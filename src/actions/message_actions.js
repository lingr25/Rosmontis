"use strict";

const {
  segmentsToCqCode,
  parseCqCodeToSegments,
  normalizeOneBotMessage,
  ntMsgToOneBotSegments,
  formatNtMsgToOneBotEvent,
} = require("../bridge_onebot");

const { resolveCompatVersionInfo } = require("../core/config");

function extractExclusiveForwardNodes(message, autoEscape = false) {
  if (autoEscape && typeof message === "string") return null;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    return String(message.type || "").toLowerCase() === "node" ? [message] : null;
  }
  if (!Array.isArray(message) || message.length === 0) return null;
  const nodes = [];
  for (const item of message) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const t = String(item.type || "").trim().toLowerCase();
    if (!t) return null;
    if (t === "text" && (item.data?.text ?? item.text) === "") continue;
    if (t !== "node") return null;
    nodes.push(item);
  }
  return nodes.length > 0 ? nodes : null;
}

const HANDLED_ACTIONS = new Set([
  "get_login_info",
  "get_status",
  "quick_login",
  "get_login_list",
  "get_login_qrcode",
  "get_version_info",
  "can_send_image",
  "can_send_record",
  "clean_cache",
  "send_private_msg",
  "send_group_msg",
  "send_msg",
  "delete_msg",
  "get_msg",
  "get_forward_msg",
  "send_group_forward_msg",
  "send_private_forward_msg",
  "send_forward_msg",
  "upload_forward_msg",
  "upload_foward_msg",
  "forward_friend_single_msg",
  "forward_group_single_msg",
  "get_group_msg_history",
  "get_friend_msg_history",
  "mark_msg_as_read",
  "mark_group_msg_as_read",
  "mark_private_msg_as_read",
  "mark_all_as_read",
  "_mark_all_as_read",
  "set_input_status",
  "set_msg_emoji_like",
  "set_group_reaction",
  "fetch_emoji_like",
  "get_emoji_likes",
  "get_msg_emoji_likes",
  "send_like",
  "get_profile_like",
  "group_poke",
  "friend_poke",
  "send_poke",
  ".handle_quick_operation",
  ".handle_quick_operation_async",
  "handle_quick_operation",
  "handle_quick_operation_async",
]);

