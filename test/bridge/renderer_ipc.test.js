"use strict";

/**
 * bridge_renderer.js window IPC, spoofing defense, structured CMD/ACK channel & Web credential gate
 * Migrated from test/test_bridge.js sections: 4, 16.
 */

const test = require("node:test");
const assert = require("assert");
const EventEmitter = require("events");
const { rendererMod, mainMod } = require("./_helpers");
// === Section 4: Testing bridge_renderer.js in Simulated Window Environment ===

test("bridge_renderer.js sends RM_IPCFROM_RENDERER frames, handles promiseStatue, deduplicates session state, and forwards RM_IPCFROM_MAIN", async () => {
  const sentIpcFrames = [];
  const forwardedEvents = [];
  const mainListeners = new Map();

  const fakeIpcRenderer = {
    send(channel, metaOrPayload, data) {
      if (channel === "__ROSMONTIS_BRIDGE_EVENT__") {
        forwardedEvents.push({ channel, data: metaOrPayload });
        return;
      }
      sentIpcFrames.push({ channel, meta: metaOrPayload, data });
      if (metaOrPayload && metaOrPayload.callbackId) {
        const onMain = mainListeners.get(`RM_IPCFROM_MAIN${metaOrPayload.peerId || 1}`);
        if (typeof onMain === "function") {
          setImmediate(() => {
            if (data && data.cmdName === "nodeIKernelTest/failCmd") {
              onMain(
                {},
                {
                  callbackId: metaOrPayload.callbackId,
                  promiseStatue: "err",
                  type: "response",
                  eventName: "ntApi",
                  peerId: metaOrPayload.peerId || 1,
                },
                "Simulated kernel failure"
              );
            } else {
              onMain(
                {},
                {
                  callbackId: metaOrPayload.callbackId,
                  promiseStatue: "full",
                  type: "response",
                  eventName: "ntApi",
                  peerId: metaOrPayload.peerId || 1,
                },
                { result: 0, errMsg: "", echoCmd: data?.cmdName }
              );
            }
          });
        }
      }
    },
    on(channel, listener) {
      mainListeners.set(channel, listener);
    },
  };

  const fakeWin = {
    webContentId: 1,
    location: { search: "?webcontentsid=1&tid=" },
    ipcRenderer: fakeIpcRenderer,
    document: {
      querySelector(sel) {
        if (sel === "#app") {
          return {
            __vue_app__: {
              config: {
                globalProperties: {
                  $route: { path: "/main/message" },
                  $pinia: { _s: new Map([["aio", {}], ["chat", {}]]) },
                },
              },
            },
          };
        }
        return null;
      },
    },
  };

  const rBridge = rendererMod.installRendererBridge(fakeWin, {
    forceReinstall: true,
    autoRegisterListeners: true,
  });
  assert.strictEqual(rBridge.windowId, 1);

  // Confirm ntApi-register frames were sent on init
  const registerFrames = sentIpcFrames.filter((f) => f.meta?.eventName === "ntApi-register");
  assert.ok(registerFrames.length >= 5, "Expected ntApi-register frames on init");
  sentIpcFrames.length = 0;

  const apiRes = await rBridge.invokeNtApi("nodeIKernelMsgService/sendMsg", [
    { msgId: "0", peer: { chatType: 1, peerUid: "u_test" } },
    null,
  ]);
  assert.strictEqual(apiRes.result, 0);
  assert.strictEqual(apiRes.echoCmd, "nodeIKernelMsgService/sendMsg");
  assert.strictEqual(sentIpcFrames[0].channel, "RM_IPCFROM_RENDERER1");
  assert.strictEqual(sentIpcFrames[0].meta.eventName, "ntApi");
  assert.strictEqual(sentIpcFrames[0].meta.peerId, 1);
  assert.strictEqual(sentIpcFrames[0].data.cmdName, "nodeIKernelMsgService/sendMsg");
  assert.strictEqual(sentIpcFrames[0].data.cmdType, "invoke");
  assert.ok(Array.isArray(sentIpcFrames[0].data.payload));

  // Verify promiseStatue === "err" rejects properly
  await assert.rejects(
    () => rBridge.invokeNtApi("nodeIKernelTest/failCmd", {}),
    /Simulated kernel failure/
  );

  // 1st human session flow for u_friend_1
  const simRes1 = await rBridge.simulateHumanSessionFlow({
    chatType: 1,
    peerUid: "u_friend_1",
    markRead: true,
    sendTyping: true,
  });
  assert.strictEqual(simRes1.vueState.mounted, true);
  assert.strictEqual(simRes1.alreadyInAio, false);
  assert.strictEqual(simRes1.enterOrExitAio, true);
  assert.strictEqual(simRes1.setFocusOnBase, true);
  assert.strictEqual(simRes1.markRead, true);
  assert.strictEqual(simRes1.sendTyping, true);

  // 2nd human session flow immediately for same u_friend_1 -> anti-burst deduplication
  const simRes2 = await rBridge.simulateHumanSessionFlow({
    chatType: 1,
    peerUid: "u_friend_1",
    markRead: true,
    sendTyping: true,
  });
  assert.strictEqual(simRes2.alreadyInAio, true);
  assert.strictEqual(simRes2.markRead, false);
  assert.strictEqual(simRes2.markReadSkipped, true);
  assert.strictEqual(simRes2.sendTyping, false);
  assert.strictEqual(simRes2.sendTypingSkipped, true);

  // 3rd human session flow switching to u_friend_2 -> exits u_friend_1 AIO first
  const simRes3 = await rBridge.simulateHumanSessionFlow({
    chatType: 1,
    peerUid: "u_friend_2",
    markRead: true,
    sendTyping: false,
  });
  assert.strictEqual(simRes3.exitedPreviousAio, true);
  assert.strictEqual(simRes3.enterOrExitAio, true);
  assert.strictEqual(simRes3.markRead, true);

  // Simulate incoming RM_IPCFROM_MAIN1 event (and verify O3 telemetry is untouched)
  const onMainChannel = mainListeners.get("RM_IPCFROM_MAIN1");
  assert.strictEqual(typeof onMainChannel, "function");
  onMainChannel(
    {},
    { eventName: "ntApi", peerId: 1 },
    { cmdName: "nodeIKernelMsgListener/onRecvMsg", cmdType: "event", payload: [{ msgId: "9001" }] }
  );
  assert.strictEqual(forwardedEvents.length, 1);
  assert.strictEqual(forwardedEvents[0].channel, "__ROSMONTIS_BRIDGE_EVENT__");
  assert.strictEqual(forwardedEvents[0].data.cmdName, "nodeIKernelMsgListener/onRecvMsg");
});

