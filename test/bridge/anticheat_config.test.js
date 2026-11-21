"use strict";

/**
 * Anti-cheat hardening, causal read/typing order, config isolation, resource hygiene & Map.prototype.set hook release
 * Migrated from test/test_bridge.js sections: 6, 11.
 */

const test = require("node:test");
const assert = require("assert");
const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");
const { onebot, rendererMod, mainMod } = require("./_helpers");
// === Section 6: Testing Anti-Cheat Hardening, Causal Order, Config Isolation & Resource Hygiene ===

test("bridge_renderer.js generates native RFC 4122 v4 UUID callbackIds without rosmontis_cb_ prefix and prevents duplicate listeners on reattachListeners()", async () => {
  const sentIpcFrames = [];
  const forwardedEvents = [];
  const channelListeners = new Map();

  const fakeIpcRenderer = {
    send(channel, metaOrPayload, data) {
      if (channel === "__ROSMONTIS_BRIDGE_EVENT__") {
        forwardedEvents.push({ channel, data: metaOrPayload });
        return;
      }
      sentIpcFrames.push({ channel, meta: metaOrPayload, data });
      if (metaOrPayload && metaOrPayload.callbackId) {
        const listeners = channelListeners.get(`RM_IPCFROM_MAIN${metaOrPayload.peerId || 1}`) || [];
        setImmediate(() => {
          for (const fn of [...listeners]) {
            fn(
              {},
              {
                callbackId: metaOrPayload.callbackId,
                promiseStatue: "full",
                type: "response",
                eventName: "ntApi",
                peerId: metaOrPayload.peerId || 1,
              },
              { result: 0 }
            );
          }
        });
      }
    },
    on(channel, listener) {
      if (!channelListeners.has(channel)) channelListeners.set(channel, []);
      channelListeners.get(channel).push(listener);
    },
    removeListener(channel, listener) {
      const list = channelListeners.get(channel);
      if (!list) return;
      const idx = list.indexOf(listener);
      if (idx !== -1) list.splice(idx, 1);
    },
  };

  const fakeWin = {
    webContentId: 1,
    ipcRenderer: fakeIpcRenderer,
    document: { querySelector: () => null },
  };

  const rBridge = rendererMod.installRendererBridge(fakeWin, {
    forceReinstall: true,
    autoRegisterListeners: false,
  });

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const sampleCbId = rBridge.makeCallbackId();
  assert.ok(!sampleCbId.startsWith("rosmontis_cb_"), `callbackId must not start with rosmontis_cb_: ${sampleCbId}`);
  assert.ok(uuidRegex.test(sampleCbId), `callbackId must be RFC 4122 v4 UUID: ${sampleCbId}`);

  await rBridge.invokeNtApi("nodeIKernelMsgService/setFocusOnBase", [
    {
      peer: { chatType: 1, peerUid: "u_1", guildId: "" },
      chatType: 1,
      peerUid: "u_1",
      guildId: "",
    },
    null,
  ]);
  assert.strictEqual(sentIpcFrames.length, 1);
  const frameCbId = sentIpcFrames[0].meta.callbackId;
  assert.ok(!frameCbId.startsWith("rosmontis_cb_"));
  assert.ok(uuidRegex.test(frameCbId));

  // Call reattachListeners() multiple times and verify RM_IPCFROM_MAIN1 only has 1 listener
  rBridge.reattachListeners();
  rBridge.reattachListeners();
  rBridge.reattachListeners();

  const main1Listeners = channelListeners.get("RM_IPCFROM_MAIN1") || [];
  assert.strictEqual(main1Listeners.length, 1, "reattachListeners() must not duplicate handleIncomingMainIpc");
  assert.strictEqual(
    (channelListeners.get("RM_IPCFROM_MAIN3") || []).length,
    0,
    "Should only attach windowId 1 and fallback 2, not 3"
  );

  for (const fn of main1Listeners) {
    fn(
      {},
      { eventName: "ntApi", peerId: 1 },
      { cmdName: "nodeIKernelMsgListener/onRecvMsg", cmdType: "event", payload: [{ msgId: "9901" }] }
    );
  }
  assert.strictEqual(forwardedEvents.length, 1, "Incoming event must be forwarded exactly once");
});

