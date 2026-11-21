// @ts-check
"use strict";

/**
 * Stateful Hot-Reload Engine for Rosmontis (`src/core/hot_reload.js`)
 *
 * Keeps the early-boot Electron/NTQQ shell intact (`singletonBridge`, captured
 * `ntApi`/`ntStore`/`wrapperSession`, `Map.prototype.set` capture state, active
 * HTTP/WebSocket listeners, and in-memory `MessageIdStore`/`UinUidStore` data)
 * while atomically reloading protocol converters, OneBot v11 action handlers,
 * composed subsystem controller classes, configuration budgets, and injected
 * renderer scripts.
 *
 * Guarantees:
 * - Transactional `require.cache` swap: if any module or `bridge_renderer.js`
 *   has a syntax/load/contract error, `require.cache` and live prototypes/routes
 *   are rolled back untouched.
 * - Zero state loss: live composed controllers (`NtCaptureController`,
 *   `RendererIpcController`, `InboundPipeline`, `MediaHydrator`, `LoginRecovery`,
 *   `OutboundPipeline`, `ServerRuntime`, `HotReloadController`), `MessageIdStore`,
 *   `UinUidStore`, and `CausalSessionScheduler` instances have their prototypes
 *   upgraded in-place and retained `rawMsg` records are re-indexed for new lookup keys.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { isQuietLogsEnabled, isTestModeFromEnv } = require("./env");

/** @typedef {import("../types").BridgeHost} BridgeHost */

const CORE_RELOAD_SEQUENCE = Object.freeze([
  "core/env.js",
  "core/wire_codec.js",
  "core/primitives.js",
  "core/nt_normalizer.js",
  "core/ntqq_meta.js",
  "core/image_probe.js",
  "core/media_downloader.js",
  "core/media_security.js",
  "core/rkey_manager.js",
  "core/audio_codec.js",
  "onebot/stores.js",
  "onebot/cq_codec.js",
  "onebot/segment_converter.js",
  "onebot/event_formatter.js",
  "bridge_onebot.js",
  "core/transport_security.js",
  "core/ws_rfc6455.js",
  "core/config.js",
  "core/web_http.js",
  "core/qzone_actions.js",
  "core/echo_correlator.js",
  "core/rate_limiter.js",
  "core/capability_probe.js",
  "core/session_scheduler.js",
  "core/session_controller.js",
  "core/nt_capture.js",
  "core/renderer_ipc.js",
  "core/media_hydrator.js",
  "core/login_recovery.js",
  "core/inbound_pipeline.js",
  "core/outbound_pipeline.js",
  "core/server_runtime.js",
  "core/hot_reload.js",
]);

const OPTIONAL_CORE_MODULES = new Set([
  "core/wire_codec.js",
  "core/hot_reload.js",
  "core/rkey_manager.js",
  "core/ntqq_meta.js",
  "core/image_probe.js",
  "core/media_downloader.js",
  "core/media_hydrator.js",
  "core/login_recovery.js",
  "core/rate_limiter.js",
  "core/capability_probe.js",
]);

/**
 * @param {string} dirPath
 * @returns {string[]}
 */
function _listSortedJsFiles(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return [];
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((ent) => ent.isFile() && ent.name.endsWith(".js"))
      .map((ent) => ent.name)
      .sort();
  } catch (_readErr) {
    // Missing or unreadable directory returns empty module list cleanly.
    return [];
  }
}

/**
 * @param {string | null} [rootDir]
 * @returns {{ codeDigest: string, fileCount: number, files: string[] }}
 */
