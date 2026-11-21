// @ts-check
"use strict";

/**
 * NTQQ Main-Process & Renderer-Coordinated OneBot v11 Bridge (`bridge_main.js`)
 *
 * Lean pure-JavaScript coordinator (zero C++ hooks, zero npm dependencies) composing
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
  BridgeLogger, TtlDedupeSet, TempCleanupQueue,
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
const { HotReloadController, computeBridgeCodeDigest } = require("./core/hot_reload");

const messageActions = require("./actions/message_actions");
const contactActions = require("./actions/contact_actions");
const groupActions = require("./actions/group_actions");
const fileMediaActions = require("./actions/file_media_actions");

/** @typedef {import("./types").BridgeHost} BridgeHost */
/** @typedef {import("./types").BridgeOptions} BridgeOptions */
/** @typedef {import("./types").BridgeConfig} BridgeConfig */
/** @typedef {import("./types").CapturedServices} CapturedServices */
/** @typedef {import("./types").CapabilityProbeCache} CapabilityProbeCache */
/** @typedef {import("./types").ActionContext} ActionContext */
/** @typedef {import("./types").InvokeNtOptions} InvokeNtOptions */
/** @typedef {import("./types").OneBotActionResponse} OneBotActionResponse */

const WEB_HTTP_HELPERS = Object.freeze({
  computeBkn, cookieObjToString, httpsGetCookies, httpRequestText, parseJsonpOrJson,
});