test("set_input_status marks read before sendShowInputStatusReq and send_private_msg/send_msg skips 0ms sendShowInputStatusReq", async () => {
  const callOrder = [];
  const controller = new mainMod.NtqqOneBotBridge({
    selfUin: "100010001",
    selfUid: "u_rosmontis_self",
    config: {
      selfUin: "100010001",
      httpServers: [],
      wsServers: [],
      wsClients: [],
      humanSimulation: true,
      dedupeWindowMs: 5000,
    },
  });
  controller.uinUidStore.record("100020002", "u_uid_100020002");
  controller.uinUidStore.record("100030003", "u_uid_100030003");

  controller.capturedServices.ntApi = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== "string" || !prop.includes("/")) return undefined;
        return async (payload) => {
          callOrder.push({ cmd: prop, payload });
          return { result: 0, errMsg: "", msgId: "7600000000000000001" };
        };
      },
    }
  );

  try {
    // 1. Trigger set_input_status (event_type: 1): setFocusOnBase -> enterOrExitAio(1) -> setMsgRead -> sendShowInputStatusReq
    const statusResp = await controller.handleOneBotAction("set_input_status", {
      user_id: 100020002,
      event_type: 1,
    });
    assert.strictEqual(statusResp.status, "ok");

    const cmdsAfterTyping = callOrder.map((c) => c.cmd);
    const focusIdx = cmdsAfterTyping.indexOf("nodeIKernelMsgService/setFocusOnBase");
    const enterIdx = cmdsAfterTyping.indexOf("nodeIKernelMsgService/enterOrExitAio");
    const readIdx = cmdsAfterTyping.indexOf("nodeIKernelMsgService/setMsgRead");
    const typingIdx = cmdsAfterTyping.indexOf("nodeIKernelMsgService/sendShowInputStatusReq");
    assert.strictEqual(
      cmdsAfterTyping.includes("nodeIKernelMsgService/addActiveChatByUid"),
      false,
      "addActiveChatByUid does not exist in QQNT and must never be called"
    );
    assert.ok(focusIdx >= 0 && focusIdx < enterIdx, "setFocusOnBase must precede enterOrExitAio");
    assert.ok(enterIdx >= 0 && enterIdx < readIdx, "enterOrExitAio must precede setMsgRead");
    assert.ok(readIdx >= 0 && readIdx < typingIdx, "setMsgRead must precede sendShowInputStatusReq");

    // 2. Immediately send_private_msg -> already in AIO & read deduplicated, NO 0ms sendShowInputStatusReq before sendMsg!
    callOrder.length = 0;
    const sendResp = await controller.handleOneBotAction("send_private_msg", {
      user_id: 100020002,
      message: "你好博士",
    });
    assert.strictEqual(sendResp.status, "ok");

    const cmdsAfterSend = callOrder.map((c) => c.cmd);
    assert.strictEqual(
      cmdsAfterSend.includes("nodeIKernelMsgService/setMsgRead"),
      false,
      "setMsgRead must be deduplicated within the 5s window after set_input_status already marked read"
    );
    assert.strictEqual(
      cmdsAfterSend.includes("nodeIKernelMsgService/sendShowInputStatusReq"),
      false,
      "send_private_msg must NOT emit a 0ms sendShowInputStatusReq right before sendMsg"
    );
    assert.deepStrictEqual(cmdsAfterSend, ["nodeIKernelMsgService/sendMsg"]);

    // 3. Direct send_msg to a fresh private peer activates AIO + marks read WITHOUT 0ms sendShowInputStatusReq
    callOrder.length = 0;
    const directMsgResp = await controller.handleOneBotAction("send_msg", {
      message_type: "private",
      user_id: 100030003,
      message: "直接回复",
    });
    assert.strictEqual(directMsgResp.status, "ok");
    const cmdsDirect = callOrder.map((c) => c.cmd);
    assert.deepStrictEqual(cmdsDirect, [
      "nodeIKernelMsgService/enterOrExitAio",
      "nodeIKernelMsgService/enterOrExitAio",
      "nodeIKernelMsgService/setMsgRead",
      "nodeIKernelMsgService/sendMsg",
    ]);
  } finally {
    await controller.stopServers();
  }
});

