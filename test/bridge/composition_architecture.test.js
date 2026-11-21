// @ts-check
"use strict";

/**
 * Composed Subsystem Architecture, `BridgeHost` Typing & Mixin-Free Contract Tests
 */

const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { REPO_ROOT, mainMod } = require("./_helpers");

const ntCaptureMod = require(path.join(REPO_ROOT, "src", "core", "nt_capture.js"));
const rendererIpcMod = require(path.join(REPO_ROOT, "src", "core", "renderer_ipc.js"));
const inboundPipelineMod = require(path.join(REPO_ROOT, "src", "core", "inbound_pipeline.js"));
const outboundPipelineMod = require(path.join(REPO_ROOT, "src", "core", "outbound_pipeline.js"));
const serverRuntimeMod = require(path.join(REPO_ROOT, "src", "core", "server_runtime.js"));
const mediaHydratorMod = require(path.join(REPO_ROOT, "src", "core", "media_hydrator.js"));
const loginRecoveryMod = require(path.join(REPO_ROOT, "src", "core", "login_recovery.js"));

const { NtCaptureController } = ntCaptureMod;
const { RendererIpcController, getRendererBridgeSource } = rendererIpcMod;
const { InboundPipeline } = inboundPipelineMod;
const { OutboundPipeline } = outboundPipelineMod;
const { ServerRuntime } = serverRuntimeMod;
const { MediaHydrator } = mediaHydratorMod;
const { LoginRecovery } = loginRecoveryMod;

