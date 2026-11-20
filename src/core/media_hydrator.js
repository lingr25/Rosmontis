// @ts-check
"use strict";

/**
 * Inbound Rich-Media Download & Hydration Subsystem (`src/core/media_hydrator.js`)
 *
 * Extracted from `src/core/inbound_pipeline.js`:
 * - `onRichMediaDownloadComplete` waiter resolution (`_handleRichMediaDownloadComplete`)
 * - Active NTQQ rich-media download with event waiter + fs stat polling (`_downloadRichMediaElement`)
 * - Inbound message media hydration for `picElement`, `pttElement`, and `videoElement` (`_hydrateNtMsgMedia`)
 * - Non-enumerable `__localFileUrl` / `__base64Uri` helpers & transient media stripping
 */

const fs = require("fs");
const { pathToFileURL } = require("url");

const bridgeOnebot = require("../bridge_onebot");

const MAX_HYDRATE_PIC_BYTES = 10 * 1024 * 1024;
const MAX_HYDRATE_PTT_BYTES = 2 * 1024 * 1024;

async function statPositiveFile(filePath) {
  if (!filePath) return null;
  try {
    const st = await fs.promises.stat(String(filePath));
    if (st.isFile() && st.size > 0) {
      return st;
    }
  } catch (_) {
    // Expected when rich media file is not downloaded yet or path is not readable.
  }
  return null;
}

