"use strict";

const path = require("path");

const { resolveMediaSource } = require("../bridge_onebot");

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

const HANDLED_ACTIONS = new Set([
  "get_group_root_files",
  "get_group_files_by_folder",
  "get_group_file_system_info",
  "get_group_file_url",
  "get_private_file_url",
  "upload_group_file",
  "upload_private_file",
  "create_group_file_folder",
  "delete_group_folder",
  "delete_group_file_folder",
  "delete_group_file",
  "move_group_file",
  "trans_group_file",
  "get_image",
  "get_record",
  "get_file",
  "ocr_image",
  ".ocr_image",
  "translate_en2zh",
  "voice_msg_to_text",
  "fetch_ptt_text",
  "get_ptt_text",
  "get_record_text",
  "set_qq_profile",
  "set_self_longnick",
  "set_online_status",
  "set_diy_online_status",
  "set_qq_avatar",
  "fetch_custom_face",
  "ArkSharePeer",
  "share_peer",
  "send_ark_share",
  "ArkShareGroup",
  "share_group_ex",
  "send_group_ark_share",
  "get_robot_uin_range",
  "get_clientkey",
  "get_cookies",
  "get_csrf_token",
  "get_credentials",
  "get_qzone_msg_list",
  "get_qzone_feeds",
  "send_qzone_msg",
  "delete_qzone_msg",
  "like_qzone",
  "unlike_qzone",
  "comment_qzone",
  "get_rkey",
  "nc_get_rkey",
]);

