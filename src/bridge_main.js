// @ts-check
"use strict";

/**
 * NTQQ Main-Process & Renderer-Coordinated OneBot v11 Bridge (`bridge_main.js`)
 *
 * Pure JavaScript coordinator (zero C++ hooks, zero npm dependencies) composing
 * `src/core/*` runtime subsystems (`NtCaptureController`, `RendererIpcController`,
 * `InboundPipeline`, `OutboundPipeline`, `ServerRuntime`), `src/bridge_onebot.js`
 * (`src/onebot/*`) codecs, and `src/actions/*` declarative OneBot v11 action routers.
 */

const path = require("path");
const { EventEmitter } = require("events");

const {
  MessageIdStore, UinUidStore, segmentsToCqCode,
  getNtqqVersionMetadata, buildNtqqUserAgent, pruneTempDir,
} = require("./bridge_onebot");
const { isAutoInstallDisabledFromEnv } = require("./core/env");
const {
  BridgeLogger, TtlDedupeSet, TempCleanupQueue, setBoundedMap, safeJsJson,
} = require("./core/primitives");
const {
  EchoCorrelator, _ntElementsSignature, _elementsSignatureMatch,
} = require("./core/echo_correlator");
const { HumanSessionController } = require("./core/session_controller");
const {
  encodeWsFrame, Rfc6455Connection, connectReverseWebSocket,
} = require("./core/ws_rfc6455");
const { loadBridgeConfig } = require("./core/config");
const {
  computeBkn, cookieObjToString, httpsGetCookies, httpRequestText, parseJsonpOrJson,
} = require("./core/web_http");
const {
  assertWebCredentialApiEnabled, fetchClientKey, getCookiesObject,
} = require("./core/qzone_actions");

const { NtCaptureController } = require("./core/nt_capture");
const { RendererIpcController } = require("./core/renderer_ipc");
const { InboundPipeline } = require("./core/inbound_pipeline");
const { OutboundPipeline } = require("./core/outbound_pipeline");
const { ServerRuntime } = require("./core/server_runtime");

const messageActions = require("./actions/message_actions");
const contactActions = require("./actions/contact_actions");
const groupActions = require("./actions/group_actions");
const fileMediaActions = require("./actions/file_media_actions");

/** @typedef {import("./types").BridgeOptions} BridgeOptions */
/** @typedef {import("./types").BridgeConfig} BridgeConfig */
/** @typedef {import("./types").CapturedServices} CapturedServices */
/** @typedef {import("./types").ActionContext} ActionContext */
/** @typedef {import("./types").OneBotActionResponse} OneBotActionResponse */

const WEB_HTTP_HELPERS = Object.freeze({
  computeBkn, cookieObjToString, httpsGetCookies, httpRequestText, parseJsonpOrJson,
});

const ACTION_MODULES = [messageActions, contactActions, groupActions, fileMediaActions];
/** @type {Map<string, (action: string, p: Record<string, any>, context?: any) => Promise<any>>} */
const ACTION_DISPATCH_MAP = new Map();
for (const mod of ACTION_MODULES) {
  for (const act of mod.HANDLED_ACTIONS) {
    if (ACTION_DISPATCH_MAP.has(act)) {
      throw new Error(`Duplicate OneBot action registration: ${act}`);
    }
    ACTION_DISPATCH_MAP.set(act, mod.dispatch);
  }
}

// ============================================================================
// Main Bridge Coordinator Class (`NtqqOneBotBridge`)
// ============================================================================

