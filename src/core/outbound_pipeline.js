// @ts-check
"use strict";

/**
 * Two-Phase Outbound Send, Media Staging, Rate-Limiting & Echo Correlation Pipeline (`src/core/outbound_pipeline.js`)
 *
 * Composed controller (`OutboundPipeline`) handling outbound rate limiting, unlocked
 * rich-media staging (`image`/`record`/`video`), AIO-serialized session activation +
 * `sendMsg` dispatch, forward-message echo correlation, and poke/nudge fallbacks.
 */

const fs = require("fs");
const path = require("path");

const {
  normalizeOneBotMessage,
  oneBotSegmentsToNtElements,
} = require("../bridge_onebot");
const {
  EchoCorrelator,
  _ntElementsSignature,
  _elementsSignatureMatch,
  hasRichMediaElements,
} = require("./echo_correlator");
const { OutboundRateLimiter } = require("./rate_limiter");

/** @typedef {import("../types").BridgeHost} BridgeHost */
/** @typedef {import("../types").BridgeConfig} BridgeConfig */
/** @typedef {import("../types").RateLimitConfig} RateLimitConfig */

const BRIDGE_UNAVAILABLE_TAG = "ROSMONTIS_BRIDGE_UNAVAILABLE";

/** @type {any} */
let cachedRendererIpc = null;

/** @returns {any} */
function getRendererIpcHelpers() {
  if (cachedRendererIpc) return cachedRendererIpc;
  try {
    const mod = require("./renderer_ipc");
    if (
      mod &&
      typeof mod.makeBridgeUnavailableError === "function" &&
      typeof mod.isBridgeUnavailableError === "function"
    ) {
      cachedRendererIpc = mod;
      return cachedRendererIpc;
    }
  } catch (_loadErr) {
    // Benign: fallback error helpers below are used if renderer_ipc is unavailable during early bootstrap.
  }
  return null;
}

/**
 * @param {string} [message]
 * @returns {Error & { code?: string, rosmontisUnavailable?: boolean }}
 */
