// @ts-check
"use strict";

/**
 * Media Resolution, Profile/Status, Ark Share & Web Credential/QZone Actions
 * (`src/actions/media_profile_actions.js`)
 *
 * Extracted from `src/actions/file_media_actions.js`:
 * - Media actions: `get_image`, `get_record` (+ transcoding), `get_file`, `ocr_image`, `translate_en2zh`, `voice_msg_to_text`, `fetch_custom_face`
 * - Profile & online status: `set_qq_profile`, `set_self_longnick`, `set_online_status`, `set_diy_online_status`, `set_qq_avatar`
 * - Ark share & robot range: `ArkSharePeer`, `ArkShareGroup`, `get_robot_uin_range`
 * - Web credentials, QZone & rkey: `get_clientkey`, `get_cookies`, `get_csrf_token`, `get_credentials`, `*_qzone*`, `get_rkey`
 */

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const { resolveMediaSource } = require("../core/media_security");
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
const {
  resolveMessageEntry,
  statNonEmptyFile,
  selectMediaDescFromRawMsg,
  downloadGroupFileToLocal,
  trackActionTempMedia,
} = require("./file_actions");

const WEB_HTTP_HELPERS = Object.freeze({
  computeBkn,
  cookieObjToString,
  httpsGetCookies,
  httpRequestText,
  parseJsonpOrJson,
});

/**
 * @param {import("../types").BridgeHost} bridge
 * @param {any} media
 */
function scheduleResolvedMediaCleanup(bridge, media) {
  if (!media) return;
  if (typeof media.cleanup === "function") {
    bridge.tempCleanupQueue?.schedule?.(media.cleanup);
  } else {
    bridge.tempCleanupQueue?.scheduleMedia?.(media);
  }
}

/**
 * @param {import("../types").BridgeHost} bridge
 * @param {string | number} ntMsgId
 * @param {number} [timeoutMs=10000]
 */