class NtqqOneBotBridge extends EventEmitter {
  /**
   * @param {BridgeOptions} [options={}]
   */
  constructor(options = {}) {
    super();
    this._configDir = options.configDir;
    /** @type {BridgeConfig} */
    this.config = options.config || loadBridgeConfig(options.configDir);
    this.messageIdStore = options.messageIdStore || new MessageIdStore(10000);
    this.uinUidStore = options.uinUidStore || new UinUidStore(20000);

    this.logger = new BridgeLogger({ getConfig: () => this.config });
    this.eventDedupe = new TtlDedupeSet(5000, 30000);
    this.tempCleanupQueue = new TempCleanupQueue(() => this.config);
    this.echoCorrelator = new EchoCorrelator({
      getSignatureFns: () => {
        const ctor = /** @type {typeof NtqqOneBotBridge} */ (this.constructor);
        return {
          _ntElementsSignature: ctor._ntElementsSignature,
          _elementsSignatureMatch: ctor._elementsSignatureMatch,
        };
      },
    });
    this.sessionController = new HumanSessionController({
      getConfig: () => this.config,
      invokeNt: (cmd, payload, positionalArgs) => this.invokeNt(cmd, payload, positionalArgs),
      canInvokeRenderer: () => this._canInvokeRendererBridge(),
      invokeRendererCommand: (action, payload, timeoutMs) =>
        this._invokeRendererBridgeCommand(action, payload, timeoutMs),
      getRendererHooks: () => ({
        simulateSession: this.rendererSimulateSession,
        leaveSession: this.rendererLeaveSession,
      }),
    });

    this.selfUin = String(options.selfUin || this.config.selfUin || "");
    this.selfUid = String(options.selfUid || "");
    this.selfNickname = String(options.selfNickname || this.config.selfNickname || "QQBot");
    this._initStorePersistence(options);
    this.startedAtMs = Number.isFinite(Number(options.startedAtMs))
      ? Number(options.startedAtMs)
      : Date.now();
    const isLiveElectron = Boolean(
      process.versions?.electron &&
        !options.ntApi &&
        !options.wrapperSession &&
        !options.rendererExecute
    );
    this.online = options.online !== undefined ? Boolean(options.online) : !isLiveElectron;
    this.lastQrCodeBase64 = "";

    /** @type {CapturedServices} */
    this.capturedServices = {
      ntApi: options.ntApi || null, ntApiContainer: null, ntStore: null,
      WindowApi: null, PerformanceApi: null, LoggerApi: null,
      UserBehaviorReportService: null, SubWindowApi: null, ScreenRecordApi: null,
      ntCall: null, ntSessionManager: options.ntSessionManager || null,
      wrapperSession: options.wrapperSession || null,
    };

    this.rendererExecute = options.rendererExecute || null;
    this.rendererSimulateSession = options.rendererSimulateSession || null;
    this.rendererLeaveSession = options.rendererLeaveSession || null;

    // Composed Core Subsystems
    this.ntCapture = new NtCaptureController(this);
    this.rendererIpc = new RendererIpcController(this);
    this.inboundPipeline = new InboundPipeline(this);
    this.outboundPipeline = new OutboundPipeline(this);
    this.serverRuntime = new ServerRuntime(this);
  }

  /**
   * @param {BridgeOptions} [options={}]
   */
  _initStorePersistence(options = {}) {
    const stateDir = typeof this.config?.stateDir === "string" ? this.config.stateDir.trim() : "";
    if (!stateDir || this.config?.persistStores === false) return;
    const rawTag = String(this.config?.selfUin || options.selfUin || "").trim();
    const uinTag = rawTag ? `_${rawTag.replace(/[^0-9a-zA-Z_-]/g, "")}` : "";
    const debounceMs = Number.isFinite(Number(this.config?.statePersistDebounceMs))
      ? Math.max(0, Math.trunc(Number(this.config.statePersistDebounceMs)))
      : 1500;
    const msgStorePath = path.join(stateDir, `.rosmontis_state_messages${uinTag}.json`);
    const uinUidStorePath = path.join(stateDir, `.rosmontis_state_uin_uid${uinTag}.json`);

    if (!options.messageIdStore && this.messageIdStore) {
      this.messageIdStore.loadFromFileSync?.(msgStorePath);
      this.messageIdStore.enableAutoPersist?.(msgStorePath, { debounceMs });
    }
    if (!options.uinUidStore && this.uinUidStore) {
      this.uinUidStore.loadFromFileSync?.(uinUidStorePath);
      this.uinUidStore.enableAutoPersist?.(uinUidStorePath, { debounceMs });
    }
  }

  async flushStateStores() {
    await Promise.allSettled([
      this.messageIdStore?.flushPersist?.(),
      this.uinUidStore?.flushPersist?.(),
    ]);
  }

  // --------------------------------------------------------------------------
  // Primitive & Session Subsystem Accessors
  // --------------------------------------------------------------------------

  get _seenEventKeys() { return this.eventDedupe.entries; }
  set _seenEventKeys(v) { if (v instanceof Map) this.eventDedupe.entries = v; }
  get _tempCleanupRing() { return this.tempCleanupQueue.ring; }
  set _tempCleanupRing(v) { if (Array.isArray(v)) this.tempCleanupQueue._ring = v; }
  get _logThrottle() { return this.logger._throttleMap; }
  set _logThrottle(v) { if (v instanceof Map) this.logger._throttleMap = /** @type {any} */ (v); }
  get _sendEchoWaiters() { return this.echoCorrelator.waiters; }
  set _sendEchoWaiters(v) { if (v instanceof Map) this.echoCorrelator.waiters = v; }
  get sendEchoStats() { return this.echoCorrelator.stats; }
  set sendEchoStats(v) { if (v && typeof v === "object") this.echoCorrelator.stats = v; }
  get _activeAioPeer() { return this.sessionController.activeAioPeer; }
  set _activeAioPeer(v) { this.sessionController.activeAioPeer = v; }
  get _activeAioPeerKey() { return this.sessionController.activeAioPeerKey; }
  set _activeAioPeerKey(v) { this.sessionController.activeAioPeerKey = v; }
  get _windowFocused() { return this.sessionController.windowFocused; }
  set _windowFocused(v) { this.sessionController.windowFocused = Boolean(v); }
  get _aioIdleTimer() { return this.sessionController.aioIdleTimer; }
  set _aioIdleTimer(v) { this.sessionController.aioIdleTimer = v; }
  get _focusBlurTimer() { return this.sessionController.focusBlurTimer; }
  set _focusBlurTimer(v) { this.sessionController.focusBlurTimer = v; }
  get _aioInteractionSeq() { return this.sessionController.interactionSeq; }
  set _aioInteractionSeq(v) { this.sessionController.interactionSeq = Number(v) || 0; }
  get _recentReadByPeer() { return this.sessionController.recentReadByPeer; }
  get _recentTypingByPeer() { return this.sessionController.recentTypingByPeer; }
  get _sessionScheduler() { return this.sessionController.scheduler; }