function makeBridgeUnavailableError(message) {
  const mod = getRendererIpcHelpers();
  if (mod) return mod.makeBridgeUnavailableError(message);
  /** @type {Error & { code?: string, rosmontisUnavailable?: boolean }} */
  const err = new Error(message || "NTQQ bridge unavailable");
  err.code = BRIDGE_UNAVAILABLE_TAG;
  Object.defineProperty(err, BRIDGE_UNAVAILABLE_TAG, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return err;
}

/**
 * @param {any} err
 * @returns {boolean}
 */
function isBridgeUnavailableError(err) {
  const mod = getRendererIpcHelpers();
  if (mod) return mod.isBridgeUnavailableError(err);
  return Boolean(err && (err.code === BRIDGE_UNAVAILABLE_TAG || err[BRIDGE_UNAVAILABLE_TAG]));
}

/**
 * Composed outbound message staging, rate-limiting & send/echo pipeline.
 */
class OutboundPipeline {
  /**
   * @param {BridgeHost | Partial<BridgeHost>} [bridge={}]
   */
  constructor(bridge = {}) {
    /** @type {BridgeHost} */
    this.bridge = /** @type {BridgeHost} */ (bridge || {});
    /** @type {InstanceType<typeof OutboundRateLimiter> | null} */
    this.rateLimiter = Object.prototype.hasOwnProperty.call(this.bridge, "rateLimiter")
      ? this.bridge.rateLimiter ?? null
      : null;
    /** @type {RateLimitConfig | undefined} */
    this._rateLimiterConfigRef = undefined;
  }

  /** @returns {BridgeConfig | undefined} */
  get config() {
    return this.bridge.config;
  }

  /** @returns {InstanceType<typeof import("./primitives").BridgeLogger> | undefined} */
  get logger() {
    return this.bridge.logger;
  }

  /** @returns {InstanceType<typeof import("../onebot/stores").MessageIdStore>} */
  get messageIdStore() {
    return this.bridge.messageIdStore;
  }

  /** @returns {InstanceType<typeof import("../onebot/stores").UinUidStore>} */
  get uinUidStore() {
    return this.bridge.uinUidStore;
  }

  /** @returns {string} */
  get selfUin() {
    return this.bridge.selfUin || "";
  }

  /** @returns {string} */
  get selfUid() {
    return this.bridge.selfUid || "";
  }

  /** @returns {InstanceType<typeof OutboundRateLimiter>} */
  _ensureRateLimiter() {
    const cfgRef = this.config?.rateLimit;
    if (!this.rateLimiter) {
      this.rateLimiter = new OutboundRateLimiter(cfgRef);
      this._rateLimiterConfigRef = cfgRef;
    } else if (this._rateLimiterConfigRef !== cfgRef) {
      this._rateLimiterConfigRef = cfgRef;
      if (typeof this.rateLimiter.updateConfig === "function") {
        this.rateLimiter.updateConfig(cfgRef);
      }
    }
    return this.rateLimiter;
  }

  /**
   * @param {string} peerKey
   * @returns {any}
   */
  _enforceOutboundRateLimit(peerKey) {
    const limiter = this._ensureRateLimiter();
    if (!limiter || typeof limiter.consume !== "function") return null;
    const res = limiter.consume(peerKey);
    if (res && res.allowed === false) {
      const retryAfterMs = Number.isFinite(Number(res.retryAfterMs))
        ? Math.max(0, Math.ceil(Number(res.retryAfterMs)))
        : 0;
      const reason = res.reason || "rate_limited";
      /** @type {Error & { retcode?: number, code?: string, retryAfterMs?: number, rateLimitReason?: string, circuitState?: string }} */
      const err = new Error(`Rate limit exceeded (${reason}); retry after ${retryAfterMs}ms`);
      err.retcode = 1429;
      err.code = "ERR_RATE_LIMITED";
      err.retryAfterMs = retryAfterMs;
      err.rateLimitReason = reason;
      err.circuitState = res.state;
      throw err;
    }
    return res;
  }

  /** @returns {InstanceType<typeof EchoCorrelator>} */
  _ensureEchoCorrelator() {
    const b = this.bridge;
    if (!b.echoCorrelator) {
      const ctor = /** @type {any} */ (b?.constructor);
      b.echoCorrelator = new EchoCorrelator({
        getSignatureFns: () => ({
          _ntElementsSignature: ctor?._ntElementsSignature || _ntElementsSignature,
          _elementsSignatureMatch: ctor?._elementsSignatureMatch || _elementsSignatureMatch,
        }),
      });
    }
    return b.echoCorrelator;
  }

  /**
   * @param {any} userId
   * @param {any} [groupId]
   * @returns {Promise<{ chatType: number, peerUid: string, guildId: string }>}
   */
  async _resolvePeerForUser(userId, groupId) {
    const uinStr = String(userId || "").trim();
    const uid = await this.uinUidStore.resolveUid(uinStr, this.bridge.invokeNt.bind(this.bridge));
    if (groupId && Number(groupId) > 0) {
      return {
        chatType: 100,
        peerUid: uid || uinStr,
        guildId: "",
      };
    }
    return {
      chatType: 1,
      peerUid: uid || uinStr,
      guildId: "",
    };
  }

  /**
   * @param {any} media
   * @param {number} [subType=0]
   * @returns {Promise<any>}
   */
  async _prepareNtImagePath(media, subType = 0) {
    const elemSubType = Number(subType || 0);
    try {
      const exifRes = await this.bridge.invokeNt(
        "nodeIKernelMsgService/copyFileWithDelExifInfo",
        {
          sourcePath: media.localPath,
          elementSubType: elemSubType,
        },
        [media.localPath, elemSubType]
      );
      if (exifRes && exifRes.newPath && !exifRes.errorMsg) {
        const newPath = String(exifRes.newPath);
        let fileSize = media.fileSize;
        try {
          if (fs.existsSync(newPath)) {
            fileSize = fs.statSync(newPath).size || media.fileSize;
          }
        } catch (statErr) {
          this.logger?.debug?.("outbound", statErr);
        }
        return {
          localPath: newPath,
          md5HexStr: String(exifRes.md5 || media.md5HexStr),
          fileSize,
          fileName: path.basename(newPath) || media.fileName,
        };
      }
    } catch (exifErr) {
      this.logger?.debug?.("outbound", exifErr);
    }

    try {
      const pathInfo = {
        md5HexStr: media.md5HexStr,
        fileName: media.fileName,
        elementType: 2,
        elementSubType: elemSubType,
        thumbSize: 0,
        needCreate: true,
        downloadType: 1,
        file_uuid: "",
      };
      const pathRes = await this.bridge.invokeNt(
        "nodeIKernelMsgService/getRichMediaFilePathForGuild",
        { path_info: pathInfo },
        [pathInfo]
      );
      const targetPath = typeof pathRes === "string" ? pathRes : pathRes?.path || "";
      if (targetPath && targetPath !== media.localPath) {
        try {
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          fs.copyFileSync(media.localPath, targetPath);
          return targetPath;
        } catch (copyErr) {
          this.logger?.debug?.("outbound", copyErr);
          await this.bridge.invokeNt(
            "nodeIKernelFileAssistantService/copyFile",
            { fromPath: media.localPath, toPath: targetPath },
            [media.localPath, targetPath]
          );
          return targetPath;
        }
      }
    } catch (stageErr) {
      this.logger?.debug?.("outbound", stageErr);
    }
    return media.localPath;
  }

  /**
   * @param {any} media
   * @returns {Promise<{ localPath: string, fileName: string, md5HexStr: string, fileSize: number }>}
   */
  async _prepareNtRecordPath(media) {
    const fileName = media.fileName || `${media.md5HexStr}.amr`;
    try {
      const pathInfo = {
        md5HexStr: media.md5HexStr,
        fileName,
        elementType: 4,
        elementSubType: 0,
        thumbSize: 0,
        needCreate: true,
        downloadType: 1,
        file_uuid: "",
      };
      const pathRes = await this.bridge.invokeNt(
        "nodeIKernelMsgService/getRichMediaFilePathForGuild",
        { path_info: pathInfo },
        [pathInfo]
      );
      const targetPath = typeof pathRes === "string" ? pathRes : pathRes?.path || "";
      if (targetPath && targetPath !== media.localPath) {
        try {
          await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
          await fs.promises.copyFile(media.localPath, targetPath);
          return {
            localPath: targetPath,
            fileName: path.basename(targetPath) || fileName,
            md5HexStr: media.md5HexStr,
            fileSize: media.fileSize,
          };
        } catch (copyErr) {
          this.logger?.debug?.("outbound", copyErr);
          await this.bridge.invokeNt(
            "nodeIKernelFileAssistantService/copyFile",
            { fromPath: media.localPath, toPath: targetPath },
            [media.localPath, targetPath]
          );
          return {
            localPath: targetPath,
            fileName: path.basename(targetPath) || fileName,
            md5HexStr: media.md5HexStr,
            fileSize: media.fileSize,
          };
        }
      }
    } catch (stageErr) {
      this.logger?.debug?.("outbound", stageErr);
    }
    return {
      localPath: media.localPath,
      fileName,
      md5HexStr: media.md5HexStr,
      fileSize: media.fileSize,
    };
  }

  /**
   * @param {any} media
   * @param {any} thumbInfo
   * @returns {Promise<{
   *   videoPath: string,
   *   fileName: string,
   *   videoMd5: string,
   *   fileSize: number,
   *   thumbPath: string,
   *   thumbMd5: string,
   *   thumbSize: number
   * }>}
   */
  async _prepareNtVideoPath(media, thumbInfo) {
    const videoFileName = media.fileName || `${media.md5HexStr}.mp4`;
    const result = {
      videoPath: media.localPath,
      fileName: videoFileName,
      videoMd5: media.md5HexStr,
      fileSize: media.fileSize,
      thumbPath: thumbInfo?.localPath || "",
      thumbMd5: thumbInfo?.md5HexStr || "",
      thumbSize: Number(thumbInfo?.fileSize || 0),
    };
    try {
      const videoPathInfo = {
        md5HexStr: media.md5HexStr,
        fileName: videoFileName,
        elementType: 5,
        elementSubType: 2,
        thumbSize: 0,
        needCreate: true,
        downloadType: 1,
        file_uuid: "",
      };
      const videoPathRes = await this.bridge.invokeNt(
        "nodeIKernelMsgService/getRichMediaFilePathForGuild",
        { path_info: videoPathInfo },
        [videoPathInfo]
      );
      const targetVideoPath =
        typeof videoPathRes === "string" ? videoPathRes : videoPathRes?.path || "";
      if (targetVideoPath && targetVideoPath !== media.localPath) {
        try {
          await fs.promises.mkdir(path.dirname(targetVideoPath), { recursive: true });
          await fs.promises.copyFile(media.localPath, targetVideoPath);
          result.videoPath = targetVideoPath;
          result.fileName = path.basename(targetVideoPath) || videoFileName;
        } catch (copyErr) {
          this.logger?.debug?.("outbound", copyErr);
          await this.bridge.invokeNt(
            "nodeIKernelFileAssistantService/copyFile",
            { fromPath: media.localPath, toPath: targetVideoPath },
            [media.localPath, targetVideoPath]
          );
          result.videoPath = targetVideoPath;
          result.fileName = path.basename(targetVideoPath) || videoFileName;
        }
      }
    } catch (videoErr) {
      this.logger?.debug?.("outbound", videoErr);
    }

    if (thumbInfo?.localPath && thumbInfo?.md5HexStr) {
      const thumbExt = path.extname(thumbInfo.localPath) || ".jpg";
      const thumbFileName = `${thumbInfo.md5HexStr}_0${thumbExt}`;
      try {
        const thumbPathInfo = {
          md5HexStr: thumbInfo.md5HexStr,
          fileName: thumbFileName,
          elementType: 5,
          elementSubType: 1,
          thumbSize: 0,
          needCreate: true,
          downloadType: 1,
          file_uuid: "",
        };
        const thumbPathRes = await this.bridge.invokeNt(
          "nodeIKernelMsgService/getRichMediaFilePathForGuild",
          { path_info: thumbPathInfo },
          [thumbPathInfo]
        );
        const targetThumbPath =
          typeof thumbPathRes === "string" ? thumbPathRes : thumbPathRes?.path || "";
        if (targetThumbPath && targetThumbPath !== thumbInfo.localPath) {
          try {
            await fs.promises.mkdir(path.dirname(targetThumbPath), { recursive: true });
            await fs.promises.copyFile(thumbInfo.localPath, targetThumbPath);
            result.thumbPath = targetThumbPath;
          } catch (copyErr) {
            this.logger?.debug?.("outbound", copyErr);
            await this.bridge.invokeNt(
              "nodeIKernelFileAssistantService/copyFile",
              { fromPath: thumbInfo.localPath, toPath: targetThumbPath },
              [thumbInfo.localPath, targetThumbPath]
            );
            result.thumbPath = targetThumbPath;
          }
        }
      } catch (thumbErr) {
        this.logger?.debug?.("outbound", thumbErr);
      }
    }
    return result;
  }

  /** @param {any} peer */
  _sendPeerKey(peer) {
    return this._ensureEchoCorrelator().peerKey(peer);
  }

  /**
   * @param {any} peer
   * @param {any} elements
   * @param {((ntMsg: any) => boolean) | null} [elementPredicate=null]
   */
  _registerSendEchoWaiter(peer, elements, elementPredicate = null) {
    return this._ensureEchoCorrelator().register(peer, elements, elementPredicate);
  }

  /** @param {any} ntMsg */
  _matchSendEcho(ntMsg) {
    return this._ensureEchoCorrelator().match(ntMsg);
  }

  /** @param {any[]} elements */
  _hasRichMediaElements(elements) {
    return hasRichMediaElements(elements);
  }

  /** @param {any[]} elements */
  _computeSendEchoTimeoutMs(elements) {
    return this._ensureEchoCorrelator().computeTimeoutMs(elements, this.config);
  }

  _mediaSecurityOptions() {
    const cfg = this.config || {};
    return {
      ...(cfg.tempDir ? { tempDir: cfg.tempDir } : {}),
      maxMediaBytes: cfg.maxMediaBytes,
      allowPrivateUrls:
        cfg.allowPrivateUrls === true || cfg.allowPrivateMediaUrls === true
          ? true
          : undefined,
      allowArbitraryLocalFiles: cfg.allowArbitraryLocalFiles === true ? true : undefined,
      allowedFileDirs: cfg.allowedFileDirs,
    };
  }

  /**
   * @param {any} peer
   * @param {any} message
   * @param {boolean} [autoEscape=false]
   * @param {any} [groupId=undefined]
   * @param {Record<string, any>} [options={}]
   * @returns {Promise<{ message_id: number, real_id?: string }>}
   */
  async _sendMessageToPeer(peer, message, autoEscape = false, groupId = undefined, options = {}) {
    const peerKey = `${peer.chatType}:${peer.peerUid}:${peer.guildId || ""}`;
    this._enforceOutboundRateLimit(peerKey);
    this.bridge.sessionController?.scheduler.cancelPeerReaction(peerKey);

    // Phase 1 (unlocked): concurrent heavy I/O (HTTP media download, EXIF normalize, @UIN->UID)
    const { elements, sideEffects, cleanupCallbacks } = await oneBotSegmentsToNtElements(message, {
      autoEscape,
      groupId,
      uinUidStore: this.uinUidStore,
      messageIdStore: this.messageIdStore,
      invokeNt: this.bridge.invokeNt.bind(this.bridge),
      prepareNtImagePath: this._prepareNtImagePath.bind(this),
      prepareNtRecordPath: this._prepareNtRecordPath.bind(this),
      prepareNtVideoPath: this._prepareNtVideoPath.bind(this),
      ffmpegPath: this.config?.ffmpegPath,
      silkEncoderPath: this.config?.silkEncoderPath,
      silkAddonPath: this.config?.silkAddonPath,
      nodeBinPath: this.config?.nodeBinPath,
      ...this._mediaSecurityOptions(),
    });

    try {
      // Phase 2 (AIO-mutex serialized): activate target AIO + dispatch sendMsg IPC, then release immediately
      const runWithLock = this.bridge.sessionController
        ? this.bridge.sessionController.withLock.bind(this.bridge.sessionController)
        : (/** @type {() => Promise<any>} */ fn) => fn();
      const { echoWaiter, sendRes } = await runWithLock(
        async () => {
          this.bridge.sessionController?.scheduler.cancelPeerReaction(peerKey);
          if (
            this.config?.humanSimulation !== false &&
            !options.skipHumanSimulation &&
            this.bridge.sessionController
          ) {
            await this.bridge.sessionController.activateUnlocked({
              chatType: peer.chatType,
              peerUid: peer.peerUid,
              guildId: peer.guildId || "",
              markRead: true,
              sendTyping: false,
            });
          }

          for (const effect of sideEffects) {
            if (effect.type === "poke") {
              await this._sendPokeInternal(
                peer.chatType === 2 ? Number(peer.peerUid) : undefined,
                effect.qq ||
                  (peer.chatType === 1 ? Number(this.uinUidStore.getUinSync(peer.peerUid)) : 0)
              );
            }
          }

          if (elements.length === 0) {
            return { echoWaiter: null, sendRes: null };
          }

          const waiter = this._registerSendEchoWaiter(peer, elements);
          try {
            const res = await this.bridge.invokeNt(
              "nodeIKernelMsgService/sendMsg",
              {
                msgId: "0",
                peer,
                msgElements: elements,
                msgAttributeInfos: new Map(),
              },
              ["0", peer, elements, new Map()]
            );
            if (this.config?.humanSimulation !== false && !options.skipHumanSimulation) {
              this.bridge.sessionController?.touchActivity();
            }
            return { echoWaiter: waiter, sendRes: res };
          } catch (err) {
            waiter.cancel();
            throw err;
          }
        },
        { peerKey }
      );

      if (!echoWaiter) {
        return { message_id: this.messageIdStore.register("", peer, "0") };
      }

      if (sendRes && typeof sendRes.result === "number" && sendRes.result !== 0) {
        echoWaiter.cancel();
        throw new Error(sendRes.errMsg || `sendMsg failed with code ${sendRes.result}`);
      }

      // Phase 3 (unlocked): await onAddSendMsg echo correlation without holding _aioMutex
      const normId = (/** @type {any} */ v) =>
        v !== undefined && v !== null && String(v) !== "0" ? String(v) : "";
      let realMsgId = normId(sendRes?.msgId || sendRes?.msgRecord?.msgId);
      let msgSeq = String(sendRes?.msgSeq || sendRes?.msgRecord?.msgSeq || "0");
      let msgTime = Math.floor(Date.now() / 1000);
      let echoRawMsg = sendRes?.msgRecord || null;
      const echoStats = this.bridge.sendEchoStats || this._ensureEchoCorrelator().stats;
      if (realMsgId) {
        echoWaiter.cancel();
        echoStats.fromResult += 1;
      } else {
        const echoTimeoutMs = this._computeSendEchoTimeoutMs(elements);
        const echo = await echoWaiter.wait(echoTimeoutMs);
        if (echo && echo.msgId) {
          realMsgId = echo.msgId;
          if (msgSeq === "0" && echo.msgSeq) msgSeq = echo.msgSeq;
          if (Number.isFinite(echo.msgTime) && Number(echo.msgTime) > 0) msgTime = Number(echo.msgTime);
          if (echo.rawMsg) echoRawMsg = echo.rawMsg;
          echoStats.matched += 1;
        } else {
          echoStats.timedOut += 1;
          const peerKeyStr = this._sendPeerKey(peer);
          const warnKey = `send-echo-timeout:${peerKeyStr}`;
          const warnMsg = `sendMsg to ${peerKeyStr} succeeded but no onAddSendMsg echo arrived within ${echoTimeoutMs}ms; message_id will not be recallable`;
          this.logger?.warnThrottled?.(warnKey, warnMsg, 60000);
        }
      }
      if (!realMsgId) {
        realMsgId = `sent_${Date.now()}`;
      }

      const shortId = this.messageIdStore.register(realMsgId, peer, msgSeq, {
        senderUin: this.selfUin,
        senderUid: this.selfUid,
        groupId: peer.chatType === 2 ? peer.peerUid : "",
        msgTime,
        rawMsg: echoRawMsg || null,
      });
      if (echoRawMsg && typeof this.messageIdStore.indexMsgMedia === "function") {
        this.messageIdStore.indexMsgMedia(echoRawMsg, shortId);
      }

      return { message_id: shortId, real_id: realMsgId };
    } finally {
      this.bridge.tempCleanupQueue?.schedule(
        cleanupCallbacks,
        Boolean(options.cleanupTempImmediately)
      );
    }
  }

  /**
   * @param {any} peer
   * @param {() => Promise<any>} invokeFn
   * @param {string} [fallbackSeed=""]
   * @returns {Promise<{ message_id: number, real_id: string, msgId: string }>}
   */
  async _invokeForwardWithEcho(peer, invokeFn, fallbackSeed = "") {
    const peerKey = `${peer?.chatType || 0}:${peer?.peerUid || ""}:${peer?.guildId || ""}`;
    this._enforceOutboundRateLimit(peerKey);
    const fwdTimeoutCfg = Number(this.config?.forwardEchoTimeoutMs);
    const timeoutMs =
      fwdTimeoutCfg > 0
        ? fwdTimeoutCfg
        : Math.min(Math.max(50, Number(this.config?.sendEchoTimeoutMs) || 200), 200);
    const echoWaiter = this._registerSendEchoWaiter(
      peer,
      null,
      (ntMsg) => Boolean(ntMsg && ntMsg.msgId && String(ntMsg.msgId) !== "0")
    );

    let res;
    try {
      res = await invokeFn();
    } catch (err) {
      echoWaiter.cancel();
      throw err;
    }

    if (res && typeof res.result === "number" && res.result !== 0) {
      echoWaiter.cancel();
      throw new Error(res.errMsg || `forward failed with code ${res.result}`);
    }

    const normId = (/** @type {any} */ v) =>
      v !== undefined && v !== null && String(v) !== "0" ? String(v) : "";
    const directMsgId = normId(res?.msgId || res?.result?.msgId || res?.msgRecord?.msgId);
    const directSeq = String(res?.msgSeq || res?.result?.msgSeq || res?.msgRecord?.msgSeq || "0");
    if (directMsgId) {
      echoWaiter.cancel();
      const rawMsg = res?.msgRecord || null;
      const oneBotId = this.messageIdStore.register(directMsgId, peer, directSeq, {
        senderUin: this.selfUin,
        senderUid: this.selfUid,
        groupId: peer.chatType === 2 ? peer.peerUid : "",
        rawMsg,
      });
      if (rawMsg && typeof this.messageIdStore.indexMsgMedia === "function") {
        this.messageIdStore.indexMsgMedia(rawMsg, oneBotId);
      }
      return { message_id: oneBotId, real_id: String(directMsgId), msgId: String(directMsgId) };
    }

    const echo = await echoWaiter.wait(timeoutMs);
    if (echo && echo.msgId) {
      const rawMsg = echo.rawMsg || null;
      const oneBotId = this.messageIdStore.register(echo.msgId, peer, echo.msgSeq || "0", {
        senderUin: this.selfUin,
        senderUid: this.selfUid,
        groupId: peer.chatType === 2 ? peer.peerUid : "",
        ...(Number.isFinite(echo.msgTime) && Number(echo.msgTime) > 0
          ? { msgTime: Number(echo.msgTime) }
          : {}),
        rawMsg,
      });
      if (rawMsg && typeof this.messageIdStore.indexMsgMedia === "function") {
        this.messageIdStore.indexMsgMedia(rawMsg, oneBotId);
      }
      return { message_id: oneBotId, real_id: String(echo.msgId), msgId: String(echo.msgId) };
    }

    const seedPart = fallbackSeed ? `${String(fallbackSeed)}_` : "";
    const syntheticId = `fwd_${seedPart}${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const oneBotId = this.messageIdStore.register(syntheticId, peer, "0", {
      senderUin: this.selfUin,
      senderUid: this.selfUid,
      groupId: peer.chatType === 2 ? peer.peerUid : "",
    });
    return { message_id: oneBotId, real_id: String(syntheticId), msgId: String(syntheticId) };
  }

  /**
   * @param {any} groupId
   * @param {any} userId
   */
  async _sendPokeInternal(groupId, userId) {
    const rawUserStr = String(userId ?? "").trim();
    let targetUin = /^\d+$/.test(rawUserStr) ? Number(rawUserStr) : 0;
    if (!targetUin && rawUserStr && this.uinUidStore) {
      targetUin = Number(this.uinUidStore.getUinSync(rawUserStr) || 0);
      if (!targetUin && this.bridge.inboundPipeline) {
        targetUin = Number((await this.bridge.inboundPipeline._ensureUinForUid(rawUserStr)) || 0);
      }
    }
    const targetGroup = groupId ? Number(groupId) : 0;
    const targetUid = targetUin
      ? await this.uinUidStore.resolveUid(targetUin, this.bridge.invokeNt.bind(this.bridge))
      : rawUserStr.startsWith("u_")
      ? rawUserStr
      : "";
    const peer =
      targetGroup > 0
        ? { chatType: 2, peerUid: String(targetGroup), guildId: "" }
        : await this._resolvePeerForUser(targetUin || rawUserStr);

    const toUinStr = String(targetUin || 0);
    const chatUinStr = String(targetGroup > 0 ? targetGroup : targetUin || 0);

    // 1. Primary: genuine NTQQ 3.2.32 `nodeIKernelMsgService/sendNudge(peer, toUin, chatUin)` (3 args)
    try {
      await this.bridge.invokeNt(
        "nodeIKernelMsgService/sendNudge",
        {
          peer,
          targetUin: toUinStr,
          toUin: toUinStr,
          chatUin: chatUinStr,
        },
        [peer, toUinStr, chatUinStr]
      );
      return;
    } catch (err) {
      if (!isBridgeUnavailableError(err)) throw err;
    }

    // 2. Fallback: legacy `sendPoke` if bridged by a custom adapter
    try {
      if (targetGroup > 0) {
        await this.bridge.invokeNt("nodeIKernelMsgService/sendPoke", {
          groupCode: String(targetGroup),
          toUin: String(targetUin),
          peer,
          targetUid: targetUid || String(targetUin),
        });
        return;
      }
      await this.bridge.invokeNt("nodeIKernelMsgService/sendPoke", {
        toUin: String(targetUin),
        peer,
        targetUid: targetUid || String(targetUin),
      });
      return;
    } catch (err) {
      if (!isBridgeUnavailableError(err)) throw err;
    }

    // 3. Final fallback: sendMsg poke faceElement
    if (targetUin > 0 && peer && peer.peerUid) {
      const pokeElements = [
        {
          elementType: 6,
          elementId: "",
          faceElement: {
            faceIndex: 0,
            faceType: 5,
            faceText: "[戳一戳]",
            pokeType: 1,
            spokeSummary: "",
            doubleHit: 0,
            vasPokeId: 1,
            vasPokeName: "戳一戳",
          },
        },
      ];
      await this.bridge.invokeNt(
        "nodeIKernelMsgService/sendMsg",
        {
          msgId: "0",
          peer,
          msgElements: pokeElements,
          msgAttributeInfos: new Map(),
        },
        ["0", peer, pokeElements, new Map()]
      );
      return;
    }
    throw makeBridgeUnavailableError("NTQQ service unavailable for sendNudge/sendPoke");
  }
}

module.exports = {
  OutboundPipeline,
  _ntElementsSignature,
  _elementsSignatureMatch,
  BRIDGE_UNAVAILABLE_TAG,
  makeBridgeUnavailableError,
  isBridgeUnavailableError,
  normalizeOneBotMessage,
};
