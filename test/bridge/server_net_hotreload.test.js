"use strict";

/**
 * Wave 2 `server-net` Test Suite (`test/bridge/server_net_hotreload.test.js`)
 *
 * Verifies:
 * 1. New env & JSON config options with multi-prefix (`ROSMONTIS_*` / `ONEBOT_*` / `XIAO_BRIDGE_*`) precedence
 * 2. Structured JSON vs text logging in `BridgeLogger`
 * 3. Forward WebSocket split endpoints (`/api`, `/api/`, `/event`, `/event/`, `/`, `/universal`)
 * 4. HTTP readiness probe (`GET /ready`) and Prometheus exposition endpoint (`GET /metrics`) + auth/Origin guard
 * 5. Webhook bounded concurrency, FIFO queue overflow drop, exponential backoff retry (503/429 vs 4xx), and timer cleanup
 * 6. Hot config reload (`reloadConfig()`, live `POST /reload_config` zero-deadlock over HTTP, SIGHUP lifecycle, store & session preservation)
 */

const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { mainMod, sleep, saveEnvVars, makeTempDir } = require("./_helpers");
const { BridgeLogger } = require("../../src/core/primitives");
const { classifyForwardWsRole } = require("../../src/core/server_runtime");

const { NtqqOneBotBridge, loadBridgeConfig, connectReverseWebSocket } = mainMod;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function httpRequest({
  port,
  method = "GET",
  path: reqPath = "/",
  headers = {},
  body = null,
  agent = false,
}) {
  return new Promise((resolve, reject) => {
    const payload =
      body === null || body === undefined
        ? null
        : typeof body === "string"
        ? Buffer.from(body, "utf8")
        : Buffer.from(JSON.stringify(body), "utf8");
    const reqHeaders = { ...headers };
    if (payload) {
      if (!reqHeaders["Content-Type"]) {
        reqHeaders["Content-Type"] = "application/json; charset=utf-8";
      }
      reqHeaders["Content-Length"] = String(payload.length);
    }
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path: reqPath,
        headers: reqHeaders,
        agent,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {}
          resolve({ statusCode: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

function connectWsClient(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const waiters = [];
    let connRef = null;
    let settled = false;

    const handle = connectReverseWebSocket(
      url,
      headers,
      (conn) => {
        connRef = conn;
        if (!settled) {
          settled = true;
          resolve({
            conn,
            handle,
            messages,
            nextMessage(timeoutMs = 1500) {
              if (messages.length > 0) {
                return Promise.resolve(messages.shift());
              }
              return new Promise((res, rej) => {
                const timer = setTimeout(() => {
                  const idx = waiters.indexOf(entry);
                  if (idx >= 0) waiters.splice(idx, 1);
                  rej(new Error(`Timed out waiting for WS message on ${url}`));
                }, timeoutMs);
                timer.unref?.();
                const entry = {
                  resolve: (msg) => {
                    clearTimeout(timer);
                    res(msg);
                  },
                };
                waiters.push(entry);
              });
            },
            close() {
              try {
                connRef?.close();
              } catch (_) {}
              try {
                handle.close();
              } catch (_) {}
            },
          });
        }
      },
      (text) => {
        let parsed = text;
        try {
          parsed = JSON.parse(text);
        } catch (_) {}
        if (waiters.length > 0) {
          waiters.shift().resolve(parsed);
        } else {
          messages.push(parsed);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          reject(new Error(`WS connection closed before open: ${url}`));
        }
      }
    );
  });
}

// ============================================================================
// 1. Env & Config Multi-Prefix Parsing
// ============================================================================

test("loadBridgeConfig parses new observability, webhook, renderer, and rateLimit options with multi-prefix env overrides", () => {
  const envKeys = [
    "ROSMONTIS_LOG_FORMAT",
    "ONEBOT_LOG_FORMAT",
    "XIAO_BRIDGE_LOG_FORMAT",
    "ROSMONTIS_ENABLE_METRICS",
    "ONEBOT_ENABLE_METRICS",
    "ROSMONTIS_RELOAD_ON_SIGHUP",
    "XIAO_BRIDGE_RELOAD_ON_SIGHUP",
    "ROSMONTIS_WEBHOOK_MAX_CONCURRENCY",
    "ONEBOT_WEBHOOK_MAX_QUEUE_SIZE",
    "XIAO_BRIDGE_WEBHOOK_MAX_RETRIES",
    "ROSMONTIS_WEBHOOK_RETRY_BASE_MS",
    "ROSMONTIS_RENDERER_AUTO_RELOAD",
    "ONEBOT_RENDERER_MAX_RELOADS_PER_MINUTE",
    "XIAO_BRIDGE_RENDERER_RELOAD_BACKOFF_MS",
    "ROSMONTIS_RATE_LIMIT_ENABLE",
    "ONEBOT_RATE_LIMIT_GLOBAL_PER_SEC",
    "XIAO_BRIDGE_RATE_LIMIT_GLOBAL_BURST",
    "ROSMONTIS_RATE_LIMIT_PER_PEER_PER_SEC",
    "ONEBOT_RATE_LIMIT_PER_PEER_BURST",
    "XIAO_BRIDGE_RATE_LIMIT_CB_THRESHOLD",
    "ROSMONTIS_RATE_LIMIT_CB_COOLDOWN_MS",
  ];
  const restoreEnv = saveEnvVars(envKeys);
  const tmp = makeTempDir("rosmontis-cfg-w2-");

  try {
    for (const k of envKeys) delete process.env[k];

    // Defaults when empty directory
    const defaults = loadBridgeConfig(tmp.dir);
    assert.strictEqual(defaults.logFormat, "text");
    assert.strictEqual(defaults.enableMetrics, true);
    assert.strictEqual(defaults.reloadOnSighup, true);
    assert.strictEqual(defaults.webhookMaxConcurrency, 8);
    assert.strictEqual(defaults.webhookMaxQueueSize, 256);
    assert.strictEqual(defaults.webhookMaxRetries, 2);
    assert.strictEqual(defaults.webhookRetryBaseMs, 250);
    assert.strictEqual(defaults.rendererAutoReload, true);
    assert.strictEqual(defaults.rendererMaxReloadsPerMinute, 3);
    assert.strictEqual(defaults.rendererReloadBackoffMs, 1500);
    assert.deepStrictEqual(defaults.rateLimit, {
      enabled: false,
      globalPerSec: 10,
      globalBurst: 20,
      perPeerPerSec: 2,
      perPeerBurst: 5,
      circuitBreakerThreshold: 5,
      circuitBreakerCooldownMs: 30000,
    });

    // JSON file values
    fs.writeFileSync(
      path.join(tmp.dir, "rosmontis.json"),
      JSON.stringify({
        logFormat: "json",
        enableMetrics: false,
        reloadOnSighup: false,
        webhookMaxConcurrency: 4,
        webhookMaxQueueSize: 64,
        webhookMaxRetries: 0,
        webhookRetryBaseMs: 100,
        rendererAutoReload: false,
        rendererMaxReloadsPerMinute: 7,
        rendererReloadBackoffMs: 0,
        rateLimit: {
          enabled: true,
          globalPerSec: 15,
          globalBurst: 30,
          perPeerPerSec: 3,
          perPeerBurst: 6,
          circuitBreakerThreshold: 9,
          circuitBreakerCooldownMs: 12000,
        },
        networks: { httpServers: [], wsServers: [] },
      }),
      "utf8"
    );

    const fromJson = loadBridgeConfig(tmp.dir);
    assert.strictEqual(fromJson.logFormat, "json");
    assert.strictEqual(fromJson.enableMetrics, false);
    assert.strictEqual(fromJson.reloadOnSighup, false);
    assert.strictEqual(fromJson.webhookMaxConcurrency, 4);
    assert.strictEqual(fromJson.webhookMaxQueueSize, 64);
    assert.strictEqual(fromJson.webhookMaxRetries, 0);
    assert.strictEqual(fromJson.webhookRetryBaseMs, 100);
    assert.strictEqual(fromJson.rendererAutoReload, false);
    assert.strictEqual(fromJson.rendererMaxReloadsPerMinute, 7);
    assert.strictEqual(fromJson.rendererReloadBackoffMs, 0);
    assert.deepStrictEqual(fromJson.rateLimit, {
      enabled: true,
      globalPerSec: 15,
      globalBurst: 30,
      perPeerPerSec: 3,
      perPeerBurst: 6,
      circuitBreakerThreshold: 9,
      circuitBreakerCooldownMs: 12000,
    });

    // Multi-prefix env overrides (ROSMONTIS_ > ONEBOT_ > XIAO_BRIDGE_ > JSON)
    process.env.XIAO_BRIDGE_LOG_FORMAT = "text";
    process.env.ONEBOT_LOG_FORMAT = "json";
    process.env.ROSMONTIS_LOG_FORMAT = "text";
    process.env.ONEBOT_ENABLE_METRICS = "true";
    process.env.XIAO_BRIDGE_RELOAD_ON_SIGHUP = "true";
    process.env.ROSMONTIS_WEBHOOK_MAX_CONCURRENCY = "12";
    process.env.ONEBOT_WEBHOOK_MAX_QUEUE_SIZE = "512";
    process.env.XIAO_BRIDGE_WEBHOOK_MAX_RETRIES = "5";
    process.env.ROSMONTIS_WEBHOOK_RETRY_BASE_MS = "50";
    process.env.ROSMONTIS_RENDERER_AUTO_RELOAD = "true";
    process.env.ONEBOT_RENDERER_MAX_RELOADS_PER_MINUTE = "9";
    process.env.XIAO_BRIDGE_RENDERER_RELOAD_BACKOFF_MS = "500";
    process.env.ROSMONTIS_RATE_LIMIT_ENABLE = "false";
    process.env.ONEBOT_RATE_LIMIT_GLOBAL_PER_SEC = "25";
    process.env.XIAO_BRIDGE_RATE_LIMIT_GLOBAL_BURST = "50";
    process.env.ROSMONTIS_RATE_LIMIT_PER_PEER_PER_SEC = "4.5";
    process.env.ONEBOT_RATE_LIMIT_PER_PEER_BURST = "8";
    process.env.XIAO_BRIDGE_RATE_LIMIT_CB_THRESHOLD = "11";
    process.env.ROSMONTIS_RATE_LIMIT_CB_COOLDOWN_MS = "45000";

    const fromEnv = loadBridgeConfig(tmp.dir);
    assert.strictEqual(fromEnv.logFormat, "text");
    assert.strictEqual(fromEnv.enableMetrics, true);
    assert.strictEqual(fromEnv.reloadOnSighup, true);
    assert.strictEqual(fromEnv.webhookMaxConcurrency, 12);
    assert.strictEqual(fromEnv.webhookMaxQueueSize, 512);
    assert.strictEqual(fromEnv.webhookMaxRetries, 5);
    assert.strictEqual(fromEnv.webhookRetryBaseMs, 50);
    assert.strictEqual(fromEnv.rendererAutoReload, true);
    assert.strictEqual(fromEnv.rendererMaxReloadsPerMinute, 9);
    assert.strictEqual(fromEnv.rendererReloadBackoffMs, 500);
    assert.deepStrictEqual(fromEnv.rateLimit, {
      enabled: false,
      globalPerSec: 25,
      globalBurst: 50,
      perPeerPerSec: 4.5,
      perPeerBurst: 8,
      circuitBreakerThreshold: 11,
      circuitBreakerCooldownMs: 45000,
    });
  } finally {
    restoreEnv();
    tmp.cleanup();
  }
});

// ============================================================================
// 2. Structured JSON vs Text Logging
// ============================================================================

test("BridgeLogger emits unchanged text lines by default and valid single-line JSON when logFormat=json", () => {
  const lines = [];
  const cfg = { quietLogs: false, debugLogs: true, logFormat: "text" };
  const logger = new BridgeLogger({
    getConfig: () => cfg,
    isQuiet: (c) => Boolean(c.quietLogs),
    isDebug: (c) => Boolean(c.debugLogs),
    write: (chunk) => lines.push(chunk),
  });

  // Text mode
  assert.strictEqual(logger.debug("ipc", "ping ok"), true);
  assert.strictEqual(logger.debug("standalone debug"), true);
  assert.strictEqual(logger.warn("slow peer"), true);
  assert.strictEqual(logger.warnThrottled("wh-key", "webhook degraded", 60000), true);
  assert.strictEqual(logger.error("boot failed", new Error("boom")), true);

  assert.strictEqual(lines[0], "[rosmontis] DEBUG [ipc]: ping ok\n");
  assert.strictEqual(lines[1], "[rosmontis] DEBUG: standalone debug\n");
  assert.strictEqual(lines[2], "[rosmontis] slow peer\n");
  assert.strictEqual(lines[3], "[rosmontis] webhook degraded\n");
  assert.strictEqual(lines[4], "[rosmontis] ERROR: boot failed: boom\n");

  // Switch dynamically to JSON mode (as happens during hot config reload)
  lines.length = 0;
  cfg.logFormat = "json";

  assert.strictEqual(logger.debug("ipc", "json debug"), true);
  assert.strictEqual(logger.warn("json warn"), true);
  assert.strictEqual(logger.warnThrottled("wh-key-2", "throttled json", 60000), true);
  assert.strictEqual(logger.error("json err", new Error("oops")), true);

  assert.strictEqual(lines.length, 4);
  for (const raw of lines) {
    assert.ok(raw.endsWith("\n"), "Every log entry must terminate with newline");
    assert.strictEqual(raw.trim().includes("\n"), false, "JSON log entry must be single-line");
  }

  const parsedDebug = JSON.parse(lines[0]);
  assert.strictEqual(parsedDebug.level, "debug");
  assert.strictEqual(parsedDebug.component, "rosmontis");
  assert.strictEqual(parsedDebug.scope, "ipc");
  assert.strictEqual(parsedDebug.msg, "json debug");
  assert.ok(!Number.isNaN(Date.parse(parsedDebug.ts)));
  assert.strictEqual("key" in parsedDebug, false);

  const parsedWarn = JSON.parse(lines[1]);
  assert.strictEqual(parsedWarn.level, "warn");
  assert.strictEqual(parsedWarn.component, "rosmontis");
  assert.strictEqual(parsedWarn.msg, "json warn");
  assert.strictEqual("scope" in parsedWarn, false);
  assert.strictEqual("key" in parsedWarn, false);

  const parsedThrottled = JSON.parse(lines[2]);
  assert.strictEqual(parsedThrottled.level, "warn");
  assert.strictEqual(parsedThrottled.key, "wh-key-2");
  assert.strictEqual(parsedThrottled.msg, "throttled json");

  const parsedErr = JSON.parse(lines[3]);
  assert.strictEqual(parsedErr.level, "error");
  assert.strictEqual(parsedErr.component, "rosmontis");
  assert.strictEqual(parsedErr.msg, "json err: oops");
});

// ============================================================================
// 3. Forward WebSocket Split Endpoints (/api, /event, /)
// ============================================================================

test("Forward WS separates /api (actions only, no events), /event (events only, rejects API 1403), and / (universal)", async () => {
  assert.strictEqual(classifyForwardWsRole("/api"), "api");
  assert.strictEqual(classifyForwardWsRole("/api/"), "api");
  assert.strictEqual(classifyForwardWsRole("/event"), "event");
  assert.strictEqual(classifyForwardWsRole("/event/"), "event");
  assert.strictEqual(classifyForwardWsRole("/"), "universal");
  assert.strictEqual(classifyForwardWsRole("/universal"), "universal");

  const wsPort = await getFreePort();
  const bridge = new NtqqOneBotBridge({
    selfUin: "10086001",
    selfNickname: "SplitWsBot",
    online: true,
    ntApi: { "nodeIKernelMsgService/sendMsg": async () => ({ result: 0 }) },
    config: {
      selfUin: "10086001",
      httpServers: [],
      wsServers: [{ name: "ws-split", host: "127.0.0.1", port: wsPort, accessToken: "ws-tok" }],
      wsClients: [],
      httpClients: [],
      heartbeatIntervalMs: 0,
      wsPingIntervalMs: 0,
    },
  });

  await bridge.startServers();
  const clients = [];
  try {
    const authHeaders = { Authorization: "Bearer ws-tok" };
    const apiClient = await connectWsClient(`ws://127.0.0.1:${wsPort}/api`, authHeaders);
    const eventClient = await connectWsClient(`ws://127.0.0.1:${wsPort}/event/`, authHeaders);
    const univClient = await connectWsClient(`ws://127.0.0.1:${wsPort}/`, authHeaders);
    clients.push(apiClient, eventClient, univClient);

    // /event and / must receive lifecycle connect; /api must NOT
    const evLifecycle = await eventClient.nextMessage();
    assert.strictEqual(evLifecycle.post_type, "meta_event");
    assert.strictEqual(evLifecycle.meta_event_type, "lifecycle");

    const univLifecycle = await univClient.nextMessage();
    assert.strictEqual(univLifecycle.post_type, "meta_event");
    assert.strictEqual(univLifecycle.meta_event_type, "lifecycle");

    // Broadcast a message event
    bridge.broadcastOneBotEvent({
      post_type: "message",
      message_type: "private",
      user_id: 20001,
      raw_message: "split-broadcast-test",
      message: [{ type: "text", data: { text: "split-broadcast-test" } }],
    });

    const evMsg = await eventClient.nextMessage();
    assert.strictEqual(evMsg.raw_message, "split-broadcast-test");
    const univMsg = await univClient.nextMessage();
    assert.strictEqual(univMsg.raw_message, "split-broadcast-test");

    // Give a brief window to confirm /api never received lifecycle or broadcast events
    await sleep(40);
    assert.strictEqual(apiClient.messages.length, 0, "/api client must not receive lifecycle or broadcast events");

    // /api accepts API action frames
    apiClient.conn.sendJson({ action: "get_login_info", params: {}, echo: "api-1" });
    const apiReply = await apiClient.nextMessage();
    assert.strictEqual(apiReply.status, "ok");
    assert.strictEqual(apiReply.retcode, 0);
    assert.strictEqual(apiReply.echo, "api-1");
    assert.strictEqual(apiReply.data.user_id, 10086001);

    // /universal also accepts API action frames
    univClient.conn.sendJson({ action: "get_login_info", params: {}, echo: "univ-1" });
    const univReply = await univClient.nextMessage();
    assert.strictEqual(univReply.status, "ok");
    assert.strictEqual(univReply.echo, "univ-1");

    // /event rejects API action frames with retcode 1403
    eventClient.conn.sendJson({ action: "get_login_info", params: {}, echo: "ev-deny" });
    const evReject = await eventClient.nextMessage();
    assert.strictEqual(evReject.status, "failed");
    assert.strictEqual(evReject.retcode, 1403);
    assert.strictEqual(evReject.echo, "ev-deny");
    assert.ok(evReject.message.includes("Event-only WebSocket endpoint"));
  } finally {
    for (const c of clients) c.close();
    await bridge.stopServers();
  }
});

// ============================================================================
// 4. HTTP Readiness Probe (/ready) & Prometheus Metrics (/metrics)
// ============================================================================

test("GET /ready reflects online/nt_ready/unresponsive states and GET /metrics exposes Prometheus text with auth guard", async () => {
  const httpPort = await getFreePort();
  const bridge = new NtqqOneBotBridge({
    selfUin: "20260001",
    selfNickname: "MetricsBot",
    online: true,
    ntApi: { "nodeIKernelMsgService/sendMsg": async () => ({ result: 0 }) },
    config: {
      selfUin: "20260001",
      enableMetrics: true,
      httpServers: [
        {
          name: "http-obs",
          host: "127.0.0.1",
          port: httpPort,
          accessToken: "obs-secret",
          allowedOrigins: ["https://ops.example.com"],
        },
      ],
      wsServers: [],
      wsClients: [],
      httpClients: [],
      heartbeatIntervalMs: 0,
      wsPingIntervalMs: 0,
    },
  });

  // Seed observable telemetry counters & stores
  bridge.invokeStats.tier1 = 7;
  bridge.invokeStats.tier2 = 2;
  bridge.invokeStats.tier3 = 1;
  bridge.invokeStats.degraded = 3;
  bridge.invokeStats.blockedReplays = 1;
  bridge.invokeStats.failed = 4;
  bridge.sendEchoStats.matched = 11;
  bridge.sendEchoStats.fromResult = 2;
  bridge.sendEchoStats.timedOut = 1;
  bridge.webhookStats.ok = 5;
  bridge.webhookStats.failed = 1;
  bridge.webhookStats.dropped = 2;
  bridge.rateLimiter = { getStats: () => ({ rejected: 6 }) };
  bridge.rendererHealthStats = { crashes: 2, unresponsiveActive: false };
  bridge.messageIdStore.register("700000000000000001", { chatType: 1, peerUid: "u_1" }, "1");
  bridge.uinUidStore.remember("30001", "u_30001");

  await bridge.startServers();
  try {
    const authHeaders = { Authorization: "Bearer obs-secret" };

    // Auth & Origin enforcement on /ready and /metrics
    const noAuthReady = await httpRequest({ port: httpPort, path: "/ready" });
    assert.strictEqual(noAuthReady.statusCode, 401);
    const noAuthMetrics = await httpRequest({ port: httpPort, path: "/metrics" });
    assert.strictEqual(noAuthMetrics.statusCode, 401);
    const badOriginMetrics = await httpRequest({
      port: httpPort,
      path: "/metrics",
      headers: { ...authHeaders, Origin: "https://evil.example.com" },
    });
    assert.strictEqual(badOriginMetrics.statusCode, 403);

    // Ready 200 when online + ntReady + responsive
    const readyOk = await httpRequest({ port: httpPort, path: "/ready", headers: authHeaders });
    assert.strictEqual(readyOk.statusCode, 200);
    assert.deepStrictEqual(readyOk.json, {
      status: "ok",
      retcode: 0,
      ready: true,
      online: true,
      nt_ready: true,
      renderer_unresponsive: false,
      self_id: 20260001,
    });

    // Prometheus /metrics exposition
    const metricsRes = await httpRequest({ port: httpPort, path: "/metrics", headers: authHeaders });
    assert.strictEqual(metricsRes.statusCode, 200);
    assert.strictEqual(
      metricsRes.headers["content-type"],
      "text/plain; version=0.0.4; charset=utf-8"
    );
    const body = metricsRes.text;
    for (const expectedLine of [
      "# HELP rosmontis_up",
      "# TYPE rosmontis_up gauge",
      "rosmontis_up 1",
      "rosmontis_online 1",
      "rosmontis_ready 1",
      'rosmontis_invoke_total{tier="tier1"} 7',
      'rosmontis_invoke_total{tier="tier2"} 2',
      'rosmontis_invoke_total{tier="tier3"} 1',
      "rosmontis_invoke_degraded_total 3",
      "rosmontis_invoke_blocked_replays_total 1",
      "rosmontis_invoke_failed_total 4",
      'rosmontis_send_echo_total{outcome="matched"} 11',
      'rosmontis_send_echo_total{outcome="from_result"} 2',
      'rosmontis_send_echo_total{outcome="timed_out"} 1',
      "rosmontis_ws_server_clients 0",
      "rosmontis_reverse_ws_connected 0",
      'rosmontis_webhook_deliveries_total{outcome="ok"} 5',
      'rosmontis_webhook_deliveries_total{outcome="failed"} 1',
      'rosmontis_webhook_deliveries_total{outcome="dropped"} 2',
      "rosmontis_webhook_in_flight 0",
      "rosmontis_webhook_queued 0",
      "rosmontis_rate_limit_rejected_total 6",
      "rosmontis_renderer_crashes_total 2",
      "rosmontis_store_messages_size 1",
      "rosmontis_store_uin_uid_size 1",
    ]) {
      assert.ok(body.includes(expectedLine), `Expected metrics output to contain: ${expectedLine}`);
    }
    assert.match(body, /^rosmontis_uptime_seconds \d+$/m);

    // 503 when renderer is unresponsive
    bridge.rendererHealthStats.unresponsiveActive = true;
    const unrespRes = await httpRequest({ port: httpPort, path: "/ready", headers: authHeaders });
    assert.strictEqual(unrespRes.statusCode, 503);
    assert.strictEqual(unrespRes.json.retcode, 1503);
    assert.strictEqual(unrespRes.json.ready, false);
    assert.strictEqual(unrespRes.json.renderer_unresponsive, true);
    bridge.rendererHealthStats.unresponsiveActive = false;

    // 503 when offline
    bridge.online = false;
    const offlineRes = await httpRequest({ port: httpPort, path: "/ready", headers: authHeaders });
    assert.strictEqual(offlineRes.statusCode, 503);
    assert.strictEqual(offlineRes.json.online, false);
    assert.strictEqual(offlineRes.json.ready, false);
    // /health liveness remains 200 OK even when offline
    const healthRes = await httpRequest({ port: httpPort, path: "/health", headers: authHeaders });
    assert.strictEqual(healthRes.statusCode, 200);
    bridge.online = true;

    // 503 when NT runtime is not ready
    bridge.capturedServices.ntApi = null;
    const notNtRes = await httpRequest({ port: httpPort, path: "/ready", headers: authHeaders });
    assert.strictEqual(notNtRes.statusCode, 503);
    assert.strictEqual(notNtRes.json.nt_ready, false);
    assert.strictEqual(notNtRes.json.ready, false);

    // Metrics disabled via config -> 404
    bridge.config.enableMetrics = false;
    const disabledMetrics = await httpRequest({
      port: httpPort,
      path: "/metrics",
      headers: authHeaders,
    });
    assert.strictEqual(disabledMetrics.statusCode, 404);
  } finally {
    await bridge.stopServers();
  }
});

// ============================================================================
// 5. Webhook Bounded Concurrency, Queue Drop & Exponential Backoff Retry
// ============================================================================

test("Webhook queue enforces bounded concurrency & drops overflow, retries 503/429 with backoff, skips retry on 400, and clears timers on stop", async () => {
  // Part A: Bounded concurrency + queue drop
  let activeReqs = 0;
  let peakConcurrency = 0;
  let completedCount = 0;
  const pendingResolvers = [];

  const slowServer = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      activeReqs += 1;
      if (activeReqs > peakConcurrency) peakConcurrency = activeReqs;
      pendingResolvers.push(() => {
        activeReqs -= 1;
        completedCount += 1;
        res.writeHead(204);
        res.end();
      });
    });
  });
  await new Promise((resolve) => slowServer.listen(0, "127.0.0.1", resolve));
  const slowPort = slowServer.address().port;

  // Part B: Retry server (503 -> 200, 400 -> no retry, 429 -> 500 -> 204)
  const routeHits = new Map();
  const routeTimestamps = new Map();
  const retryServer = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const urlPath = req.url || "/";
      const hit = (routeHits.get(urlPath) || 0) + 1;
      routeHits.set(urlPath, hit);
      const tsList = routeTimestamps.get(urlPath) || [];
      tsList.push(Date.now());
      routeTimestamps.set(urlPath, tsList);

      if (urlPath === "/flaky503") {
        res.writeHead(hit === 1 ? 503 : 200, { "Content-Type": "application/json" });
        res.end(hit === 1 ? "unavailable" : "{}");
      } else if (urlPath === "/bad400") {
        res.writeHead(400);
        res.end("bad request");
      } else if (urlPath === "/rate429") {
        const status = hit === 1 ? 429 : hit === 2 ? 500 : 204;
        res.writeHead(status);
        res.end();
      } else {
        res.writeHead(503);
        res.end("always down");
      }
    });
  });
  await new Promise((resolve) => retryServer.listen(0, "127.0.0.1", resolve));
  const retryPort = retryServer.address().port;

  const bridge = new NtqqOneBotBridge({
    selfUin: "10001",
    online: true,
    config: {
      selfUin: "10001",
      httpServers: [],
      wsServers: [],
      wsClients: [],
      httpClients: [
        { name: "bounded", url: `http://127.0.0.1:${slowPort}/hook`, maxRetries: 0 },
      ],
      webhookMaxConcurrency: 2,
      webhookMaxQueueSize: 2,
      webhookMaxRetries: 2,
      webhookRetryBaseMs: 35,
      heartbeatIntervalMs: 0,
      wsPingIntervalMs: 0,
    },
  });

  try {
    // Dispatch 6 events simultaneously with maxConcurrency=2, maxQueueSize=2 -> 2 inFlight, 2 queued, 2 dropped
    const tasks = [];
    for (let i = 0; i < 6; i += 1) {
      tasks.push(
        ...bridge._dispatchHttpWebhookEvent({
          post_type: "message",
          message_type: "private",
          user_id: 100 + i,
          raw_message: `msg-${i}`,
        })
      );
    }

    assert.strictEqual(bridge.webhookStats.inFlight, 2);
    assert.strictEqual(bridge.webhookStats.queued, 2);
    assert.strictEqual(bridge.webhookStats.dropped, 2);

    // Wait until the first 2 requests reach the server, then release them in waves
    for (let tries = 0; tries < 50 && pendingResolvers.length < 2; tries += 1) {
      await sleep(10);
    }
    assert.strictEqual(pendingResolvers.length, 2);
    while (pendingResolvers.length > 0) pendingResolvers.shift()();

    for (let tries = 0; tries < 50 && pendingResolvers.length < 2; tries += 1) {
      await sleep(10);
    }
    assert.strictEqual(pendingResolvers.length, 2);
    while (pendingResolvers.length > 0) pendingResolvers.shift()();

    await Promise.all(tasks);
    assert.strictEqual(peakConcurrency, 2, "Concurrency must never exceed webhookMaxConcurrency");
    assert.strictEqual(completedCount, 4);
    assert.strictEqual(bridge.webhookStats.ok, 4);
    assert.strictEqual(bridge.webhookStats.inFlight, 0);
    assert.strictEqual(bridge.webhookStats.queued, 0);
    assert.strictEqual(bridge.webhookStats.dropped, 2);

    // Test retry: 503 on 1st attempt -> succeeds on 2nd attempt
    bridge.config.httpClients = [
      { name: "flaky503", url: `http://127.0.0.1:${retryPort}/flaky503` },
    ];
    await Promise.all(
      bridge._dispatchHttpWebhookEvent({ post_type: "notice", notice_type: "poke" })
    );
    assert.strictEqual(routeHits.get("/flaky503"), 2);
    assert.strictEqual(bridge.webhookStats.ok, 5);
    assert.strictEqual(bridge.webhookStats.retries, 1);
    assert.strictEqual(bridge.webhookStats.failed, 0);

    // Test non-retryable 400 -> 1 attempt only, increments failed
    bridge.config.httpClients = [
      { name: "bad400", url: `http://127.0.0.1:${retryPort}/bad400` },
    ];
    await Promise.all(
      bridge._dispatchHttpWebhookEvent({ post_type: "notice", notice_type: "poke" })
    );
    assert.strictEqual(routeHits.get("/bad400"), 1, "400 must not be retried");
    assert.strictEqual(bridge.webhookStats.retries, 1);
    assert.strictEqual(bridge.webhookStats.failed, 1);

    // Test 429 -> 500 -> 204 with exponential backoff (base 35ms -> 35ms, then 70ms)
    bridge.config.httpClients = [
      { name: "rate429", url: `http://127.0.0.1:${retryPort}/rate429` },
    ];
    await Promise.all(
      bridge._dispatchHttpWebhookEvent({ post_type: "notice", notice_type: "poke" })
    );
    assert.strictEqual(routeHits.get("/rate429"), 3);
    assert.strictEqual(bridge.webhookStats.ok, 6);
    assert.strictEqual(bridge.webhookStats.retries, 3);
    const ts429 = routeTimestamps.get("/rate429");
    assert.strictEqual(ts429.length, 3);
    assert.ok(ts429[1] - ts429[0] >= 20, `Expected first backoff >=20ms, got ${ts429[1] - ts429[0]}ms`);
    assert.ok(ts429[2] - ts429[1] >= 45, `Expected second exponential backoff >=45ms, got ${ts429[2] - ts429[1]}ms`);

    // Test stopServers cancels long pending retry timers immediately without leaking handles
    bridge.config.httpClients = [
      {
        name: "always-down",
        url: `http://127.0.0.1:${retryPort}/always-down`,
        maxRetries: 3,
        retryBaseMs: 30000,
      },
    ];
    const pendingStopTasks = bridge._dispatchHttpWebhookEvent({
      post_type: "notice",
      notice_type: "poke",
    });
    for (let tries = 0; tries < 50 && bridge._webhookRetryTimers.size === 0; tries += 1) {
      await sleep(10);
    }
    assert.strictEqual(bridge._webhookRetryTimers.size, 1);
    const stopStart = Date.now();
    await bridge.stopServers();
    await Promise.all(pendingStopTasks);
    assert.ok(Date.now() - stopStart < 500, "stopServers must cancel pending webhook retry timers immediately");
    assert.strictEqual(bridge._webhookRetryTimers.size, 0);
  } finally {
    await bridge.stopServers();
    await new Promise((resolve) => slowServer.close(resolve));
    await new Promise((resolve) => retryServer.close(resolve));
  }
});

