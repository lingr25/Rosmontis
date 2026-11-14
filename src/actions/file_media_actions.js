"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const { buildNtMarketFaceUrl } = require("../bridge_onebot");
const { resolveTempDirFromEnv } = require("../core/env");
const { resolveMediaSource, pruneTempDirAsync } = require("../core/media_security");
const { transcodeRecordOutFormat } = require("../core/audio_codec");
const { createActionRouter, createEventWaiter } = require("../core/primitives");
const {
  computeBkn,
  cookieObjToString,
  httpsGetCookies,
  httpRequestText,
  parseJsonpOrJson,
} = require("../core/web_http");
const { dispatchWebCredentialOrQzoneAction } = require("../core/qzone_actions");

const WEB_HTTP_HELPERS = Object.freeze({
  computeBkn,
  cookieObjToString,
  httpsGetCookies,
  httpRequestText,
  parseJsonpOrJson,
});

function resolveMessageEntry(bridge, rawMsgId) {
  const store = bridge?.messageIdStore;
  if (!store || rawMsgId === undefined || rawMsgId === null || rawMsgId === "") {
    return null;
  }
  if (typeof store.resolve === "function") {
    const resolved = store.resolve(rawMsgId);
    return resolved ? resolved.entry || resolved : store.resolveByOneBotId?.(rawMsgId) || null;
  }
  return (
    store.resolveByOneBotId?.(rawMsgId) ||
    store.getByShortId?.(rawMsgId) ||
    store.getByMsgId?.(rawMsgId) ||
    null
  );
}

async function statNonEmptyFile(candidatePath) {
  if (!candidatePath || typeof candidatePath !== "string") return null;
  try {
    const st = await fs.promises.stat(candidatePath);
    if (st.isFile() && st.size > 0) return st;
  } catch (_) {}
  return null;
}

function scheduleResolvedMediaCleanup(bridge, media) {
  if (!media) return;
  if (typeof media.cleanup === "function") {
    bridge._scheduleTempCleanup(media.cleanup);
  } else {
    bridge._scheduleMediaCleanup(media);
  }
}

function createPttTextWaiter(bridge, ntMsgId, timeoutMs = 10000) {
  if (!(bridge._pttTextWaiters instanceof Map)) {
    bridge._pttTextWaiters = new Map();
  }
  const waiterMap = bridge._pttTextWaiters;
  const key = String(ntMsgId || "");
  let dispatcher = waiterMap.get(key);
  if (typeof dispatcher !== "function" || !(dispatcher._listeners instanceof Set)) {
    const listeners = new Set();
    if (typeof dispatcher === "function") {
      listeners.add(dispatcher);
    }
    dispatcher = (txt) => {
      for (const fn of Array.from(listeners)) {
        try {
          fn(txt);
        } catch (_) {}
      }
    };
    dispatcher._listeners = listeners;
    waiterMap.set(key, dispatcher);
  }

  const listeners = dispatcher._listeners;
  const cleanupIfEmpty = () => {
    if (listeners.size === 0 && waiterMap.get(key) === dispatcher) {
      waiterMap.delete(key);
    }
  };
  const waiterSetAdapter = {
    add(fn) {
      listeners.add(fn);
    },
    delete(fn) {
      const removed = listeners.delete(fn);
      cleanupIfEmpty();
      return removed;
    },
  };

  const inner = createEventWaiter(waiterSetAdapter, timeoutMs);
  return {
    promise: inner.promise.then((txt) => (txt === null || txt === undefined ? "" : String(txt))),
    cancel() {
      inner.cancel();
      cleanupIfEmpty();
    },
  };
}

function elementToMediaDesc(el, ntMsgId, chatType, peerUid) {
  if (!el || typeof el !== "object") return null;
  const elementId = String(el.elementId || "");
  const t = Number(el.elementType || 0);
  if (t === 2 && el.picElement) {
    const pe = el.picElement;
    let sourcePath = String(pe.sourcePath || "");
    if (!sourcePath && pe.thumbPath) {
      const thumbs =
        pe.thumbPath instanceof Map
          ? Array.from(pe.thumbPath.values())
          : typeof pe.thumbPath === "object"
          ? Object.values(pe.thumbPath)
          : [];
      sourcePath = String(thumbs[0] || "");
    }
    return {
      ntMsgId: String(ntMsgId || ""),
      chatType: Number(chatType || 1),
      peerUid: String(peerUid || ""),
      elementId,
      elementType: 2,
      md5: String(pe.md5HexStr || "").toLowerCase(),
      fileUuid: String(pe.fileUuid || ""),
      fileName: String(pe.fileName || ""),
      sourcePath,
      url: String(pe.originImageUrl || ""),
      fileSize: Number(pe.fileSize || 0),
    };
  }
  if (t === 3 && el.fileElement) {
    const fe = el.fileElement;
    return {
      ntMsgId: String(ntMsgId || ""),
      chatType: Number(chatType || 1),
      peerUid: String(peerUid || ""),
      elementId,
      elementType: 3,
      md5: String(fe.fileMd5 || "").toLowerCase(),
      fileUuid: String(fe.fileUuid || ""),
      fileName: String(fe.fileName || ""),
      sourcePath: String(fe.filePath || fe.sourcePath || ""),
      url: "",
      fileSize: Number(fe.fileSize || 0),
    };
  }
  if (t === 4 && el.pttElement) {
    const ptt = el.pttElement;
    return {
      ntMsgId: String(ntMsgId || ""),
      chatType: Number(chatType || 1),
      peerUid: String(peerUid || ""),
      elementId,
      elementType: 4,
      md5: String(ptt.md5HexStr || "").toLowerCase(),
      fileUuid: String(ptt.fileUuid || ""),
      fileName: String(ptt.fileName || ""),
      sourcePath: String(ptt.filePath || ptt.sourcePath || ""),
      url: "",
      fileSize: Number(ptt.fileSize || 0),
    };
  }
  if (t === 5 && el.videoElement) {
    const ve = el.videoElement;
    return {
      ntMsgId: String(ntMsgId || ""),
      chatType: Number(chatType || 1),
      peerUid: String(peerUid || ""),
      elementId,
      elementType: 5,
      md5: String(ve.videoMd5 || "").toLowerCase(),
      fileUuid: String(ve.fileUuid || ""),
      fileName: String(ve.fileName || ""),
      sourcePath: String(ve.filePath || ve.sourcePath || ""),
      url: "",
      fileSize: Number(ve.fileSize || 0),
    };
  }
  if (t === 11 && el.marketFaceElement) {
    const mf = el.marketFaceElement;
    const emojiId = String(mf.emojiId || "").trim();
    return {
      ntMsgId: String(ntMsgId || ""),
      chatType: Number(chatType || 1),
      peerUid: String(peerUid || ""),
      elementId,
      elementType: 11,
      md5: emojiId.toLowerCase(),
      fileUuid: emojiId,
      fileName: String(mf.faceName || (emojiId ? `${emojiId}.gif` : "marketface.gif")),
      sourcePath: String(mf.staticFacePath || mf.dynamicFacePath || ""),
      url: buildNtMarketFaceUrl(emojiId),
      fileSize: 0,
    };
  }
  return null;
}