/**
 * @param {Partial<import("../../src/types").BridgeConfig>} [overrides]
 * @returns {import("../../src/types").BridgeConfig}
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

test("NtqqOneBotBridge is a lean composition coordinator with zero private _xxx state pass-throughs or legacy *Mixin exports", () => {
  const bridgeMainPath = path.join(REPO_ROOT, "src", "bridge_main.js");
  const bridgeMainSrc = fs.readFileSync(bridgeMainPath, "utf8");
  const bridgeMainLines = bridgeMainSrc.split(/\r?\n/).length;

  assert.strictEqual(
    /Object\.assign\s*\(\s*NtqqOneBotBridge\.prototype/.test(bridgeMainSrc),
    false,
    "src/bridge_main.js must not dump mixins onto NtqqOneBotBridge.prototype via Object.assign"
  );
  assert.strictEqual(
    /\b(?:get|set)\s+_[A-Za-z0-9_$]*\s*\(/.test(bridgeMainSrc),
    false,
    "src/bridge_main.js must have zero private get _* / set _* state pass-throughs"
  );
  assert.ok(
    bridgeMainLines < 450,
    `Expected lean src/bridge_main.js (< 450 lines), got ${bridgeMainLines} lines`
  );

  // Runtime descriptor check on NtqqOneBotBridge.prototype
  const protoDescs = Object.getOwnPropertyDescriptors(mainMod.NtqqOneBotBridge.prototype);
  for (const [propName, desc] of Object.entries(protoDescs)) {
    if (propName.startsWith("_")) {
      assert.strictEqual(
        typeof desc.get === "function" || typeof desc.set === "function",
        false,
        `NtqqOneBotBridge.prototype.${propName} must not be a private state getter/setter facade`
      );
    }
  }

  // Verify all 5 controllers + 2 helper modules export zero *Mixin objects and zero _resolveLegacy* helpers
  const subsystemEntries = [
    { rel: "src/core/nt_capture.js", mod: ntCaptureMod, forbidden: ["ntCaptureMixin"] },
    { rel: "src/core/renderer_ipc.js", mod: rendererIpcMod, forbidden: ["rendererIpcMixin"] },
    {
      rel: "src/core/inbound_pipeline.js",
      mod: inboundPipelineMod,
      forbidden: ["inboundPipelineMixin", "mediaHydratorMixin", "loginRecoveryMixin"],
    },
    { rel: "src/core/outbound_pipeline.js", mod: outboundPipelineMod, forbidden: ["outboundPipelineMixin"] },
    { rel: "src/core/server_runtime.js", mod: serverRuntimeMod, forbidden: ["serverRuntimeMixin"] },
    { rel: "src/core/media_hydrator.js", mod: mediaHydratorMod, forbidden: ["mediaHydratorMixin"] },
    { rel: "src/core/login_recovery.js", mod: loginRecoveryMod, forbidden: ["loginRecoveryMixin"] },
  ];

  for (const { rel, mod, forbidden } of subsystemEntries) {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    const firstLine = src.split(/\r?\n/)[0].trim();
    assert.strictEqual(firstLine, "// @ts-check", `${rel} must enable // @ts-check`);
    assert.strictEqual(
      src.includes("_resolveLegacy"),
      false,
      `${rel} must not retain _resolveLegacy* adapter helpers`
    );
    for (const key of Object.keys(mod)) {
      assert.strictEqual(
        key.endsWith("Mixin"),
        false,
        `${rel} must not export legacy mixin '${key}'`
      );
    }
    for (const name of forbidden) {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(mod, name),
        false,
        `${rel} must not export ${name}`
      );
    }
  }

  // Verify BridgeHost contract is defined in src/types.js and used across all 5 controllers
  const typesSrc = fs.readFileSync(path.join(REPO_ROOT, "src", "types.js"), "utf8");
  assert.strictEqual(typesSrc.split(/\r?\n/)[0].trim(), "// @ts-check");
  assert.match(typesSrc, /@typedef\s+\{[^}]+\}\s+BridgeHost\b/, "src/types.js must define BridgeHost");
  assert.strictEqual(
    /@typedef\s+\{\s*any\s*\}\s+BridgeHost\b/.test(typesSrc),
    false,
    "BridgeHost in src/types.js must not be untyped any"
  );

  for (const ctrlRel of [
    "src/core/nt_capture.js",
    "src/core/renderer_ipc.js",
    "src/core/inbound_pipeline.js",
    "src/core/outbound_pipeline.js",
    "src/core/server_runtime.js",
  ]) {
    const ctrlSrc = fs.readFileSync(path.join(REPO_ROOT, ctrlRel), "utf8");
    assert.match(
      ctrlSrc,
      /import\("\.\.\/types"\)\.BridgeHost/,
      `${ctrlRel} must type its host reference with BridgeHost from ../types`
    );
  }
});

test("Subsystem state lives exclusively on composed controller instances and getRendererBridgeSource is standalone", () => {
  const bridge = new mainMod.NtqqOneBotBridge({ config: makeConfig() });

  assert.ok(bridge.ntCapture instanceof NtCaptureController);
  assert.ok(bridge.rendererIpc instanceof RendererIpcController);
  assert.ok(bridge.inboundPipeline instanceof InboundPipeline);
  assert.ok(bridge.outboundPipeline instanceof OutboundPipeline);
  assert.ok(bridge.serverRuntime instanceof ServerRuntime);
  assert.ok(bridge.inboundPipeline.mediaHydrator instanceof MediaHydrator);
  assert.ok(bridge.inboundPipeline.loginRecovery instanceof LoginRecovery);

  assert.strictEqual(bridge.ntCapture.bridge, bridge);
  assert.strictEqual(bridge.rendererIpc.bridge, bridge);
  assert.strictEqual(bridge.inboundPipeline.bridge, bridge);
  assert.strictEqual(bridge.outboundPipeline.bridge, bridge);
  assert.strictEqual(bridge.serverRuntime.bridge, bridge);

  // Private state lives on controllers (not exposed as bridge._* pass-throughs)
  assert.strictEqual(/** @type {any} */ (bridge)._mapSetHook, undefined);
  assert.strictEqual(/** @type {any} */ (bridge)._knownWebContents, undefined);
  assert.strictEqual(/** @type {any} */ (bridge)._groupListCache, undefined);
  assert.strictEqual(/** @type {any} */ (bridge)._httpServers, undefined);

  assert.ok(bridge.ntCapture._attachedEmitters instanceof WeakSet);
  assert.ok(bridge.rendererIpc._knownWebContents instanceof Set);
  assert.ok(bridge.rendererIpc._pendingRendererCmds instanceof Map);
  assert.strictEqual(typeof bridge.rendererIpc._ipcAuthToken, "string");
  assert.ok(bridge.inboundPipeline._groupListCache instanceof Map);
  assert.ok(bridge.inboundPipeline._qrCodeWaiters instanceof Set);
  assert.ok(bridge.inboundPipeline._richMediaWaiters instanceof Map);
  assert.ok(Array.isArray(bridge.serverRuntime._httpServers));
  assert.ok(Array.isArray(bridge.serverRuntime._wsServers));

  // Public telemetry/transport getters & logger wiring remain synchronized
  assert.strictEqual(bridge.invokeStats, bridge.rendererIpc.invokeStats);
  assert.strictEqual(bridge.sendEchoStats, bridge.echoCorrelator.stats);
  assert.strictEqual(bridge.webhookStats, bridge.serverRuntime.webhookStats);
  assert.strictEqual(bridge.listenErrors, bridge.serverRuntime.listenErrors);
  assert.strictEqual(bridge.wsClients, bridge.serverRuntime._wsServerClients);
  assert.strictEqual(bridge.reverseWsClients, bridge.serverRuntime._reverseWsClients);
  assert.strictEqual(bridge.messageIdStore._logger, bridge.logger);
  assert.strictEqual(bridge.uinUidStore._logger, bridge.logger);
  assert.strictEqual(bridge.sessionController.logger, bridge.logger);
  assert.strictEqual(bridge.sessionController.scheduler._logger, bridge.logger);

  // getRendererBridgeSource() injects wire_codec inline so BrowserWindow VM execution needs zero require()
  const rendererSrc = getRendererBridgeSource();
  assert.ok(rendererSrc.length > 0, "getRendererBridgeSource() must return non-empty script");
  assert.strictEqual(
    rendererSrc.includes("/* __ROSMONTIS_WIRE_CODEC_INJECT__ */"),
    false,
    "Wire codec injection marker must be replaced in getRendererBridgeSource()"
  );
  /** @type {Record<string, any>} */
  const sandbox = { window: {}, module: { exports: {} } };
  sandbox.globalThis = sandbox.window;
  vm.runInNewContext(rendererSrc, sandbox);
  assert.strictEqual(
    typeof sandbox.installRendererBridge,
    "function",
    "getRendererBridgeSource() must execute standalone with require === undefined"
  );
  const installed = sandbox.installRendererBridge(sandbox.window, {
    windowId: 7,
    autoRegisterListeners: false,
  });
  assert.ok(installed && typeof installed.invokeNtApiSerialized === "function");
  const encodedJson = sandbox.module.exports.serializeBridgePayload({
    m: new Map([["k", new Uint8Array([9, 8, 7])]]),
  });
  const revived = sandbox.module.exports.reviveBridgePayload(JSON.parse(encodedJson));
  assert.ok(revived.m instanceof Map || typeof revived.m.get === "function");
  assert.deepStrictEqual(Array.from(revived.m.get("k")), [9, 8, 7]);
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
    // 1. NtCaptureController
    bridge.ntCapture._updateSelfIdentity({ uin: "22334455", uid: "u_22334455", nick: "RosmontisTest" });
    assert.strictEqual(bridge.selfUin, "22334455");
    assert.strictEqual(bridge.selfUid, "u_22334455");
    assert.strictEqual(bridge.selfNickname, "RosmontisTest");

    // 2. RendererIpcController + reviveBridgePayload parity (Uint8Array, Buffer, Map, __proto__)
    const rawBuf = Buffer.from([10, 20, 30]);
    const rawPayload = JSON.parse(
      '{"bytes":{"__rosmontisUint8Array__":[1,2,3]},"nested":{"__rosmontisMap__":[[1,{"__rosmontisUint8Array__":[4,5]}]],"extra":{"__rosmontisVoid__":true}},"__proto__":{"polluted":true}}'
    );
    const revived = bridge.rendererIpc._reviveBridgeResult(rawPayload);
    assert.ok(revived.bytes instanceof Uint8Array);
    assert.deepStrictEqual(Array.from(revived.bytes), [1, 2, 3]);
    assert.ok(revived.nested instanceof Map || typeof revived.nested === "object");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(revived, "__proto__"), true);
    assert.strictEqual(/** @type {any} */ ({}).polluted, undefined);
    assert.strictEqual(bridge.rendererIpc._reviveBridgeResult(rawBuf), rawBuf);

    const serializedMapWithBytes = bridge.rendererIpc._reviveBridgeResult({
      __rosmontisMap__: [["k1", { __rosmontisUint8Array__: [7, 8, 9] }]],
    });
    assert.ok(serializedMapWithBytes instanceof Map);
    const mapBytes = serializedMapWithBytes.get("k1");
    assert.ok(mapBytes instanceof Uint8Array);
    assert.deepStrictEqual(Array.from(mapBytes), [7, 8, 9]);

    // 3. InboundPipeline
    await bridge.inboundPipeline._handleKernelEvent("nodeIKernelGroupListener", "onGroupListUpdate", [
      0,
      [{ groupCode: "99887766", groupName: "Composed Group" }],
    ]);
    assert.strictEqual(bridge.inboundPipeline._groupListCache.has("99887766"), true);
    assert.strictEqual(bridge.inboundPipeline._groupListCache.get("99887766")?.groupName, "Composed Group");

    // 4. OutboundPipeline (rate limit lazy init + 1429 rejection)
    bridge.outboundPipeline._enforceOutboundRateLimit("2:99887766:");
    assert.ok(bridge.outboundPipeline.rateLimiter);
    assert.strictEqual(bridge.rateLimiter, bridge.outboundPipeline.rateLimiter);
    assert.throws(
      () => bridge.outboundPipeline._enforceOutboundRateLimit("2:99887766:"),
      (/** @type {any} */ err) => err && err.retcode === 1429 && err.code === "ERR_RATE_LIMITED"
    );

    // 5. ServerRuntime (startServers + reloadConfig + stopServers)
    await bridge.startServers();
    const reloadRes = await bridge.reloadConfig({
      config: makeConfig({
        httpServers: [{ host: "127.0.0.1", port: 0 }],
      }),
    });
    assert.strictEqual(reloadRes.reloaded, true);
    assert.strictEqual(reloadRes.network_restarted, true);
    assert.strictEqual(bridge.serverRuntime._httpServers.length, 1);
  } finally {
    await bridge.stopServers();
  }
  assert.strictEqual(bridge.serverRuntime._httpServers.length, 0);
});