test("mark_msg_as_read & mark_group_msg_as_read resolve group/private peers even when message_id is absent from MessageIdStore", async () => {
  const readPeers = [];
  const controller = new mainMod.NtqqOneBotBridge({
    selfUin: "100010001",
    selfUid: "u_rosmontis_self",
    config: {
      selfUin: "100010001",
      httpServers: [],
      wsServers: [],
      wsClients: [],
      humanSimulation: true,
      dedupeWindowMs: 0,
    },
  });
  controller.uinUidStore.record("100020002", "u_uid_100020002");
  controller.capturedServices.ntApi = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== "string" || !prop.includes("/")) return undefined;
        return async (payload) => {
          if (prop === "nodeIKernelMsgService/setMsgRead") {
            readPeers.push(payload.peer);
          }
          return { result: 0, errMsg: "" };
        };
      },
    }
  );

  // 1. mark_msg_as_read with unknown message_id + group_id
  await controller.handleOneBotAction("mark_msg_as_read", {
    message_id: 99999991,
    group_id: 654321,
  });
  assert.strictEqual(readPeers.length, 1);
  assert.deepStrictEqual(readPeers[0], { chatType: 2, peerUid: "654321", guildId: "" });

  // 2. mark_group_msg_as_read with target_id only
  await controller.handleOneBotAction("mark_group_msg_as_read", {
    target_id: 777888,
  });
  assert.strictEqual(readPeers.length, 2);
  assert.deepStrictEqual(readPeers[1], { chatType: 2, peerUid: "777888", guildId: "" });

  // 3. mark_msg_as_read with unknown message_id + user_id
  await controller.handleOneBotAction("mark_msg_as_read", {
    message_id: 99999992,
    user_id: 100020002,
  });
  assert.strictEqual(readPeers.length, 3);
  assert.deepStrictEqual(readPeers[2], { chatType: 1, peerUid: "u_uid_100020002", guildId: "" });
});

test("loadBridgeConfig supports onebot_sandbox.json, honors empty wsClients: [], filters disabled entries, and isolates multiple account files", () => {
  const tmpCfgDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "rosmontis_cfg_test_"));
  const savedEnv = { ...process.env };
  try {
    delete process.env.ROSMONTIS_HTTP_PORT;
    delete process.env.ROSMONTIS_WS_PORT;
    delete process.env.ROSMONTIS_REVERSE_WS_URL;
    delete process.env.ROSMONTIS_DISABLE_DEFAULT_WS;
    delete process.env.ONEBOT_SELF_ID;
    delete process.env.ROSMONTIS_SELF_ID;

    // Case A: onebot_sandbox.json with empty wsClients: [] and a disabled httpServer
    const sandboxFile = path.join(tmpCfgDir, "onebot_sandbox.json");
    fs.writeFileSync(
      sandboxFile,
      JSON.stringify({
        networks: {
          httpServers: [
            { enable: true, host: "127.0.0.1", port: 13000, accessToken: "" },
            { enable: false, host: "127.0.0.1", port: 13999, accessToken: "" },
          ],
          wsServers: [{ enable: true, host: "127.0.0.1", port: 13001, accessToken: "" }],
          wsClients: [],
        },
      }),
      "utf8"
    );

    const cfgSandbox = mainMod.loadBridgeConfig(tmpCfgDir);
    assert.strictEqual(cfgSandbox.selfUin, "", "Non-numeric suffix 'sandbox' must not populate selfUin");
    assert.strictEqual(cfgSandbox.httpServers.length, 1, "Disabled httpServer must be filtered out");
    assert.strictEqual(cfgSandbox.httpServers[0].port, 13000);
    assert.strictEqual(
      cfgSandbox.wsClients.length,
      0,
      "Explicitly empty wsClients: [] in config file must NOT inject ws://127.0.0.1:8080/onebot/v11/ws"
    );

    // Case B: Two account files in the same dir -> must NOT merge servers from both files
    fs.unlinkSync(sandboxFile);
    fs.writeFileSync(
      path.join(tmpCfgDir, "onebot_111111.json"),
      JSON.stringify({
        networks: {
          httpServers: [{ enable: true, host: "127.0.0.1", port: 3000 }],
          wsServers: [],
          wsClients: [],
        },
      }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmpCfgDir, "onebot_222222.json"),
      JSON.stringify({
        networks: {
          httpServers: [{ enable: true, host: "127.0.0.1", port: 4000 }],
          wsServers: [],
          wsClients: [{ enable: true, url: "ws://127.0.0.1:8080/onebot/v11/ws" }],
        },
      }),
      "utf8"
    );

    const cfgMulti = mainMod.loadBridgeConfig(tmpCfgDir);
    assert.strictEqual(cfgMulti.selfUin, "222222");
    assert.strictEqual(
      cfgMulti.httpServers.length,
      1,
      "loadBridgeConfig must load only from bestEntry and never merge ports from multiple account files"
    );
    assert.strictEqual(cfgMulti.httpServers[0].port, 4000);
    assert.strictEqual(cfgMulti.wsClients.length, 1);
  } finally {
    process.env = savedEnv;
    fs.rmSync(tmpCfgDir, { recursive: true, force: true });
  }
});

