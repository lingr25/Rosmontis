"use strict";

/**
 * NTQQ Main-Process & Renderer-Coordinated OneBot v11 Bridge (`bridge_main.js`)
 *
 * Pure JavaScript coordinator with ZERO C++ `.so` hooks and ZERO external npm
 * dependencies. Wires together:
 * 1. Core subsystems (`src/core/`):
 *    - `nt_capture`: `Map.prototype.set` & InversifyJS DI capture hooks
 *    - `renderer_ipc`: Trusted `BrowserWindow` IPC bridge & 3-tier `invokeNt`
 *    - `inbound_pipeline`: Kernel event listener & incoming message hydration
 *    - `outbound_pipeline`: Rich media preparation, send-echo matching & pokes
 *    - `server_runtime`: RFC 6455 Forward/Reverse WebSocket & HTTP API servers
 *    - `session_scheduler`: Causal human session state machine & AIO mutex
 * 2. OneBot v11 action modules (`src/actions/`):
 *    - `message_actions`, `contact_actions`, `group_actions`, `file_media_actions`
 */

const crypto = require("crypto");
const fs = require("fs");
const { EventEmitter } = require("events");

const {
  MessageIdStore,
  UinUidStore,
  segmentsToCqCode,
  getNtqqVersionMetadata,
  buildNtqqUserAgent,
  pruneTempDir,
} = require("./bridge_onebot");

const {
  encodeWsFrame,
  Rfc6455Connection,
  connectReverseWebSocket,
} = require("./core/ws_rfc6455");

const { loadBridgeConfig } = require("./core/config");

const {
  computeBkn,
  cookieObjToString,
  httpsGetCookies,
  httpRequestText,
  parseJsonpOrJson,
} = require("./core/web_http");

const { CausalSessionScheduler } = require("./core/session_scheduler");

const {
  assertWebCredentialApiEnabled,
  fetchClientKey,
  getCookiesObject,
} = require("./core/qzone_actions");

const { ntCaptureMixin } = require("./core/nt_capture");
const { rendererIpcMixin, safeJsJson } = require("./core/renderer_ipc");
const { inboundPipelineMixin } = require("./core/inbound_pipeline");
const {
  outboundPipelineMixin,
  _ntElementsSignature,
  _elementsSignatureMatch,
} = require("./core/outbound_pipeline");
const { serverRuntimeMixin } = require("./core/server_runtime");

const messageActions = require("./actions/message_actions");
const contactActions = require("./actions/contact_actions");
const groupActions = require("./actions/group_actions");
const fileMediaActions = require("./actions/file_media_actions");

const WEB_HTTP_HELPERS = Object.freeze({
  computeBkn,
  cookieObjToString,
  httpsGetCookies,
  httpRequestText,
  parseJsonpOrJson,
});

const ACTION_MODULES = [
  messageActions,
  contactActions,
  groupActions,
  fileMediaActions,
];

const ACTION_DISPATCH_MAP = new Map();
for (const mod of ACTION_MODULES) {
  for (const act of mod.HANDLED_ACTIONS) {
    ACTION_DISPATCH_MAP.set(act, mod.dispatch);
  }
}

// ============================================================================
// Main Bridge Coordinator Class (`NtqqOneBotBridge`)
// ============================================================================

class NtqqOneBotBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = options.config || loadBridgeConfig(options.configDir);
    this.messageIdStore = options.messageIdStore || new MessageIdStore(10000);
    this.uinUidStore = options.uinUidStore || new UinUidStore(20000);

    this.selfUin = String(options.selfUin || this.config.selfUin || "");
    this.selfUid = String(options.selfUid || "");
    this.selfNickname = String(options.selfNickname || this.config.selfNickname || "QQBot");
    this.startedAtMs = Number.isFinite(Number(options.startedAtMs))
      ? Number(options.startedAtMs)
      : Date.now();
    const isLiveElectron = Boolean(
      process.versions &&
        process.versions.electron &&
        !options.ntApi &&
        !options.wrapperSession &&
        !options.rendererExecute
    );
    this.online = options.online !== undefined ? Boolean(options.online) : !isLiveElectron;
    this.lastQrCodeBase64 = "";

    this.capturedServices = {
      ntApi: options.ntApi || null,
      ntApiContainer: null,
      ntStore: null,
      WindowApi: null,
      PerformanceApi: null,
      LoggerApi: null,
      UserBehaviorReportService: null,
      SubWindowApi: null,
      ScreenRecordApi: null,
      ntCall: null,
      ntSessionManager: options.ntSessionManager || null,
      wrapperSession: options.wrapperSession || null,
    };

    this.rendererExecute = options.rendererExecute || null; // async (cmd, args) => result
    this.rendererSimulateSession = options.rendererSimulateSession || null;
    this.rendererLeaveSession = options.rendererLeaveSession || null;
    this.activeWebContents = null;
    this._knownWebContents = new Set();
    this._attachedEmitters = new WeakSet();
    this._seenEventKeys = new Map(); // key -> timestamp
    this._pttTextWaiters = new Map(); // msgId -> resolve(text)
    this._richMediaWaiters = new Map(); // `${msgId}:${elementId}` -> Set<resolve>
    this._groupNotifiesCache = new Map(); // flag -> notifyItem
    this._buddyReqsCache = new Map(); // flag -> reqItem
    this._groupListCache = new Map(); // groupId -> groupObj
    this._buddyCategoriesCache = []; // cached buddy categories from onBuddyListChange
    this._groupListWaiters = new Set(); // resolvers waiting on onGroupListUpdate
    this._buddyListWaiters = new Set(); // resolvers waiting on onBuddyListChange
    this._recentSentMsgByPeer = new Map(); // peerUid -> { ntMsg, at }
    this._recentReadByPeer = new Map(); // peerKey -> timestamp
    this._recentTypingByPeer = new Map(); // peerKey -> timestamp
    this._tempCleanupRing = []; // bounded ring of cleanup callbacks
    this._activeAioPeer = null;
    this._activeAioPeerKey = "";
    this._windowFocused = false;
    this._aioMutex = Promise.resolve();
    this._sessionScheduler = new CausalSessionScheduler({
      getActivePeerKey: () => this._activeAioPeerKey,
      switchCooldownMs: this.config.aioSwitchCooldownMs ?? 800,
      enforceHardCooldownOnExplicit: Boolean(this.config.enforceSwitchCooldownOnSend),
    });
    this._aioInteractionSeq = 0;
    this._aioIdleTimer = null;
    this._focusBlurTimer = null;
    this._ipcAuthToken = crypto.randomBytes(32).toString("hex");
    this._pendingRendererCmds = new Map();
    this._ipcCmdAckInstalled = false;
    this._logThrottle = new Map(); // key -> last log timestamp
    this.invokeStats = {
      tier1: 0,
      tier2: 0,
      tier3: 0,
      degraded: 0,
      blockedReplays: 0,
      failed: 0,
      lastDegraded: null,
    };
    this._sendEchoWaiters = new Map(); // peerKey -> Array<waiter> awaiting onAddSendMsg
    this.sendEchoStats = { matched: 0, fromResult: 0, timedOut: 0 };

    this._httpServers = [];
    this._wsServers = [];
    this._wsServerClients = new Set();
    this._reverseWsClients = [];
    this._wsClientHandles = this._reverseWsClients;
    this._heartbeatTimer = null;
  }

  _safeJsJson(val) {
    return safeJsJson(val);
  }

  // --------------------------------------------------------------------------
  // Bounded State, Temp Media Cleanup & Event Broadcast
  // --------------------------------------------------------------------------

  _setBoundedMap(map, key, value, maxEntries = 2000) {
    if (!map) return;
    if (map.has(key)) {
      map.delete(key);
    }
    map.set(key, value);
    while (map.size > maxEntries) {
      const oldestKey = map.keys().next().value;
      if (oldestKey === undefined) break;
      map.delete(oldestKey);
    }
  }

  _scheduleTempCleanup(cleanupCallbacks = [], immediate = false) {
    const callbacks =
      typeof cleanupCallbacks === "function" ? [cleanupCallbacks] : cleanupCallbacks;
    if (!Array.isArray(callbacks) || callbacks.length === 0) return;
    if (immediate || this.config.cleanupTempImmediately) {
      for (const fn of callbacks) {
        try {
          if (typeof fn === "function") fn();
        } catch (_) {}
      }
      return;
    }
    const maxRing = Math.max(8, Number(this.config.maxTempCleanupRing || 64));
    for (const fn of callbacks) {
      if (typeof fn !== "function") continue;
      let called = false;
      const runOnce = () => {
        if (called) return;
        called = true;
        try {
          fn();
        } catch (_) {}
      };
      const timer = setTimeout(runOnce, Number(this.config.tempCleanupDelayMs ?? 5000));
      if (typeof timer.unref === "function") timer.unref();
      this._tempCleanupRing.push(runOnce);
      while (this._tempCleanupRing.length > maxRing) {
        const oldest = this._tempCleanupRing.shift();
        if (typeof oldest === "function") oldest();
      }
    }
  }

  _scheduleMediaCleanup(media) {
    if (!media) return;
    if (typeof media.cleanup === "function") {
      this._scheduleTempCleanup(media.cleanup);
      return;
    }
    if (media.isTempFile && media.localPath) {
      const tempPath = media.localPath;
      this._scheduleTempCleanup(() => {
        try {
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }
        } catch (_) {}
      });
    }
  }

  flushTempCleanup() {
    while (this._tempCleanupRing.length > 0) {
      const fn = this._tempCleanupRing.shift();
      if (typeof fn === "function") {
        try {
          fn();
        } catch (_) {}
      }
    }
  }

  _isDuplicateEvent(key, ttlMs = 30000) {
    if (!key) return false;
    const now = Date.now();
    const prev = this._seenEventKeys.get(key);
    if (prev && now - prev < ttlMs) {
      return true;
    }
    this._seenEventKeys.set(key, now);
    if (this._seenEventKeys.size > 5000) {
      const oldestKey = this._seenEventKeys.keys().next().value;
      this._seenEventKeys.delete(oldestKey);
    }
    return false;
  }

  _formatEventForEndpoint(eventObj, messageFormat) {
    if (
      messageFormat === "string" &&
      eventObj &&
      (eventObj.post_type === "message" || eventObj.post_type === "message_sent")
    ) {
      return {
        ...eventObj,
        message:
          typeof eventObj.raw_message === "string"
            ? eventObj.raw_message
            : Array.isArray(eventObj.message)
            ? segmentsToCqCode(eventObj.message)
            : String(eventObj.message ?? ""),
      };
    }
    return eventObj;
  }

  broadcastOneBotEvent(event) {
    if (!event || typeof event !== "object") return;
    if (!event.self_id && this.selfUin) {
      event.self_id = Number(this.selfUin);
    }
    const defaultFormat = this.config.messageFormat || "array";
    this.emit("onebot_event", this._formatEventForEndpoint(event, defaultFormat));

    // Do not broadcast self-sent messages unless reportSelfMessage is true
    for (const client of this._wsServerClients) {
      if (client.closed) {
        this._wsServerClients.delete(client);
        continue;
      }
      if (event.post_type === "message_sent" && !client.reportSelfMessage) {
        continue;
      }
      const targetFormat = client._messageFormat || defaultFormat;
      client.sendJson(this._formatEventForEndpoint(event, targetFormat));
    }

    for (const rev of this._reverseWsClients) {
      if (!rev.conn || rev.conn.closed) continue;
      if (event.post_type === "message_sent" && !rev.cfg?.reportSelfMessage) {
        continue;
      }
      const targetFormat = rev.messageFormat || rev.cfg?.messageFormat || defaultFormat;
      rev.conn.sendJson(this._formatEventForEndpoint(event, targetFormat));
    }
  }

  // --------------------------------------------------------------------------
  // Human Session State Machine Coordinator
  // --------------------------------------------------------------------------

  _withAioLock(fn, options = {}) {
    const opts = options && typeof options === "object" ? options : {};
    return this._sessionScheduler.runExclusive(opts.peerKey || "", fn, opts);
  }

  _clearIdleTimers() {
    if (this._aioIdleTimer) {
      clearTimeout(this._aioIdleTimer);
      this._aioIdleTimer = null;
    }
    if (this._focusBlurTimer) {
      clearTimeout(this._focusBlurTimer);
      this._focusBlurTimer = null;
    }
  }

  _resetHumanSessionState({ resetRenderer = false } = {}) {
    this._aioInteractionSeq += 1;
    this._clearIdleTimers();
    this._sessionScheduler.dispose();
    this._activeAioPeer = null;
    this._activeAioPeerKey = "";
    this._windowFocused = false;
    this._recentReadByPeer.clear();
    this._recentTypingByPeer.clear();
    if (resetRenderer && this._canInvokeRenderer(this.activeWebContents)) {
      this._invokeRendererCommand("resetSession", {}, 5000).catch(() => {});
    }
  }

  _touchAioActivity() {
    this._aioInteractionSeq += 1;
    const seq = this._aioInteractionSeq;
    this._clearIdleTimers();
    if (this.config.humanSimulation === false) return;

    const aioIdleMs = Number(this.config.aioIdleExitMs ?? 45000);
    if (aioIdleMs > 0) {
      this._aioIdleTimer = setTimeout(() => {
        this._aioIdleTimer = null;
        if (seq !== this._aioInteractionSeq || !this._activeAioPeer) return;
        this._withAioLock(async () => {
          if (seq !== this._aioInteractionSeq || !this._activeAioPeer) return;
          await this._leaveSessionUnlocked({ exitAio: true, blurWindow: false });
        }).catch(() => {});
      }, aioIdleMs);
      if (typeof this._aioIdleTimer.unref === "function") this._aioIdleTimer.unref();
    }

    const focusBlurMs = Number(this.config.focusIdleBlurMs ?? 300000);
    if (focusBlurMs > 0) {
      this._focusBlurTimer = setTimeout(() => {
        this._focusBlurTimer = null;
        if (seq !== this._aioInteractionSeq || (!this._windowFocused && !this._activeAioPeer)) {
          return;
        }
        this._withAioLock(async () => {
          if (seq !== this._aioInteractionSeq || (!this._windowFocused && !this._activeAioPeer)) {
            return;
          }
          await this._leaveSessionUnlocked({ exitAio: true, blurWindow: true });
        }).catch(() => {});
      }, focusBlurMs);
      if (typeof this._focusBlurTimer.unref === "function") this._focusBlurTimer.unref();
    }
  }

  async _leaveSessionUnlocked({ exitAio = true, blurWindow = false } = {}) {
    const shouldExitAio = Boolean(exitAio && this._activeAioPeer && this._activeAioPeerKey);
    const shouldBlur = Boolean(blurWindow && this._windowFocused);
    if (!shouldExitAio && !shouldBlur) {
      return { exitedAio: false, blurredWindow: false };
    }

    const leaveOpts = {
      exitAio: shouldExitAio,
      blurWindow: shouldBlur,
      knownActivePeer: this._activeAioPeer,
      knownActivePeerKey: this._activeAioPeerKey,
      knownFocused: this._windowFocused,
    };

    if (typeof this.rendererLeaveSession === "function") {
      try {
        const res = await this.rendererLeaveSession(leaveOpts);
        if (res !== undefined && res !== null) {
          if (shouldExitAio) {
            this._activeAioPeer = null;
            this._activeAioPeerKey = "";
          }
          if (shouldBlur) {
            this._windowFocused = false;
          }
          return res;
        }
      } catch (_) {}
    }

    if (this._canInvokeRenderer(this.activeWebContents)) {
      try {
        const res = await this._invokeRendererCommand("leaveSession", { opts: leaveOpts }, 8000);
        if (res && typeof res === "object" && ("exitedAio" in res || "blurredWindow" in res)) {
          if (shouldExitAio) {
            this._activeAioPeer = null;
            this._activeAioPeerKey = "";
          }
          if (shouldBlur) {
            this._windowFocused = false;
          }
          return res;
        }
      } catch (_) {}
    }

    let exitedAio = false;
    let blurredWindow = false;
    if (shouldExitAio) {
      const prevPeer = this._activeAioPeer;
      this._activeAioPeer = null;
      this._activeAioPeerKey = "";
      try {
        await this.invokeNt("nodeIKernelMsgService/enterOrExitAio", {
          info: { peer: prevPeer, enterType: 2 },
        });
        exitedAio = true;
      } catch (_) {}
    }
    if (shouldBlur) {
      this._windowFocused = false;
      try {
        await this.invokeNt("nodeIKernelMsgService/setFocusOnBase", { isFocus: false });
        blurredWindow = true;
      } catch (_) {}
    }
    return { fallback: true, exitedAio, blurredWindow };
  }

  async leaveHumanSession(opts) {
    return this._withAioLock(() => this._leaveSessionUnlocked(opts));
  }

  async _activateSessionUnlocked(opts = {}) {
    const peer = {
      chatType: Number(opts?.chatType || 1),
      peerUid: String(opts?.peerUid || ""),
      guildId: String(opts?.guildId || ""),
    };
    if (!peer.peerUid) return null;

    const peerKey = `${peer.chatType}:${peer.peerUid}:${peer.guildId}`;
    const prevPeerKey = this._activeAioPeerKey;
    const switchDecision = this._sessionScheduler.shouldAllowSwitch(peerKey, {
      advisory: Boolean(opts?.advisory),
    });
    if (!switchDecision.allowed) {
      return {
        skippedByCooldown: true,
        activeAioPeer: this._activeAioPeer,
        activeAioPeerKey: this._activeAioPeerKey,
        focused: this._windowFocused,
      };
    }
    if (switchDecision.waitMs > 0) {
      await this._sessionScheduler.sleepUnref(switchDecision.waitMs);
    }

    const now = Date.now();
    const dedupeMs = Number(opts?.dedupeWindowMs ?? this.config?.dedupeWindowMs ?? 5000);
    const effEventType = Number(opts?.eventType ?? 1);
    const shouldMarkRead =
      Boolean(opts?.markRead) && now - (this._recentReadByPeer.get(peerKey) || 0) >= dedupeMs;
    const shouldSendTyping =
      Boolean(opts?.sendTyping && peer.chatType === 1) &&
      (effEventType !== 1 || now - (this._recentTypingByPeer.get(peerKey) || 0) >= dedupeMs);
    const delaySpec =
      opts?.readToTypingDelayMs !== undefined
        ? opts.readToTypingDelayMs
        : this.config.humanReadToTypingDelayMs;
    const readToTypingDelayMs =
      shouldMarkRead && shouldSendTyping
        ? this._sessionScheduler.computeDelayMs(delaySpec, 0)
        : 0;

    const effectiveOpts = {
      ...opts,
      chatType: peer.chatType,
      peerUid: peer.peerUid,
      guildId: peer.guildId,
      markRead: shouldMarkRead,
      sendTyping: shouldSendTyping,
      readToTypingDelayMs,
      eventType: effEventType,
      dedupeWindowMs: dedupeMs,
      bypassDedupe: true,
      knownActivePeer: this._activeAioPeer,
      knownActivePeerKey: this._activeAioPeerKey,
      knownFocused: this._windowFocused,
    };

    if (typeof this.rendererSimulateSession === "function") {
      try {
        const res = await this.rendererSimulateSession(effectiveOpts);
        if (res !== undefined && res !== null) {
          this._windowFocused = res.focused !== undefined ? Boolean(res.focused) : true;
          this._activeAioPeer = peer;
          this._activeAioPeerKey = peerKey;
          if (prevPeerKey !== this._activeAioPeerKey) {
            this._sessionScheduler.recordSwitch(this._activeAioPeerKey);
          }
          if (shouldMarkRead && res.markRead !== false) {
            this._setBoundedMap(this._recentReadByPeer, peerKey, Date.now());
          }
          if (shouldSendTyping && effEventType === 1 && res.sendTyping !== false) {
            this._setBoundedMap(this._recentTypingByPeer, peerKey, Date.now());
          }
          this._touchAioActivity();
          return res;
        }
      } catch (_) {}
    }

    if (this._canInvokeRenderer(this.activeWebContents)) {
      try {
        const res = await this._invokeRendererCommand(
          "simulateSession",
          { opts: effectiveOpts },
          10000
        );
        if (res && typeof res === "object" && ("enterOrExitAio" in res || "alreadyInAio" in res)) {
          this._windowFocused = res.focused !== undefined ? Boolean(res.focused) : true;
          this._activeAioPeer = peer;
          this._activeAioPeerKey = peerKey;
          if (prevPeerKey !== this._activeAioPeerKey) {
            this._sessionScheduler.recordSwitch(this._activeAioPeerKey);
          }
          if (shouldMarkRead && res.markRead !== false) {
            this._setBoundedMap(this._recentReadByPeer, peerKey, Date.now());
          }
          if (shouldSendTyping && effEventType === 1 && res.sendTyping !== false) {
            this._setBoundedMap(this._recentTypingByPeer, peerKey, Date.now());
          }
          this._touchAioActivity();
          return res;
        }
      } catch (_) {}
    }

    // Fallback via invokeNt with strict causal ordering:
    // setFocusOnBase(true) -> enterOrExitAio(prev, 2) -> addActiveChatByUid(new) -> enterOrExitAio(new, 1) -> setMsgRead -> sendShowInputStatusReq
    let didFocus = false;
    if (!this._windowFocused) {
      try {
        await this.invokeNt("nodeIKernelMsgService/setFocusOnBase", { isFocus: true });
        didFocus = true;
        this._windowFocused = true;
      } catch (_) {}
    } else {
      didFocus = true;
    }

    let exitedPreviousAio = false;
    const alreadyInAio = this._activeAioPeerKey === peerKey;
    if (!alreadyInAio) {
      if (this._activeAioPeer && this._activeAioPeerKey) {
        try {
          await this.invokeNt("nodeIKernelMsgService/enterOrExitAio", {
            info: { peer: this._activeAioPeer, enterType: 2 },
          });
          exitedPreviousAio = true;
        } catch (_) {}
      }
      try {
        await this.invokeNt("nodeIKernelMsgService/addActiveChatByUid", { peer });
      } catch (_) {}
      try {
        await this.invokeNt("nodeIKernelMsgService/enterOrExitAio", {
          info: { peer, enterType: 1 },
        });
      } catch (_) {}
      this._activeAioPeer = peer;
      this._activeAioPeerKey = peerKey;
      if (prevPeerKey !== this._activeAioPeerKey) {
        this._sessionScheduler.recordSwitch(this._activeAioPeerKey);
      }
    }

    let didMarkRead = false;
    let didSendTyping = false;

    if (shouldMarkRead) {
      try {
        await this.invokeNt("nodeIKernelMsgService/setMsgRead", { peer }, [peer]);
        didMarkRead = true;
        this._setBoundedMap(this._recentReadByPeer, peerKey, Date.now());
      } catch (_) {}
    }
    if (shouldMarkRead && shouldSendTyping && readToTypingDelayMs > 0) {
      await this._sessionScheduler.sleepUnref(readToTypingDelayMs);
    }
    if (shouldSendTyping) {
      try {
        await this.invokeNt(
          "nodeIKernelMsgService/sendShowInputStatusReq",
          { eventType: effEventType, peer },
          [1, effEventType, peer.peerUid]
        );
        didSendTyping = true;
        if (effEventType === 1) {
          this._setBoundedMap(this._recentTypingByPeer, peerKey, Date.now());
        }
      } catch (_) {}
    }
    this._touchAioActivity();
    return {
      fallback: true,
      alreadyInAio,
      exitedPreviousAio,
      setFocusOnBase: didFocus,
      markRead: didMarkRead,
      sendTyping: didSendTyping,
    };
  }

  async simulateHumanSession(opts = {}) {
    const peerKey = opts?.peerUid
      ? `${Number(opts.chatType || 1)}:${String(opts.peerUid)}:${String(opts.guildId || "")}`
      : "";
    return this._withAioLock(() => this._activateSessionUnlocked(opts), {
      peerKey,
      advisory: Boolean(opts?.advisory),
    });
  }

  // --------------------------------------------------------------------------
  // Credential Helper Delegates & OneBot v11 Action Dispatcher
  // --------------------------------------------------------------------------

  async _fetchClientKey() {
    assertWebCredentialApiEnabled(this.config, "get_clientkey");
    return await fetchClientKey(this);
  }

  async _getCookiesObject(domain = "qun.qq.com") {
    assertWebCredentialApiEnabled(this.config, "get_cookies");
    return await getCookiesObject(this, domain, WEB_HTTP_HELPERS);
  }

  async handleOneBotAction(action, params = {}, echo = undefined, context = {}) {
    const act = String(action || "").replace(/^\/+/, "").trim();
    const p = params && typeof params === "object" ? params : {};

    try {
      const data = await this._dispatchAction(act, p, context);
      return {
        status: "ok",
        retcode: 0,
        data: data === undefined ? {} : data,
        message: "",
        wording: "",
        ...(echo !== undefined ? { echo } : {}),
      };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      const retcode = Number(
        err?.retcode || (err?.code === "ERR_WEB_CREDENTIAL_API_DISABLED" ? 1403 : 1400)
      );
      return {
        status: "failed",
        retcode,
        data: null,
        message: msg,
        wording: msg,
        ...(echo !== undefined ? { echo } : {}),
      };
    }
  }

  async _dispatchAction(action, p, context = {}) {
    const handler = ACTION_DISPATCH_MAP.get(action);
    if (!handler) {
      throw new Error(`Unsupported OneBot action: ${action}`);
    }
    return await handler.call(this, action, p, context);
  }
}