test("Controllers instantiate cleanly on standalone Partial<BridgeHost> unit-test mocks", async () => {
  // NtCaptureController
  /** @type {Partial<import("../../src/types").BridgeHost>} */
  const captureHost = {
    config: { keepMapHook: true },
    capturedServices: { ntApi: null, ntApiContainer: null, ntStore: null, wrapperSession: null },
  };
  const ntCapture = new NtCaptureController(captureHost);
  const fakeNtApi = { "nodeIKernelMsgService/sendMsg": async () => ({ result: 0 }) };
  ntCapture._inspectMapEntry(new Map(), "ntApi", fakeNtApi);
  assert.strictEqual(captureHost.capturedServices?.ntApi, fakeNtApi);

  // RendererIpcController
  const rendererIpc = new RendererIpcController({
    config: { quietLogs: true },
    rendererExecute: async (/** @type {string} */ cmd) => ({ ok: true, cmd }),
    capturedServices: {},
  });
  const ipcRes = await rendererIpc.invokeNt("nodeIKernelMsgService/getMsgsIncludeSelf", {});
  assert.deepStrictEqual(ipcRes, { ok: true, cmd: "nodeIKernelMsgService/getMsgsIncludeSelf" });
  assert.strictEqual(rendererIpc.invokeStats.tier1, 1);

  // InboundPipeline
  const inbound = new InboundPipeline({
    config: { quietLogs: true },
    selfUin: "10001",
    online: false,
  });
  await inbound._handleKernelEvent("nodeIKernelGroupListener", "onGroupListUpdate", [
    0,
    [{ groupCode: "556677", groupName: "Standalone Controller Group" }],
  ]);
  assert.strictEqual(inbound._groupListCache.get("556677")?.groupName, "Standalone Controller Group");

  // OutboundPipeline
  const outbound = new OutboundPipeline({
    config: { maxMediaBytes: 12345, allowPrivateUrls: true },
  });
  const secOpts = outbound._mediaSecurityOptions();
  assert.strictEqual(secOpts.maxMediaBytes, 12345);
  assert.strictEqual(secOpts.allowPrivateUrls, true);

  // ServerRuntime
  const server = new ServerRuntime({
    config: makeConfig(),
    online: true,
    selfUin: "10001",
  });
  const readiness = server._computeReadiness();
  assert.strictEqual(readiness.ready, true);
  assert.strictEqual(readiness.self_id, 10001);
});