test("Dynamic User-Agent, temp file cleanup, multi-window activeWebContents contention, and onAddSendMsg deduplication", async () => {
  const ua = onebot.buildNtqqUserAgent();
  assert.ok(ua.includes("QQ/3.2.32-52194"), `Expected dynamic QQ version in User-Agent, got: ${ua}`);
  assert.ok(!ua.includes("QQ/3.2.26"), "User-Agent must not contain hardcoded outdated QQ/3.2.26");

  // Verify temp file creation & cleanup on send_private_msg with base64:// image
  const tmpMediaDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "rosmontis_media_test_"));
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  try {
    const { elements, cleanupCallbacks, tempFiles } = await onebot.oneBotSegmentsToNtElements(
      [{ type: "image", data: { file: `base64://${pngBase64}` } }],
      { chatType: 1, peerUid: "u_test", tempDir: tmpMediaDir }
    );
    assert.strictEqual(elements.length, 1);
    assert.strictEqual(tempFiles.length, 1);
    assert.strictEqual(cleanupCallbacks.length, 1);
    assert.ok(fs.existsSync(tempFiles[0]), "Temp file should exist before cleanup");
    for (const fn of cleanupCallbacks) fn();
    assert.ok(!fs.existsSync(tempFiles[0]), "Temp file must be unlinked after cleanupCallback");
  } finally {
    fs.rmSync(tmpMediaDir, { recursive: true, force: true });
  }

  // Verify multi-window activeWebContents protection & onAddSendMsg deduplication
  const controller = new mainMod.NtqqOneBotBridge({
    selfUin: "100010001",
    selfUid: "u_rosmontis_self",
    config: { httpServers: [], wsServers: [], wsClients: [] },
  });

  const mainWc = new EventEmitter();
  mainWc.isDestroyed = () => false;
  mainWc.getURL = () => "app://./renderer/index.html#/main/message";
  mainWc.executeJavaScript = async () => ({ ok: true });

  const devtoolsWc = new EventEmitter();
  devtoolsWc.isDestroyed = () => false;
  devtoolsWc.getURL = () => "devtools://devtools/bundled/inspector.html";
  devtoolsWc.executeJavaScript = async () => ({ ok: true });

  controller.rendererIpc._attachToWebContents(mainWc);
  assert.strictEqual(controller.activeWebContents, mainWc);

  // Auxiliary devtools window must NOT overwrite active main window
  controller.rendererIpc._attachToWebContents(devtoolsWc);
  assert.strictEqual(controller.activeWebContents, mainWc);

  // When mainWc is destroyed, activeWebContents is cleared
  mainWc.emit("destroyed");
  assert.strictEqual(controller.activeWebContents, null);

  // Verify onAddSendMsg deduplication
  let sendBroadcastCount = 0;
  controller.broadcastOneBotEvent = () => {
    sendBroadcastCount += 1;
  };
  const sampleSentMsg = {
    msgId: "7888888888888888888",
    msgSeq: "301",
    chatType: 1,
    peerUid: "u_friend_1",
    elements: [],
  };
  await controller.inboundPipeline._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [sampleSentMsg]);
  await controller.inboundPipeline._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [sampleSentMsg]);
  assert.strictEqual(sendBroadcastCount, 0);
  assert.notStrictEqual(controller.messageIdStore.getByMsgId("7888888888888888888"), null);
});

