// @ts-check
"use strict";

/**
 * Composed Subsystem Architecture & Backward-Compatibility Contract Tests
 */

const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { REPO_ROOT, mainMod } = require("./_helpers");

const {
  NtCaptureController,
  ntCaptureMixin,
} = require(path.join(REPO_ROOT, "src", "core", "nt_capture.js"));
const {
  RendererIpcController,
  rendererIpcMixin,
} = require(path.join(REPO_ROOT, "src", "core", "renderer_ipc.js"));
const {
  InboundPipeline,
  inboundPipelineMixin,
} = require(path.join(REPO_ROOT, "src", "core", "inbound_pipeline.js"));
const {
  OutboundPipeline,
  outboundPipelineMixin,
} = require(path.join(REPO_ROOT, "src", "core", "outbound_pipeline.js"));
const {
  ServerRuntime,
  serverRuntimeMixin,
} = require(path.join(REPO_ROOT, "src", "core", "server_runtime.js"));

/**
 * @param {Record<string, any>} [overrides]
 */
function makeConfig(overrides = {}) {
  return {
    selfUin: "100010001",
    httpServers: [],
    wsServers: [],
    wsClients: [],
    heartbeatIntervalMs: 0,
    humanSimulation: false,
    quietLogs: true,
    ...overrides,
  };
}

test("NtqqOneBotBridge composes 5 real subsystem controller classes without Object.assign prototype mixin dumping", () => {
  const bridgeMainSrc = fs.readFileSync(path.join(REPO_ROOT, "src", "bridge_main.js"), "utf8");
  assert.strictEqual(
    /Object\.assign\s*\(\s*NtqqOneBotBridge\.prototype/.test(bridgeMainSrc),
    false,
    "src/bridge_main.js must not dump mixins onto NtqqOneBotBridge.prototype via Object.assign"
  );

  const rendererIpcSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src", "core", "renderer_ipc.js"),
    "utf8"
  );
  assert.strictEqual(
    rendererIpcSrc.includes("function _reviveUint8Arrays"),
    false,
    "src/core/renderer_ipc.js must not keep duplicate _reviveUint8Arrays helper"
  );
  assert.strictEqual(
    rendererIpcSrc.includes("reviveBridgePayload"),
    true,
    "src/core/renderer_ipc.js must use reviveBridgePayload from ./primitives"
  );

  for (const rel of [
    "src/bridge_main.js",
    "src/types.js",
    "src/core/nt_capture.js",
    "src/core/renderer_ipc.js",
    "src/core/inbound_pipeline.js",
    "src/core/outbound_pipeline.js",
    "src/core/server_runtime.js",
  ]) {
    const firstLine = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8").split(/\r?\n/)[0].trim();
    assert.strictEqual(firstLine, "// @ts-check", `${rel} must enable // @ts-check`);
  }

  const bridge = new mainMod.NtqqOneBotBridge({ config: makeConfig() });

  assert.ok(bridge.ntCapture instanceof NtCaptureController);
  assert.ok(bridge.rendererIpc instanceof RendererIpcController);
  assert.ok(bridge.inboundPipeline instanceof InboundPipeline);
  assert.ok(bridge.outboundPipeline instanceof OutboundPipeline);
  assert.ok(bridge.serverRuntime instanceof ServerRuntime);

  assert.strictEqual(bridge.ntCapture.bridge, bridge);
  assert.strictEqual(bridge.rendererIpc.bridge, bridge);
  assert.strictEqual(bridge.inboundPipeline.bridge, bridge);
  assert.strictEqual(bridge.outboundPipeline.bridge, bridge);
  assert.strictEqual(bridge.serverRuntime.bridge, bridge);
});