const ACTION_MODULES = [messageActions, contactActions, groupActions, fileMediaActions];
/** @type {Map<string, (action: string, p: Record<string, any>, context?: ActionContext) => Promise<any>>} */
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
    this._explicitConfig = Boolean(options.config);
    this._bridgeRootDir = __dirname;
    /** @type {BridgeConfig} */
    this.config = options.config || loadBridgeConfig(options.configDir);
    this.logger = new BridgeLogger({ getConfig: () => this.config });
    this.messageIdStore =
      options.messageIdStore || new MessageIdStore(10000, 256, { logger: this.logger });
    this.uinUidStore =
      options.uinUidStore || new UinUidStore(20000, { logger: this.logger });
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
      canInvokeRenderer: () => Boolean(this.rendererIpc._canInvokeRenderer(this.activeWebContents)),
      invokeRendererCommand: (action, payload, timeoutMs) =>
        this.rendererIpc._invokeRendererCommand(action, payload, timeoutMs),
      getRendererHooks: () => ({
        simulateSession: this.rendererSimulateSession,
        leaveSession: this.rendererLeaveSession,
      }),
      logger: this.logger,
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
    /** @type {CapabilityProbeCache | null} */
    this._capabilityProbeCache = null;
    /** @type {{ track: (filePath: string) => void } | null} */
    this.tempFileCleaner = null;

    // Composed Core Subsystems
    /** @type {BridgeHost} */
    const hostRef = this;
    this.ntCapture = new NtCaptureController(hostRef);
    this.rendererIpc = new RendererIpcController(hostRef);
    this.inboundPipeline = new InboundPipeline(hostRef);
    this.outboundPipeline = new OutboundPipeline(hostRef);
    this.serverRuntime = new ServerRuntime(hostRef);
    this.hotReload = new HotReloadController(hostRef, (nextMap) => {
      ACTION_DISPATCH_MAP.clear();
      nextMap.forEach((fn, act) => ACTION_DISPATCH_MAP.set(act, fn));
    });
    this.richMediaStats = {
      downloaded: 0, timedOut: 0, skippedByBudget: 0,
      lastTimeout: null, lastError: null, recentErrors: [],
    };
    this._actionDispatchMap = ACTION_DISPATCH_MAP;
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

  flushTempCleanup() { return this.tempCleanupQueue.flush(); }

  // Public Telemetry & Transport Accessors
  get sendEchoStats() { return this.echoCorrelator.stats; }
  set sendEchoStats(v) { if (v && typeof v === "object") this.echoCorrelator.stats = v; }
  get mapHookRelease() { return this.ntCapture.mapHookRelease; }
  set mapHookRelease(v) { this.ntCapture.mapHookRelease = v; }
  get activeWebContents() { return this.rendererIpc.activeWebContents; }
  set activeWebContents(v) { this.rendererIpc.activeWebContents = v; }
  get invokeStats() { return this.rendererIpc.invokeStats; }
  set invokeStats(v) { if (v && typeof v === "object") this.rendererIpc.invokeStats = v; }
  get rendererHealthStats() { return this.rendererIpc.rendererHealthStats; }
  set rendererHealthStats(v) { this.rendererIpc.rendererHealthStats = v; }
  get rateLimiter() { return this.outboundPipeline.rateLimiter; }
  set rateLimiter(v) { this.outboundPipeline.rateLimiter = v; }
  get webhookStats() { return this.serverRuntime.webhookStats; }
  set webhookStats(v) { this.serverRuntime.webhookStats = v; }
  get listenErrors() { return this.serverRuntime.listenErrors; }
  set listenErrors(v) { this.serverRuntime.listenErrors = v; }
  get reloadStats() { return this.hotReload.reloadStats; }
  set reloadStats(v) { if (v && typeof v === "object") this.hotReload.reloadStats = v; }
  get wsClients() { return this.serverRuntime._wsServerClients; }
  get reverseWsClients() { return this.serverRuntime._reverseWsClients; }

  // Public Lifecycle & Subsystem Entrypoints
  /** @param {Record<string, any>} [opts] */
  simulateHumanSession(opts) { return this.sessionController.simulate(opts); }
  /** @param {Record<string, any>} [opts] */
  leaveHumanSession(opts) { return this.sessionController.leave(opts); }

  installMapPrototypeHook() { return this.ntCapture.installMapPrototypeHook(); }
  /** @param {string} [reason] */
  releaseMapPrototypeHook(reason) { return this.ntCapture.releaseMapPrototypeHook(reason); }
  installWrapperHook() { return this.ntCapture.installWrapperHook(); }
  /** @param {Record<string, any>} [options] */
  probeExistingRuntime(options) { return this.ntCapture.probeExistingRuntime(options); }

  /** @param {any} [electronModule] */
  installElectronHooks(electronModule) { return this.rendererIpc.installElectronHooks(electronModule); }
  /**
   * @param {string} cmd
   * @param {Record<string, any>} [payload]
   * @param {any[] | null} [positionalArgs]
   * @param {InvokeNtOptions | null} [invokeOptions]
   */
  invokeNt(cmd, payload, positionalArgs, invokeOptions) {
    return this.rendererIpc.invokeNt(cmd, payload, positionalArgs, invokeOptions);
  }

  startServers() { return this.serverRuntime.startServers(); }
  stopServers() { return this.serverRuntime.stopServers(); }
  /** @param {Record<string, any>} [options] */
  reloadConfig(options) { return this.serverRuntime.reloadConfig(options); }
  /** @param {string | null} [customRootDir=null] */
  getCodeDigestInfo(customRootDir = null) { return this.hotReload.getCodeDigestInfo(customRootDir); }
  /** @param {Record<string, any>} [options={}] */
  reloadBridge(options = {}) { return this.hotReload.reloadBridge(options); }

  // Event Formatting & Broadcast
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

    const wsServerClients = this.serverRuntime._wsServerClients;
    for (const client of wsServerClients) {
      if (client.closed) {
        wsServerClients.delete(client);
        continue;
      }
      if (client._wsRole === "api") continue;
      if (event.post_type === "message_sent" && !client.reportSelfMessage) continue;
      const targetFormat = client._messageFormat || defaultFormat;
      client.sendJson(this._formatEventForEndpoint(event, targetFormat));
    }

    for (const rev of this.serverRuntime._reverseWsClients) {
      if (!rev.conn || rev.conn.closed) continue;
      if (event.post_type === "message_sent" && !rev.cfg?.reportSelfMessage) continue;
      const targetFormat = rev.messageFormat || rev.cfg?.messageFormat || defaultFormat;
      rev.conn.sendJson(this._formatEventForEndpoint(event, targetFormat));
    }

    this.serverRuntime._dispatchHttpWebhookEvent(event);
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
    const dispatchMap =
      this._actionDispatchMap instanceof Map ? this._actionDispatchMap : ACTION_DISPATCH_MAP;
    const handler = dispatchMap.get(action);
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
      const active = singletonBridge;
      if (options.configDir !== undefined) active._configDir = options.configDir;
      const nextCfg = options.config || loadBridgeConfig(options.configDir);
      active.config = nextCfg;
      const task =
        options.autoStartServers === false
          ? active.stopServers()
          : active.reloadConfig({ config: nextCfg, restartServers: true });
      task.catch((err) => {
        active.logger?.error?.("Failed to reconfigure bridge servers", err);
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
      bridge.logger?.error?.("Failed to start bridge servers", err);
    });
  }
  singletonBridge = bridge;
  HotReloadController.installProcessSignalHandler(() => singletonBridge);
  return bridge;
}

if (require.main !== module && !isAutoInstallDisabledFromEnv() && process.versions?.electron) {
  installMainBridge();
}

module.exports = {
  NtqqOneBotBridge, Rfc6455Connection, encodeWsFrame, connectReverseWebSocket,
  loadBridgeConfig, computeBkn, getNtqqVersionMetadata, buildNtqqUserAgent,
  pruneTempDir, computeBridgeCodeDigest, installMainBridge,
};
