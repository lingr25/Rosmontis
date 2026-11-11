"use strict";

/**
 * NTQQ Main-Process & Renderer-Coordinated OneBot v11 Bridge (`bridge_main.js`)
 *
 * Pure JavaScript architecture with ZERO C++ `.so` hooks and ZERO external npm
 * dependencies.
 *
 * Architecture:
 * 1. Hooks `Map.prototype.set` before `908.background.js` runs to capture:
 *    - `"ntApi"` (and `"WindowApi"`, `"PerformanceApi"`, `"LoggerApi"`, `"UserBehaviorReportService"`)
 *    - InversifyJS `ntSessionManager` (`ntStore.listenerEventEmitterMap`, `createNt()`)
 *    - Live `NodeIQQNTWrapperSession` (`getMsgService()`, `getGroupService()`, etc.)
 * 2. Hooks `electron.app.on("web-contents-created")` to inject `bridge_renderer.js`
 *    into the QQ Renderer window and receive passive `__ROSMONTIS_BRIDGE_EVENT__` IPC.
 * 3. Provides 3-tier `invokeNt(cmd, payload, positionalArgs)`:
 *    - Tier 1: Renderer `window.__ROSMONTIS_RENDERER_BRIDGE__.invokeNtApi(cmd, [payload, null])`
 *    - Tier 2: Main-process `ntApi[cmd]([payload, null], ipcEvent)`
 *    - Tier 3: Direct `wrapperSession.get*Service()[method](...positionalArgs)`
 * 4. Implements all 65+ OneBot v11 actions for OneBot v11 ecosystems (including QZone,
 *    group files, forward messages, voice PTT to text, emoji likes, pokes, etc.).
 * 5. Includes zero-dependency RFC 6455 WebSocket Server (`:3001`), Reverse WebSocket
 *    Client, Forward WebSocket Server (`:3001`), and HTTP API Server (`:3000`).
 */

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const {
  MessageIdStore,
  UinUidStore,
  segmentsToCqCode,
  normalizeOneBotMessage,
  getNtqqVersionMetadata,
  buildNtqqUserAgent,
  pruneTempDir,
  resolveMediaSource,
  ntMsgToOneBotSegments,
  oneBotSegmentsToNtElements,
  formatNtMsgToOneBotEvent,
  formatGroupUploadNotice,
  formatNoticeEvent,
  formatRequestEvent,
  formatMetaEvent,
} = require("./bridge_onebot");

const {
  WS_GUID,
  encodeWsFrame,
  Rfc6455Connection,
  connectReverseWebSocket,
} = require("./core/ws_rfc6455");

const {
  DEFAULT_MAX_HTTP_BODY_BYTES,
  DEFAULT_MAX_WS_PAYLOAD_BYTES,
  sanitizeHeaderValue,
  verifyAccessTokenConstantTime,
  checkRequestAuth,
  checkOriginHeader,
  enforceProtectedModeOnServers,
  readHttpJsonBody,
} = require("./core/transport_security");

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
  WEB_CREDENTIAL_ACTIONS,
  isWebCredentialApiEnabled,
  assertWebCredentialApiEnabled,
  fetchClientKey,
  getCookiesObject,
  dispatchWebCredentialOrQzoneAction,
} = require("./core/qzone_actions");

const WEB_HTTP_HELPERS = Object.freeze({
  computeBkn,
  cookieObjToString,
  httpsGetCookies,
  httpRequestText,
  parseJsonpOrJson,
});

