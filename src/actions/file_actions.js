// @ts-check
"use strict";

/**
 * Group & Private File OneBot v11 Action Router (`src/actions/file_actions.js`)
 *
 * Extracted from `src/actions/file_media_actions.js`:
 * - Group & private file listing, metadata, URL download, upload, folder CRUD, move/rename/transfer
 * - Shared media-descriptor lookup & temp download helpers reused by `media_profile_actions.js`
 */

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const { buildNtMarketFaceUrl } = require("../bridge_onebot");
const { resolveTempDirFromEnv } = require("../core/env");
const { pruneTempDirAsync } = require("../core/media_security");
const { createActionRouter } = require("../core/primitives");

/**
 * @param {import("../types").BridgeHost} bridge
 * @param {any} rawMsgId
 */
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
  } catch (_) {
    // Candidate file does not exist yet or is not readable; treat as absent.
  }
  return null;
}

/**
 * @param {import("../types").BridgeHost} bridge
 * @param {any} media
 */
function trackActionTempMedia(bridge, media) {
  if (!media || !media.isTempFile || !media.localPath) return;
  if (typeof bridge.tempFileCleaner?.track === "function") {
    bridge.tempFileCleaner.track(media.localPath);
  } else if (
    !bridge.config?.cleanupTempImmediately &&
    typeof bridge.tempCleanupQueue?.scheduleMedia === "function"
  ) {
    bridge.tempCleanupQueue.scheduleMedia(media);
  }
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

/**
 * @param {any} val
 * @returns {any}
 */
function _cloneVisitMediaElem(val) {
  if (val === null || val === undefined || typeof val !== "object") return val;
  if (val instanceof Map) {
    const m = new Map();
    for (const [k, v] of val.entries()) {
      m.set(_cloneVisitMediaElem(k), _cloneVisitMediaElem(v));
    }
    return m;
  }
  if (val instanceof Uint8Array) {
    return Uint8Array.from(val);
  }
  if (Array.isArray(val)) {
    return val.map((item) => _cloneVisitMediaElem(item));
  }
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    if (k.startsWith("__")) continue;
    out[k] = _cloneVisitMediaElem(v);
  }
  return out;
}

function selectMediaDescFromRawMsg(rawMsg, entry, action, rawFile, rawFileId, elementIdHint) {
  if (!rawMsg || !Array.isArray(rawMsg.elements)) return null;
  const ntMsgId = String(rawMsg.msgId || entry?.msgId || entry?.ntMsgId || "");
  const inVisit = Boolean(entry?.inVisit);
  const hasForwardPeer = Boolean(
    inVisit && entry?.forwardPeer?.peerUid && String(entry.forwardPeer.peerUid) !== "0"
  );
  const hasMsgPeer = Boolean(rawMsg.peerUid && String(rawMsg.peerUid) !== "0");
  const msgChatType = Number(
    hasMsgPeer ? rawMsg.chatType || entry?.peer?.chatType || entry?.chatType || 0 : 0
  );
  const msgPeerUid = hasMsgPeer ? String(rawMsg.peerUid) : "";
  const msgGuildId = hasMsgPeer ? String(rawMsg.guildId || entry?.peer?.guildId || "") : "";
  const chatType = Number(
    hasForwardPeer
      ? entry.forwardPeer.chatType || msgChatType || entry?.chatType || 1
      : hasMsgPeer
      ? msgChatType || 1
      : entry?.peer?.chatType || entry?.forwardPeer?.chatType || entry?.chatType || rawMsg.chatType || 1
  );
  const peerUid = String(
    hasForwardPeer
      ? entry.forwardPeer.peerUid
      : hasMsgPeer
      ? msgPeerUid
      : entry?.peer?.peerUid || entry?.forwardPeer?.peerUid || entry?.peerUid || ""
  );
  const guildId = String(
    hasForwardPeer
      ? entry.forwardPeer.guildId || ""
      : hasMsgPeer
      ? msgGuildId
      : entry?.peer?.guildId || entry?.forwardPeer?.guildId || rawMsg.guildId || ""
  );
  const descs = rawMsg.elements
    .map((el) => {
      const base = elementToMediaDesc(el, ntMsgId, chatType, peerUid);
      if (!base || !inVisit) return base;
      return {
        ...base,
        inVisit: true,
        guildId,
        forwardPeer: hasForwardPeer
          ? {
              chatType: Number(entry.forwardPeer.chatType || chatType || 1),
              peerUid: String(entry.forwardPeer.peerUid),
              guildId: String(entry.forwardPeer.guildId || ""),
            }
          : null,
        msgChatType,
        msgPeerUid,
        msgGuildId,
        rootMsgId: String(entry?.rootMsgId || ""),
        parentMsgId: String(entry?.parentMsgId || entry?.rootMsgId || ""),
        forwardSenderUid: String(
          entry?.forwardSenderUid ||
            (Number(entry?.forwardPeer?.chatType || chatType) === 1
              ? entry?.forwardPeer?.peerUid || peerUid
              : "") ||
            ""
        ),
        senderUid: String(rawMsg.senderUid || entry?.senderUid || ""),
        msgRandom: String(rawMsg.msgRandom || entry?.msgRandom || "0"),
        msgSeq: String(rawMsg.msgSeq || entry?.msgSeq || "0"),
        msgTime: String(rawMsg.msgTime || entry?.msgTime || "0"),
        elem: _cloneVisitMediaElem(el),
      };
    })
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

/**
 * @param {import("../types").BridgeHost} bridge
 * @param {string} [preferredName="file"]
 */
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

/**
 * @param {import("../types").BridgeHost} bridge
 * @param {string | number} groupId
 * @param {string} fileId
 * @param {any} [rawBusId]
 */
async function resolveGroupFileMeta(bridge, groupId, fileId, rawBusId) {
  const explicitBus =
    rawBusId !== undefined &&
    rawBusId !== null &&
    rawBusId !== "" &&
    Number.isFinite(Number(rawBusId)) &&
    Number(rawBusId) > 0
      ? Number(rawBusId)
      : 0;
  /** @type {Record<string, any> | null} */
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
    } catch (err) {
      bridge?.logger?.debug?.("file_actions", err);
    }
  }
  const candidateBus = Number(fileInfo?.busId || fileInfo?.busid || 0);
  const busId = explicitBus || (candidateBus > 0 ? candidateBus : 102);
  return { busId, fileInfo };
}