function selectMediaDescFromRawMsg(rawMsg, entry, action, rawFile, rawFileId, elementIdHint) {
  if (!rawMsg || !Array.isArray(rawMsg.elements)) return null;
  const ntMsgId = String(rawMsg.msgId || entry?.msgId || entry?.ntMsgId || "");
  const chatType = Number(rawMsg.chatType || entry?.peer?.chatType || entry?.chatType || 1);
  const peerUid = String(rawMsg.peerUid || entry?.peer?.peerUid || entry?.peerUid || "");
  const descs = rawMsg.elements
    .map((el) => elementToMediaDesc(el, ntMsgId, chatType, peerUid))
    .filter(Boolean);
  if (descs.length === 0) return null;

  if (elementIdHint && String(elementIdHint) !== "0") {
    const byElId = descs.find((d) => d.elementId === String(elementIdHint));
    if (byElId) return byElId;
  }

  const tokens = [rawFile, rawFileId]
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  for (const tok of tokens) {
    const cleanHex = tok.replace(/^\{|\}$/g, "").replace(/-/g, "").split(".")[0].toLowerCase();
    const hit = descs.find(
      (d) =>
        (d.fileUuid && d.fileUuid === tok) ||
        (d.fileName && d.fileName === tok) ||
        (d.md5 && (d.md5 === tok.toLowerCase() || d.md5 === cleanHex))
    );
    if (hit) return hit;
  }

  if (action === "get_image") {
    return descs.find((d) => d.elementType === 2 || d.elementType === 11) || descs[0];
  }
  if (action === "get_record") {
    return descs.find((d) => d.elementType === 4) || descs[0];
  }
  return descs.find((d) => d.elementType === 3 || d.elementType === 5) || descs[0];
}

function sanitizeDownloadFileName(rawName, fallback = "file") {
  const base = path.basename(String(rawName || "").trim());
  const cleaned = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return cleaned || fallback;
}

async function allocateTempDownloadPath(bridge, preferredName = "file") {
  const tempDir = resolveTempDirFromEnv(bridge?.config?.tempDir);
  await fs.promises.mkdir(tempDir, { recursive: true, mode: 0o700 });
  const safeName = sanitizeDownloadFileName(preferredName, "file");
  const filePath = path.join(
    tempDir,
    `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`
  );
  return { tempDir, filePath };
}

async function resolveGroupFileMeta(bridge, groupId, fileId, rawBusId) {
  const explicitBus =
    rawBusId !== undefined &&
    rawBusId !== null &&
    rawBusId !== "" &&
    Number.isFinite(Number(rawBusId)) &&
    Number(rawBusId) > 0
      ? Number(rawBusId)
      : 0;
  let fileInfo = null;
  if (groupId && fileId) {
    try {
      const infoRes = await bridge.invokeNt(
        "nodeIKernelRichMediaService/getGroupFileInfo",
        { groupId: String(groupId), fileId: String(fileId) },
        [String(groupId), String(fileId)]
      );
      fileInfo =
        infoRes?.groupFileInfoResult?.fileInfo ||
        infoRes?.fileInfo ||
        (infoRes && typeof infoRes === "object" && (infoRes.fileId || infoRes.busId)
          ? infoRes
          : null);
    } catch (_) {}
  }
  const busId =
    explicitBus ||
    (Number(fileInfo?.busId || fileInfo?.busid || 0) > 0
      ? Number(fileInfo.busId || fileInfo.busid)
      : 102);
  return { busId, fileInfo };
}

async function waitRichMediaTargetFile(bridge, targetPath, extraKeys = [], timeoutMs = 8000) {
  const effectiveTimeout = Math.max(50, Number(timeoutMs) || 8000);
  if (!bridge._richMediaWaiters) {
    bridge._richMediaWaiters = new Map();
  }
  const waitKeys = [targetPath, ...extraKeys].map((k) => String(k || "")).filter(Boolean);
  let timer = null;
  let pollTimer = null;
  let waiterEntry = null;
  let settled = false;

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (waiterEntry && bridge._richMediaWaiters) {
      for (const k of waitKeys) {
        const set = bridge._richMediaWaiters.get(k);
        if (set) {
          set.delete(waiterEntry);
          if (set.size === 0) bridge._richMediaWaiters.delete(k);
        }
      }
    }
  };

  let finishRef = null;
  const promise = new Promise((resolve) => {
    let polling = false;
    const finish = (candidate) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(String(candidate || targetPath || ""));
    };
    finishRef = finish;
    waiterEntry = {
      msgId: "",
      elementId: "0",
      targetPath,
      resolve: (downloadedPath) => finish(downloadedPath || targetPath),
    };
    for (const k of waitKeys) {
      if (!bridge._richMediaWaiters.has(k)) {
        bridge._richMediaWaiters.set(k, new Set());
      }
      bridge._richMediaWaiters.get(k).add(waiterEntry);
    }
    if (targetPath) {
      pollTimer = setInterval(async () => {
        if (polling || settled) return;
        polling = true;
        try {
          const st = await statNonEmptyFile(targetPath);
          if (st) finish(targetPath);
        } finally {
          polling = false;
        }
      }, 150);
      pollTimer.unref?.();
    }
    timer = setTimeout(() => finish(targetPath), effectiveTimeout);
    timer.unref?.();
  });

  return {
    promise,
    cancel: () => finishRef && finishRef(""),
  };
}