function computeBridgeCodeDigest(rootDir) {
  const baseDir = path.resolve(rootDir || path.join(__dirname, ".."));
  /** @type {string[]} */
  const relFiles = [];

  for (const top of [
    "app_launcher_index.js",
    "bridge_main.js",
    "bridge_onebot.js",
    "bridge_renderer.js",
    "plugin_loader.js",
    "types.js",
  ]) {
    if (fs.existsSync(path.join(baseDir, top))) {
      relFiles.push(top);
    }
  }
  for (const subdir of ["core", "onebot", "actions"]) {
    const names = _listSortedJsFiles(path.join(baseDir, subdir));
    for (const name of names) {
      relFiles.push(`${subdir}/${name}`);
    }
  }

  const hash = crypto.createHash("sha256");
  for (const rel of relFiles) {
    const full = path.join(baseDir, rel);
    try {
      const buf = fs.readFileSync(full);
      hash.update(`${rel}:${buf.length}\0`);
      hash.update(buf);
      hash.update("\0");
    } catch (_fileErr) {
      // Skip transiently removed file while hashing; digest remains deterministic for readable files.
    }
  }

  return {
    codeDigest: hash.digest("hex").slice(0, 12),
    fileCount: relFiles.length,
    files: relFiles,
  };
}

/**
 * @param {any} store
 * @param {any} NewMessageIdStore
 */
function _migrateMessageIdStore(store, NewMessageIdStore) {
  if (!store || typeof store !== "object" || typeof NewMessageIdStore !== "function") {
    return { retainedMessages: 0, reindexedRawMessages: 0 };
  }
  Object.setPrototypeOf(store, NewMessageIdStore.prototype);

  if (!(store.byShortId instanceof Map)) store.byShortId = new Map();
  store.byOneBotId = store.byShortId;
  if (!(store.byMsgId instanceof Map)) store.byMsgId = new Map();
  if (!(store.byPeerSeq instanceof Map)) store.byPeerSeq = new Map();
  if (!(store._rawIds instanceof Set)) store._rawIds = new Set();
  if (!(store.byMediaKey instanceof Map)) store.byMediaKey = new Map();
  if (!(store.byForwardId instanceof Map)) store.byForwardId = new Map();
  if (!Number.isFinite(Number(store._seqCounter))) store._seqCounter = 100000;
  if (!Number.isFinite(Number(store.maxEntries)) || store.maxEntries < 2) {
    store.maxEntries = 10000;
  }
  if (!Number.isFinite(Number(store.maxRawEntries)) || store.maxRawEntries < 0) {
    store.maxRawEntries = 256;
  }

  let reindexedRawMessages = 0;
  if (typeof store.indexMsgMedia === "function") {
    for (const [shortId, entry] of store.byShortId.entries()) {
      if (!entry || typeof entry !== "object") continue;
      if (!(entry._mediaKeys instanceof Set)) entry._mediaKeys = new Set();
      if (!(entry._forwardKeys instanceof Set)) entry._forwardKeys = new Set();
      if (entry.rawMsg && typeof entry.rawMsg === "object") {
        try {
          store.indexMsgMedia(entry.rawMsg, shortId);
          reindexedRawMessages += 1;
        } catch (_reindexErr) {
          // Skip malformed cached rawMsg during post-reload media re-indexing.
        }
      }
    }
  }

  return {
    retainedMessages: store.byShortId.size,
    reindexedRawMessages,
  };
}

/**
 * @param {any} store
 * @param {any} NewUinUidStore
 */
function _migrateUinUidStore(store, NewUinUidStore) {
  if (!store || typeof store !== "object" || typeof NewUinUidStore !== "function") {
    return { retainedUsers: 0 };
  }
  Object.setPrototypeOf(store, NewUinUidStore.prototype);
  if (!(store.uinToUid instanceof Map)) store.uinToUid = new Map();
  if (!(store.uidToUin instanceof Map)) store.uidToUin = new Map();
  if (!(store.pendingByUid instanceof Map)) store.pendingByUid = new Map();
  if (!(store.pendingByUin instanceof Map)) store.pendingByUin = new Map();
  if (!Number.isFinite(Number(store.maxEntries)) || store.maxEntries < 16) {
    store.maxEntries = 20000;
  }
  return {
    retainedUsers: store.uidToUin.size,
  };
}

/**
 * @param {any} scheduler
 * @param {any} NewScheduler
 * @param {any} config
 */
