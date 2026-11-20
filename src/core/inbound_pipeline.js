// @ts-check
"use strict";

/**
 * Inbound Kernel Event Routing, UID Resolution & Per-Peer Concurrency Pipeline (`src/core/inbound_pipeline.js`)
 *
 * Composed controller (`InboundPipeline`) coordinating incoming NTQQ kernel events,
 * per-peer causal message ordering with bounded cross-peer media hydration concurrency,
 * UID->UIN resolution, `mediaHydratorMixin` (`./media_hydrator`), and
 * `loginRecoveryMixin` (`./login_recovery`).
 */

const bridgeOnebot = require("../bridge_onebot");
const {
  formatNtMsgToOneBotEvent,
  formatGroupUploadNotice,
  formatNoticeEvent,
  formatRequestEvent,
} = bridgeOnebot;
const { isPrefixedEnvFlagOne } = require("./env");
const { BoundedMap, setBoundedMap } = require("./primitives");
const { pickPositiveUin } = require("./nt_normalizer");
const { mediaHydratorMixin, stripTransientMedia } = require("./media_hydrator");
const { loginRecoveryMixin } = require("./login_recovery");

/**
 * @param {any} v
 * @returns {boolean}
 */
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

/**
 * @param {...any} candidates
 * @returns {string}
 */
function _pickPositiveUin(...candidates) {
  const picked = pickPositiveUin(...candidates);
  return picked > 0 ? String(picked) : "";
}

/**
 * @param {any} ntMsg
 * @returns {boolean}
 */
function _isRecallMsg(ntMsg) {
  if (!ntMsg || typeof ntMsg !== "object") return false;
  if (ntMsg.recallTime && String(ntMsg.recallTime) !== "0" && Number(ntMsg.recallTime) > 0) {
    return true;
  }
  if (
    Number(ntMsg.msgType) === 5 &&
    Array.isArray(ntMsg.elements) &&
    ntMsg.elements.some((/** @type {any} */ e) => Boolean(e?.grayTipElement?.revokeElement))
  ) {
    return true;
  }
  return false;
}

/**
 * @param {any} templParam
 * @param {string[]} out
 */