async function downloadGroupFileToLocal(bridge, groupId, fileId, options = {}) {
  const groupCode = String(groupId || "").trim();
  const targetFileId = String(fileId || "").trim();
  if (!groupCode || !targetFileId) return { localPath: "", url: "" };

  const { fileInfo } = await resolveGroupFileMeta(
    bridge,
    groupCode,
    targetFileId,
    options.busId
  );
  if (fileInfo?.localPath) {
    const existing = await statNonEmptyFile(String(fileInfo.localPath));
    if (existing) {
      return { localPath: String(fileInfo.localPath), url: pathToFileURL(String(fileInfo.localPath)).href };
    }
  }

  const modelId = String(
    options.modelId ||
      (fileInfo?.fileModelId && String(fileInfo.fileModelId) !== "0" ? fileInfo.fileModelId : "") ||
      targetFileId
  );
  const preferredName = String(options.fileName || fileInfo?.fileName || targetFileId || "group_file");
  const { tempDir, filePath: savePath } = await allocateTempDownloadPath(bridge, preferredName);
  const peer = { chatType: 2, peerUid: groupCode, guildId: "" };
  const timeoutMs =
    Number(options.timeoutMs || bridge?.config?.richMediaDownloadTimeoutMs) || 8000;

  const waiter = await waitRichMediaTargetFile(bridge, savePath, [`0:0`], timeoutMs);
  try {
    const res = await bridge.invokeNt(
      "nodeIKernelRichMediaService/downloadFileForModelId",
      {
        peer,
        fileModelIdList: [modelId],
        modelIdList: [modelId],
        savePath,
        save_path: savePath,
      },
      [peer, [modelId], savePath]
    );
    const directFilePath =
      res && typeof res === "object" && res.filePath ? String(res.filePath) : "";
    if (directFilePath) {
      const directStat = await statNonEmptyFile(directFilePath);
      if (directStat) {
        waiter.cancel();
        if (path.resolve(directFilePath).startsWith(path.resolve(tempDir))) {
          trackActionTempMedia(bridge, { isTempFile: true, localPath: directFilePath });
          await pruneTempDirAsync(tempDir, 128);
        }
        return { localPath: directFilePath, url: pathToFileURL(directFilePath).href };
      }
    }
    const directUrl =
      typeof res === "string"
        ? res
        : String(res?.url || res?.downloadUrl || res?.httpsUrl || "");
    if (/^(?:https?|file):\/\//i.test(directUrl)) {
      waiter.cancel();
      return { localPath: "", url: directUrl };
    }

    const immediateStat = await statNonEmptyFile(savePath);
    const candidatePath = immediateStat ? savePath : await waiter.promise;
    const finalStat = await statNonEmptyFile(candidatePath);
    if (finalStat) {
      trackActionTempMedia(bridge, { isTempFile: true, localPath: candidatePath });
      await pruneTempDirAsync(tempDir, 128);
      return { localPath: candidatePath, url: pathToFileURL(candidatePath).href };
    }
  } catch (_) {
    waiter.cancel();
  }
  return { localPath: "", url: "" };
}

async function listGroupFiles(bridge, groupId, folderId, options = {}) {
  const groupIdStr = String(groupId);
  const fileListForm = {
    sortType: 1,
    fileCount: Math.max(1, Number(options.fileCount || 100)),
    startIndex: Math.max(0, Number(options.startIndex || 0)),
    sortOrder: 2,
    showOnlinedocFolder: false,
    folderId: String(folderId || "/"),
  };
  const res = await bridge.invokeNt(
    "nodeIKernelRichMediaService/getGroupFileList",
    {
      groupId: groupIdStr,
      fileListForm,
    },
    [groupIdStr, fileListForm]
  );
  const listRoot = res?.groupFileListResult || res || {};
  const items = Array.isArray(listRoot.item)
    ? listRoot.item
    : Array.isArray(listRoot.items)
    ? listRoot.items
    : Array.isArray(listRoot.files)
    ? listRoot.files
    : [];
  const files = [];
  const folders = [];
  for (const item of items) {
    if (item.type === 1 || item.fileInfo) {
      const fi = item.fileInfo || item;
      files.push({
        group_id: groupId,
        file_id: String(fi.fileId || fi.file_id || ""),
        file_name: String(fi.fileName || fi.file_name || ""),
        busid: Number(fi.busId || fi.busid || 102),
        file_size: Number(fi.fileSize || fi.file_size || 0),
        upload_time: Number(fi.uploadTime || fi.upload_time || 0),
        dead_time: Number(fi.deadTime || 0),
        modify_time: Number(fi.modifyTime || 0),
        download_times: Number(fi.downloadTimes || 0),
        uploader: Number(fi.uploaderUin || fi.uploader || 0),
        uploader_name: String(fi.uploaderName || fi.uploader_name || ""),
      });
    } else if (item.type === 2 || item.folderInfo) {
      const fo = item.folderInfo || item;
      folders.push({
        group_id: groupId,
        folder_id: String(fo.folderId || fo.folder_id || ""),
        folder_name: String(fo.folderName || fo.folder_name || ""),
        create_time: Number(fo.createTime || 0),
        creator: Number(fo.createUin || 0),
        create_name: String(fo.creatorName || ""),
        total_file_count: Number(fo.totalFileCount || fo.total_file_count || 0),
      });
    }
  }
  return { files, folders };
}

async function extractUploadedFileUuid(bridge, peer, sent) {
  const entry = resolveMessageEntry(bridge, sent.message_id);
  let fileUuid = String(
    entry?.rawMsg?.elements?.find((e) => e?.fileElement)?.fileElement?.fileUuid || ""
  );
  if (
    !fileUuid &&
    sent.real_id &&
    !/^(sent_|fwd_|echo_timeout_)/.test(String(sent.real_id))
  ) {
    try {
      const res = await bridge.invokeNt(
        "nodeIKernelMsgService/getMsgsByMsgId",
        { peer, msgIds: [String(sent.real_id)] },
        [peer, [String(sent.real_id)]]
      );
      const fetched = res?.msgList?.[0];
      fileUuid = String(
        fetched?.elements?.find((e) => e?.fileElement)?.fileElement?.fileUuid || ""
      );
    } catch (_) {}
  }
  return fileUuid;
}

function trackActionTempMedia(bridge, media) {
  if (!media || !media.isTempFile || !media.localPath) return;
  if (typeof bridge.tempFileCleaner?.track === "function") {
    bridge.tempFileCleaner.track(media.localPath);
  } else if (
    !bridge.config?.cleanupTempImmediately &&
    typeof bridge._scheduleMediaCleanup === "function"
  ) {
    bridge._scheduleMediaCleanup(media);
  }
}

async function maybeTranscodeGetRecordOutput(bridge, action, rawOutFormat, localPath) {
  if (action !== "get_record" || !rawOutFormat || !localPath) return null;
  const converted = await transcodeRecordOutFormat(localPath, rawOutFormat, {
    ...(typeof bridge._mediaSecurityOptions === "function" ? bridge._mediaSecurityOptions() : {}),
    ffmpegPath: bridge.config?.ffmpegPath,
  });
  if (!converted) return null;
  trackActionTempMedia(bridge, converted);
  return converted;
}

