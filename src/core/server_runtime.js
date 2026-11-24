// @ts-check
"use strict";

/**
 * Built-in HTTP API, Forward/Reverse WebSocket, Webhook Queue & Hot-Reload Runtime (`src/core/server_runtime.js`)
 *
 * Composed controller (`ServerRuntime`) owning HTTP API servers (`/health`, `/ready`,
 * Prometheus `/metrics`), Forward WS servers (`/` `/api` `/event`), Reverse WS loops,
 * bounded HTTP POST webhook queues with exponential backoff retries and Quick Operations,
 * and deadlock-free `reloadConfig` / `SIGHUP` hot reload.
 */

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");

const { formatMetaEvent } = require("../bridge_onebot");
const { loadBridgeConfig } = require("./config");

const {
  WS_GUID,
  DEFAULT_MAX_WS_SEND_BUFFER_BYTES,
  Rfc6455Connection,
  connectReverseWebSocket,
} = require("./ws_rfc6455");

const {
  DEFAULT_MAX_HTTP_BODY_BYTES,
  DEFAULT_MAX_WS_PAYLOAD_BYTES,
  sanitizeHeaderValue,
  checkRequestAuth,
  checkOriginHeader,
  enforceProtectedModeOnServers,
  readHttpJsonBody,
} = require("./transport_security");

const { isQuietLogsEnabled } = require("./env");
const { pruneNtCache } = require("./nt_cache_pruner");

/** @typedef {import("../types").BridgeHost} BridgeHost */
/** @typedef {import("../types").BridgeConfig} BridgeConfig */
/** @typedef {import("../types").ActionContext} ActionContext */
/** @typedef {import("../types").ListenErrorEntry} ListenErrorEntry */
/** @typedef {import("../types").WebhookStats} WebhookStats */
/** @typedef {import("../types").ReloadConfigResult} ReloadConfigResult */

const JSON_CONTENT_TYPE_HEADERS = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
});

const PROMETHEUS_CONTENT_TYPE_HEADERS = Object.freeze({
  "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
});

const NETWORK_RELOAD_KEYS = Object.freeze([
  "httpServers",
  "wsServers",
  "wsClients",
  "heartbeatIntervalMs",
  "wsPingIntervalMs",
  "wsPongTimeoutMs",
]);

/**
 * @param {any} res
 * @param {number} statusCode
 * @param {any} payload
 * @param {Record<string, string> | null} [extraHeaders=null]
 * @returns {boolean}
 */
function writeHttpJson(res, statusCode, payload, extraHeaders = null) {
  if (!res || res.writableEnded || res.destroyed) return false;
  const headers =
    extraHeaders && typeof extraHeaders === "object"
      ? { ...JSON_CONTENT_TYPE_HEADERS, ...extraHeaders }
      : JSON_CONTENT_TYPE_HEADERS;
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(payload));
  return true;
}

/**
 * @param {string} pathname
 * @returns {"api" | "event" | "universal"}
 */
function classifyForwardWsRole(pathname) {
  const raw = typeof pathname === "string" && pathname.length > 0 ? pathname : "/";
  const normalized = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
  if (normalized === "/api") return "api";
  if (normalized === "/event") return "event";
  return "universal";
}

/**
 * @param {any} val
 * @returns {string}
 */
function _stableSerialize(val) {
  if (val === undefined) return "undefined";
  if (val === null || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) {
    return `[${val.map((item) => _stableSerialize(item)).join(",")}]`;
  }
  const keys = Object.keys(val).sort();
  const pairs = [];
  for (const k of keys) {
    if (val[k] === undefined) continue;
    pairs.push(`${JSON.stringify(k)}:${_stableSerialize(val[k])}`);
  }
  return `{${pairs.join(",")}}`;
}

/**
 * @param {Record<string, any>} [prevConfig={}]
 * @param {Record<string, any>} [nextConfig={}]
 * @returns {{ changedKeys: string[], networkChangedKeys: string[], networkChanged: boolean }}
 */
function computeConfigDiff(prevConfig = {}, nextConfig = {}) {
  const prev = prevConfig && typeof prevConfig === "object" ? prevConfig : {};
  const next = nextConfig && typeof nextConfig === "object" ? nextConfig : {};
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  /** @type {string[]} */
  const changedKeys = [];
  for (const key of Array.from(allKeys).sort()) {
    if (_stableSerialize(prev[key]) !== _stableSerialize(next[key])) {
      changedKeys.push(key);
    }
  }
  /** @type {Set<string>} */
  const networkSet = new Set(NETWORK_RELOAD_KEYS);
  const networkChangedKeys = changedKeys.filter((k) => networkSet.has(k));
  return {
    changedKeys,
    networkChangedKeys,
    networkChanged: networkChangedKeys.length > 0,
  };
}

/**
 * @param {number} statusCode
 * @returns {boolean}
 */
function isRetryableWebhookStatus(statusCode) {
  const code = Number(statusCode || 0);
  return code === 429 || code >= 500;
}

/**
 * @param {Record<string, any>} [endpointCfg={}]
 * @param {string} [defaultMsgFormat="array"]
 */
function buildEndpointActionContext(endpointCfg = {}, defaultMsgFormat = "array") {
  const cfg = endpointCfg && typeof endpointCfg === "object" ? endpointCfg : {};
  return {
    messageFormat: cfg.messageFormat || defaultMsgFormat || "array",
    compatProfile: cfg.compatProfile || cfg.compat_profile,
    compatAppName: cfg.compatAppName || cfg.compat_app_name,
    compatAppVersion: cfg.compatAppVersion || cfg.compat_app_version,
  };
}

/**
 * @param {number} retcode
 * @param {any} message
 * @param {any} [echo=undefined]
 */
function buildFailedActionReply(retcode, message, echo = undefined) {
  const msg = message !== undefined && message !== null ? String(message) : "";
  return {
    status: "failed",
    retcode: Number.isFinite(Number(retcode)) ? Number(retcode) : 1400,
    data: null,
    message: msg,
    wording: msg,
    ...(echo !== undefined ? { echo } : {}),
  };
}

const MAX_WEBHOOK_RESPONSE_BYTES = 1024 * 1024;
const QUICK_OP_KEYS = Object.freeze([
  "reply",
  "auto_escape",
  "at_sender",
  "delete",
  "kick",
  "ban",
  "ban_duration",
  "approve",
  "reason",
  "remark",
]);

/**
 * @param {any} obj
 * @returns {boolean}
 */
function hasMeaningfulQuickOperation(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  for (const key of QUICK_OP_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) {
      return true;
    }
  }
  return false;
}

/**
 * Composed HTTP / WebSocket / Webhook / Hot-Reload transport runtime.
 */
