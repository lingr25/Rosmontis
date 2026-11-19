"use strict";

/**
 * Inbound Kernel Event Routing, UID Resolution & Per-Peer Concurrency Pipeline (`src/core/inbound_pipeline.js`)
 *
 * Composes `mediaHydratorMixin` (`./media_hydrator`) and `loginRecoveryMixin` (`./login_recovery`)
 * into `inboundPipelineMixin` for seamless attachment onto `NtqqOneBotBridge.prototype`.
 */

const bridgeOnebot = require("../bridge_onebot");
const {
  formatNtMsgToOneBotEvent,
  formatGroupUploadNotice,
  formatNoticeEvent,
  formatRequestEvent,
} = bridgeOnebot;
const { isPrefixedEnvFlagOne } = require("./env");
const { setBoundedMap } = require("./primitives");
const { pickPositiveUin } = require("./nt_normalizer");
const { mediaHydratorMixin, stripTransientMedia } = require("./media_hydrator");
const { loginRecoveryMixin } = require("./login_recovery");

function _isPositiveUin(v) {
  return (
    v != null &&
    v !== "" &&
    typeof v !== "boolean" &&
    !Array.isArray(v) &&
    Number.isFinite(Number(v)) &&
    Number(v) > 0
  );
}

function _pickPositiveUin(...candidates) {
  const picked = pickPositiveUin(...candidates);
  return picked > 0 ? String(picked) : "";
}

function _isRecallMsg(ntMsg) {
  if (!ntMsg || typeof ntMsg !== "object") return false;
  if (ntMsg.recallTime && String(ntMsg.recallTime) !== "0" && Number(ntMsg.recallTime) > 0) {
    return true;
  }
  if (
    Number(ntMsg.msgType) === 5 &&
    Array.isArray(ntMsg.elements) &&
    ntMsg.elements.some((e) => Boolean(e?.grayTipElement?.revokeElement))
  ) {
    return true;
  }
  return false;
}

function _collectTemplParamUids(templParam, out) {
  if (!templParam) return;
  const checkPair = (k, v) => {
    const keyStr = String(k || "");
    if (
      (keyStr === "uid_str1" ||
        keyStr === "uid_str2" ||
        keyStr === "memberUid" ||
        keyStr === "targetUid" ||
        keyStr === "uid") &&
      v != null &&
      v !== ""
    ) {
      out.push(String(v));
    }
  };
  if (templParam instanceof Map) {
    for (const [k, v] of templParam.entries()) {
      checkPair(k, v);
    }
  } else if (Array.isArray(templParam)) {
    for (const entry of templParam) {
      if (Array.isArray(entry) && entry.length >= 2) {
        checkPair(entry[0], entry[1]);
      } else if (entry && typeof entry === "object") {
        checkPair(entry.key ?? entry.k ?? entry.name, entry.value ?? entry.v ?? entry.val);
      }
    }
  } else if (typeof templParam === "object") {
    for (const [k, v] of Object.entries(templParam)) {
      checkPair(k, v);
    }
  }
}