async function dispatch(action, p, context = {}) {
  switch (action) {
    // ---- 1. Info & Status ----
    case "get_login_info": {
      if (!this.selfUin || !this.selfUid || !this.selfNickname || this.selfNickname === "QQBot") {
        try {
          const loginRes = await this.invokeNt("nodeIKernelLoginService/getLoginList", {});
          const list = Array.isArray(loginRes?.LocalLoginInfoList)
            ? loginRes.LocalLoginInfoList
            : [];
          const activeAcc =
            list.find((item) => item && this.selfUin && String(item.uin) === String(this.selfUin)) ||
            list.find((item) => item && (item.isQuickLogin || item.isAutoLogin) && item.uin) ||
            list.find((item) => item && item.uin) ||
            null;
          if (activeAcc) {
            this._updateSelfIdentity({
              uin: this.selfUin || activeAcc.uin,
              uid: this.selfUid || activeAcc.uid,
              nick:
                this.selfNickname && this.selfNickname !== "QQBot"
                  ? this.selfNickname
                  : activeAcc.nickName || activeAcc.nick,
              markOnline: false,
            });
          }
        } catch (_) {}
      }
      return {
        user_id: Number(this.selfUin || 0),
        nickname: String(this.selfNickname || "QQBot"),
      };
    }

    case "get_status":
      return {
        online: Boolean(this.online),
        good: Boolean(this.online),
        time: Math.max(
          0,
          Math.floor((Date.now() - (this.startedAtMs || Date.now())) / 1000)
        ),
        bridge: {
          invoke: { ...this.invokeStats },
          send_echo: { ...this.sendEchoStats },
          map_hook_active: Boolean(this._mapSetHook) && Map.prototype.set === this._mapSetHook,
          map_hook_release: this.mapHookRelease || null,
        },
      };

    case "quick_login":
      return await this._tryAutoQuickLogin({
        uin: p.user_id || p.uin || "",
        force: p.force !== undefined ? Boolean(p.force) : true,
      });

    case "get_login_list": {
      const loginRes = await this.invokeNt("nodeIKernelLoginService/getLoginList", {}, []);
      return Array.isArray(loginRes?.LocalLoginInfoList) ? loginRes.LocalLoginInfoList : [];
    }

    case "get_login_qrcode": {
      if (Boolean(p.refresh) || !this.lastQrCodeBase64) {
        try {
          const qrRes = await this.invokeNt("nodeIKernelLoginService/getQRCodePicture", {});
          const directQr =
            qrRes?.pngBase64QrcodeData ||
            qrRes?.qrcodeImage ||
            qrRes?.result?.pngBase64QrcodeData ||
            "";
          if (directQr) {
            this.lastQrCodeBase64 = String(directQr);
          }
        } catch (_) {}
      }
      return {
        online: Boolean(this.online),
        qrcode_base64: String(this.lastQrCodeBase64 || ""),
      };
    }

    case "get_version_info":
      return resolveCompatVersionInfo(this.config, context);

    case "can_send_image":
    case "can_send_record":
      return { yes: true };

    case "clean_cache":
      this.flushTempCleanup();
      return {};

    // ---- 2. Messaging ----
    case "send_private_msg": {
      const userId = p.user_id;
      if (!userId) throw new Error("user_id is required");
      const fwdNodes = extractExclusiveForwardNodes(p.message, Boolean(p.auto_escape));
      if (fwdNodes) {
        return await this._dispatchAction(
          "send_private_forward_msg",
          { ...p, messages: fwdNodes },
          context
        );
      }
      const peer = await this._resolvePeerForUser(userId, p.group_id);
      return await this._sendMessageToPeer(peer, p.message, Boolean(p.auto_escape), p.group_id);
    }

    case "send_group_msg": {
      const groupId = p.group_id;
      if (!groupId) throw new Error("group_id is required");
      const fwdNodes = extractExclusiveForwardNodes(p.message, Boolean(p.auto_escape));
      if (fwdNodes) {
        return await this._dispatchAction(
          "send_group_forward_msg",
          { ...p, messages: fwdNodes },
          context
        );
      }
      const peer = { chatType: 2, peerUid: String(groupId), guildId: "" };
      return await this._sendMessageToPeer(peer, p.message, Boolean(p.auto_escape), groupId);
    }

    case "send_msg": {
      const isGroup = p.message_type === "group" || (p.group_id && p.message_type !== "private");
      if (isGroup) {
        return await this._dispatchAction("send_group_msg", p, context);
      }
      return await this._dispatchAction("send_private_msg", p, context);
    }

    case "delete_msg": {
      const entry =
        this.messageIdStore.getByShortId(p.message_id) ||
        this.messageIdStore.getByMsgId(p.message_id);
      if (!entry) throw new Error("message not found");
      await this.invokeNt(
        "nodeIKernelMsgService/recallMsg",
        { peer: entry.peer, msgIds: [String(entry.msgId)] },
        [entry.peer, [String(entry.msgId)]]
      );
      return {};
    }

    case "get_msg": {
      const reqMsgFormat =
        context?.messageFormat || p?.message_format || this.config.messageFormat || "array";
      const formatMsgPayload = (copy) => {
        if (reqMsgFormat === "string") {
          copy.message =
            typeof copy.raw_message === "string" &&
            (copy.raw_message.length > 0 || !Array.isArray(copy.message) || copy.message.length === 0)
              ? copy.raw_message
              : Array.isArray(copy.message)
              ? segmentsToCqCode(copy.message)
              : String(copy.message ?? "");
        } else if (typeof copy.message === "string") {
          copy.message = normalizeOneBotMessage(copy.message);
        }
        return copy;
      };
      const entry =
        this.messageIdStore.getByShortId(p.message_id) ||
        this.messageIdStore.getByMsgId(p.message_id);
      if (entry && entry.rawMsg) {
        await this._hydrateNtMsgMedia(entry.rawMsg);
        const refreshed = formatNtMsgToOneBotEvent(entry.rawMsg, {
          selfId: this.selfUin,
          uinUidStore: this.uinUidStore,
          messageIdStore: this.messageIdStore,
          reportSelfMessage: true,
          messageFormat: reqMsgFormat,
        });
        if (refreshed) {
          const copy = formatMsgPayload({ ...refreshed });
          delete copy.post_type;
          delete copy.self_id;
          copy.real_id = entry.msgId;
          return copy;
        }
      }
      if (entry && entry.oneBotEvent) {
        const copy = formatMsgPayload({ ...entry.oneBotEvent });
        delete copy.post_type;
        delete copy.self_id;
        copy.real_id = entry.msgId;
        return copy;
      }
      if (entry && entry.peer?.peerUid) {
        const res = await this.invokeNt(
          "nodeIKernelMsgService/getMsgsByMsgId",
          { peer: entry.peer, msgIds: [String(entry.msgId)] },
          [entry.peer, [String(entry.msgId)]]
        );
        const rawMsg = res?.msgList?.[0];
        if (rawMsg) {
          await this._hydrateNtMsgMedia(rawMsg);
          const formatted = formatNtMsgToOneBotEvent(rawMsg, {
            selfId: this.selfUin,
            uinUidStore: this.uinUidStore,
            messageIdStore: this.messageIdStore,
            messageFormat: reqMsgFormat,
          });
          if (formatted) {
            const copy = formatMsgPayload({ ...formatted });
            delete copy.post_type;
            delete copy.self_id;
            copy.real_id = rawMsg.msgId;
            return copy;
          }
        }
      }
      if (entry) {
        return formatMsgPayload({
          time: Number(entry.msgTime || Math.floor(Date.now() / 1000)),
          message_type: entry.peer?.chatType === 2 ? "group" : "private",
          message_id: entry.shortId,
          real_id: entry.msgId,
          message_seq: Number(entry.msgSeq || 0),
          sender: {
            user_id: Number(entry.senderUin || this.selfUin || 0),
            nickname: this.selfNickname || "",
          },
          message: [],
          raw_message: "",
          font: 14,
          ...(entry.peer?.chatType === 2 ? { group_id: Number(entry.peer.peerUid || 0) } : {}),
        });
      }
      throw new Error("message not found");
    }

    // ---- 3. Forward Messages & History ----
    case "get_forward_msg": {
      const resId = String(p.id || p.message_id || p.res_id || "");
      if (!resId) throw new Error("id is required");
      const entry =
        this.messageIdStore.getByShortId(resId) || this.messageIdStore.getByMsgId(resId);
      const peer = entry?.peer || { chatType: 2, peerUid: String(p.group_id || "0"), guildId: "" };
      const rootMsgId = entry?.msgId || resId;
      const res = await this.invokeNt(
        "nodeIKernelMsgService/getMultiMsg",
        {
          peer,
          rootMsgId: String(rootMsgId),
          parentMsgId: String(rootMsgId),
        },
        [peer, String(rootMsgId), String(rootMsgId)]
      );
      const msgList = Array.isArray(res?.msgList) ? res.msgList : [];
      const messages = [];
      for (const m of msgList) {
        await this._hydrateNtMsgMedia(m);
        const { segments, raw_message } = ntMsgToOneBotSegments(m, {
          uinUidStore: this.uinUidStore,
          messageIdStore: this.messageIdStore,
        });
        const uin = Number(
          m.senderUin || this.uinUidStore.getUinSync(m.senderUid) || 0
        );
        const nickname = String(m.sendMemberName || m.sendNickName || uin || "群友");
        const shortId = this.messageIdStore.register(
          m.msgId,
          { chatType: m.chatType || peer.chatType, peerUid: m.peerUid || peer.peerUid },
          m.msgSeq,
          { senderUin: uin, senderUid: m.senderUid, rawMsg: m }
        );
        messages.push({
          type: "node",
          data: {
            user_id: uin,
            nickname,
            sender: { user_id: uin, nickname },
            content: segments,
            message: segments,
            raw_message,
            time: Number(m.msgTime || Math.floor(Date.now() / 1000)),
            message_id: shortId,
          },
        });
      }
      return { messages };
    }

    case "send_group_forward_msg":
    case "send_private_forward_msg":
    case "send_forward_msg":
    case "upload_forward_msg":
    case "upload_foward_msg": {
      const isGroup =
        action === "send_group_forward_msg" ||
        (p.group_id && action !== "send_private_forward_msg");
      const peer = isGroup
        ? { chatType: 2, peerUid: String(p.group_id), guildId: "" }
        : await this._resolvePeerForUser(p.user_id, p.group_id);
      const nodes = Array.isArray(p.messages)
        ? p.messages
        : Array.isArray(p.message)
        ? p.message
        : [];

      const hasCustomNodes = nodes.some((n) => {
        const nd = n?.data || n || {};
        return !nd.id && (nd.content !== undefined || nd.message !== undefined);
      });

      let srcContact = peer;
      if (hasCustomNodes) {
        let selfUid = this.selfUid || this.uinUidStore.getUidSync(this.selfUin);
        if (!selfUid && this.selfUin) {
          selfUid = await this.uinUidStore.resolveUid(this.selfUin, this.invokeNt.bind(this));
          if (selfUid) this.selfUid = selfUid;
        }
        if (selfUid) {
          srcContact = { chatType: 1, peerUid: selfUid, guildId: "" };
        }
      }

      const sentIds = [];
      for (const node of nodes) {
        const nd = node?.data || node || {};
        const content = nd.content !== undefined ? nd.content : nd.message;
        if (nd.id) {
          const ref =
            this.messageIdStore.getByShortId(nd.id) || this.messageIdStore.getByMsgId(nd.id);
          if (ref?.msgId) sentIds.push(String(ref.msgId));
        } else if (content !== undefined) {
          const subSent = await this._sendMessageToPeer(
            srcContact,
            content,
            false,
            undefined,
            { skipHumanSimulation: true }
          );
          if (subSent?.real_id) sentIds.push(String(subSent.real_id));
        }
      }
      let messageId = 0;
      const forwardId = `fwd_${Date.now()}`;
      if (sentIds.length > 0) {
        const msgInfos = sentIds.map((id) => ({
          msgId: id,
          senderShowName: String(p.source || this.selfNickname || "QQBot"),
        }));
        try {
          const fwdRes = await this.invokeNt(
            "nodeIKernelMsgService/multiForwardMsgWithComment",
            {
              msgInfos,
              srcContact,
              dstContact: peer,
              commentElements: [],
              msgAttributeInfos: new Map(),
            },
            [msgInfos, srcContact, peer, [], new Map()]
          );
          messageId = this.messageIdStore.register(
            fwdRes?.msgId || forwardId,
            peer,
            fwdRes?.msgSeq || "0"
          );
        } catch (_) {
          // Fallback: send combined text ONLY if staging did not already send directly to `peer`
          if (srcContact.peerUid !== peer.peerUid || srcContact.chatType !== peer.chatType) {
            const combined = nodes
              .map((n) => {
                const nd = n?.data || n || {};
                const segs = normalizeOneBotMessage(nd.content || nd.message || "");
                return segs.map((s) => s.data?.text || "").join("");
              })
              .filter(Boolean)
              .join("\n\n");
            if (combined) {
              const fallbackRes = await this._sendMessageToPeer(peer, combined);
              messageId = fallbackRes.message_id;
            }
          }
        }
      }
      return {
        message_id: messageId,
        res_id: forwardId,
        forward_id: forwardId,
      };
    }

    case "forward_friend_single_msg":
    case "forward_group_single_msg": {
      const entry =
        this.messageIdStore.getByShortId(p.message_id) ||
        this.messageIdStore.getByMsgId(p.message_id);
      if (!entry) throw new Error("message not found");
      const dstContact =
        action === "forward_group_single_msg"
          ? { chatType: 2, peerUid: String(p.group_id), guildId: "" }
          : await this._resolvePeerForUser(p.user_id);
      await this.invokeNt(
        "nodeIKernelMsgService/forwardMsgWithComment",
        {
          msgIds: [String(entry.msgId)],
          srcContact: entry.peer,
          dstContacts: [dstContact],
          commentElements: [],
          msgAttributeInfos: new Map(),
        },
        [[String(entry.msgId)], entry.peer, [dstContact], [], new Map()]
      );
      const newShortId = this.messageIdStore.register(
        `fwd_${entry.msgId}_${Date.now()}`,
        dstContact,
        "0"
      );
      return { message_id: newShortId };
    }

    case "get_group_msg_history":
    case "get_friend_msg_history": {
      const isGroup = action === "get_group_msg_history";
      const peer = isGroup
        ? { chatType: 2, peerUid: String(p.group_id), guildId: "" }
        : await this._resolvePeerForUser(p.user_id);
      const count = Math.max(1, Math.min(Number(p.count || 20), 100));
      let startMsgId = "0";
      if (p.message_id && Number(p.message_id) > 0) {
        const ref =
          this.messageIdStore.getByShortId(p.message_id) ||
          this.messageIdStore.getByMsgId(p.message_id);
        if (ref?.msgId && /^\d+$/.test(String(ref.msgId))) {
          startMsgId = String(ref.msgId);
        }
      }
      const queryOrder = startMsgId === "0";
      let res = await this.invokeNt(
        "nodeIKernelMsgService/getMsgsIncludeSelf",
        {
          peer,
          msgId: startMsgId,
          cnt: count,
          queryOrder,
        },
        [peer, startMsgId, count, queryOrder]
      );
      let rawList = Array.isArray(res?.msgList) ? res.msgList : [];
      if (rawList.length === 0 && queryOrder) {
        res = await this.invokeNt(
          "nodeIKernelMsgService/getMsgsIncludeSelf",
          {
            peer,
            msgId: startMsgId,
            cnt: count,
            queryOrder: false,
          },
          [peer, startMsgId, count, false]
        );
        rawList = Array.isArray(res?.msgList) ? res.msgList : [];
      }
      const reqMsgFormat =
        context?.messageFormat || p?.message_format || this.config.messageFormat || "array";
      const messages = [];
      for (const m of rawList) {
        await this._hydrateNtMsgMedia(m);
        const ev = formatNtMsgToOneBotEvent(m, {
          selfId: this.selfUin,
          uinUidStore: this.uinUidStore,
          messageIdStore: this.messageIdStore,
          reportSelfMessage: true,
          messageFormat: reqMsgFormat,
        });
        if (ev) messages.push(this._formatEventForEndpoint(ev, reqMsgFormat));
      }
      return { messages };
    }

    // ---- 4. Read, Input Status, Emoji Likes, Profile Likes, Pokes ----
    case "mark_msg_as_read":
    case "mark_group_msg_as_read":
    case "mark_private_msg_as_read":
    case "mark_all_as_read":
    case "_mark_all_as_read": {
      let peer = null;
      if (p.message_id) {
        const entry =
          this.messageIdStore.getByShortId(p.message_id) ||
          this.messageIdStore.getByMsgId(p.message_id);
        if (entry?.peer) peer = entry.peer;
      }
      if (!peer) {
        const isGroupTarget =
          Boolean(p.group_id) ||
          action === "mark_group_msg_as_read" ||
          p.message_type === "group" ||
          String(p.chat_type) === "2";
        if (isGroupTarget && (p.group_id || p.target_id)) {
          peer = { chatType: 2, peerUid: String(p.group_id || p.target_id), guildId: "" };
        } else if (p.user_id || p.target_id) {
          peer = await this._resolvePeerForUser(p.user_id || p.target_id);
        }
      }
      if (peer && peer.peerUid) {
        const peerKey = `${peer.chatType}:${peer.peerUid}:${peer.guildId || ""}`;
        this._sessionScheduler.cancelPeerReaction(peerKey);
        await this.simulateHumanSession({
          chatType: peer.chatType,
          peerUid: peer.peerUid,
          guildId: peer.guildId || "",
          markRead: true,
          sendTyping: false,
        });
      } else if (action === "mark_all_as_read" || action === "_mark_all_as_read") {
        try {
          await this.invokeNt("nodeIKernelMsgService/setAllC2CAndGroupMsgRead", {});
        } catch (_) {}
      }
      return {};
    }

    case "set_input_status": {
      const userId = p.user_id;
      if (!userId) throw new Error("user_id is required");
      const peer = await this._resolvePeerForUser(userId);
      const peerKey = `${peer.chatType}:${peer.peerUid}:${peer.guildId || ""}`;
      this._sessionScheduler.cancelPeerReaction(peerKey);
      const eventType = Number(p.event_type ?? 1);
      await this.simulateHumanSession({
        chatType: peer.chatType,
        peerUid: peer.peerUid,
        guildId: peer.guildId || "",
        markRead: true,
        sendTyping: true,
        eventType,
      });
      return {};
    }

    case "set_msg_emoji_like":
    case "set_group_reaction": {
      const entry =
        this.messageIdStore.getByShortId(p.message_id) ||
        this.messageIdStore.getByMsgId(p.message_id);
      if (!entry) throw new Error("message not found");
      const emojiId = String(p.emoji_id ?? p.code ?? "");
      if (!emojiId) throw new Error("emoji_id is required");
      const emojiType = Number(emojiId) > 999 ? "2" : "1";
      const setEmoji = Boolean(p.set ?? p.is_set ?? true);
      await this.invokeNt(
        "nodeIKernelMsgService/setMsgEmojiLikes",
        {
          peer: entry.peer,
          msgSeq: String(entry.msgSeq || "0"),
          emojiId,
          emojiType,
          setEmoji,
        },
        [entry.peer, String(entry.msgSeq || "0"), emojiId, emojiType, setEmoji]
      );
      return {};
    }

    case "fetch_emoji_like":
    case "get_emoji_likes":
    case "get_msg_emoji_likes": {
      const entry =
        this.messageIdStore.getByShortId(p.message_id) ||
        this.messageIdStore.getByMsgId(p.message_id);
      const peer =
        entry?.peer ||
        (p.group_id
          ? { chatType: 2, peerUid: String(p.group_id), guildId: "" }
          : await this._resolvePeerForUser(p.user_id));
      const msgSeq = String(entry?.msgSeq || p.msg_seq || "0");
      const emojiId = String(p.emoji_id || "");
      const emojiType = String(p.emoji_type || (Number(emojiId) > 999 ? "2" : "1"));
      const res = await this.invokeNt(
        "nodeIKernelMsgService/getMsgEmojiLikesList",
        {
          peer,
          msgSeq,
          emojiId,
          emojiType,
          cookie: "",
          isForward: false,
          count: Number(p.count || 20),
        }
      );
      return {
        emoji_like_list: res?.emojiLikesList || [],
      };
    }

    case "send_like": {
      const targetUid = await this.uinUidStore.resolveUid(
        p.user_id,
        this.invokeNt.bind(this)
      );
      const count = Math.max(1, Math.min(Number(p.times || 1), 20));
      await this.invokeNt(
        "nodeIKernelProfileLikeService/setBuddyProfileLike",
        {
          doLikeUserInfo: {
            friendUid: targetUid,
            sourceId: 71,
            doLikeCount: count,
            doLikeTollCount: 0,
          },
        }
      );
      return {};
    }

    case "get_profile_like": {
      const targetUid = p.user_id
        ? await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this))
        : this.selfUid;
      const res = await this.invokeNt(
        "nodeIKernelProfileLikeService/getBuddyProfileLike",
        {
          req: {
            friendUids: [targetUid || ""],
            basic: 1,
            vote: 1,
            favorite: 0,
            userProfile: 1,
            type: 2,
            start: Number(p.start || 0),
            limit: Number(p.count || 10),
          },
        }
      );
      const info = res?.info?.userLikeInfos?.[0] || {};
      return {
        uid: String(targetUid || ""),
        time: Number(info.time || 0),
        favoriteInfo: info.favoriteInfo || {
          total_count: 0,
          last_time: 0,
          today_count: 0,
          userInfos: [],
        },
        voteInfo: info.voteInfo || {
          total_count: 0,
          new_count: 0,
          new_nearby_count: 0,
          last_visit_time: 0,
          userInfos: [],
        },
      };
    }

    case "group_poke":
      await this._sendPokeInternal(p.group_id, p.user_id);
      return {};

    case "friend_poke":
      await this._sendPokeInternal(undefined, p.user_id);
      return {};

    case "send_poke":
      await this._sendPokeInternal(p.group_id, p.user_id || p.target_id);
      return {};

    case ".handle_quick_operation":
    case ".handle_quick_operation_async":
    case "handle_quick_operation":
    case "handle_quick_operation_async": {
      const ev = p.context;
      const op = p.operation;
      if (
        !ev ||
        typeof ev !== "object" ||
        Array.isArray(ev) ||
        !op ||
        typeof op !== "object" ||
        Array.isArray(op)
      ) {
        const err = new Error("context and operation are required");
        err.retcode = 1400;
        throw err;
      }

      const postType = String(ev.post_type || "");
      if (postType === "message") {
        if (op.reply !== undefined && op.reply !== null && op.reply !== "") {
          const autoEscape = Boolean(op.auto_escape);
          if (ev.message_type === "group" && ev.group_id) {
            let replyMessage = op.reply;
            let effectiveAutoEscape = autoEscape;
            if (op.at_sender !== false && ev.user_id) {
              const atSeg = { type: "at", data: { qq: String(ev.user_id) } };
              if (typeof op.reply === "string") {
                const parsed = autoEscape
                  ? [{ type: "text", data: { text: op.reply } }]
                  : parseCqCodeToSegments(op.reply, false);
                replyMessage = [atSeg, ...parsed];
                effectiveAutoEscape = false;
              } else if (Array.isArray(op.reply)) {
                replyMessage = [atSeg, ...op.reply];
              } else if (op.reply && typeof op.reply === "object") {
                replyMessage = [atSeg, op.reply];
              }
            }
            await this._dispatchAction(
              "send_group_msg",
              {
                group_id: ev.group_id,
                message: replyMessage,
                auto_escape: effectiveAutoEscape,
              },
              context
            );
          } else if (ev.user_id) {
            await this._dispatchAction(
              "send_private_msg",
              {
                user_id: ev.user_id,
                ...(ev.group_id ? { group_id: ev.group_id } : {}),
                message: op.reply,
                auto_escape: autoEscape,
              },
              context
            );
          }
        }

        if (op.delete && ev.message_id !== undefined && ev.message_id !== null) {
          await this._dispatchAction("delete_msg", { message_id: ev.message_id }, context);
        }

        if (op.ban && ev.message_type === "group" && ev.group_id && ev.user_id) {
          const duration =
            typeof op.ban_duration === "number" && Number.isFinite(op.ban_duration)
              ? op.ban_duration
              : 1800;
          await this._dispatchAction(
            "set_group_ban",
            {
              group_id: ev.group_id,
              user_id: ev.user_id,
              duration,
            },
            context
          );
        }

        if (op.kick && ev.message_type === "group" && ev.group_id && ev.user_id) {
          await this._dispatchAction(
            "set_group_kick",
            {
              group_id: ev.group_id,
              user_id: ev.user_id,
              reject_add_request: Boolean(op.reject_add_request),
            },
            context
          );
        }
      } else if (postType === "request" && op.approve !== undefined) {
        if (ev.request_type === "friend") {
          await this._dispatchAction(
            "set_friend_add_request",
            {
              flag: String(ev.flag || ""),
              approve: Boolean(op.approve),
              remark: String(op.remark ?? ""),
            },
            context
          );
        } else if (ev.request_type === "group") {
          await this._dispatchAction(
            "set_group_add_request",
            {
              flag: String(ev.flag || ""),
              sub_type: String(ev.sub_type || ev.subType || "add"),
              approve: Boolean(op.approve),
              reason: String(op.reason ?? ""),
            },
            context
          );
        }
      }
      return {};
    }

    default:
      throw new Error(`Unsupported OneBot action: ${action}`);
  }
}

module.exports = {
  HANDLED_ACTIONS,
  dispatch,
};