class ServerRuntime {
  /**
   * @param {BridgeHost | Partial<BridgeHost>} [bridge={}]
   */
  constructor(bridge = {}) {
    /** @type {BridgeHost} */
    this.bridge = /** @type {BridgeHost} */ (bridge || {});
    /** @type {http.Server[]} */
    this._httpServers = [];
    /** @type {http.Server[]} */
    this._wsServers = [];
    /** @type {Set<any>} */
    this._wsServerClients = new Set();
    /** @type {any[]} */
    this._reverseWsClients = [];
    /** @type {any[]} */
    this._wsClientHandles = this._reverseWsClients;
    /** @type {Set<any>} */
    this._activeWebhookReqs = new Set();
    /** @type {Set<{ timer: ReturnType<typeof setTimeout> | null, cancel: () => void }>} */
    this._webhookRetryTimers = new Set();
    /** @type {Array<{ clientCfg: Record<string, any>, event: any, resolve: (val: any) => void, reject: (err: any) => void }>} */
    this._webhookQueue = [];
    /** @type {number} */
    this._webhookGeneration = 0;
    /** @type {WebhookStats} */
    this.webhookStats = { ok: 0, failed: 0, retries: 0, dropped: 0, inFlight: 0, queued: 0 };
    /** @type {(() => void) | null} */
    this._sighupHandler = null;
    /** @type {ListenErrorEntry[]} */
    this.listenErrors = [];
    /** @type {ReturnType<typeof setInterval> | null} */
    this._heartbeatTimer = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this._wsPingTimer = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this._livenessTimer = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this._ntCachePruneTimer = null;
    /** @type {boolean} */
    this._stopped = false;
    /** @type {AsyncLocalStorage<any> | null} */
    this._transportAsyncLocal = null;
    /** @type {Promise<any> | null} */
    this._reloadChain = null;
    /** @type {Set<() => void>} */
    this._pendingDeferredReloadCancels = new Set();
    /** @type {Promise<void> | null} */
    this._pendingNetworkRestart = null;
  }

  /** @returns {BridgeConfig | undefined} */
  get config() {
    return this.bridge.config;
  }

  /** @returns {InstanceType<typeof import("./primitives").BridgeLogger> | undefined} */
  get logger() {
    return this.bridge.logger;
  }

  /** @param {any} err */
  _debugSafe(err) {
    try {
      this.logger?.debug?.("server_runtime", err);
    } catch (_logErr) {
      // Benign: never let debug logging fail inside transport/cleanup handlers.
    }
  }

  /**
   * @param {any} req
   * @param {string | undefined} expectedToken
   * @param {URL | null} [parsedUrl=null]
   * @returns {boolean}
   */
  _checkAuth(req, expectedToken, parsedUrl = null) {
    return checkRequestAuth(req, expectedToken, {
      allowQueryToken: this.config?.allowQueryAccessToken !== false,
      parsedUrl,
    });
  }

  /**
   * @param {string} kind
   * @param {string} host
   * @param {number} port
   * @param {any} err
   */
  _recordListenError(kind, host, port, err) {
    if (!Array.isArray(this.listenErrors)) {
      this.listenErrors = [];
    }
    /** @type {ListenErrorEntry} */
    const entry = {
      kind: String(kind || "server"),
      host: String(host || ""),
      port: Number(port),
      code: err?.code || "ERR_LISTEN_FAILED",
      message: err?.message || String(err),
      ts: Date.now(),
    };
    const dupIdx = this.listenErrors.findIndex(
      (e) =>
        e.kind === entry.kind &&
        e.host === entry.host &&
        Object.is(e.port, entry.port) &&
        e.code === entry.code
    );
    if (dupIdx !== -1) {
      this.listenErrors[dupIdx] = entry;
    } else {
      if (this.listenErrors.length >= 16) {
        this.listenErrors.shift();
      }
      this.listenErrors.push(entry);
    }
    const warnMsg = `WARN: Failed to listen (${entry.kind} ${entry.host}:${entry.port}): [${entry.code}] ${entry.message}`;
    if (this.logger && typeof this.logger.warn === "function") {
      this.logger.warn(warnMsg);
    } else if (!isQuietLogsEnabled(this.config)) {
      try {
        process.stderr.write(`[rosmontis] ${warnMsg}\n`);
      } catch (_writeErr) {
        // Benign: stderr may be closed in detached daemon environments.
      }
    }
  }

  /**
   * @param {http.Server} srv
   * @param {string} kind
   * @param {string} listenHost
   * @param {number} listenPort
   * @param {http.Server[]} targetList
   * @returns {Promise<void>}
   */
  _listenServerInstance(srv, kind, listenHost, listenPort, targetList) {
    return new Promise((resolve) => {
      let settled = false;
      const settleOnce = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      srv.on("error", (err) => {
        this._recordListenError(kind, listenHost, listenPort, err);
        settleOnce();
      });
      try {
        srv.listen(listenPort, listenHost, () => {
          targetList.push(srv);
          settleOnce();
        });
      } catch (syncErr) {
        this._recordListenError(kind, listenHost, listenPort, syncErr);
        try {
          srv.close();
        } catch (closeErr) {
          this._debugSafe(closeErr);
        }
        settleOnce();
      }
    });
  }

  /** @returns {AsyncLocalStorage<any>} */
  _getTransportAls() {
    if (!this._transportAsyncLocal) {
      this._transportAsyncLocal = new AsyncLocalStorage();
    }
    return this._transportAsyncLocal;
  }

  /** @returns {WebhookStats} */
  _ensureWebhookState() {
    if (!this.webhookStats || typeof this.webhookStats !== "object") {
      this.webhookStats = { ok: 0, failed: 0, retries: 0, dropped: 0, inFlight: 0, queued: 0 };
    }
    if (!Array.isArray(this._webhookQueue)) {
      this._webhookQueue = [];
    }
    if (!(this._webhookRetryTimers instanceof Set)) {
      this._webhookRetryTimers = new Set();
    }
    if (!(this._activeWebhookReqs instanceof Set)) {
      this._activeWebhookReqs = new Set();
    }
    if (!Number.isFinite(this._webhookGeneration)) {
      this._webhookGeneration = 0;
    }
    return this.webhookStats;
  }

  _computeReadiness() {
    const b = this.bridge;
    const online = Boolean(b.online);
    const ntReady = b.inboundPipeline ? Boolean(b.inboundPipeline._isNtReady()) : true;
    const rendererUnresponsive = Boolean(b.rendererHealthStats?.unresponsiveActive);
    const livenessState = b.inboundPipeline?._ensureLivenessState?.() || null;
    const livenessOk = livenessState ? Boolean(livenessState.healthy) : true;
    const loginState = b.inboundPipeline?.getLoginState?.() || null;
    const reloginRequired = !online && Boolean(loginState?.relogin_required);
    const ready = online && ntReady && !rendererUnresponsive && livenessOk;
    return {
      ready,
      online,
      nt_ready: ntReady,
      renderer_unresponsive: rendererUnresponsive,
      ...(reloginRequired
        ? {
            relogin_required: true,
            ...(loginState?.state ? { login_state: loginState.state } : {}),
            ...(loginState?.reason ? { login_reason: loginState.reason } : {}),
            ...(loginState?.error_code ? { login_error_code: loginState.error_code } : {}),
            ...(loginState?.error_message
              ? { login_error_message: loginState.error_message }
              : {}),
          }
        : {}),
      ...(!livenessOk ? { liveness_ok: false } : {}),
      ...(livenessState?.degradedReason ? { degraded_reason: livenessState.degradedReason } : {}),
      self_id: Number(b.selfUin || 0),
    };
  }

