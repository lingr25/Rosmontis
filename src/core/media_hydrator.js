// @ts-check
"use strict";

/**
 * Inbound Rich-Media Download & Hydration Subsystem (`src/core/media_hydrator.js`)
 *
 * Typed helper class (`MediaHydrator`) composed by `InboundPipeline`:
 * - `onRichMediaDownloadComplete` waiter resolution + `-6101` fast-fail signaling (`handleRichMediaDownloadComplete`)
 * - Active NTQQ rich-media download with `downloadRichMediaInVisit` candidate probing + event waiter + fs stat polling (`downloadRichMediaElement`)
 * - Inbound message media hydration for `picElement`, `pttElement`, and `videoElement` with `0x9067_202` RKey CDN fallback (`hydrateNtMsgMedia`)
 * - Non-enumerable `__localFileUrl` / `__base64Uri` helpers & transient media stripping
 */

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const bridgeOnebot = require("../bridge_onebot");
const { extractNtRichMediaAppId } = require("./nt_normalizer");
const {
  isNtMultimediaDownloadUrl,
  downloadNtMultimediaWithRKey,
} = require("./rkey_manager");

/** @typedef {import("../types").BridgeHost} BridgeHost */
/** @typedef {import("../types").BridgeConfig} BridgeConfig */
/** @typedef {import("../types").InvokeNtFn} InvokeNtFn */

/**
 * @typedef {{
 *   msgId: string,
 *   elementId: string,
 *   md5?: string,
 *   targetPath: string,
 *   candidatePaths?: string[],
 *   resolve: (downloadedPath: string) => void,
 *   onError?: (info?: any) => void
 * } | ((downloadedPath: string) => void)} RichMediaWaiterEntry
 */

/**
 * Host contract required by `MediaHydrator` (satisfied by `InboundPipeline`).
 * @typedef {object} MediaHydratorHost
 * @property {BridgeHost} [bridge]
 * @property {Map<string, Set<RichMediaWaiterEntry>>} _richMediaWaiters
 * @property {Map<string, any>} [_groupListCache]
 * @property {() => boolean} _isNtReady
 * @property {InvokeNtFn} invokeNt
 * @property {((service: string, method: string, args: any[]) => Promise<any>) | null} [ntCall]
 * @property {BridgeConfig} [config]
 * @property {InstanceType<typeof import("./primitives").BridgeLogger>} [logger]
 * @property {InstanceType<typeof import("../onebot/stores").MessageIdStore>} [messageIdStore]
 * @property {Record<string, any>} [richMediaStats]
 */

/**
 * @typedef {object} MediaHydrationContext
 * @property {boolean} skipRemoteDownload
 * @property {boolean} inVisit
 * @property {number} downSourceType
 * @property {number} fallbackChatType
 * @property {string} fallbackPeerUid
 * @property {string} fallbackGuildId
 * @property {number} altChatType
 * @property {string} altPeerUid
 * @property {string} altGuildId
 * @property {string} forwardSenderUid
 * @property {string} senderUid
 * @property {number} deadlineMs
 * @property {(capMs: number) => number} remainingRemoteBudgetMs
 */

const MAX_HYDRATE_PIC_BYTES = 10 * 1024 * 1024;
const MAX_HYDRATE_PTT_BYTES = 2 * 1024 * 1024;

/**
 * @param {string | null | undefined} filePath
 * @returns {Promise<fs.Stats | null>}
 */
async function statPositiveFile(filePath) {
  if (!filePath) return null;
  try {
    const st = await fs.promises.stat(String(filePath));
    if (st.isFile() && st.size > 0) {
      return st;
    }
  } catch (_statErr) {
    // Expected when rich media file is not downloaded yet or path is not readable.
  }
  return null;
}

/**
 * @param {any} val
 * @returns {any}
 */
function cloneElemForVisitDownload(val) {
  if (val === null || val === undefined || typeof val !== "object") return val;
  if (val instanceof Map) {
    const m = new Map();
    for (const [k, v] of val.entries()) {
      m.set(cloneElemForVisitDownload(k), cloneElemForVisitDownload(v));
    }
    return m;
  }
  if (val instanceof Uint8Array) {
    return Uint8Array.from(val);
  }
  if (Array.isArray(val)) {
    return val.map((item) => cloneElemForVisitDownload(item));
  }
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    if (k.startsWith("__")) continue;
    out[k] = cloneElemForVisitDownload(v);
  }
  return out;
}

/**
 * @param {any} filePath
 * @returns {string}
 */
function _extractMd5FromMediaPath(filePath) {
  if (!filePath || typeof filePath !== "string") return "";
  const base = path.basename(filePath.trim());
  const m = /(?:^|[^0-9a-fA-F])([0-9a-fA-F]{32})(?:$|[^0-9a-fA-F])/.exec(base);
  return m ? m[1].toLowerCase() : "";
}

/**
 * @param {any} val
 * @returns {string}
 */
function _toDecimalInt64Str(val) {
  const s = String(val ?? "0").trim();
  return /^-?\d+$/.test(s) ? s : "0";
}

/**
 * @param {any} target
 * @param {string} localPath
 */