test("Subsystem-private state lives on controllers and stays synchronized through bridge accessors", () => {
  const bridge = new mainMod.NtqqOneBotBridge({ config: makeConfig() });

  // NtCaptureController state ownership
  assert.strictEqual(bridge._attachedEmitters, bridge.ntCapture._attachedEmitters);
  assert.strictEqual(bridge._mapSetHook, bridge.ntCapture._mapSetHook);

  // RendererIpcController state ownership
  assert.strictEqual(bridge._knownWebContents, bridge.rendererIpc._knownWebContents);
  assert.strictEqual(bridge._pendingRendererCmds, bridge.rendererIpc._pendingRendererCmds);
  assert.strictEqual(bridge._ipcAuthToken, bridge.rendererIpc._ipcAuthToken);
  assert.strictEqual(bridge.invokeStats, bridge.rendererIpc.invokeStats);
  bridge._ipcCmdAckInstalled = true;
  assert.strictEqual(bridge.rendererIpc._ipcCmdAckInstalled, true);

  // InboundPipeline state ownership
  assert.strictEqual(bridge._groupListCache, bridge.inboundPipeline._groupListCache);
  assert.strictEqual(bridge._qrCodeWaiters, bridge.inboundPipeline._qrCodeWaiters);
  assert.strictEqual(bridge._richMediaWaiters, bridge.inboundPipeline._richMediaWaiters);

  // OutboundPipeline state ownership
  assert.strictEqual(bridge.rateLimiter, null);
  assert.strictEqual(bridge.outboundPipeline.rateLimiter, null);

  // ServerRuntime state ownership
  assert.strictEqual(bridge._httpServers, bridge.serverRuntime._httpServers);
  assert.strictEqual(bridge._wsServers, bridge.serverRuntime._wsServers);
  assert.strictEqual(bridge._webhookQueue, bridge.serverRuntime._webhookQueue);
  assert.strictEqual(bridge.webhookStats, bridge.serverRuntime.webhookStats);
  assert.strictEqual(bridge.listenErrors, bridge.serverRuntime.listenErrors);
});

test("Composed subsystems delegate cleanly end-to-end (capture, renderer IPC revival, inbound, outbound, serverRuntime)", async () => {
  const bridge = new mainMod.NtqqOneBotBridge({
    config: makeConfig({
      rateLimit: {
        enabled: true,
        globalPerSec: 1,
        globalBurst: 1,
        perPeerPerSec: 1,
        perPeerBurst: 1,
      },
    }),
  });

  try {
    // 1. NtCaptureController delegation
    bridge._updateSelfIdentity({ uin: "22334455", uid: "u_22334455", nick: "RosmontisTest" });
    assert.strictEqual(bridge.selfUin, "22334455");
    assert.strictEqual(bridge.selfUid, "u_22334455");
    assert.strictEqual(bridge.selfNickname, "RosmontisTest");

    // 2. RendererIpcController delegation + reviveBridgePayload parity (Uint8Array, Buffer, Map, __proto__)
    const rawBuf = Buffer.from([10, 20, 30]);
    const rawPayload = JSON.parse(
      '{"bytes":{"__rosmontisUint8Array__":[1,2,3]},"nested":{"__rosmontisMap__":[[1,{"__rosmontisUint8Array__":[4,5]}]],"extra":{"__rosmontisVoid__":true}},"__proto__":{"polluted":true}}'
    );
    const revived = bridge._reviveBridgeResult(rawPayload);
    assert.ok(revived.bytes instanceof Uint8Array);
    assert.deepStrictEqual(Array.from(revived.bytes), [1, 2, 3]);
    assert.ok(revived.nested instanceof Map || typeof revived.nested === "object");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(revived, "__proto__"), true);
    assert.strictEqual(/** @type {any} */ ({}).polluted, undefined);
    assert.strictEqual(bridge._reviveBridgeResult(rawBuf), rawBuf);

    // Direct serialized Map containing encoded Uint8Array
    const serializedMapWithBytes = bridge._reviveBridgeResult({
      __rosmontisMap__: [["k1", { __rosmontisUint8Array__: [7, 8, 9] }]],
    });
    assert.ok(serializedMapWithBytes instanceof Map);
    const mapBytes = serializedMapWithBytes.get("k1");
    assert.ok(mapBytes instanceof Uint8Array);
    assert.deepStrictEqual(Array.from(mapBytes), [7, 8, 9]);

    // 3. InboundPipeline delegation
    await bridge._handleKernelEvent("nodeIKernelGroupListener", "onGroupListUpdate", [
      0,
      [{ groupCode: "99887766", groupName: "Composed Group" }],
    ]);
    assert.strictEqual(bridge.inboundPipeline._groupListCache.has("99887766"), true);
    assert.strictEqual(bridge._groupListCache.get("99887766")?.groupName, "Composed Group");

    // 4. OutboundPipeline delegation (rate limit lazy init + 1429 rejection)
    bridge._enforceOutboundRateLimit("2:99887766:");
    assert.ok(bridge.outboundPipeline.rateLimiter);
    assert.strictEqual(bridge.rateLimiter, bridge.outboundPipeline.rateLimiter);
    assert.throws(
      () => bridge._enforceOutboundRateLimit("2:99887766:"),
      (/** @type {any} */ err) => err && err.retcode === 1429 && err.code === "ERR_RATE_LIMITED"
    );

    // 5. ServerRuntime delegation (startServers + reloadConfig + stopServers)
    await bridge.startServers();
    const reloadRes = await bridge.reloadConfig({
      config: makeConfig({
        httpServers: [{ host: "127.0.0.1", port: 0 }],
      }),
    });
    assert.strictEqual(reloadRes.reloaded, true);
    assert.strictEqual(reloadRes.network_restarted, true);
    assert.strictEqual(bridge.serverRuntime._httpServers.length, 1);
    assert.strictEqual(bridge._httpServers.length, 1);
  } finally {
    await bridge.stopServers();
  }
  assert.strictEqual(bridge.serverRuntime._httpServers.length, 0);
});