  /** @returns {string} */
  _formatPrometheusMetrics() {
    const b = this.bridge;
    const readiness = this._computeReadiness();
    const uptimeSec = Math.max(
      0,
      Math.floor((Date.now() - (b.startedAtMs || Date.now())) / 1000)
    );
    const inv = b.invokeStats || {
      tier1: 0,
      tier2: 0,
      tier3: 0,
      degraded: 0,
      blockedReplays: 0,
      failed: 0,
    };
    const echo = b.sendEchoStats || { matched: 0, fromResult: 0, timedOut: 0 };
    const wh = this._ensureWebhookState();

    let wsServerClients = 0;
    if (this._wsServerClients) {
      for (const c of this._wsServerClients) {
        if (c && !c.closed && !c._closed) wsServerClients += 1;
      }
    }
    let revWsConnected = 0;
    if (Array.isArray(this._reverseWsClients)) {
      for (const rc of this._reverseWsClients) {
        if (rc?.conn && !rc.conn.closed && !rc.conn._closed) revWsConnected += 1;
      }
    }

    const rateLimitRejected = Number(b.rateLimiter?.getStats?.()?.rejected || 0);
    const sq = b.sessionController?.scheduler?.getStats?.() || {
      queueLength: 0,
      timedOut: 0,
      overflowRejected: 0,
      aborted: 0,
    };
    const rendererCrashes = Number(b.rendererHealthStats?.crashes || 0);
    const livenessState = b.inboundPipeline?._ensureLivenessState?.() || null;
    const sessionRebinds = Number(livenessState?.sessionRebinds || 0);
    const anomaliesTotal = Number(
      b.inboundPipeline?._ensureAnomalyRecorder?.()?.totalRecorded || 0
    );
    const msgStoreSize = Number(b.messageIdStore?.byShortId?.size ?? b.messageIdStore?.size ?? 0);
    const uinUidStoreSize = Number(b.uinUidStore?.uinToUid?.size ?? 0);

    const lines = [
      "# HELP rosmontis_up Whether the Rosmontis bridge process is up.",
      "# TYPE rosmontis_up gauge",
      "rosmontis_up 1",
      "# HELP rosmontis_online Whether the QQ account session is online.",
      "# TYPE rosmontis_online gauge",
      `rosmontis_online ${readiness.online ? 1 : 0}`,
      "# HELP rosmontis_ready Whether the bridge is ready to serve requests.",
      "# TYPE rosmontis_ready gauge",
      `rosmontis_ready ${readiness.ready ? 1 : 0}`,
      "# HELP rosmontis_relogin_required Whether QQ requires manual re-login or re-authentication.",
      "# TYPE rosmontis_relogin_required gauge",
      `rosmontis_relogin_required ${readiness.relogin_required ? 1 : 0}`,
      "# HELP rosmontis_liveness_ok Whether silent kernel liveness checks report healthy.",
      "# TYPE rosmontis_liveness_ok gauge",
      `rosmontis_liveness_ok ${readiness.liveness_ok === false ? 0 : 1}`,
      "# HELP rosmontis_session_rebinds_total Total silent wrapperSession drift rebinds performed.",
      "# TYPE rosmontis_session_rebinds_total counter",
      `rosmontis_session_rebinds_total ${sessionRebinds}`,
      "# HELP rosmontis_anomalies_total Total sanitized inbound payload anomalies recorded.",
      "# TYPE rosmontis_anomalies_total counter",
      `rosmontis_anomalies_total ${anomaliesTotal}`,
      "# HELP rosmontis_uptime_seconds Bridge uptime in seconds.",
      "# TYPE rosmontis_uptime_seconds gauge",
      `rosmontis_uptime_seconds ${uptimeSec}`,
      "# HELP rosmontis_invoke_total Total NTQQ kernel invocations by dispatch tier.",
      "# TYPE rosmontis_invoke_total counter",
      `rosmontis_invoke_total{tier="tier1"} ${Number(inv.tier1 || 0)}`,
      `rosmontis_invoke_total{tier="tier2"} ${Number(inv.tier2 || 0)}`,
      `rosmontis_invoke_total{tier="tier3"} ${Number(inv.tier3 || 0)}`,
      "# HELP rosmontis_invoke_degraded_total Total degraded NTQQ invocations.",
      "# TYPE rosmontis_invoke_degraded_total counter",
      `rosmontis_invoke_degraded_total ${Number(inv.degraded || 0)}`,
      "# HELP rosmontis_invoke_blocked_replays_total Total side-effect invocations blocked from replay.",
      "# TYPE rosmontis_invoke_blocked_replays_total counter",
      `rosmontis_invoke_blocked_replays_total ${Number(inv.blockedReplays || 0)}`,
      "# HELP rosmontis_invoke_failed_total Total failed NTQQ invocations.",
      "# TYPE rosmontis_invoke_failed_total counter",
      `rosmontis_invoke_failed_total ${Number(inv.failed || 0)}`,
      "# HELP rosmontis_send_echo_total Outbound send-echo correlation outcomes.",
      "# TYPE rosmontis_send_echo_total counter",
      `rosmontis_send_echo_total{outcome="matched"} ${Number(echo.matched || 0)}`,
      `rosmontis_send_echo_total{outcome="from_result"} ${Number(echo.fromResult || 0)}`,
      `rosmontis_send_echo_total{outcome="timed_out"} ${Number(echo.timedOut || 0)}`,
      "# HELP rosmontis_ws_server_clients Connected forward WebSocket clients.",
      "# TYPE rosmontis_ws_server_clients gauge",
      `rosmontis_ws_server_clients ${wsServerClients}`,
      "# HELP rosmontis_reverse_ws_connected Connected reverse WebSocket clients.",
      "# TYPE rosmontis_reverse_ws_connected gauge",
      `rosmontis_reverse_ws_connected ${revWsConnected}`,
      "# HELP rosmontis_webhook_deliveries_total HTTP POST webhook delivery outcomes.",
      "# TYPE rosmontis_webhook_deliveries_total counter",
      `rosmontis_webhook_deliveries_total{outcome="ok"} ${Number(wh.ok || 0)}`,
      `rosmontis_webhook_deliveries_total{outcome="failed"} ${Number(wh.failed || 0)}`,
      `rosmontis_webhook_deliveries_total{outcome="dropped"} ${Number(wh.dropped || 0)}`,
      "# HELP rosmontis_webhook_in_flight Currently in-flight HTTP POST webhook deliveries.",
      "# TYPE rosmontis_webhook_in_flight gauge",
      `rosmontis_webhook_in_flight ${Number(wh.inFlight || 0)}`,
      "# HELP rosmontis_webhook_queued Queued HTTP POST webhook deliveries waiting for a concurrency slot.",
      "# TYPE rosmontis_webhook_queued gauge",
      `rosmontis_webhook_queued ${Number(wh.queued || 0)}`,
      "# HELP rosmontis_rate_limit_rejected_total Total outbound sends rejected by rate limiter.",
      "# TYPE rosmontis_rate_limit_rejected_total counter",
      `rosmontis_rate_limit_rejected_total ${rateLimitRejected}`,
      "# HELP rosmontis_session_queue_length Currently queued outbound session mutex tasks.",
      "# TYPE rosmontis_session_queue_length gauge",
      `rosmontis_session_queue_length ${Number(sq.queueLength || 0)}`,
      "# HELP rosmontis_session_queue_dropped_total Total outbound session tasks dropped before sendMsg.",
      "# TYPE rosmontis_session_queue_dropped_total counter",
      `rosmontis_session_queue_dropped_total{reason="timed_out"} ${Number(sq.timedOut || 0)}`,
      `rosmontis_session_queue_dropped_total{reason="overflow"} ${Number(sq.overflowRejected || 0)}`,
      `rosmontis_session_queue_dropped_total{reason="aborted"} ${Number(sq.aborted || 0)}`,
      "# HELP rosmontis_renderer_crashes_total Total renderer process crashes observed.",
      "# TYPE rosmontis_renderer_crashes_total counter",
      `rosmontis_renderer_crashes_total ${rendererCrashes}`,
      "# HELP rosmontis_store_messages_size Current number of entries in MessageIdStore.",
      "# TYPE rosmontis_store_messages_size gauge",
      `rosmontis_store_messages_size ${msgStoreSize}`,
      "# HELP rosmontis_store_uin_uid_size Current number of entries in UinUidStore.",
      "# TYPE rosmontis_store_uin_uid_size gauge",
      `rosmontis_store_uin_uid_size ${uinUidStoreSize}`,
    ];
    return `${lines.join("\n")}\n`;
  }