/**
 * @param {import("../types").BridgeHost} bridge
 * @param {string} targetPath
 * @param {string[]} [extraKeys]
 * @param {number} [timeoutMs]
 */
async function waitRichMediaTargetFile(bridge, targetPath, extraKeys = [], timeoutMs = 8000) {
  const effectiveTimeout = Math.max(50, Number(timeoutMs) || 8000);
  if (!bridge.inboundPipeline._richMediaWaiters) {
    bridge.inboundPipeline._richMediaWaiters = new Map();
  }
  const richMediaWaiters = bridge.inboundPipeline._richMediaWaiters;
  const waitKeys = [targetPath, ...extraKeys].map((k) => String(k || "")).filter(Boolean);
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** @type {NodeJS.Timeout | null} */
  let pollTimer = null;
  /** @type {{ msgId: string, elementId: string, targetPath: any, resolve: (downloadedPath: any) => void } | null} */
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
    if (waiterEntry && richMediaWaiters) {
      for (const k of waitKeys) {
        const set = richMediaWaiters.get(k);
        if (set) {
          set.delete(waiterEntry);
          if (set.size === 0) richMediaWaiters.delete(k);
        }
      }
    }
  };

  /** @type {((candidate: any) => void) | null} */
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
    const entry = {
      msgId: "",
      elementId: "0",
      targetPath,
      resolve: (downloadedPath) => finish(downloadedPath || targetPath),
    };
    waiterEntry = entry;
    for (const k of waitKeys) {
      let waiterSet = richMediaWaiters.get(k);
      if (!waiterSet) {
        waiterSet = new Set();
        richMediaWaiters.set(k, waiterSet);
      }
      waiterSet.add(entry);
    }
    if (targetPath) {
      const pTimer = setInterval(async () => {
        if (polling || settled) return;
        polling = true;
        try {
          const st = await statNonEmptyFile(targetPath);
          if (st) finish(targetPath);
        } finally {
          polling = false;
        }
      }, 150);
      pTimer.unref?.();
      pollTimer = pTimer;
    }
    const t = setTimeout(() => finish(targetPath), effectiveTimeout);
    t.unref?.();
    timer = t;
  });

  return {
    promise,
    cancel: () => {
      if (finishRef) finishRef("");
    },
  };
}