  // --------------------------------------------------------------------------
  // Composed Subsystem State Accessors (Backward-Compatible Property Facade)
  // --------------------------------------------------------------------------

  // NtCaptureController state
  get _mapSetHook() { return this.ntCapture._mapSetHook; }
  set _mapSetHook(v) { this.ntCapture._mapSetHook = v; }
  get _mapHookMaxTimer() { return this.ntCapture._mapHookMaxTimer; }
  set _mapHookMaxTimer(v) { this.ntCapture._mapHookMaxTimer = v; }
  get _mapHookReleaseTimer() { return this.ntCapture._mapHookReleaseTimer; }
  set _mapHookReleaseTimer(v) { this.ntCapture._mapHookReleaseTimer = v; }
  get mapHookRelease() { return this.ntCapture.mapHookRelease; }
  set mapHookRelease(v) { this.ntCapture.mapHookRelease = v; }
  get _moduleLoadHook() { return this.ntCapture._moduleLoadHook; }
  set _moduleLoadHook(v) { this.ntCapture._moduleLoadHook = v; }
  get _attachedEmitters() { return this.ntCapture._attachedEmitters; }
  set _attachedEmitters(v) { if (v instanceof WeakSet) this.ntCapture._attachedEmitters = v; }

  // RendererIpcController state
  get activeWebContents() { return this.rendererIpc.activeWebContents; }
  set activeWebContents(v) { this.rendererIpc.activeWebContents = v; }
  get _knownWebContents() { return this.rendererIpc._knownWebContents; }
  set _knownWebContents(v) { if (v instanceof Set) this.rendererIpc._knownWebContents = v; }
  get _ipcAuthToken() { return this.rendererIpc._ipcAuthToken; }
  set _ipcAuthToken(v) { this.rendererIpc._ipcAuthToken = v; }
  get _pendingRendererCmds() { return this.rendererIpc._pendingRendererCmds; }
  set _pendingRendererCmds(v) { if (v instanceof Map) this.rendererIpc._pendingRendererCmds = v; }
  get _ipcCmdAckInstalled() { return this.rendererIpc._ipcCmdAckInstalled; }
  set _ipcCmdAckInstalled(v) { this.rendererIpc._ipcCmdAckInstalled = Boolean(v); }
  get invokeStats() { return this.rendererIpc.invokeStats; }
  set invokeStats(v) { if (v && typeof v === "object") this.rendererIpc.invokeStats = v; }
  get rendererHealthStats() { return this.rendererIpc.rendererHealthStats; }
  set rendererHealthStats(v) { this.rendererIpc.rendererHealthStats = v; }
  get _rendererReloadTimestamps() { return this.rendererIpc._rendererReloadTimestamps; }
  set _rendererReloadTimestamps(v) { this.rendererIpc._rendererReloadTimestamps = v; }
  get _rendererReloadTimers() { return this.rendererIpc._rendererReloadTimers; }
  set _rendererReloadTimers(v) { this.rendererIpc._rendererReloadTimers = v; }