NtqqOneBotBridge._ntElementsSignature = _ntElementsSignature;
NtqqOneBotBridge._elementsSignatureMatch = _elementsSignatureMatch;

Object.assign(
  NtqqOneBotBridge.prototype,
  ntCaptureMixin,
  rendererIpcMixin,
  inboundPipelineMixin,
  outboundPipelineMixin,
  serverRuntimeMixin
);

// ============================================================================
// Bootstrap & Public Exports
// ============================================================================

let singletonBridge = null;

function installMainBridge(options = {}) {
  if (singletonBridge && !options.forceNew) {
    if (options.config) {
      singletonBridge.config = options.config;
      singletonBridge
        .stopServers()
        .then(() => {
          if (options.autoStartServers !== false) {
            return singletonBridge.startServers();
          }
        })
        .catch(() => {});
    }
    return singletonBridge;
  }
  const bridge = new NtqqOneBotBridge(options);
  bridge.installMapPrototypeHook();
  bridge.installWrapperHook();
  bridge.installElectronHooks(options.electron);
  if (options.autoStartServers !== false) {
    bridge.startServers().catch(() => {});
  }
  singletonBridge = bridge;
  return bridge;
}

if (
  require.main !== module &&
  process.env.ROSMONTIS_NO_AUTOINSTALL !== "1" &&
  process.env.ROSMONTIS_BRIDGE_NO_AUTOINSTALL !== "1" &&
  process.env.XIAO_BRIDGE_NO_AUTOINSTALL !== "1" &&
  process.versions &&
  process.versions.electron
) {
  installMainBridge();
}

module.exports = {
  NtqqOneBotBridge,
  Rfc6455Connection,
  encodeWsFrame,
  connectReverseWebSocket,
  loadBridgeConfig,
  computeBkn,
  getNtqqVersionMetadata,
  buildNtqqUserAgent,
  pruneTempDir,
  installMainBridge,
};