  _installSighupHandler() {
    if (process.platform === "win32" || this.config?.reloadOnSighup === false) {
      this._removeSighupHandler();
      return;
    }
    if (this._sighupHandler) return;
    this._sighupHandler = () => {
      const reloadFn =
        typeof this.bridge.reloadConfig === "function"
          ? this.bridge.reloadConfig.bind(this.bridge)
          : this.reloadConfig.bind(this);
      reloadFn().catch((/** @type {any} */ err) => {
        this.logger?.warnThrottled?.(
          "sighup-reload-err",
          `SIGHUP config reload failed: ${err?.message || err}`,
          5000
        );
      });
    };
    try {
      process.on("SIGHUP", this._sighupHandler);
    } catch (err) {
      this._debugSafe(err);
      this._sighupHandler = null;
    }
  }

  _removeSighupHandler() {
    if (!this._sighupHandler) return;
    try {
      process.removeListener("SIGHUP", this._sighupHandler);
    } catch (err) {
      this._debugSafe(err);
    }
    this._sighupHandler = null;
  }

  _syncSighupHandler() {
    if (process.platform === "win32" || this.config?.reloadOnSighup === false) {
      this._removeSighupHandler();
    } else if (
      this._httpServers?.length > 0 ||
      this._wsServers?.length > 0 ||
      this._reverseWsClients?.length > 0 ||
      this._sighupHandler
    ) {
      this._installSighupHandler();
    }
  }