function createPttTextWaiter(bridge, ntMsgId, timeoutMs = 10000) {
  if (!(bridge.inboundPipeline._pttTextWaiters instanceof Map)) {
    bridge.inboundPipeline._pttTextWaiters = new Map();
  }
  const waiterMap = bridge.inboundPipeline._pttTextWaiters;
  const key = String(ntMsgId || "");
  let dispatcher = /** @type {any} */ (waiterMap.get(key));
  if (typeof dispatcher !== "function" || !(dispatcher._listeners instanceof Set)) {
    const listeners = new Set();
    if (typeof dispatcher === "function") {
      listeners.add(dispatcher);
    }
    dispatcher = (txt) => {
      for (const fn of Array.from(listeners)) {
        try {
          fn(txt);
        } catch (err) {
          bridge?.logger?.debug?.("media_profile_actions", err);
        }
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

  const inner = createEventWaiter(/** @type {any} */ (waiterSetAdapter), timeoutMs);
  return {
    promise: inner.promise.then((txt) => (txt === null || txt === undefined ? "" : String(txt))),
    cancel() {
      inner.cancel();
      cleanupIfEmpty();
    },
  };
}

/**
 * @param {import("../types").BridgeHost} bridge
 * @param {string} action
 * @param {any} rawOutFormat
 * @param {string} localPath
 */
async function maybeTranscodeGetRecordOutput(bridge, action, rawOutFormat, localPath) {
  if (action !== "get_record" || !rawOutFormat || !localPath) return null;
  const converted = await transcodeRecordOutFormat(localPath, rawOutFormat, {
    ...(typeof bridge.outboundPipeline?._mediaSecurityOptions === "function"
      ? bridge.outboundPipeline._mediaSecurityOptions()
      : {}),
    ffmpegPath: bridge.config?.ffmpegPath,
    silkDecoderPath: bridge.config?.silkDecoderPath,
  });
  if (!converted) return null;
  trackActionTempMedia(bridge, converted);
  return converted;
}

/**
 * @this {import("../types").BridgeHost}
 * @param {Record<string, any>} p
 * @param {import("../types").ActionContext} _context
 * @param {string} action
 */
async function resolveOneBotMediaAction(p, _context, action) {
  const rawFile = String(p.file || p.file_id || "").trim();
  const rawFileId = String(p.file_id || "").trim();
  const includeB64 = Boolean(p.base64) || Boolean(this.config?.enableLocalFile2Url);

  // Step A: Resolve NTQQ kernel-owned media metadata via msg_id/message_id or lookupMedia
  /** @type {Record<string, any> | null} */
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
      if (typeof this.inboundPipeline?._downloadRichMediaElement === "function") {
        try {
          const dlPath = await this.inboundPipeline._downloadRichMediaElement({
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
        } catch (err) {
          this.logger?.debug?.("media_profile_actions", err);
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
        } catch (err) {
          this.logger?.debug?.("media_profile_actions", err);
        }
      }
    }
  }

  if (action === "get_file" && !kernelStat) {
    const groupCode = String(
      p.group_id || (Number(mediaDesc?.chatType) === 2 ? mediaDesc?.peerUid : "") || ""
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
    const remoteUrl = String(kernelRemoteUrl || mediaDesc?.url || "");
    let urlName = "";
    try {
      urlName = path.basename(new URL(remoteUrl).pathname);
    } catch (err) {
      this.logger?.debug?.("media_profile_actions", err);
    }
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
    /** @type {Error & { code?: string }} */
    const err = new Error(`Blocked relative or unverified local media path: ${directFile}`);
    err.code = "ERR_LFI_BLOCKED";
    throw err;
  }

  let resolved;
  try {
    resolved = await resolveMediaSource(directFile, this.outboundPipeline._mediaSecurityOptions());
  } catch (err) {
    if (
      err &&
      (err.code === "ERR_LFI_BLOCKED" ||
        err.code === "ERR_SSRF_BLOCKED" ||
        err.code === "ERR_MEDIA_TOO_LARGE")
    ) {
      throw err;
    }
    /** @type {Error & { code?: string }} */
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

/**
 * @this {import("../types").BridgeHost}
 * @param {Record<string, any>} p
 * @param {import("../types").ActionContext} _context
 * @param {string} action
 */
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
// Declarative Media, Profile, Ark & Web Credential Action Handlers & Aliases
// ============================================================================

/** @type {Record<string, import("../types").BridgeActionHandler>} */
const ACTION_HANDLERS = {
  // ---- Media / OCR / Translate / Voice / Profile / Online Status ----
  get_image: resolveOneBotMediaAction,
  get_record: resolveOneBotMediaAction,
  get_file: resolveOneBotMediaAction,

  async ocr_image(p) {
    const imgSrc = String(p.image || p.file || "").trim();
    /** @type {any} */
    let media = null;
    try {
      const resolved = await resolveMediaSource(imgSrc, this.outboundPipeline._mediaSecurityOptions());
      media = resolved;
      const res = await this.invokeNt(
        "nodeIKernelRichMediaService/getScreenOCR",
        {
          imgFilepath: resolved.localPath,
          path: resolved.localPath,
          filePath: resolved.localPath,
        },
        [resolved.localPath]
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
      } catch (err) {
        this.logger?.debug?.("media_profile_actions", err);
      }
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
    /** @type {any} */
    let media = null;
    try {
      const resolved = await resolveMediaSource(p.file, this.outboundPipeline._mediaSecurityOptions());
      media = resolved;
      await this.invokeNt(
        "nodeIKernelProfileService/setHeader",
        { path: resolved.localPath },
        [resolved.localPath]
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

  // ---- Ark Share & Robot UIN Range ----
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

  // ---- Credentials, ClientKey, Cookies, QZone (Opt-in via enableWebCredentialApi) ----
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
  scheduleResolvedMediaCleanup,
  createPttTextWaiter,
  maybeTranscodeGetRecordOutput,
  normalizeOcrResultLines,
};