// === Section 16: Testing Electron IPC Spoofing Defense, Structured CMD/ACK Channel & Web Credential Gate ===

test("_isTrustedIpcEvent blocks spoofed renderer events, __ROSMONTIS_BRIDGE_CMD__ executes without per-call executeJavaScript, and all 11 WEB_CREDENTIAL_ACTIONS default to 1403", async () => {
  const vm = require("vm");
  const { WEB_CREDENTIAL_ACTIONS } = require("../../src/core/qzone_actions.js");

  // 1 & 2. _isTrustedIpcEvent spoofing checks + structured __ROSMONTIS_BRIDGE_CMD__ / __ROSMONTIS_BRIDGE_CMD_ACK__ round-trips
  {
    const ipcMainListeners = new Map();
    const ipcMainHandlers = new Map();
    const appListeners = new Map();
    const fakeElectron = {
      app: {
        on(ev, fn) {
          appListeners.set(ev, fn);
        },
      },
      ipcMain: {
        on(ch, fn) {
          ipcMainListeners.set(ch, fn);
        },
        handle(ch, fn) {
          ipcMainHandlers.set(ch, fn);
        },
      },
      webContents: {
        getAllWebContents: () => [],
      },
    };

    const bridge = new mainMod.NtqqOneBotBridge({
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
    bridge.uinUidStore.record("100020002", "u_ipc_peer");
    assert.strictEqual(bridge.installElectronHooks(fakeElectron), true);

    const mainFrameObj = { id: "frame-main" };
    const childSubFrameObj = { id: "frame-sub-iframe" };
    let currentRendererUrl = "app://./renderer/index.html#/main/message";
    let executeJsCount = 0;

    const rendererIpcListeners = new Map();
    const ntKernelCalls = [];
    let fakeWebContents = null;

    const fakeIpcRenderer = {
      on(ch, fn) {
        rendererIpcListeners.set(ch, fn);
      },
      removeListener(ch, fn) {
        if (rendererIpcListeners.get(ch) === fn) rendererIpcListeners.delete(ch);
      },
      send(ch, metaOrPayload, maybeData) {
        if (ch === "__ROSMONTIS_BRIDGE_EVENT__") {
          const onEv = ipcMainListeners.get("__ROSMONTIS_BRIDGE_EVENT__");
          if (onEv) {
            onEv({ sender: fakeWebContents, senderFrame: mainFrameObj }, metaOrPayload);
          }
          return;
        }
        if (ch === "__ROSMONTIS_BRIDGE_CMD_ACK__") {
          const onAck = ipcMainListeners.get("__ROSMONTIS_BRIDGE_CMD_ACK__");
          if (onAck) {
            onAck({ sender: fakeWebContents, senderFrame: mainFrameObj }, metaOrPayload);
          }
          return;
        }
        if (ch === "RM_IPCFROM_RENDERER1" && metaOrPayload?.eventName === "ntApi" && maybeData?.cmdType === "invoke") {
          const cmd = maybeData.cmdName;
          const arg0 = Array.isArray(maybeData.payload) ? maybeData.payload[0] : maybeData.payload;
          ntKernelCalls.push({ cmd, payload: arg0 });
          const onMain = rendererIpcListeners.get("RM_IPCFROM_MAIN1");
          if (typeof onMain === "function" && metaOrPayload.callbackId) {
            setImmediate(() => {
              let result = { result: 0, errMsg: "" };
              if (cmd === "nodeIKernelGroupService/getGroupList") {
                result = {
                  groupList: [
                    { groupCode: "777001", groupName: "IPC测试群", memberCount: 12, maxMember: 200 },
                  ],
                };
              }
              onMain(
                {},
                {
                  callbackId: metaOrPayload.callbackId,
                  promiseStatue: "full",
                  type: "response",
                  eventName: "ntApi",
                  peerId: 1,
                },
                result
              );
            });
          }
        }
      },
    };

    const fakeWindow = {
      webContentId: 1,
      location: { search: "?webcontentsid=1" },
      ipcRenderer: fakeIpcRenderer,
      document: { querySelector: () => null },
      crypto,
    };

    const wcEvents = new EventEmitter();
    fakeWebContents = Object.assign(wcEvents, {
      id: 1,
      mainFrame: mainFrameObj,
      isDestroyed: () => false,
      getURL: () => currentRendererUrl,
      send(ch, payload) {
        const fn = rendererIpcListeners.get(ch);
        if (typeof fn === "function") {
          fn({}, payload);
        }
      },
      executeJavaScript(code) {
        executeJsCount += 1;
        const sandbox = {
          window: fakeWindow,
          crypto,
          setTimeout,
          clearTimeout,
          URLSearchParams,
        };
        return Promise.resolve(vm.runInNewContext(code, sandbox));
      },
    });

    try {
      // Trigger web-contents-created + did-finish-load bootstrap injection
      appListeners.get("web-contents-created")({}, fakeWebContents);
      fakeWebContents.emit("did-finish-load");
      await new Promise((r) => setImmediate(r));

      assert.strictEqual(fakeWebContents.__rosmontisIpcTokenInjected, true);
      assert.strictEqual(fakeWebContents.__rosmontisCmdChannelReady, true);
      assert.strictEqual(executeJsCount, 1, "Bootstrap should run executeJavaScript once on load");
      // Verify ipcAuthToken is NOT exposed on window.__ROSMONTIS_RENDERER_BRIDGE__
      assert.strictEqual(fakeWindow.__ROSMONTIS_RENDERER_BRIDGE__.__ipcToken, undefined);
      assert.strictEqual(fakeWindow.__ROSMONTIS_RENDERER_BRIDGE__.ipcAuthToken, undefined);
      assert.strictEqual(
        Object.keys(fakeWindow.__ROSMONTIS_RENDERER_BRIDGE__).includes("setIpcAuthToken"),
        false
      );

      // Reset executeJsCount to prove zero per-message executeJavaScript calls afterward!
      executeJsCount = 0;

      // Structured IPC round-trip 1: invokeNt via get_group_list
      const grpResp = await bridge.handleOneBotAction("get_group_list", {});
      assert.strictEqual(grpResp.status, "ok");
      assert.strictEqual(grpResp.data.length, 1);
      assert.strictEqual(grpResp.data[0].group_id, 777001);
      assert.strictEqual(executeJsCount, 0, "invokeNt must use __ROSMONTIS_BRIDGE_CMD__ without executeJavaScript");
      assert.strictEqual(bridge.invokeStats.tier1 >= 1, true);
      assert.strictEqual(bridge.invokeStats.degraded, 0);

      // Structured IPC round-trip 2: simulateSession via set_input_status
      ntKernelCalls.length = 0;
      const typingResp = await bridge.handleOneBotAction("set_input_status", {
        user_id: 100020002,
        event_type: 1,
      });
      assert.strictEqual(typingResp.status, "ok");
      assert.strictEqual(executeJsCount, 0, "simulateSession must use __ROSMONTIS_BRIDGE_CMD__ without executeJavaScript");
      assert.deepStrictEqual(
        ntKernelCalls.map((c) => c.cmd),
        [
          "nodeIKernelMsgService/setFocusOnBase",
          "nodeIKernelMsgService/enterOrExitAio",
          "nodeIKernelMsgService/setMsgRead",
          "nodeIKernelMsgService/sendShowInputStatusReq",
        ]
      );

      // Test _isTrustedIpcEvent & __ROSMONTIS_BRIDGE_EVENT__ spoofing vectors
      const emittedEvents = [];
      bridge.on("onebot_event", (ev) => emittedEvents.push(ev));
      const onBridgeEvent = ipcMainListeners.get("__ROSMONTIS_BRIDGE_EVENT__");

      const makeFakeRecvPayload = (msgId, token) => ({
        cmdName: "nodeIKernelMsgListener/onRecvMsg",
        eventName: "ntApi",
        ...(token !== undefined ? { __ipcToken: token } : {}),
        payload: [
          [
            {
              msgId,
              msgSeq: "501",
              msgTime: "1710000000",
              chatType: 1,
              msgType: 2,
              peerUid: "u_ipc_peer",
              senderUid: "u_ipc_peer",
              senderUin: "100020002",
              sendNickName: "Doctor",
              elements: [{ elementType: 1, textElement: { content: "spoof check" } }],
            },
          ],
        ],
      });

      // Spoof 1: Unknown webContents
      const unknownWc = { id: 99, mainFrame: mainFrameObj, isDestroyed: () => false, getURL: () => currentRendererUrl };
      onBridgeEvent({ sender: unknownWc, senderFrame: mainFrameObj }, makeFakeRecvPayload("spoof_1", bridge._ipcAuthToken));

      // Spoof 2: Subframe (senderFrame !== sender.mainFrame)
      onBridgeEvent(
        { sender: fakeWebContents, senderFrame: childSubFrameObj },
        makeFakeRecvPayload("spoof_2", bridge._ipcAuthToken)
      );

      // Spoof 3: Untrusted https://evil.example URL
      currentRendererUrl = "https://evil.example/malicious.html";
      onBridgeEvent(
        { sender: fakeWebContents, senderFrame: mainFrameObj },
        makeFakeRecvPayload("spoof_3", bridge._ipcAuthToken)
      );
      currentRendererUrl = "app://./renderer/index.html#/main/message";

      // Spoof 4: Wrong or missing __ipcToken
      onBridgeEvent(
        { sender: fakeWebContents, senderFrame: mainFrameObj },
        makeFakeRecvPayload("spoof_4a", "wrong_forged_ipc_token")
      );
      onBridgeEvent(
        { sender: fakeWebContents, senderFrame: mainFrameObj },
        makeFakeRecvPayload("spoof_4b", undefined)
      );

      await new Promise((r) => setImmediate(r));
      assert.strictEqual(emittedEvents.length, 0, "All 4 spoofed IPC vectors must emit zero OneBot events");

      // Valid mainFrame event from injected renderer (via RM_IPCFROM_MAIN1 -> forwardToMain with sealed ipcAuthToken)
      rendererIpcListeners.get("RM_IPCFROM_MAIN1")(
        {},
        { eventName: "ntApi", peerId: 1 },
        {
          cmdName: "nodeIKernelMsgListener/onRecvMsg",
          cmdType: "event",
          payload: [
            [
              {
                msgId: "valid_ipc_9001",
                msgSeq: "502",
                msgTime: "1710000005",
                chatType: 1,
                msgType: 2,
                peerUid: "u_ipc_peer",
                senderUid: "u_ipc_peer",
                senderUin: "100020002",
                sendNickName: "Doctor",
                elements: [{ elementType: 1, textElement: { content: "legitimate message" } }],
              },
            ],
          ],
        }
      );
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(emittedEvents.length, 1, "Legitimate mainFrame IPC event with valid __ipcToken must be processed");
      assert.strictEqual(emittedEvents[0].raw_message, "legitimate message");
    } finally {
      await bridge.stopServers();
    }
  }

  // 3. All 11 WEB_CREDENTIAL_ACTIONS return status: "failed", retcode: 1403 by default,
  //    while get_rkey remains accessible and get_essence_msg_list / _get_group_notice fall back to NT kernel APIs
  {
    assert.strictEqual(WEB_CREDENTIAL_ACTIONS.size, 11);
    let failEssenceV2 = false;
    const calledKernelCmds = [];
    const defaultBridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_rosmontis_self",
      ntApi: new Proxy(
        {},
        {
          get(_t, prop) {
            if (typeof prop !== "string" || !prop.includes("/")) return undefined;
            return async (payload) => {
              calledKernelCmds.push(prop);
              if (prop === "nodeIKernelUnitedConfigService/loadUnitedConfig") {
                return { configData: { content: "&rkey=test_cdn_rkey_123" } };
              }
              if (prop === "nodeIKernelGroupService/fetchGroupEssenceListV2") {
                if (failEssenceV2) throw new Error("V2 unavailable on legacy build");
                return { msgList: [{ msg_seq: 88, sender_uin: "100020002" }] };
              }
              if (prop === "nodeIKernelGroupService/getGroupLatestEssenceList") {
                return { msgList: [{ msg_seq: 89, sender_uin: "100020002" }] };
              }
              if (prop === "nodeIKernelGroupService/getGroupBulletin") {
                return {
                  feeds: [{ feedId: "notice_1", msg: { text: "NT内核群公告" } }],
                };
              }
              return { result: 0, errMsg: "" };
            };
          },
        }
      ),
      config: {
        selfUin: "100010001",
        httpServers: [],
        wsServers: [],
        wsClients: [],
      },
    });

    try {
      for (const action of WEB_CREDENTIAL_ACTIONS) {
        const resp = await defaultBridge.handleOneBotAction(action, {
          domain: "qun.qq.com",
          content: "test",
          tid: "t1",
        });
        assert.strictEqual(resp.status, "failed", `Expected ${action} to fail when gated`);
        assert.strictEqual(resp.retcode, 1403, `Expected ${action} retcode === 1403, got ${resp.retcode}`);
      }

      const rkeyResp = await defaultBridge.handleOneBotAction("get_rkey", {});
      assert.strictEqual(rkeyResp.status, "ok");
      assert.strictEqual(rkeyResp.retcode, 0);
      assert.strictEqual(rkeyResp.data.rkeys.length, 2);
      assert.strictEqual(rkeyResp.data.rkeys[0].rkey, "&rkey=test_cdn_rkey_123");

      calledKernelCmds.length = 0;
      const essenceResp = await defaultBridge.handleOneBotAction("get_essence_msg_list", {
        group_id: 654321,
      });
      assert.strictEqual(essenceResp.status, "ok");
      assert.strictEqual(Array.isArray(essenceResp.data), true);
      assert.strictEqual(essenceResp.data.length, 1);
      assert.strictEqual(essenceResp.data[0].msg_seq, 88);
      assert.strictEqual(
        calledKernelCmds[0],
        "nodeIKernelGroupService/fetchGroupEssenceListV2",
        "get_essence_msg_list must invoke fetchGroupEssenceListV2 first"
      );
      assert.strictEqual(
        calledKernelCmds.includes("nodeIKernelGroupService/getGroupLatestEssenceList"),
        false,
        "get_essence_msg_list should not fall back when fetchGroupEssenceListV2 succeeds"
      );

      failEssenceV2 = true;
      calledKernelCmds.length = 0;
      const essenceFallbackResp = await defaultBridge.handleOneBotAction("get_essence_msg_list", {
        group_id: 654321,
      });
      assert.strictEqual(essenceFallbackResp.status, "ok");
      assert.strictEqual(essenceFallbackResp.data[0].msg_seq, 89);
      assert.deepStrictEqual(calledKernelCmds, [
        "nodeIKernelGroupService/fetchGroupEssenceListV2",
        "nodeIKernelGroupService/getGroupLatestEssenceList",
      ]);

      const noticeResp = await defaultBridge.handleOneBotAction("_get_group_notice", {
        group_id: 654321,
      });
      assert.strictEqual(noticeResp.status, "ok");
      assert.strictEqual(Array.isArray(noticeResp.data), true);
      assert.strictEqual(noticeResp.data[0].feedId, "notice_1");
      assert.ok(calledKernelCmds.includes("nodeIKernelGroupService/getGroupBulletin"));
    } finally {
      await defaultBridge.stopServers();
    }
  }
});