  // InboundPipeline state
  get _pttTextWaiters() { return this.inboundPipeline._pttTextWaiters; }
  set _pttTextWaiters(v) { this.inboundPipeline._pttTextWaiters = v; }
  get _richMediaWaiters() { return this.inboundPipeline._richMediaWaiters; }
  set _richMediaWaiters(v) { this.inboundPipeline._richMediaWaiters = v; }
  get _groupNotifiesCache() { return this.inboundPipeline._groupNotifiesCache; }
  set _groupNotifiesCache(v) { this.inboundPipeline._groupNotifiesCache = v; }
  get _buddyReqsCache() { return this.inboundPipeline._buddyReqsCache; }
  set _buddyReqsCache(v) { this.inboundPipeline._buddyReqsCache = v; }
  get _groupListCache() { return this.inboundPipeline._groupListCache; }
  set _groupListCache(v) { this.inboundPipeline._groupListCache = v; }
  get _buddyCategoriesCache() { return this.inboundPipeline._buddyCategoriesCache; }
  set _buddyCategoriesCache(v) { this.inboundPipeline._buddyCategoriesCache = v; }
  get _groupListWaiters() { return this.inboundPipeline._groupListWaiters; }
  set _groupListWaiters(v) { this.inboundPipeline._groupListWaiters = v; }
  get _qrCodeWaiters() { return this.inboundPipeline._qrCodeWaiters; }
  set _qrCodeWaiters(v) { this.inboundPipeline._qrCodeWaiters = v; }
  get _buddyListWaiters() { return this.inboundPipeline._buddyListWaiters; }
  set _buddyListWaiters(v) { this.inboundPipeline._buddyListWaiters = v; }
  get _profileDetailWaiters() { return this.inboundPipeline._profileDetailWaiters; }
  set _profileDetailWaiters(v) { this.inboundPipeline._profileDetailWaiters = v; }
  get _doubtBuddyWaiters() { return this.inboundPipeline._doubtBuddyWaiters; }
  set _doubtBuddyWaiters(v) { this.inboundPipeline._doubtBuddyWaiters = v; }
  get _recentSentMsgByPeer() { return this.inboundPipeline._recentSentMsgByPeer; }
  set _recentSentMsgByPeer(v) { this.inboundPipeline._recentSentMsgByPeer = v; }
  get _autoQuickLoginAttempts() { return this.inboundPipeline._autoQuickLoginAttempts; }
  set _autoQuickLoginAttempts(v) { this.inboundPipeline._autoQuickLoginAttempts = v; }
  get _lastAutoQuickLoginAt() { return this.inboundPipeline._lastAutoQuickLoginAt; }
  set _lastAutoQuickLoginAt(v) { this.inboundPipeline._lastAutoQuickLoginAt = v; }

  // OutboundPipeline state
  get rateLimiter() { return this.outboundPipeline.rateLimiter; }
  set rateLimiter(v) { this.outboundPipeline.rateLimiter = v; }

  // ServerRuntime state
  get _httpServers() { return this.serverRuntime._httpServers; }
  set _httpServers(v) { this.serverRuntime._httpServers = v; }
  get _wsServers() { return this.serverRuntime._wsServers; }
  set _wsServers(v) { this.serverRuntime._wsServers = v; }
  get _wsServerClients() { return this.serverRuntime._wsServerClients; }
  set _wsServerClients(v) { this.serverRuntime._wsServerClients = v; }
  get _reverseWsClients() { return this.serverRuntime._reverseWsClients; }
  set _reverseWsClients(v) {
    this.serverRuntime._reverseWsClients = v;
    this.serverRuntime._wsClientHandles = v;
  }
  get _wsClientHandles() { return this.serverRuntime._wsClientHandles; }
  set _wsClientHandles(v) { this.serverRuntime._wsClientHandles = v; }
  get _activeWebhookReqs() { return this.serverRuntime._activeWebhookReqs; }
  set _activeWebhookReqs(v) { this.serverRuntime._activeWebhookReqs = v; }
  get _webhookRetryTimers() { return this.serverRuntime._webhookRetryTimers; }
  set _webhookRetryTimers(v) { this.serverRuntime._webhookRetryTimers = v; }
  get _webhookQueue() { return this.serverRuntime._webhookQueue; }
  set _webhookQueue(v) { this.serverRuntime._webhookQueue = v; }
  get _webhookGeneration() { return this.serverRuntime._webhookGeneration; }
  set _webhookGeneration(v) { this.serverRuntime._webhookGeneration = v; }
  get webhookStats() { return this.serverRuntime.webhookStats; }
  set webhookStats(v) { this.serverRuntime.webhookStats = v; }
  get _sighupHandler() { return this.serverRuntime._sighupHandler; }
  set _sighupHandler(v) { this.serverRuntime._sighupHandler = v; }
  get listenErrors() { return this.serverRuntime.listenErrors; }
  set listenErrors(v) { this.serverRuntime.listenErrors = v; }
  get _heartbeatTimer() { return this.serverRuntime._heartbeatTimer; }
  set _heartbeatTimer(v) { this.serverRuntime._heartbeatTimer = v; }
  get _wsPingTimer() { return this.serverRuntime._wsPingTimer; }
  set _wsPingTimer(v) { this.serverRuntime._wsPingTimer = v; }
  get _stopped() { return this.serverRuntime._stopped; }
  set _stopped(v) { this.serverRuntime._stopped = Boolean(v); }
  get _pendingNetworkRestart() { return this.serverRuntime._pendingNetworkRestart; }
  set _pendingNetworkRestart(v) { this.serverRuntime._pendingNetworkRestart = v; }
  get wsClients() { return this.serverRuntime._wsServerClients; }
  get reverseWsClients() { return this.serverRuntime._reverseWsClients; }

  // --------------------------------------------------------------------------
  // Shared Primitive & Session Delegates
  // --------------------------------------------------------------------------

