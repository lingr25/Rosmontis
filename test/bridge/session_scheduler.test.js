"use strict";

/**
 * CausalSessionScheduler peer-affinity mutex, auto-read cooldown/coalescing & messageFormat string vs array
 * Migrated from test/test_bridge.js sections: 17.
 */

const test = require("node:test");
const assert = require("assert");
const { mainMod } = require("./_helpers");
// === Section 17: Testing Causal Session Scheduler, Peer-Affinity Mutex, Auto-Read Cooldown & messageFormat ===

test("Full private-chat causal timeline, CausalSessionScheduler peer-affinity & maxAffinityStreak, autoReadAndTypeOnPrivateRecv coalescing/cooldown, and messageFormat string vs array", async () => {
  const { CausalSessionScheduler } = require("../../src/core/session_scheduler.js");

  function createPrivateCausalBridge(cfgOverrides = {}) {
    const calls = [];
    const bridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_rosmontis_self",
      ntApi: new Proxy(
        {},
        {
          get(_t, prop) {
            if (typeof prop !== "string" || !prop.includes("/")) return undefined;
            return async (payload) => {
              calls.push({ cmd: prop, payload, at: Date.now() });
              if (prop === "nodeIKernelMsgService/sendMsg") {
                return { result: 0, errMsg: "", msgId: `7700000000000000${calls.length}` };
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
        humanSimulation: true,
        dedupeWindowMs: 5000,
        aioSwitchCooldownMs: 0,
        ...cfgOverrides,
      },
    });
    bridge.uinUidStore.record("100020002", "u_priv_1");
    bridge.uinUidStore.record("100030003", "u_priv_2");
    bridge.uinUidStore.record("100040004", "u_priv_3");
    return { bridge, calls };
  }

  // 1a. Full private-chat causal timeline: recv -> set_input_status -> LLM gap -> send_private_msg
  {
    const { bridge, calls } = createPrivateCausalBridge({ autoReadAndTypeOnPrivateRecv: false });
    try {
      await bridge.inboundPipeline._handleKernelEvent("nodeIKernelMsgListener", "onRecvMsg", [
        [
          {
            msgId: "c_in_1",
            msgSeq: "101",
            msgTime: "1710000100",
            chatType: 1,
            msgType: 2,
            peerUid: "u_priv_1",
            senderUid: "u_priv_1",
            senderUin: "100020002",
            sendNickName: "Doctor",
            elements: [{ elementType: 1, textElement: { content: "在吗迷迭香？" } }],
          },
        ],
      ]);
      assert.strictEqual(calls.length, 0, "Passive receipt with autoReadAndTypeOnPrivateRecv=false should not invoke AIO commands yet");

      // Step 2: set_input_status -> focus -> enterAio(option: 1) -> setMsgRead -> sendShowInputStatusReq
      const stRes = await bridge.handleOneBotAction("set_input_status", {
        user_id: 100020002,
        event_type: 1,
      });
      assert.strictEqual(stRes.status, "ok");
      assert.deepStrictEqual(
        calls.map((c) => c.cmd),
        [
          "nodeIKernelMsgService/setFocusOnBase",
          "nodeIKernelMsgService/enterOrExitAio",
          "nodeIKernelMsgService/setMsgRead",
          "nodeIKernelMsgService/sendShowInputStatusReq",
        ]
      );

      // Step 3: LLM generation gap
      await new Promise((r) => setTimeout(r, 30));

      // Step 4: send_private_msg -> sendMsg directly on already-active peer with NO redundant enterOrExitAio and NO 0ms sendShowInputStatusReq
      calls.length = 0;
      const sendRes = await bridge.handleOneBotAction("send_private_msg", {
        user_id: 100020002,
        message: "我在的，博士。",
      });
      assert.strictEqual(sendRes.status, "ok");
      assert.deepStrictEqual(
        calls.map((c) => c.cmd),
        ["nodeIKernelMsgService/sendMsg"],
        "send_private_msg on already-active session must invoke sendMsg directly with zero redundant enterOrExitAio or 0ms sendShowInputStatusReq"
      );
    } finally {
      await bridge.stopServers();
    }
  }

  // 1b. "Typed then deleted / chose not to reply" path: set_input_status runs, send_private_msg is NEVER called -> clean idle exit/blur & zero leaks
  {
    const { bridge, calls } = createPrivateCausalBridge({
      aioIdleExitMs: 45,
      focusIdleBlurMs: 95,
    });
    try {
      await bridge.handleOneBotAction("set_input_status", {
        user_id: 100020002,
        event_type: 1,
      });
      assert.strictEqual(bridge.sessionController.activeAioPeerKey, "1:u_priv_1:");
      assert.strictEqual(bridge.sessionController.windowFocused, true);

      // Never call send_private_msg; let idle timers settle cleanly
      await new Promise((r) => setTimeout(r, 160));

      assert.strictEqual(bridge.sessionController.activeAioPeerKey, "");
      assert.strictEqual(bridge.sessionController.windowFocused, false);
      assert.strictEqual(bridge.echoCorrelator.waiters.size, 0);
      assert.strictEqual(bridge.sessionController.scheduler.pendingReactionCount, 0);
      assert.ok(
        calls.some(
          (c) =>
            c.cmd === "nodeIKernelMsgService/enterOrExitAio" &&
            c.payload?.info_list?.[0]?.option === 2 &&
            c.payload?.info_list?.[0]?.peer?.peerUid === "u_priv_1"
        ),
        "Unanswered typing session must cleanly exit AIO after idle timeout"
      );
      assert.ok(
        calls.some(
          (c) =>
            c.cmd === "nodeIKernelMsgService/setFocusOnBase" &&
            c.payload?.chatType === 0 &&
            c.payload?.peerUid === "" &&
            c.payload?.peer?.chatType === 0 &&
            c.payload?.peer?.peerUid === ""
        ),
        "Unanswered typing session must cleanly blur window after focus idle timeout"
      );
    } finally {
      await bridge.stopServers();
    }
  }

  // 2. Peer-affinity mutex scheduling (CausalSessionScheduler) + maxAffinityStreak anti-starvation
  {
    let activePeer = "A";
    const scheduler = new CausalSessionScheduler({
      getActivePeerKey: () => activePeer,
      maxAffinityStreak: 2,
    });
    try {
      // (a) Peer A holds lock; [B1, A2, B2] queue up while activePeer === "A" -> A2 runs BEFORE B1!
      const order1 = [];
      let releaseA1;
      const holdA1 = new Promise((r) => {
        releaseA1 = r;
      });

      const pA1 = scheduler.runExclusive("A", async () => {
        order1.push("A1");
        await holdA1;
      });
      const pB1 = scheduler.runExclusive("B", async () => {
        activePeer = "B";
        order1.push("B1");
      });
      const pA2 = scheduler.runExclusive("A", async () => {
        activePeer = "A";
        order1.push("A2");
      });
      const pB2 = scheduler.runExclusive("B", async () => {
        activePeer = "B";
        order1.push("B2");
      });

      releaseA1();
      await Promise.all([pA1, pB1, pA2, pB2]);
      assert.deepStrictEqual(
        order1,
        ["A1", "A2", "B1", "B2"],
        "A2 must execute before B1 while activePeerKey === 'A' to eliminate A->B->A->B ping-pong"
      );

      // (b) maxAffinityStreak: 2 prevents starvation when [B1, A2, A3, A4] queue behind A1
      activePeer = "A";
      const order2 = [];
      let releaseFirst;
      const holdFirst = new Promise((r) => {
        releaseFirst = r;
      });

      const qA1 = scheduler.runExclusive("A", async () => {
        order2.push("A1");
        await holdFirst;
      });
      const qB1 = scheduler.runExclusive("B", async () => {
        activePeer = "B";
        order2.push("B1");
      });
      const qA2 = scheduler.runExclusive("A", async () => {
        activePeer = "A";
        order2.push("A2");
      });
      const qA3 = scheduler.runExclusive("A", async () => {
        activePeer = "A";
        order2.push("A3");
      });
      const qA4 = scheduler.runExclusive("A", async () => {
        activePeer = "A";
        order2.push("A4");
      });

      releaseFirst();
      await Promise.all([qA1, qB1, qA2, qA3, qA4]);
      assert.deepStrictEqual(
        order2,
        ["A1", "A2", "A3", "B1", "A4"],
        "After maxAffinityStreak=2 consecutive affinity picks (A2, A3), B1 must run before A4 to prevent starvation"
      );
    } finally {
      scheduler.dispose();
    }
  }

  // 3. High-frequency switch cooldown & autoReadAndTypeOnPrivateRecv (burst coalescing, immediate cancel, cooldown skip)
  {
    // Keep event loop alive while awaiting serverless sleepUnref(humanReadToTypingDelayMs); cleared in finally
    const keepAlive = setInterval(() => {}, 1000);
    const { bridge, calls } = createPrivateCausalBridge({
      autoReadAndTypeOnPrivateRecv: true,
      autoReadReactionDelayMs: 35,
      humanReadToTypingDelayMs: 10,
      aioSwitchCooldownMs: 400,
    });
    try {
      const pushPrivRecv = (msgId, peerUid, uin, text) =>
        bridge.inboundPipeline._handleKernelEvent("nodeIKernelMsgListener", "onRecvMsg", [
          [
            {
              msgId,
              msgSeq: msgId.replace(/\D+/g, "") || "1",
              msgTime: String(Math.floor(Date.now() / 1000)),
              chatType: 1,
              msgType: 2,
              peerUid,
              senderUid: peerUid,
              senderUin: uin,
              sendNickName: "Friend",
              elements: [{ elementType: 1, textElement: { content: text } }],
            },
          ],
        ]);

      // (a) Rapid 3-message burst from u_priv_1 coalesces into 1 delayed read+typing reaction
      await pushPrivRecv("burst_1", "u_priv_1", "100020002", "msg 1");
      await pushPrivRecv("burst_2", "u_priv_1", "100020002", "msg 2");
      await pushPrivRecv("burst_3", "u_priv_1", "100020002", "msg 3");
      assert.strictEqual(bridge.sessionController.scheduler.pendingReactionCount, 1);
      assert.strictEqual(calls.length, 0, "Auto-read reaction must wait for reaction delay");

      await new Promise((r) => setTimeout(r, 110));
      assert.strictEqual(bridge.sessionController.scheduler.pendingReactionCount, 0);
      const readCalls = calls.filter((c) => c.cmd === "nodeIKernelMsgService/setMsgRead");
      const typingCalls = calls.filter((c) => c.cmd === "nodeIKernelMsgService/sendShowInputStatusReq");
      assert.strictEqual(readCalls.length, 1, "Coalesced burst must mark read once");
      assert.strictEqual(typingCalls.length, 1, "Coalesced burst must send typing once");
      assert.ok(typingCalls[0].at >= readCalls[0].at, "sendShowInputStatusReq must occur after setMsgRead");

      // Wait for 400ms cooldown from u_priv_1 switch to expire before testing cancel on u_priv_2 / u_priv_3
      bridge.sessionController.scheduler.lastSwitchAt = Date.now() - 1000;

      // (b) Immediate cancellation when send_private_msg or set_input_status runs first
      bridge.config.autoReadReactionDelayMs = 150;
      calls.length = 0;
      await pushPrivRecv("cancel_by_send", "u_priv_2", "100030003", "fast reply test");
      assert.strictEqual(bridge.sessionController.scheduler.hasPendingReaction("1:u_priv_2:"), true);

      const fastReply = await bridge.handleOneBotAction("send_private_msg", {
        user_id: 100030003,
        message: "秒回消息",
      });
      assert.strictEqual(fastReply.status, "ok");
      assert.strictEqual(
        bridge.sessionController.scheduler.hasPendingReaction("1:u_priv_2:"),
        false,
        "send_private_msg must immediately cancel pending auto-read/typing reaction"
      );
      await new Promise((r) => setTimeout(r, 180));
      assert.strictEqual(
        calls.some((c) => c.cmd === "nodeIKernelMsgService/sendShowInputStatusReq"),
        false,
        "Cancelled reaction must never fire a late sendShowInputStatusReq after send_private_msg"
      );

      await pushPrivRecv("cancel_by_typing", "u_priv_3", "100040004", "explicit typing test");
      assert.strictEqual(bridge.sessionController.scheduler.hasPendingReaction("1:u_priv_3:"), true);
      bridge.sessionController.scheduler.lastSwitchAt = Date.now() - 1000;
      await bridge.handleOneBotAction("set_input_status", {
        user_id: 100040004,
        event_type: 1,
      });
      assert.strictEqual(
        bridge.sessionController.scheduler.hasPendingReaction("1:u_priv_3:"),
        false,
        "set_input_status must immediately cancel pending auto-read/typing reaction"
      );

      // (c) Advisory switch skipped when another peer just switched within aioSwitchCooldownMs (400ms)
      bridge.config.autoReadReactionDelayMs = 20;
      bridge.sessionController.recentReadByPeer.clear();
      bridge.sessionController.recentTypingByPeer.clear();
      await bridge.handleOneBotAction("send_group_msg", {
        group_id: 999888,
        message: "锁定当前活跃群会话",
      });
      assert.strictEqual(bridge.sessionController.activeAioPeerKey, "2:999888:");
      calls.length = 0;

      // Incoming private message arrives immediately while 400ms cooldown from 2:999888: is active
      await pushPrivRecv("cooldown_skip_1", "u_priv_1", "100020002", "should skip advisory switch");
      await new Promise((r) => setTimeout(r, 55));
      assert.strictEqual(
        bridge.sessionController.activeAioPeerKey,
        "2:999888:",
        "Advisory auto-read reaction must skip switching when another peer just switched within aioSwitchCooldownMs"
      );
      assert.strictEqual(calls.length, 0);
    } finally {
      clearInterval(keepAlive);
      await bridge.stopServers();
    }
  }

  // 4. End-to-end messageFormat: "string" vs "array" across broadcastOneBotEvent, WS clients, and get_msg
  {
    const fmtBridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_rosmontis_self",
      online: true,
      config: {
        selfUin: "100010001",
        messageFormat: "string",
        httpServers: [],
        wsServers: [
          { host: "127.0.0.1", port: 0, accessToken: "", messageFormat: "string" },
          { host: "127.0.0.1", port: 0, accessToken: "", messageFormat: "array" },
        ],
        wsClients: [],
        heartbeatIntervalMs: 0,
        humanSimulation: false,
      },
    });
    fmtBridge.uinUidStore.record("100020002", "u_fmt_peer");
    await fmtBridge.startServers();

    const connectWsTestClient = (port) =>
      new Promise((resolve, reject) => {
        const msgs = [];
        const waiters = [];
        const handle = mainMod.connectReverseWebSocket(
          `ws://127.0.0.1:${port}/`,
          {},
          (conn) =>
            resolve({
              conn,
              handle,
              msgs,
              nextJson: (predicate) => {
                const idx = msgs.findIndex(predicate);
                if (idx >= 0) {
                  const [found] = msgs.splice(idx, 1);
                  return Promise.resolve(found);
                }
                return new Promise((res) => waiters.push({ predicate, res }));
              },
            }),
          (text) => {
            const parsed = JSON.parse(text);
            const wIdx = waiters.findIndex((w) => w.predicate(parsed));
            if (wIdx >= 0) {
              const [w] = waiters.splice(wIdx, 1);
              w.res(parsed);
            } else {
              msgs.push(parsed);
            }
          },
          () => {}
        );
        if (!handle) reject(new Error("Failed to connect WS test client"));
      });

    let wsStrClient = null;
    let wsArrClient = null;
    try {
      const wsStrPort = fmtBridge.serverRuntime._wsServers[0].address().port;
      const wsArrPort = fmtBridge.serverRuntime._wsServers[1].address().port;
      wsStrClient = await connectWsTestClient(wsStrPort);
      wsArrClient = await connectWsTestClient(wsArrPort);

      await wsStrClient.nextJson((m) => m.post_type === "meta_event" && m.sub_type === "connect");
      await wsArrClient.nextJson((m) => m.post_type === "meta_event" && m.sub_type === "connect");

      const localEvents = [];
      fmtBridge.on("onebot_event", (ev) => localEvents.push(ev));

      // Emit incoming message containing face + text
      await fmtBridge.inboundPipeline._handleKernelEvent("nodeIKernelMsgListener", "onRecvMsg", [
        [
          {
            msgId: "fmt_msg_7001",
            msgSeq: "7001",
            msgTime: "1710000200",
            chatType: 1,
            msgType: 2,
            peerUid: "u_fmt_peer",
            senderUid: "u_fmt_peer",
            senderUin: "100020002",
            sendNickName: "Doctor",
            elements: [
              { elementType: 6, faceElement: { faceIndex: 14, faceType: 1 } },
              { elementType: 1, textElement: { content: "博士你好" } },
            ],
          },
        ],
      ]);

      const strBroadcast = await wsStrClient.nextJson((m) => m.post_type === "message");
      const arrBroadcast = await wsArrClient.nextJson((m) => m.post_type === "message");

      // Verify local broadcastOneBotEvent (global messageFormat: "string")
      assert.strictEqual(localEvents.length, 1);
      assert.strictEqual(typeof localEvents[0].message, "string");
      assert.strictEqual(localEvents[0].message, "[CQ:face,id=14]博士你好");

      // Verify WS client 1 (messageFormat: "string") vs WS client 2 (messageFormat: "array")
      assert.strictEqual(typeof strBroadcast.message, "string");
      assert.strictEqual(strBroadcast.message, "[CQ:face,id=14]博士你好");

      assert.strictEqual(Array.isArray(arrBroadcast.message), true);
      assert.deepStrictEqual(arrBroadcast.message, [
        { type: "face", data: { id: "14" } },
        { type: "text", data: { text: "博士你好" } },
      ]);

      const msgId = strBroadcast.message_id;

      // Verify get_msg over WS client 1 ("string") vs WS client 2 ("array")
      wsStrClient.conn.sendJson({
        action: "get_msg",
        params: { message_id: msgId },
        echo: "get_str",
      });
      const getStrReply = await wsStrClient.nextJson((m) => m.echo === "get_str");
      assert.strictEqual(getStrReply.status, "ok");
      assert.strictEqual(typeof getStrReply.data.message, "string");
      assert.strictEqual(getStrReply.data.message, "[CQ:face,id=14]博士你好");

      wsArrClient.conn.sendJson({
        action: "get_msg",
        params: { message_id: msgId },
        echo: "get_arr",
      });
      const getArrReply = await wsArrClient.nextJson((m) => m.echo === "get_arr");
      assert.strictEqual(getArrReply.status, "ok");
      assert.strictEqual(Array.isArray(getArrReply.data.message), true);
      assert.deepStrictEqual(getArrReply.data.message, [
        { type: "face", data: { id: "14" } },
        { type: "text", data: { text: "博士你好" } },
      ]);

      // Also verify direct handleOneBotAction("get_msg") respects global "string" and per-call message_format override
      const directDefault = await fmtBridge.handleOneBotAction("get_msg", { message_id: msgId });
      assert.strictEqual(directDefault.data.message, "[CQ:face,id=14]博士你好");

      const directArray = await fmtBridge.handleOneBotAction("get_msg", {
        message_id: msgId,
        message_format: "array",
      });
      assert.strictEqual(Array.isArray(directArray.data.message), true);
    } finally {
      if (wsStrClient) wsStrClient.handle.close();
      if (wsArrClient) wsArrClient.handle.close();
      await fmtBridge.stopServers();
    }
  }
});