function safeJsJson(val) {
  const raw = JSON.stringify(val);
  if (typeof raw !== "string") return "undefined";
  return raw.replace(/[<>&\u2028\u2029]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}

// ============================================================================
// 1. Main Bridge Controller Class (`NtqqOneBotBridge`)
// ============================================================================

const SERVICE_GETTER_MAP = {
  nodeIKernelMsgService: "getMsgService",
  nodeIKernelGroupService: "getGroupService",
  nodeIKernelBuddyService: "getBuddyService",
  nodeIKernelProfileService: "getProfileService",
  nodeIKernelProfileLikeService: "getProfileLikeService",
  nodeIKernelRichMediaService: "getRichMediaService",
  nodeIKernelRecentContactService: "getRecentContactService",
  nodeIKernelTicketService: "getTicketService",
  nodeIKernelUixConvertService: "getUixConvertService",
  nodeIKernelOnlineStatusService: "getOnlineStatusService",
  nodeIKernelRobotService: "getRobotService",
  nodeIKernelSearchService: "getSearchService",
  nodeIKernelFileAssistantService: "getFileAssistantService",
  nodeIKernelUnitedConfigService: "getUnitedConfigService",
  nodeIKernelTipOffService: "getTipOffService",
  nodeIKernelNodeMiscService: "getNodeMiscService",
  nodeIKernelMiscService: "getNodeMiscService",
  nodeIKernelLoginService: "getLoginService",
};

// Native `Map.prototype.set`, captured at module load before any bridge hook is installed.
const NATIVE_MAP_SET = Map.prototype.set;

// Process-wide state of the temporary `Map.prototype.set` capture hook (one per process).
const MAP_HOOK_STATE = {
  owner: null, // NtqqOneBotBridge receiving captures
  hookFn: null, // our installed wrapper
  orig: null, // Map.prototype.set at install time
  inspecting: false, // re-entrancy guard
};

// Error tag for "this tier could not even dispatch the call" (renderer bridge not injected,
// ipcRenderer missing, webContents gone). Only such errors allow side-effect commands to
// fall through to the next tier; any other failure means the call may already have reached
// the kernel/server and must NOT be replayed.
const BRIDGE_UNAVAILABLE_TAG = "ROSMONTIS_BRIDGE_UNAVAILABLE";

// Kernel commands whose duplicate execution is user-visible or harmful (double messages,
// double recalls, repeated admin actions, burst retries under risk control).
const SIDE_EFFECT_NT_METHODS = new Set([
  "sendMsg",
  "forwardMsg",
  "forwardMsgWithComment",
  "multiForwardMsg",
  "multiForwardMsgWithComment",
  "recallMsg",
  "sendNudge",
  "sendPoke",
  "setMsgEmojiLikes",
  "sendShowInputStatusReq",
  "kickMember",
  "banMember",
  "quitGroup",
  "delBuddy",
  "approvalFriendRequest",
  "approvalDoubtBuddyReq",
  "operateSysNotify",
  "publishGroupBulletin",
  "addGroupEssence",
  "removeGroupEssence",
  "setBuddyProfileLike",
  "setBuddyRemark",
  "createGroupFolder",
  "deleteGroupFile",
  "deleteGroupFolder",
  "moveGroupFile",
  "transGroupFile",
  "modifyGroupName",
  "modifyGroupExtInfo",
  "modifyMemberRole",
  "modifyMemberCardName",
  "modifyMemberSpecialTitle",
  "setIdentityTitleInfo",
  "setHeader",
  "setLongNick",
  "modifySelfProfile",
  "modifyDesktopMiniProfile",
  "setOnlineStatus",
  "quickLogin",
  "quickLoginWithUin",
]);

function isSideEffectNtCmd(cmd) {
  const method = String(cmd || "").split("/").pop();
  return SIDE_EFFECT_NT_METHODS.has(method);
}

function makeBridgeUnavailableError(message) {
  const err = new Error(`${BRIDGE_UNAVAILABLE_TAG}: ${message}`);
  err.rosmontisUnavailable = true;
  return err;
}

function isBridgeUnavailableError(err) {
  if (!err) return false;
  if (err.rosmontisUnavailable === true) return true;
  return String(err.message || err).includes(BRIDGE_UNAVAILABLE_TAG);
}

let cachedRendererBridgeSource = null;

function getRendererBridgeSource() {
  if (cachedRendererBridgeSource !== null) {
    return cachedRendererBridgeSource;
  }
  try {
    const rendererPath = path.join(__dirname, "bridge_renderer.js");
    if (!fs.existsSync(rendererPath)) {
      cachedRendererBridgeSource = "";
      return "";
    }
    cachedRendererBridgeSource = fs.readFileSync(rendererPath, "utf8");
    return cachedRendererBridgeSource;
  } catch (_) {
    return "";
  }
}

class NtqqOneBotBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = options.config || loadBridgeConfig(options.configDir);
    this.messageIdStore = options.messageIdStore || new MessageIdStore(10000);
    this.uinUidStore = options.uinUidStore || new UinUidStore(20000);

    this.selfUin = String(options.selfUin || this.config.selfUin || "");
    this.selfUid = String(options.selfUid || "");
    this.selfNickname = String(options.selfNickname || this.config.selfNickname || "QQBot");
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

  // --------------------------------------------------------------------------
  // Event Deduplication & Broadcast
  // --------------------------------------------------------------------------

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
  // InversifyJS DI & `Map.prototype.set` Hook
  // --------------------------------------------------------------------------

  installMapPrototypeHook() {
    // Another bridge instance in this process (tests / hot reinstall) already owns our hook:
    // route captures to the newest instance instead of stacking a second wrapper.
    if (MAP_HOOK_STATE.hookFn && Map.prototype.set === MAP_HOOK_STATE.hookFn) {
      MAP_HOOK_STATE.owner = this;
      this._mapSetHook = MAP_HOOK_STATE.hookFn;
      this._scheduleMapHookMaxLifetime();
      return;
    }
    if (Map.prototype.__rosmontisBridgeHooked__) return;

    const origSet = Map.prototype.set;
    Object.defineProperty(Map.prototype, "__rosmontisBridgeHooked__", {
      value: true,
      enumerable: false,
      configurable: true,
    });

    const hookFn = function (k, v) {
      const res = origSet.call(this, k, v);
      const owner = MAP_HOOK_STATE.owner;
      if (owner && !MAP_HOOK_STATE.inspecting) {
        MAP_HOOK_STATE.inspecting = true;
        try {
          owner._inspectMapEntry(this, k, v);
        } catch (_) {
        } finally {
          MAP_HOOK_STATE.inspecting = false;
        }
      }
      return res;
    };

    MAP_HOOK_STATE.owner = this;
    MAP_HOOK_STATE.hookFn = hookFn;
    MAP_HOOK_STATE.orig = origSet;
    this._mapSetHook = hookFn;
    Map.prototype.set = hookFn;
    this._scheduleMapHookMaxLifetime();
  }

  _mapHookReleaseDisabled() {
    return (
      process.env.ROSMONTIS_KEEP_MAP_HOOK === "1" ||
      process.env.XIAO_BRIDGE_KEEP_MAP_HOOK === "1" ||
      this.config?.keepMapHook === true
    );
  }

  _scheduleMapHookMaxLifetime() {
    if (this._mapHookReleaseDisabled() || this._mapHookMaxTimer) return;
    const maxMs = Number(this.config?.mapHookMaxLifetimeMs ?? 10 * 60 * 1000);
    if (!(maxMs > 0)) return;
    this._mapHookMaxTimer = setTimeout(() => {
      this._mapHookMaxTimer = null;
      this.releaseMapPrototypeHook("max_lifetime");
    }, maxMs);
    if (typeof this._mapHookMaxTimer.unref === "function") this._mapHookMaxTimer.unref();
  }

  _mapHookCapturesComplete() {
    const cs = this.capturedServices;
    let hasNtApi = false;
    try {
      hasNtApi = Boolean(
        cs.ntApi &&
          (typeof cs.ntApi["nodeIKernelMsgService/sendMsg"] === "function" ||
            (cs.ntApi.invoke && typeof cs.ntApi.invoke["nodeIKernelMsgService/sendMsg"] === "function"))
      );
    } catch (_) {}
    return hasNtApi && Boolean(cs.ntStore) && Boolean(cs.wrapperSession || cs.ntSessionManager);
  }

  /**
   * Called after every successful capture. Once ntApi + ntStore + session are all captured,
   * schedule restoring the native `Map.prototype.set` (after a grace period so the second
   * `globalIPCMainMap` "ntApi" registration is still observed). Later kernel listeners keep
   * flowing through `ntStore.emitter`, the hooked `setNewListenEmitter`, the instance-level
   * `listenerEventEmitterMap.set` patch and the Inversify `binding.cache` watchers.
   */
  _maybeScheduleMapHookRelease() {
    if (!this._mapSetHook || this._mapHookReleaseTimer || this._mapHookReleaseDisabled()) return;
    if (MAP_HOOK_STATE.owner !== this) return;
    if (!this._mapHookCapturesComplete()) return;
    const delayMs = Math.max(0, Number(this.config?.mapHookReleaseDelayMs ?? 15000));
    this._mapHookReleaseTimer = setTimeout(() => {
      this._mapHookReleaseTimer = null;
      this.releaseMapPrototypeHook("captured");
    }, delayMs);
    if (typeof this._mapHookReleaseTimer.unref === "function") this._mapHookReleaseTimer.unref();
  }

  releaseMapPrototypeHook(reason = "manual") {
    for (const key of ["_mapHookReleaseTimer", "_mapHookMaxTimer"]) {
      if (this[key]) {
        clearTimeout(this[key]);
        this[key] = null;
      }
    }
    if (!this._mapSetHook || MAP_HOOK_STATE.owner !== this || MAP_HOOK_STATE.hookFn !== this._mapSetHook) {
      return false;
    }
    let restored = false;
    if (Map.prototype.set === MAP_HOOK_STATE.hookFn) {
      Map.prototype.set = MAP_HOOK_STATE.orig;
      try {
        delete Map.prototype.__rosmontisBridgeHooked__;
      } catch (_) {}
      restored = true;
    }
    // If something wrapped Map.prototype.set on top of us we can not unlink safely; with no
    // owner our hook degrades to a pure pass-through.
    MAP_HOOK_STATE.owner = null;
    MAP_HOOK_STATE.hookFn = restored ? null : MAP_HOOK_STATE.hookFn;
    this._mapSetHook = null;
    this.mapHookRelease = { reason, restored, at: Date.now() };
    this._restoreModuleLoad();

    const missing = [];
    if (!this.capturedServices.ntApi) missing.push("ntApi");
    if (!this.capturedServices.ntStore) missing.push("ntStore");
    if (!this.capturedServices.wrapperSession && !this.capturedServices.ntSessionManager) missing.push("session");
    this._logWarn(
      "map-hook-release",
      `Map.prototype.set hook released (reason=${reason}, restored=${restored}${
        missing.length ? `, missing=${missing.join("/")}` : ""
      })`,
      0
    );
    return restored;
  }

  installWrapperHook() {
    try {
      const Module = require("module");
      if (!Module || Module._load.__rosmontisWrapperHooked__) return;
      const origLoad = Module._load;
      const self = this;
      const wrappedLoad = function (request, parent, isMain) {
        const exp = origLoad.apply(this, [request, parent, isMain]);
        try {
          if (typeof request === "string" && request.includes("wrapper.node") && exp) {
            if (self._hookWrapperExports(exp)) {
              // wrapper.node is loaded once per process; stop intercepting every require().
              self._restoreModuleLoad();
            }
          }
        } catch (_) {}
        return exp;
      };
      Object.defineProperty(wrappedLoad, "__rosmontisWrapperHooked__", {
        value: true,
        enumerable: false,
      });
      Module._load = wrappedLoad;
      this._moduleLoadHook = { Module, origLoad, wrappedLoad };
    } catch (_) {}
  }

  _restoreModuleLoad() {
    const h = this._moduleLoadHook;
    if (!h) return false;
    this._moduleLoadHook = null;
    if (h.Module._load === h.wrappedLoad) {
      h.Module._load = h.origLoad;
      return true;
    }
    return false;
  }

  _hookWrapperExports(wrapperExports) {
    if (!wrapperExports || typeof wrapperExports !== "object") return false;
    const self = this;
    const SessionClass = wrapperExports.NodeIQQNTWrapperSession;
    if (!SessionClass) return false;
    if (!SessionClass.__rosmontisHookedSessionClass__) {
      try {
        Object.defineProperty(SessionClass, "__rosmontisHookedSessionClass__", {
          value: true,
          enumerable: false,
        });
        for (const staticFn of ["get", "create", "getNTWrapperSession"]) {
          if (typeof SessionClass[staticFn] === "function") {
            const origFn = SessionClass[staticFn].bind(SessionClass);
            SessionClass[staticFn] = function (...args) {
              const inst = origFn(...args);
              if (inst && typeof inst === "object") {
                self.capturedServices.wrapperSession = inst;
                self._maybeScheduleMapHookRelease();
              }
              return inst;
            };
          }
        }
      } catch (_) {}
    }
    return true;
  }

  _inspectMapEntry(_mapInstance, k, v) {
    // 1. String keys in Inversify or globalIPCMainMap or listenerEventEmitterMap
    if (typeof k === "string") {
      if (k === "ntApi" && v) {
        // First registration is the direct ntApi route Proxy; second registration in
        // globalIPCMainMap is `{ emit: Proxy, invoke: Proxy }` where `v.invoke` is the route Proxy.
        if (typeof v["nodeIKernelMsgService/sendMsg"] === "function") {
          this.capturedServices.ntApi = v;
        } else if (
          v.invoke &&
          typeof v.invoke["nodeIKernelMsgService/sendMsg"] === "function"
        ) {
          this.capturedServices.ntApi = v.invoke;
        } else if (!this.capturedServices.ntApi) {
          this.capturedServices.ntApi = v;
        }
        this.capturedServices.ntApiContainer = v;
        this._maybeScheduleMapHookRelease();
        return;
      }
      if (
        k === "WindowApi" ||
        k === "PerformanceApi" ||
        k === "LoggerApi" ||
        k === "UserBehaviorReportService" ||
        k === "SubWindowApi" ||
        k === "ScreenRecordApi" ||
        k === "ntCall"
      ) {
        this.capturedServices[k] = v;
        return;
      }
      if (k.startsWith("nodeIKernel") && k.endsWith("Listener") && v) {
        this._attachKernelListenerEmitter(k, v);
        return;
      }
    }

    // 2. Symbol or Inversify binding arrays: [{ cache, implementationType, type }]
    if (Array.isArray(v)) {
      for (const binding of v) {
        if (!binding || typeof binding !== "object") continue;
        if (binding.cache) {
          this._inspectInversifyCache(binding.cache);
        } else if ("cache" in binding) {
          this._watchBindingCacheProperty(binding);
        }
      }
    } else if (v && typeof v === "object") {
      this._inspectInversifyCache(v);
    }
  }

  _watchBindingCacheProperty(binding) {
    if (binding.__rosmontisWatched__) return;
    try {
      Object.defineProperty(binding, "__rosmontisWatched__", {
        value: true,
        enumerable: false,
      });
      let currentCache = binding.cache;
      const self = this;
      Object.defineProperty(binding, "cache", {
        configurable: true,
        enumerable: true,
        get() {
          return currentCache;
        },
        set(newVal) {
          currentCache = newVal;
          try {
            self._inspectInversifyCache(newVal);
          } catch (_) {}
        },
      });
    } catch (_) {}
  }

  _updateSelfIdentity({ uin, uid, nick, markOnline = false } = {}) {
    const prevUin = this.selfUin;
    if (uin && /^\d+$/.test(String(uin))) {
      this.selfUin = String(uin);
    }
    if (uid && String(uid).trim()) {
      this.selfUid = String(uid).trim();
    }
    if (nick && String(nick).trim()) {
      this.selfNickname = String(nick).trim();
    }
    if (this.selfUin && this.selfUid) {
      this.uinUidStore.record(this.selfUin, this.selfUid, {
        nick: this.selfNickname !== "QQBot" ? this.selfNickname : "",
      });
    }
    if (markOnline) {
      const wasOnline = this.online;
      this.online = true;
      if (!wasOnline && this.config.autoQuickLogin !== false && !this._persistedAutoLogin) {
        this._persistedAutoLogin = true;
        const t = setTimeout(() => {
          this.invokeNt("nodeIKernelLoginService/setAutoLogin", { shouldAutoLogin: true }, [true]).catch(() => {});
          this.invokeNt("nodeIKernelSettingService/setAutoLoginSwitch", { state: true }, [true]).catch(() => {});
        }, 1000);
        if (t && typeof t.unref === "function") t.unref();
      }
    }
    if ((!prevUin || prevUin === "0") && this.selfUin && this.selfUin !== "0") {
      this._reconnectUnidentifiedReverseWs();
    }
  }

  _reconnectUnidentifiedReverseWs() {
    if (!this.selfUin || this.selfUin === "0") return;
    for (const rev of this._reverseWsClients) {
      if (!rev.stopped && rev.conn && (!rev.connectedSelfId || rev.connectedSelfId === "0")) {
        rev.immediateReconnectOnce = true;
        try {
          rev.conn.close();
        } catch (_) {}
      }
    }
  }

  _inspectInversifyCache(obj) {
    if (!obj || typeof obj !== "object") return;
    const proto = Object.getPrototypeOf(obj) || {};

    // Check if obj is ntStore (has listenerEventEmitterMap, setNewListenEmitter, or emitter + session)
    if (
      obj.listenerEventEmitterMap instanceof Map ||
      typeof obj.setNewListenEmitter === "function" ||
      typeof proto.setNewListenEmitter === "function" ||
      (obj.emitter &&
        typeof obj.emitter.emit === "function" &&
        ("listenerEventEmitterMap" in obj || "wrapperSession" in obj || "session" in obj))
    ) {
      this._inspectNtStore(obj);
    }

    // Check if obj is ntSessionManager (has createNt or ntStore)
    if (
      typeof obj.createNt === "function" ||
      typeof proto.createNt === "function" ||
      (obj.ntStore && typeof obj.ntStore === "object")
    ) {
      this.capturedServices.ntSessionManager = obj;
      this._hookNtSessionManager(obj);
      this._maybeScheduleMapHookRelease();
    }

    // Check if obj is authMgr (has initAppSessionAndWindowPool) to auto-sync selfUin/selfUid/selfNickname
    if (
      typeof obj.initAppSessionAndWindowPool === "function" ||
      typeof proto.initAppSessionAndWindowPool === "function"
    ) {
      if (!obj.__rosmontisHookedAuthMgr__) {
        try {
          Object.defineProperty(obj, "__rosmontisHookedAuthMgr__", {
            value: true,
            enumerable: false,
          });
          const origInitPool = obj.initAppSessionAndWindowPool;
          const self = this;
          obj.initAppSessionAndWindowPool = function (authInfo, ...rest) {
            try {
              if (authInfo && typeof authInfo === "object") {
                self._updateSelfIdentity({
                  uin: authInfo.uin,
                  uid: authInfo.uid,
                  nick: authInfo.nick || authInfo.nickName,
                  markOnline: true,
                });
              }
            } catch (_) {}
            return origInitPool.apply(this, [authInfo, ...rest]);
          };
        } catch (_) {}
      }
    }

    // Check if obj is NodeIQQNTWrapperSession (has getMsgService & getGroupService)
    if (
      typeof obj.getMsgService === "function" ||
      typeof proto.getMsgService === "function"
    ) {
      this.capturedServices.wrapperSession = obj;
      this._maybeScheduleMapHookRelease();
    }
  }

  _inspectNtStore(ntStore) {
    if (!ntStore || typeof ntStore !== "object") return;
    this.capturedServices.ntStore = ntStore;
    if (ntStore.wrapperSession || ntStore.session) {
      this.capturedServices.wrapperSession = ntStore.wrapperSession || ntStore.session;
    }
    if (ntStore.emitter && typeof ntStore.emitter === "object") {
      this._attachNtStoreRootEmitter(ntStore.emitter);
    }
    if (ntStore.listenerEventEmitterMap instanceof Map) {
      for (const [listenerName, emitter] of ntStore.listenerEventEmitterMap.entries()) {
        this._attachKernelListenerEmitter(listenerName, emitter);
      }
      this._patchListenerEmitterMapInstance(ntStore.listenerEventEmitterMap);
    }
    if (typeof ntStore.setNewListenEmitter === "function" && !ntStore.__rosmontisHookedSetNew__) {
      try {
        Object.defineProperty(ntStore, "__rosmontisHookedSetNew__", {
          value: true,
          enumerable: false,
        });
        const origSetNew = ntStore.setNewListenEmitter;
        const self = this;
        ntStore.setNewListenEmitter = function (listenerName, emitter, ...rest) {
          const res = origSetNew.apply(this, [listenerName, emitter, ...rest]);
          try {
            if (listenerName && emitter) {
              self._attachKernelListenerEmitter(String(listenerName), emitter);
            }
          } catch (_) {}
          return res;
        };
      } catch (_) {}
    }
    this._maybeScheduleMapHookRelease();
  }

  /**
   * Instance-level replacement for the global `Map.prototype.set` hook on the one Map that
   * keeps receiving kernel listener emitters after startup, so the global hook can be released.
   */
  _patchListenerEmitterMapInstance(map) {
    if (!(map instanceof Map) || Object.prototype.hasOwnProperty.call(map, "set")) return;
    const self = this;
    try {
      Object.defineProperty(map, "set", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: function (k, v) {
          const res = NATIVE_MAP_SET.call(this, k, v);
          try {
            if (typeof k === "string" && v) {
              self._attachKernelListenerEmitter(k, v);
            }
          } catch (_) {}
          return res;
        },
      });
    } catch (_) {}
  }

  _attachNtStoreRootEmitter(emitter) {
    if (!emitter || typeof emitter.emit !== "function") return;
    if (this._attachedEmitters.has(emitter)) return;
    this._attachedEmitters.add(emitter);
    const origEmit = emitter.emit;
    const self = this;
    emitter.emit = function (fullEventName, ...args) {
      try {
        const name = String(fullEventName || "");
        const sepIdx = name.indexOf("-") >= 0 ? name.indexOf("-") : name.indexOf("/");
        if (sepIdx > 0) {
          const listenerName = name.slice(0, sepIdx);
          const shortEvent = name.slice(sepIdx + 1);
          if (listenerName && shortEvent) {
            self._handleKernelEvent(listenerName, shortEvent, args);
          }
        }
      } catch (_) {}
      return origEmit.apply(this, [fullEventName, ...args]);
    };
  }

  _hookNtSessionManager(mgr) {
    if (!mgr || mgr.__rosmontisHooked__) return;
    try {
      Object.defineProperty(mgr, "__rosmontisHooked__", { value: true, enumerable: false });
    } catch (_) {}

    if (mgr.ntStore) {
      this._inspectNtStore(mgr.ntStore);
    }

    if (typeof mgr.createNt === "function") {
      const origCreateNt = mgr.createNt;
      const self = this;
      mgr.createNt = function (...args) {
        const session = origCreateNt.apply(this, args);
        if (session && typeof session === "object") {
          self.capturedServices.wrapperSession = session;
          if (self.selfUid) {
            self.online = true;
          }
        }
        if (this.ntStore) {
          self._inspectNtStore(this.ntStore);
        }
        self._maybeScheduleMapHookRelease();
        return session;
      };
    }
  }

  _attachKernelListenerEmitter(listenerName, emitterOrMap) {
    if (!emitterOrMap || typeof emitterOrMap !== "object") return;
    if (emitterOrMap instanceof Map) {
      for (const sub of emitterOrMap.values()) {
        this._attachKernelListenerEmitter(listenerName, sub);
      }
      return;
    }
    if (this._attachedEmitters.has(emitterOrMap)) return;
    if (typeof emitterOrMap.on !== "function" && typeof emitterOrMap.emit !== "function") return;
    this._attachedEmitters.add(emitterOrMap);

    const self = this;
    if (typeof emitterOrMap.emit === "function") {
      const origEmit = emitterOrMap.emit;
      emitterOrMap.emit = function (eventName, ...args) {
        try {
          self._handleKernelEvent(listenerName, String(eventName), args);
        } catch (_) {}
        return origEmit.apply(this, [eventName, ...args]);
      };
    }
  }

  // --------------------------------------------------------------------------
  // Electron Main-Process & Renderer Window Integration
  // --------------------------------------------------------------------------

  _isTrustedRendererUrl(url) {
    if (url === undefined || url === null) return true;
    const trimmed = String(url).trim().toLowerCase();
    if (trimmed === "") return true;
    if (
      trimmed.startsWith("http:") ||
      trimmed.startsWith("https:") ||
      trimmed.startsWith("devtools:") ||
      trimmed.startsWith("chrome-extension:") ||
      trimmed.startsWith("data:") ||
      trimmed.startsWith("blob:") ||
      trimmed.startsWith("javascript:") ||
      trimmed.startsWith("about:")
    ) {
      return false;
    }
    if (
      trimmed.startsWith("app:") ||
      trimmed.startsWith("file:") ||
      trimmed.startsWith("qq:") ||
      trimmed.startsWith("ntqq:") ||
      trimmed.startsWith("local-resource:")
    ) {
      return true;
    }
    return false;
  }

  _isTrustedIpcEvent(event, payload) {
    if (!event || !event.sender) {
      if (payload && typeof payload === "object" && payload.__ipcToken !== undefined) {
        return verifyAccessTokenConstantTime(String(payload.__ipcToken || ""), this._ipcAuthToken);
      }
      return true;
    }
    const sender = event.sender;
    if (!this._knownWebContents.has(sender) || !this._isWebContentsAlive(sender)) {
      return false;
    }
    if (typeof sender.getURL === "function") {
      let senderUrl = "";
      try {
        senderUrl = sender.getURL();
      } catch (_) {
        return false;
      }
      if (!this._isTrustedRendererUrl(senderUrl)) {
        return false;
      }
    }
    if (event.senderFrame && sender.mainFrame && event.senderFrame !== sender.mainFrame) {
      return false;
    }
    if (sender.__rosmontisIpcTokenInjected) {
      const provided =
        payload && typeof payload === "object" && typeof payload.__ipcToken === "string"
          ? payload.__ipcToken
          : "";
      if (!verifyAccessTokenConstantTime(provided, this._ipcAuthToken)) {
        return false;
      }
    }
    return true;
  }

  _handleRendererCmdAck(_event, ack) {
    if (!this._isTrustedIpcEvent(_event, ack)) return;
    if (!ack || typeof ack !== "object" || !ack.reqId) return;
    const reqId = String(ack.reqId);
    const pending = this._pendingRendererCmds.get(reqId);
    if (!pending) return;
    if (pending.webContents && _event && _event.sender && _event.sender !== pending.webContents) {
      return;
    }
    this._pendingRendererCmds.delete(reqId);
    if (pending.timer) clearTimeout(pending.timer);

    if (ack.ok) {
      let val = ack.result !== undefined ? ack.result : ack.data;
      if (typeof ack.resultSerialized === "string") {
        try {
          val = JSON.parse(ack.resultSerialized);
        } catch (_) {
          val = ack.resultSerialized;
        }
      }
      pending.resolve(this._reviveBridgePayload(val));
    } else {
      const errMsg = String(ack.error?.message || ack.error || "Renderer bridge command failed");
      const err = new Error(errMsg);
      if (ack.error?.code) {
        err.code = String(ack.error.code);
      }
      if (err.code === BRIDGE_UNAVAILABLE_TAG || errMsg.includes(BRIDGE_UNAVAILABLE_TAG)) {
        err.rosmontisUnavailable = true;
      }
      pending.reject(err);
    }
  }

  _rejectPendingRendererCmds(webContents = null, reason = "Renderer command channel closed") {
    for (const [reqId, pending] of Array.from(this._pendingRendererCmds.entries())) {
      if (!webContents || pending.webContents === webContents) {
        this._pendingRendererCmds.delete(reqId);
        if (pending.timer) clearTimeout(pending.timer);
        try {
          pending.reject(makeBridgeUnavailableError(reason));
        } catch (_) {}
      }
    }
  }

  installElectronHooks(electronModule) {
    let electron = electronModule;
    if (!electron) {
      try {
        electron = require("electron");
      } catch (_) {
        return false;
      }
    }
    if (!electron || typeof electron !== "object") return false;

    const { app, ipcMain } = electron;
    if (ipcMain) {
      try {
        ipcMain.on("__ROSMONTIS_BRIDGE_EVENT__", (_event, payload) => {
          if (!this._isTrustedIpcEvent(_event, payload)) return;
          this._handleRendererForwardedEvent(payload);
        });
        if (typeof ipcMain.handle === "function") {
          ipcMain.handle("__ROSMONTIS_BRIDGE_EVENT__", (_event, payload) => {
            if (!this._isTrustedIpcEvent(_event, payload)) return { ok: false };
            this._handleRendererForwardedEvent(payload);
            return { ok: true };
          });
        }
        ipcMain.on("__ROSMONTIS_BRIDGE_CMD_ACK__", (_event, ack) => {
          this._handleRendererCmdAck(_event, ack);
        });
        if (typeof ipcMain.handle === "function") {
          ipcMain.handle("__ROSMONTIS_BRIDGE_CMD_ACK__", (_event, ack) => {
            this._handleRendererCmdAck(_event, ack);
            return { ok: true };
          });
        }
        this._ipcCmdAckInstalled = true;
        for (const wc of this._knownWebContents) {
          if (wc && wc.__rosmontisIpcTokenInjected && typeof wc.send === "function") {
            wc.__rosmontisCmdChannelReady = true;
          }
        }
      } catch (_) {}
    }

    if (app && typeof app.on === "function") {
      app.on("web-contents-created", (_event, webContents) => {
        this._attachToWebContents(webContents);
      });
    }
    try {
      const existing = electron.webContents?.getAllWebContents?.();
      if (Array.isArray(existing)) {
        for (const wc of existing) {
          this._attachToWebContents(wc);
        }
      }
    } catch (_) {}
    return true;
  }

  _isWebContentsAlive(wc) {
    if (!wc) return false;
    if (typeof wc.isDestroyed === "function" && wc.isDestroyed()) return false;
    return true;
  }

  _canInvokeRenderer(wc) {
    if (!this._isWebContentsAlive(wc)) return false;
    if (this._ipcCmdAckInstalled && wc.__rosmontisCmdChannelReady && typeof wc.send === "function") {
      return true;
    }
    return typeof wc.executeJavaScript === "function";
  }

  _isMainChatUrl(url) {
    const u = String(url || "").trim().toLowerCase();
    return Boolean(u && (u.includes("main") || (u.includes("index.html") && !u.includes("login"))));
  }

  _shouldPromoteWebContents(webContents) {
    if (!this._isWebContentsAlive(webContents)) return false;
    let url = "";
    try {
      if (typeof webContents.getURL === "function") {
        url = String(webContents.getURL() || "").trim().toLowerCase();
      }
    } catch (_) {}
    if (!this._isTrustedRendererUrl(url)) {
      return false;
    }
    if (!this._isWebContentsAlive(this.activeWebContents)) {
      return true;
    }
    if (this.activeWebContents === webContents) {
      return true;
    }
    const isAuxiliaryPopup =
      url.includes("image-viewer") ||
      url.includes("media-viewer") ||
      url.includes("video") ||
      url.includes("popup") ||
      url.includes("tray") ||
      url.includes("notification") ||
      url.includes("about:blank");
    if (isAuxiliaryPopup) {
      return false;
    }
    let currentUrl = "";
    try {
      if (typeof this.activeWebContents.getURL === "function") {
        currentUrl = String(this.activeWebContents.getURL() || "").trim().toLowerCase();
      }
    } catch (_) {}
    const currentIsMain = this._isMainChatUrl(currentUrl);
    if (!url) {
      return !currentIsMain;
    }
    if (this._isMainChatUrl(url)) {
      return true;
    }
    if (url.includes("login") && !currentIsMain) {
      return true;
    }
    return false;
  }

  _attachToWebContents(webContents) {
    if (!webContents || typeof webContents.on !== "function") return;
    if (this._knownWebContents.has(webContents)) return;
    this._knownWebContents.add(webContents);

    if (this._shouldPromoteWebContents(webContents)) {
      this.activeWebContents = webContents;
    }
    const onDestroyed = () => {
      webContents.__rosmontisCmdChannelReady = false;
      this._rejectPendingRendererCmds(webContents, "renderer webContents destroyed");
      this._knownWebContents.delete(webContents);
      if (this.activeWebContents === webContents) {
        this.activeWebContents = null;
        for (const candidate of this._knownWebContents) {
          if (this._shouldPromoteWebContents(candidate)) {
            this.activeWebContents = candidate;
            break;
          }
        }
      }
    };
    if (typeof webContents.once === "function") {
      webContents.once("destroyed", onDestroyed);
    } else {
      webContents.on("destroyed", onDestroyed);
    }

    let pageInjected = false;
    let injectPending = false;
    let injectGen = 0;
    const resetPageInjected = () => {
      injectGen += 1;
      pageInjected = false;
      injectPending = false;
      webContents.__rosmontisCmdChannelReady = false;
      webContents.__rosmontisIpcTokenInjected = false;
      this._rejectPendingRendererCmds(webContents, "renderer navigated");
    };

    const injectScript = () => {
      try {
        if (!this._isWebContentsAlive(webContents)) return;
        let rawUrl = "";
        try {
          if (typeof webContents.getURL === "function") {
            rawUrl = String(webContents.getURL() || "");
          }
        } catch (_) {
          return;
        }
        if (!this._isTrustedRendererUrl(rawUrl)) return;
        const url = rawUrl.trim().toLowerCase();
        if (this._isMainChatUrl(url)) {
          this.online = true;
        }
        if (this._shouldPromoteWebContents(webContents)) {
          this.activeWebContents = webContents;
        }
        const maybeTriggerQuickLogin = () => {
          if (!this.online && url.includes("login") && this.config.autoQuickLogin !== false) {
            const timer = setTimeout(() => {
              this._tryAutoQuickLogin({ webContents }).catch(() => {});
            }, 1500);
            if (timer && typeof timer.unref === "function") timer.unref();
          }
        };
        if (pageInjected || injectPending) {
          maybeTriggerQuickLogin();
          return;
        }
        const code = getRendererBridgeSource();
        if (!code) return;
        const rawWid = Number(webContents.id || 1);
        const widJson = this._safeJsJson(Number.isFinite(rawWid) && rawWid > 0 ? rawWid : 1);
        const ipcAuthTokenJson = this._safeJsJson(this._ipcAuthToken);
        const syncPatchJson = this._safeJsJson({
          activeAioPeer: this._activeAioPeer,
          activeAioPeerKey: this._activeAioPeerKey,
          focused: this._windowFocused,
        });
        const script = `(function(){ var wid = ${widJson}; var ipcAuthToken = ${ipcAuthTokenJson}; var syncPatch = ${syncPatchJson}; if (window.__ROSMONTIS_RENDERER_BRIDGE__) { if (typeof window.__ROSMONTIS_RENDERER_BRIDGE__.setIpcAuthToken === "function") window.__ROSMONTIS_RENDERER_BRIDGE__.setIpcAuthToken(ipcAuthToken); window.__ROSMONTIS_RENDERER_BRIDGE__.setWindowId(wid); if (typeof window.__ROSMONTIS_RENDERER_BRIDGE__.reattachListeners === "function") window.__ROSMONTIS_RENDERER_BRIDGE__.reattachListeners(); if (typeof window.__ROSMONTIS_RENDERER_BRIDGE__.syncSessionState === "function") window.__ROSMONTIS_RENDERER_BRIDGE__.syncSessionState(syncPatch); return true; } window.__ROSMONTIS_WINDOW_ID__ = wid; ${code}\n if (typeof installRendererBridge === "function") { var b = installRendererBridge(window, { windowId: wid, autoRegisterListeners: true, ipcAuthToken: ipcAuthToken }); if (b && typeof b.setIpcAuthToken === "function") b.setIpcAuthToken(ipcAuthToken); if (b && typeof b.syncSessionState === "function") b.syncSessionState(syncPatch); } return true; })();`;
        const genAtStart = injectGen;
        injectPending = true;
        Promise.resolve(webContents.executeJavaScript(script, true))
          .then(() => {
            if (genAtStart !== injectGen || !this._isWebContentsAlive(webContents)) {
              return;
            }
            if (typeof webContents.getURL === "function") {
              try {
                if (!this._isTrustedRendererUrl(webContents.getURL())) return;
              } catch (_) {
                return;
              }
            }
            injectPending = false;
            pageInjected = true;
            webContents.__rosmontisIpcTokenInjected = true;
            if (typeof webContents.send === "function" && this._ipcCmdAckInstalled) {
              webContents.__rosmontisCmdChannelReady = true;
            }
            maybeTriggerQuickLogin();
          })
          .catch(() => {
            if (genAtStart === injectGen) {
              injectPending = false;
            }
          });
      } catch (_) {
        injectPending = false;
      }
    };

    webContents.on("did-start-loading", resetPageInjected);
    webContents.on("did-navigate", resetPageInjected);
    webContents.on("dom-ready", injectScript);
    webContents.on("did-finish-load", injectScript);
    webContents.on("did-navigate-in-page", injectScript);
  }

  async _tryAutoQuickLogin({ uin: explicitUin = "", force = false, webContents = null } = {}) {
    if (this.online && !force) {
      return { skipped: true, reason: "already_online", online: true };
    }
    const now = Date.now();
    if (!force) {
      if ((this._autoQuickLoginAttempts || 0) >= 3) {
        return { skipped: true, reason: "max_attempts_reached", online: Boolean(this.online) };
      }
      if (this._lastAutoQuickLoginAt && now - this._lastAutoQuickLoginAt < 12000) {
        return { skipped: true, reason: "cooldown", online: Boolean(this.online) };
      }
      this._lastAutoQuickLoginAt = now;
      this._autoQuickLoginAttempts = (this._autoQuickLoginAttempts || 0) + 1;
    }

    try {
      await this.invokeNt("nodeIKernelLoginService/setAutoLogin", { shouldAutoLogin: true }, [true]);
    } catch (_) {}

    let loginRes = null;
    try {
      loginRes = await this.invokeNt("nodeIKernelLoginService/getLoginList", {}, []);
    } catch (_) {}
    const list = Array.isArray(loginRes?.LocalLoginInfoList) ? loginRes.LocalLoginInfoList : [];
    const targetUin = String(explicitUin || this.selfUin || "").trim();
    const acc =
      (targetUin && list.find((item) => item && String(item.uin) === targetUin)) ||
      list.find((item) => item && (item.isQuickLogin || item.isAutoLogin) && item.uin) ||
      null;

    if (!acc || (!acc.isQuickLogin && !acc.isAutoLogin && !force)) {
      return {
        skipped: true,
        reason: acc ? "quick_login_unavailable" : "no_saved_account",
        accounts: list.map((x) => ({
          uin: String(x?.uin || ""),
          isQuickLogin: Boolean(x?.isQuickLogin),
          isAutoLogin: Boolean(x?.isAutoLogin),
        })),
      };
    }

    const uin = String(acc.uin);
    this._updateSelfIdentity({
      uin,
      uid: acc.uid || this.selfUid,
      nick: acc.nickName || acc.nick || this.selfNickname,
      markOnline: false,
    });

    try {
      await this.invokeNt("nodeIKernelSettingService/setAutoLoginSwitch", { state: true }, [true]);
    } catch (_) {}

    let quickRes = null;
    let methodUsed = "";
    for (const cmd of [
      "nodeIKernelLoginService/quickLoginWithUin",
      "nodeIKernelLoginService/quickLogin",
    ]) {
      try {
        quickRes = await this.invokeNt(cmd, { uin }, [uin]);
        const code = Number(quickRes?.result ?? quickRes?.resultCode ?? 0);
        if (!Number.isNaN(code) && code === 0) {
          methodUsed = cmd;
          break;
        }
      } catch (_) {}
    }

    const wc = webContents || this.activeWebContents;
    if (
      !methodUsed &&
      wc &&
      this._isWebContentsAlive(wc) &&
      typeof wc.executeJavaScript === "function" &&
      (typeof wc.getURL !== "function" || this._isTrustedRendererUrl(wc.getURL()))
    ) {
      try {
        const clicked = await wc.executeJavaScript(
          `(function(){
            const btns = Array.from(document.querySelectorAll("button, .q-button, [role='button']"));
            const loginBtn = btns.find((el) => /^\\s*登\\s*录\\s*$/.test(String(el.textContent || "")));
            if (loginBtn) { loginBtn.click(); return true; }
            return false;
          })()`,
          true
        );
        if (clicked) methodUsed = "dom_button_click";
      } catch (_) {}
    }

    return {
      triggered: Boolean(methodUsed),
      uin,
      method: methodUsed,
      result: quickRes || null,
      online: Boolean(this.online),
    };
  }

  _reviveBridgePayload(val) {
    if (val === null || val === undefined || typeof val !== "object") {
      return val;
    }
    if (val instanceof Map || val instanceof Uint8Array || Buffer.isBuffer(val)) {
      return val;
    }
    if (Array.isArray(val)) {
      return val.map((item) => this._reviveBridgePayload(item));
    }
    if (val.__rosmontisVoid__ === true && Object.keys(val).length === 1) {
      return undefined;
    }
    if (Array.isArray(val.__rosmontisMap__) && Object.keys(val).length === 1) {
      return new Map(
        val.__rosmontisMap__.map((entry) => [
          Array.isArray(entry) ? this._reviveBridgePayload(entry[0]) : undefined,
          Array.isArray(entry) ? this._reviveBridgePayload(entry[1]) : undefined,
        ])
      );
    }
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = this._reviveBridgePayload(v);
    }
    return out;
  }

  _handleRendererForwardedEvent(rawData) {
    const data = this._reviveBridgePayload(rawData);
    if (!data || typeof data !== "object") return;
    const cmdName = String(data.cmdName || "");
    const eventName = String(data.eventName || "");
    const shortEvent = cmdName.includes("/") ? cmdName.split("/").pop() : cmdName;
    const listenerName = cmdName.includes("/") ? cmdName.split("/")[0] : eventName;
    const payload = data.payload;
    if (shortEvent) {
      this._handleKernelEvent(
        listenerName,
        shortEvent,
        Array.isArray(payload) ? payload : [payload]
      );
    }
  }

  // --------------------------------------------------------------------------
  // 3-Tier `invokeNt` Execution Engine
  // --------------------------------------------------------------------------

  _serializeBridgePayload(value) {
    const raw = JSON.stringify(value, (_key, val) => {
      if (val instanceof Map) {
        return { __rosmontisMap__: Array.from(val.entries()) };
      }
      if (typeof val === "bigint") {
        return val.toString();
      }
      return val;
    });
    if (typeof raw !== "string") return "undefined";
    return raw.replace(/[<>&\u2028\u2029]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
  }

  async _invokeRendererCommand(type, cmdPayload = {}, timeoutMs = 15000) {
    const wc = this.activeWebContents;
    if (!this._isWebContentsAlive(wc)) {
      throw makeBridgeUnavailableError("no live renderer webContents");
    }
    if (typeof wc.getURL === "function") {
      let senderUrl = "";
      try {
        senderUrl = wc.getURL();
      } catch (_) {
        throw makeBridgeUnavailableError("failed to inspect renderer URL");
      }
      if (!this._isTrustedRendererUrl(senderUrl)) {
        throw makeBridgeUnavailableError("active renderer URL is untrusted");
      }
    }

    // Primary structured IPC channel (zero executeJavaScript per command)
    if (
      this._ipcCmdAckInstalled &&
      wc.__rosmontisCmdChannelReady &&
      typeof wc.send === "function"
    ) {
      const reqId = crypto.randomUUID();
      const envelope = {
        reqId,
        __ipcToken: this._ipcAuthToken,
        type,
        ...cmdPayload,
        timeoutMs,
      };
      return await new Promise((resolve, reject) => {
        const effectiveTimeout = Math.max(100, Number(timeoutMs) || 15000);
        const timer = setTimeout(() => {
          this._pendingRendererCmds.delete(reqId);
          reject(new Error(`Renderer IPC command timeout (${effectiveTimeout}ms): ${type}`));
        }, effectiveTimeout);
        if (typeof timer.unref === "function") timer.unref();

        this._pendingRendererCmds.set(reqId, {
          reqId,
          type,
          webContents: wc,
          timer,
          resolve,
          reject,
        });

        try {
          wc.send("__ROSMONTIS_BRIDGE_CMD__", envelope);
        } catch (err) {
          clearTimeout(timer);
          this._pendingRendererCmds.delete(reqId);
          reject(makeBridgeUnavailableError(`webContents.send failed: ${err?.message || err}`));
        }
      });
    }

    // Fallback for synthetic unit-test mocks that only provide executeJavaScript
    if (typeof wc.executeJavaScript === "function") {
      let js = "";
      if (type === "invokeNt") {
        const cmdJson = this._safeJsJson(cmdPayload.cmd);
        const argsJson =
          typeof cmdPayload.argsSerialized === "string"
            ? cmdPayload.argsSerialized
            : this._serializeBridgePayload(cmdPayload.args ?? [null, null]);
        const notReady = this._safeJsJson(`${BRIDGE_UNAVAILABLE_TAG}: Renderer bridge not ready`);
        js = `(window.__ROSMONTIS_RENDERER_BRIDGE__ && window.__ROSMONTIS_RENDERER_BRIDGE__.invokeNtApiSerialized) ? window.__ROSMONTIS_RENDERER_BRIDGE__.invokeNtApiSerialized(${cmdJson}, ${argsJson}) : (window.__ROSMONTIS_RENDERER_BRIDGE__ && window.__ROSMONTIS_RENDERER_BRIDGE__.invokeNtApi) ? window.__ROSMONTIS_RENDERER_BRIDGE__.invokeNtApi(${cmdJson}, ${argsJson}) : Promise.reject(new Error(${notReady}))`;
      } else if (type === "simulateSession") {
        const optsJson = this._safeJsJson(cmdPayload.opts || {});
        js = `(window.__ROSMONTIS_RENDERER_BRIDGE__ && window.__ROSMONTIS_RENDERER_BRIDGE__.simulateHumanSessionFlow) ? window.__ROSMONTIS_RENDERER_BRIDGE__.simulateHumanSessionFlow(${optsJson}) : null`;
      } else if (type === "leaveSession") {
        const optsJson = this._safeJsJson(cmdPayload.opts || {});
        js = `(window.__ROSMONTIS_RENDERER_BRIDGE__ && window.__ROSMONTIS_RENDERER_BRIDGE__.leaveHumanSessionFlow) ? window.__ROSMONTIS_RENDERER_BRIDGE__.leaveHumanSessionFlow(${optsJson}) : null`;
      } else if (type === "syncSession") {
        const patchJson = this._safeJsJson(cmdPayload.patch || {});
        js = `(window.__ROSMONTIS_RENDERER_BRIDGE__ && window.__ROSMONTIS_RENDERER_BRIDGE__.syncSessionState) ? window.__ROSMONTIS_RENDERER_BRIDGE__.syncSessionState(${patchJson}) : null`;
      } else if (type === "resetSession") {
        js = `(window.__ROSMONTIS_RENDERER_BRIDGE__ && window.__ROSMONTIS_RENDERER_BRIDGE__.resetSessionState) ? window.__ROSMONTIS_RENDERER_BRIDGE__.resetSessionState() : null`;
      } else {
        throw new Error(`Unsupported renderer command type: ${type}`);
      }
      const rawRes = await wc.executeJavaScript(js, true);
      if (typeof rawRes === "string" && type === "invokeNt") {
        try {
          return this._reviveBridgePayload(JSON.parse(rawRes));
        } catch (_) {
          return rawRes;
        }
      }
      return this._reviveBridgePayload(rawRes);
    }

    throw makeBridgeUnavailableError("no live renderer command transport");
  }

  _recordInvokeTier(cmd, tier, prevErrors) {
    const stats = this.invokeStats;
    stats[`tier${tier}`] = (stats[`tier${tier}`] || 0) + 1;
    if (tier > 1) {
      stats.degraded += 1;
      stats.lastDegraded = { cmd, tier, at: Date.now() };
      const reason = prevErrors.length > 0 ? String(prevErrors[0]?.message || prevErrors[0]) : "";
      this._logWarn(
        `degrade:${cmd}:${tier}`,
        `invokeNt degraded to Tier ${tier} for ${cmd}${reason ? ` (after: ${reason.slice(0, 200)})` : ""}`
      );
    }
  }

  _logWarn(key, message, intervalMs = 60000) {
    if (
      process.env.ROSMONTIS_QUIET === "1" ||
      process.env.XIAO_BRIDGE_QUIET === "1" ||
      this.config?.quietLogs
    ) {
      return;
    }
    const now = Date.now();
    const last = this._logThrottle.get(key) || 0;
    if (now - last < intervalMs) return;
    this._setBoundedMap(this._logThrottle, key, now, 500);
    try {
      process.stderr.write(`[rosmontis] ${message}\n`);
    } catch (_) {}
  }

  /**
   * 3-tier NTQQ invocation.
   *
   * Fallback policy:
   * - Read/idempotent commands: any Tier failure falls through to the next Tier (legacy behaviour).
   * - Side-effect commands (`SIDE_EFFECT_NT_METHODS`, e.g. sendMsg/recallMsg): only fall through
   *   when the previous Tier could not dispatch at all (`BRIDGE_UNAVAILABLE_TAG`). Once a Tier has
   *   actually dispatched the call, its timeout/error is surfaced as-is and never replayed, so a
   *   slow upload or a risk-control rejection can not turn into duplicate messages.
   */
  async invokeNt(cmd, payload = {}, positionalArgs = null) {
    const errors = [];
    const sideEffect = isSideEffectNtCmd(cmd);
    const stopAfterDispatchedFailure = (err) => {
      errors.push(err);
      if (sideEffect && !isBridgeUnavailableError(err)) {
        this.invokeStats.blockedReplays += 1;
        this._logWarn(
          `blocked:${cmd}`,
          `invokeNt not replaying side-effect ${cmd} after dispatched failure: ${String(err?.message || err).slice(0, 200)}`
        );
        return true;
      }
      return false;
    };

    // Tier 1: Execute via Renderer structured IPC (`__ROSMONTIS_BRIDGE_CMD__`) or safe fallback
    if (typeof this.rendererExecute === "function") {
      try {
        const res = await this.rendererExecute(cmd, [payload, null]);
        this._recordInvokeTier(cmd, 1, errors);
        return this._reviveBridgePayload(res);
      } catch (e) {
        if (stopAfterDispatchedFailure(e)) throw e;
      }
    } else if (this._canInvokeRenderer(this.activeWebContents)) {
      try {
        const argsSerialized = this._serializeBridgePayload([payload, null]);
        const res = await this._invokeRendererCommand("invokeNt", {
          cmd,
          argsSerialized,
        });
        if (res !== undefined || sideEffect) {
          this._recordInvokeTier(cmd, 1, errors);
          return res;
        }
      } catch (e) {
        if (stopAfterDispatchedFailure(e)) throw e;
      }
    } else {
      errors.push(makeBridgeUnavailableError("no live renderer webContents"));
    }

    // Tier 2: Execute via Main-Process `ntApi[cmd]` Proxy
    // Note: Real NTQQ 3.2.32 `ntApi.invoke[cmd]` expects `(payload, ipcEvent)` directly
    // (NOT `([payload, null], ipcEvent)`).
    if (this.capturedServices.ntApi) {
      const ntApiTarget =
        typeof this.capturedServices.ntApi["nodeIKernelMsgService/sendMsg"] === "function"
          ? this.capturedServices.ntApi
          : this.capturedServices.ntApi.invoke &&
            typeof this.capturedServices.ntApi.invoke["nodeIKernelMsgService/sendMsg"] === "function"
          ? this.capturedServices.ntApi.invoke
          : this.capturedServices.ntApi;
      let handler = null;
      try {
        handler = ntApiTarget[cmd];
      } catch (_) {}
      if (typeof handler === "function") {
        try {
          const fakeIpcEvent = {
            sender: this.activeWebContents || {
              id: 1,
              send() {},
              isDestroyed: () => false,
            },
          };
          const res = await handler(payload, fakeIpcEvent);
          // A resolved side-effect call has been dispatched even if it returns void.
          if (res !== undefined || sideEffect) {
            this._recordInvokeTier(cmd, 2, errors);
            return res;
          }
        } catch (e) {
          if (stopAfterDispatchedFailure(e)) throw e;
        }
      } else {
        errors.push(makeBridgeUnavailableError(`ntApi has no handler for ${cmd}`));
      }
    }

    // Tier 3: Execute via live `NodeIQQNTWrapperSession.get*Service()[method](...positionalArgs)`
    const session =
      this.capturedServices.wrapperSession ||
      this.capturedServices.ntStore?.wrapperSession ||
      this.capturedServices.ntStore?.session ||
      this.capturedServices.ntSessionManager?.ntStore?.wrapperSession ||
      this.capturedServices.ntSessionManager?.ntStore?.session;
    if (session && cmd.includes("/")) {
      const [serviceName, methodName] = cmd.split("/");
      const getterName = SERVICE_GETTER_MAP[serviceName];
      if (getterName && typeof session[getterName] === "function") {
        try {
          const svc = session[getterName]();
          if (svc && typeof svc[methodName] === "function") {
            const callArgs = Array.isArray(positionalArgs)
              ? positionalArgs
              : payload && typeof payload === "object"
              ? Object.values(payload)
              : [];
            const res = await svc[methodName](...callArgs);
            this._recordInvokeTier(cmd, 3, errors);
            return res;
          }
        } catch (e) {
          errors.push(e);
        }
      }
    }

    this.invokeStats.failed += 1;
    const dispatched = errors.find((e) => !isBridgeUnavailableError(e));
    if (dispatched) {
      throw dispatched;
    }
    const unavailable = new Error(`NTQQ service unavailable for ${cmd}`);
    unavailable.rosmontisUnavailable = true;
    throw unavailable;
  }

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
  // Kernel Event Handler -> OneBot v11 Events
  // --------------------------------------------------------------------------

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
  }

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
  }

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
  }

  // --------------------------------------------------------------------------
  // Helper Methods for Media, Peer Resolution, Cookies & QZone
  // --------------------------------------------------------------------------

  async _resolvePeerForUser(userId, groupId) {
    const uinStr = String(userId || "").trim();
    const uid = await this.uinUidStore.resolveUid(uinStr, this.invokeNt.bind(this));
    if (groupId && Number(groupId) > 0) {
      return {
        chatType: 100,
        peerUid: uid || uinStr,
        guildId: "",
      };
    }
    return {
      chatType: 1,
      peerUid: uid || uinStr,
      guildId: "",
    };
  }

  async _prepareNtImagePath(media, subType = 0) {
    const elemSubType = Number(subType || 0);
    try {
      const exifRes = await this.invokeNt(
        "nodeIKernelMsgService/copyFileWithDelExifInfo",
        {
          sourcePath: media.localPath,
          elementSubType: elemSubType,
        },
        [media.localPath, elemSubType]
      );
      if (exifRes && exifRes.newPath && !exifRes.errorMsg) {
        const newPath = String(exifRes.newPath);
        let fileSize = media.fileSize;
        try {
          if (fs.existsSync(newPath)) {
            fileSize = fs.statSync(newPath).size || media.fileSize;
          }
        } catch (_) {}
        return {
          localPath: newPath,
          md5HexStr: String(exifRes.md5 || media.md5HexStr),
          fileSize,
          fileName: path.basename(newPath) || media.fileName,
        };
      }
    } catch (_) {}

    try {
      const pathInfo = {
        md5HexStr: media.md5HexStr,
        fileName: media.fileName,
        elementType: 2,
        elementSubType: elemSubType,
        thumbSize: 0,
        needCreate: true,
        downloadType: 1,
        file_uuid: "",
      };
      const pathRes = await this.invokeNt(
        "nodeIKernelMsgService/getRichMediaFilePathForGuild",
        { path_info: pathInfo },
        [pathInfo]
      );
      const targetPath = typeof pathRes === "string" ? pathRes : pathRes?.path || "";
      if (targetPath && targetPath !== media.localPath) {
        try {
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          fs.copyFileSync(media.localPath, targetPath);
          return targetPath;
        } catch (_) {
          await this.invokeNt(
            "nodeIKernelFileAssistantService/copyFile",
            { fromPath: media.localPath, toPath: targetPath },
            [media.localPath, targetPath]
          );
          return targetPath;
        }
      }
    } catch (_) {}
    return media.localPath;
  }

  // --------------------------------------------------------------------------
  // Outbound message echo correlation (sendMsg result <-> onAddSendMsg msgRecord)
  //
  // NTQQ `sendMsg` usually resolves with `{ result, errMsg }` only; the real 64-bit msgId of
  // the outgoing message is delivered via `nodeIKernelMsgListener/onAddSendMsg`. Waiters are
  // registered per peer BEFORE dispatching sendMsg (the echo may arrive before sendMsg
  // resolves) and matched FIFO, skipping candidates whose plain text clearly differs.
  // --------------------------------------------------------------------------

  static _ntElementsSignature(elements) {
    const parts = [];
    let text = "";
    if (Array.isArray(elements)) {
      for (const el of elements) {
        if (!el || typeof el !== "object") continue;
        const type = Number(el.elementType || 0);
        if (type === 1 && el.textElement) {
          const atType = Number(el.textElement.atType || 0);
          if (atType === 0) {
            const chunk = String(el.textElement.content || "");
            if (!chunk) continue;
            text += chunk;
            const prev = parts[parts.length - 1];
            if (prev && prev.kind === "text") {
              prev.text += chunk;
            } else {
              parts.push({ kind: "text", text: chunk });
            }
          } else {
            parts.push({
              kind: "at",
              atType,
              uid: String(el.textElement.atNtUid || ""),
              uin: String(el.textElement.atUid || ""),
            });
          }
        } else if (type === 2 && el.picElement) {
          parts.push({
            kind: "pic",
            md5: String(el.picElement.md5HexStr || "").toLowerCase(),
            subType: Number(el.picElement.picSubType || 0),
            name: String(el.picElement.fileName || ""),
          });
        } else if (type === 3 && el.fileElement) {
          parts.push({
            kind: "file",
            md5: String(el.fileElement.fileMd5 || "").toLowerCase(),
            name: String(el.fileElement.fileName || ""),
          });
        } else if (type === 4 && el.pttElement) {
          parts.push({
            kind: "ptt",
            md5: String(el.pttElement.md5HexStr || "").toLowerCase(),
            name: String(el.pttElement.fileName || ""),
          });
        } else if (type === 5 && el.videoElement) {
          parts.push({
            kind: "video",
            md5: String(el.videoElement.videoMd5 || "").toLowerCase(),
            name: String(el.videoElement.fileName || ""),
          });
        } else if (type === 6 && el.faceElement) {
          parts.push({
            kind: "face",
            faceType: Number(el.faceElement.faceType || 0),
            faceIndex: Number(el.faceElement.faceIndex || 0),
            pokeType: Number(el.faceElement.pokeType || 0),
          });
        } else if (type === 7 && el.replyElement) {
          parts.push({
            kind: "reply",
            msgId: String(el.replyElement.replayMsgId || "0"),
            msgSeq: String(el.replyElement.replayMsgSeq || "0"),
          });
        } else if (type === 10 && el.arkElement) {
          parts.push({
            kind: "ark",
            data: String(el.arkElement.bytesData || ""),
          });
        } else if (type === 11 && el.marketFaceElement) {
          parts.push({
            kind: "mface",
            emojiId: String(el.marketFaceElement.emojiId || ""),
          });
        } else if (type > 0) {
          parts.push({ kind: `el:${type}` });
        }
      }
    }
    return { text: text.trim(), parts };
  }

  static _elementsSignatureMatch(expected, actual) {
    const aList = expected?.parts;
    const bList = actual?.parts;
    if (!Array.isArray(aList) || !Array.isArray(bList)) return false;
    if (aList.length === 0 || aList.length !== bList.length) return false;
    for (let i = 0; i < aList.length; i++) {
      const a = aList[i];
      const b = bList[i];
      if (!a || !b || a.kind !== b.kind) return false;
      if (a.kind === "text") {
        if (a.text.trim() !== b.text.trim()) return false;
        if (!a.text.trim() && a.text !== b.text) return false;
      } else if (a.kind === "at") {
        if (a.atType !== b.atType) return false;
        if (a.uid && b.uid) {
          if (a.uid !== b.uid) return false;
        } else if (a.uin && b.uin && a.uin !== b.uin) {
          return false;
        }
      } else if (a.kind === "pic" || a.kind === "file" || a.kind === "ptt" || a.kind === "video") {
        if (a.md5 && b.md5) {
          if (a.md5 !== b.md5) return false;
        } else if (a.name && b.name && a.name !== b.name) {
          return false;
        }
      } else if (a.kind === "face") {
        if (a.faceType !== b.faceType || a.faceIndex !== b.faceIndex || a.pokeType !== b.pokeType) {
          return false;
        }
      } else if (a.kind === "reply") {
        if (a.msgId !== "0" && b.msgId !== "0") {
          if (a.msgId !== b.msgId) return false;
        } else if (a.msgSeq !== "0" && b.msgSeq !== "0" && a.msgSeq !== b.msgSeq) {
          return false;
        }
      } else if (a.kind === "ark") {
        if (a.data !== b.data) return false;
      } else if (a.kind === "mface") {
        if (a.emojiId !== b.emojiId) return false;
      }
    }
    return true;
  }

  _sendPeerKey(peer) {
    return `${Number(peer?.chatType) || 0}:${String(peer?.peerUid || "")}`;
  }

  _registerSendEchoWaiter(peer, elements) {
    const key = this._sendPeerKey(peer);
    const waiter = {
      sig: NtqqOneBotBridge._ntElementsSignature(elements),
      echo: null,
      resolve: null,
      done: false,
    };
    const queue = this._sendEchoWaiters.get(key) || [];
    queue.push(waiter);
    while (queue.length > 32) {
      const stale = queue.shift();
      stale.done = true;
      if (stale.resolve) stale.resolve(null);
    }
    this._sendEchoWaiters.set(key, queue);

    const remove = () => {
      const q = this._sendEchoWaiters.get(key);
      if (!q) return;
      const idx = q.indexOf(waiter);
      if (idx >= 0) q.splice(idx, 1);
      if (q.length === 0) this._sendEchoWaiters.delete(key);
    };

    return {
      wait: (timeoutMs) => {
        if (waiter.echo || waiter.done) {
          waiter.done = true;
          remove();
          return Promise.resolve(waiter.echo);
        }
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            waiter.done = true;
            waiter.resolve = null;
            remove();
            resolve(null);
          }, Math.max(0, Number(timeoutMs) || 0));
          // Intentionally NOT unref'd: the caller is awaiting this bounded timer.
          waiter.resolve = (echo) => {
            clearTimeout(timer);
            waiter.done = true;
            waiter.resolve = null;
            remove();
            resolve(echo);
          };
        });
      },
      cancel: () => {
        waiter.done = true;
        waiter.resolve = null;
        remove();
      },
    };
  }

  _matchSendEcho(ntMsg) {
    if (!ntMsg || !ntMsg.msgId || String(ntMsg.msgId) === "0") return false;
    const key = this._sendPeerKey({ chatType: ntMsg.chatType, peerUid: ntMsg.peerUid });
    const queue = this._sendEchoWaiters.get(key);
    if (!queue || queue.length === 0) return false;
    const sig = NtqqOneBotBridge._ntElementsSignature(ntMsg.elements);
    const waiter = queue.find(
      (w) => !w.done && !w.echo && NtqqOneBotBridge._elementsSignatureMatch(w.sig, sig)
    );
    if (!waiter) return false;
    waiter.echo = {
      msgId: String(ntMsg.msgId),
      msgSeq: String(ntMsg.msgSeq || "0"),
      msgTime: ntMsg.msgTime !== undefined ? Number(ntMsg.msgTime) : undefined,
      rawMsg: ntMsg,
    };
    if (waiter.resolve) waiter.resolve(waiter.echo);
    return true;
  }

  _hasRichMediaElements(elements) {
    if (!Array.isArray(elements)) return false;
    return elements.some((el) => {
      if (!el || typeof el !== "object") return false;
      const t = Number(el.elementType);
      return (
        t === 2 ||
        t === 3 ||
        t === 4 ||
        t === 5 ||
        Boolean(el.picElement || el.fileElement || el.pttElement || el.videoElement)
      );
    });
  }

  _computeSendEchoTimeoutMs(elements) {
    const textTimeout = Math.max(0, Number(this.config.sendEchoTimeoutMs ?? 3000));
    if (!this._hasRichMediaElements(elements)) {
      return textTimeout;
    }
    const rawRich =
      this.config.richMediaEchoTimeoutMs ??
      this.config.sendRichMediaEchoTimeoutMs ??
      15000;
    const baseRich = Math.max(textTimeout, Math.max(0, Number(rawRich)));
    let totalBytes = 0;
    for (const el of elements) {
      const sub = el?.picElement || el?.fileElement || el?.pttElement || el?.videoElement;
      const sz = Number(sub?.fileSize || 0);
      if (Number.isFinite(sz) && sz > 0) totalBytes += sz;
    }
    const extraMb =
      totalBytes > 1024 * 1024 ? Math.ceil((totalBytes - 1024 * 1024) / (1024 * 1024)) : 0;
    const maxTimeout = Math.max(baseRich, Number(this.config.maxSendEchoTimeoutMs ?? 60000));
    return Math.min(maxTimeout, baseRich + extraMb * 2000);
  }

  _mediaSecurityOptions() {
    return {
      maxMediaBytes: this.config.maxMediaBytes,
      allowPrivateUrls:
        this.config.allowPrivateUrls === true || this.config.allowPrivateMediaUrls === true
          ? true
          : undefined,
      allowArbitraryLocalFiles:
        this.config.allowArbitraryLocalFiles === true ? true : undefined,
      allowedFileDirs: this.config.allowedFileDirs,
    };
  }

  async _sendMessageToPeer(peer, message, autoEscape = false, groupId = undefined, options = {}) {
    const peerKey = `${peer.chatType}:${peer.peerUid}:${peer.guildId || ""}`;
    this._sessionScheduler.cancelPeerReaction(peerKey);

    // Phase 1 (unlocked): concurrent heavy I/O (HTTP media download, EXIF normalize, @UIN->UID)
    const { elements, sideEffects, cleanupCallbacks } = await oneBotSegmentsToNtElements(message, {
      autoEscape,
      groupId,
      uinUidStore: this.uinUidStore,
      messageIdStore: this.messageIdStore,
      invokeNt: this.invokeNt.bind(this),
      prepareNtImagePath: this._prepareNtImagePath.bind(this),
      ...this._mediaSecurityOptions(),
    });

    try {
      // Phase 2 (AIO-mutex serialized): activate target AIO + dispatch sendMsg IPC, then release immediately
      const { echoWaiter, sendRes } = await this._withAioLock(
        async () => {
          this._sessionScheduler.cancelPeerReaction(peerKey);
          if (this.config.humanSimulation !== false && !options.skipHumanSimulation) {
            await this._activateSessionUnlocked({
              chatType: peer.chatType,
              peerUid: peer.peerUid,
              guildId: peer.guildId || "",
              markRead: true,
              sendTyping: false,
            });
          }

          for (const effect of sideEffects) {
            if (effect.type === "poke") {
              await this._sendPokeInternal(
                peer.chatType === 2 ? Number(peer.peerUid) : undefined,
                effect.qq || (peer.chatType === 1 ? Number(this.uinUidStore.getUinSync(peer.peerUid)) : 0)
              );
            }
          }

          if (elements.length === 0) {
            return { echoWaiter: null, sendRes: null };
          }

          const waiter = this._registerSendEchoWaiter(peer, elements);
          try {
            const res = await this.invokeNt(
              "nodeIKernelMsgService/sendMsg",
              {
                msgId: "0",
                peer,
                msgElements: elements,
                msgAttributeInfos: new Map(),
              },
              ["0", peer, elements, new Map()]
            );
            if (this.config.humanSimulation !== false && !options.skipHumanSimulation) {
              this._touchAioActivity();
            }
            return { echoWaiter: waiter, sendRes: res };
          } catch (err) {
            waiter.cancel();
            throw err;
          }
        },
        { peerKey }
      );

      if (!echoWaiter) {
        return { message_id: this.messageIdStore.register("", peer, "0") };
      }

      if (sendRes && typeof sendRes.result === "number" && sendRes.result !== 0) {
        echoWaiter.cancel();
        throw new Error(sendRes.errMsg || `sendMsg failed with code ${sendRes.result}`);
      }

      // Phase 3 (unlocked): await onAddSendMsg echo correlation without holding _aioMutex
      const normId = (v) => (v !== undefined && v !== null && String(v) !== "0" ? String(v) : "");
      let realMsgId = normId(sendRes?.msgId || sendRes?.msgRecord?.msgId);
      let msgSeq = String(sendRes?.msgSeq || sendRes?.msgRecord?.msgSeq || "0");
      let msgTime = Math.floor(Date.now() / 1000);
      if (realMsgId) {
        echoWaiter.cancel();
        this.sendEchoStats.fromResult += 1;
      } else {
        const echoTimeoutMs = this._computeSendEchoTimeoutMs(elements);
        const echo = await echoWaiter.wait(echoTimeoutMs);
        if (echo && echo.msgId) {
          realMsgId = echo.msgId;
          if (msgSeq === "0" && echo.msgSeq) msgSeq = echo.msgSeq;
          if (Number.isFinite(echo.msgTime) && echo.msgTime > 0) msgTime = echo.msgTime;
          this.sendEchoStats.matched += 1;
        } else {
          this.sendEchoStats.timedOut += 1;
          this._logWarn(
            `send-echo-timeout:${this._sendPeerKey(peer)}`,
            `sendMsg to ${this._sendPeerKey(peer)} succeeded but no onAddSendMsg echo arrived within ${echoTimeoutMs}ms; message_id will not be recallable`
          );
        }
      }
      if (!realMsgId) {
        realMsgId = `sent_${Date.now()}`;
      }

      const shortId = this.messageIdStore.register(realMsgId, peer, msgSeq, {
        senderUin: this.selfUin,
        senderUid: this.selfUid,
        groupId: peer.chatType === 2 ? peer.peerUid : "",
        msgTime,
      });

      return { message_id: shortId, real_id: realMsgId };
    } finally {
      this._scheduleTempCleanup(cleanupCallbacks, Boolean(options.cleanupTempImmediately));
    }
  }

  async _sendPokeInternal(groupId, userId) {
    const targetUin = Number(userId || 0);
    const targetGroup = groupId ? Number(groupId) : 0;
    const targetUid = targetUin
      ? await this.uinUidStore.resolveUid(targetUin, this.invokeNt.bind(this))
      : "";
    const peer =
      targetGroup > 0
        ? { chatType: 2, peerUid: String(targetGroup), guildId: "" }
        : await this._resolvePeerForUser(targetUin);

    // 1. Primary: genuine NTQQ 3.2.32 `nodeIKernelMsgService/sendNudge`
    try {
      await this.invokeNt(
        "nodeIKernelMsgService/sendNudge",
        {
          peer,
          toUid: targetUid || String(targetUin),
          uid: targetUid || String(targetUin),
        },
        [peer, targetUid || String(targetUin)]
      );
      return;
    } catch (err) {
      if (!isBridgeUnavailableError(err)) throw err;
    }

    // 2. Fallback: legacy `sendPoke` if bridged by a custom adapter
    try {
      if (targetGroup > 0) {
        await this.invokeNt("nodeIKernelMsgService/sendPoke", {
          groupCode: String(targetGroup),
          toUin: String(targetUin),
          peer,
          targetUid: targetUid || String(targetUin),
        });
        return;
      }
      await this.invokeNt("nodeIKernelMsgService/sendPoke", {
        toUin: String(targetUin),
        peer,
        targetUid: targetUid || String(targetUin),
      });
      return;
    } catch (err) {
      if (!isBridgeUnavailableError(err)) throw err;
    }

    // 3. Final fallback: sendMsg poke faceElement
    if (targetUin > 0 && peer && peer.peerUid) {
      const pokeElements = [
        {
          elementType: 6,
          elementId: "",
          faceElement: {
            faceIndex: 0,
            faceType: 5,
            faceText: "[戳一戳]",
            pokeType: 1,
            spokeSummary: "",
            doubleHit: 0,
            vasPokeId: 1,
            vasPokeName: "戳一戳",
          },
        },
      ];
      await this.invokeNt(
        "nodeIKernelMsgService/sendMsg",
        {
          msgId: "0",
          peer,
          msgElements: pokeElements,
          msgAttributeInfos: new Map(),
        },
        ["0", peer, pokeElements, new Map()]
      );
      return;
    }
    throw makeBridgeUnavailableError("NTQQ service unavailable for sendNudge/sendPoke");
  }

  async _fetchClientKey() {
    assertWebCredentialApiEnabled(this.config, "get_clientkey");
    return await fetchClientKey(this);
  }

  async _getCookiesObject(domain = "qun.qq.com") {
    assertWebCredentialApiEnabled(this.config, "get_cookies");
    return await getCookiesObject(this, domain, WEB_HTTP_HELPERS);
  }

  // --------------------------------------------------------------------------
  // OneBot v11 Action Dispatcher (65+ Actions)
  // --------------------------------------------------------------------------

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
        return {
          app_name: "Rosmontis",
          app_version: "1.0.0",
          protocol_version: "v11",
        };

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
        const peer = await this._resolvePeerForUser(userId, p.group_id);
        return await this._sendMessageToPeer(peer, p.message, Boolean(p.auto_escape), p.group_id);
      }

      case "send_group_msg": {
        const groupId = p.group_id;
        if (!groupId) throw new Error("group_id is required");
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
      case "get_emoji_likes": {
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

      // ---- 5. Friends ----
      case "get_friend_list": {
        let cancelWait = null;
        const waitBuddyEvent = new Promise((resolve) => {
          const onUpdate = (payload) => {
            clearTimeout(timer);
            this._buddyListWaiters.delete(onUpdate);
            resolve(payload);
          };
          const timer = setTimeout(() => {
            this._buddyListWaiters.delete(onUpdate);
            resolve(null);
          }, 1200);
          if (typeof timer.unref === "function") timer.unref();
          cancelWait = () => {
            clearTimeout(timer);
            this._buddyListWaiters.delete(onUpdate);
            resolve(null);
          };
          this._buddyListWaiters.add(onUpdate);
        });

        const forceRefresh = Boolean(p.no_cache);
        let res = null;
        try {
          res = await this.invokeNt(
            "nodeIKernelBuddyService/getBuddyList",
            { force_update: forceRefresh, noCache: forceRefresh },
            [forceRefresh]
          );
        } catch (_) {}

        let directCats = Array.isArray(res)
          ? res
          : Array.isArray(res?.buddyCategory)
          ? res.buddyCategory
          : Array.isArray(res?.data)
          ? res.data
          : [];

        if (directCats.length === 0) {
          try {
            const v2Cache = await this.invokeNt(
              "nodeIKernelBuddyService/getBuddyListFromCache",
              { buddyListReqType: 0 },
              [0]
            );
            const v2Cats = Array.isArray(v2Cache)
              ? v2Cache
              : Array.isArray(v2Cache?.data)
              ? v2Cache.data
              : Array.isArray(v2Cache?.buddyCategory)
              ? v2Cache.buddyCategory
              : [];
            if (v2Cats.length > 0) {
              res = v2Cache;
              directCats = v2Cats;
            }
          } catch (_) {}
        }

        if (directCats.length === 0 || forceRefresh) {
          try {
            const v2Res = await this.invokeNt(
              "nodeIKernelBuddyService/getBuddyListV2",
              { callFrom: "ContactNodeStore", forceRefresh, reqType: 0 },
              ["ContactNodeStore", forceRefresh, 0]
            );
            const v2Cats = Array.isArray(v2Res)
              ? v2Res
              : Array.isArray(v2Res?.data)
              ? v2Res.data
              : Array.isArray(v2Res?.buddyCategory)
              ? v2Res.buddyCategory
              : [];
            if (v2Cats.length > 0) {
              res = v2Res;
              directCats = v2Cats;
            }
          } catch (_) {}
        }

        if (directCats.length > 0) {
          if (cancelWait) cancelWait();
          this.uinUidStore.rememberFromBuddyList(res);
          this._buddyCategoriesCache = directCats;
        } else if (forceRefresh || this._buddyCategoriesCache.length === 0) {
          await waitBuddyEvent;
        } else if (cancelWait) {
          cancelWait();
        }

        const categories =
          directCats.length > 0 ? directCats : this._buddyCategoriesCache;

        // Collect any V2 buddyUids across categories and batch-hydrate UIN + CoreInfo
        const v2Uids = [];
        for (const cat of categories) {
          if (Array.isArray(cat?.buddyUids)) {
            for (const uid of cat.buddyUids) {
              if (uid && typeof uid === "string") v2Uids.push(uid);
            }
          }
        }
        if (v2Uids.length > 0) {
          const missingUinUids = v2Uids.filter((uid) => !this.uinUidStore.getUinSync(uid));
          if (missingUinUids.length > 0) {
            try {
              const uinRes = await this.invokeNt(
                "nodeIKernelUixConvertService/getUin",
                { uids: missingUinUids },
                [missingUinUids]
              );
              const uinMap = uinRes?.uinInfo || uinRes;
              const pairs =
                uinMap instanceof Map
                  ? Array.from(uinMap.entries())
                  : uinMap && typeof uinMap === "object"
                  ? Object.entries(uinMap)
                  : [];
              for (const [uid, uin] of pairs) {
                if (uin && /^\d+$/.test(String(uin)) && Number(uin) > 0) {
                  this.uinUidStore.remember(String(uin), String(uid));
                }
              }
            } catch (_) {}
          }

          try {
            const coreRes = await this.invokeNt(
              "nodeIKernelProfileService/getCoreInfo",
              { callFrom: "BuddyList", uids: v2Uids },
              ["BuddyList", v2Uids]
            );
            const coreMap = coreRes?.coreInfos || coreRes;
            const pairs =
              coreMap instanceof Map
                ? Array.from(coreMap.entries())
                : coreMap && typeof coreMap === "object"
                ? Object.entries(coreMap)
                : [];
            for (const [uidKey, info] of pairs) {
              if (!info || typeof info !== "object") continue;
              const core = info.coreInfo || info;
              const uin = core.uin || this.uinUidStore.getUinSync(core.uid || uidKey);
              if (uin) {
                this.uinUidStore.remember(uin, core.uid || uidKey, {
                  nickname: core.nick || "",
                  remark: core.remark || "",
                });
              }
            }
          } catch (_) {}
        }

        const list = [];
        const seenUins = new Set();
        for (const cat of categories) {
          if (Array.isArray(cat?.buddyList)) {
            for (const b of cat.buddyList) {
              if (!b || typeof b !== "object") continue;
              const core = b.coreInfo || b.baseInfo || b;
              const uin = Number(b.uin || core.uin || 0);
              if (uin > 0 && !seenUins.has(uin)) {
                seenUins.add(uin);
                list.push({
                  user_id: uin,
                  nickname: String(b.nick || core.nick || b.nickname || uin),
                  remark: String(b.remark || core.remark || ""),
                });
              }
            }
          } else if (Array.isArray(cat?.buddyUids)) {
            for (const uid of cat.buddyUids) {
              let uinStr = this.uinUidStore.getUinSync(uid);
              if (!uinStr) {
                uinStr = await this.uinUidStore.resolveUin(uid, this.invokeNt.bind(this));
              }
              const uin = Number(uinStr || 0);
              if (uin > 0 && !seenUins.has(uin)) {
                seenUins.add(uin);
                const meta = this.uinUidStore.userMeta.get(String(uin)) || {};
                list.push({
                  user_id: uin,
                  nickname: String(meta.nickname || uin),
                  remark: String(meta.remark || ""),
                });
              }
            }
          } else if (cat && typeof cat === "object") {
            const core = cat.coreInfo || cat.baseInfo || cat;
            const uin = Number(cat.uin || core.uin || 0);
            if (uin > 0 && !seenUins.has(uin)) {
              seenUins.add(uin);
              list.push({
                user_id: uin,
                nickname: String(cat.nick || core.nick || cat.nickname || uin),
                remark: String(cat.remark || core.remark || ""),
              });
            }
          }
        }
        return list;
      }

      case "get_stranger_info": {
        const userId = Number(p.user_id || 0);
        const uid = await this.uinUidStore.resolveUid(userId, this.invokeNt.bind(this));
        let detail = null;
        if (uid) {
          try {
            const res = await this.invokeNt(
              "nodeIKernelProfileService/getUserDetailInfo",
              { uid },
              [uid]
            );
            detail = res?.info || res?.detail?.[uid] || res;
          } catch (_) {}
        }
        const core = detail?.simpleInfo?.coreInfo || detail?.coreInfo || detail || {};
        const base = detail?.simpleInfo?.baseInfo || detail?.baseInfo || detail || {};
        const cached = this.uinUidStore.userMeta.get(String(userId)) || {};
        const sexNum = Number(base.sex ?? core.sex ?? 0);
        const sex = sexNum === 1 ? "male" : sexNum === 2 ? "female" : "unknown";
        const level = Number(base.qqLevel ?? detail?.qqLevel ?? 0);
        return {
          user_id: userId,
          nickname: String(core.nick || detail?.nick || cached.nickname || ""),
          sex,
          age: Number(base.age ?? detail?.age ?? cached.age ?? 0),
          qq_level: level,
          level,
        };
      }

      case "delete_friend": {
        const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
        await this.invokeNt("nodeIKernelBuddyService/delBuddy", {
          delInfo: {
            friendUid: uid,
            tempBlock: Boolean(p.block),
            tempBothDel: true,
          },
        });
        return {};
      }

      case "set_friend_add_request": {
        const flag = String(p.flag || "");
        const [friendUidPart, reqTimePart] = flag.split(":");
        const cached = this._buddyReqsCache.get(flag);
        const friendUid =
          cached?.friendUid ||
          (friendUidPart?.startsWith("u_")
            ? friendUidPart
            : await this.uinUidStore.resolveUid(friendUidPart, this.invokeNt.bind(this)));
        const reqTime = String(cached?.reqTime || reqTimePart || Math.floor(Date.now() / 1000));
        await this.invokeNt("nodeIKernelBuddyService/approvalFriendRequest", {
          approvalInfo: {
            friendUid,
            reqTime,
            accept: Boolean(p.approve ?? true),
          },
        });
        return {};
      }

      case "set_friend_remark": {
        const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
        await this.invokeNt("nodeIKernelBuddyService/setBuddyRemark", {
          remarkParams: { uid, remark: String(p.remark ?? "") },
        });
        return {};
      }

      // ---- 6. Groups & Group Admin ----
      case "get_group_list": {
        let cancelWait = null;
        const waitGroupEvent = new Promise((resolve) => {
          const onUpdate = (groupList) => {
            clearTimeout(timer);
            this._groupListWaiters.delete(onUpdate);
            resolve(groupList);
          };
          const timer = setTimeout(() => {
            this._groupListWaiters.delete(onUpdate);
            resolve(null);
          }, 1200);
          if (typeof timer.unref === "function") timer.unref();
          cancelWait = () => {
            clearTimeout(timer);
            this._groupListWaiters.delete(onUpdate);
            resolve(null);
          };
          this._groupListWaiters.add(onUpdate);
        });

        let res;
        try {
          res = await this.invokeNt(
            "nodeIKernelGroupService/getGroupList",
            { force: Boolean(p.no_cache) },
            [Boolean(p.no_cache)]
          );
        } catch (err) {
          if (cancelWait) cancelWait();
          throw err;
        }

        const hasDirectGroups =
          Array.isArray(res) || Array.isArray(res?.groupList) || Array.isArray(res?.groups);
        if (hasDirectGroups) {
          if (cancelWait) cancelWait();
        } else if (Boolean(p.no_cache) || this._groupListCache.size === 0) {
          await waitGroupEvent;
        } else if (cancelWait) {
          cancelWait();
        }

        const rawGroups = hasDirectGroups
          ? Array.isArray(res)
            ? res
            : res?.groupList || res?.groups || []
          : Array.from(this._groupListCache.values());

        return rawGroups.map((g) => {
          const gid = Number(g.groupCode || g.groupUin || g.group_id || 0);
          if (gid > 0) this._setBoundedMap(this._groupListCache, String(gid), g);
          return {
            group_id: gid,
            group_name: String(g.groupName || g.info?.groupName || ""),
            member_count: Number(g.memberCount || g.info?.memberCount || 0),
            max_member_count: Number(g.maxMember || g.info?.memberMax || 0),
            group_create_time: Number(g.createTime || g.info?.createdTime || 0),
            group_level: Number(g.groupLevel || 0),
            group_memo: String(g.richFingerMemo || g.info?.announcement || ""),
          };
        });
      }

      case "get_group_info": {
        const groupId = Number(p.group_id || 0);
        try {
          const res = await this.invokeNt(
            "nodeIKernelGroupService/getGroupAllInfo",
            { groupCode: String(groupId), source: 4 },
            [String(groupId), 4]
          );
          const d = res?.groupInfo || res?.detail || res || {};
          if (d.groupName || d.memberCount || d.maxMember) {
            return {
              group_id: groupId,
              group_name: String(d.groupName || ""),
              member_count: Number(d.memberCount || 0),
              max_member_count: Number(d.maxMember || d.maxMemberCount || 0),
              group_create_time: Number(d.createTime || 0),
              group_level: Number(d.groupLevel || 0),
              group_memo: String(d.richFingerMemo || d.groupMemo || ""),
            };
          }
        } catch (_) {}
        const list = await this._dispatchAction("get_group_list", { no_cache: p.no_cache });
        return (
          list.find((g) => g.group_id === groupId) || {
            group_id: groupId,
            group_name: "",
            member_count: 0,
            max_member_count: 0,
            group_create_time: 0,
            group_level: 0,
            group_memo: "",
          }
        );
      }

      case "get_group_member_list": {
        const groupId = Number(p.group_id || 0);
        const groupCode = String(groupId);
        const forceFetch = Boolean(p.no_cache);
        let infos = null;
        let sceneId = "";
        const hasMemberEntries = (val) => {
          if (!val) return false;
          if (val instanceof Map) return val.size > 0;
          if (Array.isArray(val)) return val.length > 0;
          if (typeof val === "object") return Object.keys(val).length > 0;
          return false;
        };
        try {
          const sceneRes = await this.invokeNt(
            "nodeIKernelGroupService/createMemberListScene",
            { groupCode, scene: "groupMemberList_MainWindow" },
            [groupCode, "groupMemberList_MainWindow"]
          );
          sceneId = typeof sceneRes === "string" ? sceneRes : sceneRes?.sceneId || "";
          if (sceneId) {
            const listRes = await this.invokeNt(
              "nodeIKernelGroupService/getNextMemberList",
              { sceneId, lastId: undefined, prevId: undefined, num: 3000 },
              [sceneId, undefined, 3000]
            );
            infos = listRes?.result?.infos || listRes?.infos || listRes;
          }
        } catch (_) {} finally {
          if (sceneId) {
            this.invokeNt(
              "nodeIKernelGroupService/destroyMemberListScene",
              { sceneId },
              [sceneId]
            ).catch(() => {});
          }
        }
        if (!hasMemberEntries(infos) || forceFetch) {
          try {
            const allRes = await this.invokeNt(
              "nodeIKernelGroupService/getAllMemberList",
              { groupCode, force_fetch: forceFetch, forceFetch },
              [groupCode, forceFetch]
            );
            const allInfos = allRes?.result?.infos || allRes?.infos || allRes;
            if (hasMemberEntries(allInfos)) {
              infos = allInfos;
            }
          } catch (_) {}
        }
        this.uinUidStore.rememberFromGroupMemberList(groupCode, infos);
        const rawMembers =
          infos instanceof Map
            ? [...infos.values()]
            : Array.isArray(infos)
            ? infos
            : infos && typeof infos === "object"
            ? Object.values(infos)
            : [];
        const missingUids = rawMembers
          .filter((m) => m && !(Number(m.uin || m.user_id || 0) > 0) && m.uid)
          .map((m) => String(m.uid));
        if (missingUids.length > 0) {
          try {
            const uinRes = await this.invokeNt(
              "nodeIKernelUixConvertService/getUin",
              { uids: missingUids },
              [missingUids]
            );
            const uinMap = uinRes?.uinInfo || uinRes;
            const pairs =
              uinMap instanceof Map
                ? Array.from(uinMap.entries())
                : uinMap && typeof uinMap === "object"
                ? Object.entries(uinMap)
                : [];
            for (const [uid, uin] of pairs) {
              if (uin && /^\d+$/.test(String(uin)) && Number(uin) > 0) {
                this.uinUidStore.remember(String(uin), String(uid));
              }
            }
          } catch (_) {}
        }
        for (const m of rawMembers) {
          if (m && !(Number(m.uin || m.user_id || 0) > 0) && m.uid) {
            const resolvedUin = this.uinUidStore.getUinSync(m.uid);
            if (resolvedUin) {
              m.uin = String(resolvedUin);
            }
          }
        }
        this.uinUidStore.rememberFromGroupMemberList(groupCode, rawMembers);
        return rawMembers.map((m) => {
          const directUin = Number(m.uin || m.user_id || 0);
          const uin =
            directUin > 0
              ? directUin
              : Number((m.uid ? this.uinUidStore.getUinSync(m.uid) : 0) || 0);
          const roleNum = m.role ?? m.permission;
          const role =
            typeof roleNum === "string"
              ? roleNum
              : roleNum === 4 || roleNum === 1
              ? "owner"
              : roleNum === 3 || roleNum === 2
              ? "admin"
              : "member";
          return {
            group_id: groupId,
            user_id: uin,
            nickname: String(m.nick ?? m.nickname ?? m.memberName ?? ""),
            card: String(m.cardName ?? m.card ?? m.memberCard?.memberCard ?? ""),
            sex: "unknown",
            age: 0,
            area: "",
            join_time: Number(m.joinTime ?? m.joinTimestamp ?? 0),
            last_sent_time: Number(m.lastSpeakTime ?? m.lastMsgTimestamp ?? 0),
            level: String(m.memberLevel ?? m.level?.level ?? 0),
            role,
            unfriendly: false,
            title: String(m.memberSpecialTitle ?? m.specialTitle ?? m.title ?? ""),
            title_expire_time: 0,
            card_changeable: true,
          };
        });
      }

      case "get_group_member_info": {
        const groupId = Number(p.group_id || 0);
        const userId = Number(p.user_id || 0);
        const gKey = `${groupId}:${userId}`;
        if (!p.no_cache && this.uinUidStore.groupMemberMeta.has(gKey)) {
          const cached = this.uinUidStore.groupMemberMeta.get(gKey);
          // Only short-circuit cache when `cached.role` has been authoritatively populated
          if (cached && cached.role) {
            return {
              group_id: groupId,
              user_id: userId,
              nickname: cached.nickname || "",
              card: cached.card || "",
              sex: "unknown",
              age: 0,
              area: "",
              join_time: 0,
              last_sent_time: 0,
              level: "0",
              role: cached.role,
              unfriendly: false,
              title: cached.title || "",
              title_expire_time: 0,
              card_changeable: true,
            };
          }
        }

        // Try single-member query via nodeIKernelGroupService/getMemberInfo first
        try {
          const uid = await this.uinUidStore.resolveUid(userId, this.invokeNt.bind(this));
          if (uid) {
            const singleRes = await this.invokeNt(
              "nodeIKernelGroupService/getMemberInfo",
              {
                groupCode: String(groupId),
                uids: [uid],
                force_fetch: Boolean(p.no_cache),
                forceFetch: Boolean(p.no_cache),
              },
              [String(groupId), [uid], Boolean(p.no_cache)]
            );
            const infos = singleRes?.result?.infos || singleRes?.infos;
            if (infos) {
              this.uinUidStore.rememberFromGroupMemberList(String(groupId), infos);
              const refreshed = this.uinUidStore.groupMemberMeta.get(gKey);
              if (refreshed && refreshed.role) {
                return {
                  group_id: groupId,
                  user_id: userId,
                  nickname: refreshed.nickname || "",
                  card: refreshed.card || "",
                  sex: "unknown",
                  age: 0,
                  area: "",
                  join_time: 0,
                  last_sent_time: 0,
                  level: "0",
                  role: refreshed.role,
                  unfriendly: false,
                  title: refreshed.title || "",
                  title_expire_time: 0,
                  card_changeable: true,
                };
              }
            }
          }
        } catch (_) {}

        const members = await this._dispatchAction("get_group_member_list", {
          group_id: groupId,
          no_cache: p.no_cache,
        });
        return (
          members.find((m) => Number(m.user_id) === userId) || {
            group_id: groupId,
            user_id: userId,
            nickname: "",
            card: "",
            sex: "unknown",
            age: 0,
            area: "",
            join_time: 0,
            last_sent_time: 0,
            level: "0",
            role: "member",
            unfriendly: false,
            title: "",
            title_expire_time: 0,
            card_changeable: true,
          }
        );
      }

      case "set_group_kick": {
        const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
        await this.invokeNt(
          "nodeIKernelGroupService/kickMember",
          {
            groupCode: String(p.group_id),
            kickUids: [uid],
            refuseForever: Boolean(p.reject_add_request),
            kickReason: "",
          },
          [String(p.group_id), [uid], Boolean(p.reject_add_request), ""]
        );
        return {};
      }

      case "set_group_ban": {
        const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
        const memList = [{ uid, timeStamp: Number(p.duration ?? 1800) }];
        await this.invokeNt(
          "nodeIKernelGroupService/banMember",
          { groupCode: String(p.group_id), memList },
          [String(p.group_id), memList]
        );
        return {};
      }

      case "set_group_whole_ban": {
        const enable = Boolean(p.enable ?? true);
        const groupInfo = {
          groupCode: String(p.group_id),
          shutUpAllMember: enable ? 1 : 0,
        };
        await this.invokeNt(
          "nodeIKernelGroupService/modifyGroupExtInfo",
          { groupInfo },
          [groupInfo]
        );
        return {};
      }

      case "set_group_admin": {
        const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
        const enable = Boolean(p.enable ?? true);
        const role = enable ? 3 : 2;
        await this.invokeNt(
          "nodeIKernelGroupService/modifyMemberRole",
          { groupCode: String(p.group_id), uid, role },
          [String(p.group_id), uid, role]
        );
        const gKey = `${Number(p.group_id || 0)}:${Number(p.user_id || 0)}`;
        if (this.uinUidStore.groupMemberMeta.has(gKey)) {
          const prev = this.uinUidStore.groupMemberMeta.get(gKey);
          this.uinUidStore.groupMemberMeta.set(gKey, {
            ...prev,
            role: enable ? "admin" : "member",
          });
        }
        return {};
      }

      case "set_group_card": {
        const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
        await this.invokeNt(
          "nodeIKernelGroupService/modifyMemberCardName",
          {
            groupCode: String(p.group_id),
            uid,
            cardName: String(p.card ?? ""),
          },
          [String(p.group_id), uid, String(p.card ?? "")]
        );
        return {};
      }

      case "set_group_special_title": {
        const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
        const specialTitle = String(p.special_title ?? "");
        const expireTime = Number(p.duration ?? -1);
        try {
          await this.invokeNt(
            "nodeIKernelGroupService/setIdentityTitleInfo",
            {
              groupCode: String(p.group_id),
              uid,
              specialTitle,
              expireTime,
            },
            [String(p.group_id), uid, specialTitle, expireTime]
          );
        } catch (_) {
          await this.invokeNt("nodeIKernelGroupService/modifyMemberSpecialTitle", {
            groupCode: String(p.group_id),
            uid,
            specialTitle,
          });
        }
        return {};
      }

      case "set_group_name": {
        await this.invokeNt(
          "nodeIKernelGroupService/modifyGroupName",
          {
            groupCode: String(p.group_id),
            groupName: String(p.group_name ?? ""),
            isConf: false,
          },
          [String(p.group_id), String(p.group_name ?? ""), false]
        );
        return {};
      }

      case "set_group_leave": {
        await this.invokeNt(
          "nodeIKernelGroupService/quitGroup",
          { groupCode: String(p.group_id) },
          [String(p.group_id)]
        );
        return {};
      }

      case "set_group_add_request": {
        const flag = String(p.flag || "");
        const cached = this._groupNotifiesCache.get(flag);
        const parts = flag.split(":");
        const seq = cached?.seq || parts[0] || flag;
        const notifyType = Number(cached?.type || parts[1] || (p.sub_type === "invite" ? 2 : 1));
        const groupCode = String(cached?.group?.groupCode || parts[2] || p.group_id || "");
        const approve = Boolean(p.approve ?? true);
        await this.invokeNt("nodeIKernelGroupService/operateSysNotify", {
          doubt: false,
          operateMsg: {
            operateType: approve ? 1 : 2,
            targetMsg: {
              seq: String(seq),
              type: notifyType,
              groupCode,
              postscript: String(p.reason || ""),
            },
          },
        });
        return {};
      }

      case "get_group_system_msg":
      case "get_group_ignored_notifies":
      case "get_group_ignore_add_request": {
        const doubt = action !== "get_group_system_msg";
        const res = await this.invokeNt(
          "nodeIKernelGroupService/getSingleScreenNotifies",
          { doubt, startSeq: "", number: 50 },
          [doubt, "", 50]
        );
        const notifies = Array.isArray(res?.notifies) ? res.notifies : [];
        const invited_requests = [];
        const join_requests = [];
        for (const item of notifies) {
          const seq = String(item.seq || "");
          const nType = Number(item.type || 1);
          const gid = Number(item.group?.groupCode || 0);
          const flag = `${seq}:${nType}:${gid}`;
          this._setBoundedMap(this._groupNotifiesCache, flag, item);
          const entry = {
            request_id: Number(seq || 0),
            invitor_uin: Number(item.user2?.uin || this.uinUidStore.getUinSync(item.user2?.uid) || 0),
            invitor_nick: String(item.user2?.nickName || ""),
            group_id: gid,
            group_name: String(item.group?.groupName || ""),
            requester_uin: Number(item.user1?.uin || this.uinUidStore.getUinSync(item.user1?.uid) || 0),
            requester_nick: String(item.user1?.nickName || ""),
            message: String(item.postscript || ""),
            checked: Number(item.status) !== 1,
            actor: Number(item.actionUser?.uin || 0),
            flag,
          };
          if (nType === 2) invited_requests.push(entry);
          else join_requests.push(entry);
        }
        if (action === "get_group_system_msg") {
          return { invited_requests, join_requests };
        }
        return [...invited_requests, ...join_requests];
      }

      case "get_essence_msg_list": {
        const groupId = String(p.group_id || "");
        if (isWebCredentialApiEnabled(this.config) && this.config.allowExternalHttp !== false) {
          try {
            const cookies = await this._getCookiesObject("qun.qq.com");
            const bkn = computeBkn(cookies.p_skey || cookies.skey);
            const url = `https://qun.qq.com/cgi-bin/group_digest/digest_list?bkn=${bkn}&page_start=0&page_limit=50&group_code=${groupId}`;
            const text = await httpRequestText(url, "GET", "", {
              Cookie: cookieObjToString(cookies),
            });
            const parsed = parseJsonpOrJson(text);
            if (Array.isArray(parsed?.data?.msg_list)) {
              return parsed.data.msg_list;
            }
          } catch (_) {}
        }
        for (const essenceCmd of [
          "nodeIKernelGroupService/getGroupLatestEssenceList",
          "nodeIKernelGroupService/fetchGroupEssenceList",
          "nodeIKernelGroupService/getGroupEssenceList",
        ]) {
          try {
            const res = await this.invokeNt(essenceCmd, { groupCode: groupId }, [groupId]);
            if (res && (Array.isArray(res.msgList) || Array.isArray(res.list))) {
              return res.msgList || res.list;
            }
            if (res !== undefined) return res?.msgList || [];
          } catch (_) {}
        }
        return [];
      }

      case "set_essence_msg":
      case "delete_essence_msg": {
        const entry =
          this.messageIdStore.getByShortId(p.message_id) ||
          this.messageIdStore.getByMsgId(p.message_id);
        if (!entry) throw new Error("message not found");
        const cmd =
          action === "set_essence_msg"
            ? "nodeIKernelGroupService/addGroupEssence"
            : "nodeIKernelGroupService/removeGroupEssence";
        await this.invokeNt(cmd, {
          param: {
            groupCode: String(entry.peer?.peerUid || entry.groupId || p.group_id || ""),
            msgRandom: Number(entry.rawMsg?.msgRandom || 0),
            msgSeq: Number(entry.msgSeq || 0),
          },
        });
        return {};
      }

      case "_send_group_notice": {
        const groupCode = String(p.group_id || "");
        const content = String(p.content || "");
        if (isWebCredentialApiEnabled(this.config) && this.config.allowExternalHttp !== false) {
          try {
            const cookies = await this._getCookiesObject("qun.qq.com");
            if (cookies.skey || cookies.p_skey) {
              const bodyBkn = computeBkn(cookies.skey || cookies.p_skey);
              const urlBkn = computeBkn(cookies.p_skey || cookies.skey);
              const body = new URLSearchParams({
                qid: groupCode,
                bkn: String(bodyBkn),
                text: content,
                pinned: String(p.pinned ?? 0),
                type: String(p.type ?? 1),
                settings: JSON.stringify({
                  is_show_edit_card: 1,
                  tip_window_type: 1,
                  confirm_required: Number(p.confirm_required ?? 1),
                }),
              }).toString();
              const url = `https://web.qun.qq.com/cgi-bin/announce/add_qun_notice?bkn=${urlBkn}`;
              const text = await httpRequestText(url, "POST", body, {
                Cookie: cookieObjToString(cookies),
                "Content-Type": "application/x-www-form-urlencoded",
              });
              const json = parseJsonpOrJson(text);
              if (json && json.ec === 0) return {};
            }
          } catch (_) {}
        }
        await this.invokeNt("nodeIKernelGroupService/publishGroupBulletin", {
          groupCode,
          pskey: "",
          data: {
            text: content,
            pinned: Number(p.pinned ?? 0),
            isShowEditCard: 1,
            tipWindowType: 1,
            confirmRequired: Number(p.confirm_required ?? 1),
          },
        });
        return {};
      }

      case "_get_group_notice": {
        const groupCode = String(p.group_id || "");
        try {
          const res = await this.invokeNt("nodeIKernelGroupService/getGroupBulletin", {
            groupCode,
          });
          if (Array.isArray(res?.feeds)) {
            return res.feeds;
          }
        } catch (_) {}
        if (isWebCredentialApiEnabled(this.config) && this.config.allowExternalHttp !== false) {
          try {
            const cookies = await this._getCookiesObject("qun.qq.com");
            if (cookies.skey || cookies.p_skey) {
              const bodyBkn = computeBkn(cookies.skey || cookies.p_skey);
              const urlBkn = computeBkn(cookies.p_skey || cookies.skey);
              const body = new URLSearchParams({
                qid: groupCode,
                bkn: String(bodyBkn),
                ft: "23",
                s: "-1",
                n: "20",
                i: "1",
                ni: "1",
              }).toString();
              const url = `https://web.qun.qq.com/cgi-bin/announce/list_announce?bkn=${urlBkn}`;
              const text = await httpRequestText(url, "POST", body, {
                Cookie: cookieObjToString(cookies),
                "Content-Type": "application/x-www-form-urlencoded",
                Referer: "https://web.qun.qq.com/mannounce/index.html?_wv=1031&_bid=148",
              });
              const ret = parseJsonpOrJson(text);
              if (ret && Array.isArray(ret.feeds)) {
                return ret.feeds.map((f) => ({
                  notice_id: String(f.fid || ""),
                  sender_id: Number(f.u || 0),
                  publish_time: Number(f.pubt || 0),
                  message: {
                    text: String(f.msg?.text || ""),
                    images: (f.msg?.pics || []).map((pic) => ({
                      id: pic.id,
                      width: pic.w,
                      height: pic.h,
                    })),
                  },
                }));
              }
            }
          } catch (_) {}
        }
        return [];
      }

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

      case "get_group_honor_info": {
        const groupId = Number(p.group_id || 0);
        return {
          group_id: groupId,
          current_talkative: null,
          talkative_list: [],
          performer_list: [],
          legend_list: [],
          strong_newbie_list: [],
          emotion_list: [],
        };
      }

      case "get_doubt_friends_add_request": {
        const res = await this.invokeNt("nodeIKernelBuddyService/getDoubtBuddyReq", {});
        return Array.isArray(res?.doubtList) ? res.doubtList : [];
      }

      case "set_doubt_friends_add_request": {
        await this.invokeNt("nodeIKernelBuddyService/approvalDoubtBuddyReq", {
          reqId: String(p.flag || p.req_id || ""),
          accept: Boolean(p.approve ?? true),
        });
        return {};
      }

      case "get_friend_With_category":
      case "get_friends_with_category": {
        const res = await this.invokeNt(
          "nodeIKernelBuddyService/getBuddyList",
          { noCache: Boolean(p.no_cache) },
          [Boolean(p.no_cache)]
        );
        return Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
      }

      default:
        throw new Error(`Unsupported OneBot action: ${action}`);
    }
  }

  // --------------------------------------------------------------------------
  // Built-in Zero-Dependency HTTP Server, WS Server, and Reverse WS Client
  // --------------------------------------------------------------------------

  _checkAuth(req, expectedToken, parsedUrl = null) {
    return checkRequestAuth(req, expectedToken, {
      allowQueryToken: this.config.allowQueryAccessToken !== false,
      parsedUrl,
    });
  }

  async startServers() {
    enforceProtectedModeOnServers(
      [...(this.config.httpServers || []), ...(this.config.wsServers || [])],
      this.config,
      (msg) => {
        try {
          process.stderr.write("[rosmontis] SECURITY WARNING: " + msg + "\n");
        } catch (_) {}
      }
    );

    // 1. Start HTTP Server(s)
    for (const httpCfg of this.config.httpServers || []) {
      const endpointMsgFormat = httpCfg.messageFormat || this.config.messageFormat || "array";
      await new Promise((resolve) => {
        const srv = http.createServer(async (req, res) => {
          req.on("error", () => {});
          res.on("error", () => {});

          const originRes = checkOriginHeader(req, {
            allowedOrigins: httpCfg.allowedOrigins || this.config.allowedOrigins || [],
          });
          if (!originRes.allowed) {
            res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
            res.end(
              JSON.stringify({
                status: "failed",
                retcode: 1403,
                message: "Forbidden: Origin not allowed",
              })
            );
            return;
          }

          let u;
          try {
            u = new URL(req.url || "/", "http://127.0.0.1");
          } catch (_) {
            u = new URL("/", "http://127.0.0.1");
          }

          if (!this._checkAuth(req, httpCfg.accessToken, u)) {
            res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ status: "failed", retcode: 1403, message: "Unauthorized" }));
            return;
          }

          const actionName = u.pathname.replace(/^\/+/, "");
          if (req.method === "GET" && (actionName === "health" || actionName === "")) {
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(
              JSON.stringify({
                status: "ok",
                retcode: 0,
                self_id: Number(this.selfUin || 0),
                online: this.online,
              })
            );
            return;
          }

          try {
            const params = await readHttpJsonBody(req, {
              maxBodyBytes: this.config.maxHttpBodyBytes || DEFAULT_MAX_HTTP_BODY_BYTES,
            });
            for (const [k, v] of u.searchParams.entries()) {
              if (!(k in params)) params[k] = v;
            }
            const act = actionName || String(params.action || "");
            const actParams =
              params.params !== undefined
                ? params.params && typeof params.params === "object" && !Array.isArray(params.params)
                  ? params.params
                  : {}
                : params;
            const reply = await this.handleOneBotAction(act, actParams, params.echo, {
              messageFormat: endpointMsgFormat,
            });
            if (!res.writableEnded) {
              res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
              res.end(JSON.stringify(reply));
            }
          } catch (err) {
            if (!res.writableEnded) {
              if (err && (err.statusCode === 413 || err.code === "ERR_HTTP_BODY_TOO_LARGE")) {
                res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
                res.end(
                  JSON.stringify({
                    status: "failed",
                    retcode: 1413,
                    message: err.message,
                  })
                );
                return;
              }
              const msg = err && err.message ? err.message : String(err);
              res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
              res.end(
                JSON.stringify({
                  status: "failed",
                  retcode: 1400,
                  data: null,
                  message: msg,
                  wording: msg,
                })
              );
            }
          }
        });
        srv.on("error", () => resolve());
        srv.listen(Number(httpCfg.port ?? 3000), httpCfg.host || "0.0.0.0", () => {
          this._httpServers.push(srv);
          resolve();
        });
      });
    }

    // 2. Start Forward WebSocket Server(s)
    for (const wsCfg of this.config.wsServers || []) {
      const endpointMsgFormat = wsCfg.messageFormat || this.config.messageFormat || "array";
      await new Promise((resolve) => {
        const srv = http.createServer((_req, res) => {
          res.writeHead(426);
          res.end("Upgrade Required");
        });
        srv.on("upgrade", (req, socket, head) => {
          socket.on("error", () => {});

          const originRes = checkOriginHeader(req, {
            allowedOrigins: wsCfg.allowedOrigins || this.config.allowedOrigins || [],
          });
          if (!originRes.allowed) {
            socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
          }

          let u = null;
          try {
            u = new URL(req.url || "/", "http://127.0.0.1");
          } catch (_) {}

          if (!this._checkAuth(req, wsCfg.accessToken, u)) {
            socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
          }
          const rawSecKey = req.headers["sec-websocket-key"];
          const secKey = sanitizeHeaderValue(rawSecKey);
          if (!secKey) {
            socket.destroy();
            return;
          }
          const accept = sanitizeHeaderValue(
            crypto
              .createHash("sha1")
              .update(secKey + WS_GUID)
              .digest("base64")
          );
          socket.write(
            [
              "HTTP/1.1 101 Switching Protocols",
              "Upgrade: websocket",
              "Connection: Upgrade",
              `Sec-WebSocket-Accept: ${accept}`,
              "",
              "",
            ].join("\r\n")
          );
          const conn = new Rfc6455Connection(socket, {
            isClient: false,
            maxPayloadBytes: this.config.maxWsPayloadBytes || DEFAULT_MAX_WS_PAYLOAD_BYTES,
            allowUnmaskedClientFrames: Boolean(this.config.allowUnmaskedClientFrames),
          });
          conn.reportSelfMessage = Boolean(wsCfg.reportSelfMessage);
          conn._messageFormat = endpointMsgFormat;
          this._wsServerClients.add(conn);

          conn.on("error", () => {
            this._wsServerClients.delete(conn);
            try {
              socket.destroy();
            } catch (_) {}
          });
          conn.on("close", () => {
            this._wsServerClients.delete(conn);
          });

          conn.sendJson(
            formatMetaEvent("lifecycle", { sub_type: "connect" }, { selfId: this.selfUin })
          );

          conn.on("message", async (text) => {
            try {
              const payload = JSON.parse(text);
              if (payload && typeof payload === "object" && !Array.isArray(payload) && payload.action) {
                const actParams =
                  payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)
                    ? payload.params
                    : {};
                const reply = await this.handleOneBotAction(
                  payload.action,
                  actParams,
                  payload.echo,
                  { messageFormat: conn._messageFormat || "array" }
                );
                conn.sendJson(reply);
              }
            } catch (_) {}
          });
          if (head && head.length > 0) {
            conn._onData(head);
          }
        });
        srv.on("error", () => resolve());
        srv.listen(Number(wsCfg.port ?? 3001), wsCfg.host || "0.0.0.0", () => {
          this._wsServers.push(srv);
          resolve();
        });
      });
    }

    // 3. Start Reverse WebSocket Client(s)
    for (const clientCfg of this.config.wsClients || []) {
      if (!clientCfg.url) continue;
      this._startReverseWsLoop(clientCfg);
    }

    // 4. Start Heartbeat Timer
    if (!this._heartbeatTimer && this.config.heartbeatIntervalMs > 0) {
      this._heartbeatTimer = setInterval(() => {
        this.broadcastOneBotEvent(
          formatMetaEvent(
            "heartbeat",
            {
              status: { online: this.online, good: this.online },
              interval: this.config.heartbeatIntervalMs,
            },
            { selfId: this.selfUin }
          )
        );
      }, this.config.heartbeatIntervalMs);
      if (typeof this._heartbeatTimer.unref === "function") {
        this._heartbeatTimer.unref();
      }
    }
  }

  _startReverseWsLoop(clientCfg) {
    const endpointMsgFormat = clientCfg.messageFormat || this.config.messageFormat || "array";
    const entry = {
      cfg: clientCfg,
      conn: null,
      connecting: false,
      stopped: false,
      timer: null,
      handle: null,
      connectedSelfId: "0",
      immediateReconnectOnce: false,
      messageFormat: endpointMsgFormat,
    };
    this._reverseWsClients.push(entry);

    const connectOnce = () => {
      if (entry.stopped || entry.connecting || (entry.conn && !entry.conn.closed)) return;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      entry.connecting = true;
      const currentSelfId = sanitizeHeaderValue(String(this.selfUin || "0"));
      const headers = {
        "X-Self-ID": currentSelfId,
        "X-Client-Role": sanitizeHeaderValue(clientCfg.role || "Universal"),
        "User-Agent": "OneBot/11 Rosmontis/1.0.0",
      };
      if (clientCfg.accessToken) {
        headers["Authorization"] = `Bearer ${sanitizeHeaderValue(clientCfg.accessToken)}`;
      }
      entry.handle = connectReverseWebSocket(
        clientCfg.url,
        headers,
        (conn) => {
          entry.connecting = false;
          entry.conn = conn;
          entry.connectedSelfId = currentSelfId;
          conn._messageFormat = entry.messageFormat;
          conn.sendJson(
            formatMetaEvent("lifecycle", { sub_type: "connect" }, { selfId: this.selfUin })
          );
        },
        async (text, conn) => {
          try {
            const payload = JSON.parse(text);
            if (payload && typeof payload === "object" && !Array.isArray(payload) && payload.action) {
              const actParams =
                payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)
                  ? payload.params
                  : {};
              const reply = await this.handleOneBotAction(
                payload.action,
                actParams,
                payload.echo,
                { messageFormat: entry.messageFormat || "array" }
              );
              conn.sendJson(reply);
            }
          } catch (_) {}
        },
        () => {
          entry.connecting = false;
          entry.conn = null;
          if (!entry.stopped) {
            if (entry.timer) {
              clearTimeout(entry.timer);
              entry.timer = null;
            }
            const fastReconnect = Boolean(entry.immediateReconnectOnce);
            entry.immediateReconnectOnce = false;
            const delay = fastReconnect
              ? 50
              : Math.max(500, Number(clientCfg.reconnectIntervalMs || 5000));
            entry.timer = setTimeout(connectOnce, delay);
            if (typeof entry.timer.unref === "function") entry.timer.unref();
          }
        },
        {
          maxPayloadBytes: this.config.maxWsPayloadBytes || DEFAULT_MAX_WS_PAYLOAD_BYTES,
        }
      );
    };

    connectOnce();
  }

  async stopServers() {
    this._aioInteractionSeq += 1;
    this._clearIdleTimers();
    this._sessionScheduler.dispose();
    this._rejectPendingRendererCmds(null, "bridge servers stopped");
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    for (const rev of this._reverseWsClients) {
      rev.stopped = true;
      if (rev.timer) clearTimeout(rev.timer);
      if (rev.conn) rev.conn.close();
      if (rev.handle) rev.handle.close();
    }
    this._reverseWsClients = [];
    this._wsClientHandles = this._reverseWsClients;
    for (const client of this._wsServerClients) {
      client.close();
    }
    this._wsServerClients.clear();
    for (const srv of [...this._httpServers, ...this._wsServers]) {
      await new Promise((resolve) => srv.close(() => resolve()));
    }
    this._httpServers = [];
    this._wsServers = [];
    this.flushTempCleanup();
  }
}

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