  /** @param {any} val */
  _safeJsJson(val) { return safeJsJson(val); }
  /**
   * @param {Map<any, any>} map
   * @param {any} key
   * @param {any} value
   * @param {number} [maxEntries=2000]
   */
  _setBoundedMap(map, key, value, maxEntries = 2000) { return setBoundedMap(map, key, value, maxEntries); }
  /**
   * @param {string} key
   * @param {string} msg
   * @param {number} [windowMs=60000]
   */
  _logWarn(key, msg, windowMs = 60000) { return this.logger.warnThrottled(key, msg, windowMs); }
  /**
   * @param {Array<() => void> | (() => void)} cbs
   * @param {boolean} [immediate]
   */
  _scheduleTempCleanup(cbs, immediate) { return this.tempCleanupQueue.schedule(cbs, immediate); }
  /** @param {any} media */
  _scheduleMediaCleanup(media) { return this.tempCleanupQueue.scheduleMedia(media); }
  flushTempCleanup() { return this.tempCleanupQueue.flush(); }
  /**
   * @param {string} key
   * @param {number} [ttlMs=30000]
   */
  _isDuplicateEvent(key, ttlMs = 30000) { return this.eventDedupe.isDuplicate(key, ttlMs); }
  _canInvokeRendererBridge() { return Boolean(this._canInvokeRenderer(this.activeWebContents)); }
  /**
   * @param {string} action
   * @param {Record<string, any>} payload
   * @param {number} [timeoutMs]
   */
  _invokeRendererBridgeCommand(action, payload, timeoutMs) { return this._invokeRendererCommand(action, payload, timeoutMs); }

  /**
   * @param {() => Promise<any>} fn
   * @param {Record<string, any>} [options]
   */
  _withAioLock(fn, options) { return this.sessionController.withLock(fn, options); }
  _clearAioIdleTimers() { return this.sessionController.clearIdleTimers(); }
  _clearIdleTimers() { return this.sessionController.clearIdleTimers(); }
  /** @param {Record<string, any>} [opts] */
  _resetSessionState(opts) { return this.sessionController.reset(opts || undefined); }
  /** @param {Record<string, any>} [opts] */
  _resetHumanSessionState(opts) { return this.sessionController.reset(opts || undefined); }
  _touchAioActivity() { return this.sessionController.touchActivity(); }
  /** @param {Record<string, any>} [opts] */
  _leaveSessionUnlocked(opts) { return this.sessionController.leaveUnlocked(opts); }
  /** @param {Record<string, any>} [opts] */
  _leaveSession(opts) { return this.sessionController.leave(opts); }
  /** @param {Record<string, any>} [opts] */
  leaveHumanSession(opts) { return this.sessionController.leave(opts); }
  /** @param {Record<string, any>} [opts] */
  _activateSessionUnlocked(opts) { return this.sessionController.activateUnlocked(opts); }
  /** @param {Record<string, any>} [opts] */
  simulateHumanSession(opts) { return this.sessionController.simulate(opts); }

  // --------------------------------------------------------------------------
  // Composed Subsystem Method Delegates
  // --------------------------------------------------------------------------

  // 1. NtCaptureController
  installMapPrototypeHook() { return this.ntCapture.installMapPrototypeHook(); }
  /** @param {string} [reason] */
  releaseMapPrototypeHook(reason) { return this.ntCapture.releaseMapPrototypeHook(reason); }
  installWrapperHook() { return this.ntCapture.installWrapperHook(); }
  /** @param {Record<string, any>} [options] */
  probeExistingRuntime(options) { return this.ntCapture.probeExistingRuntime(options); }
  _mapHookReleaseDisabled() { return this.ntCapture._mapHookReleaseDisabled(); }
  _maybeScheduleMapHookRelease() { return this.ntCapture._maybeScheduleMapHookRelease(); }
  /**
   * @param {any} mapInstance
   * @param {any} k
   * @param {any} v
   */
  _inspectMapEntry(mapInstance, k, v) { return this.ntCapture._inspectMapEntry(mapInstance, k, v); }
  /** @param {any} obj */
  _inspectInversifyCache(obj) { return this.ntCapture._inspectInversifyCache(obj); }
  /** @param {any} ntStore */
  _inspectNtStore(ntStore) { return this.ntCapture._inspectNtStore(ntStore); }
  /** @param {any} emitter */
  _attachNtStoreRootEmitter(emitter) { return this.ntCapture._attachNtStoreRootEmitter(emitter); }
  /**
   * @param {string} listenerName
   * @param {any} emitterOrMap
   */
  _attachKernelListenerEmitter(listenerName, emitterOrMap) {
    return this.ntCapture._attachKernelListenerEmitter(listenerName, emitterOrMap);
  }
  /** @param {Record<string, any>} [identity] */
  _updateSelfIdentity(identity) { return this.ntCapture._updateSelfIdentity(identity); }
  _reconnectUnidentifiedReverseWs() { return this.ntCapture._reconnectUnidentifiedReverseWs(); }