// === Section 11: Testing Map.prototype.set Capture Hook Release ===

test("Map.prototype.set hook is restored to native once ntApi/ntStore/session are captured", async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bridge = new mainMod.NtqqOneBotBridge({
    selfUin: "100010001",
    selfUid: "u_self",
    online: true,
    config: {
      httpServers: [],
      wsServers: [],
      wsClients: [],
      heartbeatIntervalMs: 0,
      mapHookReleaseDelayMs: 10,
    },
  });
  bridge.installMapPrototypeHook();
  assert.ok(!/\[native code\]/.test(Map.prototype.set.toString()), "hook should be active");
  assert.strictEqual(bridge.ntCapture._mapSetHook, Map.prototype.set);

  // Simulate 908.background.js DI registrations
  const di = new Map();
  di.set("ntApi", {
    emit: {},
    invoke: new Proxy(
      {},
      { get: (_t, prop) => (typeof prop === "string" && prop.includes("/") ? async () => ({}) : undefined) }
    ),
  });
  await sleep(30);
  assert.ok(bridge.ntCapture._mapSetHook, "must not release before ntStore/session are captured");

  const listenerMap = new Map();
  const fakeSession = { getMsgService: () => ({}), getGroupService: () => ({}) };
  const fakeNtStore = {
    emitter: new EventEmitter(),
    listenerEventEmitterMap: listenerMap,
    wrapperSession: fakeSession,
  };
  di.set(Symbol("ntStore"), [{ cache: fakeNtStore, implementationType: function NtStore() {}, type: "Singleton" }]);
  assert.strictEqual(bridge.capturedServices.ntStore, fakeNtStore);
  assert.strictEqual(bridge.capturedServices.wrapperSession, fakeSession);

  await sleep(40);
  assert.ok(/\[native code\]/.test(Map.prototype.set.toString()), "native Map.prototype.set must be restored");
  assert.ok(!("__rosmontisBridgeHooked__" in Map.prototype), "hook marker must be removed");
  assert.deepStrictEqual(
    { reason: bridge.mapHookRelease.reason, restored: bridge.mapHookRelease.restored },
    { reason: "captured", restored: true }
  );

  // Kernel listeners registered after release still reach the bridge via the instance patch
  const seen = [];
  bridge.inboundPipeline._handleKernelEvent = async (listenerName, eventName) => {
    seen.push(`${listenerName}/${eventName}`);
  };
  const lateEmitter = new EventEmitter();
  listenerMap.set("nodeIKernelMsgListener", lateEmitter);
  lateEmitter.emit("onRecvMsg", []);
  assert.deepStrictEqual(seen, ["nodeIKernelMsgListener/onRecvMsg"]);
  assert.strictEqual(listenerMap.get("nodeIKernelMsgListener"), lateEmitter);

  // Ordinary Maps no longer pass through the bridge
  const plain = new Map();
  plain.set("nodeIKernelBuddyListener", new EventEmitter());
  assert.strictEqual(seen.length, 1);

  const status = await bridge.handleOneBotAction("get_status", {});
  assert.strictEqual(status.data.bridge.map_hook_active, false);
  assert.strictEqual(status.data.bridge.map_hook_release.reason, "captured");

  // Releasing twice is a no-op
  assert.strictEqual(bridge.releaseMapPrototypeHook("again"), false);
});