// ============================================================================
// 6. Hot Config Reload (Programmatic + Live POST /reload_config Zero-Deadlock)
// ============================================================================

test("reloadConfig supports programmatic & live HTTP POST /reload_config without deadlock, updating port/token/policy while preserving stores & session", async () => {
  const tmp = makeTempDir("rosmontis-hotreload-");
  const port1 = await getFreePort();
  const port2 = await getFreePort();
  const port3 = await getFreePort();

  const writeConfigFile = (cfgObj) => {
    fs.writeFileSync(
      path.join(tmp.dir, "rosmontis.json"),
      JSON.stringify(cfgObj, null, 2),
      "utf8"
    );
  };

  writeConfigFile({
    selfUin: "88880001",
    logFormat: "text",
    enableMetrics: true,
    rateLimit: { enabled: false, globalPerSec: 10 },
    networks: {
      httpServers: [
        { name: "http-main", host: "127.0.0.1", port: port1, accessToken: "tok-v1" },
      ],
      wsServers: [],
      wsClients: [],
      httpClients: [],
    },
  });

  let rateLimitUpdateCalls = 0;
  let lastRateLimitCfg = null;

  const bridge = new NtqqOneBotBridge({
    configDir: tmp.dir,
    selfUin: "88880001",
    selfUid: "u_self_88880001",
    selfNickname: "ReloadBot",
    online: true,
    ntApi: { "nodeIKernelMsgService/sendMsg": async () => ({ result: 0 }) },
  });

  bridge.rateLimiter = {
    updateConfig(cfg) {
      rateLimitUpdateCalls += 1;
      lastRateLimitCfg = cfg;
    },
    getStats() {
      return { rejected: 0 };
    },
  };

  // Spy on sessionScheduler.dispose and echoCorrelator.clear to verify hot reload never disposes QQ runtime state
  let schedulerDisposeCalls = 0;
  const origSchedulerDispose = bridge._sessionScheduler.dispose.bind(bridge._sessionScheduler);
  bridge._sessionScheduler.dispose = () => {
    schedulerDisposeCalls += 1;
    return origSchedulerDispose();
  };
  let echoClearCalls = 0;
  const origEchoClear = bridge.echoCorrelator.clear.bind(bridge.echoCorrelator);
  bridge.echoCorrelator.clear = () => {
    echoClearCalls += 1;
    return origEchoClear();
  };

  // Seed messageIdStore & uinUidStore to assert complete preservation across reloads
  const seededShortId = bridge.messageIdStore.register(
    "799999999999999999",
    { chatType: 2, peerUid: "600001" },
    "42"
  );
  bridge.uinUidStore.remember("500001", "u_500001");

  await bridge.startServers();
  try {
    // Verify initial HTTP server works with tok-v1
    const initHealth = await httpRequest({
      port: port1,
      path: "/health",
      headers: { Authorization: "Bearer tok-v1" },
    });
    assert.strictEqual(initHealth.statusCode, 200);
    assert.strictEqual(initHealth.json.self_id, 88880001);

    // 1) Policy-only programmatic reload: should NOT restart HTTP server
    const prevHttpServerRef = bridge._httpServers[0];
    writeConfigFile({
      selfUin: "88880001",
      logFormat: "json",
      enableMetrics: true,
      rateLimit: { enabled: true, globalPerSec: 42 },
      networks: {
        httpServers: [
          { name: "http-main", host: "127.0.0.1", port: port1, accessToken: "tok-v1" },
        ],
        wsServers: [],
        wsClients: [],
        httpClients: [],
      },
    });
    const policyRes = await bridge.reloadConfig();
    assert.strictEqual(policyRes.reloaded, true);
    assert.strictEqual(policyRes.network_restarted, false);
    assert.strictEqual(bridge.config.logFormat, "json");
    assert.strictEqual(bridge._httpServers[0], prevHttpServerRef, "Policy-only reload must not restart servers");
    assert.strictEqual(rateLimitUpdateCalls, 1);
    assert.strictEqual(lastRateLimitCfg.enabled, true);
    assert.strictEqual(lastRateLimitCfg.globalPerSec, 42);

    // 2) Live HTTP POST /reload_config changing port1 -> port2 AND token tok-v1 -> tok-v2 (ZERO DEADLOCK!)
    writeConfigFile({
      selfUin: "88880001",
      logFormat: "text",
      enableMetrics: true,
      rateLimit: { enabled: true, globalPerSec: 55 },
      networks: {
        httpServers: [
          { name: "http-main", host: "127.0.0.1", port: port2, accessToken: "tok-v2" },
        ],
        wsServers: [],
        wsClients: [],
        httpClients: [],
      },
    });

    const keepAliveAgent = new http.Agent({ keepAlive: true });
    const reloadStart = Date.now();
    let httpReloadRes;
    try {
      httpReloadRes = await httpRequest({
        port: port1,
        method: "POST",
        path: "/reload_config",
        headers: { Authorization: "Bearer tok-v1" },
        body: {},
        agent: keepAliveAgent,
      });
    } finally {
      keepAliveAgent.destroy();
    }
    const reloadElapsed = Date.now() - reloadStart;
    assert.ok(reloadElapsed < 2000, `POST /reload_config must not deadlock (took ${reloadElapsed}ms)`);
    assert.strictEqual(httpReloadRes.statusCode, 200);
    assert.strictEqual(httpReloadRes.json.status, "ok");
    assert.strictEqual(httpReloadRes.json.retcode, 0);
    assert.strictEqual(httpReloadRes.json.data.reloaded, true);
    assert.strictEqual(httpReloadRes.json.data.network_restart_scheduled, true);

    // Wait for deferred network restart to finish binding port2
    if (bridge._pendingNetworkRestart) {
      await bridge._pendingNetworkRestart;
    }

    // Old token rejected on port2, new token succeeds on port2
    const oldTokOnPort2 = await httpRequest({
      port: port2,
      path: "/health",
      headers: { Authorization: "Bearer tok-v1" },
    });
    assert.strictEqual(oldTokOnPort2.statusCode, 401);

    const newTokOnPort2 = await httpRequest({
      port: port2,
      path: "/ready",
      headers: { Authorization: "Bearer tok-v2" },
    });
    assert.strictEqual(newTokOnPort2.statusCode, 200);
    assert.strictEqual(newTokOnPort2.json.ready, true);

    // Old port1 must no longer accept connections
    await assert.rejects(
      httpRequest({ port: port1, path: "/health", headers: { Authorization: "Bearer tok-v1" } }),
      /ECONNREFUSED|ECONNRESET|socket hang up/i
    );

    // 3) Live HTTP POST /reload_config changing token on the SAME port (port2: tok-v2 -> tok-v3)
    writeConfigFile({
      selfUin: "88880001",
      logFormat: "json",
      enableMetrics: true,
      networks: {
        httpServers: [
          { name: "http-main", host: "127.0.0.1", port: port2, accessToken: "tok-v3" },
        ],
        wsServers: [],
        wsClients: [],
        httpClients: [],
      },
    });
    const samePortReload = await httpRequest({
      port: port2,
      method: "POST",
      path: "/reload_config",
      headers: { Authorization: "Bearer tok-v2" },
      body: {},
    });
    assert.strictEqual(samePortReload.statusCode, 200);
    assert.strictEqual(samePortReload.json.data.reloaded, true);
    if (bridge._pendingNetworkRestart) {
      await bridge._pendingNetworkRestart;
    }
    const tok3Res = await httpRequest({
      port: port2,
      path: "/health",
      headers: { Authorization: "Bearer tok-v3" },
    });
    assert.strictEqual(tok3Res.statusCode, 200);

    // 4) Overlapping programmatic reloadConfig calls serialize cleanly without racing
    const cfgA = {
      ...bridge.config,
      logFormat: "text",
      httpServers: [{ name: "http-a", host: "127.0.0.1", port: port1, accessToken: "tok-a" }],
    };
    const cfgB = {
      ...bridge.config,
      logFormat: "json",
      httpServers: [{ name: "http-b", host: "127.0.0.1", port: port3, accessToken: "tok-b" }],
    };
    const [rA, rB] = await Promise.all([
      bridge.reloadConfig({ config: cfgA }),
      bridge.reloadConfig({ config: cfgB }),
    ]);
    assert.strictEqual(rA.network_restarted, true);
    assert.strictEqual(rB.network_restarted, true);
    assert.strictEqual(bridge._httpServers.length, 1);
    const port3Res = await httpRequest({
      port: port3,
      path: "/health",
      headers: { Authorization: "Bearer tok-b" },
    });
    assert.strictEqual(port3Res.statusCode, 200);

    // 5) Verify QQ identity, online flag, capturedServices, and stores survived all reloads intact
    assert.strictEqual(bridge.online, true);
    assert.strictEqual(bridge.selfUin, "88880001");
    assert.strictEqual(bridge.selfUid, "u_self_88880001");
    assert.strictEqual(bridge.selfNickname, "ReloadBot");
    assert.ok(bridge.capturedServices.ntApi, "capturedServices.ntApi must remain intact");
    assert.strictEqual(bridge.messageIdStore.resolve(seededShortId)?.msgId, "799999999999999999");
    assert.strictEqual(bridge.uinUidStore.getUidSync("500001"), "u_500001");
    assert.strictEqual(schedulerDisposeCalls, 0, "Hot reload must never dispose _sessionScheduler");
    assert.strictEqual(echoClearCalls, 0, "Hot reload must never clear echoCorrelator");
    const lockOk = await bridge._withAioLock(async () => "still-alive");
    assert.strictEqual(lockOk, "still-alive");
  } finally {
    await bridge.stopServers();
    assert.strictEqual(schedulerDisposeCalls, 1, "stopServers must dispose _sessionScheduler");
    assert.strictEqual(echoClearCalls, 1, "stopServers must clear echoCorrelator");
    tmp.cleanup();
  }
});