async function dispatch(action, p, context = {}) {
  switch (action) {
    // ---- 7. Group & Private Files ----
    case "get_group_root_files":
    case "get_group_files_by_folder": {
      const groupId = Number(p.group_id || 0);
      const folderId =
        action === "get_group_root_files"
          ? "/"
          : String(p.folder_id || p.folder || "/");
      const res = await this.invokeNt("nodeIKernelRichMediaService/getGroupFileList", {
        groupId: String(groupId),
        groupFileListForm: {
          sortType: 1,
          fileCount: 100,
          startIndex: 0,
          sortOrder: 2,
          showOnlinedocFolder: 0,
          folderId,
        },
      });
      const items = Array.isArray(res?.items) ? res.items : Array.isArray(res?.files) ? res.files : [];
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

    case "get_group_file_system_info": {
      const groupId = String(p.group_id || "");
      const res = await this.invokeNt("nodeIKernelRichMediaService/getGroupSpace", {
        groupId,
      });
      return {
        file_count: Number(res?.fileCount || 0),
        limit_count: Number(res?.maxFileCount || 10000),
        used_space: Number(res?.usedSpace || 0),
        total_space: Number(res?.totalSpace || 10737418240),
      };
    }

    case "get_group_file_url": {
      const groupId = String(p.group_id || "");
      const fileId = String(p.file_id || "");
      const busId = Number(p.busid || 102);
      const peer = { chatType: 2, peerUid: groupId, guildId: "" };

      // 1. Primary: genuine NTQQ RichMedia downloadFileForModelId / downloadFileForFileUuid
      for (const [cmd, payload, posArgs] of [
        [
          "nodeIKernelRichMediaService/downloadFileForModelId",
          { peer, modelIdList: [fileId], downSourceType: 0 },
          [peer, [fileId], ""],
        ],
        [
          "nodeIKernelRichMediaService/downloadFileForFileUuid",
          { peer, fileUuid: fileId, httpsUrl: "", fileName: "", fileSize: "0", busId },
          [peer, fileId, ""],
        ],
        [
          "nodeIKernelRichMediaService/getGroupFileDownloadUrl",
          { groupId, fileId, busId },
          [groupId, fileId, busId],
        ],
      ]) {
        try {
          const res = await this.invokeNt(cmd, payload, posArgs);
          const url =
            typeof res === "string"
              ? res
              : String(res?.url || res?.downloadUrl || res?.httpsUrl || "");
          if (url) return { url };
        } catch (_) {}
      }
      return { url: "" };
    }

    case "get_private_file_url": {
      const fileId = String(p.file_id || "");
      const fileHash = String(p.file_hash || "");
      const userId = String(p.user_id || "");
      const peer = userId
        ? await this._resolvePeerForUser(userId)
        : { chatType: 1, peerUid: "", guildId: "" };

      for (const [cmd, payload, posArgs] of [
        [
          "nodeIKernelRichMediaService/downloadFileForFileUuid",
          { peer, fileUuid: fileId, fileHash, userId },
          [peer, fileId, ""],
        ],
        [
          "nodeIKernelRichMediaService/getPrivateFileDownloadUrl",
          { fileId, fileHash, userId },
          [fileId, fileHash, userId],
        ],
      ]) {
        try {
          const res = await this.invokeNt(cmd, payload, posArgs);
          const url =
            typeof res === "string"
              ? res
              : String(res?.url || res?.downloadUrl || res?.httpsUrl || "");
          if (url) return { url };
        } catch (_) {}
      }
      return { url: "" };
    }

    case "upload_group_file": {
      const groupId = Number(p.group_id || 0);
      const peer = { chatType: 2, peerUid: String(groupId), guildId: "" };
      const sent = await this._sendMessageToPeer(peer, [
        {
          type: "file",
          data: {
            file: p.file,
            name: p.name || undefined,
            folder: p.folder || p.folder_id || "/",
          },
        },
      ]);
      return { file_id: String(sent.real_id || sent.message_id) };
    }

    case "upload_private_file": {
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
      return { file_id: String(sent.real_id || sent.message_id) };
    }

    case "create_group_file_folder": {
      const res = await this.invokeNt("nodeIKernelRichMediaService/createGroupFolder", {
        groupId: String(p.group_id),
        parentFolderId: String(p.parent_id || "/"),
        folderName: String(p.name || ""),
      });
      return {
        result: { retCode: 0, retMsg: "success" },
        groupItem: {
          folderInfo: res?.folderInfo || {
            folderId: String(res?.folderId || `folder_${Date.now()}`),
            folderName: String(p.name || ""),
            folderPath: String(p.parent_id || "/"),
          },
        },
      };
    }

    case "delete_group_folder":
    case "delete_group_file_folder": {
      await this.invokeNt("nodeIKernelRichMediaService/deleteGroupFolder", {
        groupId: String(p.group_id),
        folderId: String(p.folder_id || ""),
      });
      return {};
    }

    case "delete_group_file": {
      await this.invokeNt("nodeIKernelRichMediaService/deleteGroupFile", {
        groupId: String(p.group_id),
        busIdList: [Number(p.busid || 102)],
        fileIdList: [String(p.file_id || "")],
      });
      return {};
    }

    case "move_group_file": {
      await this.invokeNt("nodeIKernelRichMediaService/moveGroupFile", {
        groupId: String(p.group_id),
        busIdList: [Number(p.busid || 102)],
        fileIdList: [String(p.file_id || "")],
        curFolderId: String(p.parent_directory || "/"),
        dstFolderId: String(p.target_directory || "/"),
      });
      return {};
    }

    case "trans_group_file": {
      await this.invokeNt("nodeIKernelRichMediaService/transGroupFile", {
        groupId: String(p.group_id),
        fileId: String(p.file_id || ""),
      });
      return { ok: true };
    }

    // ---- 8. Media / OCR / Translate / Voice / Profile / Online Status ----
    case "get_image":
    case "get_record":
    case "get_file": {
      const fileId = String(p.file || p.file_id || "");
      const getReq = {
        downSourceType: 0,
        fileModelId: "0",
        downloadSourceType: 0,
        triggerType: 1,
        msgId: String(p.msg_id || "0"),
        chatType: Number(p.chat_type || 1),
        peerUid: String(p.peer_uid || ""),
        elementId: String(p.element_id || "0"),
        thumbSize: 0,
        downloadType: 1,
        filePath: fileId,
      };
      const res = await this.invokeNt(
        "nodeIKernelMsgService/downloadRichMedia",
        { getReq },
        [getReq]
      );
      const localPath = res?.filePath || fileId;
      return {
        file: localPath,
        url: localPath.startsWith("http") ? localPath : `file://${localPath}`,
        file_size: String(res?.fileSize || 0),
        file_name: path.basename(localPath),
      };
    }

    case "ocr_image":
    case ".ocr_image": {
      const imgSrc = String(p.image || "");
      let media = null;
      try {
        media = await resolveMediaSource(imgSrc, this._mediaSecurityOptions());
        const res = await this.invokeNt("nodeIKernelMiscService/ocr", {
          path: media.localPath,
        });
        return {
          texts: Array.isArray(res?.texts) ? res.texts : [],
          language: String(res?.language || "zh"),
        };
      } finally {
        if (media && typeof media.cleanup === "function") {
          this._scheduleTempCleanup(media.cleanup);
        } else if (media) {
          this._scheduleMediaCleanup(media);
        }
      }
    }

    case "translate_en2zh": {
      const words = Array.isArray(p.words) ? p.words : [String(p.words || "")];
      const res = await this.invokeNt(
        "nodeIKernelRichMediaService/translateEnWordToZn",
        { words },
        [words]
      );
      return { words: Array.isArray(res?.words) ? res.words : words };
    }

    case "voice_msg_to_text":
    case "fetch_ptt_text":
    case "get_ptt_text":
    case "get_record_text": {
      const entry =
        this.messageIdStore.getByShortId(p.message_id) ||
        this.messageIdStore.getByMsgId(p.message_id);
      if (!entry) throw new Error("message not found");
      const pttEl = Array.isArray(entry.rawMsg?.elements)
        ? entry.rawMsg.elements.find((e) => e?.elementType === 4 && e.pttElement)
        : null;
      if (pttEl?.pttElement?.text) {
        return { text: String(pttEl.pttElement.text) };
      }
      let pttTimer = null;
      const waitPromise = new Promise((resolve) => {
        pttTimer = setTimeout(() => {
          this._pttTextWaiters.delete(String(entry.msgId));
          resolve("");
        }, 10000);
        if (typeof pttTimer.unref === "function") pttTimer.unref();
        this._pttTextWaiters.set(String(entry.msgId), (txt) => {
          if (pttTimer) clearTimeout(pttTimer);
          resolve(txt);
        });
      });
      const res = await this.invokeNt("nodeIKernelMsgService/translatePtt2Text", {
        msgId: String(entry.msgId),
        peer: entry.peer,
        msgElement: pttEl || { elementType: 4, elementId: "" },
      });
      if (res?.text) {
        if (pttTimer) clearTimeout(pttTimer);
        this._pttTextWaiters.delete(String(entry.msgId));
        return { text: String(res.text) };
      }
      const waitedText = await waitPromise;
      return { text: String(waitedText || "") };
    }

    case "set_qq_profile": {
      await this.invokeNt("nodeIKernelProfileService/modifyDesktopMiniProfile", {
        profile: {
          nick: p.nickname !== undefined ? String(p.nickname) : undefined,
          longNick: p.personal_note !== undefined ? String(p.personal_note) : undefined,
        },
      });
      return {};
    }

    case "set_self_longnick": {
      await this.invokeNt("nodeIKernelProfileService/modifyDesktopMiniProfile", {
        profile: {
          longNick: String(p.longNick ?? p.personal_note ?? ""),
        },
      });
      return {};
    }

    case "set_online_status": {
      await this.invokeNt("nodeIKernelOnlineStatusService/setOnlineStatus", {
        statusReq: {
          status: Number(p.status || 10),
          extStatus: Number(p.ext_status || 0),
          batteryStatus: Number(p.battery_status || 100),
        },
      });
      return {};
    }

    case "set_diy_online_status": {
      await this.invokeNt("nodeIKernelOnlineStatusService/setOnlineStatus", {
        statusReq: {
          status: 10,
          extStatus: 2000,
          customStatus: {
            faceId: String(p.face_id ?? 212),
            faceType: Number(p.face_type ?? 1),
            wording: String(p.wording ?? ""),
          },
        },
      });
      return {};
    }

    case "set_qq_avatar": {
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
        if (media && typeof media.cleanup === "function") {
          this._scheduleTempCleanup(media.cleanup);
        } else if (media) {
          this._scheduleMediaCleanup(media);
        }
      }
    }

    case "fetch_custom_face": {
      const count = Number(p.count || 48);
      const res = await this.invokeNt("nodeIKernelMsgService/fetchFavEmojiList", {
        resId: "",
        count,
        backwardFetch: true,
        forceRefresh: true,
      });
      const list = Array.isArray(res?.emojiInfoList) ? res.emojiInfoList : [];
      return list.map((e) => String(e.url || e.emoOriginalPath || "")).filter(Boolean);
    }

    // ---- 9. Ark Share & Robot UIN Range ----
    case "ArkSharePeer":
    case "share_peer":
    case "send_ark_share": {
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
    }

    case "ArkShareGroup":
    case "share_group_ex":
    case "send_group_ark_share": {
      const res = await this.invokeNt(
        "nodeIKernelGroupService/getGroupRecommendContactArkJson",
        { groupCode: String(p.group_id) },
        [String(p.group_id)]
      );
      return String(res?.arkJson || res?.arkMsg || res || "");
    }

    case "get_robot_uin_range": {
      const res = await this.invokeNt("nodeIKernelRobotService/getRobotUinRange", {
        req: {
          justFetchMsgConfig: "0",
          type: 1,
          version: 0,
          aioKeywordVersion: 0,
        },
      });
      return Array.isArray(res?.response?.robotUinRanges)
        ? res.response.robotUinRanges
        : [];
    }

    // ---- 10. Credentials, ClientKey, Cookies, QZone (Opt-in via enableWebCredentialApi) ----
    case "get_clientkey":
    case "get_cookies":
    case "get_csrf_token":
    case "get_credentials":
    case "get_qzone_msg_list":
    case "get_qzone_feeds":
    case "send_qzone_msg":
    case "delete_qzone_msg":
    case "like_qzone":
    case "unlike_qzone":
    case "comment_qzone":
      return await dispatchWebCredentialOrQzoneAction(this, action, p, WEB_HTTP_HELPERS);

    case "get_rkey":
    case "nc_get_rkey": {
      const res = await this.invokeNt("nodeIKernelUnitedConfigService/loadUnitedConfig", {
        id: "100293",
      });
      return {
        rkeys: [
          { type: "private", rkey: String(res?.configData?.content || "") },
          { type: "group", rkey: String(res?.configData?.content || "") },
        ],
      };
    }

    default:
      throw new Error(`Unsupported action: ${action}`);
  }
}

module.exports = {
  HANDLED_ACTIONS,
  dispatch,
};