const inboundPipelineMixin = Object.assign({}, mediaHydratorMixin, loginRecoveryMixin, {
  _isPositiveUin(v) {
    return _isPositiveUin(v);
  },

  _isNtReady() {
    if (this.dispatcher !== undefined) {
      return Boolean(this.dispatcher?.ready);
    }
    if (typeof this.rendererExecute === "function") return true;
    if (
      typeof this._canInvokeRenderer === "function" &&
      this._canInvokeRenderer(this.activeWebContents)
    ) {
      return true;
    }
    if (this.capturedServices) {
      const cs = this.capturedServices;
      if (
        cs.ntApi ||
        cs.wrapperSession ||
        cs.ntStore?.wrapperSession ||
        cs.ntStore?.session ||
        cs.ntSessionManager?.ntStore?.wrapperSession ||
        cs.ntSessionManager?.ntStore?.session
      ) {
        return true;
      }
    }
    if (typeof this.ntCall === "function") return true;
    if (
      typeof this.invokeNt === "function" &&
      (!this.capturedServices || Object.prototype.hasOwnProperty.call(this, "invokeNt"))
    ) {
      return true;
    }
    return false;
  },

  _dispatchInboundEvent(ev) {
    if (!ev) return;
    if (typeof this.broadcastOneBotEvent === "function") {
      this.broadcastOneBotEvent(ev);
    } else if (typeof this._dispatchEvent === "function") {
      this._dispatchEvent(ev);
    }
  },

  async _ensureUinForUid(uid) {
    const uidStr = uid != null ? String(uid).trim() : "";
    if (!uidStr || uidStr === "0" || uidStr === "all") return "";
    if (/^\d+$/.test(uidStr) && _isPositiveUin(uidStr)) return uidStr;
    if (!this.uinUidStore) return "";

    const cached = this.uinUidStore.getUinSync?.(uidStr) || "";
    if (_isPositiveUin(cached)) return String(cached);

    if (typeof this.uinUidStore.resolveUin === "function") {
      const invoker =
        typeof this.invokeNt === "function"
          ? this.invokeNt.bind(this)
          : typeof this.ntCall === "function"
          ? (cmd, payload) => {
              const [service, method] = String(cmd).split("/");
              return this.ntCall(service, method, [payload]);
            }
          : undefined;
      try {
        const resolved = await this.uinUidStore.resolveUin(uidStr, invoker);
        if (_isPositiveUin(resolved)) {
          return String(resolved);
        }
      } catch (err) {
        this.logger?.debug?.("inbound", err);
      }
    }
    return "";
  },

  async _resolveNtMsgUids(ntMsg) {
    if (!ntMsg || typeof ntMsg !== "object") return;
    this.uinUidStore?.rememberFromNtMsg?.(ntMsg);

    const pendingByUid = new Map();
    let mutated = false;

    const queueUid = (rawUid, onResolved) => {
      const uidStr = rawUid != null ? String(rawUid).trim() : "";
      if (!uidStr || uidStr === "0" || uidStr === "all") return;
      if (/^\d+$/.test(uidStr) && _isPositiveUin(uidStr)) {
        if (onResolved) {
          onResolved(uidStr);
          mutated = true;
        }
        return;
      }
      const cached = this.uinUidStore?.getUinSync?.(uidStr) || "";
      if (_isPositiveUin(cached)) {
        if (onResolved) {
          onResolved(String(cached));
          mutated = true;
        }
        return;
      }
      if (!pendingByUid.has(uidStr)) {
        pendingByUid.set(uidStr, []);
      }
      if (onResolved) {
        pendingByUid.get(uidStr).push(onResolved);
      }
    };

    if (!_isPositiveUin(ntMsg.senderUin) && ntMsg.senderUid) {
      queueUid(ntMsg.senderUid, (uin) => {
        ntMsg.senderUin = String(uin);
      });
    }

    if (Number(ntMsg.chatType) === 1 && !_isPositiveUin(ntMsg.peerUin) && ntMsg.peerUid) {
      queueUid(ntMsg.peerUid, (uin) => {
        ntMsg.peerUin = String(uin);
      });
    }

    if (Array.isArray(ntMsg.elements)) {
      for (const el of ntMsg.elements) {
        if (!el || typeof el !== "object") continue;

        if (el.textElement) {
          const te = el.textElement;
          if (Number(te.atType) === 2 && te.atNtUid && !_isPositiveUin(te.atUid)) {
            queueUid(te.atNtUid, (uin) => {
              te.atUid = String(uin);
            });
          }
        }

        if (Number(el.elementType) === 8 || el.grayTipElement) {
          const gt = el.grayTipElement;
          if (!gt || typeof gt !== "object") continue;

          if (gt.revokeElement && typeof gt.revokeElement === "object") {
            const rev = gt.revokeElement;
            if (rev.operatorUid && !_isPositiveUin(rev.operatorUin)) {
              queueUid(rev.operatorUid, (uin) => {
                rev.operatorUin = String(uin);
              });
            }
            if (rev.origMsgSenderUid && !_isPositiveUin(rev.origMsgSenderUin)) {
              queueUid(rev.origMsgSenderUid, (uin) => {
                rev.origMsgSenderUin = String(uin);
              });
            }
          }

          if (gt.groupElement && typeof gt.groupElement === "object") {
            const ge = gt.groupElement;
            if (ge.memberUid && !_isPositiveUin(ge.memberUin)) {
              queueUid(ge.memberUid, (uin) => {
                ge.memberUin = String(uin);
              });
            }
            if (ge.adminUid && !_isPositiveUin(ge.adminUin)) {
              queueUid(ge.adminUid, (uin) => {
                ge.adminUin = String(uin);
              });
            }
            if (ge.shutUp?.member?.uid && !_isPositiveUin(ge.shutUp.member.uin)) {
              queueUid(ge.shutUp.member.uid, (uin) => {
                ge.shutUp.member.uin = String(uin);
              });
            }
            if (ge.shutUp?.admin?.uid && !_isPositiveUin(ge.shutUp.admin.uin)) {
              queueUid(ge.shutUp.admin.uid, (uin) => {
                ge.shutUp.admin.uin = String(uin);
              });
            }
            if (ge.adminNotify?.uid && !_isPositiveUin(ge.adminNotify.uin)) {
              queueUid(ge.adminNotify.uid, (uin) => {
                ge.adminNotify.uin = String(uin);
              });
            }
            if (ge.memberTitleNotify?.memberUid && !_isPositiveUin(ge.memberTitleNotify.memberUin)) {
              queueUid(ge.memberTitleNotify.memberUid, (uin) => {
                ge.memberTitleNotify.memberUin = String(uin);
              });
            }
            if (
              ge.memberTitle &&
              typeof ge.memberTitle === "object" &&
              ge.memberTitle.memberUid &&
              !_isPositiveUin(ge.memberTitle.memberUin)
            ) {
              queueUid(ge.memberTitle.memberUid, (uin) => {
                ge.memberTitle.memberUin = String(uin);
              });
            }
            if (ge.targetUid && !_isPositiveUin(ge.targetUin)) {
              queueUid(ge.targetUid, (uin) => {
                ge.targetUin = String(uin);
              });
            }
          }

          if (gt.aioOpGrayTipElement && typeof gt.aioOpGrayTipElement === "object") {
            const ao = gt.aioOpGrayTipElement;
            const fromUid = ao.fromUid || ao.senderUid;
            if (fromUid && !_isPositiveUin(ao.fromUin) && !_isPositiveUin(ao.senderUin)) {
              queueUid(fromUid, (uin) => {
                ao.fromUin = String(uin);
              });
            }
            const targetUid = ao.targetUid || ao.luckyKingUid || ao.memberUid || ao.receiverUid;
            if (targetUid && !_isPositiveUin(ao.targetUin) && !_isPositiveUin(ao.luckyKingUin)) {
              queueUid(targetUid, (uin) => {
                ao.targetUin = String(uin);
              });
            }
          }

          if (gt.buddyElement && typeof gt.buddyElement === "object") {
            const be = gt.buddyElement;
            const buddyUid = be.peerUid || ntMsg.peerUid;
            if (buddyUid && !_isPositiveUin(be.peerUin)) {
              queueUid(buddyUid, (uin) => {
                be.peerUin = String(uin);
              });
            }
          }

          const templUids = [];
          _collectTemplParamUids(gt.xmlElement?.templParam, templUids);
          _collectTemplParamUids(gt.jsonGrayTipElement?.templParam, templUids);
          _collectTemplParamUids(gt.jsonGrayTipElement?.xmlToJsonParam?.templParam, templUids);
          _collectTemplParamUids(gt.aioOpGrayTipElement?.templParam, templUids);
          const rawTipBody = `${gt.xmlElement?.content || ""}\n${gt.jsonGrayTipElement?.jsonStr || ""}`;
          if (rawTipBody.includes("u_")) {
            for (const m of rawTipBody.matchAll(/(?:uid(?:_str\d+)?|memberUid|targetUid|jp|col_uid)"?\s*[:=]\s*"?(u_[A-Za-z0-9_-]+)"?/gi)) {
              if (m[1]) templUids.push(m[1]);
            }
          }
          for (const uidVal of templUids) {
            queueUid(uidVal, null);
          }
        }
      }
    }

    if (pendingByUid.size > 0) {
      await Promise.all(
        Array.from(pendingByUid.entries()).map(async ([uidStr, callbacks]) => {
          const resolvedUin = await this._ensureUinForUid(uidStr);
          if (_isPositiveUin(resolvedUin)) {
            const uinStr = String(resolvedUin);
            for (const cb of callbacks) {
              cb(uinStr);
            }
            if (callbacks.length > 0) {
              mutated = true;
            }
          }
        })
      );
    }

    if (mutated) {
      this.uinUidStore?.rememberFromNtMsg?.(ntMsg);
    }
  },

  _getInboundMediaMaxConcurrent() {
    const raw = Number(this.config?.inboundMediaConcurrency || 4);
    return Number.isFinite(raw) && raw >= 1 ? Math.max(1, Math.trunc(raw)) : 4;
  },

  _acquireInboundMediaSlot() {
    const maxConcurrent = this._getInboundMediaMaxConcurrent();
    if (!Number.isFinite(this._inboundMediaActive) || this._inboundMediaActive < 0) {
      this._inboundMediaActive = 0;
    }
    if (!Array.isArray(this._inboundMediaWaiters)) {
      this._inboundMediaWaiters = [];
    }
    if (this._inboundMediaActive < maxConcurrent) {
      this._inboundMediaActive += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this._inboundMediaWaiters.push(resolve);
    });
  },

  _releaseInboundMediaSlot() {
    if (!Array.isArray(this._inboundMediaWaiters)) {
      this._inboundMediaWaiters = [];
    }
    const maxConcurrent = this._getInboundMediaMaxConcurrent();
    this._inboundMediaActive = Math.max(0, (Number(this._inboundMediaActive) || 1) - 1);
    while (this._inboundMediaActive < maxConcurrent && this._inboundMediaWaiters.length > 0) {
      this._inboundMediaActive += 1;
      const next = this._inboundMediaWaiters.shift();
      next();
    }
  },

  _enqueueInboundNtMessage(ntMsg) {
    if (!ntMsg || typeof ntMsg !== "object") {
      return Promise.resolve();
    }
    if (!(this._inboundPeerChains instanceof Map)) {
      this._inboundPeerChains = new Map();
    }
    const peerChains = this._inboundPeerChains;
    const peerKey = `${ntMsg?.chatType || 0}:${ntMsg?.peerUid || ""}`;
    const prev = peerChains.get(peerKey) || null;

    let chainEntry;
    const taskPromise = (async () => {
      if (prev) {
        await prev;
      }
      await this._acquireInboundMediaSlot();
      try {
        await this._processIncomingNtMessage(ntMsg);
      } finally {
        this._releaseInboundMediaSlot();
      }
    })();

    chainEntry = taskPromise.catch(() => {}).finally(() => {
      if (peerChains.get(peerKey) === chainEntry) {
        peerChains.delete(peerKey);
      }
    });
    peerChains.set(peerKey, chainEntry);
    return taskPromise;
  },

  _handleAddSendMsgEvent(firstArg) {
    const ntMsg = firstArg?.msgRecord || firstArg;
    if (!ntMsg || typeof ntMsg !== "object" || !ntMsg.msgId) return;
    if (this._isDuplicateEvent(`send:${ntMsg.msgId}`)) {
      return;
    }
    this._matchSendEcho(ntMsg);
    this.uinUidStore.rememberFromNtMsg(ntMsg);
    try {
      const ev = formatNtMsgToOneBotEvent(ntMsg, {
        selfId: this.selfUin,
        uinUidStore: this.uinUidStore,
        messageIdStore: this.messageIdStore,
        reportSelfMessage: false,
      });
      if (ev && ev.message_id !== undefined) {
        this.messageIdStore?.indexMsgMedia?.(ntMsg, ev.message_id);
      }
      if (ev && ev.post_type === "message_sent") {
        this._dispatchInboundEvent(ev);
      }
    } finally {
      stripTransientMedia(ntMsg);
    }
  },

  async _handleMsgInfoUpdateEvent(eventName, firstArg) {
    const msgList = Array.isArray(firstArg)
      ? firstArg
      : Array.isArray(firstArg?.msgList)
      ? firstArg.msgList
      : firstArg &&
        typeof firstArg === "object" &&
        (firstArg.msgId || Array.isArray(firstArg.emojiLikesList))
      ? [firstArg]
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

      if (eventName === "onMsgInfoListUpdate" && _isRecallMsg(ntMsg)) {
        const recallTag =
          ntMsg.recallTime && String(ntMsg.recallTime) !== "0"
            ? String(ntMsg.recallTime)
            : "revoke";
        const dedupKey = `recall:${ntMsg.msgId}:${recallTag}`;
        if (!this._isDuplicateEvent(dedupKey)) {
          await this._resolveNtMsgUids(ntMsg);
          try {
            const ev = formatNtMsgToOneBotEvent(ntMsg, {
              selfId: this.selfUin,
              uinUidStore: this.uinUidStore,
              messageIdStore: this.messageIdStore,
            });
            if (ev && ev.post_type === "notice") {
              this._dispatchInboundEvent(ev);
            }
          } finally {
            stripTransientMedia(ntMsg);
          }
        }
        continue;
      }

      await this._resolveNtMsgUids(ntMsg);
      let hit = null;
      let oneBotId = 0;
      try {
        hit =
          this.messageIdStore?.resolveByNtKey?.(ntMsg.chatType, ntMsg.peerUid, ntMsg.msgId) ||
          (ntMsg.msgId ? this.messageIdStore?.getByMsgId?.(ntMsg.msgId) : null) ||
          (ntMsg.peerUid && ntMsg.msgSeq
            ? this.messageIdStore?.getByPeerAndSeq?.(
                ntMsg.chatType,
                ntMsg.peerUid,
                ntMsg.msgSeq
              )
            : null);
        if (hit) {
          if (eventName === "onMsgInfoListUpdate" || Array.isArray(ntMsg.elements)) {
            if (hit.rawMsg !== null && hit.rawMsg !== undefined) {
              hit.rawMsg = ntMsg;
            } else {
              this.messageIdStore?.register?.(
                ntMsg.msgId,
                {
                  chatType: Number(ntMsg.chatType || 1),
                  peerUid: String(ntMsg.peerUid || ""),
                  guildId: String(ntMsg.guildId || ""),
                },
                ntMsg.msgSeq,
                {
                  ...(ntMsg.senderUin ? { senderUin: String(ntMsg.senderUin) } : {}),
                  ...(ntMsg.senderUid ? { senderUid: String(ntMsg.senderUid) } : {}),
                  rawMsg: ntMsg,
                }
              );
            }
          }
          oneBotId = hit.oneBotId ?? hit.shortId;
          if (eventName === "onMsgInfoListUpdate" || Array.isArray(ntMsg.elements)) {
            this.messageIdStore?.indexMsgMedia?.(ntMsg, oneBotId);
          }
        } else if (eventName === "onMsgInfoListUpdate" || Array.isArray(ntMsg.elements)) {
          this.messageIdStore?.indexMsgMedia?.(ntMsg);
        }

        if (Array.isArray(ntMsg.emojiLikesList)) {
          if (!(this._emojiLikesSnapshot instanceof Map)) {
            this._emojiLikesSnapshot = new Map();
          }
          const snapshotKey = String(
            ntMsg.msgId || `${ntMsg.chatType || 0}:${ntMsg.peerUid || ""}:${ntMsg.msgSeq || ""}`
          );
          const likes = ntMsg.emojiLikesList
            .filter((item) => item && typeof item === "object")
            .map((item) => ({
              emoji_id: String(item.emojiId ?? item.emoji_id ?? ""),
              emoji_type: Number(item.emojiType ?? item.emoji_type ?? 1),
              count: Number(item.likesCnt ?? item.count ?? 1),
            }));
          if (likes.length === 0) {
            if (snapshotKey) {
              this._emojiLikesSnapshot.delete(snapshotKey);
            }
          } else {
            const serializedSnapshot = likes
              .map((x) => `${x.emoji_type}:${x.emoji_id}:${x.count}`)
              .sort()
              .join(",");
            const prevSnapshot = snapshotKey
              ? this._emojiLikesSnapshot.get(snapshotKey)
              : undefined;
            if (
              prevSnapshot !== serializedSnapshot ||
              eventName === "onMsgEmojiLikesListChanged"
            ) {
              if (snapshotKey) {
                setBoundedMap(this._emojiLikesSnapshot, snapshotKey, serializedSnapshot, 2000);
              }
              const effectiveChatType = Number(ntMsg.chatType || hit?.peer?.chatType || 0);
              const groupId = pickPositiveUin(
                ntMsg.peerUid,
                ntMsg.peerUin,
                hit?.peer?.peerUid,
                hit?.groupId
              );
              if (effectiveChatType === 2 && groupId > 0) {
                const userId = Number(
                  pickPositiveUin(
                    ntMsg.senderUin,
                    ntMsg.senderUid ? this.uinUidStore?.getUinSync?.(ntMsg.senderUid) : 0,
                    hit?.senderUin,
                    hit?.senderUid ? this.uinUidStore?.getUinSync?.(hit.senderUid) : 0
                  ) || 0
                );
                this._dispatchInboundEvent(
                  formatNoticeEvent(
                    "group_msg_emoji_like",
                    {
                      group_id: groupId,
                      user_id: userId,
                      message_id: Number(oneBotId || 0),
                      likes,
                    },
                    { selfId: this.selfUin }
                  )
                );
              }
            }
          }
        }
      } finally {
        stripTransientMedia(ntMsg);
      }
    }
  },

  async _handleGroupNotifiesUpdatedEvent(args, firstArg) {
    const doubt =
      typeof args[0] === "boolean"
        ? args[0]
        : typeof firstArg?.doubt === "boolean"
        ? firstArg.doubt
        : false;
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
      const groupId = pickPositiveUin(item.group?.groupCode);
      const flag = seq ? `${seq}:${notifyType}:${groupId}` : "";
      const cachedItem =
        typeof item.doubt === "boolean" ? item : { ...item, doubt: Boolean(doubt) };
      if (flag) setBoundedMap(this._groupNotifiesCache, flag, cachedItem);

      if (item.user1?.uid && _isPositiveUin(item.user1?.uin)) {
        this.uinUidStore?.remember?.(item.user1.uin, item.user1.uid, {
          nickname: item.user1.nickName || "",
        });
      }
      if (item.user2?.uid && _isPositiveUin(item.user2?.uin)) {
        this.uinUidStore?.remember?.(item.user2.uin, item.user2.uid, {
          nickname: item.user2.nickName || "",
        });
      }

      // status === 1 means pending approval
      if (status === 1 && (notifyType === 1 || notifyType === 2 || notifyType === 7)) {
        const dedupKey = `group_req:${flag}`;
        if (this._isDuplicateEvent(dedupKey)) continue;
        const userUid = item.user1?.uid || "";
        const resolvedUser1Uin =
          _pickPositiveUin(item.user1?.uin) || (await this._ensureUinForUid(userUid));
        if (_isPositiveUin(resolvedUser1Uin) && item.user1) {
          item.user1.uin = String(resolvedUser1Uin);
        }
        if (item.user2?.uid && !_isPositiveUin(item.user2?.uin)) {
          const resolvedUser2Uin = await this._ensureUinForUid(item.user2.uid);
          if (_isPositiveUin(resolvedUser2Uin)) {
            item.user2.uin = String(resolvedUser2Uin);
          }
        }
        const userUin = _isPositiveUin(resolvedUser1Uin) ? Number(resolvedUser1Uin) : 0;
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
        this._dispatchInboundEvent(ev);
      }
    }
  },

  async _handleBuddyReqChangeEvent(firstArg) {
    const reqs = Array.isArray(firstArg?.buddyReqs)
      ? firstArg.buddyReqs
      : Array.isArray(firstArg)
      ? firstArg
      : [];
    for (const req of reqs) {
      if (!req || typeof req !== "object") continue;
      if (req.isDecide || Number(req.reqType) !== 1) continue;
      const rawFriendUid = String(req.friendUid || "");
      const positiveReqUin = _pickPositiveUin(req.friendUin);
      const friendUid = rawFriendUid || positiveReqUin;
      const reqExtra = String(req.reqTime || req.flag || req.postscript || req.extWords || "0");
      const flag = `${friendUid}:${reqExtra}`;
      setBoundedMap(this._buddyReqsCache, flag, req);
      const dedupKey = `friend_req:${friendUid}:${req.reqTime || req.flag || req.postscript || req.extWords || ""}`;
      if (this._isDuplicateEvent(dedupKey)) continue;
      const resolvedUin =
        positiveReqUin || (await this._ensureUinForUid(rawFriendUid || friendUid));
      if (_isPositiveUin(resolvedUin)) {
        req.friendUin = String(resolvedUin);
        if (rawFriendUid) {
          this.uinUidStore?.remember?.(resolvedUin, rawFriendUid, {
            nickname: req.friendNick || "",
          });
        }
      }
      const userUin = _isPositiveUin(resolvedUin) ? Number(resolvedUin) : 0;
      const ev = formatRequestEvent(
        "friend",
        {
          user_id: userUin,
          comment: String(req.extWords || ""),
          flag,
        },
        { selfId: this.selfUin }
      );
      this._dispatchInboundEvent(ev);
    }
  },

  _handleBuddyListChangeEvent(firstArg) {
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
      } catch (err) {
        this.logger?.debug?.("inbound", err);
      }
    }
  },

  _handleProfileSimpleChangedEvent(firstArg) {
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
      const uin = _pickPositiveUin(core.uin, info.uin);
      this.uinUidStore.remember(uin, core.uid || info.uid || uidKey, {
        nickname: core.nick || info.nick || "",
        remark: core.remark || info.remark || "",
      });
    }
  },

  _handleProfileDetailInfoChangedEvent(firstArg) {
    const info = firstArg?.info || firstArg;
    if (!info || typeof info !== "object") return;
    const simple = info.simpleInfo || info;
    const core = simple.coreInfo || simple.baseInfo || info.coreInfo || info.baseInfo || info;
    const uid = String(info.uid || simple.uid || core.uid || "");
    const uin = _pickPositiveUin(info.uin, simple.uin, core.uin);
    if (uid || uin) {
      this.uinUidStore.remember(uin, uid, {
        nickname: core.nick || info.nick || "",
        remark: core.remark || info.remark || "",
      });
    }
    if (uid && this._profileDetailWaiters instanceof Map) {
      const waiters = this._profileDetailWaiters.get(uid);
      if (waiters) {
        this._profileDetailWaiters.delete(uid);
        for (const resolve of Array.from(waiters)) {
          try {
            resolve(info);
          } catch (err) {
            this.logger?.debug?.("inbound", err);
          }
        }
      }
    }
  },

  _handleDoubtBuddyReqChangeEvent(firstArg) {
    if (!this._doubtBuddyWaiters) return;
    for (const waiter of Array.from(this._doubtBuddyWaiters)) {
      try {
        waiter(firstArg);
      } catch (err) {
        this.logger?.debug?.("inbound", err);
      }
    }
  },

  _handleGroupListUpdateEvent(args, firstArg) {
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
        setBoundedMap(this._groupListCache, gid, g);
      }
    }
    for (const waiter of Array.from(this._groupListWaiters)) {
      try {
        waiter(groupList);
      } catch (err) {
        this.logger?.debug?.("inbound", err);
      }
    }
  },

  async _handleMemberInfoChangeEvent(args, firstArg) {
    const rawObj = firstArg && typeof firstArg === "object" ? firstArg : null;
    const groupCode = String(
      (rawObj
        ? rawObj.groupCode ?? rawObj.groupUin ?? rawObj.group_id ?? ""
        : firstArg) || ""
    );
    const members =
      args[2] ||
      args[1] ||
      (rawObj
        ? rawObj.members ??
          rawObj.infos ??
          rawObj.result?.infos ??
          (rawObj.cardName !== undefined ||
          rawObj.cardNew !== undefined ||
          rawObj.card_new !== undefined
            ? [rawObj]
            : null)
        : null);
    if (!groupCode || !members) return;

    this.uinUidStore.rememberFromGroupMemberList(groupCode, members);

    const groupId = pickPositiveUin(groupCode);
    if (groupId <= 0) return;

    if (!(this._memberCardCache instanceof Map)) {
      this._memberCardCache = new Map();
    }
    let infos = members;
    if (members && typeof members === "object") {
      if (members.result && members.result.infos) {
        infos = members.result.infos;
      } else if (members.infos) {
        infos = members.infos;
      }
    }
    const entries =
      infos instanceof Map
        ? Array.from(infos.entries())
        : Array.isArray(infos)
        ? infos.map((m, idx) => [m?.uid || String(idx), m])
        : infos && typeof infos === "object"
        ? Object.entries(infos)
        : [];
    const explicitBatchCardChange = Boolean(
      args[1] === "card" ||
        rawObj?.changeType === "card" ||
        rawObj?.subType === "card" ||
        rawObj?.sub_type === "card"
    );

    for (const [entryKey, m] of entries) {
      if (!m || typeof m !== "object") continue;
      const hasCardField =
        m.cardName !== undefined ||
        m.card !== undefined ||
        m.memberCard !== undefined ||
        m.cardNew !== undefined ||
        m.card_new !== undefined;
      if (!hasCardField) continue;

      const cardNew = String(
        m.cardName ?? m.cardNew ?? m.card_new ?? m.card ?? m.memberCard?.memberCard ?? ""
      );
      const uid = String(
        m.uid || (typeof entryKey === "string" && entryKey.startsWith("u_") ? entryKey : "") || ""
      );
      let uin = pickPositiveUin(
        m.uin,
        m.user_id,
        uid ? this.uinUidStore?.getUinSync?.(uid) : 0,
        typeof entryKey === "string" && /^\d+$/.test(entryKey) ? entryKey : 0
      );

      const uinCacheKey = uin > 0 ? `${groupId}:${uin}` : "";
      const uidCacheKey = uid ? `${groupId}:${uid}` : "";
      const existingKey =
        (uinCacheKey && this._memberCardCache.has(uinCacheKey) ? uinCacheKey : "") ||
        (uidCacheKey && this._memberCardCache.has(uidCacheKey) ? uidCacheKey : "");
      const hasExplicitOld =
        m.cardOld !== undefined || m.card_old !== undefined || m.oldCardName !== undefined;

      if (existingKey) {
        const cardOld = String(this._memberCardCache.get(existingKey) ?? "");
        if (!uin && uid) {
          const resolved = await this._ensureUinForUid(uid);
          uin = pickPositiveUin(resolved);
        }
        const targetCacheKey = uin > 0 ? `${groupId}:${uin}` : existingKey;
        if (existingKey !== targetCacheKey) {
          this._memberCardCache.delete(existingKey);
        }
        setBoundedMap(this._memberCardCache, targetCacheKey, cardNew, 5000);
        if (cardNew !== cardOld && uin > 0) {
          this._dispatchInboundEvent(
            formatNoticeEvent(
              "group_card",
              {
                group_id: Number(groupId),
                user_id: uin,
                card_new: cardNew,
                card_old: cardOld,
              },
              { selfId: this.selfUin }
            )
          );
        }
      } else {
        if ((hasExplicitOld || explicitBatchCardChange) && !uin && uid) {
          const resolved = await this._ensureUinForUid(uid);
          uin = pickPositiveUin(resolved);
        }
        const targetCacheKey = uin > 0 ? `${groupId}:${uin}` : uidCacheKey;
        if (targetCacheKey) {
          setBoundedMap(this._memberCardCache, targetCacheKey, cardNew, 5000);
        }
        if ((hasExplicitOld || explicitBatchCardChange) && uin > 0) {
          const cardOld = hasExplicitOld
            ? String(m.cardOld ?? m.card_old ?? m.oldCardName ?? "")
            : "";
          if (!hasExplicitOld || cardNew !== cardOld) {
            this._dispatchInboundEvent(
              formatNoticeEvent(
                "group_card",
                {
                  group_id: Number(groupId),
                  user_id: uin,
                  card_new: cardNew,
                  card_old: cardOld,
                },
                { selfId: this.selfUin }
              )
            );
          }
        }
      }
    }
  },

  async _handleKernelEvent(_listenerName, eventName, args) {
    const firstArg = args && args.length > 0 ? args[0] : undefined;

    // 1. Incoming messages: onRecvMsg / onRecvActiveMsg
    if (eventName === "onRecvMsg" || eventName === "onRecvActiveMsg") {
      const msgList = Array.isArray(firstArg)
        ? firstArg
        : Array.isArray(firstArg?.msgList)
        ? firstArg.msgList
        : [];
      if (msgList.length > 0) {
        const tasksForThisBatch = msgList.map((ntMsg) => this._enqueueInboundNtMessage(ntMsg));
        await Promise.all(tasksForThisBatch);
      }
      return;
    }

    // 2. Self-sent message confirmation: onAddSendMsg
    if (eventName === "onAddSendMsg") {
      this._handleAddSendMsgEvent(firstArg);
      return;
    }

    // 3. Message updates (recalls, PTT transcription completion, emoji likes, async media updates)
    if (eventName === "onMsgInfoListUpdate" || eventName === "onMsgEmojiLikesListChanged") {
      await this._handleMsgInfoUpdateEvent(eventName, firstArg);
      return;
    }

    // 4. Group notifications (join/invite requests)
    if (eventName === "onGroupNotifiesUpdated") {
      await this._handleGroupNotifiesUpdatedEvent(args, firstArg);
      return;
    }

    // 5. Friend requests: onBuddyReqChange
    if (eventName === "onBuddyReqChange") {
      await this._handleBuddyReqChangeEvent(firstArg);
      return;
    }

    // 6. Buddy list change (V1 & V2), Profile changes, Doubt buddy reqs & RichMedia download complete
    if (eventName === "onBuddyListChange" || eventName === "onBuddyListChangedV2") {
      this._handleBuddyListChangeEvent(firstArg);
      return;
    }
    if (eventName === "onProfileSimpleChanged") {
      this._handleProfileSimpleChangedEvent(firstArg);
      return;
    }
    if (eventName === "onProfileDetailInfoChanged") {
      this._handleProfileDetailInfoChangedEvent(firstArg);
      return;
    }
    if (eventName === "onDoubtBuddyReqChange") {
      this._handleDoubtBuddyReqChangeEvent(firstArg);
      return;
    }
    if (eventName === "onRichMediaDownloadComplete") {
      this._handleRichMediaDownloadComplete(firstArg);
      return;
    }

    // 7. Group list update
    if (eventName === "onGroupListUpdate") {
      this._handleGroupListUpdateEvent(args, firstArg);
      return;
    }

    // 8. Group member info change
    if (eventName === "onMemberInfoChange") {
      await this._handleMemberInfoChangeEvent(args, firstArg);
      return;
    }

    // 9. Login / QR / Session / Offline (delegated to loginRecoveryMixin)
    this._handleLoginKernelEvent(eventName, args);
  },

  async _processIncomingNtMessage(ntMsg) {
    if (!ntMsg || typeof ntMsg !== "object") return;
    const msgId = String(ntMsg.msgId || "");
    if (msgId && this._isDuplicateEvent(`msg:${msgId}`)) {
      return;
    }

    await this._resolveNtMsgUids(ntMsg);
    await this._hydrateNtMsgMedia(ntMsg);

    try {
      const ev = formatNtMsgToOneBotEvent(ntMsg, {
        selfId: this.selfUin,
        uinUidStore: this.uinUidStore,
        messageIdStore: this.messageIdStore,
      });
      if (ev && ev.message_id !== undefined) {
        this.messageIdStore?.indexMsgMedia?.(ntMsg, ev.message_id);
      }
      if (ev) {
        this._dispatchInboundEvent(ev);
      }

      const uploadNotice = formatGroupUploadNotice(ntMsg, {
        selfId: this.selfUin,
        uinUidStore: this.uinUidStore,
      });
      if (uploadNotice) {
        this._dispatchInboundEvent(uploadNotice);
      }
    } finally {
      stripTransientMedia(ntMsg);
    }

    const autoReadAndType =
      Boolean(this.config && this.config.autoReadAndTypeOnPrivateRecv === true) ||
      isPrefixedEnvFlagOne("AUTO_READ_AND_TYPE_ON_PRIVATE_RECV");
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
          }).catch((err) => {
            this.logger?.debug?.("inbound", err);
          })
      );
    }
  },
});

module.exports = {
  inboundPipelineMixin,
  mediaHydratorMixin,
  loginRecoveryMixin,
  _isPositiveUin,
};