  // 2. RendererIpcController
  /** @param {any} [electronModule] */
  installElectronHooks(electronModule) { return this.rendererIpc.installElectronHooks(electronModule); }
  /**
   * @param {string} cmd
   * @param {Record<string, any>} [payload]
   * @param {any[] | null} [positionalArgs]
   * @param {{ preferMainProcess?: boolean, timeoutMs?: number } | null} [invokeOptions]
   */
  invokeNt(cmd, payload, positionalArgs, invokeOptions) {
    return this.rendererIpc.invokeNt(cmd, payload, positionalArgs, invokeOptions);
  }
  /** @param {any} url */
  _isTrustedRendererUrl(url) { return this.rendererIpc._isTrustedRendererUrl(url); }
  /**
   * @param {any} event
   * @param {any} payload
   */
  _isTrustedIpcEvent(event, payload) { return this.rendererIpc._isTrustedIpcEvent(event, payload); }
  /**
   * @param {any} event
   * @param {any} ack
   */
  _handleRendererCmdAck(event, ack) { return this.rendererIpc._handleRendererCmdAck(event, ack); }
  _ensureRendererHealthStats() { return this.rendererIpc._ensureRendererHealthStats(); }
  /** @param {any} [webContents] */
  _clearRendererReloadTimers(webContents) { return this.rendererIpc._clearRendererReloadTimers(webContents); }
  /**
   * @param {any} [webContents]
   * @param {string} [reason]
   */
  _rejectPendingRendererCmds(webContents, reason) {
    return this.rendererIpc._rejectPendingRendererCmds(webContents, reason);
  }
  /** @param {any} wc */
  _isWebContentsAlive(wc) { return this.rendererIpc._isWebContentsAlive(wc); }
  /** @param {any} wc */
  _canInvokeRenderer(wc) { return this.rendererIpc._canInvokeRenderer(wc); }
  /** @param {any} url */
  _isMainChatUrl(url) { return this.rendererIpc._isMainChatUrl(url); }
  /** @param {any} wc */
  _shouldPromoteWebContents(wc) { return this.rendererIpc._shouldPromoteWebContents(wc); }
  /** @param {any} wc */
  _attachToWebContents(wc) { return this.rendererIpc._attachToWebContents(wc); }
  /** @param {any} val */
  _reviveBridgeResult(val) { return this.rendererIpc._reviveBridgeResult(val); }
  /** @param {any} val */
  _reviveBridgePayload(val) { return this.rendererIpc._reviveBridgePayload(val); }
  /** @param {any} rawData */
  _handleRendererForwardedEvent(rawData) { return this.rendererIpc._handleRendererForwardedEvent(rawData); }
  /** @param {any} value */
  _serializeBridgeArgs(value) { return this.rendererIpc._serializeBridgeArgs(value); }
  /** @param {any} value */
  _serializeBridgePayload(value) { return this.rendererIpc._serializeBridgePayload(value); }
  /**
   * @param {string} type
   * @param {Record<string, any>} [cmdPayload]
   * @param {number} [timeoutMs]
   */
  _invokeRendererCommand(type, cmdPayload, timeoutMs) {
    return this.rendererIpc._invokeRendererCommand(type, cmdPayload, timeoutMs);
  }
  /**
   * @param {string} key
   * @param {string} message
   */
  _logInvokeWarning(key, message) { return this.rendererIpc._logInvokeWarning(key, message); }

  // 3. InboundPipeline
  /** @param {any} v */
  _isPositiveUin(v) { return this.inboundPipeline._isPositiveUin(v); }
  _isNtReady() { return this.inboundPipeline._isNtReady(); }
  /** @param {any} ev */
  _dispatchInboundEvent(ev) { return this.inboundPipeline._dispatchInboundEvent(ev); }
  /** @param {any} uid */
  _ensureUinForUid(uid) { return this.inboundPipeline._ensureUinForUid(uid); }
  /** @param {any} ntMsg */
  _resolveNtMsgUids(ntMsg) { return this.inboundPipeline._resolveNtMsgUids(ntMsg); }
  /** @param {any} ntMsg */
  _enqueueInboundNtMessage(ntMsg) { return this.inboundPipeline._enqueueInboundNtMessage(ntMsg); }
  /**
   * @param {string} listenerName
   * @param {string} eventName
   * @param {any[]} args
   */
  _handleKernelEvent(listenerName, eventName, args) {
    return this.inboundPipeline._handleKernelEvent(listenerName, eventName, args);
  }
  /** @param {any} ntMsg */
  _processIncomingNtMessage(ntMsg) { return this.inboundPipeline._processIncomingNtMessage(ntMsg); }
  /** @param {any} firstArg */
  _handleRichMediaDownloadComplete(firstArg) {
    return this.inboundPipeline._handleRichMediaDownloadComplete(firstArg);
  }
  /** @param {Record<string, any>} [options] */
  _downloadRichMediaElement(options) { return this.inboundPipeline._downloadRichMediaElement(options); }
  /**
   * @param {any} ntMsg
   * @param {Record<string, any>} [options]
   */
  _hydrateNtMsgMedia(ntMsg, options) { return this.inboundPipeline._hydrateNtMsgMedia(ntMsg, options); }
  /**
   * @param {any} rawIdentity
   * @param {{ markOnline?: boolean }} [options]
   */
  _syncSelfIdentityFromLogin(rawIdentity, options) {
    return this.inboundPipeline._syncSelfIdentityFromLogin(rawIdentity, options);
  }
  /**
   * @param {string} eventName
   * @param {any[]} args
   */
  _handleLoginKernelEvent(eventName, args) {
    return this.inboundPipeline._handleLoginKernelEvent(eventName, args);
  }
  /** @param {Record<string, any>} [options] */
  _tryAutoQuickLogin(options) { return this.inboundPipeline._tryAutoQuickLogin(options); }