/**
 * @param {import("../types").BridgeHost} bridge
 * @param {string | number} groupId
 * @param {string} fileId
 * @param {Record<string, any>} [options]
 */
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

/**
 * @param {import("../types").BridgeHost} bridge
 * @param {string | number} groupId
 * @param {string} folderId
 * @param {Record<string, any>} [options]
 */
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

function inspectMsgFileElement(msg) {
  const fileElement = msg?.elements?.find((e) => e?.fileElement)?.fileElement || null;
  const fileUuid = fileElement ? String(fileElement.fileUuid || "") : "";
  return { fileElement, fileUuid };
}

/**
 * @param {import("../types").BridgeHost} bridge
 * @param {any} peer
 * @param {any} sent
 */
async function extractUploadedFileUuid(bridge, peer, sent) {
  const entry = resolveMessageEntry(bridge, sent.message_id);
  let { fileElement: storeFileEl, fileUuid } = inspectMsgFileElement(entry?.rawMsg);
  if (fileUuid) return fileUuid;

  if (
    !sent.real_id ||
    /^(sent_|fwd_|echo_timeout_)/.test(String(sent.real_id))
  ) {
    return "";
  }

  const msgIdStr = String(sent.real_id);
  let fetchedFileEl = null;
  let hasMsgList = false;
  let invokeFailed = false;
  try {
    const res = await bridge.invokeNt(
      "nodeIKernelMsgService/getMsgsByMsgId",
      { peer, msgIds: [msgIdStr] },
      [peer, [msgIdStr]]
    );
    hasMsgList = Array.isArray(res?.msgList) && res.msgList.length > 0;
    const inspected = inspectMsgFileElement(res?.msgList?.[0]);
    fetchedFileEl = inspected.fileElement;
    fileUuid = inspected.fileUuid;
  } catch (_) {
    invokeFailed = true;
  }
  if (fileUuid) return fileUuid;

  const rawMaxWait = Number(bridge.config?.uploadFileUuidWaitMs ?? 2000);
  const maxWaitMs = Number.isFinite(rawMaxWait) && rawMaxWait > 0 ? rawMaxWait : 0;
  if (maxWaitMs <= 0) return "";

  const explicitWaitConfigured =
    bridge.config?.uploadFileUuidWaitMs !== undefined &&
    Number(bridge.config.uploadFileUuidWaitMs) > 0;
  const pollIntervals = [80, 160, 320, 500, 800];
  let elapsed = 0;
  let attempt = 0;

  while (elapsed < maxWaitMs) {
    const stepMs =
      attempt < pollIntervals.length
        ? pollIntervals[attempt]
        : pollIntervals[pollIntervals.length - 1];
    const waitMs = Math.min(stepMs, maxWaitMs - elapsed);
    if (waitMs <= 0) break;

    await new Promise((resolve) => setTimeout(resolve, waitMs));
    elapsed += waitMs;
    attempt += 1;

    const updatedEntry = resolveMessageEntry(bridge, sent.message_id);
    const storeInspected = inspectMsgFileElement(updatedEntry?.rawMsg);
    if (storeInspected.fileUuid) return storeInspected.fileUuid;
    storeFileEl = storeInspected.fileElement;

    invokeFailed = false;
    hasMsgList = false;
    fetchedFileEl = null;
    try {
      const res = await bridge.invokeNt(
        "nodeIKernelMsgService/getMsgsByMsgId",
        { peer, msgIds: [msgIdStr] },
        [peer, [msgIdStr]]
      );
      hasMsgList = Array.isArray(res?.msgList) && res.msgList.length > 0;
      const inspected = inspectMsgFileElement(res?.msgList?.[0]);
      if (inspected.fileUuid) return inspected.fileUuid;
      fetchedFileEl = inspected.fileElement;
    } catch (_) {
      invokeFailed = true;
    }

    const activeFileEl = fetchedFileEl || storeFileEl;
    if (invokeFailed && !storeFileEl) break;
    if (!hasMsgList && !activeFileEl) break;
    if (!activeFileEl) break;
    if (!explicitWaitConfigured && activeFileEl.transferStatus !== undefined) {
      const statusNum = Number(activeFileEl.transferStatus);
      // Stop early if NTQQ reports terminal failure/cancel status with no fileUuid
      if (statusNum === 5 || statusNum === 6) break;
    }
  }

  return "";
}