async function resolveOneBotMediaAction(p, _context, action) {
  const rawFile = String(p.file || p.file_id || "").trim();
  const rawFileId = String(p.file_id || "").trim();
  const includeB64 = Boolean(p.base64) || Boolean(this.config?.enableLocalFile2Url);

  // Step A: Resolve NTQQ kernel-owned media metadata via msg_id/message_id or lookupMedia
  let mediaDesc = null;
  if (p.msg_id || p.message_id) {
    const entry = resolveMessageEntry(this, p.msg_id || p.message_id);
    if (entry) {
      let rawMsg = entry.rawMsg || null;
      const ntMsgId = String(entry.msgId || entry.ntMsgId || "");
      const peer =
        entry.peer ||
        (entry.peerUid
          ? {
              chatType: Number(entry.chatType || 1),
              peerUid: String(entry.peerUid),
              guildId: "",
            }
          : null);
      if (
        !rawMsg &&
        ntMsgId &&
        !/^(sent_|fwd_|echo_timeout_)/.test(ntMsgId) &&
        peer?.peerUid
      ) {
        try {
          const res = await this.invokeNt(
            "nodeIKernelMsgService/getMsgsByMsgId",
            { peer, msgIds: [ntMsgId] },
            [peer, [ntMsgId]]
          );
          rawMsg = res?.msgList?.[0] || null;
        } catch (_) {
          rawMsg = null;
        }
      }
      mediaDesc = selectMediaDescFromRawMsg(
        rawMsg,
        entry,
        action,
        rawFile,
        rawFileId,
        p.element_id
      );
    }
  }

  if (!mediaDesc && typeof this.messageIdStore?.lookupMedia === "function") {
    if (rawFile) {
      mediaDesc = this.messageIdStore.lookupMedia(rawFile);
    }
    if (!mediaDesc && rawFileId && rawFileId !== rawFile) {
      mediaDesc = this.messageIdStore.lookupMedia(rawFileId);
    }
  }

  let kernelLocalPath = mediaDesc?.sourcePath ? String(mediaDesc.sourcePath) : "";
  let kernelStat = await statNonEmptyFile(kernelLocalPath);
  let kernelRemoteUrl = "";

  if (mediaDesc && !kernelStat && Number(mediaDesc.elementType) !== 11) {
    const ntMsgId = String(mediaDesc.ntMsgId || "");
    const chatType = Number(mediaDesc.chatType || 1);
    const peerUid = String(mediaDesc.peerUid || "");
    const elementId = String(mediaDesc.elementId || "");
    const safeTargetPath = mediaDesc.sourcePath ? String(mediaDesc.sourcePath) : "";
    if (ntMsgId && !/^(sent_|fwd_|echo_timeout_)/.test(ntMsgId) && peerUid && elementId) {
      if (typeof this._downloadRichMediaElement === "function") {
        try {
          const dlPath = await this._downloadRichMediaElement({
            msgId: ntMsgId,
            chatType,
            peerUid,
            elementId,
            downloadType: 1,
            downSourceType: 0,
            downloadScene: 0,
            fileModelId: String(mediaDesc.fileModelId || "0"),
            thumbSize: 0,
            filePath: safeTargetPath,
            timeoutMs: Number(this.config?.richMediaDownloadTimeoutMs) || 8000,
          });
          const candidate = String(dlPath || safeTargetPath || "");
          const st = await statNonEmptyFile(candidate);
          if (st) {
            kernelLocalPath = candidate;
            kernelStat = st;
          }
        } catch (_) {}
      } else {
        try {
          const getReq = {
            downSourceType: 0,
            downloadSourceType: 0,
            downloadScene: 0,
            fileModelId: String(mediaDesc.fileModelId || "0"),
            triggerType: 1,
            msgId: ntMsgId,
            chatType,
            peerUid,
            elementId,
            thumbSize: 0,
            downloadType: 1,
            filePath: safeTargetPath,
          };
          const res = await this.invokeNt(
            "nodeIKernelMsgService/downloadRichMedia",
            { getReq },
            [getReq]
          );
          const candidate = String(res?.filePath || safeTargetPath || "");
          const st = await statNonEmptyFile(candidate);
          if (st) {
            kernelLocalPath = candidate;
            kernelStat = st;
          }
        } catch (_) {}
      }
    }
  }

  if (action === "get_file" && !kernelStat) {
    const groupCode = String(
      p.group_id || (Number(mediaDesc?.chatType) === 2 ? mediaDesc.peerUid : "") || ""
    );
    const knownUuid = String(
      mediaDesc?.fileUuid ||
        (p.group_id && rawFileId
          ? rawFileId
          : p.group_id &&
            rawFile &&
            !rawFile.includes("..") &&
            !/^(?:file|base64|https?):\/\//i.test(rawFile) &&
            !/^[a-zA-Z]:[\\/]/.test(rawFile) &&
            !/^\/(?:etc|proc|sys|root|home|var|usr|opt|tmp)\b/i.test(rawFile)
          ? rawFile
          : "") ||
        ""
    ).trim();
    if (knownUuid && groupCode) {
      const dl = await downloadGroupFileToLocal(this, groupCode, knownUuid, {
        busId: p.busid,
        fileName: mediaDesc?.fileName,
      });
      if (dl.localPath) {
        const st = await statNonEmptyFile(dl.localPath);
        if (st) {
          kernelLocalPath = dl.localPath;
          kernelStat = st;
        }
      } else if (/^https?:\/\//i.test(dl.url)) {
        kernelRemoteUrl = dl.url;
      }
    }
  }

  if (kernelStat) {
    const converted = await maybeTranscodeGetRecordOutput(
      this,
      action,
      p.out_format,
      kernelLocalPath
    );
    const outPath = converted ? converted.localPath : kernelLocalPath;
    const outSize = converted ? converted.fileSize : kernelStat.size;
    const outName = converted
      ? converted.fileName
      : String(mediaDesc?.fileName || path.basename(kernelLocalPath));
    return {
      file: outPath,
      url: pathToFileURL(outPath).href,
      file_size: String(outSize),
      file_name: outName,
      ...(includeB64
        ? { base64: (await fs.promises.readFile(outPath)).toString("base64") }
        : {}),
    };
  }

  if (kernelRemoteUrl || (mediaDesc?.url && /^https?:\/\//i.test(String(mediaDesc.url)))) {
    const remoteUrl = String(kernelRemoteUrl || mediaDesc.url);
    let urlName = "";
    try {
      urlName = path.basename(new URL(remoteUrl).pathname);
    } catch (_) {}
    const fileName = String(mediaDesc?.fileName || urlName || "file");
    return {
      file: fileName,
      url: remoteUrl,
      file_size: String(mediaDesc?.fileSize || 0),
      file_name: fileName,
    };
  }

  // Step B: Validate direct URI / local path via resolveMediaSource (never trust raw caller path)
  const directFile = p.file !== undefined && p.file !== null ? String(p.file).trim() : "";
  if (!directFile) {
    throw new Error("Media file not found or not accessible");
  }
  const hasExplicitSchemeOrAbs =
    /^(?:file|base64|https?):\/\//i.test(directFile) ||
    /^data:[^;]+;base64,/i.test(directFile) ||
    path.isAbsolute(directFile);
  if (!hasExplicitSchemeOrAbs) {
    const err = new Error(`Blocked relative or unverified local media path: ${directFile}`);
    err.code = "ERR_LFI_BLOCKED";
    throw err;
  }

  let resolved;
  try {
    resolved = await resolveMediaSource(directFile, this._mediaSecurityOptions());
  } catch (err) {
    if (
      err &&
      (err.code === "ERR_LFI_BLOCKED" ||
        err.code === "ERR_SSRF_BLOCKED" ||
        err.code === "ERR_MEDIA_TOO_LARGE")
    ) {
      throw err;
    }
    const notFound = new Error("Media file not found or not accessible");
    if (err && err.code) notFound.code = err.code;
    throw notFound;
  }

  trackActionTempMedia(this, resolved);

  let st;
  try {
    st = await fs.promises.stat(resolved.localPath);
  } catch (_) {
    throw new Error("Media file not found or not accessible");
  }
  if (!st.isFile()) {
    throw new Error("Media file not found or not accessible");
  }

  const converted = await maybeTranscodeGetRecordOutput(
    this,
    action,
    p.out_format,
    resolved.localPath
  );
  const outPath = converted ? converted.localPath : resolved.localPath;
  const outSize = converted ? converted.fileSize : st.size;
  const outName = converted
    ? converted.fileName
    : String(resolved.fileName || path.basename(resolved.localPath));

  return {
    file: outPath,
    url: pathToFileURL(outPath).href,
    file_size: String(outSize),
    file_name: outName,
    ...(includeB64
      ? { base64: (await fs.promises.readFile(outPath)).toString("base64") }
      : {}),
  };
}

async function handleWebCredentialOrQzoneAction(p, _context, action) {
  return await dispatchWebCredentialOrQzoneAction(this, action, p, WEB_HTTP_HELPERS);
}

function normalizeOcrResultLines(res) {
  const rawList = Array.isArray(res)
    ? res
    : Array.isArray(res?.ocrResult)
    ? res.ocrResult
    : Array.isArray(res?.lines)
    ? res.lines
    : Array.isArray(res?.texts)
    ? res.texts
    : Array.isArray(res?.result?.ocrResult)
    ? res.result.ocrResult
    : [];
  const texts = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    if (Array.isArray(item.coordinates) && item.confidence !== undefined) {
      texts.push({
        text: String(item.text || ""),
        confidence: Number(item.confidence) || 0,
        coordinates: item.coordinates.map((pt) => ({
          x: Number(pt?.x || 0),
          y: Number(pt?.y || 0),
        })),
      });
      continue;
    }
    const rawScore = Number(item.score ?? item.confidence ?? 0);
    const confidence = Number.isFinite(rawScore)
      ? rawScore > 0 && rawScore <= 1
        ? Math.round(rawScore * 100)
        : Math.round(rawScore)
      : 0;
    const coordinates = [item.pt1, item.pt2, item.pt3, item.pt4]
      .filter((pt) => pt && typeof pt === "object")
      .map((pt) => ({
        x: Number(pt.x || 0),
        y: Number(pt.y || 0),
      }));
    texts.push({
      text: String(item.text || ""),
      confidence,
      coordinates,
    });
  }
  return {
    texts,
    language: String(res?.language || "zh"),
  };
}