  // 4. OutboundPipeline
  _ensureRateLimiter() { return this.outboundPipeline._ensureRateLimiter(); }
  /** @param {string} peerKey */
  _enforceOutboundRateLimit(peerKey) { return this.outboundPipeline._enforceOutboundRateLimit(peerKey); }
  _ensureEchoCorrelator() { return this.outboundPipeline._ensureEchoCorrelator(); }
  /**
   * @param {any} userId
   * @param {any} [groupId]
   */
  _resolvePeerForUser(userId, groupId) { return this.outboundPipeline._resolvePeerForUser(userId, groupId); }
  /**
   * @param {any} media
   * @param {number} [subType]
   */
  _prepareNtImagePath(media, subType) { return this.outboundPipeline._prepareNtImagePath(media, subType); }
  /** @param {any} media */
  _prepareNtRecordPath(media) { return this.outboundPipeline._prepareNtRecordPath(media); }
  /**
   * @param {any} media
   * @param {any} thumbInfo
   */
  _prepareNtVideoPath(media, thumbInfo) { return this.outboundPipeline._prepareNtVideoPath(media, thumbInfo); }
  /** @param {any} peer */
  _sendPeerKey(peer) { return this.outboundPipeline._sendPeerKey(peer); }
  /**
   * @param {any} peer
   * @param {any} elements
   * @param {((ntMsg: any) => boolean) | null} [elementPredicate]
   */
  _registerSendEchoWaiter(peer, elements, elementPredicate) {
    return this.outboundPipeline._registerSendEchoWaiter(peer, elements, elementPredicate);
  }
  /** @param {any} ntMsg */
  _matchSendEcho(ntMsg) { return this.outboundPipeline._matchSendEcho(ntMsg); }
  /** @param {any[]} elements */
  _hasRichMediaElements(elements) { return this.outboundPipeline._hasRichMediaElements(elements); }
  /** @param {any[]} elements */
  _computeSendEchoTimeoutMs(elements) { return this.outboundPipeline._computeSendEchoTimeoutMs(elements); }
  _mediaSecurityOptions() { return this.outboundPipeline._mediaSecurityOptions(); }
  /**
   * @param {any} peer
   * @param {any} message
   * @param {boolean} [autoEscape]
   * @param {any} [groupId]
   * @param {Record<string, any>} [options]
   */
  _sendMessageToPeer(peer, message, autoEscape, groupId, options) {
    return this.outboundPipeline._sendMessageToPeer(peer, message, autoEscape, groupId, options);
  }
  /**
   * @param {any} peer
   * @param {() => Promise<any>} invokeFn
   * @param {string} [fallbackSeed]
   */
  _invokeForwardWithEcho(peer, invokeFn, fallbackSeed) {
    return this.outboundPipeline._invokeForwardWithEcho(peer, invokeFn, fallbackSeed);
  }
  /**
   * @param {any} groupId
   * @param {any} userId
   */
  _sendPokeInternal(groupId, userId) { return this.outboundPipeline._sendPokeInternal(groupId, userId); }

  // 5. ServerRuntime
  startServers() { return this.serverRuntime.startServers(); }
  stopServers() { return this.serverRuntime.stopServers(); }
  /** @param {Record<string, any>} [options] */
  reloadConfig(options) { return this.serverRuntime.reloadConfig(options); }
  /**
   * @param {any} req
   * @param {string | undefined} expectedToken
   * @param {URL | null} [parsedUrl]
   */
  _checkAuth(req, expectedToken, parsedUrl) {
    return this.serverRuntime._checkAuth(req, expectedToken, parsedUrl);
  }
  _computeReadiness() { return this.serverRuntime._computeReadiness(); }
  _formatPrometheusMetrics() { return this.serverRuntime._formatPrometheusMetrics(); }
  /**
   * @param {any} rawText
   * @param {(payload: any) => void} sendJsonFn
   * @param {Record<string, any>} [actionContext]
   */
  _handleWsActionMessage(rawText, sendJsonFn, actionContext) {
    return this.serverRuntime._handleWsActionMessage(rawText, sendJsonFn, actionContext);
  }
  /** @param {any} event */
  _dispatchHttpWebhookEvent(event) { return this.serverRuntime._dispatchHttpWebhookEvent(event); }
  /**
   * @param {Record<string, any>} clientCfg
   * @param {any} event
   */
  _postEventToHttpClient(clientCfg, event) {
    return this.serverRuntime._postEventToHttpClient(clientCfg, event);
  }
  _stopNetworkRuntime() { return this.serverRuntime._stopNetworkRuntime(); }