// ============================================================================
// Declarative File Action Handlers & Aliases
// ============================================================================

/** @type {Record<string, import("../types").BridgeActionHandler>} */
const ACTION_HANDLERS = {
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
      typeof this.inboundPipeline?._downloadRichMediaElement === "function"
    ) {
      try {
        const { tempDir, filePath: fallbackSavePath } = await allocateTempDownloadPath(
          this,
          mediaDesc.fileName || fileId
        );
        const targetPath = mediaDesc.sourcePath
          ? String(mediaDesc.sourcePath)
          : fallbackSavePath;
        const dlPath = await this.inboundPipeline._downloadRichMediaElement({
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
      } catch (err) {
        this.logger?.debug?.("file_actions", err);
      }
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

    /** @type {Record<string, any> | null} */
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
        const peer = await this.outboundPipeline._resolvePeerForUser(userId);
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
      } catch (err) {
        this.logger?.debug?.("file_actions", err);
      }
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
    if (typeof this.inboundPipeline?._downloadRichMediaElement === "function") {
      try {
        candidatePath = await this.inboundPipeline._downloadRichMediaElement({
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
      } catch (err) {
        this.logger?.debug?.("file_actions", err);
      }
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
      } catch (err) {
        this.logger?.debug?.("file_actions", err);
      }
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
    const sent = await this.outboundPipeline._sendMessageToPeer(peer, [
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
      const retryBackoffs = [120, 250];
      /** @type {any} */
      let lastMoveErr = null;
      for (let attempt = 0; attempt <= retryBackoffs.length; attempt += 1) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryBackoffs[attempt - 1]));
        }
        try {
          const { busId } = await resolveGroupFileMeta(this, groupIdStr, fileUuid, p.busid);
          const busIdList = [busId];
          const fileIdList = [String(fileUuid)];
          const moveRes = await this.invokeNt(
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
          const topResult =
            moveRes &&
            typeof moveRes === "object" &&
            moveRes.result !== undefined &&
            moveRes.result !== null &&
            typeof moveRes.result !== "object"
              ? Number(moveRes.result)
              : 0;
          const innerRetCode = Number(moveRes?.moveGroupFileResult?.result?.retCode ?? 0);
          const errCode =
            Number.isFinite(topResult) && topResult !== 0
              ? topResult
              : Number.isFinite(innerRetCode) && innerRetCode !== 0
              ? innerRetCode
              : 0;
          if (errCode !== 0) {
            const errMsg = String(
              moveRes?.errMsg ||
                moveRes?.moveGroupFileResult?.result?.retMsg ||
                `result=${errCode}`
            );
            lastMoveErr = new Error(`moveGroupFile failed (${errMsg})`);
            continue;
          }
          lastMoveErr = null;
          break;
        } catch (err) {
          lastMoveErr = err;
        }
      }
      if (lastMoveErr) {
        this.logger?.warn?.(
          `[Rosmontis] upload_group_file failed to move file ${fileUuid} into folder ${folder} in group ${groupIdStr}: ${
            lastMoveErr?.message || lastMoveErr
          }`
        );
        if (this.config?.strictUploadGroupFileFolderMove) {
          throw lastMoveErr;
        }
      }
    }
    return {
      file_id: String(fileUuid || sent.real_id || sent.message_id),
      message_id: sent.message_id,
    };
  },

  async upload_private_file(p) {
    const peer = await this.outboundPipeline._resolvePeerForUser(p.user_id);
    const sent = await this.outboundPipeline._sendMessageToPeer(peer, [
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
};

const ACTION_ALIASES = {
  delete_group_file_folder: "delete_group_folder",
};

const { HANDLED_ACTIONS, dispatch } = createActionRouter(ACTION_HANDLERS, ACTION_ALIASES);

module.exports = {
  HANDLED_ACTIONS,
  dispatch,
  resolveMessageEntry,
  statNonEmptyFile,
  trackActionTempMedia,
  elementToMediaDesc,
  selectMediaDescFromRawMsg,
  sanitizeDownloadFileName,
  allocateTempDownloadPath,
  resolveGroupFileMeta,
  waitRichMediaTargetFile,
  downloadGroupFileToLocal,
  listGroupFiles,
  inspectMsgFileElement,
  extractUploadedFileUuid,
};