// ============================================================================
// Declarative Action Handlers & Aliases
// ============================================================================

const ACTION_HANDLERS = {
  // ---- 7. Group & Private Files ----
  async get_group_root_files(p) {
    return await listGroupFiles(this, Number(p.group_id || 0), "/", {
      fileCount: p.file_count,
      startIndex: p.start_index,
    });
  },

  async get_group_files_by_folder(p) {
    return await listGroupFiles(
      this,
      Number(p.group_id || 0),
      String(p.folder_id || p.folder || "/"),
      {
        fileCount: p.file_count,
        startIndex: p.start_index,
      }
    );
  },

  async get_group_file_system_info(p) {
    const groupId = String(p.group_id || "");
    const res = await this.invokeNt(
      "nodeIKernelRichMediaService/getGroupSpace",
      { groupId },
      [groupId]
    );
    const space = res?.groupSpaceResult || res || {};
    return {
      file_count: Number(space.fileCount ?? space.totalFileCount ?? 0),
      limit_count: Number(space.maxFileCount ?? 10000),
      used_space: Number(space.usedSpace ?? 0),
      total_space: Number(space.totalSpace ?? 10737418240),
    };
  },

  async get_group_file_url(p) {
    const groupId = String(p.group_id || "").trim();
    const fileId = String(p.file_id || "").trim();
    if (!groupId || !fileId) return { url: "" };

    const mediaDesc = this.messageIdStore?.lookupMedia?.(fileId) || null;
    if (mediaDesc?.sourcePath) {
      const existing = await statNonEmptyFile(String(mediaDesc.sourcePath));
      if (existing) {
        return { url: pathToFileURL(String(mediaDesc.sourcePath)).href };
      }
    }
    if (
      mediaDesc?.ntMsgId &&
      !/^(sent_|fwd_|echo_timeout_)/.test(String(mediaDesc.ntMsgId)) &&
      mediaDesc.peerUid &&
      mediaDesc.elementId &&
      typeof this._downloadRichMediaElement === "function"
    ) {
      try {
        const { tempDir, filePath: fallbackSavePath } = await allocateTempDownloadPath(
          this,
          mediaDesc.fileName || fileId
        );
        const targetPath = mediaDesc.sourcePath
          ? String(mediaDesc.sourcePath)
          : fallbackSavePath;
        const dlPath = await this._downloadRichMediaElement({
          msgId: String(mediaDesc.ntMsgId),
          chatType: Number(mediaDesc.chatType || 2),
          peerUid: String(mediaDesc.peerUid),
          elementId: String(mediaDesc.elementId),
          downloadType: 1,
          downSourceType: 0,
          downloadScene: 0,
          fileModelId: String(mediaDesc.fileModelId || "0"),
          thumbSize: 0,
          filePath: targetPath,
          timeoutMs: Number(this.config?.richMediaDownloadTimeoutMs) || 8000,
        });
        const candidate = String(dlPath || targetPath || "");
        const st = await statNonEmptyFile(candidate);
        if (st) {
          if (path.resolve(candidate).startsWith(path.resolve(tempDir))) {
            trackActionTempMedia(this, { isTempFile: true, localPath: candidate });
            await pruneTempDirAsync(tempDir, 128);
          }
          return { url: pathToFileURL(candidate).href };
        }
      } catch (_) {}
    }

    const dl = await downloadGroupFileToLocal(this, groupId, fileId, {
      busId: p.busid,
      modelId: p.model_id,
      fileName: p.file_name || mediaDesc?.fileName,
    });
    return { url: String(dl.url || "") };
  },

  async get_private_file_url(p) {
    const fileId = String(p.file_id || "").trim();
    const fileHash = String(p.file_hash || "").trim().toLowerCase();
    const userId = String(p.user_id || "").trim();

    let mediaDesc = null;
    if (p.msg_id || p.message_id) {
      const entry = resolveMessageEntry(this, p.msg_id || p.message_id);
      if (entry?.rawMsg) {
        mediaDesc = selectMediaDescFromRawMsg(
          entry.rawMsg,
          entry,
          "get_file",
          fileId,
          fileHash,
          p.element_id
        );
      }
    }
    if (!mediaDesc && typeof this.messageIdStore?.lookupMedia === "function") {
      if (fileId) mediaDesc = this.messageIdStore.lookupMedia(fileId);
      if (!mediaDesc && fileHash) mediaDesc = this.messageIdStore.lookupMedia(fileHash);
    }

    if (!mediaDesc && userId) {
      try {
        const peer = await this._resolvePeerForUser(userId);
        if (peer?.peerUid) {
          const histRes = await this.invokeNt(
            "nodeIKernelMsgService/getMsgsIncludeSelf",
            { peer, msgId: "0", cnt: 20, queryOrder: false },
            [peer, "0", 20, false]
          );
          const msgList = Array.isArray(histRes?.msgList) ? histRes.msgList : [];
          for (const msg of msgList) {
            this.messageIdStore?.indexMsgMedia?.(msg);
            const candidate = selectMediaDescFromRawMsg(
              msg,
              null,
              "get_file",
              fileId,
              fileHash,
              p.element_id
            );
            if (
              candidate &&
              ((fileId && candidate.fileUuid === fileId) ||
                (fileHash && candidate.md5 === fileHash) ||
                (!fileId && !fileHash))
            ) {
              mediaDesc = candidate;
              break;
            }
          }
        }
      } catch (_) {}
    }

    if (!mediaDesc) return { url: "" };

    if (mediaDesc.sourcePath) {
      const existing = await statNonEmptyFile(String(mediaDesc.sourcePath));
      if (existing) {
        return { url: pathToFileURL(String(mediaDesc.sourcePath)).href };
      }
    }

    const ntMsgId = String(mediaDesc.ntMsgId || "");
    const peerUid = String(mediaDesc.peerUid || "");
    const elementId = String(mediaDesc.elementId || "");
    if (!ntMsgId || /^(sent_|fwd_|echo_timeout_)/.test(ntMsgId) || !peerUid || !elementId) {
      return { url: "" };
    }

    const { tempDir, filePath: fallbackSavePath } = await allocateTempDownloadPath(
      this,
      mediaDesc.fileName || fileId || "private_file"
    );
    const targetPath = mediaDesc.sourcePath ? String(mediaDesc.sourcePath) : fallbackSavePath;
    const timeoutMs = Number(this.config?.richMediaDownloadTimeoutMs) || 8000;

    let candidatePath = "";
    if (typeof this._downloadRichMediaElement === "function") {
      try {
        candidatePath = await this._downloadRichMediaElement({
          msgId: ntMsgId,
          chatType: Number(mediaDesc.chatType || 1),
          peerUid,
          elementId,
          downloadType: 1,
          downSourceType: 0,
          downloadScene: 0,
          fileModelId: String(mediaDesc.fileModelId || "0"),
          thumbSize: 0,
          filePath: targetPath,
          timeoutMs,
        });
      } catch (_) {}
    } else {
      try {
        const getReq = {
          downSourceType: 0,
          downloadSourceType: 0,
          downloadScene: 0,
          fileModelId: String(mediaDesc.fileModelId || "0"),
          triggerType: 1,
          msgId: ntMsgId,
          chatType: Number(mediaDesc.chatType || 1),
          peerUid,
          elementId,
          thumbSize: 0,
          downloadType: 1,
          filePath: targetPath,
        };
        const res = await this.invokeNt(
          "nodeIKernelMsgService/downloadRichMedia",
          { getReq },
          [getReq]
        );
        candidatePath = String(res?.filePath || targetPath || "");
      } catch (_) {}
    }

    const resolved = String(candidatePath || targetPath || "");
    const st = await statNonEmptyFile(resolved);
    if (st) {
      if (path.resolve(resolved).startsWith(path.resolve(tempDir))) {
        trackActionTempMedia(this, { isTempFile: true, localPath: resolved });
        await pruneTempDirAsync(tempDir, 128);
      }
      return { url: pathToFileURL(resolved).href };
    }
    return { url: "" };
  },

  async upload_group_file(p) {
    const groupId = Number(p.group_id || 0);
    const groupIdStr = String(groupId);
    const folder = String(p.folder || p.folder_id || "/").trim();
    const peer = { chatType: 2, peerUid: groupIdStr, guildId: "" };
    const sent = await this._sendMessageToPeer(peer, [
      {
        type: "file",
        data: {
          file: p.file,
          name: p.name || undefined,
          folder: folder || "/",
        },
      },
    ]);
    const fileUuid = await extractUploadedFileUuid(this, peer, sent);
    if (folder && folder !== "/" && fileUuid) {
      try {
        const { busId } = await resolveGroupFileMeta(this, groupIdStr, fileUuid, p.busid);
        const busIdList = [busId];
        const fileIdList = [String(fileUuid)];
        await this.invokeNt(
          "nodeIKernelRichMediaService/moveGroupFile",
          {
            groupId: groupIdStr,
            busIdList,
            fileIdList,
            curFolderId: "/",
            dstFolderId: folder,
          },
          [groupIdStr, busIdList, fileIdList, "/", folder]
        );
      } catch (_) {}
    }
    return {
      file_id: String(fileUuid || sent.real_id || sent.message_id),
      message_id: sent.message_id,
    };
  },

  async upload_private_file(p) {
    const peer = await this._resolvePeerForUser(p.user_id);
    const sent = await this._sendMessageToPeer(peer, [
      {
        type: "file",
        data: {
          file: p.file,
          name: p.name || undefined,
        },
      },
    ]);
    const fileUuid = await extractUploadedFileUuid(this, peer, sent);
    return {
      file_id: String(fileUuid || sent.real_id || sent.message_id),
      message_id: sent.message_id,
    };
  },

  async create_group_file_folder(p) {
    const groupId = String(p.group_id);
    const folderName = String(p.name || "");
    const res = await this.invokeNt(
      "nodeIKernelRichMediaService/createGroupFolder",
      {
        groupId,
        folderName,
      },
      [groupId, folderName]
    );
    const groupItem = res?.resultWithGroupItem?.groupItem || res?.groupItem || res;
    return {
      result: { retCode: 0, retMsg: "success" },
      groupItem: {
        folderInfo: groupItem?.folderInfo || {
          folderId: String(
            groupItem?.folderId || res?.folderId || `folder_${Date.now()}`
          ),
          folderName,
          folderPath: String(p.parent_id || "/"),
        },
      },
    };
  },

  async delete_group_folder(p) {
    const groupId = String(p.group_id);
    const folderId = String(p.folder_id || "");
    await this.invokeNt(
      "nodeIKernelRichMediaService/deleteGroupFolder",
      { groupId, folderId },
      [groupId, folderId]
    );
    return {};
  },

  async delete_group_file(p) {
    const groupId = String(p.group_id);
    const fileId = String(p.file_id || "");
    const { busId } = await resolveGroupFileMeta(this, groupId, fileId, p.busid);
    const busIdList = [busId];
    const fileIdList = [fileId];
    await this.invokeNt(
      "nodeIKernelRichMediaService/deleteGroupFile",
      {
        groupId,
        busIdList,
        fileIdList,
        transGroupFileResult: [],
      },
      [groupId, busIdList, fileIdList]
    );
    return {};
  },

  async move_group_file(p) {
    const groupId = String(p.group_id);
    const fileId = String(p.file_id || "");
    const { busId } = await resolveGroupFileMeta(this, groupId, fileId, p.busid);
    const busIdList = [busId];
    const fileIdList = [fileId];
    const curFolderId = String(p.parent_directory || "/");
    const dstFolderId = String(p.target_directory || "/");
    await this.invokeNt(
      "nodeIKernelRichMediaService/moveGroupFile",
      {
        groupId,
        busIdList,
        fileIdList,
        curFolderId,
        dstFolderId,
      },
      [groupId, busIdList, fileIdList, curFolderId, dstFolderId]
    );
    return {};
  },

  async rename_group_file(p) {
    const groupId = String(p.group_id);
    const fileId = String(p.file_id || "");
    const { busId } = await resolveGroupFileMeta(this, groupId, fileId, p.busid);
    const parentFolderId = String(p.current_parent_directory || p.parent_directory || "/");
    const newFileName = String(p.new_name || p.name || "");
    await this.invokeNt(
      "nodeIKernelRichMediaService/renameGroupFile",
      {
        groupId,
        busId,
        fileId,
        parentFolderId,
        newFileName,
      },
      [groupId, busId, fileId, parentFolderId, newFileName]
    );
    return {};
  },

  async rename_group_file_folder(p) {
    const groupId = String(p.group_id);
    const folderId = String(p.folder_id || "");
    const newFolderName = String(p.new_folder_name || p.new_name || p.name || "");
    await this.invokeNt(
      "nodeIKernelRichMediaService/renameGroupFolder",
      {
        groupId,
        folderId,
        newFolderName,
      },
      [groupId, folderId, newFolderName]
    );
    return {};
  },

  async trans_group_file(p) {
    const groupId = String(p.group_id);
    const fileId = String(p.file_id || "");
    await this.invokeNt(
      "nodeIKernelRichMediaService/transGroupFile",
      {
        groupId,
        fileId,
      },
      [groupId, fileId]
    );
    return { ok: true };
  },

  // ---- 8. Media / OCR / Translate / Voice / Profile / Online Status ----
  get_image: resolveOneBotMediaAction,
  get_record: resolveOneBotMediaAction,
  get_file: resolveOneBotMediaAction,

  async ocr_image(p) {
    const imgSrc = String(p.image || p.file || "").trim();
    let media = null;
    try {
      media = await resolveMediaSource(imgSrc, this._mediaSecurityOptions());
      const res = await this.invokeNt(
        "nodeIKernelRichMediaService/getScreenOCR",
        {
          imgFilepath: media.localPath,
          path: media.localPath,
          filePath: media.localPath,
        },
        [media.localPath]
      );
      return normalizeOcrResultLines(res);
    } finally {
      scheduleResolvedMediaCleanup(this, media);
    }
  },

  async translate_en2zh(p) {
    const words = Array.isArray(p.words) ? p.words : [String(p.words || "")];
    const res = await this.invokeNt(
      "nodeIKernelRichMediaService/translateEnWordToZn",
      { words },
      [words]
    );
    return { words: Array.isArray(res?.words) ? res.words : words };
  },

  async voice_msg_to_text(p) {
    const entry = resolveMessageEntry(this, p.message_id);
    if (!entry) throw new Error("message not found");
    let rawMsg = entry.rawMsg || null;
    const ntMsgId = String(entry.msgId || entry.ntMsgId || "");
    const peer =
      entry.peer ||
      (entry.peerUid
        ? {
            chatType: Number(entry.chatType || 1),
            peerUid: String(entry.peerUid),
            guildId: "",
          }
        : null);
    if (!rawMsg && ntMsgId && !/^(sent_|fwd_|echo_timeout_)/.test(ntMsgId) && peer?.peerUid) {
      try {
        const msgRes = await this.invokeNt(
          "nodeIKernelMsgService/getMsgsByMsgId",
          { peer, msgIds: [ntMsgId] },
          [peer, [ntMsgId]]
        );
        rawMsg = msgRes?.msgList?.[0] || null;
      } catch (_) {
        rawMsg = null;
      }
    }
    const pttEl = Array.isArray(rawMsg?.elements)
      ? rawMsg.elements.find((e) => e?.elementType === 4 && e.pttElement)
      : null;
    if (pttEl?.pttElement?.text) {
      return { text: String(pttEl.pttElement.text) };
    }

    const waiter = createPttTextWaiter(this, ntMsgId, 10000);
    const msgElement = pttEl || { elementType: 4, elementId: "" };
    try {
      const res = await this.invokeNt(
        "nodeIKernelMsgService/translatePtt2Text",
        {
          msgId: ntMsgId,
          peer,
          msgElement,
        },
        [ntMsgId, peer, msgElement]
      );
      if (res?.text) {
        waiter.cancel();
        return { text: String(res.text) };
      }
      const waitedText = await waiter.promise;
      return { text: String(waitedText || "") };
    } catch (err) {
      waiter.cancel();
      throw err;
    }
  },

  async set_qq_profile(p) {
    const profile = {
      ...(p.nickname !== undefined ? { nick: String(p.nickname) } : {}),
      ...(p.personal_note !== undefined ? { longNick: String(p.personal_note) } : {}),
      ...(p.sex !== undefined ? { sex: Number(p.sex) } : {}),
    };
    if (Object.keys(profile).length > 0) {
      await this.invokeNt(
        "nodeIKernelProfileService/modifyDesktopMiniProfile",
        { profile },
        [profile]
      );
    }
    if (p.personal_note !== undefined) {
      const words = String(p.personal_note);
      try {
        await this.invokeNt(
          "nodeIKernelProfileService/setLongNick",
          { words, longNick: words },
          [words]
        );
      } catch (_) {}
    }
    return {};
  },

  async set_self_longnick(p) {
    const words = String(p.longNick ?? p.personal_note ?? "");
    await this.invokeNt(
      "nodeIKernelProfileService/setLongNick",
      { words, longNick: words },
      [words]
    );
    return {};
  },

  async set_online_status(p) {
    const statusReq = {
      status: Number(p.status ?? 10),
      extStatus: Number(p.ext_status ?? 0),
      batteryStatus: Number(p.battery_status ?? 0),
    };
    await this.invokeNt(
      "nodeIKernelMsgService/setStatus",
      { statusReq, ...statusReq },
      [statusReq]
    );
    return {};
  },

  async set_diy_online_status(p) {
    const statusReq = {
      status: 10,
      extStatus: Number(p.ext_status ?? 2000),
      batteryStatus: 0,
      customStatus: {
        faceId: String(p.face_id ?? 212),
        faceType: Number(p.face_type ?? 1),
        wording: String(p.wording ?? ""),
      },
    };
    await this.invokeNt(
      "nodeIKernelMsgService/setStatus",
      { statusReq, ...statusReq },
      [statusReq]
    );
    return {};
  },

  async set_qq_avatar(p) {
    let media = null;
    try {
      media = await resolveMediaSource(p.file, this._mediaSecurityOptions());
      await this.invokeNt(
        "nodeIKernelProfileService/setHeader",
        { path: media.localPath },
        [media.localPath]
      );
      return {};
    } finally {
      scheduleResolvedMediaCleanup(this, media);
    }
  },

  async fetch_custom_face(p) {
    const count = Number(p.count || 48);
    const res = await this.invokeNt(
      "nodeIKernelMsgService/fetchFavEmojiList",
      {
        resId: "",
        count,
        backwardFetch: true,
        forceRefresh: true,
      },
      ["", count, true, true]
    );
    const list = Array.isArray(res?.emojiInfoList) ? res.emojiInfoList : [];
    return list.map((e) => String(e.url || e.emoOriginalPath || "")).filter(Boolean);
  },

  // ---- 9. Ark Share & Robot UIN Range ----
  async ArkSharePeer(p) {
    if (p.group_id) {
      const res = await this.invokeNt(
        "nodeIKernelGroupService/getGroupRecommendContactArkJson",
        { groupCode: String(p.group_id) },
        [String(p.group_id)]
      );
      return { arkMsg: String(res?.arkJson || res?.arkMsg || res || "") };
    }
    const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
    const res = await this.invokeNt(
      "nodeIKernelBuddyService/getBuddyRecommendContactArkJson",
      { uid, phoneNumber: String(p.phone_number || "") },
      [uid, String(p.phone_number || "")]
    );
    return { arkMsg: String(res?.arkJson || res?.arkMsg || res || "") };
  },

  async ArkShareGroup(p) {
    const res = await this.invokeNt(
      "nodeIKernelGroupService/getGroupRecommendContactArkJson",
      { groupCode: String(p.group_id) },
      [String(p.group_id)]
    );
    return String(res?.arkJson || res?.arkMsg || res || "");
  },

  async get_robot_uin_range() {
    const req = {
      justFetchMsgConfig: "0",
      type: 1,
      version: 0,
      aioKeywordVersion: 0,
    };
    const res = await this.invokeNt(
      "nodeIKernelRobotService/getRobotUinRange",
      { req },
      [req]
    );
    return Array.isArray(res?.response?.robotUinRanges)
      ? res.response.robotUinRanges
      : [];
  },

  // ---- 10. Credentials, ClientKey, Cookies, QZone (Opt-in via enableWebCredentialApi) ----
  get_clientkey: handleWebCredentialOrQzoneAction,
  get_cookies: handleWebCredentialOrQzoneAction,
  get_csrf_token: handleWebCredentialOrQzoneAction,
  get_credentials: handleWebCredentialOrQzoneAction,
  get_qzone_msg_list: handleWebCredentialOrQzoneAction,
  get_qzone_feeds: handleWebCredentialOrQzoneAction,
  send_qzone_msg: handleWebCredentialOrQzoneAction,
  delete_qzone_msg: handleWebCredentialOrQzoneAction,
  like_qzone: handleWebCredentialOrQzoneAction,
  unlike_qzone: handleWebCredentialOrQzoneAction,
  comment_qzone: handleWebCredentialOrQzoneAction,

  async get_rkey() {
    const res = await this.invokeNt(
      "nodeIKernelUnitedConfigService/loadUnitedConfig",
      { id: "100293", group: "100293" },
      ["100293"]
    );
    return {
      rkeys: [
        { type: "private", rkey: String(res?.configData?.content || "") },
        { type: "group", rkey: String(res?.configData?.content || "") },
      ],
    };
  },
};

const ACTION_ALIASES = {
  delete_group_file_folder: "delete_group_folder",
  ".ocr_image": "ocr_image",
  fetch_ptt_text: "voice_msg_to_text",
  get_ptt_text: "voice_msg_to_text",
  get_record_text: "voice_msg_to_text",
  share_peer: "ArkSharePeer",
  send_ark_share: "ArkSharePeer",
  share_group_ex: "ArkShareGroup",
  send_group_ark_share: "ArkShareGroup",
  nc_get_rkey: "get_rkey",
};

const { HANDLED_ACTIONS, dispatch } = createActionRouter(ACTION_HANDLERS, ACTION_ALIASES);

module.exports = {
  HANDLED_ACTIONS,
  dispatch,
};