function defineLocalFileUrl(target, localPath) {
  if (!target || typeof target !== "object" || !localPath) return;
  try {
    Object.defineProperty(target, "__localFileUrl", {
      value: pathToFileURL(String(localPath)).href,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch (_) {
    // Target NTQQ element object may be frozen or non-extensible; skip non-enumerable attachment.
  }
}

function defineBase64Uri(target, buf) {
  if (!target || typeof target !== "object" || !buf) return;
  Object.defineProperty(target, "__base64Uri", {
    value: `base64://${buf.toString("base64")}`,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

function stripTransientMedia(ntMsg) {
  if (typeof bridgeOnebot.stripTransientNtMedia === "function") {
    try {
      bridgeOnebot.stripTransientNtMedia(ntMsg);
    } catch (_) {
      // Fallback to direct element cleanup below if facade strip helper fails.
    }
  }
  if (!ntMsg || typeof ntMsg !== "object" || !Array.isArray(ntMsg.elements)) return;
  for (const el of ntMsg.elements) {
    if (!el || typeof el !== "object") continue;
    if (el.picElement && typeof el.picElement === "object") {
      if ("__base64Uri" in el.picElement) delete el.picElement.__base64Uri;
      if ("__localFileUrl" in el.picElement) delete el.picElement.__localFileUrl;
    }
    if (el.pttElement && typeof el.pttElement === "object") {
      if ("__base64Uri" in el.pttElement) delete el.pttElement.__base64Uri;
      if ("__localFileUrl" in el.pttElement) delete el.pttElement.__localFileUrl;
    }
    if (el.videoElement && typeof el.videoElement === "object") {
      if ("__base64Uri" in el.videoElement) delete el.videoElement.__base64Uri;
      if ("__localFileUrl" in el.videoElement) delete el.videoElement.__localFileUrl;
    }
  }
}

const mediaHydratorMixin = {
  /** @this {any} */
  _handleRichMediaDownloadComplete(firstArg) {
    const info = firstArg?.notifyInfo || firstArg || {};
    const msgId = String(info.msgId || "");
    const elId = String(info.msgElementId || info.elementId || "");
    const filePath = String(info.filePath || "");
    const keys = [`${msgId}:${elId}`, `${msgId}:0`, filePath].filter(Boolean);
    const toInvoke = new Set();

    for (const k of keys) {
      const set = this._richMediaWaiters?.get(k);
      if (!set) continue;
      for (const waiter of Array.from(set)) {
        if (typeof waiter === "function") {
          set.delete(waiter);
          toInvoke.add(waiter);
        } else if (waiter && typeof waiter.resolve === "function") {
          const specificElMismatch =
            elId &&
            elId !== "0" &&
            waiter.elementId &&
            waiter.elementId !== "0" &&
            waiter.elementId !== elId &&
            (!filePath || !waiter.targetPath || filePath !== waiter.targetPath);
          if (!specificElMismatch) {
            set.delete(waiter);
            toInvoke.add(waiter);
          }
        }
      }
      if (set.size === 0) {
        this._richMediaWaiters.delete(k);
      }
    }

    for (const waiter of toInvoke) {
      try {
        if (typeof waiter === "function") {
          waiter(filePath);
        } else {
          waiter.resolve(filePath);
        }
      } catch (err) {
        this.logger?.debug?.("inbound", err);
      }
    }
  },

  /**
   * @this {any}
   */
  async _downloadRichMediaElement(
    {
      msgId,
      chatType,
      peerUid,
      elementId,
      downloadType = 1,
      downSourceType = 0,
      downloadScene = 0,
      fileModelId = "0",
      thumbSize = 0,
      filePath = "",
      timeoutMs = 8000,
    } = /** @type {Record<string, any>} */ ({})
  ) {
    const targetPath = filePath ? String(filePath).trim() : "";
    if (targetPath) {
      const existingStat = await statPositiveFile(targetPath);
      if (existingStat) {
        return targetPath;
      }
    }
    if (!this._isNtReady()) return "";
    if (!msgId || !peerUid) return "";

    const msgIdStr = String(msgId);
    const elIdStr = String(elementId || "0");
    const effectiveTimeout = Math.max(100, Number(timeoutMs) || 8000);
    if (!this._richMediaWaiters) {
      this._richMediaWaiters = new Map();
    }
    const waitKeys = [`${msgIdStr}:${elIdStr}`, `${msgIdStr}:0`, targetPath].filter(Boolean);

    let timer = null;
    let pollTimer = null;
    let waiterEntry = null;
    const cleanupWaiter = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (waiterEntry && this._richMediaWaiters) {
        for (const k of waitKeys) {
          const set = this._richMediaWaiters.get(k);
          if (set) {
            set.delete(waiterEntry);
            if (set.size === 0) {
              this._richMediaWaiters.delete(k);
            }
          }
        }
      }
    };

    const waitDownload = new Promise((resolve) => {
      let settled = false;
      let polling = false;
      const finish = (candidate) => {
        if (settled) return;
        settled = true;
        cleanupWaiter();
        resolve(candidate || targetPath);
      };
      waiterEntry = {
        msgId: msgIdStr,
        elementId: elIdStr,
        targetPath,
        resolve: (downloadedPath) => finish(downloadedPath || targetPath),
      };
      for (const k of waitKeys) {
        if (!this._richMediaWaiters.has(k)) {
          this._richMediaWaiters.set(k, new Set());
        }
        this._richMediaWaiters.get(k).add(waiterEntry);
      }
      if (targetPath) {
        pollTimer = setInterval(async () => {
          if (polling || settled) return;
          polling = true;
          try {
            const st = await statPositiveFile(targetPath);
            if (st) {
              finish(targetPath);
            }
          } finally {
            polling = false;
          }
        }, 200);
        pollTimer.unref?.();
      }
      timer = setTimeout(() => finish(targetPath), effectiveTimeout);
      timer.unref?.();
    });

    try {
      const resolvedDownSourceType = Number(downSourceType ?? 0);
      const getReq = {
        downSourceType: resolvedDownSourceType,
        downloadSourceType: resolvedDownSourceType,
        downloadScene: Number(downloadScene ?? 0),
        fileModelId: String(fileModelId || "0"),
        triggerType: 1,
        msgId: msgIdStr,
        chatType: Number(chatType || 1),
        peerUid: String(peerUid),
        elementId: elIdStr,
        thumbSize: Number(thumbSize || 0),
        downloadType: Number(downloadType ?? 1),
        filePath: targetPath,
      };
      const dlRes =
        typeof this.invokeNt === "function"
          ? await this.invokeNt(
              "nodeIKernelMsgService/downloadRichMedia",
              { getReq },
              [getReq]
            )
          : typeof this.ntCall === "function"
          ? await this.ntCall("nodeIKernelMsgService", "downloadRichMedia", [{ getReq }])
          : null;
      const directPath =
        typeof dlRes === "string" ? dlRes : dlRes?.filePath ? String(dlRes.filePath) : "";
      if (directPath && (await statPositiveFile(directPath))) {
        return directPath;
      }
      if (targetPath && (await statPositiveFile(targetPath))) {
        return targetPath;
      }
      const waitedPath = await waitDownload;
      if (waitedPath && (await statPositiveFile(waitedPath))) {
        return String(waitedPath);
      }
    } catch (err) {
      this.logger?.debug?.("inbound", err);
    } finally {
      cleanupWaiter();
    }
    return "";
  },

  /** @this {any} */
  async _hydratePicElement(ntMsg, el, ctx) {
    const pe = el.picElement;
    if (!pe || pe.__base64Uri) return;
    const origin = String(pe.originImageUrl || "").trim();
    if (origin && origin.includes("rkey=")) return;
    if (
      origin &&
      /^https?:\/\//i.test(origin) &&
      !origin.includes("multimedia.nt.qq.com.cn/download")
    ) {
      return;
    }

    let localPath = String(pe.sourcePath || "").trim();
    let st = await statPositiveFile(localPath);
    if (!st && Number(pe.fileSize || 0) > MAX_HYDRATE_PIC_BYTES) return;

    if (!ctx.skipRemoteDownload && !st && !localPath && pe.md5HexStr && this._isNtReady()) {
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
        const pathRes = await this.invokeNt(
          "nodeIKernelMsgService/getRichMediaFilePathForGuild",
          { path_info: pathInfo },
          [pathInfo]
        );
        const resolvedPath = typeof pathRes === "string" ? pathRes : pathRes?.path || "";
        if (resolvedPath) {
          localPath = String(resolvedPath);
          st = await statPositiveFile(localPath);
        }
      } catch (err) {
        this.logger?.debug?.("inbound", err);
      }
    }

    const origBudgetMs = ctx.remainingRemoteBudgetMs(8000);
    if (!st && origBudgetMs > 0 && ntMsg.msgId && ctx.fallbackPeerUid) {
      const downloadedOrig = await this._downloadRichMediaElement({
        msgId: ntMsg.msgId,
        chatType: ctx.fallbackChatType,
        peerUid: ctx.fallbackPeerUid,
        elementId: el.elementId || "0",
        downloadType: 1,
        downSourceType: ctx.downSourceType,
        thumbSize: 0,
        filePath: localPath,
        timeoutMs: origBudgetMs,
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
      const thumbBudgetMs = ctx.remainingRemoteBudgetMs(5000);
      if (!st && thumbBudgetMs > 0 && ntMsg.msgId && ctx.fallbackPeerUid) {
        const fallbackThumbPath = thumbs.length > 0 ? String(thumbs[0] || "") : "";
        const downloadedThumb = await this._downloadRichMediaElement({
          msgId: ntMsg.msgId,
          chatType: ctx.fallbackChatType,
          peerUid: ctx.fallbackPeerUid,
          elementId: el.elementId || "0",
          downloadType: 2,
          downSourceType: ctx.downSourceType,
          thumbSize: 720,
          filePath: fallbackThumbPath,
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

    if (st && st.size > 0 && localPath) {
      pe.sourcePath = localPath;
      defineLocalFileUrl(pe, localPath);
      if (st.size <= MAX_HYDRATE_PIC_BYTES) {
        try {
          const buf = await fs.promises.readFile(localPath);
          defineBase64Uri(pe, buf);
        } catch (err) {
          this.logger?.debug?.("inbound", err);
        }
      }
    }
  },

  /** @this {any} */
  async _hydratePttElement(ntMsg, el, ctx) {
    const ptt = el.pttElement;
    if (!ptt || ptt.__base64Uri) return;
    let localPath = String(ptt.filePath || ptt.sourcePath || "").trim();
    let st = await statPositiveFile(localPath);

    const pttBudgetMs = ctx.remainingRemoteBudgetMs(8000);
    if (
      !st &&
      pttBudgetMs > 0 &&
      this._isNtReady() &&
      ntMsg.msgId &&
      ctx.fallbackPeerUid &&
      el.elementId
    ) {
      const downloadedPtt = await this._downloadRichMediaElement({
        msgId: ntMsg.msgId,
        chatType: ctx.fallbackChatType,
        peerUid: ctx.fallbackPeerUid,
        elementId: el.elementId,
        downloadType: 1,
        downSourceType: ctx.downSourceType,
        thumbSize: 0,
        filePath: localPath,
        timeoutMs: pttBudgetMs,
      });
      if (downloadedPtt) {
        localPath = downloadedPtt;
        st = await statPositiveFile(localPath);
      }
    }

    if (!ctx.skipRemoteDownload && !st && this._isNtReady() && ptt.md5HexStr) {
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
        const pathRes = await this.invokeNt(
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
        this.logger?.debug?.("inbound", err);
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
          this.logger?.debug?.("inbound", err);
        }
      }
    }
  },

  /** @this {any} */
  async _hydrateVideoElement(el) {
    const ve = el.videoElement;
    if (!ve || ve.__localFileUrl) return;
    const localPath = String(ve.filePath || ve.sourcePath || "").trim();
    const st = await statPositiveFile(localPath);
    if (st && st.size > 0 && localPath) {
      ve.filePath = localPath;
      defineLocalFileUrl(ve, localPath);
    }
  },

  /**
   * @this {any}
   * @param {any} ntMsg
   * @param {Record<string, any>} [options]
   */
  async _hydrateNtMsgMedia(ntMsg, options = {}) {
    if (!ntMsg || typeof ntMsg !== "object" || !Array.isArray(ntMsg.elements)) return;
    const skipRemoteDownload = Boolean(options?.skipRemoteDownload);
    const downSourceType = Number(options?.downSourceType ?? 0);
    const fallbackChatType = Number(ntMsg.chatType || options?.chatType || 1);
    const fallbackPeerUid = String(
      ntMsg.peerUid && String(ntMsg.peerUid) !== "0" ? ntMsg.peerUid : options?.peerUid || ""
    );
    const hydrationTimeout = Math.max(
      100,
      Number(
        options?.timeoutMs ??
          this.config?.mediaHydrationTimeoutMs ??
          this.config?.richMediaDownloadTimeoutMs ??
          8000
      ) || 8000
    );
    const deadlineMs = Number(options?.deadlineMs) > 0 ? Number(options.deadlineMs) : 0;
    const remainingRemoteBudgetMs = (capMs) => {
      if (skipRemoteDownload) return 0;
      if (deadlineMs > 0) {
        const rem = deadlineMs - Date.now();
        if (rem <= 0) return 0;
        return Math.min(hydrationTimeout, capMs, rem);
      }
      return Math.min(hydrationTimeout, capMs);
    };

    const ctx = {
      skipRemoteDownload,
      downSourceType,
      fallbackChatType,
      fallbackPeerUid,
      remainingRemoteBudgetMs,
    };

    for (const el of ntMsg.elements) {
      if (!el || typeof el !== "object") continue;
      const elType = Number(el.elementType);
      if (elType === 2 && el.picElement) {
        await this._hydratePicElement(ntMsg, el, ctx);
      } else if (elType === 4 && el.pttElement) {
        await this._hydratePttElement(ntMsg, el, ctx);
      } else if (elType === 5 && el.videoElement) {
        await this._hydrateVideoElement(el);
      }
    }

    this.messageIdStore?.indexMsgMedia?.(ntMsg);
  },
};

module.exports = {
  mediaHydratorMixin,
  MAX_HYDRATE_PIC_BYTES,
  MAX_HYDRATE_PTT_BYTES,
  statPositiveFile,
  defineLocalFileUrl,
  defineBase64Uri,
  stripTransientMedia,
};
