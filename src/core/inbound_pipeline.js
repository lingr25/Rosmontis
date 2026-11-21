// @ts-check
"use strict";

/**
 * Inbound Kernel Event Routing, UID Resolution & Per-Peer Concurrency Pipeline (`src/core/inbound_pipeline.js`)
 *
 * Composed controller (`InboundPipeline`) coordinating incoming NTQQ kernel events,
 * per-peer causal message ordering with bounded cross-peer media hydration concurrency,
 * UID->UIN resolution, `MediaHydrator` (`./media_hydrator`), and
 * `LoginRecovery` (`./login_recovery`).
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
const { MediaHydrator, stripTransientMedia } = require("./media_hydrator");
const { LoginRecovery } = require("./login_recovery");
const { AnomalyRecorder } = require("./anomaly_recorder");

const KNOWN_HANDLED_ELEMENT_TYPES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 16]);

/** @typedef {import("../types").BridgeHost} BridgeHost */
/** @typedef {import("../types").BridgeConfig} BridgeConfig */
/** @typedef {import("../types").InvokeNtOptions} InvokeNtOptions */
/** @typedef {import("../types").LivenessStats} LivenessStats */

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

/**
 * Composed inbound kernel event routing, media hydration & login recovery pipeline.
 */
class InboundPipeline {
  /**
   * @param {BridgeHost | Partial<BridgeHost>} [bridge={}]
   */
  constructor(bridge = {}) {
    /** @type {BridgeHost} */
    this.bridge = /** @type {BridgeHost} */ (bridge || {});
    /** @type {Map<string, any>} */
    this._pttTextWaiters = new Map();
    /** @type {Map<string, Set<import("./media_hydrator").RichMediaWaiterEntry>>} */
    this._richMediaWaiters = new Map();
    /** @type {Map<string, any>} */
    this._groupNotifiesCache = new BoundedMap(2000);
    /** @type {Map<string, any>} */
    this._buddyReqsCache = new BoundedMap(2000);
    /** @type {Map<string, any>} */
    this._groupListCache = new BoundedMap(2000);
    /** @type {any[]} */
    this._buddyCategoriesCache = [];
    /** @type {Set<any>} */
    this._groupListWaiters = new Set();
    /** @type {Set<(qrBase64: string) => void>} */
    this._qrCodeWaiters = new Set();
    /** @type {Set<any>} */
    this._buddyListWaiters = new Set();
    /** @type {Map<string, Set<any>>} */
    this._profileDetailWaiters = new Map();
    /** @type {Set<any>} */
    this._doubtBuddyWaiters = new Set();
    /** @type {Map<string, any>} */
    this._recentSentMsgByPeer = new BoundedMap(2000);
    /** @type {number} */
    this._inboundMediaActive = 0;
    /** @type {Array<() => void>} */
    this._inboundMediaWaiters = [];
    /** @type {Map<string, Promise<void>>} */
    this._inboundPeerChains = new Map();
    /** @type {Map<string, string>} */
    this._emojiLikesSnapshot = new Map();
    /** @type {Map<string, string>} */
    this._memberCardCache = new Map();
    /** @type {number} */
    this._autoQuickLoginAttempts = 0;
    /** @type {number} */
    this._lastAutoQuickLoginAt = 0;

    this.mediaHydrator = new MediaHydrator(this);
    this.loginRecovery = new LoginRecovery(this);
    this.anomalyRecorder = new AnomalyRecorder({
      getConfig: () => this.config,
      logger: this.logger,
    });
    /** @type {LivenessStats} */
    this.livenessStats = {
      healthy: true,
      degradedReason: "",
      lastKernelEventAt: Date.now(),
      lastProbeAt: 0,
      probeCount: 0,
      consecutiveFailures: 0,
      sessionRebinds: 0,
    };
  }

  _ensureAnomalyRecorder() {
    if (!this.anomalyRecorder || typeof this.anomalyRecorder.record !== "function") {
      this.anomalyRecorder = new AnomalyRecorder({
        getConfig: () => this.config,
        logger: this.logger,
      });
    }
    return this.anomalyRecorder;
  }

  /** @returns {LivenessStats} */
  _ensureLivenessState() {
    if (!this.livenessStats || typeof this.livenessStats !== "object") {
      this.livenessStats = {
        healthy: true,
        degradedReason: "",
        lastKernelEventAt: Date.now(),
        lastProbeAt: 0,
        probeCount: 0,
        consecutiveFailures: 0,
        sessionRebinds: 0,
      };
    }
    return this.livenessStats;
  }