function _migrateSessionScheduler(scheduler, NewScheduler, config) {
  if (!scheduler || typeof scheduler !== "object" || typeof NewScheduler !== "function") {
    return;
  }
  Object.setPrototypeOf(scheduler, NewScheduler.prototype);
  if (config && typeof config === "object") {
    if (config.aioSwitchCooldownMs !== undefined) {
      scheduler.switchCooldownMs = Number(config.aioSwitchCooldownMs) || 0;
    }
    if (config.enforceSwitchCooldownOnSend !== undefined) {
      scheduler.enforceHardCooldownOnExplicit = Boolean(config.enforceSwitchCooldownOnSend);
    }
  }
}

class HotReloadController {
  /**
   * @param {BridgeHost | Partial<BridgeHost>} bridge
   * @param {((nextMap: Map<string, any>) => void) | null} [syncDispatchMap=null]
   */
  constructor(bridge, syncDispatchMap = null) {
    /** @type {BridgeHost} */
    this.bridge = /** @type {BridgeHost} */ (bridge);
    /** @type {((nextMap: Map<string, any>) => void) | null} */
    this._syncDispatchMap = syncDispatchMap;
    /** @type {Promise<any>} */
    this._reloadChain = Promise.resolve();
    /** @type {Record<string, any>} */
    this.reloadStats = {
      count: 0,
      failed: 0,
      codeDigest: "",
      previousDigest: null,
      loadedAt: bridge?.startedAtMs || Date.now(),
      lastReloadAt: null,
      lastSource: null,
      lastError: null,
    };
  }

  /**
   * Installs a process-wide `SIGUSR2` hot-reload handler once on POSIX non-test runtimes.
   * @param {() => (BridgeHost | null)} getActiveBridge
   */
  static installProcessSignalHandler(getActiveBridge) {
    if (
      process.platform === "win32" ||
      isTestModeFromEnv() ||
      /** @type {any} */ (process).__rosmontisSigusr2Installed
    ) {
      return;
    }
    try {
      Object.defineProperty(process, "__rosmontisSigusr2Installed", {
        value: true,
        enumerable: false,
        configurable: true,
        writable: false,
      });
      process.on("SIGUSR2", () => {
        const active = typeof getActiveBridge === "function" ? getActiveBridge() : null;
        if (active && typeof active.reloadBridge === "function") {
          active
            .reloadBridge({ source: "SIGUSR2", reloadConfig: true, reloadRenderer: true })
            .catch((/** @type {any} */ err) => {
              try {
                process.stderr.write(
                  `[rosmontis] SIGUSR2 hot-reload failed: ${err?.message || String(err)}\n`
                );
              } catch (_stderrErr) {
                // Ignore broken stderr pipe when running detached.
              }
            });
        }
      });
    } catch (sigErr) {
      const active = typeof getActiveBridge === "function" ? getActiveBridge() : null;
      active?.logger?.debug?.("hot_reload.sigusr2", sigErr);
    }
  }

  /**
   * @param {string | null} [customRootDir=null]
   */
  getCodeDigestInfo(customRootDir = null) {
    const rootDir = path.resolve(
      customRootDir || this.bridge?._bridgeRootDir || path.join(__dirname, "..")
    );
    return computeBridgeCodeDigest(rootDir);
  }

  /**
   * @param {Record<string, any>} [options={}]
   */
  async reloadBridge(options = {}) {
    const opts = options && typeof options === "object" ? options : {};
    const runReload = () => this._performReloadBridgeUnlocked(opts);
    const prevChain = this._reloadChain || Promise.resolve();
    const nextPromise = prevChain.then(runReload, runReload);
    this._reloadChain = nextPromise.catch((err) => {
      this.bridge?.logger?.debug?.("hot_reload", err);
    });
    return await nextPromise;
  }