function defineLocalFileUrl(target, localPath) {
  if (!target || typeof target !== "object" || !localPath) return;
  try {
    Object.defineProperty(target, "__localFileUrl", {
      value: pathToFileURL(String(localPath)).href,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch (_defErr) {
    // Target NTQQ element object may be frozen or non-extensible; skip non-enumerable attachment.
  }
}

/**
 * @param {any} target
 * @param {Buffer} buf
 */
function defineBase64Uri(target, buf) {
  if (!target || typeof target !== "object" || !buf) return;
  Object.defineProperty(target, "__base64Uri", {
    value: `base64://${buf.toString("base64")}`,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

/**
 * @param {any} ntMsg
 */
function stripTransientMedia(ntMsg) {
  bridgeOnebot.stripTransientNtMedia(ntMsg);
}

class MediaHydrator {
  /**
   * @param {MediaHydratorHost} host
   */
  constructor(host) {
    /** @type {MediaHydratorHost} */
    this.host = host;
  }

  /**
   * @param {any} firstArg
   */
  async handleRichMediaDownloadComplete(firstArg) {
    const info = firstArg?.notifyInfo || firstArg || {};
    const msgId = String(info.msgId || "");
    const elId = String(info.msgElementId || info.elementId || "");
    const filePath = String(info.filePath || "");
    const resultCode = Number(info.fileErrCode ?? info.result ?? 0);
    const transferStatus = Number(info.trasferStatus ?? info.transferStatus ?? 0);
    const hasErrorStatus =
      (Number.isFinite(resultCode) && resultCode !== 0) ||
      transferStatus === 5 ||
      transferStatus === 6;
    const hasValidFileOnError =
      hasErrorStatus && filePath ? Boolean(await statPositiveFile(filePath)) : false;
    const isFailureNotify = hasErrorStatus && !hasValidFileOnError;

    const bridgeTarget = this.host.bridge;
    const stats = this.host.richMediaStats || bridgeTarget?.richMediaStats;
    if (isFailureNotify && stats) {
      const errRecord = {
        msgId,
        elementId: elId,
        filePath,
        fileErrCode: resultCode,
        trasferStatus: transferStatus,
        fileErrMsg: String(info.fileErrMsg || info.errMsg || ""),
        fileSrvErrCode: Number(info.fileSrvErrCode ?? info.srvErrCode ?? 0),
        clientMsg: String(info.clientMsg || ""),
        at: Date.now(),
      };
      stats.lastError = errRecord;
      if (!Array.isArray(stats.recentErrors)) {
        stats.recentErrors = [];
      }
      stats.recentErrors.push(errRecord);
      if (stats.recentErrors.length > 8) {
        stats.recentErrors.splice(0, stats.recentErrors.length - 8);
      }
    }

    const md5Lower = String(
      info.md5HexStr || _extractMd5FromMediaPath(filePath) || ""
    ).toLowerCase();
    const keys = [
      `${msgId}:${elId}`,
      `${msgId}:0`,
      md5Lower ? `md5:${md5Lower}` : "",
      filePath,
    ].filter(Boolean);
    /** @type {Set<any>} */
    const toInvoke = new Set();

    for (const k of keys) {
      const set = this.host._richMediaWaiters?.get(k);
      if (!set) continue;
      for (const waiter of Array.from(set)) {
        if (typeof waiter === "function") {
          if (!isFailureNotify) {
            set.delete(waiter);
            toInvoke.add(waiter);
          }
        } else if (waiter && typeof waiter.resolve === "function") {
          const pathMatched = Boolean(
            filePath &&
              ((waiter.targetPath && filePath === waiter.targetPath) ||
                (Array.isArray(waiter.candidatePaths) &&
                  waiter.candidatePaths.includes(filePath)))
          );
          const md5Matched = Boolean(md5Lower && waiter.md5 && waiter.md5 === md5Lower);
          const specificElMismatch =
            elId &&
            elId !== "0" &&
            waiter.elementId &&
            waiter.elementId !== "0" &&
            waiter.elementId !== elId &&
            !pathMatched &&
            !md5Matched;
          if (!specificElMismatch) {
            if (isFailureNotify && typeof waiter.onError === "function") {
              toInvoke.add({ __errorOnly: true, waiter, info });
            } else {
              set.delete(waiter);
              toInvoke.add(waiter);
            }
          }
        }
      }
      if (set.size === 0) {
        this.host._richMediaWaiters.delete(k);
      }
    }

    for (const item of toInvoke) {
      try {
        if (item && item.__errorOnly) {
          item.waiter.onError(item.info);
        } else if (typeof item === "function") {
          item(filePath);
        } else {
          item.resolve(filePath);
        }
      } catch (err) {
        this.host.logger?.debug?.("inbound", err);
      }
    }
  }

  /**
   * @param {Record<string, any>} [options={}]
   * @returns {Promise<string>}
   */
  async downloadRichMediaElement(
    {
      msgId,
      chatType,
      peerUid,
      altChatType = 0,
      altPeerUid = "",
      altGuildId = "",
      elementId,
      downloadType = 1,
      downSourceType = 0,
      downloadScene = 0,
      fileModelId = "0",
      thumbSize = 0,
      filePath = "",
      altFilePaths = [],
      md5 = "",
      inVisit = false,
      elem = null,
      msgRandom = "0",
      msgSeq = "0",
      msgTime = "0",
      forwardSenderUid = "",
      senderUid = "",
      guildId = "",
      timeoutMs = 8000,
    } = {}
  ) {
    const targetPath = filePath ? String(filePath).trim() : "";
    const candidatePaths = Array.from(
      new Set(
        [targetPath, ...(Array.isArray(altFilePaths) ? altFilePaths : [])]
          .map((p) => String(p || "").trim())
          .filter(Boolean)
      )
    );
    for (const cp of candidatePaths) {
      const existingStat = await statPositiveFile(cp);
      if (existingStat) {
        return cp;
      }
    }
    if (!this.host._isNtReady()) return "";
    if ((!msgId && !inVisit) || !peerUid) return "";

    const msgIdStr = String(msgId || "0");
    const elIdStr = String(elementId || "0");
    const md5Lower = String(md5 || _extractMd5FromMediaPath(targetPath) || "")
      .trim()
      .toLowerCase();
    const effectiveTimeout = Math.max(100, Number(timeoutMs) || 8000);
    if (!this.host._richMediaWaiters) {
      this.host._richMediaWaiters = new Map();
    }
    const waitKeys = [
      `${msgIdStr}:${elIdStr}`,
      `${msgIdStr}:0`,
      md5Lower ? `md5:${md5Lower}` : "",
      ...candidatePaths,
    ].filter(Boolean);

    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    let pollTimer = null;
    /** @type {RichMediaWaiterEntry | null} */
    let waiterEntry = null;
    let downloadSettled = false;
    let settledFilePath = "";
    let stageErrorCount = 0;

    const cleanupWaiter = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (waiterEntry && this.host._richMediaWaiters) {
        for (const k of waitKeys) {
          const set = this.host._richMediaWaiters.get(k);
          if (set) {
            set.delete(waiterEntry);
            if (set.size === 0) {
              this.host._richMediaWaiters.delete(k);
            }
          }
        }
      }
    };

    /** @type {Set<() => void>} */
    const stageErrorResolvers = new Set();
    /** @type {(candidate: string) => void} */
    let finishWaitDownload = () => {};
    /** @type {Promise<string>} */
    const waitDownload = new Promise((resolve) => {
      let polling = false;
      /** @param {string} [candidate] */
      const finish = (candidate) => {
        if (downloadSettled) return;
        downloadSettled = true;
        settledFilePath = String(candidate ?? targetPath ?? "").trim();
        for (const wake of Array.from(stageErrorResolvers)) {
          try {
            wake();
          } catch (wakeErr) {
            this.host.logger?.debug?.("inbound", wakeErr);
          }
        }
        stageErrorResolvers.clear();
        cleanupWaiter();
        resolve(settledFilePath);
      };
      finishWaitDownload = finish;
      /** @type {RichMediaWaiterEntry} */
      const entry = {
        msgId: msgIdStr,
        elementId: elIdStr,
        md5: md5Lower,
        targetPath,
        candidatePaths,
        resolve: (downloadedPath) => finish(downloadedPath || targetPath),
        onError: () => {
          stageErrorCount += 1;
          for (const wake of Array.from(stageErrorResolvers)) {
            try {
              wake();
            } catch (wakeErr) {
              this.host.logger?.debug?.("inbound", wakeErr);
            }
          }
          stageErrorResolvers.clear();
        },
      };
      waiterEntry = entry;
      for (const k of waitKeys) {
        let waiterSet = this.host._richMediaWaiters.get(k);
        if (!waiterSet) {
          waiterSet = new Set();
          this.host._richMediaWaiters.set(k, waiterSet);
        }
        waiterSet.add(entry);
      }
      if (candidatePaths.length > 0) {
        pollTimer = setInterval(async () => {
          if (polling || downloadSettled) return;
          polling = true;
          try {
            for (const cp of candidatePaths) {
              const st = await statPositiveFile(cp);
              if (st) {
                finish(cp);
                break;
              }
            }
          } finally {
            polling = false;
          }
        }, 150);
        pollTimer.unref?.();
      }
      timer = setTimeout(() => finish(targetPath), effectiveTimeout);
    });

    /**
     * @param {number} ms
     * @param {number} [prevErrCount]
     */
    const waitSlice = (ms, prevErrCount = stageErrorCount) => {
      if (downloadSettled || stageErrorCount > prevErrCount || ms <= 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        let done = false;
        const wake = () => {
          if (done) return;
          done = true;
          clearTimeout(t);
          stageErrorResolvers.delete(wake);
          resolve(undefined);
        };
        const t = setTimeout(wake, ms);
        stageErrorResolvers.add(wake);
        waitDownload.then(wake, wake);
      });
    };

    /** @param {any} dlRes */
    const checkResolvedNow = async (dlRes) => {
      const directPath =
        typeof dlRes === "string" ? dlRes : dlRes?.filePath ? String(dlRes.filePath) : "";
      if (directPath && (await statPositiveFile(directPath))) {
        return directPath;
      }
      if (settledFilePath && (await statPositiveFile(settledFilePath))) {
        return settledFilePath;
      }
      for (const cp of candidatePaths) {
        if (cp && (await statPositiveFile(cp))) {
          return cp;
        }
      }
      return "";
    };

    const bridgeTarget = this.host.bridge;
    const stats = this.host.richMediaStats || bridgeTarget?.richMediaStats;

    /**
     * @param {number} reqChatType
     * @param {string} reqPeerUid
     * @param {number} srcType
     */
    const invokeMsgDownload = async (reqChatType, reqPeerUid, srcType) => {
      const getReq = {
        downSourceType: Number(srcType ?? 0),
        downloadSourceType: Number(srcType ?? 0),
        downloadScene: Number(downloadScene ?? 0),
        fileModelId: String(fileModelId || "0"),
        triggerType: 1,
        msgId: msgIdStr,
        chatType: Number(reqChatType || 1),
        peerUid: String(reqPeerUid),
        elementId: elIdStr,
        thumbSize: Number(thumbSize || 0),
        downloadType: Number(downloadType ?? 1),
        filePath: targetPath,
      };
      return typeof this.host.invokeNt === "function"
        ? await this.host.invokeNt("nodeIKernelMsgService/downloadRichMedia", { getReq }, [getReq])
        : typeof this.host.ntCall === "function"
        ? await this.host.ntCall("nodeIKernelMsgService", "downloadRichMedia", [{ getReq }])
        : null;
    };

    /**
     * @param {number} reqChatType
     * @param {string} reqPeerUid
     * @param {string} reqGuildId
     * @param {string} [reqSenderUid]
     */
    const invokeVisitDownload = async (
      reqChatType,
      reqPeerUid,
      reqGuildId,
      reqSenderUid = senderUid
    ) => {
      const cleanElem = cloneElemForVisitDownload(elem);
      const downReq = {
        downloadType: Number(downloadType ?? 1),
        thumbSize: Number(thumbSize || 0),
        msgId: _toDecimalInt64Str(msgIdStr),
        msgRandom: _toDecimalInt64Str(msgRandom),
        msgSeq: _toDecimalInt64Str(msgSeq),
        msgTime: _toDecimalInt64Str(msgTime),
        chatType: Number(reqChatType || 1),
        senderUid: String(reqSenderUid ?? ""),
        peerUid: String(reqPeerUid),
        guildId: String(reqGuildId || ""),
        elem: cleanElem,
        useHttps: null,
        triggerType: 1,
      };
      return typeof this.host.invokeNt === "function"
        ? await this.host.invokeNt(
            "nodeIKernelRichMediaService/downloadRichMediaInVisit",
            { downReq },
            [downReq]
          )
        : typeof this.host.ntCall === "function"
        ? await this.host.ntCall("nodeIKernelRichMediaService", "downloadRichMediaInVisit", [
            { downReq },
          ])
        : null;
    };

    try {
      const resolvedDownSourceType = Number(downSourceType ?? (inVisit ? 1 : 0));
      const hasValidMsgElemIds =
        msgIdStr !== "0" &&
        msgIdStr !== "" &&
        !/^(sent_|fwd_|echo_timeout_)/.test(msgIdStr) &&
        elIdStr !== "0" &&
        elIdStr !== "";
      const hasVisitElem = Boolean(inVisit && elem && typeof elem === "object");
      let lastApiLabel = "downloadRichMedia";
      const deadlineAt = Date.now() + effectiveTimeout;

      if (!inVisit) {
        const dlRes = await invokeMsgDownload(chatType, peerUid, resolvedDownSourceType);
        const hit = await checkResolvedNow(dlRes);
        if (hit) {
          if (stats) stats.downloaded += 1;
          return hit;
        }
      } else if (hasVisitElem) {
        lastApiLabel = "downloadRichMediaInVisit";
        const appId = extractNtRichMediaAppId(elem);
        const isPositiveDigits = (/** @type {any} */ v) => /^[1-9]\d*$/.test(String(v || "").trim());
        const isNonZeroUid = (/** @type {any} */ v) => {
          const s = String(v || "").trim();
          return Boolean(s && s !== "0");
        };
        /** @type {Array<{ chatType: number, peerUid: string, guildId: string, senderUid: string }>} */
        const visitCandidates = [];
        const seenCandidates = new Set();
        /**
         * @param {any} cChatType
         * @param {any} cPeerUid
         * @param {string} [cGuildId]
         * @param {string} [cSenderUid]
         */
        const pushVisitCand = (cChatType, cPeerUid, cGuildId = "", cSenderUid = "") => {
          const ct = Number(cChatType || 0);
          const pu = String(cPeerUid || "").trim();
          const gu = String(cGuildId || "").trim();
          let su = String(cSenderUid ?? "").trim();
          if (su === "0") su = "";
          if (ct <= 0 || !isNonZeroUid(pu)) return;
          if (ct === 2 && !isPositiveDigits(pu)) return;
          const key = `${ct}|${pu}|${gu}|${su}`;
          if (seenCandidates.has(key)) return;
          seenCandidates.add(key);
          visitCandidates.push({
            chatType: ct,
            peerUid: pu,
            guildId: gu,
            senderUid: su,
          });
        };

        const c2cOuterSender = isNonZeroUid(forwardSenderUid)
          ? String(forwardSenderUid).trim()
          : Number(chatType) === 1 && isNonZeroUid(peerUid)
          ? String(peerUid).trim()
          : "";
        const childSender = isNonZeroUid(senderUid) ? String(senderUid).trim() : "";

        if (appId === 1406) {
          if (Number(chatType) === 1 && isNonZeroUid(peerUid)) {
            pushVisitCand(1, peerUid, "", c2cOuterSender || peerUid);
            pushVisitCand(1, peerUid, "", peerUid);
            pushVisitCand(1, peerUid, "", "");
          }
          if (Number(altChatType) === 1 && isNonZeroUid(altPeerUid)) {
            pushVisitCand(1, altPeerUid, "", childSender || altPeerUid);
            pushVisitCand(1, altPeerUid, "", altPeerUid);
            pushVisitCand(1, altPeerUid, "", "");
          }
          if (c2cOuterSender) {
            pushVisitCand(1, c2cOuterSender, "", c2cOuterSender);
          }
          if (childSender) {
            pushVisitCand(1, childSender, "", childSender);
          }
          pushVisitCand(chatType, peerUid, guildId, childSender || c2cOuterSender);
          pushVisitCand(altChatType, altPeerUid, altGuildId, childSender || c2cOuterSender);
        } else if (appId === 1407) {
          if (Number(chatType) === 2 && isPositiveDigits(peerUid)) {
            pushVisitCand(2, peerUid, "", childSender || c2cOuterSender);
          }
          if (isPositiveDigits(altPeerUid)) {
            pushVisitCand(2, altPeerUid, "", childSender || c2cOuterSender);
          }
          const groupCache = this.host._groupListCache;
          if (visitCandidates.length === 0 && groupCache instanceof Map && groupCache.size > 0) {
            for (const gKey of groupCache.keys()) {
              if (isPositiveDigits(gKey)) {
                pushVisitCand(2, gKey, "", childSender || c2cOuterSender);
                break;
              }
            }
          }
          if (Number(chatType) === 1 && isNonZeroUid(peerUid)) {
            pushVisitCand(1, peerUid, "", c2cOuterSender || peerUid);
            pushVisitCand(1, peerUid, "", "");
          }
          pushVisitCand(chatType, peerUid, guildId, childSender);
          pushVisitCand(altChatType, altPeerUid, altGuildId, childSender);
        } else {
          pushVisitCand(
            chatType,
            peerUid,
            guildId,
            Number(chatType) === 1 ? c2cOuterSender || peerUid : childSender
          );
          if (Number(chatType) === 1 && isNonZeroUid(peerUid)) {
            pushVisitCand(1, peerUid, "", "");
            if (childSender) pushVisitCand(1, peerUid, "", childSender);
          }
          pushVisitCand(
            altChatType,
            altPeerUid,
            altGuildId,
            Number(altChatType) === 1 ? childSender || altPeerUid : childSender
          );
        }

        for (let idx = 0; idx < visitCandidates.length; idx += 1) {
          if (downloadSettled) break;
          const remBefore = deadlineAt - Date.now();
          if (remBefore <= 0) break;
          const cand = visitCandidates[idx];
          const prevErrCount = stageErrorCount;
          try {
            const visitRes = await invokeVisitDownload(
              cand.chatType,
              cand.peerUid,
              cand.guildId,
              cand.senderUid
            );
            const visitHit = await checkResolvedNow(visitRes);
            if (visitHit) {
              if (stats) stats.downloaded += 1;
              return visitHit;
            }
          } catch (err) {
            this.host.logger?.debug?.("inbound", err);
            continue;
          }

          const remAfter = deadlineAt - Date.now();
          if (remAfter <= 0 || downloadSettled) break;
          const remainingCandidates = visitCandidates.length - idx;
          const isLastCandidate = remainingCandidates <= 1;
          const sliceMs = isLastCandidate
            ? stageErrorCount > 0
              ? Math.min(remAfter, 600)
              : remAfter
            : Math.min(
                remAfter,
                Math.max(
                  200,
                  Math.min(
                    stageErrorCount > 0 ? 500 : 1200,
                    Math.floor(remAfter / remainingCandidates)
                  )
                )
              );
          await waitSlice(sliceMs, prevErrCount);
          const settledHit = await checkResolvedNow(null);
          if (settledHit) {
            if (stats) stats.downloaded += 1;
            return settledHit;
          }
          if (isLastCandidate && stageErrorCount > prevErrCount && !downloadSettled) {
            finishWaitDownload("");
            break;
          }
        }
      } else if (hasValidMsgElemIds) {
        try {
          const dlRes = await invokeMsgDownload(chatType, peerUid, resolvedDownSourceType);
          const hit = await checkResolvedNow(dlRes);
          if (hit) {
            if (stats) stats.downloaded += 1;
            return hit;
          }
        } catch (err) {
          this.host.logger?.debug?.("inbound", err);
        }
        const hasDistinctAltPeer = Boolean(
          altPeerUid &&
            String(altPeerUid) !== "0" &&
            (String(altPeerUid) !== String(peerUid) ||
              Number(altChatType || 0) !== Number(chatType || 0))
        );
        if (!downloadSettled && hasDistinctAltPeer) {
          const prevErrCount = stageErrorCount;
          await waitSlice(
            Math.min(800, Math.max(200, Math.floor(effectiveTimeout * 0.4))),
            prevErrCount
          );
          if (!downloadSettled) {
            try {
              const altRes = await invokeMsgDownload(
                altChatType || chatType,
                altPeerUid,
                resolvedDownSourceType
              );
              const altHit = await checkResolvedNow(altRes);
              if (altHit) {
                if (stats) stats.downloaded += 1;
                return altHit;
              }
            } catch (err) {
              this.host.logger?.debug?.("inbound", err);
            }
          }
        }
      }

      const waitedPath = downloadSettled
        ? settledFilePath
        : Date.now() < deadlineAt
        ? await waitDownload
        : "";
      if (waitedPath && (await statPositiveFile(waitedPath))) {
        if (stats) stats.downloaded += 1;
        return String(waitedPath);
      }
      for (const checkPath of candidatePaths) {
        if (checkPath && (await statPositiveFile(checkPath))) {
          if (stats) stats.downloaded += 1;
          return String(checkPath);
        }
      }
      const endedByServerError = stageErrorCount > 0 && Date.now() < deadlineAt;
      if (!endedByServerError) {
        if (stats) {
          stats.timedOut += 1;
          stats.lastTimeout = {
            msgId: msgIdStr,
            elementId: elIdStr,
            downloadType: Number(downloadType ?? 1),
            downSourceType: resolvedDownSourceType,
            inVisit: Boolean(inVisit),
            timeoutMs: effectiveTimeout,
            at: Date.now(),
          };
        }
        this.host.logger?.warnThrottled?.(
          `richmedia-timeout:${downloadType ?? 1}`,
          `${lastApiLabel} timed out after ${effectiveTimeout}ms (msgId=${msgIdStr}, el=${elIdStr}, source=${resolvedDownSourceType})`,
          5000
        );
      }
    } catch (err) {
      this.host.logger?.debug?.("inbound", err);
    } finally {
      cleanupWaiter();
    }
    return "";
  }

  /**
   * @param {any} ntMsg
   * @param {any} el
   * @param {MediaHydrationContext} ctx
   */
  async hydratePicElement(ntMsg, el, ctx) {
    const pe = el.picElement;
    if (!pe || pe.__base64Uri) return;
    const origin = String(pe.originImageUrl || "").trim();
    if (origin && origin.includes("rkey=")) return;
    if (origin && /^https?:\/\//i.test(origin) && !isNtMultimediaDownloadUrl(origin)) {
      return;
    }

    let localPath = String(pe.sourcePath || "").trim();
    let st = await statPositiveFile(localPath);
    if (!st && Number(pe.fileSize || 0) > MAX_HYDRATE_PIC_BYTES) return;

    /** @type {string[]} */
    const altPicPaths = [];
    if (
      !ctx.skipRemoteDownload &&
      !st &&
      (!localPath || ctx.inVisit) &&
      pe.md5HexStr &&
      this.host._isNtReady()
    ) {
      try {
        const pathInfo = {
          md5HexStr: String(pe.md5HexStr),
          fileName: String(pe.fileName || `${pe.md5HexStr}.jpg`),
          elementType: 2,
          elementSubType: Number(pe.picSubType || 0),
          thumbSize: 0,
          needCreate: true,
          downloadType: 1,
          file_uuid: String(pe.fileUuid || ""),
        };
        const pathRes = await this.host.invokeNt(
          "nodeIKernelMsgService/getRichMediaFilePathForGuild",
          { path_info: pathInfo },
          [pathInfo]
        );
        const resolvedPath = String(
          (typeof pathRes === "string" ? pathRes : pathRes?.path) || ""
        ).trim();
        if (resolvedPath) {
          const resolvedStat = await statPositiveFile(resolvedPath);
          if (resolvedStat) {
            localPath = resolvedPath;
            st = resolvedStat;
          } else if (!localPath) {
            localPath = resolvedPath;
          } else if (resolvedPath !== localPath) {
            altPicPaths.push(resolvedPath);
          }
        }
      } catch (err) {
        this.host.logger?.debug?.("inbound", err);
      }
    }

    const bridgeTarget = this.host.bridge || this.host;
    const stats = this.host.richMediaStats || this.host.bridge?.richMediaStats;
    const hasRkeyFallbackUrl = Boolean(origin && isNtMultimediaDownloadUrl(origin));
    const origBudgetMs = ctx.remainingRemoteBudgetMs(8000);
    const kernelBudgetMs =
      ctx.inVisit && hasRkeyFallbackUrl ? Math.min(origBudgetMs, 1500) : origBudgetMs;
    if (!st && origBudgetMs <= 0 && (ctx.skipRemoteDownload || ctx.deadlineMs > 0)) {
      if (stats) stats.skippedByBudget += 1;
    }
    if (!st && kernelBudgetMs > 0 && (ntMsg.msgId || ctx.inVisit) && ctx.fallbackPeerUid) {
      const downloadedOrig = await this.downloadRichMediaElement({
        msgId: ntMsg.msgId || "0",
        chatType: ctx.fallbackChatType,
        peerUid: ctx.fallbackPeerUid,
        altChatType: ctx.altChatType,
        altPeerUid: ctx.altPeerUid,
        altGuildId: ctx.altGuildId,
        elementId: el.elementId || "0",
        downloadType: 1,
        downSourceType: ctx.downSourceType,
        thumbSize: 0,
        filePath: localPath,
        altFilePaths: altPicPaths,
        md5: pe.md5HexStr || "",
        inVisit: ctx.inVisit,
        elem: ctx.inVisit ? el : null,
        msgRandom: ntMsg.msgRandom || "0",
        msgSeq: ntMsg.msgSeq || "0",
        msgTime: ntMsg.msgTime || "0",
        forwardSenderUid: ctx.forwardSenderUid,
        senderUid: ctx.senderUid,
        guildId: ctx.fallbackGuildId,
        timeoutMs: kernelBudgetMs,
      });
      if (downloadedOrig) {
        const dlStat = await statPositiveFile(downloadedOrig);
        if (dlStat && dlStat.size <= MAX_HYDRATE_PIC_BYTES) {
          localPath = downloadedOrig;
          st = dlStat;
        }
      }
    }

    if (!st) {
      const thumbs =
        pe.thumbPath instanceof Map
          ? Array.from(pe.thumbPath.values())
          : pe.thumbPath && typeof pe.thumbPath === "object"
          ? Object.values(pe.thumbPath)
          : [];
      for (const tp of thumbs) {
        const candidate = String(tp || "").trim();
        const tpStat = await statPositiveFile(candidate);
        if (tpStat && tpStat.size <= MAX_HYDRATE_PIC_BYTES) {
          localPath = candidate;
          st = tpStat;
          break;
        }
      }
      // Skip downloadType=2 remote retry for inVisit virtual nodes: NTQQ kernel
      // DownloadRichMediaInVisit checks local SQLite (down_record_msg) on downloadType=2
      // and silently drops virtual child messages without emitting completion events.
      const thumbBudgetMs = ctx.inVisit ? 0 : ctx.remainingRemoteBudgetMs(5000);
      if (!st && thumbBudgetMs > 0 && ntMsg.msgId && ctx.fallbackPeerUid) {
        const fallbackThumbPath = thumbs.length > 0 ? String(thumbs[0] || "") : "";
        const downloadedThumb = await this.downloadRichMediaElement({
          msgId: ntMsg.msgId || "0",
          chatType: ctx.fallbackChatType,
          peerUid: ctx.fallbackPeerUid,
          altChatType: ctx.altChatType,
          altPeerUid: ctx.altPeerUid,
          altGuildId: ctx.altGuildId,
          elementId: el.elementId || "0",
          downloadType: 2,
          downSourceType: ctx.downSourceType,
          thumbSize: 720,
          filePath: fallbackThumbPath,
          md5: pe.md5HexStr || "",
          inVisit: false,
          elem: null,
          msgRandom: ntMsg.msgRandom || "0",
          msgSeq: ntMsg.msgSeq || "0",
          msgTime: ntMsg.msgTime || "0",
          forwardSenderUid: ctx.forwardSenderUid,
          senderUid: ctx.senderUid,
          guildId: ctx.fallbackGuildId,
          timeoutMs: thumbBudgetMs,
        });
        if (downloadedThumb) {
          const dlThumbStat = await statPositiveFile(downloadedThumb);
          if (dlThumbStat && dlThumbStat.size <= MAX_HYDRATE_PIC_BYTES) {
            localPath = downloadedThumb;
            st = dlThumbStat;
          }
        }
      }
    }

    const rkeyBudgetMs =
      !st && hasRkeyFallbackUrl && !ctx.skipRemoteDownload
        ? Math.max(ctx.remainingRemoteBudgetMs(8000), ctx.inVisit ? 2500 : 0)
        : 0;
    if (!st && rkeyBudgetMs > 150 && hasRkeyFallbackUrl && this.host._isNtReady()) {
      try {
        const rkeyDl = await downloadNtMultimediaWithRKey(bridgeTarget, origin, {
          targetPath: localPath,
          appId: extractNtRichMediaAppId(el),
          isGroup: Number(ctx.fallbackChatType) === 2,
          md5: pe.md5HexStr || "",
          fileName: pe.fileName || "",
          maxMediaBytes: MAX_HYDRATE_PIC_BYTES,
          timeoutMs: rkeyBudgetMs,
        });
        if (rkeyDl?.localPath) {
          const rkeyStat = await statPositiveFile(rkeyDl.localPath);
          if (rkeyStat && rkeyStat.size <= MAX_HYDRATE_PIC_BYTES) {
            localPath = rkeyDl.localPath;
            st = rkeyStat;
            if (stats) stats.downloaded += 1;
            if (rkeyDl.isTempFile && typeof this.host.bridge?.tempFileCleaner?.track === "function") {
              this.host.bridge.tempFileCleaner.track(rkeyDl.localPath);
            }
          }
        }
      } catch (err) {
        this.host.logger?.debug?.("inbound-rkey", err);
      }
    }

    if (st && st.size > 0 && localPath) {
      pe.sourcePath = localPath;
      defineLocalFileUrl(pe, localPath);
      if (st.size <= MAX_HYDRATE_PIC_BYTES) {
        try {
          const buf = await fs.promises.readFile(localPath);
          defineBase64Uri(pe, buf);
        } catch (err) {
          this.host.logger?.debug?.("inbound", err);
        }
      }
    }
  }

  /**
   * @param {any} ntMsg
   * @param {any} el
   * @param {MediaHydrationContext} ctx
   */
  async hydratePttElement(ntMsg, el, ctx) {
    const ptt = el.pttElement;
    if (!ptt || ptt.__base64Uri) return;
    let localPath = String(ptt.filePath || ptt.sourcePath || "").trim();
    let st = await statPositiveFile(localPath);

    const pttBudgetMs = ctx.remainingRemoteBudgetMs(8000);
    if (
      !st &&
      pttBudgetMs > 0 &&
      this.host._isNtReady() &&
      ntMsg.msgId &&
      ctx.fallbackPeerUid &&
      el.elementId
    ) {
      const downloadedPtt = await this.downloadRichMediaElement({
        msgId: ntMsg.msgId,
        chatType: ctx.fallbackChatType,
        peerUid: ctx.fallbackPeerUid,
        altChatType: ctx.altChatType,
        altPeerUid: ctx.altPeerUid,
        altGuildId: ctx.altGuildId,
        elementId: el.elementId,
        downloadType: 1,
        downSourceType: ctx.downSourceType,
        thumbSize: 0,
        filePath: localPath,
        md5: ptt.md5HexStr || "",
        inVisit: ctx.inVisit,
        elem: ctx.inVisit ? el : null,
        msgRandom: ntMsg.msgRandom || "0",
        msgSeq: ntMsg.msgSeq || "0",
        msgTime: ntMsg.msgTime || "0",
        senderUid: ctx.senderUid,
        guildId: ctx.fallbackGuildId,
        timeoutMs: pttBudgetMs,
      });
      if (downloadedPtt) {
        localPath = downloadedPtt;
        st = await statPositiveFile(localPath);
      }
    }

    if (!ctx.skipRemoteDownload && !st && this.host._isNtReady() && ptt.md5HexStr) {
      try {
        const pathInfo = {
          md5HexStr: String(ptt.md5HexStr),
          fileName: String(ptt.fileName || `${ptt.md5HexStr}.amr`),
          elementType: 4,
          elementSubType: 0,
          thumbSize: 0,
          needCreate: false,
          downloadType: 1,
          file_uuid: String(ptt.fileUuid || ""),
        };
        const pathRes = await this.host.invokeNt(
          "nodeIKernelMsgService/getRichMediaFilePathForGuild",
          { path_info: pathInfo },
          [pathInfo]
        );
        const resolvedPath = typeof pathRes === "string" ? pathRes : pathRes?.path || "";
        if (resolvedPath) {
          const cachedStat = await statPositiveFile(String(resolvedPath));
          if (cachedStat) {
            localPath = String(resolvedPath);
            st = cachedStat;
          }
        }
      } catch (err) {
        this.host.logger?.debug?.("inbound", err);
      }
    }

    if (st && st.size > 0 && localPath) {
      ptt.filePath = localPath;
      defineLocalFileUrl(ptt, localPath);
      if (st.size <= MAX_HYDRATE_PTT_BYTES) {
        try {
          const buf = await fs.promises.readFile(localPath);
          defineBase64Uri(ptt, buf);
        } catch (err) {
          this.host.logger?.debug?.("inbound", err);
        }
      }
    }
  }

  /**
   * @param {any} el
   */
  async hydrateVideoElement(el) {
    const ve = el.videoElement;
    if (!ve || ve.__localFileUrl) return;
    const localPath = String(ve.filePath || ve.sourcePath || "").trim();
    const st = await statPositiveFile(localPath);
    if (st && st.size > 0 && localPath) {
      ve.filePath = localPath;
      defineLocalFileUrl(ve, localPath);
    }
  }

  /**
   * @param {any} ntMsg
   * @param {Record<string, any>} [options={}]
   */
  async hydrateNtMsgMedia(ntMsg, options = {}) {
    if (!ntMsg || typeof ntMsg !== "object" || !Array.isArray(ntMsg.elements)) return;
    const skipRemoteDownload = Boolean(options?.skipRemoteDownload);
    const inVisit = Boolean(options?.inVisit);
    const downSourceType = Number(options?.downSourceType ?? (inVisit ? 1 : 0));
    const hasOptionPeer = Boolean(options?.peerUid && String(options.peerUid) !== "0");
    const hasMsgPeer = Boolean(ntMsg.peerUid && String(ntMsg.peerUid) !== "0");
    const preferOptionPeer = Boolean(inVisit && hasOptionPeer);
    const fallbackChatType = Number(
      preferOptionPeer
        ? options.chatType || ntMsg.chatType || 1
        : hasMsgPeer
        ? ntMsg.chatType || options?.chatType || 1
        : options?.chatType || ntMsg.chatType || 1
    );
    const fallbackPeerUid = String(
      preferOptionPeer ? options.peerUid : hasMsgPeer ? ntMsg.peerUid : options?.peerUid || ""
    );
    const fallbackGuildId = String(
      preferOptionPeer
        ? options?.guildId || ""
        : hasMsgPeer
        ? ntMsg.guildId || options?.guildId || ""
        : options?.guildId || ntMsg.guildId || ""
    );
    const altChatType = preferOptionPeer && hasMsgPeer ? Number(ntMsg.chatType || 0) : 0;
    const altPeerUid = preferOptionPeer && hasMsgPeer ? String(ntMsg.peerUid) : "";
    const altGuildId = preferOptionPeer && hasMsgPeer ? String(ntMsg.guildId || "") : "";
    const forwardSenderUid = String(
      options?.forwardSenderUid ||
        (inVisit && Number(options?.chatType) === 1 && hasOptionPeer ? options.peerUid : "") ||
        ""
    );
    const senderUid = String(ntMsg.senderUid || options?.senderUid || "");
    const hydrationTimeout = Math.max(
      100,
      Number(
        options?.timeoutMs ??
          this.host.config?.mediaHydrationTimeoutMs ??
          this.host.config?.richMediaDownloadTimeoutMs ??
          8000
      ) || 8000
    );
    const deadlineMs = Number(options?.deadlineMs) > 0 ? Number(options.deadlineMs) : 0;
    /** @param {number} capMs */
    const remainingRemoteBudgetMs = (capMs) => {
      if (skipRemoteDownload) return 0;
      if (deadlineMs > 0) {
        const rem = deadlineMs - Date.now();
        if (rem <= 0) return 0;
        return Math.min(hydrationTimeout, capMs, rem);
      }
      return Math.min(hydrationTimeout, capMs);
    };

    /** @type {MediaHydrationContext} */
    const ctx = {
      skipRemoteDownload,
      inVisit,
      downSourceType,
      fallbackChatType,
      fallbackPeerUid,
      fallbackGuildId,
      altChatType,
      altPeerUid,
      altGuildId,
      forwardSenderUid,
      senderUid,
      deadlineMs,
      remainingRemoteBudgetMs,
    };

    for (const el of ntMsg.elements) {
      if (!el || typeof el !== "object") continue;
      const elType = Number(el.elementType);
      if (elType === 2 && el.picElement) {
        await this.hydratePicElement(ntMsg, el, ctx);
      } else if (elType === 4 && el.pttElement) {
        await this.hydratePttElement(ntMsg, el, ctx);
      } else if (elType === 5 && el.videoElement) {
        await this.hydrateVideoElement(el);
      }
    }

    this.host.messageIdStore?.indexMsgMedia?.(ntMsg);
  }
}

module.exports = {
  MediaHydrator,
  MAX_HYDRATE_PIC_BYTES,
  MAX_HYDRATE_PTT_BYTES,
  statPositiveFile,
  cloneElemForVisitDownload,
  defineLocalFileUrl,
  defineBase64Uri,
  stripTransientMedia,
};