function _collectTemplParamUids(templParam, out) {
  if (!templParam) return;
  const checkPair = (/** @type {any} */ k, /** @type {any} */ v) => {
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

const LEGACY_INBOUND_CTRL_SYM = Symbol("rosmontisLegacyInboundPipeline");
const LEGACY_INBOUND_STATE_KEYS = Object.freeze([
  "_pttTextWaiters",
  "_richMediaWaiters",
  "_groupNotifiesCache",
  "_buddyReqsCache",
  "_groupListCache",
  "_buddyCategoriesCache",
  "_groupListWaiters",
  "_qrCodeWaiters",
  "_buddyListWaiters",
  "_profileDetailWaiters",
  "_doubtBuddyWaiters",
  "_recentSentMsgByPeer",
  "_inboundMediaActive",
  "_inboundMediaWaiters",
  "_inboundPeerChains",
  "_emojiLikesSnapshot",
  "_memberCardCache",
  "_autoQuickLoginAttempts",
  "_lastAutoQuickLoginAt",
]);

/**
 * Composed inbound kernel event routing, media hydration & login recovery pipeline.
 */
class InboundPipeline {
  /**
   * @param {any} [bridge]
   */
  constructor(bridge = {}) {
    /** @type {any} */
    this.bridge = bridge || {};
    /** @type {Map<string, any>} */
    this._pttTextWaiters =
      Object.prototype.hasOwnProperty.call(this.bridge, "_pttTextWaiters") &&
      this.bridge._pttTextWaiters instanceof Map
        ? this.bridge._pttTextWaiters
        : new Map();
    /** @type {Map<string, Set<any>>} */
    this._richMediaWaiters =
      Object.prototype.hasOwnProperty.call(this.bridge, "_richMediaWaiters") &&
      this.bridge._richMediaWaiters instanceof Map
        ? this.bridge._richMediaWaiters
        : new Map();
    /** @type {Map<string, any>} */
    this._groupNotifiesCache =
      Object.prototype.hasOwnProperty.call(this.bridge, "_groupNotifiesCache") &&
      this.bridge._groupNotifiesCache instanceof Map
        ? this.bridge._groupNotifiesCache
        : new BoundedMap(2000);
    /** @type {Map<string, any>} */
    this._buddyReqsCache =
      Object.prototype.hasOwnProperty.call(this.bridge, "_buddyReqsCache") &&
      this.bridge._buddyReqsCache instanceof Map
        ? this.bridge._buddyReqsCache
        : new BoundedMap(2000);
    /** @type {Map<string, any>} */
    this._groupListCache =
      Object.prototype.hasOwnProperty.call(this.bridge, "_groupListCache") &&
      this.bridge._groupListCache instanceof Map
        ? this.bridge._groupListCache
        : new BoundedMap(2000);
    /** @type {any[]} */
    this._buddyCategoriesCache =
      Object.prototype.hasOwnProperty.call(this.bridge, "_buddyCategoriesCache") &&
      Array.isArray(this.bridge._buddyCategoriesCache)
        ? this.bridge._buddyCategoriesCache
        : [];
    /** @type {Set<any>} */
    this._groupListWaiters =
      Object.prototype.hasOwnProperty.call(this.bridge, "_groupListWaiters") &&
      this.bridge._groupListWaiters instanceof Set
        ? this.bridge._groupListWaiters
        : new Set();
    /** @type {Set<any>} */
    this._qrCodeWaiters =
      Object.prototype.hasOwnProperty.call(this.bridge, "_qrCodeWaiters") &&
      this.bridge._qrCodeWaiters instanceof Set
        ? this.bridge._qrCodeWaiters
        : new Set();
    /** @type {Set<any>} */
    this._buddyListWaiters =
      Object.prototype.hasOwnProperty.call(this.bridge, "_buddyListWaiters") &&
      this.bridge._buddyListWaiters instanceof Set
        ? this.bridge._buddyListWaiters
        : new Set();
    /** @type {Map<string, Set<any>>} */
    this._profileDetailWaiters =
      Object.prototype.hasOwnProperty.call(this.bridge, "_profileDetailWaiters") &&
      this.bridge._profileDetailWaiters instanceof Map
        ? this.bridge._profileDetailWaiters
        : new Map();
    /** @type {Set<any>} */
    this._doubtBuddyWaiters =
      Object.prototype.hasOwnProperty.call(this.bridge, "_doubtBuddyWaiters") &&
      this.bridge._doubtBuddyWaiters instanceof Set
        ? this.bridge._doubtBuddyWaiters
        : new Set();
    /** @type {Map<string, any>} */
    this._recentSentMsgByPeer =
      Object.prototype.hasOwnProperty.call(this.bridge, "_recentSentMsgByPeer") &&
      this.bridge._recentSentMsgByPeer instanceof Map
        ? this.bridge._recentSentMsgByPeer
        : new BoundedMap(2000);
    /** @type {number} */
    this._inboundMediaActive = Object.prototype.hasOwnProperty.call(
      this.bridge,
      "_inboundMediaActive"
    )
      ? Number(this.bridge._inboundMediaActive) || 0
      : 0;
    /** @type {Array<() => void>} */
    this._inboundMediaWaiters =
      Object.prototype.hasOwnProperty.call(this.bridge, "_inboundMediaWaiters") &&
      Array.isArray(this.bridge._inboundMediaWaiters)
        ? this.bridge._inboundMediaWaiters
        : [];
    /** @type {Map<string, Promise<void>>} */
    this._inboundPeerChains =
      Object.prototype.hasOwnProperty.call(this.bridge, "_inboundPeerChains") &&
      this.bridge._inboundPeerChains instanceof Map
        ? this.bridge._inboundPeerChains
        : new Map();
    /** @type {Map<string, string>} */
    this._emojiLikesSnapshot =
      Object.prototype.hasOwnProperty.call(this.bridge, "_emojiLikesSnapshot") &&
      this.bridge._emojiLikesSnapshot instanceof Map
        ? this.bridge._emojiLikesSnapshot
        : new Map();
    /** @type {Map<string, string>} */
    this._memberCardCache =
      Object.prototype.hasOwnProperty.call(this.bridge, "_memberCardCache") &&
      this.bridge._memberCardCache instanceof Map
        ? this.bridge._memberCardCache
        : new Map();
    /** @type {number} */
    this._autoQuickLoginAttempts = Object.prototype.hasOwnProperty.call(
      this.bridge,
      "_autoQuickLoginAttempts"
    )
      ? Number(this.bridge._autoQuickLoginAttempts) || 0
      : 0;
    /** @type {number} */
    this._lastAutoQuickLoginAt = Object.prototype.hasOwnProperty.call(
      this.bridge,
      "_lastAutoQuickLoginAt"
    )
      ? Number(this.bridge._lastAutoQuickLoginAt) || 0
      : 0;
  }

  /** @returns {any} */
  get config() {
    return this.bridge.config;
  }

  /** @returns {any} */
  get logger() {
    return this.bridge.logger;
  }

  /** @returns {any} */
  get messageIdStore() {
    return this.bridge.messageIdStore;
  }

  /** @returns {any} */
  get uinUidStore() {
    return this.bridge.uinUidStore;
  }

  /** @returns {string} */
  get selfUin() {
    return this.bridge.selfUin;
  }

  /** @param {string} v */
  set selfUin(v) {
    this.bridge.selfUin = v;
  }

  /** @returns {string} */
  get selfUid() {
    return this.bridge.selfUid;
  }

  /** @param {string} v */
  set selfUid(v) {
    this.bridge.selfUid = v;
  }

  /** @returns {string} */
  get selfNickname() {
    return this.bridge.selfNickname;
  }

  /** @param {string} v */
  set selfNickname(v) {
    this.bridge.selfNickname = v;
  }

  /** @returns {boolean} */
  get online() {
    return Boolean(this.bridge.online);
  }

  /** @param {boolean} v */
  set online(v) {
    this.bridge.online = Boolean(v);
  }

  /** @returns {string} */
  get lastQrCodeBase64() {
    return this.bridge.lastQrCodeBase64;
  }

  /** @param {string} v */
  set lastQrCodeBase64(v) {
    this.bridge.lastQrCodeBase64 = v;
  }

  /** @returns {any} */
  get activeWebContents() {
    return this.bridge.activeWebContents;
  }

  /** @returns {any} */
  get capturedServices() {
    return this.bridge.capturedServices;
  }

  /** @returns {any} */
  get rendererExecute() {
    return this.bridge.rendererExecute;
  }

  /** @returns {any} */
  get ntCall() {
    return this.bridge.ntCall;
  }

  /**
   * @param {string} cmd
   * @param {any} [payload]
   * @param {any[] | null} [positionalArgs]
   * @param {any} [invokeOptions]
   */
  invokeNt(cmd, payload, positionalArgs, invokeOptions) {
    return this.bridge.invokeNt?.(cmd, payload, positionalArgs, invokeOptions);
  }

  /** @param {Record<string, any>} [identity] */
  _updateSelfIdentity(identity) {
    return this.bridge._updateSelfIdentity?.(identity);
  }

  /** @param {Record<string, any>} [opts] */
  _resetHumanSessionState(opts) {
    return this.bridge._resetHumanSessionState?.(opts);
  }

  /** @param {any} wc */
  _isWebContentsAlive(wc) {
    if (typeof this.bridge._isWebContentsAlive === "function") {
      return this.bridge._isWebContentsAlive(wc);
    }
    return Boolean(wc && (typeof wc.isDestroyed !== "function" || !wc.isDestroyed()));
  }

  /** @param {any} url */
  _isTrustedRendererUrl(url) {
    if (typeof this.bridge._isTrustedRendererUrl === "function") {
      return this.bridge._isTrustedRendererUrl(url);
    }
    return true;
  }

  /** @param {any} v */
  _isPositiveUin(v) {
    return _isPositiveUin(v);
  }

  /** @returns {boolean} */
  _isNtReady() {
    const b = this.bridge;
    if (b.dispatcher !== undefined) {
      return Boolean(b.dispatcher?.ready);
    }
    if (typeof b.rendererExecute === "function") return true;
    if (
      typeof b._canInvokeRenderer === "function" &&
      b._canInvokeRenderer(b.activeWebContents)
    ) {
      return true;
    }
    if (b.capturedServices) {
      const cs = b.capturedServices;
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
    if (typeof b.ntCall === "function") return true;
    if (
      typeof b.invokeNt === "function" &&
      (!b.capturedServices || Object.prototype.hasOwnProperty.call(b, "invokeNt"))
    ) {
      return true;
    }
    return false;
  }

  /** @param {any} ev */
  _dispatchInboundEvent(ev) {
    if (!ev) return;
    if (typeof this.bridge.broadcastOneBotEvent === "function") {
      this.bridge.broadcastOneBotEvent(ev);
    } else if (typeof this.bridge._dispatchEvent === "function") {
      this.bridge._dispatchEvent(ev);
    }
  }

  /**
   * @param {any} uid
   * @returns {Promise<string>}
   */
  async _ensureUinForUid(uid) {
    const uidStr = uid != null ? String(uid).trim() : "";
    if (!uidStr || uidStr === "0" || uidStr === "all") return "";
    if (/^\d+$/.test(uidStr) && _isPositiveUin(uidStr)) return uidStr;
    if (!this.uinUidStore) return "";

    const cached = this.uinUidStore.getUinSync?.(uidStr) || "";
    if (_isPositiveUin(cached)) return String(cached);

    if (typeof this.uinUidStore.resolveUin === "function") {
      const invoker =
        typeof this.bridge.invokeNt === "function"
          ? this.bridge.invokeNt.bind(this.bridge)
          : typeof this.bridge.ntCall === "function"
          ? (/** @type {string} */ cmd, /** @type {any} */ payload) => {
              const [service, method] = String(cmd).split("/");
              return this.bridge.ntCall(service, method, [payload]);
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
  }

  /** @param {any} ntMsg */
  async _resolveNtMsgUids(ntMsg) {
    if (!ntMsg || typeof ntMsg !== "object") return;
    this.uinUidStore?.rememberFromNtMsg?.(ntMsg);

    /** @type {Map<string, Array<(uin: string) => void>>} */
    const pendingByUid = new Map();
    let mutated = false;

    /**
     * @param {any} rawUid
     * @param {((uin: string) => void) | null} onResolved
     */
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
        pendingByUid.get(uidStr)?.push(onResolved);
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

          /** @type {string[]} */
          const templUids = [];
          _collectTemplParamUids(gt.xmlElement?.templParam, templUids);
          _collectTemplParamUids(gt.jsonGrayTipElement?.templParam, templUids);
          _collectTemplParamUids(gt.jsonGrayTipElement?.xmlToJsonParam?.templParam, templUids);
          _collectTemplParamUids(gt.aioOpGrayTipElement?.templParam, templUids);
          const rawTipBody = `${gt.xmlElement?.content || ""}\n${gt.jsonGrayTipElement?.jsonStr || ""}`;
          if (rawTipBody.includes("u_")) {
            for (const m of rawTipBody.matchAll(
              /(?:uid(?:_str\d+)?|memberUid|targetUid|jp|col_uid)"?\s*[:=]\s*"?(u_[A-Za-z0-9_-]+)"?/gi
            )) {
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
  }

  _getInboundMediaMaxConcurrent() {
    const raw = Number(this.config?.inboundMediaConcurrency || 4);
    return Number.isFinite(raw) && raw >= 1 ? Math.max(1, Math.trunc(raw)) : 4;
  }

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
      this._inboundMediaWaiters.push(() => resolve(undefined));
    });
  }

  _releaseInboundMediaSlot() {
    if (!Array.isArray(this._inboundMediaWaiters)) {
      this._inboundMediaWaiters = [];
    }
    const maxConcurrent = this._getInboundMediaMaxConcurrent();
    this._inboundMediaActive = Math.max(0, (Number(this._inboundMediaActive) || 1) - 1);
    while (this._inboundMediaActive < maxConcurrent && this._inboundMediaWaiters.length > 0) {
      this._inboundMediaActive += 1;
      const next = this._inboundMediaWaiters.shift();
      next?.();
    }
  }

  /**
   * @param {any} ntMsg
   * @returns {Promise<void>}
   */
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

    /** @type {Promise<void>} */
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

    chainEntry = taskPromise
      .catch((err) => {
        this.logger?.debug?.("inbound", err);
      })
      .finally(() => {
        if (peerChains.get(peerKey) === chainEntry) {
          peerChains.delete(peerKey);
        }
      });
    peerChains.set(peerKey, chainEntry);
    return taskPromise;
  }

  /** @param {any} firstArg */
  _handleAddSendMsgEvent(firstArg) {
    const ntMsg = firstArg?.msgRecord || firstArg;
    if (!ntMsg || typeof ntMsg !== "object" || !ntMsg.msgId) return;
    if (this.bridge._isDuplicateEvent?.(`send:${ntMsg.msgId}`)) {
      return;
    }
    this.bridge._matchSendEcho?.(ntMsg);
    this.uinUidStore?.rememberFromNtMsg?.(ntMsg);
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
  }

  /**
   * @param {string} eventName
   * @param {any} firstArg
   */
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
        const pttEl = ntMsg.elements.find(
          (/** @type {any} */ e) => e?.elementType === 4 && e.pttElement
        )?.pttElement;
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
        if (!this.bridge._isDuplicateEvent?.(dedupKey)) {
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

      // Deduplicate identical main + renderer-forwarded msg info update deliveries
      // within a short window to avoid redundant UID lookups and store churn during
      // bulk history fetches across many groups.
      if (ntMsg.msgId) {
        const emojiSig = Array.isArray(ntMsg.emojiLikesList)
          ? ntMsg.emojiLikesList
              .filter((/** @type {any} */ item) => item && typeof item === "object")
              .map(
                (/** @type {any} */ item) =>
                  `${Number(item.emojiType ?? item.emoji_type ?? 1)}:${String(
                    item.emojiId ?? item.emoji_id ?? ""
                  )}:${Number(item.likesCnt ?? item.count ?? 1)}`
              )
              .sort()
              .join(",")
          : "";
        const elCount = Array.isArray(ntMsg.elements) ? ntMsg.elements.length : 0;
        const updateKey = `msgu:${eventName}:${ntMsg.msgId}:${ntMsg.msgSeq || 0}:${
          ntMsg.recallTime || 0
        }:${elCount}:${emojiSig}`;
        if (this.bridge._isDuplicateEvent?.(updateKey, 3000)) {
          continue;
        }
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
            .filter((/** @type {any} */ item) => item && typeof item === "object")
            .map((/** @type {any} */ item) => ({
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
              .map((/** @type {any} */ x) => `${x.emoji_type}:${x.emoji_id}:${x.count}`)
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
  }

  /**
   * @param {any[]} args
   * @param {any} firstArg
   */
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
        if (this.bridge._isDuplicateEvent?.(dedupKey)) continue;
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
  }

  /** @param {any} firstArg */
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
      if (this.bridge._isDuplicateEvent?.(dedupKey)) continue;
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
  }

  /** @param {any} firstArg */
  _handleBuddyListChangeEvent(firstArg) {
    this.uinUidStore?.rememberFromBuddyList?.(firstArg);
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
  }

  /** @param {any} firstArg */
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
      this.uinUidStore?.remember?.(uin, core.uid || info.uid || uidKey, {
        nickname: core.nick || info.nick || "",
        remark: core.remark || info.remark || "",
      });
    }
  }

  /** @param {any} firstArg */
  _handleProfileDetailInfoChangedEvent(firstArg) {
    const info = firstArg?.info || firstArg;
    if (!info || typeof info !== "object") return;
    const simple = info.simpleInfo || info;
    const core = simple.coreInfo || simple.baseInfo || info.coreInfo || info.baseInfo || info;
    const uid = String(info.uid || simple.uid || core.uid || "");
    const uin = _pickPositiveUin(info.uin, simple.uin, core.uin);
    if (uid || uin) {
      this.uinUidStore?.remember?.(uin, uid, {
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
  }

  /** @param {any} firstArg */
  _handleDoubtBuddyReqChangeEvent(firstArg) {
    if (!this._doubtBuddyWaiters) return;
    for (const waiter of Array.from(this._doubtBuddyWaiters)) {
      try {
        waiter(firstArg);
      } catch (err) {
        this.logger?.debug?.("inbound", err);
      }
    }
  }

  /**
   * @param {any[]} args
   * @param {any} firstArg
   */
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
  }

  /**
   * @param {any[]} args
   * @param {any} firstArg
   */
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

    this.uinUidStore?.rememberFromGroupMemberList?.(groupCode, members);

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
        ? infos.map((/** @type {any} */ m, idx) => [m?.uid || String(idx), m])
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
  }

  /**
   * @param {string} _listenerName
   * @param {string} eventName
   * @param {any[]} args
   */
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
        const tasksForThisBatch = msgList.map((/** @type {any} */ ntMsg) =>
          this._enqueueInboundNtMessage(ntMsg)
        );
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
    const handledLogin = this._handleLoginKernelEvent(eventName, args);
    if (
      !handledLogin &&
      (String(_listenerName || "").includes("Login") ||
        String(eventName || "").includes("QR") ||
        String(eventName || "").includes("Login"))
    ) {
      const argShape =
        firstArg && typeof firstArg === "object"
          ? Object.keys(firstArg).slice(0, 16).join(",")
          : typeof firstArg;
      this.logger?.debug?.(
        "login",
        `Unhandled login-like event ${_listenerName || "?"}/${eventName} (shape=${argShape})`
      );
    }
  }

  /** @param {any} ntMsg */
  async _processIncomingNtMessage(ntMsg) {
    if (!ntMsg || typeof ntMsg !== "object") return;
    const msgId = String(ntMsg.msgId || "");
    if (msgId && this.bridge._isDuplicateEvent?.(`msg:${msgId}`)) {
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
      this.config?.humanSimulation !== false &&
      autoReadAndType &&
      Number(ntMsg.chatType) === 1 &&
      ntMsg.peerUid &&
      Number(ntMsg.msgType) !== 5 &&
      !isSelfSender
    ) {
      const peerUid = String(ntMsg.peerUid);
      const peerKey = `1:${peerUid}:`;
      this.bridge._sessionScheduler?.schedulePrivateRecvReaction?.(
        peerKey,
        this.config.autoReadReactionDelayMs ?? [500, 1800],
        () =>
          this.bridge
            .simulateHumanSession?.({
              chatType: 1,
              peerUid,
              guildId: "",
              markRead: true,
              sendTyping: true,
              eventType: 1,
              advisory: true,
            })
            ?.catch?.((/** @type {any} */ err) => {
              this.logger?.debug?.("inbound", err);
            })
      );
    }
  }

  // --------------------------------------------------------------------------
  // Media Hydration Delegates (`./media_hydrator`)
  // --------------------------------------------------------------------------

  /** @param {any} firstArg */
  _handleRichMediaDownloadComplete(firstArg) {
    return mediaHydratorMixin._handleRichMediaDownloadComplete.call(this, firstArg);
  }

  /** @param {Record<string, any>} [options={}] */
  _downloadRichMediaElement(options = {}) {
    return mediaHydratorMixin._downloadRichMediaElement.call(this, options);
  }

  /**
   * @param {any} ntMsg
   * @param {any} el
   * @param {any} ctx
   */
  _hydratePicElement(ntMsg, el, ctx) {
    return mediaHydratorMixin._hydratePicElement.call(this, ntMsg, el, ctx);
  }

  /**
   * @param {any} ntMsg
   * @param {any} el
   * @param {any} ctx
   */
  _hydratePttElement(ntMsg, el, ctx) {
    return mediaHydratorMixin._hydratePttElement.call(this, ntMsg, el, ctx);
  }

  /** @param {any} el */
  _hydrateVideoElement(el) {
    return mediaHydratorMixin._hydrateVideoElement.call(this, el);
  }

  /**
   * @param {any} ntMsg
   * @param {Record<string, any>} [options={}]
   */
  _hydrateNtMsgMedia(ntMsg, options = {}) {
    return mediaHydratorMixin._hydrateNtMsgMedia.call(this, ntMsg, options);
  }

  // --------------------------------------------------------------------------
  // Login & Recovery Delegates (`./login_recovery`)
  // --------------------------------------------------------------------------

  /**
   * @param {any} rawIdentity
   * @param {{ markOnline?: boolean }} [options]
   */
  _syncSelfIdentityFromLogin(rawIdentity, options) {
    return loginRecoveryMixin._syncSelfIdentityFromLogin.call(this, rawIdentity, options);
  }

  /** @param {any} firstArg */
  _handleQrCodeEvent(firstArg) {
    return loginRecoveryMixin._handleQrCodeEvent.call(this, firstArg);
  }

  /** @param {any} firstArg */
  _handleUserLoggedInEvent(firstArg) {
    return loginRecoveryMixin._handleUserLoggedInEvent.call(this, firstArg);
  }

  /** @param {any} firstArg */
  _handleSessionInitCompleteEvent(firstArg) {
    return loginRecoveryMixin._handleSessionInitCompleteEvent.call(this, firstArg);
  }

  /** @param {any} firstArg */
  _handleKickedOffLineEvent(firstArg) {
    return loginRecoveryMixin._handleKickedOffLineEvent.call(this, firstArg);
  }

  /**
   * @param {string} eventName
   * @param {any[]} args
   * @returns {boolean}
   */
  _handleLoginKernelEvent(eventName, args) {
    return loginRecoveryMixin._handleLoginKernelEvent.call(this, eventName, args);
  }

  /** @param {Record<string, any>} [options={}] */
  _tryAutoQuickLogin(options = {}) {
    return loginRecoveryMixin._tryAutoQuickLogin.call(this, options);
  }
}

/**
 * Resolves or lazily binds an `InboundPipeline` for legacy `inboundPipelineMixin` hosts.
 * @param {any} host
 * @returns {InboundPipeline}
 */
function _resolveLegacyInboundPipeline(host) {
  if (host instanceof InboundPipeline) return host;
  if (host && host.inboundPipeline instanceof InboundPipeline) return host.inboundPipeline;
  if (host && host[LEGACY_INBOUND_CTRL_SYM] instanceof InboundPipeline) {
    return host[LEGACY_INBOUND_CTRL_SYM];
  }
  const ctrl = new InboundPipeline(host);
  if (host && typeof host === "object") {
    Object.defineProperty(host, LEGACY_INBOUND_CTRL_SYM, {
      value: ctrl,
      enumerable: false,
      configurable: true,
    });
    for (const key of LEGACY_INBOUND_STATE_KEYS) {
      const desc = Object.getOwnPropertyDescriptor(host, key);
      if (!desc || ("value" in desc && desc.configurable !== false)) {
        Object.defineProperty(host, key, {
          enumerable: true,
          configurable: true,
          get() {
            return /** @type {any} */ (ctrl)[key];
          },
          set(val) {
            /** @type {any} */ (ctrl)[key] = val;
          },
        });
      }
    }
  }
  return ctrl;
}

const INBOUND_PIPELINE_METHODS = /** @type {const} */ ([
  "_isPositiveUin",
  "_isNtReady",
  "_dispatchInboundEvent",
  "_ensureUinForUid",
  "_resolveNtMsgUids",
  "_getInboundMediaMaxConcurrent",
  "_acquireInboundMediaSlot",
  "_releaseInboundMediaSlot",
  "_enqueueInboundNtMessage",
  "_handleAddSendMsgEvent",
  "_handleMsgInfoUpdateEvent",
  "_handleGroupNotifiesUpdatedEvent",
  "_handleBuddyReqChangeEvent",
  "_handleBuddyListChangeEvent",
  "_handleProfileSimpleChangedEvent",
  "_handleProfileDetailInfoChangedEvent",
  "_handleDoubtBuddyReqChangeEvent",
  "_handleGroupListUpdateEvent",
  "_handleMemberInfoChangeEvent",
  "_handleKernelEvent",
  "_processIncomingNtMessage",
  "_handleRichMediaDownloadComplete",
  "_downloadRichMediaElement",
  "_hydratePicElement",
  "_hydratePttElement",
  "_hydrateVideoElement",
  "_hydrateNtMsgMedia",
  "_syncSelfIdentityFromLogin",
  "_handleQrCodeEvent",
  "_handleUserLoggedInEvent",
  "_handleSessionInitCompleteEvent",
  "_handleKickedOffLineEvent",
  "_handleLoginKernelEvent",
  "_tryAutoQuickLogin",
]);

/**
 * Backward-compatible mixin facade delegating to `InboundPipeline`.
 * @type {Record<string, (...args: any[]) => any>}
 */
const inboundPipelineMixin = {};
for (const methodName of INBOUND_PIPELINE_METHODS) {
  inboundPipelineMixin[methodName] = function (/** @type {any[]} */ ...args) {
    const ctrl = _resolveLegacyInboundPipeline(this);
    return /** @type {any} */ (ctrl)[methodName](...args);
  };
}

module.exports = {
  InboundPipeline,
  inboundPipelineMixin,
  mediaHydratorMixin,
  loginRecoveryMixin,
  _isPositiveUin,
};
