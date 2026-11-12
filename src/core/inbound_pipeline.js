"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  formatNtMsgToOneBotEvent,
  formatGroupUploadNotice,
  formatNoticeEvent,
  formatRequestEvent,
} = require("../bridge_onebot");

const inboundPipelineMixin = {
  async _handleKernelEvent(_listenerName, eventName, args) {
    const firstArg = args && args.length > 0 ? args[0] : undefined;

    // 1. Incoming messages: onRecvMsg / onRecvActiveMsg
    if (eventName === "onRecvMsg" || eventName === "onRecvActiveMsg") {
      const msgList = Array.isArray(firstArg)
        ? firstArg
        : Array.isArray(firstArg?.msgList)
        ? firstArg.msgList
        : [];
      for (const ntMsg of msgList) {
        await this._processIncomingNtMessage(ntMsg);
      }
      return;
    }

    // 2. Self-sent message confirmation: onAddSendMsg
    if (eventName === "onAddSendMsg") {
      const ntMsg = firstArg?.msgRecord || firstArg;
      if (ntMsg && typeof ntMsg === "object" && ntMsg.msgId) {
        if (this._isDuplicateEvent(`send:${ntMsg.msgId}`)) {
          return;
        }
        this._matchSendEcho(ntMsg);
        this.uinUidStore.rememberFromNtMsg(ntMsg);
        const ev = formatNtMsgToOneBotEvent(ntMsg, {
          selfId: this.selfUin,
          uinUidStore: this.uinUidStore,
          messageIdStore: this.messageIdStore,
          reportSelfMessage: false,
        });
        if (ev && ev.post_type === "message_sent") {
          this.broadcastOneBotEvent(ev);
        }
      }
      return;
    }

    // 3. Message updates (recalls, PTT transcription completion, emoji likes)
    if (eventName === "onMsgInfoListUpdate") {
      const msgList = Array.isArray(firstArg)
        ? firstArg
        : Array.isArray(firstArg?.msgList)
        ? firstArg.msgList
        : [];
      for (const ntMsg of msgList) {
        if (!ntMsg || typeof ntMsg !== "object") continue;

        // Check PTT voice-to-text completion waiters
        if (Array.isArray(ntMsg.elements)) {
          const pttEl = ntMsg.elements.find((e) => e?.elementType === 4 && e.pttElement)?.pttElement;
          if (pttEl && pttEl.text && this._pttTextWaiters.has(String(ntMsg.msgId))) {
            const waiter = this._pttTextWaiters.get(String(ntMsg.msgId));
            this._pttTextWaiters.delete(String(ntMsg.msgId));
            waiter(String(pttEl.text));
          }
        }

        // Check message recall
        if (ntMsg.recallTime && String(ntMsg.recallTime) !== "0" && Number(ntMsg.recallTime) > 0) {
          const dedupKey = `recall:${ntMsg.msgId}:${ntMsg.recallTime}`;
          if (!this._isDuplicateEvent(dedupKey)) {
            const ev = formatNtMsgToOneBotEvent(ntMsg, {
              selfId: this.selfUin,
              uinUidStore: this.uinUidStore,
              messageIdStore: this.messageIdStore,
            });
            if (ev && ev.post_type === "notice") {
              this.broadcastOneBotEvent(ev);
            }
          }
        }
      }
      return;
    }

    // 4. Group notifications (join/invite requests)
    if (eventName === "onGroupNotifiesUpdated") {
      const notifies = Array.isArray(args[1])
        ? args[1]
        : Array.isArray(firstArg?.notifies)
        ? firstArg.notifies
        : Array.isArray(firstArg)
        ? firstArg
        : [];
      for (const item of notifies) {
        if (!item || typeof item !== "object") continue;
        const seq = String(item.seq || "");
        const notifyType = Number(item.type || 0);
        const status = Number(item.status || 0);
        const groupId = Number(item.group?.groupCode || 0);
        const flag = seq ? `${seq}:${notifyType}:${groupId}` : "";
        if (flag) this._setBoundedMap(this._groupNotifiesCache, flag, item);

        // status === 1 means pending approval
        if (status === 1 && (notifyType === 1 || notifyType === 2 || notifyType === 7)) {
          const dedupKey = `group_req:${flag}`;
          if (this._isDuplicateEvent(dedupKey)) continue;
          const userUid = item.user1?.uid || "";
          const userUin =
            Number(item.user1?.uin || (await this.uinUidStore.resolveUin(userUid, this.invokeNt.bind(this))) || 0);
          const ev = formatRequestEvent(
            "group",
            {
              sub_type: notifyType === 2 ? "invite" : "add",
              group_id: groupId,
              user_id: userUin,
              comment: String(item.postscript || ""),
              flag,
            },
            { selfId: this.selfUin }
          );
          this.broadcastOneBotEvent(ev);
        }
      }
      return;
    }

    // 5. Friend requests: onBuddyReqChange
    if (eventName === "onBuddyReqChange") {
      const reqs = Array.isArray(firstArg?.buddyReqs)
        ? firstArg.buddyReqs
        : Array.isArray(firstArg)
        ? firstArg
        : [];
      for (const req of reqs) {
        if (!req || typeof req !== "object") continue;
        if (req.isDecide || Number(req.reqType) !== 1) continue;
        const friendUid = String(req.friendUid || req.friendUin || "");
        const reqExtra = String(req.reqTime || req.flag || req.postscript || req.extWords || "0");
        const flag = `${friendUid}:${reqExtra}`;
        this._setBoundedMap(this._buddyReqsCache, flag, req);
        const dedupKey = `friend_req:${friendUid}:${req.reqTime || req.flag || req.postscript || req.extWords || ""}`;
        if (this._isDuplicateEvent(dedupKey)) continue;
        const userUin = Number(
          req.friendUin || (await this.uinUidStore.resolveUin(friendUid, this.invokeNt.bind(this))) || 0
        );
        const ev = formatRequestEvent(
          "friend",
          {
            user_id: userUin,
            comment: String(req.extWords || ""),
            flag,
          },
          { selfId: this.selfUin }
        );
        this.broadcastOneBotEvent(ev);
      }
      return;
    }

    // 6. Buddy list change (V1 & V2) + Profile simple change + RichMedia download complete
    if (eventName === "onBuddyListChange" || eventName === "onBuddyListChangedV2") {
      this.uinUidStore.rememberFromBuddyList(firstArg);
      const cats = Array.isArray(firstArg)
        ? firstArg
        : Array.isArray(firstArg?.buddyCategory)
        ? firstArg.buddyCategory
        : Array.isArray(firstArg?.data)
        ? firstArg.data
        : [];
      if (cats.length > 0) {
        this._buddyCategoriesCache = cats;
        this.online = true;
      }
      for (const waiter of Array.from(this._buddyListWaiters)) {
        try {
          waiter(firstArg);
        } catch (_) {}
      }
      return;
    }

    if (eventName === "onProfileSimpleChanged") {
      const profiles = firstArg?.profiles || firstArg;
      const entries =
        profiles instanceof Map
          ? Array.from(profiles.entries())
          : profiles && typeof profiles === "object"
          ? Object.entries(profiles)
          : [];
      for (const [uidKey, info] of entries) {
        if (!info || typeof info !== "object") continue;
        const core = info.coreInfo || info.baseInfo || info;
        this.uinUidStore.remember(core.uin || info.uin, core.uid || info.uid || uidKey, {
          nickname: core.nick || info.nick || "",
          remark: core.remark || info.remark || "",
        });
      }
      return;
    }

    if (eventName === "onRichMediaDownloadComplete") {
      const info = firstArg?.notifyInfo || firstArg || {};
      const msgId = String(info.msgId || "");
      const elId = String(info.msgElementId || info.elementId || "");
      const filePath = String(info.filePath || "");
      const keys = [`${msgId}:${elId}`, `${msgId}:0`, filePath].filter(Boolean);
      for (const k of keys) {
        const set = this._richMediaWaiters.get(k);
        if (set) {
          this._richMediaWaiters.delete(k);
          for (const resolve of set) {
            try {
              resolve(filePath);
            } catch (_) {}
          }
        }
      }
      return;
    }

    // 7. Group list update
    if (eventName === "onGroupListUpdate") {
      const groupList = Array.isArray(args[1])
        ? args[1]
        : Array.isArray(firstArg?.groupList)
        ? firstArg.groupList
        : Array.isArray(firstArg)
        ? firstArg
        : [];
      if (groupList.length > 0) {
        this.online = true;
      }
      for (const g of groupList) {
        if (g && (g.groupCode || g.groupUin || g.group_id)) {
          const gid = String(g.groupCode || g.groupUin || g.group_id);
          this._setBoundedMap(this._groupListCache, gid, g);
        }
      }
      for (const waiter of Array.from(this._groupListWaiters)) {
        try {
          waiter(groupList);
        } catch (_) {}
      }
      return;
    }

    // 8. Group member info change
    if (eventName === "onMemberInfoChange") {
      const groupCode = String(firstArg || "");
      const members = args[2] || args[1];
      if (groupCode && members) {
        this.uinUidStore.rememberFromGroupMemberList(groupCode, members);
      }
      return;
    }

    // 9. Login / QR / Session / Offline
    if (eventName === "onQRCodeGetPicture" || eventName === "onQRCodeSessionQuickLoginFailed") {
      const pngBase64 =
        firstArg?.pngBase64QrcodeData ||
        firstArg?.qrcodeImage ||
        firstArg?.result?.pngBase64QrcodeData ||
        "";
      if (pngBase64) {
        this.lastQrCodeBase64 = String(pngBase64);
      }
      return;
    }
    if (eventName === "onUserLoggedIn" || eventName === "onQRCodeLoginSucceed") {
      const uinCandidate =
        firstArg && typeof firstArg === "object" ? firstArg.uin || firstArg.userId : firstArg;
      const uidCandidate =
        firstArg && typeof firstArg === "object" ? firstArg.uid : undefined;
      const nickCandidate =
        firstArg && typeof firstArg === "object" ? firstArg.nickName || firstArg.nick : undefined;
      this._updateSelfIdentity({
        uin: uinCandidate,
        uid: uidCandidate,
        nick: nickCandidate,
        markOnline: true,
      });
      return;
    }
    if (eventName === "onSessionInitComplete") {
      const code =
        firstArg && typeof firstArg === "object" ? Number(firstArg.result ?? 0) : Number(firstArg ?? 0);
      if (!Number.isFinite(code) || code === 0) {
        this.online = true;
      }
      return;
    }
    if (eventName === "onKickedOffLine") {
      this.online = false;
      this._resetHumanSessionState({ resetRenderer: true });
      this.broadcastOneBotEvent(
        formatNoticeEvent(
          "bot_offline",
          {
            user_id: Number(this.selfUin || 0),
            tag: String(firstArg?.tipsTitle || "kicked_offline"),
            message: String(firstArg?.tipsDesc || "QQ offline"),
          },
          { selfId: this.selfUin }
        )
      );
    }
  },

  async _hydrateNtMsgMedia(ntMsg) {
    if (!ntMsg || typeof ntMsg !== "object" || !Array.isArray(ntMsg.elements)) return;
    const maxBytes = 10 * 1024 * 1024;
    for (const el of ntMsg.elements) {
      if (!el || Number(el.elementType) !== 2 || !el.picElement) continue;
      const pe = el.picElement;
      if (pe.__base64Uri) continue;
      const origin = String(pe.originImageUrl || "").trim();
      if (origin && origin.includes("rkey=")) continue;
      if (origin && /^https?:\/\//i.test(origin) && !origin.includes("multimedia.nt.qq.com.cn/download")) {
        continue;
      }
      if (Number(pe.fileSize || 0) > maxBytes) continue;

      let localPath = String(pe.sourcePath || "").trim();
      const hasValidFile = (p) => {
        try {
          if (!p || !fs.existsSync(p)) return false;
          const st = fs.statSync(p);
          return st.isFile() && st.size > 0 && st.size <= maxBytes;
        } catch (_) {
          return false;
        }
      };

      if (!localPath && pe.md5HexStr) {
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
          if (resolvedPath) localPath = String(resolvedPath);
        } catch (_) {}
      }

      const runDownloadAttempt = async (downloadType, thumbSize, targetPath, timeoutMs) => {
        const waitKeys = [
          `${ntMsg.msgId}:${el.elementId || "0"}`,
          `${ntMsg.msgId}:0`,
          targetPath || "",
        ].filter(Boolean);
        let timer = null;
        let pollTimer = null;
        let onDone = null;
        const cleanupWaiter = () => {
          if (timer) clearTimeout(timer);
          if (pollTimer) clearInterval(pollTimer);
          if (onDone) {
            for (const k of waitKeys) {
              const set = this._richMediaWaiters.get(k);
              if (set) {
                set.delete(onDone);
                if (set.size === 0) this._richMediaWaiters.delete(k);
              }
            }
          }
        };
        const waitDownload = new Promise((resolve) => {
          let settled = false;
          const finish = (candidate) => {
            if (settled) return;
            settled = true;
            cleanupWaiter();
            resolve(candidate || targetPath);
          };
          onDone = (downloadedPath) => finish(downloadedPath || targetPath);
          for (const k of waitKeys) {
            if (!this._richMediaWaiters.has(k)) {
              this._richMediaWaiters.set(k, new Set());
            }
            this._richMediaWaiters.get(k).add(onDone);
          }
          if (targetPath) {
            pollTimer = setInterval(() => {
              if (hasValidFile(targetPath)) {
                finish(targetPath);
              }
            }, 200);
            if (typeof pollTimer.unref === "function") pollTimer.unref();
          }
          timer = setTimeout(() => finish(targetPath), timeoutMs);
          if (typeof timer.unref === "function") timer.unref();
        });

        try {
          const getReq = {
            downSourceType: 0,
            downloadSourceType: 0,
            fileModelId: "0",
            triggerType: 1,
            msgId: String(ntMsg.msgId),
            chatType: Number(ntMsg.chatType || 1),
            peerUid: String(ntMsg.peerUid),
            elementId: String(el.elementId || "0"),
            thumbSize,
            downloadType,
            filePath: targetPath,
          };
          const dlRes = await this.invokeNt(
            "nodeIKernelMsgService/downloadRichMedia",
            { getReq },
            [getReq]
          );
          if (dlRes?.filePath && hasValidFile(dlRes.filePath)) {
            return String(dlRes.filePath);
          }
          const waitedPath = await waitDownload;
          if (waitedPath && hasValidFile(waitedPath)) {
            return String(waitedPath);
          }
        } catch (_) {
        } finally {
          cleanupWaiter();
        }
        return "";
      };

      if (!hasValidFile(localPath) && ntMsg.msgId && ntMsg.peerUid) {
        const downloadedOrig = await runDownloadAttempt(1, 0, localPath, 8000);
        if (downloadedOrig) {
          localPath = downloadedOrig;
        }
      }

      if (!hasValidFile(localPath)) {
        const thumbs =
          pe.thumbPath instanceof Map
            ? Array.from(pe.thumbPath.values())
            : pe.thumbPath && typeof pe.thumbPath === "object"
            ? Object.values(pe.thumbPath)
            : [];
        for (const tp of thumbs) {
          if (hasValidFile(String(tp || ""))) {
            localPath = String(tp);
            break;
          }
        }
        if (!hasValidFile(localPath) && ntMsg.msgId && ntMsg.peerUid) {
          const fallbackThumbPath = thumbs.length > 0 ? String(thumbs[0] || "") : "";
          const downloadedThumb = await runDownloadAttempt(2, 720, fallbackThumbPath, 5000);
          if (downloadedThumb) {
            localPath = downloadedThumb;
          }
        }
      }

      if (hasValidFile(localPath)) {
        try {
          const b64 = fs.readFileSync(localPath).toString("base64");
          Object.defineProperty(pe, "__base64Uri", {
            value: `base64://${b64}`,
            enumerable: false,
            configurable: true,
            writable: true,
          });
        } catch (_) {}
      }
    }
  },

  async _processIncomingNtMessage(ntMsg) {
    if (!ntMsg || typeof ntMsg !== "object") return;
    const msgId = String(ntMsg.msgId || "");
    if (msgId && this._isDuplicateEvent(`msg:${msgId}`)) {
      return;
    }

    this.uinUidStore.rememberFromNtMsg(ntMsg);
    if ((!ntMsg.senderUin || String(ntMsg.senderUin) === "0") && ntMsg.senderUid) {
      const resolvedUin = await this.uinUidStore.resolveUin(
        ntMsg.senderUid,
        this.invokeNt.bind(this)
      );
      if (resolvedUin) {
        ntMsg.senderUin = resolvedUin;
      }
    }

    // Also resolve any @ mentioned UIDs that don't have UIN cached yet
    if (Array.isArray(ntMsg.elements)) {
      for (const el of ntMsg.elements) {
        if (
          el?.elementType === 1 &&
          el.textElement?.atType === 2 &&
          el.textElement.atNtUid &&
          (!el.textElement.atUid || !/^\d+$/.test(String(el.textElement.atUid)))
        ) {
          const uin = await this.uinUidStore.resolveUin(
            el.textElement.atNtUid,
            this.invokeNt.bind(this)
          );
          if (uin) el.textElement.atUid = uin;
        }
      }
    }

    await this._hydrateNtMsgMedia(ntMsg);

    const ev = formatNtMsgToOneBotEvent(ntMsg, {
      selfId: this.selfUin,
      uinUidStore: this.uinUidStore,
      messageIdStore: this.messageIdStore,
    });
    if (ev) {
      this.broadcastOneBotEvent(ev);
    }

    const uploadNotice = formatGroupUploadNotice(ntMsg, {
      selfId: this.selfUin,
      uinUidStore: this.uinUidStore,
    });
    if (uploadNotice) {
      this.broadcastOneBotEvent(uploadNotice);
    }

    const autoReadAndType =
      this.config.autoReadAndTypeOnPrivateRecv === true ||
      process.env.ROSMONTIS_AUTO_READ_AND_TYPE_ON_PRIVATE_RECV === "1" ||
      process.env.ONEBOT_AUTO_READ_AND_TYPE_ON_PRIVATE_RECV === "1" ||
      process.env.XIAO_BRIDGE_AUTO_READ_AND_TYPE_ON_PRIVATE_RECV === "1";
    const isSelfSender =
      (Boolean(this.selfUin) && String(ntMsg.senderUin || "") === String(this.selfUin)) ||
      (Boolean(this.selfUid) && String(ntMsg.senderUid || "") === String(this.selfUid));
    if (
      this.config.humanSimulation !== false &&
      autoReadAndType &&
      Number(ntMsg.chatType) === 1 &&
      ntMsg.peerUid &&
      Number(ntMsg.msgType) !== 5 &&
      !isSelfSender
    ) {
      const peerUid = String(ntMsg.peerUid);
      const peerKey = `1:${peerUid}:`;
      this._sessionScheduler.schedulePrivateRecvReaction(
        peerKey,
        this.config.autoReadReactionDelayMs ?? [500, 1800],
        () =>
          this.simulateHumanSession({
            chatType: 1,
            peerUid,
            guildId: "",
            markRead: true,
            sendTyping: true,
            eventType: 1,
            advisory: true,
          }).catch(() => {})
      );
    }
  },
};

module.exports = {
  inboundPipelineMixin,
};