  /**
   * Checks for silent `wrapperSession` drift on `ntStore` (self-healing detached emitters)
   * and optionally performs a read-only kernel login probe after prolonged kernel silence.
   *
   * @param {{ forceProbe?: boolean, now?: number }} [options={}]
   */
  async checkLiveness(options = {}) {
    const state = this._ensureLivenessState();
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    const cs = this.bridge.capturedServices;

    // 1. Self-heal silent wrapperSession replacement on ntStore / ntSessionManager
    const liveNtStore = cs?.ntStore || cs?.ntSessionManager?.ntStore || null;
    const storeSession = liveNtStore?.wrapperSession || liveNtStore?.session || null;
    if (storeSession && typeof storeSession === "object" && cs && storeSession !== cs.wrapperSession) {
      cs.wrapperSession = storeSession;
      try {
        this.bridge.ntCapture?._inspectNtStore?.(liveNtStore);
      } catch (rebindErr) {
        this.logger?.debug?.("inbound.liveness", rebindErr);
      }
      state.sessionRebinds += 1;
    }

    if (!this.online) {
      return {
        ...state,
        online: false,
        skipped: "offline",
      };
    }

    const rawIdleMs = Number(this.config?.livenessIdleThresholdMs);
    const idleThresholdMs =
      Number.isFinite(rawIdleMs) && rawIdleMs >= 0 ? Math.floor(rawIdleMs) : 600000;
    const idleElapsedMs = Math.max(0, now - (state.lastKernelEventAt || 0));
    if (!options.forceProbe && idleElapsedMs < idleThresholdMs) {
      return {
        ...state,
        online: true,
        skipped: "recent_activity",
        idleElapsedMs,
      };
    }

    // Skip active RPC probing in synthetic unit-test hosts with no real/mocked kernel transport
    const hasKernelTransport =
      typeof this.bridge.rendererExecute === "function" ||
      Boolean(
        this.bridge.rendererIpc &&
          this.bridge.rendererIpc._canInvokeRenderer(this.bridge.activeWebContents)
      ) ||
      Boolean(cs?.ntApi) ||
      Boolean(cs?.wrapperSession);
    if (!hasKernelTransport || typeof this.bridge.invokeNt !== "function") {
      return {
        ...state,
        online: true,
        skipped: "no_transport",
        idleElapsedMs,
      };
    }

    state.lastProbeAt = now;
    state.probeCount += 1;
    const rawMaxFailures = Number(this.config?.livenessMaxFailures);
    const maxFailures =
      Number.isFinite(rawMaxFailures) && rawMaxFailures >= 1 ? Math.floor(rawMaxFailures) : 3;

    try {
      const loginRes = await this.bridge.invokeNt(
        "nodeIKernelLoginService/getLoginList",
        {},
        [],
        { timeoutMs: 5000 }
      );
      const list = Array.isArray(loginRes?.LocalLoginInfoList)
        ? loginRes.LocalLoginInfoList
        : null;
      if (list && this.selfUin) {
        const selfAcc = list.find(
          (/** @type {any} */ item) => String(item?.uin || "") === String(this.selfUin)
        );
        if (selfAcc && selfAcc.isUserLogin === false) {
          state.consecutiveFailures += 1;
          state.healthy = false;
          state.degradedReason = "self_account_logged_out";
          return { ...state, online: this.online, probed: true, idleElapsedMs };
        }
      }
      state.consecutiveFailures = 0;
      state.healthy = true;
      state.degradedReason = "";
      return { ...state, online: this.online, probed: true, idleElapsedMs };
    } catch (/** @type {any} */ probeErr) {
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= maxFailures) {
        state.healthy = false;
        state.degradedReason = String(probeErr?.message || probeErr).slice(0, 160);
      }
      return { ...state, online: this.online, probed: true, idleElapsedMs };
    }
  }

  /** @returns {BridgeConfig | undefined} */
  get config() {
    return this.bridge.config;
  }

  /** @returns {InstanceType<typeof import("./primitives").BridgeLogger> | undefined} */
  get logger() {
    return this.bridge.logger;
  }

  /** @returns {InstanceType<typeof import("../onebot/stores").MessageIdStore> | undefined} */
  get messageIdStore() {
    return this.bridge.messageIdStore;
  }

  /** @returns {InstanceType<typeof import("../onebot/stores").UinUidStore> | undefined} */
  get uinUidStore() {
    return this.bridge.uinUidStore;
  }

  /** @returns {string} */
  get selfUin() {
    return this.bridge.selfUin || "";
  }

  /** @param {string} v */
  set selfUin(v) {
    this.bridge.selfUin = v;
  }

  /** @returns {string} */
  get selfUid() {
    return this.bridge.selfUid || "";
  }

  /** @param {string} v */
  set selfUid(v) {
    this.bridge.selfUid = v;
  }

  /** @returns {string} */
  get selfNickname() {
    return this.bridge.selfNickname || "";
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
    return this.bridge.lastQrCodeBase64 || "";
  }

  /** @param {string} v */
  set lastQrCodeBase64(v) {
    this.bridge.lastQrCodeBase64 = v;
  }

  /** @returns {any} */
  get activeWebContents() {
    return this.bridge.activeWebContents;
  }

  /** @returns {import("../types").CapturedServices | undefined} */
  get capturedServices() {
    return this.bridge.capturedServices;
  }

  /** @returns {((cmd: string, args: any[]) => Promise<any>) | null | undefined} */
  get rendererExecute() {
    return this.bridge.rendererExecute;
  }

  /** @returns {((service: string, method: string, args: any[]) => Promise<any>) | null | undefined} */
  get ntCall() {
    return this.bridge.ntCall;
  }

  /**
   * @param {string} cmd
   * @param {Record<string, any>} [payload]
   * @param {any[] | null} [positionalArgs]
   * @param {InvokeNtOptions | null} [invokeOptions]
   * @returns {Promise<any>}
   */
  invokeNt(cmd, payload, positionalArgs, invokeOptions) {
    if (typeof this.bridge.invokeNt === "function") {
      return this.bridge.invokeNt(cmd, payload, positionalArgs, invokeOptions);
    }
    return Promise.resolve(undefined);
  }

  /**
   * @param {string} key
   * @param {number} [ttlMs]
   * @returns {boolean}
   */
  _isDuplicate(key, ttlMs) {
    return Boolean(this.bridge.eventDedupe?.isDuplicate(key, ttlMs));
  }

  /** @param {Record<string, any>} [identity] */
  _updateSelfIdentity(identity = {}) {
    if (identity.markOnline) {
      const liveness = this._ensureLivenessState();
      liveness.healthy = true;
      liveness.degradedReason = "";
      liveness.consecutiveFailures = 0;
      liveness.lastKernelEventAt = Date.now();
    }
    if (this.bridge.ntCapture) {
      this.bridge.ntCapture._updateSelfIdentity(identity);
      return;
    }
    if (identity.uin && /^\d+$/.test(String(identity.uin))) {
      this.selfUin = String(identity.uin);
    }
    if (identity.uid && String(identity.uid).trim()) {
      this.selfUid = String(identity.uid).trim();
    }
    const incomingNick = identity.nick ?? identity.nickname;
    if (incomingNick && String(incomingNick).trim()) {
      this.selfNickname = String(incomingNick).trim();
    }
    if (identity.markOnline) {
      this.online = true;
    }
  }

  /** @param {Record<string, any>} [opts] */
  _resetHumanSessionState(opts) {
    return this.bridge.sessionController?.reset(opts || undefined);
  }

  /** @param {any} wc */
  _isWebContentsAlive(wc) {
    if (this.bridge.rendererIpc) {
      return this.bridge.rendererIpc._isWebContentsAlive(wc);
    }
    return Boolean(wc && (typeof wc.isDestroyed !== "function" || !wc.isDestroyed()));
  }

  /** @param {any} url */
  _isTrustedRendererUrl(url) {
    if (this.bridge.rendererIpc) {
      return this.bridge.rendererIpc._isTrustedRendererUrl(url);
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
    if (b.rendererIpc && b.rendererIpc._canInvokeRenderer(b.activeWebContents)) {
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
      const ntCallFn = this.bridge.ntCall;
      const invoker =
        typeof this.bridge.invokeNt === "function"
          ? this.bridge.invokeNt.bind(this.bridge)
          : typeof ntCallFn === "function"
          ? (/** @type {string} */ cmd, /** @type {any} */ payload) => {
              const [service, method] = String(cmd).split("/");
              return ntCallFn.call(this.bridge, service, method, [payload]);
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
        this._ensureAnomalyRecorder().record({
          kind: "inbound_message_error",
          eventName: "onRecvMsg",
          error: err,
          payload: ntMsg,
        });
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
    if (this._isDuplicate(`send:${ntMsg.msgId}`)) {
      return;
    }
    if (this.bridge.outboundPipeline) {
      this.bridge.outboundPipeline._matchSendEcho(ntMsg);
    } else {
      this.bridge.echoCorrelator?.match(ntMsg);
    }
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
        if (!this._isDuplicate(dedupKey)) {
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
        if (this._isDuplicate(updateKey, 3000)) {
          continue;
        }
      }

      await this._resolveNtMsgUids(ntMsg);
      /** @type {any} */
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
        if (this._isDuplicate(dedupKey)) continue;
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
      if (this._isDuplicate(dedupKey)) continue;
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
    const liveness = this._ensureLivenessState();
    liveness.lastKernelEventAt = Date.now();
    if (
      this.online &&
      !liveness.healthy &&
      liveness.degradedReason !== "self_account_logged_out"
    ) {
      liveness.consecutiveFailures = 0;
      liveness.healthy = true;
      liveness.degradedReason = "";
    }
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
      await this._handleRichMediaDownloadComplete(firstArg);
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
    if (msgId && this._isDuplicate(`msg:${msgId}`)) {
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
        if (
          Array.isArray(ev.message) &&
          ev.message.length === 0 &&
          Number(ntMsg.msgType) !== 5 &&
          Array.isArray(ntMsg.elements)
        ) {
          const unknownEl = ntMsg.elements.find(
            (/** @type {any} */ el) =>
              el &&
              typeof el === "object" &&
              !KNOWN_HANDLED_ELEMENT_TYPES.has(Number(el.elementType || 0))
          );
          if (unknownEl) {
            this._ensureAnomalyRecorder().record({
              kind: "unhandled_element_type",
              eventName: "onRecvMsg",
              error: `Unhandled elementType=${unknownEl.elementType}`,
              payload: ntMsg,
            });
          }
        }
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
      this.bridge.sessionController?.scheduler.schedulePrivateRecvReaction(
        peerKey,
        this.config?.autoReadReactionDelayMs ?? [500, 1800],
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
    return this.mediaHydrator.handleRichMediaDownloadComplete(firstArg);
  }

  /** @param {Record<string, any>} [options={}] */
  _downloadRichMediaElement(options = {}) {
    return this.mediaHydrator.downloadRichMediaElement(options);
  }

  /**
   * @param {any} ntMsg
   * @param {any} el
   * @param {import("./media_hydrator").MediaHydrationContext} ctx
   */
  _hydratePicElement(ntMsg, el, ctx) {
    return this.mediaHydrator.hydratePicElement(ntMsg, el, ctx);
  }

  /**
   * @param {any} ntMsg
   * @param {any} el
   * @param {import("./media_hydrator").MediaHydrationContext} ctx
   */
  _hydratePttElement(ntMsg, el, ctx) {
    return this.mediaHydrator.hydratePttElement(ntMsg, el, ctx);
  }

  /** @param {any} el */
  _hydrateVideoElement(el) {
    return this.mediaHydrator.hydrateVideoElement(el);
  }

  /**
   * @param {any} ntMsg
   * @param {Record<string, any>} [options={}]
   */
  _hydrateNtMsgMedia(ntMsg, options = {}) {
    return this.mediaHydrator.hydrateNtMsgMedia(ntMsg, options);
  }

  // --------------------------------------------------------------------------
  // Login & Recovery Delegates (`./login_recovery`)
  // --------------------------------------------------------------------------

  /**
   * @param {any} rawIdentity
   * @param {{ markOnline?: boolean }} [options]
   */
  _syncSelfIdentityFromLogin(rawIdentity, options) {
    return this.loginRecovery.syncSelfIdentityFromLogin(rawIdentity, options);
  }

  /** @param {any} firstArg */
  _handleQrCodeEvent(firstArg) {
    return this.loginRecovery.handleQrCodeEvent(firstArg);
  }

  /** @param {any} firstArg */
  _handleUserLoggedInEvent(firstArg) {
    return this.loginRecovery.handleUserLoggedInEvent(firstArg);
  }

  /** @param {any} firstArg */
  _handleSessionInitCompleteEvent(firstArg) {
    return this.loginRecovery.handleSessionInitCompleteEvent(firstArg);
  }

  /** @param {any} firstArg */
  _handleKickedOffLineEvent(firstArg) {
    return this.loginRecovery.handleKickedOffLineEvent(firstArg);
  }

  /**
   * @param {string} eventName
   * @param {any[]} args
   * @returns {boolean}
   */
  _handleLoginKernelEvent(eventName, args) {
    return this.loginRecovery.handleLoginKernelEvent(eventName, args);
  }

  /** @param {Record<string, any>} [options={}] */
  _tryAutoQuickLogin(options = {}) {
    return this.loginRecovery.tryAutoQuickLogin(options);
  }
}

module.exports = {
  InboundPipeline,
  _isPositiveUin,
};