  /**
   * @param {Record<string, any>} [opts={}]
   */
  async _performReloadBridgeUnlocked(opts = {}) {
    const bridge = this.bridge;
    const startedAt = Date.now();
    const rootDir = path.resolve(
      opts.moduleDir || bridge?._bridgeRootDir || path.join(__dirname, "..")
    );
    const source = String(opts.source || "manual");
    const reloadRenderer = opts.reloadRenderer !== false;
    const shouldReloadConfig =
      Boolean(opts.config) ||
      opts.reloadConfig === true ||
      (opts.reloadConfig !== false && !bridge?._explicitConfig);

    if (!this.reloadStats || typeof this.reloadStats !== "object") {
      this.reloadStats = {
        count: 0,
        failed: 0,
        codeDigest: "",
        previousDigest: null,
        loadedAt: bridge?.startedAtMs || startedAt,
        lastReloadAt: null,
        lastSource: null,
        lastError: null,
      };
    }

    const previousDigest =
      this.reloadStats.codeDigest || computeBridgeCodeDigest(rootDir).codeDigest;

    // 1. Discover action modules dynamically so newly added action files load too.
    // Load concrete action modules before facade routers (e.g. file_media_actions.js).
    const actionsDir = path.join(rootDir, "actions");
    const discoveredActionNames = _listSortedJsFiles(actionsDir);
    const orderedActionNames = [
      ...discoveredActionNames.filter((n) => n !== "file_media_actions.js"),
      ...discoveredActionNames.filter((n) => n === "file_media_actions.js"),
    ];
    const actionFiles = orderedActionNames.map((f) => `actions/${f}`);
    if (actionFiles.length === 0) {
      this.reloadStats.failed += 1;
      this.reloadStats.lastError = `No action modules found in ${actionsDir}`;
      throw new Error(this.reloadStats.lastError);
    }

    // 2. Pre-validate renderer script syntax before evicting any module cache
    /** @type {string | null} */
    let rawRendererCode = null;
    const rendererPath = path.join(rootDir, "bridge_renderer.js");
    if (reloadRenderer && fs.existsSync(rendererPath)) {
      try {
        rawRendererCode = fs.readFileSync(rendererPath, "utf8");
        new vm.Script(rawRendererCode, { filename: rendererPath });
      } catch (/** @type {any} */ syntaxErr) {
        this.reloadStats.failed += 1;
        this.reloadStats.lastError = `bridge_renderer.js syntax error: ${
          syntaxErr?.message || String(syntaxErr)
        }`;
        throw new Error(this.reloadStats.lastError);
      }
    }

    // 3. Resolve reloadable module paths & snapshot existing require.cache
    const relTargets = [...CORE_RELOAD_SEQUENCE, ...actionFiles];
    /** @type {Array<{ rel: string, resolved: string }>} */
    const resolvedTargets = [];
    /** @type {Map<string, any>} */
    const backupCache = new Map();

    try {
      for (const rel of relTargets) {
        const candidatePath = path.join(rootDir, rel);
        if (!fs.existsSync(candidatePath)) {
          if (OPTIONAL_CORE_MODULES.has(rel)) continue;
          throw new Error(`Missing required bridge module: ${rel}`);
        }
        const resolved = require.resolve(candidatePath);
        resolvedTargets.push({ rel, resolved });
        if (Object.prototype.hasOwnProperty.call(require.cache, resolved)) {
          backupCache.set(resolved, require.cache[resolved]);
        }
      }
    } catch (/** @type {any} */ resolveErr) {
      this.reloadStats.failed += 1;
      this.reloadStats.lastError = resolveErr?.message || String(resolveErr);
      throw resolveErr;
    }

    for (const { resolved } of resolvedTargets) {
      delete require.cache[resolved];
    }

    /** @type {Map<string, any>} */
    const loadedByRel = new Map();
    /** @type {Map<string, any>} */
    const nextActionDispatchMap = new Map();
    /** @type {string | null} */
    let rendererCode = rawRendererCode;

    try {
      for (const { rel, resolved } of resolvedTargets) {
        loadedByRel.set(rel, require(resolved));
      }

      const freshWireCodec = loadedByRel.get("core/wire_codec.js");
      if (
        rawRendererCode &&
        typeof freshWireCodec?.injectWireCodecIntoRendererSource === "function"
      ) {
        rendererCode = freshWireCodec.injectWireCodecIntoRendererSource(rawRendererCode);
      }

      const freshPrimitives = loadedByRel.get("core/primitives.js");
      const freshBridgeOnebot = loadedByRel.get("bridge_onebot.js");
      const freshConfig = loadedByRel.get("core/config.js");
      const freshEchoCorrelator = loadedByRel.get("core/echo_correlator.js");
      const freshRateLimiter = loadedByRel.get("core/rate_limiter.js");
      const freshSessionScheduler = loadedByRel.get("core/session_scheduler.js");
      const freshSessionController = loadedByRel.get("core/session_controller.js");
      const freshNtCapture = loadedByRel.get("core/nt_capture.js");
      const freshRendererIpc = loadedByRel.get("core/renderer_ipc.js");
      const freshMediaHydrator = loadedByRel.get("core/media_hydrator.js");
      const freshLoginRecovery = loadedByRel.get("core/login_recovery.js");
      const freshInbound = loadedByRel.get("core/inbound_pipeline.js");
      const freshOutbound = loadedByRel.get("core/outbound_pipeline.js");
      const freshServerRuntime = loadedByRel.get("core/server_runtime.js");
      const freshHotReload = loadedByRel.get("core/hot_reload.js");

      if (
        !freshBridgeOnebot ||
        typeof freshBridgeOnebot.MessageIdStore !== "function" ||
        typeof freshBridgeOnebot.UinUidStore !== "function"
      ) {
        throw new Error("Reloaded bridge_onebot.js failed contract check");
      }
      if (!freshConfig || typeof freshConfig.loadBridgeConfig !== "function") {
        throw new Error("Reloaded core/config.js failed contract check");
      }
      for (const [label, Ctor] of [
        ["NtCaptureController", freshNtCapture?.NtCaptureController],
        ["RendererIpcController", freshRendererIpc?.RendererIpcController],
        ["InboundPipeline", freshInbound?.InboundPipeline],
        ["OutboundPipeline", freshOutbound?.OutboundPipeline],
        ["ServerRuntime", freshServerRuntime?.ServerRuntime],
      ]) {
        if (typeof Ctor !== "function") {
          throw new Error(`Reloaded ${label} failed contract check`);
        }
      }

      for (const rel of actionFiles) {
        const mod = loadedByRel.get(rel);
        if (
          !mod ||
          typeof mod.dispatch !== "function" ||
          !mod.HANDLED_ACTIONS ||
          typeof mod.HANDLED_ACTIONS[Symbol.iterator] !== "function"
        ) {
          throw new Error(`Reloaded ${rel} failed action module contract check`);
        }
        if (
          rel === "actions/file_media_actions.js" &&
          loadedByRel.has("actions/file_actions.js") &&
          loadedByRel.has("actions/media_profile_actions.js")
        ) {
          continue;
        }
        for (const act of mod.HANDLED_ACTIONS) {
          nextActionDispatchMap.set(act, mod.dispatch);
        }
      }
      if (nextActionDispatchMap.size === 0) {
        throw new Error("Reloaded action dispatch table is empty");
      }

      // 4. Commit phase: upgrade composed subsystem controller prototypes in-place
      if (bridge.ntCapture && typeof freshNtCapture?.NtCaptureController === "function") {
        Object.setPrototypeOf(bridge.ntCapture, freshNtCapture.NtCaptureController.prototype);
      }
      if (bridge.rendererIpc && typeof freshRendererIpc?.RendererIpcController === "function") {
        Object.setPrototypeOf(bridge.rendererIpc, freshRendererIpc.RendererIpcController.prototype);
      }
      if (bridge.inboundPipeline && typeof freshInbound?.InboundPipeline === "function") {
        Object.setPrototypeOf(bridge.inboundPipeline, freshInbound.InboundPipeline.prototype);
      }
      if (
        bridge.inboundPipeline?.mediaHydrator &&
        typeof freshMediaHydrator?.MediaHydrator === "function"
      ) {
        Object.setPrototypeOf(
          bridge.inboundPipeline.mediaHydrator,
          freshMediaHydrator.MediaHydrator.prototype
        );
      }
      if (
        bridge.inboundPipeline?.loginRecovery &&
        typeof freshLoginRecovery?.LoginRecovery === "function"
      ) {
        Object.setPrototypeOf(
          bridge.inboundPipeline.loginRecovery,
          freshLoginRecovery.LoginRecovery.prototype
        );
      }
      if (bridge.outboundPipeline && typeof freshOutbound?.OutboundPipeline === "function") {
        Object.setPrototypeOf(bridge.outboundPipeline, freshOutbound.OutboundPipeline.prototype);
      }
      if (bridge.serverRuntime && typeof freshServerRuntime?.ServerRuntime === "function") {
        Object.setPrototypeOf(bridge.serverRuntime, freshServerRuntime.ServerRuntime.prototype);
      }
      if (typeof freshHotReload?.HotReloadController === "function") {
        Object.setPrototypeOf(this, freshHotReload.HotReloadController.prototype);
      }

      const nextSigFn =
        freshEchoCorrelator?._ntElementsSignature || freshOutbound?._ntElementsSignature;
      const nextMatchFn =
        freshEchoCorrelator?._elementsSignatureMatch || freshOutbound?._elementsSignatureMatch;
      const bridgeCtor = /** @type {any} */ (bridge.constructor);
      if (bridgeCtor && typeof nextSigFn === "function") {
        bridgeCtor._ntElementsSignature = nextSigFn;
      }
      if (bridgeCtor && typeof nextMatchFn === "function") {
        bridgeCtor._elementsSignatureMatch = nextMatchFn;
      }

      bridge._bridgeRootDir = rootDir;
      bridge._actionDispatchMap = nextActionDispatchMap;
      if (typeof this._syncDispatchMap === "function") {
        this._syncDispatchMap(nextActionDispatchMap);
      } else if (typeof bridge._syncModuleActionDispatchMap === "function") {
        bridge._syncModuleActionDispatchMap(nextActionDispatchMap);
      }

      if (shouldReloadConfig) {
        const prevHttpServers = bridge.config?.httpServers;
        const prevWsServers = bridge.config?.wsServers;
        const prevWsClients = bridge.config?.wsClients;
        const nextCfg =
          opts.config || freshConfig.loadBridgeConfig(opts.configDir || bridge._configDir);
        if (opts.config) {
          bridge._explicitConfig = true;
        }
        // Keep active listener endpoint definitions stable while updating runtime tunables
        if (bridge.serverRuntime?._httpServers?.length > 0 && Array.isArray(prevHttpServers)) {
          nextCfg.httpServers = prevHttpServers;
        }
        if (bridge.serverRuntime?._wsServers?.length > 0 && Array.isArray(prevWsServers)) {
          nextCfg.wsServers = prevWsServers;
        }
        if (bridge.serverRuntime?._reverseWsClients?.length > 0 && Array.isArray(prevWsClients)) {
          nextCfg.wsClients = prevWsClients;
        }
        bridge.config = nextCfg;
      }

      _migrateMessageIdStore(bridge.messageIdStore, freshBridgeOnebot.MessageIdStore);
      _migrateUinUidStore(bridge.uinUidStore, freshBridgeOnebot.UinUidStore);
      if (bridge.logger && typeof freshPrimitives?.BridgeLogger === "function") {
        Object.setPrototypeOf(bridge.logger, freshPrimitives.BridgeLogger.prototype);
      }
      if (bridge.eventDedupe && typeof freshPrimitives?.TtlDedupeSet === "function") {
        Object.setPrototypeOf(bridge.eventDedupe, freshPrimitives.TtlDedupeSet.prototype);
      }
      if (bridge.tempCleanupQueue && typeof freshPrimitives?.TempCleanupQueue === "function") {
        Object.setPrototypeOf(bridge.tempCleanupQueue, freshPrimitives.TempCleanupQueue.prototype);
      }
      if (bridge.echoCorrelator && typeof freshEchoCorrelator?.EchoCorrelator === "function") {
        Object.setPrototypeOf(bridge.echoCorrelator, freshEchoCorrelator.EchoCorrelator.prototype);
      }
      if (
        bridge.outboundPipeline?.rateLimiter &&
        typeof freshRateLimiter?.OutboundRateLimiter === "function"
      ) {
        Object.setPrototypeOf(
          bridge.outboundPipeline.rateLimiter,
          freshRateLimiter.OutboundRateLimiter.prototype
        );
      }
      if (
        bridge.sessionController &&
        typeof freshSessionController?.HumanSessionController === "function"
      ) {
        Object.setPrototypeOf(
          bridge.sessionController,
          freshSessionController.HumanSessionController.prototype
        );
      }
      _migrateSessionScheduler(
        bridge.sessionController?.scheduler,
        freshSessionScheduler?.CausalSessionScheduler,
        bridge.config
      );
    } catch (/** @type {any} */ loadErr) {
      // Transactional rollback: restore exact prior require.cache entries
      for (const { resolved } of resolvedTargets) {
        if (backupCache.has(resolved)) {
          require.cache[resolved] = backupCache.get(resolved);
        } else {
          delete require.cache[resolved];
        }
      }
      this.reloadStats.failed += 1;
      this.reloadStats.lastError = loadErr?.message || String(loadErr);
      throw loadErr;
    }

    // 5. Refresh renderer script cache & re-inject into live trusted BrowserWindows
    let rendererReload = { reloadedCount: 0, failedCount: 0 };
    if (reloadRenderer && typeof bridge.rendererIpc?._reloadRendererWebContents === "function") {
      try {
        rendererReload = await bridge.rendererIpc._reloadRendererWebContents(rendererCode);
      } catch (reloadErr) {
        bridge?.logger?.debug?.("hot_reload.renderer", reloadErr);
      }
    } else if (typeof bridge.rendererIpc?._invalidateRendererBridgeCache === "function") {
      bridge.rendererIpc._invalidateRendererBridgeCache();
    }

    const digestInfo = computeBridgeCodeDigest(rootDir);
    const elapsedMs = Date.now() - startedAt;

    this.reloadStats = {
      count: (this.reloadStats.count || 0) + 1,
      failed: this.reloadStats.failed || 0,
      previousDigest,
      codeDigest: digestInfo.codeDigest,
      loadedAt: this.reloadStats.loadedAt || bridge?.startedAtMs || startedAt,
      lastReloadAt: Date.now(),
      lastSource: source,
      lastElapsedMs: elapsedMs,
      lastError: null,
      reloadedModuleCount: resolvedTargets.length,
      actionCount: nextActionDispatchMap.size,
      reloadedRenderers: rendererReload.reloadedCount,
    };

    if (!isQuietLogsEnabled(bridge?.config)) {
      try {
        process.stderr.write(
          `[rosmontis] Hot-reloaded bridge (${previousDigest} -> ${digestInfo.codeDigest}, modules=${resolvedTargets.length}, actions=${nextActionDispatchMap.size}, msgs=${bridge?.messageIdStore?.size || 0}, renderers=${rendererReload.reloadedCount}, ${elapsedMs}ms)\n`
        );
      } catch (_stderrErr) {
        // Ignore broken stderr pipe in detached/headless container runs.
      }
    }

    return {
      reloaded: true,
      source,
      previous_digest: previousDigest,
      code_digest: digestInfo.codeDigest,
      changed: previousDigest !== digestInfo.codeDigest,
      reloaded_modules: resolvedTargets.map((t) => t.rel),
      action_count: nextActionDispatchMap.size,
      retained_messages: bridge?.messageIdStore?.size || 0,
      retained_users: bridge?.uinUidStore?.uidToUin?.size || 0,
      reloaded_renderers: rendererReload.reloadedCount,
      failed_renderers: rendererReload.failedCount,
      elapsed_ms: elapsedMs,
    };
  }
}

module.exports = {
  CORE_RELOAD_SEQUENCE,
  computeBridgeCodeDigest,
  HotReloadController,
};