  // --------------------------------------------------------------------------
  // Event Formatting & Broadcast
  // --------------------------------------------------------------------------

  /**
   * @param {any} eventObj
   * @param {string} messageFormat
   */
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

  /** @param {any} event */
  broadcastOneBotEvent(event) {
    if (!event || typeof event !== "object") return;
    if (!event.self_id && this.selfUin) {
      event.self_id = Number(this.selfUin);
    }
    const defaultFormat = this.config.messageFormat || "array";
    this.emit("onebot_event", this._formatEventForEndpoint(event, defaultFormat));

    for (const client of this._wsServerClients) {
      if (client.closed) {
        this._wsServerClients.delete(client);
        continue;
      }
      if (client._wsRole === "api") continue;
      if (event.post_type === "message_sent" && !client.reportSelfMessage) continue;
      const targetFormat = client._messageFormat || defaultFormat;
      client.sendJson(this._formatEventForEndpoint(event, targetFormat));
    }

    for (const rev of this._reverseWsClients) {
      if (!rev.conn || rev.conn.closed) continue;
      if (event.post_type === "message_sent" && !rev.cfg?.reportSelfMessage) continue;
      const targetFormat = rev.messageFormat || rev.cfg?.messageFormat || defaultFormat;
      rev.conn.sendJson(this._formatEventForEndpoint(event, targetFormat));
    }

    if (typeof this._dispatchHttpWebhookEvent === "function") {
      this._dispatchHttpWebhookEvent(event);
    }
  }

  // --------------------------------------------------------------------------
  // Credential Helper Delegates & OneBot v11 Action Dispatcher
  // --------------------------------------------------------------------------

  async _fetchClientKey() {
    assertWebCredentialApiEnabled(this.config, "get_clientkey");
    return await fetchClientKey(this);
  }

  /** @param {string} [domain="qun.qq.com"] */
  async _getCookiesObject(domain = "qun.qq.com") {
    assertWebCredentialApiEnabled(this.config, "get_cookies");
    return await getCookiesObject(this, domain, WEB_HTTP_HELPERS);
  }

  /**
   * @param {string} action
   * @param {Record<string, any>} [params={}]
   * @param {any} [echo=undefined]
   * @param {ActionContext} [context={}]
   * @returns {Promise<OneBotActionResponse>}
   */
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
    } catch (/** @type {any} */ err) {
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

  /**
   * @param {string} action
   * @param {Record<string, any>} p
   * @param {ActionContext} [context={}]
   */
  async _dispatchAction(action, p, context = {}) {
    const handler = ACTION_DISPATCH_MAP.get(action);
    if (!handler) {
      if (action === "reload_config" && typeof this.reloadConfig === "function") {
        return await this.reloadConfig(p);
      }
      throw new Error(`Unsupported OneBot action: ${action}`);
    }
    return await handler.call(this, action, p, context);
  }
}

NtqqOneBotBridge._ntElementsSignature = _ntElementsSignature;
NtqqOneBotBridge._elementsSignatureMatch = _elementsSignatureMatch;

// ============================================================================
// Bootstrap & Public Exports
// ============================================================================

/** @type {NtqqOneBotBridge | null} */
let singletonBridge = null;

/**
 * @param {BridgeOptions} [options={}]
 * @returns {NtqqOneBotBridge}
 */
function installMainBridge(options = {}) {
  if (singletonBridge && !options.forceNew) {
    if (options.config || options.configDir) {
      singletonBridge.config = options.config || loadBridgeConfig(options.configDir);
      const active = singletonBridge;
      active
        .stopServers()
        .then(() => {
          if (options.autoStartServers !== false) return active.startServers();
        })
        .catch((err) => {
          active.logger?.debug?.("bridge_main", err);
        });
    }
    return singletonBridge;
  }
  const bridge = new NtqqOneBotBridge(options);
  bridge.installMapPrototypeHook();
  bridge.installWrapperHook();
  bridge.installElectronHooks(options.electron);
  if (options.autoStartServers !== false) {
    bridge.startServers().catch((err) => {
      bridge.logger?.debug?.("bridge_main", err);
    });
  }
  singletonBridge = bridge;
  return bridge;
}

if (require.main !== module && !isAutoInstallDisabledFromEnv() && process.versions?.electron) {
  installMainBridge();
}

module.exports = {
  NtqqOneBotBridge, Rfc6455Connection, encodeWsFrame, connectReverseWebSocket,
  loadBridgeConfig, computeBkn, getNtqqVersionMetadata, buildNtqqUserAgent,
  pruneTempDir, installMainBridge,
};