test("Legacy *Mixin exports remain backward compatible for standalone plain-object hosts", async () => {
  // ntCaptureMixin
  const captureHost = Object.assign(
    {
      config: { keepMapHook: true },
      capturedServices: { ntApi: null, ntApiContainer: null, ntStore: null, wrapperSession: null },
    },
    ntCaptureMixin
  );
  const fakeNtApi = { "nodeIKernelMsgService/sendMsg": async () => ({ result: 0 }) };
  captureHost._inspectMapEntry(new Map(), "ntApi", fakeNtApi);
  assert.strictEqual(captureHost.capturedServices.ntApi, fakeNtApi);

  // rendererIpcMixin
  const ipcHost = Object.assign(
    {
      config: { quietLogs: true },
      rendererExecute: async (/** @type {string} */ cmd) => ({ ok: true, cmd }),
      capturedServices: {},
    },
    rendererIpcMixin
  );
  const ipcRes = await ipcHost.invokeNt("nodeIKernelMsgService/getMsgsIncludeSelf", {});
  assert.deepStrictEqual(ipcRes, { ok: true, cmd: "nodeIKernelMsgService/getMsgsIncludeSelf" });
  assert.strictEqual(ipcHost.invokeStats.tier1, 1);

  // inboundPipelineMixin
  const inboundHost = Object.assign(
    {
      config: { quietLogs: true },
      selfUin: "10001",
      online: false,
    },
    inboundPipelineMixin
  );
  await inboundHost._handleKernelEvent("nodeIKernelGroupListener", "onGroupListUpdate", [
    0,
    [{ groupCode: "556677", groupName: "Legacy Mixin Group" }],
  ]);
  assert.strictEqual(inboundHost._groupListCache.get("556677")?.groupName, "Legacy Mixin Group");

  // outboundPipelineMixin
  const outboundHost = Object.assign(
    {
      config: { maxMediaBytes: 12345, allowPrivateUrls: true },
    },
    outboundPipelineMixin
  );
  const secOpts = outboundHost._mediaSecurityOptions();
  assert.strictEqual(secOpts.maxMediaBytes, 12345);
  assert.strictEqual(secOpts.allowPrivateUrls, true);

  // serverRuntimeMixin
  const serverHost = Object.assign(
    {
      config: makeConfig(),
      online: true,
      selfUin: "10001",
    },
    serverRuntimeMixin
  );
  const readiness = serverHost._computeReadiness();
  assert.strictEqual(readiness.ready, true);
  assert.strictEqual(readiness.self_id, 10001);
});