  /**
   * @param {any} rawText
   * @param {(payload: any) => void} sendJsonFn
   * @param {Record<string, any>} [actionContext={}]
   */
  async _handleWsActionMessage(rawText, sendJsonFn, actionContext = {}) {
    if (typeof sendJsonFn !== "function") return;
    let payload;
    try {
      payload = typeof rawText === "string" ? JSON.parse(rawText) : rawText;
    } catch (err) {
      this._debugSafe(err);
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !payload.action) {
      return;
    }
    const actParams =
      payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)
        ? payload.params
        : {};
    /** @type {{ kind: string, deferredTask: (() => void) | null, _ran: boolean }} */
    const transportCtx = { kind: "ws", deferredTask: null, _ran: false };
    let reply;
    try {
      reply = await this._getTransportAls().run(transportCtx, () =>
        this.bridge.handleOneBotAction(
          payload.action,
          actParams,
          payload.echo,
          actionContext
        )
      );
    } catch (/** @type {any} */ err) {
      const msg = err && err.message ? err.message : String(err);
      const retcode = Number(err?.retcode) || 1400;
      reply = buildFailedActionReply(retcode, msg, payload.echo);
    }
    try {
      sendJsonFn(reply);
    } catch (err) {
      this._debugSafe(err);
    }
    if (typeof transportCtx.deferredTask === "function" && !transportCtx._ran) {
      transportCtx._ran = true;
      setImmediate(() => {
        try {
          transportCtx.deferredTask?.();
        } catch (err) {
          this._debugSafe(err);
        }
      });
    }
  }

  async startServers() {
    this._stopped = false;
    this.listenErrors = [];
    this._ensureWebhookState();

    enforceProtectedModeOnServers(
      [...(this.config?.httpServers || []), ...(this.config?.wsServers || [])],
      this.config,
      (/** @type {string} */ msg) => {
        try {
          process.stderr.write("[rosmontis] SECURITY WARNING: " + msg + "\n");
        } catch (_writeErr) {
          // Benign: stderr may be unavailable in headless daemon environments.
        }
      }
    );

    const globalMsgFormat = this.config?.messageFormat || "array";

    // 1. Start HTTP Server(s)
    for (const httpCfg of this.config?.httpServers || []) {
      const actionContext = buildEndpointActionContext(httpCfg, globalMsgFormat);
      const srv = http.createServer(async (req, res) => {
        req.on("error", (err) => this._debugSafe(err));
        res.on("error", (err) => this._debugSafe(err));

        const originRes = checkOriginHeader(req, {
          allowedOrigins: httpCfg.allowedOrigins || this.config?.allowedOrigins || [],
        });
        if (!originRes.allowed) {
          writeHttpJson(res, 403, buildFailedActionReply(1403, "Forbidden: Origin not allowed"));
          return;
        }

        let u;
        try {
          u = new URL(req.url || "/", "http://127.0.0.1");
        } catch (urlErr) {
          this._debugSafe(urlErr);
          u = new URL("/", "http://127.0.0.1");
        }

        if (!this._checkAuth(req, httpCfg.accessToken, u)) {
          writeHttpJson(res, 401, buildFailedActionReply(1403, "Unauthorized"));
          return;
        }

        const actionName = u.pathname.replace(/^\/+/, "");
        if (req.method === "GET" && (actionName === "health" || actionName === "")) {
          const loginState = this.bridge.inboundPipeline?.getLoginState?.() || null;
          const reloginRequired = !this.bridge.online && Boolean(loginState?.relogin_required);
          writeHttpJson(res, 200, {
            status: "ok",
            retcode: 0,
            self_id: Number(this.bridge.selfUin || 0),
            online: this.bridge.online,
            ...(reloginRequired
              ? {
                  relogin_required: true,
                  ...(loginState?.error_code ? { login_error_code: loginState.error_code } : {}),
                  ...(loginState?.error_message
                    ? { login_error_message: loginState.error_message }
                    : {}),
                }
              : {}),
          });
          return;
        }

        if (req.method === "GET" && actionName === "ready") {
          const state = this._computeReadiness();
          if (state.ready) {
            writeHttpJson(res, 200, { status: "ok", retcode: 0, ...state });
          } else {
            writeHttpJson(res, 503, { status: "failed", retcode: 1503, ...state });
          }
          return;
        }

        if (req.method === "GET" && actionName === "metrics") {
          if (this.config?.enableMetrics === false) {
            writeHttpJson(res, 404, buildFailedActionReply(1404, "Metrics endpoint is disabled"));
            return;
          }
          if (!res.writableEnded) {
            res.writeHead(200, PROMETHEUS_CONTENT_TYPE_HEADERS);
            res.end(this._formatPrometheusMetrics());
          }
          return;
        }

        try {
          const params = await readHttpJsonBody(req, {
            maxBodyBytes: this.config?.maxHttpBodyBytes || DEFAULT_MAX_HTTP_BODY_BYTES,
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
          /** @type {{ kind: string, res: http.ServerResponse, deferredTask: (() => void) | null, _ran: boolean }} */
          const transportCtx = { kind: "http", res, deferredTask: null, _ran: false };
          const reqAbortController = new AbortController();
          const onPrematureClose = () => {
            if (!res.writableEnded) {
              reqAbortController.abort();
            }
          };
          if (res.destroyed && !res.writableEnded) {
            reqAbortController.abort();
          } else {
            res.once("close", onPrematureClose);
          }
          /** @type {import("../types").ActionContext} */
          const httpActionContext = {
            ...actionContext,
            transport: "http",
            signal: reqAbortController.signal,
          };
          let reply;
          try {
            reply = await this._getTransportAls().run(transportCtx, () =>
              this.bridge.handleOneBotAction(act, actParams, params.echo, httpActionContext)
            );
          } finally {
            res.removeListener("close", onPrematureClose);
          }
          if (typeof transportCtx.deferredTask === "function") {
            writeHttpJson(res, 200, reply, { Connection: "close" });
            const triggerDeferred = () => {
              if (transportCtx._ran) return;
              transportCtx._ran = true;
              try {
                transportCtx.deferredTask?.();
              } catch (err) {
                this._debugSafe(err);
              }
            };
            if (res.writableFinished) {
              setImmediate(triggerDeferred);
            } else {
              res.once("finish", () => setImmediate(triggerDeferred));
              res.once("close", () => setImmediate(triggerDeferred));
            }
          } else {
            writeHttpJson(res, 200, reply);
          }
        } catch (/** @type {any} */ err) {
          if (err && (err.statusCode === 413 || err.code === "ERR_HTTP_BODY_TOO_LARGE")) {
            writeHttpJson(res, 413, buildFailedActionReply(1413, err.message));
            return;
          }
          const msg = err && err.message ? err.message : String(err);
          writeHttpJson(res, 200, buildFailedActionReply(1400, msg));
        }
      });

      const listenPort = Number(httpCfg.port ?? 3000);
      const listenHost = httpCfg.host || "0.0.0.0";
      await this._listenServerInstance(srv, "http", listenHost, listenPort, this._httpServers);
    }

    // 2. Start Forward WebSocket Server(s)
    for (const wsCfg of this.config?.wsServers || []) {
      const baseActionContext = buildEndpointActionContext(wsCfg, globalMsgFormat);
      const srv = http.createServer((_req, res) => {
        res.writeHead(426);
        res.end("Upgrade Required");
      });
      srv.on("upgrade", (req, socket, head) => {
        socket.on("error", (err) => this._debugSafe(err));

        const originRes = checkOriginHeader(req, {
          allowedOrigins: wsCfg.allowedOrigins || this.config?.allowedOrigins || [],
        });
        if (!originRes.allowed) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }

        /** @type {URL | null} */
        let u = null;
        try {
          u = new URL(req.url || "/", "http://127.0.0.1");
        } catch (urlErr) {
          this._debugSafe(urlErr);
        }

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
        const conn = /** @type {any} */ (
          new Rfc6455Connection(socket, {
            isClient: false,
            maxPayloadBytes: this.config?.maxWsPayloadBytes || DEFAULT_MAX_WS_PAYLOAD_BYTES,
            maxSendBufferBytes:
              this.config?.maxWsSendBufferBytes || DEFAULT_MAX_WS_SEND_BUFFER_BYTES,
            allowUnmaskedClientFrames: Boolean(this.config?.allowUnmaskedClientFrames),
          })
        );
        const wsRole = classifyForwardWsRole(u ? u.pathname : "/");
        conn._wsRole = wsRole;
        conn.reportSelfMessage = Boolean(wsCfg.reportSelfMessage);
        conn._messageFormat = baseActionContext.messageFormat;
        this._wsServerClients.add(conn);

        conn.on("error", (/** @type {any} */ connErr) => {
          this._debugSafe(connErr);
          this._wsServerClients.delete(conn);
          try {
            socket.destroy();
          } catch (destroyErr) {
            this._debugSafe(destroyErr);
          }
        });
        conn.on("close", () => {
          this._wsServerClients.delete(conn);
        });

        if (wsRole !== "api") {
          conn.sendJson(
            formatMetaEvent("lifecycle", { sub_type: "connect" }, { selfId: this.bridge.selfUin })
          );
        }

        conn.on("message", (/** @type {any} */ text) => {
          if (wsRole === "event") {
            /** @type {any} */
            let payload = null;
            try {
              payload = typeof text === "string" ? JSON.parse(text) : text;
            } catch (parseErr) {
              this._debugSafe(parseErr);
              return;
            }
            if (
              payload &&
              typeof payload === "object" &&
              !Array.isArray(payload) &&
              payload.action
            ) {
              try {
                conn.sendJson(
                  buildFailedActionReply(
                    1403,
                    "Event-only WebSocket endpoint does not accept API actions",
                    payload.echo
                  )
                );
              } catch (sendErr) {
                this._debugSafe(sendErr);
              }
            }
            return;
          }
          this._handleWsActionMessage(
            text,
            (reply) => conn.sendJson(reply),
            {
              ...baseActionContext,
              messageFormat: conn._messageFormat || baseActionContext.messageFormat,
            }
          );
        });
        if (head && head.length > 0) {
          conn._onData(head);
        }
      });

      const listenPort = Number(wsCfg.port ?? 3001);
      const listenHost = wsCfg.host || "0.0.0.0";
      await this._listenServerInstance(srv, "ws", listenHost, listenPort, this._wsServers);
    }

    // 3. Start Reverse WebSocket Client(s)
    for (const clientCfg of this.config?.wsClients || []) {
      if (!clientCfg.url) continue;
      this._startReverseWsLoop(clientCfg);
    }

    // 4. Start Heartbeat Timer
    const heartbeatMs = Number(this.config?.heartbeatIntervalMs || 0);
    if (!this._heartbeatTimer && heartbeatMs > 0) {
      this._heartbeatTimer = setInterval(() => {
        const interval = Number(this.config?.heartbeatIntervalMs || heartbeatMs);
        this.bridge.broadcastOneBotEvent?.(
          formatMetaEvent(
            "heartbeat",
            {
              status: {
                online: this.bridge.online,
                good: this.bridge.online,
                time: Math.max(
                  0,
                  Math.floor((Date.now() - (this.bridge.startedAtMs || Date.now())) / 1000)
                ),
              },
              interval,
            },
            { selfId: this.bridge.selfUin }
          )
        );
      }, heartbeatMs);
      if (typeof this._heartbeatTimer.unref === "function") {
        this._heartbeatTimer.unref();
      }
    }

    // 5. Start Periodic WS Liveness Timer
    const rawPingInterval = this.config?.wsPingIntervalMs ?? 30000;
    const pingIntervalMs = Number.isFinite(Number(rawPingInterval))
      ? Number(rawPingInterval)
      : 30000;
    if (!this._wsPingTimer && pingIntervalMs > 0) {
      const rawPongTimeout = Number(this.config?.wsPongTimeoutMs ?? 90000);
      const pongTimeoutMs = Math.max(
        pingIntervalMs * 2,
        Number.isFinite(rawPongTimeout) && rawPongTimeout > 0 ? rawPongTimeout : 90000
      );
      this._wsPingTimer = setInterval(() => {
        const now = Date.now();
        const serverClients = this._wsServerClients || this.bridge.wsClients;
        if (serverClients) {
          for (const conn of Array.from(serverClients)) {
            if (!conn || conn.closed || conn._closed) {
              serverClients.delete?.(conn);
              continue;
            }
            if (conn._unansweredPingAt > 0 && now - conn._unansweredPingAt > pongTimeoutMs) {
              serverClients.delete?.(conn);
              conn.terminate("Pong timeout");
            } else {
              conn.ping();
            }
          }
        }
        const revClients = this._reverseWsClients || this.bridge.reverseWsClients;
        if (Array.isArray(revClients)) {
          for (const rc of revClients) {
            const conn = rc?.conn;
            if (!conn || conn.closed || conn._closed) continue;
            if (conn._unansweredPingAt > 0 && now - conn._unansweredPingAt > pongTimeoutMs) {
              conn.terminate("Pong timeout");
            } else {
              conn.ping();
            }
          }
        }
      }, pingIntervalMs);
      this._wsPingTimer.unref?.();
    }

    // 6. Start Silent Kernel Liveness & Session-Drift Self-Heal Timer
    const rawLivenessInterval = this.config?.livenessCheckIntervalMs ?? 300000;
    const livenessIntervalMs = Number.isFinite(Number(rawLivenessInterval))
      ? Math.floor(Number(rawLivenessInterval))
      : 300000;
    if (!this._livenessTimer && livenessIntervalMs > 0) {
      this._livenessTimer = setInterval(() => {
        if (typeof this.bridge.inboundPipeline?.checkLiveness === "function") {
          this.bridge.inboundPipeline.checkLiveness().catch((/** @type {any} */ err) => {
            this._debugSafe(err);
          });
        }
      }, livenessIntervalMs);
      this._livenessTimer.unref?.();
    }

    // 7. Start Optional Periodic NTQQ `nt_data` Cache Auto-Pruner
    const rawCachePruneInterval = Number(this.config?.ntCacheAutoPruneIntervalMs ?? 0);
    if (
      !this._ntCachePruneTimer &&
      Number.isFinite(rawCachePruneInterval) &&
      rawCachePruneInterval > 0
    ) {
      const pruneIntervalMs = Math.max(60000, Math.floor(rawCachePruneInterval));
      this._ntCachePruneTimer = setInterval(() => {
        const allowSystemDiscovery = Boolean(process.versions?.electron);
        if (!this.config?.ntCacheDir && !allowSystemDiscovery) return;
        pruneNtCache({
          ntCacheDir: this.config?.ntCacheDir,
          allowSystemDiscovery,
          maxAgeMs: this.config?.ntCacheMaxAgeMs,
        }).catch((/** @type {any} */ err) => {
          this._debugSafe(err);
        });
      }, pruneIntervalMs);
      this._ntCachePruneTimer.unref?.();
    }

    // 6. Install SIGHUP hot-reload handler (POSIX only)
    this._installSighupHandler();
  }

  /** @param {Record<string, any>} clientCfg */
  _startReverseWsLoop(clientCfg) {
    const baseActionContext = buildEndpointActionContext(
      clientCfg,
      this.config?.messageFormat || "array"
    );
    /** @type {any} */
    const entry = {
      cfg: clientCfg,
      conn: null,
      connecting: false,
      stopped: false,
      timer: null,
      handle: null,
      connectedSelfId: "0",
      immediateReconnectOnce: false,
      messageFormat: baseActionContext.messageFormat,
    };
    this._reverseWsClients.push(entry);

    const connectOnce = () => {
      if (entry.stopped || entry.connecting || (entry.conn && !entry.conn.closed)) return;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      entry.connecting = true;
      const currentSelfId = sanitizeHeaderValue(String(this.bridge.selfUin || "0"));
      /** @type {Record<string, string>} */
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
        (/** @type {any} */ conn) => {
          entry.connecting = false;
          entry.conn = conn;
          entry.connectedSelfId = currentSelfId;
          conn._messageFormat = entry.messageFormat;
          conn.sendJson(
            formatMetaEvent("lifecycle", { sub_type: "connect" }, { selfId: this.bridge.selfUin })
          );
        },
        (/** @type {any} */ text, /** @type {any} */ conn) => {
          this._handleWsActionMessage(
            text,
            (reply) => conn.sendJson(reply),
            {
              ...baseActionContext,
              messageFormat: entry.messageFormat || baseActionContext.messageFormat,
            }
          );
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
          maxPayloadBytes: this.config?.maxWsPayloadBytes || DEFAULT_MAX_WS_PAYLOAD_BYTES,
          maxSendBufferBytes:
            this.config?.maxWsSendBufferBytes || DEFAULT_MAX_WS_SEND_BUFFER_BYTES,
        }
      );
    };

    connectOnce();
  }

  /**
   * @param {any} event
   * @returns {Promise<any>[]}
   */
  _dispatchHttpWebhookEvent(event) {
    const clients = this.config?.httpClients;
    if (!Array.isArray(clients) || clients.length === 0) return [];
    /** @type {Promise<any>[]} */
    const tasks = [];
    for (const clientCfg of clients) {
      if (!clientCfg || clientCfg.enable === false || clientCfg.enabled === false) continue;
      if (!clientCfg.url) continue;
      if (event.post_type === "message_sent" && !clientCfg.reportSelfMessage) continue;
      if (
        event.post_type === "meta_event" &&
        event.meta_event_type === "heartbeat" &&
        clientCfg.enableHeartbeat === false
      ) {
        continue;
      }
      tasks.push(
        this._enqueueWebhookDelivery(clientCfg, event).catch((err) => {
          const warnKey = `webhook-err:${clientCfg.name || clientCfg.url}`;
          this.logger?.warnThrottled?.(
            warnKey,
            `HTTP POST webhook delivery failed (${clientCfg.url}): ${err?.message || err}`,
            60000
          );
        })
      );
    }
    return tasks;
  }

  /**
   * @param {Record<string, any>} clientCfg
   * @param {any} event
   * @returns {Promise<any>}
   */
  _enqueueWebhookDelivery(clientCfg, event) {
    const stats = this._ensureWebhookState();
    const rawMaxConc = Number(this.config?.webhookMaxConcurrency);
    const maxConcurrency =
      Number.isFinite(rawMaxConc) && rawMaxConc > 0 ? Math.floor(rawMaxConc) : 8;
    const rawMaxQueue = Number(this.config?.webhookMaxQueueSize);
    const maxQueueSize =
      Number.isFinite(rawMaxQueue) && rawMaxQueue > 0 ? Math.floor(rawMaxQueue) : 256;

    if (stats.inFlight >= maxConcurrency && this._webhookQueue.length >= maxQueueSize) {
      stats.dropped += 1;
      stats.queued = this._webhookQueue.length;
      this.logger?.warnThrottled?.(
        `webhook-queue-full:${clientCfg.name || clientCfg.url}`,
        `HTTP POST webhook queue full (max=${maxQueueSize}); dropping event for ${clientCfg.url}`,
        30000
      );
      return Promise.resolve(null);
    }

    return new Promise((resolve, reject) => {
      this._webhookQueue.push({ clientCfg, event, resolve, reject });
      stats.queued = this._webhookQueue.length;
      this._drainWebhookQueue();
    });
  }

  _drainWebhookQueue() {
    const stats = this._ensureWebhookState();
    const rawMaxConc = Number(this.config?.webhookMaxConcurrency);
    const maxConcurrency =
      Number.isFinite(rawMaxConc) && rawMaxConc > 0 ? Math.floor(rawMaxConc) : 8;

    while (stats.inFlight < maxConcurrency && this._webhookQueue.length > 0) {
      const task = this._webhookQueue.shift();
      if (!task) break;
      stats.queued = this._webhookQueue.length;
      stats.inFlight += 1;
      const generation = this._webhookGeneration;

      this._runWebhookTaskWithRetry(task.clientCfg, task.event, generation)
        .then(
          (res) => task.resolve(res),
          (err) => task.reject(err)
        )
        .finally(() => {
          stats.inFlight = Math.max(0, stats.inFlight - 1);
          this._drainWebhookQueue();
        });
    }
  }

  /**
   * @param {number} delayMs
   * @param {number} generation
   * @returns {Promise<boolean>}
   */
  _waitWebhookRetry(delayMs, generation) {
    return new Promise((resolve) => {
      if (generation !== this._webhookGeneration) {
        resolve(false);
        return;
      }
      /** @type {{ timer: ReturnType<typeof setTimeout> | null, cancel: () => void }} */
      const entry = {
        timer: null,
        cancel: () => {
          if (entry.timer) {
            clearTimeout(entry.timer);
            entry.timer = null;
          }
          this._webhookRetryTimers?.delete(entry);
          resolve(false);
        },
      };
      entry.timer = setTimeout(() => {
        entry.timer = null;
        this._webhookRetryTimers?.delete(entry);
        resolve(generation === this._webhookGeneration);
      }, Math.max(0, Number(delayMs) || 0));
      if (entry.timer && typeof entry.timer.unref === "function") {
        entry.timer.unref();
      }
      this._webhookRetryTimers.add(entry);
    });
  }

  /**
   * @param {Record<string, any>} clientCfg
   * @param {any} event
   * @param {number} generation
   * @returns {Promise<any>}
   */
  async _runWebhookTaskWithRetry(clientCfg, event, generation) {
    const stats = this._ensureWebhookState();
    const rawMaxRetries =
      clientCfg.maxRetries !== undefined
        ? clientCfg.maxRetries
        : this.config?.webhookMaxRetries ?? 2;
    const maxRetries =
      Number.isFinite(Number(rawMaxRetries)) && Number(rawMaxRetries) >= 0
        ? Math.floor(Number(rawMaxRetries))
        : 2;
    const rawBaseMs =
      clientCfg.retryBaseMs !== undefined
        ? clientCfg.retryBaseMs
        : this.config?.webhookRetryBaseMs ?? 250;
    const retryBaseMs =
      Number.isFinite(Number(rawBaseMs)) && Number(rawBaseMs) >= 0
        ? Math.floor(Number(rawBaseMs))
        : 250;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (generation !== this._webhookGeneration) {
        return null;
      }
      try {
        const resp = await this._postEventToHttpClient(clientCfg, event);
        if (generation !== this._webhookGeneration) {
          return null;
        }
        if (resp === null) {
          return null;
        }
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          stats.ok += 1;
          return resp;
        }
        if (isRetryableWebhookStatus(resp.statusCode) && attempt < maxRetries) {
          stats.retries += 1;
          const retryAttempt = attempt + 1;
          const delayMs = retryBaseMs * 2 ** (retryAttempt - 1);
          const shouldContinue = await this._waitWebhookRetry(delayMs, generation);
          if (!shouldContinue) return null;
          continue;
        }
        stats.failed += 1;
        /** @type {Error & { statusCode?: number, _webhookFinalized?: boolean }} */
        const statusErr = new Error(`Webhook HTTP ${resp.statusCode}`);
        statusErr.statusCode = resp.statusCode;
        statusErr._webhookFinalized = true;
        throw statusErr;
      } catch (/** @type {any} */ err) {
        if (generation !== this._webhookGeneration) {
          return null;
        }
        if (err && err._webhookFinalized) {
          throw err;
        }
        if (attempt < maxRetries) {
          stats.retries += 1;
          const retryAttempt = attempt + 1;
          const delayMs = retryBaseMs * 2 ** (retryAttempt - 1);
          const shouldContinue = await this._waitWebhookRetry(delayMs, generation);
          if (!shouldContinue) return null;
          continue;
        }
        stats.failed += 1;
        throw err;
      }
    }
    return null;
  }

  _clearWebhookRuntime() {
    const stats = this._ensureWebhookState();
    this._webhookGeneration += 1;
    for (const entry of Array.from(this._webhookRetryTimers)) {
      try {
        entry.cancel();
      } catch (err) {
        this._debugSafe(err);
      }
    }
    this._webhookRetryTimers.clear();
    while (this._webhookQueue.length > 0) {
      const pending = this._webhookQueue.shift();
      if (!pending) continue;
      try {
        pending.resolve(null);
      } catch (err) {
        this._debugSafe(err);
      }
    }
    stats.queued = 0;
    for (const req of Array.from(this._activeWebhookReqs)) {
      try {
        req.destroy();
      } catch (err) {
        this._debugSafe(err);
      }
    }
    this._activeWebhookReqs.clear();
  }

  /**
   * @param {Record<string, any>} clientCfg
   * @param {any} event
   * @returns {Promise<{ statusCode: number, bodyText: string } | null>}
   */
  async _postEventToHttpClient(clientCfg, event) {
    let parsedUrl;
    try {
      parsedUrl = new URL(String(clientCfg.url));
    } catch (urlErr) {
      this._debugSafe(urlErr);
      return null;
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return null;
    }

    const defaultFormat = this.config?.messageFormat || "array";
    const targetFormat = clientCfg.messageFormat || defaultFormat;
    const formatted =
      typeof this.bridge._formatEventForEndpoint === "function"
        ? this.bridge._formatEventForEndpoint(event, targetFormat)
        : event;
    const bodyBuf = Buffer.from(JSON.stringify(formatted), "utf8");
    /** @type {Record<string, string>} */
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(bodyBuf.length),
      "X-Self-ID": sanitizeHeaderValue(String(formatted?.self_id || this.bridge.selfUin || "0")),
      "User-Agent": "OneBot/11 Rosmontis/1.0.0",
    };
    if (clientCfg.accessToken) {
      headers["Authorization"] = `Bearer ${sanitizeHeaderValue(clientCfg.accessToken)}`;
    }
    if (
      clientCfg.secret !== undefined &&
      clientCfg.secret !== null &&
      String(clientCfg.secret) !== ""
    ) {
      const sig = crypto
        .createHmac("sha1", String(clientCfg.secret))
        .update(bodyBuf)
        .digest("hex");
      headers["X-Signature"] = `sha1=${sig}`;
    }

    const timeoutMs = Math.max(
      500,
      Number(clientCfg.timeoutMs || this.config?.httpPostTimeoutMs || 5000)
    );
    const transport = parsedUrl.protocol === "https:" ? https : http;
    if (!(this._activeWebhookReqs instanceof Set)) {
      this._activeWebhookReqs = new Set();
    }

    /** @type {{ statusCode: number, bodyText: string }} */
    const resp = await new Promise((resolve, reject) => {
      let settled = false;
      /**
       * @param {any} err
       * @param {any} [val]
       */
      const finish = (err, val) => {
        if (settled) return;
        settled = true;
        this._activeWebhookReqs.delete(req);
        if (err) reject(err);
        else resolve(val);
      };

      const req = transport.request(
        parsedUrl,
        {
          method: "POST",
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          /** @type {Buffer[]} */
          const chunks = [];
          let total = 0;
          let overflow = false;
          res.on("data", (chunk) => {
            if (overflow) return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += buf.length;
            if (total > MAX_WEBHOOK_RESPONSE_BYTES) {
              overflow = true;
              res.destroy();
              finish(new Error("Webhook response exceeded 1 MiB limit"));
              return;
            }
            chunks.push(buf);
          });
          res.on("end", () => {
            if (overflow) return;
            finish(null, {
              statusCode: Number(res.statusCode || 0),
              bodyText: Buffer.concat(chunks).toString("utf8"),
            });
          });
          res.on("error", (err) => finish(err));
        }
      );

      this._activeWebhookReqs.add(req);
      req.on("timeout", () => {
        req.destroy(new Error(`Webhook request timed out after ${timeoutMs}ms`));
      });
      req.on("error", (err) => finish(err));
      req.end(bodyBuf);
    });

    if (
      resp &&
      resp.statusCode >= 200 &&
      resp.statusCode < 300 &&
      resp.statusCode !== 204 &&
      resp.bodyText &&
      resp.bodyText.trim()
    ) {
      let quickOp = null;
      try {
        quickOp = JSON.parse(resp.bodyText);
      } catch (parseErr) {
        this._debugSafe(parseErr);
      }
      if (
        hasMeaningfulQuickOperation(quickOp) &&
        (formatted.post_type === "message" || formatted.post_type === "request")
      ) {
        const actionContext = buildEndpointActionContext(clientCfg, defaultFormat);
        await this.bridge.handleOneBotAction(
          ".handle_quick_operation",
          { context: formatted, operation: quickOp },
          undefined,
          actionContext
        );
      }
    }
    return resp;
  }

  async _stopNetworkRuntime() {
    this._removeSighupHandler();
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._wsPingTimer) {
      clearInterval(this._wsPingTimer);
      this._wsPingTimer = null;
    }
    if (this._livenessTimer) {
      clearInterval(this._livenessTimer);
      this._livenessTimer = null;
    }
    if (this._ntCachePruneTimer) {
      clearInterval(this._ntCachePruneTimer);
      this._ntCachePruneTimer = null;
    }
    for (const rev of this._reverseWsClients || []) {
      rev.stopped = true;
      if (rev.timer) clearTimeout(rev.timer);
      if (rev.conn) rev.conn.close();
      if (rev.handle) rev.handle.close();
    }
    this._reverseWsClients = [];
    this._wsClientHandles = this._reverseWsClients;
    for (const client of this._wsServerClients || []) {
      client.close();
    }
    this._wsServerClients?.clear?.();
    const serversToClose = [...(this._httpServers || []), ...(this._wsServers || [])];
    this._httpServers = [];
    this._wsServers = [];
    for (const srv of serversToClose) {
      await new Promise((resolve) => {
        let done = false;
        /** @type {ReturnType<typeof setTimeout> | null} */
        let forceTimer = null;
        const finish = () => {
          if (done) return;
          done = true;
          if (forceTimer) {
            clearTimeout(forceTimer);
            forceTimer = null;
          }
          resolve(undefined);
        };
        forceTimer = setTimeout(() => {
          try {
            if (typeof srv.closeAllConnections === "function") {
              srv.closeAllConnections();
            }
          } catch (err) {
            this._debugSafe(err);
          }
          finish();
        }, 2000);
        if (typeof forceTimer.unref === "function") {
          forceTimer.unref();
        }
        try {
          srv.close(() => finish());
          if (typeof srv.closeIdleConnections === "function") {
            srv.closeIdleConnections();
          }
        } catch (err) {
          this._debugSafe(err);
          finish();
        }
      });
    }
    this._clearWebhookRuntime();
  }

  /**
   * @param {Record<string, any>} [options={}]
   * @returns {Promise<ReloadConfigResult>}
   */
  async reloadConfig(options = {}) {
    const opts = options && typeof options === "object" ? options : {};
    const prevChain = this._reloadChain || Promise.resolve();
    /** @type {() => void} */
    let releaseMain = () => {};
    const mainDone = new Promise((resolve) => {
      releaseMain = () => resolve(undefined);
    });
    /** @type {() => void} */
    let resolveDeferredDone = () => {};
    const deferredGate = new Promise((resolve) => {
      resolveDeferredDone = () => resolve(undefined);
    });

    const transportCtx = this._getTransportAls().getStore() || null;

    this._reloadChain = prevChain
      .catch((err) => this._debugSafe(err))
      .then(() => mainDone)
      .then(() => deferredGate);

    await prevChain.catch((err) => this._debugSafe(err));

    try {
      const prevConfig = this.config || {};
      const nextConfig =
        opts.config && typeof opts.config === "object"
          ? opts.config
          : loadBridgeConfig(
              opts.configDir !== undefined ? opts.configDir : this.bridge._configDir
            );

      const diff = computeConfigDiff(prevConfig, nextConfig);
      const needNetworkRestart = Boolean(opts.restartServers) || diff.networkChanged;

      this.bridge.config = nextConfig;
      if (this.bridge.rateLimiter && typeof this.bridge.rateLimiter.updateConfig === "function") {
        this.bridge.rateLimiter.updateConfig(nextConfig.rateLimit);
      }
      this._syncSighupHandler();

      if (!needNetworkRestart) {
        resolveDeferredDone();
        return {
          reloaded: true,
          network_restarted: false,
          network_restart_scheduled: false,
          changed_keys: diff.changedKeys,
          network_changed_keys: diff.networkChangedKeys,
        };
      }

      if (transportCtx) {
        /** @type {() => void} */
        let fireTrigger = () => {};
        let cancelled = false;
        const triggerPromise = new Promise((resolve) => {
          fireTrigger = () => resolve(undefined);
        });
        const cancelPending = () => {
          cancelled = true;
          fireTrigger();
        };
        if (!(this._pendingDeferredReloadCancels instanceof Set)) {
          this._pendingDeferredReloadCancels = new Set();
        }
        this._pendingDeferredReloadCancels.add(cancelPending);

        /** @type {Promise<void> | null} */
        let deferredRestartPromise = null;
        deferredRestartPromise = (async () => {
          try {
            await triggerPromise;
            this._pendingDeferredReloadCancels?.delete(cancelPending);
            if (cancelled || this._stopped) return;
            await this._stopNetworkRuntime();
            if (cancelled || this._stopped) return;
            await this.startServers();
          } catch (/** @type {any} */ err) {
            this.logger?.warnThrottled?.(
              "reload-restart-err",
              `Deferred network reload failed: ${err?.message || err}`,
              5000
            );
          } finally {
            this._pendingDeferredReloadCancels?.delete(cancelPending);
            if (this._pendingNetworkRestart === deferredRestartPromise) {
              this._pendingNetworkRestart = null;
            }
            resolveDeferredDone();
          }
        })();

        this._pendingNetworkRestart = deferredRestartPromise;
        transportCtx.deferredTask = () => fireTrigger();

        return {
          reloaded: true,
          network_restarted: false,
          network_restart_scheduled: true,
          changed_keys: diff.changedKeys,
          network_changed_keys: diff.networkChangedKeys,
        };
      }

      await this._stopNetworkRuntime();
      await this.startServers();
      resolveDeferredDone();
      return {
        reloaded: true,
        network_restarted: true,
        network_restart_scheduled: false,
        changed_keys: diff.changedKeys,
        network_changed_keys: diff.networkChangedKeys,
        listen_errors: Array.isArray(this.listenErrors) ? [...this.listenErrors] : [],
      };
    } catch (err) {
      resolveDeferredDone();
      throw err;
    } finally {
      releaseMain();
    }
  }

  async stopServers() {
    this._stopped = true;
    if (this._pendingDeferredReloadCancels instanceof Set) {
      for (const cancel of Array.from(this._pendingDeferredReloadCancels)) {
        try {
          cancel();
        } catch (err) {
          this._debugSafe(err);
        }
      }
      this._pendingDeferredReloadCancels.clear();
    }
    if (this.bridge.sessionController) {
      this.bridge.sessionController.interactionSeq += 1;
      this.bridge.sessionController.clearIdleTimers();
      this.bridge.sessionController.scheduler.dispose();
    }
    if (this.bridge.echoCorrelator && typeof this.bridge.echoCorrelator.clear === "function") {
      this.bridge.echoCorrelator.clear();
    }
    this.bridge.rendererIpc?._rejectPendingRendererCmds(null, "bridge servers stopped");
    await this._stopNetworkRuntime();
    if (typeof this.bridge.flushStateStores === "function") {
      try {
        await this.bridge.flushStateStores();
      } catch (err) {
        this._debugSafe(err);
      }
    }
    this.bridge.flushTempCleanup?.();
  }
}

module.exports = {
  ServerRuntime,
  writeHttpJson,
  buildEndpointActionContext,
  buildFailedActionReply,
  classifyForwardWsRole,
  computeConfigDiff,
};
