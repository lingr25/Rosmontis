"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  normalizeOneBotMessage,
  oneBotSegmentsToNtElements,
} = require("../bridge_onebot");

const BRIDGE_UNAVAILABLE_TAG = "ROSMONTIS_BRIDGE_UNAVAILABLE";

let cachedRendererIpc = null;
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
  } catch (_) {}
  return null;
}

function makeBridgeUnavailableError(message) {
  const mod = getRendererIpcHelpers();
  if (mod) return mod.makeBridgeUnavailableError(message);
  const err = new Error(message || "NTQQ bridge unavailable");
  err.code = BRIDGE_UNAVAILABLE_TAG;
  Object.defineProperty(err, BRIDGE_UNAVAILABLE_TAG, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return err;
}

function isBridgeUnavailableError(err) {
  const mod = getRendererIpcHelpers();
  if (mod) return mod.isBridgeUnavailableError(err);
  return Boolean(err && (err.code === BRIDGE_UNAVAILABLE_TAG || err[BRIDGE_UNAVAILABLE_TAG]));
}

// --------------------------------------------------------------------------
// Outbound message echo correlation (sendMsg result <-> onAddSendMsg msgRecord)
//
// NTQQ `sendMsg` usually resolves with `{ result, errMsg }` only; the real 64-bit msgId of
// the outgoing message is delivered via `nodeIKernelMsgListener/onAddSendMsg`. Waiters are
// registered per peer BEFORE dispatching sendMsg (the echo may arrive before sendMsg
// resolves) and matched FIFO, skipping candidates whose plain text clearly differs.
// --------------------------------------------------------------------------

function _ntElementsSignature(elements) {
  const parts = [];
  let text = "";
  if (Array.isArray(elements)) {
    for (const el of elements) {
      if (!el || typeof el !== "object") continue;
      const type = Number(el.elementType || 0);
      if (type === 1 && el.textElement) {
        const atType = Number(el.textElement.atType || 0);
        if (atType === 0) {
          const chunk = String(el.textElement.content || "");
          if (!chunk) continue;
          text += chunk;
          const prev = parts[parts.length - 1];
          if (prev && prev.kind === "text") {
            prev.text += chunk;
          } else {
            parts.push({ kind: "text", text: chunk });
          }
        } else {
          parts.push({
            kind: "at",
            atType,
            uid: String(el.textElement.atNtUid || ""),
            uin: String(el.textElement.atUid || ""),
          });
        }
      } else if (type === 2 && el.picElement) {
        parts.push({
          kind: "pic",
          md5: String(el.picElement.md5HexStr || "").toLowerCase(),
          subType: Number(el.picElement.picSubType || 0),
          name: String(el.picElement.fileName || ""),
        });
      } else if (type === 3 && el.fileElement) {
        parts.push({
          kind: "file",
          md5: String(el.fileElement.fileMd5 || "").toLowerCase(),
          name: String(el.fileElement.fileName || ""),
        });
      } else if (type === 4 && el.pttElement) {
        parts.push({
          kind: "ptt",
          md5: String(el.pttElement.md5HexStr || "").toLowerCase(),
          name: String(el.pttElement.fileName || ""),
        });
      } else if (type === 5 && el.videoElement) {
        parts.push({
          kind: "video",
          md5: String(el.videoElement.videoMd5 || "").toLowerCase(),
          name: String(el.videoElement.fileName || ""),
        });
      } else if (type === 6 && el.faceElement) {
        parts.push({
          kind: "face",
          faceType: Number(el.faceElement.faceType || 0),
          faceIndex: Number(el.faceElement.faceIndex || 0),
          pokeType: Number(el.faceElement.pokeType || 0),
        });
      } else if (type === 7 && el.replyElement) {
        parts.push({
          kind: "reply",
          msgId: String(el.replyElement.replayMsgId || "0"),
          msgSeq: String(el.replyElement.replayMsgSeq || "0"),
        });
      } else if (type === 10 && el.arkElement) {
        parts.push({
          kind: "ark",
          data: String(el.arkElement.bytesData || ""),
        });
      } else if (type === 11 && el.marketFaceElement) {
        parts.push({
          kind: "mface",
          emojiId: String(el.marketFaceElement.emojiId || ""),
        });
      } else if (type > 0) {
        parts.push({ kind: `el:${type}` });
      }
    }
  }
  return { text: text.trim(), parts };
}

function _elementsSignatureMatch(expected, actual) {
  const aList = expected?.parts;
  const bList = actual?.parts;
  if (!Array.isArray(aList) || !Array.isArray(bList)) return false;
  if (aList.length === 0 || aList.length !== bList.length) return false;
  for (let i = 0; i < aList.length; i++) {
    const a = aList[i];
    const b = bList[i];
    if (!a || !b || a.kind !== b.kind) return false;
    if (a.kind === "text") {
      if (a.text.trim() !== b.text.trim()) return false;
      if (!a.text.trim() && a.text !== b.text) return false;
    } else if (a.kind === "at") {
      if (a.atType !== b.atType) return false;
      if (a.uid && b.uid) {
        if (a.uid !== b.uid) return false;
      } else if (a.uin && b.uin && a.uin !== b.uin) {
        return false;
      }
    } else if (a.kind === "pic" || a.kind === "file" || a.kind === "ptt" || a.kind === "video") {
      if (a.md5 && b.md5) {
        if (a.md5 !== b.md5) return false;
      } else if (a.name && b.name && a.name !== b.name) {
        return false;
      }
    } else if (a.kind === "face") {
      if (a.faceType !== b.faceType || a.faceIndex !== b.faceIndex || a.pokeType !== b.pokeType) {
        return false;
      }
    } else if (a.kind === "reply") {
      if (a.msgId !== "0" && b.msgId !== "0") {
        if (a.msgId !== b.msgId) return false;
      } else if (a.msgSeq !== "0" && b.msgSeq !== "0" && a.msgSeq !== b.msgSeq) {
        return false;
      }
    } else if (a.kind === "ark") {
      if (a.data !== b.data) return false;
    } else if (a.kind === "mface") {
      if (a.emojiId !== b.emojiId) return false;
    }
  }
  return true;
}

const outboundPipelineMixin = {
  async _resolvePeerForUser(userId, groupId) {
    const uinStr = String(userId || "").trim();
    const uid = await this.uinUidStore.resolveUid(uinStr, this.invokeNt.bind(this));
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
  },

  async _prepareNtImagePath(media, subType = 0) {
    const elemSubType = Number(subType || 0);
    try {
      const exifRes = await this.invokeNt(
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
        } catch (_) {}
        return {
          localPath: newPath,
          md5HexStr: String(exifRes.md5 || media.md5HexStr),
          fileSize,
          fileName: path.basename(newPath) || media.fileName,
        };
      }
    } catch (_) {}

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
      const pathRes = await this.invokeNt(
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
        } catch (_) {
          await this.invokeNt(
            "nodeIKernelFileAssistantService/copyFile",
            { fromPath: media.localPath, toPath: targetPath },
            [media.localPath, targetPath]
          );
          return targetPath;
        }
      }
    } catch (_) {}
    return media.localPath;
  },

  _sendPeerKey(peer) {
    return `${Number(peer?.chatType) || 0}:${String(peer?.peerUid || "")}`;
  },

  _registerSendEchoWaiter(peer, elements) {
    const key = this._sendPeerKey(peer);
    const sigFn =
      typeof this?.constructor?._ntElementsSignature === "function"
        ? this.constructor._ntElementsSignature
        : _ntElementsSignature;
    const waiter = {
      sig: sigFn(elements),
      echo: null,
      resolve: null,
      done: false,
    };
    const queue = this._sendEchoWaiters.get(key) || [];
    queue.push(waiter);
    while (queue.length > 32) {
      const stale = queue.shift();
      stale.done = true;
      if (stale.resolve) stale.resolve(null);
    }
    this._sendEchoWaiters.set(key, queue);

    const remove = () => {
      const q = this._sendEchoWaiters.get(key);
      if (!q) return;
      const idx = q.indexOf(waiter);
      if (idx >= 0) q.splice(idx, 1);
      if (q.length === 0) this._sendEchoWaiters.delete(key);
    };

    return {
      wait: (timeoutMs) => {
        if (waiter.echo || waiter.done) {
          waiter.done = true;
          remove();
          return Promise.resolve(waiter.echo);
        }
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            waiter.done = true;
            waiter.resolve = null;
            remove();
            resolve(null);
          }, Math.max(0, Number(timeoutMs) || 0));
          // Intentionally NOT unref'd: the caller is awaiting this bounded timer.
          waiter.resolve = (echo) => {
            clearTimeout(timer);
            waiter.done = true;
            waiter.resolve = null;
            remove();
            resolve(echo);
          };
        });
      },
      cancel: () => {
        waiter.done = true;
        waiter.resolve = null;
        remove();
      },
    };
  },

  _matchSendEcho(ntMsg) {
    if (!ntMsg || !ntMsg.msgId || String(ntMsg.msgId) === "0") return false;
    const key = this._sendPeerKey({ chatType: ntMsg.chatType, peerUid: ntMsg.peerUid });
    const queue = this._sendEchoWaiters.get(key);
    if (!queue || queue.length === 0) return false;
    const sigFn =
      typeof this?.constructor?._ntElementsSignature === "function"
        ? this.constructor._ntElementsSignature
        : _ntElementsSignature;
    const matchFn =
      typeof this?.constructor?._elementsSignatureMatch === "function"
        ? this.constructor._elementsSignatureMatch
        : _elementsSignatureMatch;
    const sig = sigFn(ntMsg.elements);
    const waiter = queue.find(
      (w) => !w.done && !w.echo && matchFn(w.sig, sig)
    );
    if (!waiter) return false;
    waiter.echo = {
      msgId: String(ntMsg.msgId),
      msgSeq: String(ntMsg.msgSeq || "0"),
      msgTime: ntMsg.msgTime !== undefined ? Number(ntMsg.msgTime) : undefined,
      rawMsg: ntMsg,
    };
    if (waiter.resolve) waiter.resolve(waiter.echo);
    return true;
  },

  _hasRichMediaElements(elements) {
    if (!Array.isArray(elements)) return false;
    return elements.some((el) => {
      if (!el || typeof el !== "object") return false;
      const t = Number(el.elementType);
      return (
        t === 2 ||
        t === 3 ||
        t === 4 ||
        t === 5 ||
        Boolean(el.picElement || el.fileElement || el.pttElement || el.videoElement)
      );
    });
  },

  _computeSendEchoTimeoutMs(elements) {
    const textTimeout = Math.max(0, Number(this.config.sendEchoTimeoutMs ?? 3000));
    if (!this._hasRichMediaElements(elements)) {
      return textTimeout;
    }
    const rawRich =
      this.config.richMediaEchoTimeoutMs ??
      this.config.sendRichMediaEchoTimeoutMs ??
      15000;
    const baseRich = Math.max(textTimeout, Math.max(0, Number(rawRich)));
    let totalBytes = 0;
    for (const el of elements) {
      const sub = el?.picElement || el?.fileElement || el?.pttElement || el?.videoElement;
      const sz = Number(sub?.fileSize || 0);
      if (Number.isFinite(sz) && sz > 0) totalBytes += sz;
    }
    const extraMb =
      totalBytes > 1024 * 1024 ? Math.ceil((totalBytes - 1024 * 1024) / (1024 * 1024)) : 0;
    const maxTimeout = Math.max(baseRich, Number(this.config.maxSendEchoTimeoutMs ?? 60000));
    return Math.min(maxTimeout, baseRich + extraMb * 2000);
  },

  _mediaSecurityOptions() {
    return {
      maxMediaBytes: this.config.maxMediaBytes,
      allowPrivateUrls:
        this.config.allowPrivateUrls === true || this.config.allowPrivateMediaUrls === true
          ? true
          : undefined,
      allowArbitraryLocalFiles:
        this.config.allowArbitraryLocalFiles === true ? true : undefined,
      allowedFileDirs: this.config.allowedFileDirs,
    };
  },

  async _sendMessageToPeer(peer, message, autoEscape = false, groupId = undefined, options = {}) {
    const peerKey = `${peer.chatType}:${peer.peerUid}:${peer.guildId || ""}`;
    this._sessionScheduler.cancelPeerReaction(peerKey);

    // Phase 1 (unlocked): concurrent heavy I/O (HTTP media download, EXIF normalize, @UIN->UID)
    const { elements, sideEffects, cleanupCallbacks } = await oneBotSegmentsToNtElements(message, {
      autoEscape,
      groupId,
      uinUidStore: this.uinUidStore,
      messageIdStore: this.messageIdStore,
      invokeNt: this.invokeNt.bind(this),
      prepareNtImagePath: this._prepareNtImagePath.bind(this),
      ...this._mediaSecurityOptions(),
    });

    try {
      // Phase 2 (AIO-mutex serialized): activate target AIO + dispatch sendMsg IPC, then release immediately
      const { echoWaiter, sendRes } = await this._withAioLock(
        async () => {
          this._sessionScheduler.cancelPeerReaction(peerKey);
          if (this.config.humanSimulation !== false && !options.skipHumanSimulation) {
            await this._activateSessionUnlocked({
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
                effect.qq || (peer.chatType === 1 ? Number(this.uinUidStore.getUinSync(peer.peerUid)) : 0)
              );
            }
          }

          if (elements.length === 0) {
            return { echoWaiter: null, sendRes: null };
          }

          const waiter = this._registerSendEchoWaiter(peer, elements);
          try {
            const res = await this.invokeNt(
              "nodeIKernelMsgService/sendMsg",
              {
                msgId: "0",
                peer,
                msgElements: elements,
                msgAttributeInfos: new Map(),
              },
              ["0", peer, elements, new Map()]
            );
            if (this.config.humanSimulation !== false && !options.skipHumanSimulation) {
              this._touchAioActivity();
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
      const normId = (v) => (v !== undefined && v !== null && String(v) !== "0" ? String(v) : "");
      let realMsgId = normId(sendRes?.msgId || sendRes?.msgRecord?.msgId);
      let msgSeq = String(sendRes?.msgSeq || sendRes?.msgRecord?.msgSeq || "0");
      let msgTime = Math.floor(Date.now() / 1000);
      if (realMsgId) {
        echoWaiter.cancel();
        this.sendEchoStats.fromResult += 1;
      } else {
        const echoTimeoutMs = this._computeSendEchoTimeoutMs(elements);
        const echo = await echoWaiter.wait(echoTimeoutMs);
        if (echo && echo.msgId) {
          realMsgId = echo.msgId;
          if (msgSeq === "0" && echo.msgSeq) msgSeq = echo.msgSeq;
          if (Number.isFinite(echo.msgTime) && echo.msgTime > 0) msgTime = echo.msgTime;
          this.sendEchoStats.matched += 1;
        } else {
          this.sendEchoStats.timedOut += 1;
          this._logWarn(
            `send-echo-timeout:${this._sendPeerKey(peer)}`,
            `sendMsg to ${this._sendPeerKey(peer)} succeeded but no onAddSendMsg echo arrived within ${echoTimeoutMs}ms; message_id will not be recallable`
          );
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
      });

      return { message_id: shortId, real_id: realMsgId };
    } finally {
      this._scheduleTempCleanup(cleanupCallbacks, Boolean(options.cleanupTempImmediately));
    }
  },

  async _sendPokeInternal(groupId, userId) {
    const targetUin = Number(userId || 0);
    const targetGroup = groupId ? Number(groupId) : 0;
    const targetUid = targetUin
      ? await this.uinUidStore.resolveUid(targetUin, this.invokeNt.bind(this))
      : "";
    const peer =
      targetGroup > 0
        ? { chatType: 2, peerUid: String(targetGroup), guildId: "" }
        : await this._resolvePeerForUser(targetUin);

    // 1. Primary: genuine NTQQ 3.2.32 `nodeIKernelMsgService/sendNudge`
    try {
      await this.invokeNt(
        "nodeIKernelMsgService/sendNudge",
        {
          peer,
          toUid: targetUid || String(targetUin),
          uid: targetUid || String(targetUin),
        },
        [peer, targetUid || String(targetUin)]
      );
      return;
    } catch (err) {
      if (!isBridgeUnavailableError(err)) throw err;
    }

    // 2. Fallback: legacy `sendPoke` if bridged by a custom adapter
    try {
      if (targetGroup > 0) {
        await this.invokeNt("nodeIKernelMsgService/sendPoke", {
          groupCode: String(targetGroup),
          toUin: String(targetUin),
          peer,
          targetUid: targetUid || String(targetUin),
        });
        return;
      }
      await this.invokeNt("nodeIKernelMsgService/sendPoke", {
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
      await this.invokeNt(
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
  },
};

module.exports = {
  outboundPipelineMixin,
  _ntElementsSignature,
  _elementsSignatureMatch,
  BRIDGE_UNAVAILABLE_TAG,
  makeBridgeUnavailableError,
  isBridgeUnavailableError,
  normalizeOneBotMessage,
};
