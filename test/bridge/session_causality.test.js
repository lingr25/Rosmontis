"use strict";

/**
 * Session causal state machine, AIO concurrency mutex, two-stage idle exit/blur & XIAO_BRIDGE_* env compat
 * Migrated from test/test_bridge.js sections: 14.
 */

const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { onebot, rendererMod, mainMod } = require("./_helpers");
// === Section 14: Testing Session Causal State Machine, AIO Concurrency Mutex, Idle Exit & XIAO_BRIDGE_* Compat ===

test("Strict causal order, slow-image AIO anti-thrashing, set_input_status re-entry, two-stage idle exit/blur, dynamic rich-media echo timeout & XIAO_BRIDGE_* env compat", async () => {
  const oneByOnePng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );

  // Helper: create a bridge wired to a real renderer bridge instance over simulated IPC
  function createCausalTestHarness(configOverrides = {}, { echoDelayMs = 5 } = {}) {
    const ipcCalls = [];
    const mainListeners = new Map();
    let currentActivePeerKey = "";
    let nextRealMsgCounter = 1;
    let bridgeRef = null;

    const fakeIpcRenderer = {
      send(channel, meta, data) {
        if (channel === "__ROSMONTIS_BRIDGE_EVENT__") return;
        if (meta?.eventName === "ntApi" && data?.cmdType === "invoke") {
          const cmd = data.cmdName;
          const arg0 = Array.isArray(data.payload) ? data.payload[0] : data.payload;
          if (cmd === "nodeIKernelMsgService/enterOrExitAio") {
            const entry = arg0?.info_list?.[0];
            const p = entry?.peer;
            const pKey = p ? `${p.chatType}:${p.peerUid}:${p.guildId || ""}` : "";
            if (entry?.option === 1) {
              currentActivePeerKey = pKey;
            } else if (entry?.option === 2 && currentActivePeerKey === pKey) {
              currentActivePeerKey = "";
            }
          }
          ipcCalls.push({
            tier: 1,
            cmd,
            payload: arg0,
            activeAtCall: currentActivePeerKey,
            at: Date.now(),
          });

          const onMain = mainListeners.get(`RM_IPCFROM_MAIN${meta.peerId || 1}`);
          if (typeof onMain === "function" && meta.callbackId) {
            setImmediate(() => {
              let resultPayload = { result: 0, errMsg: "" };
              if (cmd === "nodeIKernelMsgService/copyFileWithDelExifInfo") {
                resultPayload = { result: 0, errMsg: "", newPath: arg0?.sourcePath || "" };
              }
              onMain(
                {},
                {
                  callbackId: meta.callbackId,
                  promiseStatue: "full",
                  type: "response",
                  eventName: "ntApi",
                  peerId: meta.peerId || 1,
                },
                resultPayload
              );

              if (cmd === "nodeIKernelMsgService/sendMsg" && bridgeRef) {
                const realId = `7699000000000000${String(nextRealMsgCounter++).padStart(3, "0")}`;
                const delay = typeof echoDelayMs === "function" ? echoDelayMs(arg0) : echoDelayMs;
                const t = setTimeout(() => {
                  bridgeRef.inboundPipeline._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
                    {
                      msgId: realId,
                      msgSeq: String(1000 + nextRealMsgCounter),
                      msgTime: Math.floor(Date.now() / 1000),
                      chatType: arg0.peer.chatType,
                      peerUid: arg0.peer.peerUid,
                      senderUid: "u_rosmontis_self",
                      senderUin: "100010001",
                      elements: arg0.msgElements,
                    },
                  ]);
                }, delay);
                if (typeof t.unref === "function") t.unref();
              }
            });
          }
        }
      },
      on(ch, fn) {
        mainListeners.set(ch, fn);
      },
    };

    const rBridge = rendererMod.installRendererBridge(
      {
        webContentId: 1,
        location: { search: "?webcontentsid=1" },
        ipcRenderer: fakeIpcRenderer,
        document: { querySelector: () => null },
      },
      { forceReinstall: true, autoRegisterListeners: false }
    );

    const bridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_rosmontis_self",
      rendererExecute: (cmd, args) => rBridge.invokeNtApi(cmd, args),
      rendererSimulateSession: (opts) => rBridge.simulateHumanSessionFlow(opts),
      rendererLeaveSession: (opts) => rBridge.leaveHumanSessionFlow(opts),
      config: {
        selfUin: "100010001",
        httpServers: [],
        wsServers: [],
        wsClients: [],
        humanSimulation: true,
        dedupeWindowMs: 5000,
        aioIdleExitMs: 45000,
        focusIdleBlurMs: 300000,
        sendEchoTimeoutMs: 1000,
        richMediaEchoTimeoutMs: 3000,
        cleanupTempImmediately: true,
        ...configOverrides,
      },
    });
    bridgeRef = bridge;

    // Also wire Tier 2 fallback proxy to verify Tier 1 <-> Tier 2 state sync
    bridge.capturedServices.ntApi = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== "string" || !prop.includes("/")) return undefined;
          return async (payload) => {
            if (prop === "nodeIKernelMsgService/enterOrExitAio") {
              const entry = payload?.info_list?.[0];
              const p = entry?.peer;
              const pKey = p ? `${p.chatType}:${p.peerUid}:${p.guildId || ""}` : "";
              if (entry?.option === 1) {
                currentActivePeerKey = pKey;
              } else if (entry?.option === 2 && currentActivePeerKey === pKey) {
                currentActivePeerKey = "";
              }
            }
            ipcCalls.push({
              tier: 2,
              cmd: prop,
              payload,
              activeAtCall: currentActivePeerKey,
              at: Date.now(),
            });
            if (prop === "nodeIKernelMsgService/sendMsg") {
              return {
                result: 0,
                errMsg: "",
                msgId: `7699990000000000${String(nextRealMsgCounter++).padStart(3, "0")}`,
              };
            }
            return { result: 0, errMsg: "" };
          };
        },
      }
    );

    bridge.uinUidStore.record("100020002", "u_uid_u1");
    bridge.uinUidStore.record("100030003", "u_uid_u2");
    return { bridge, rBridge, ipcCalls, getCurrentActivePeerKey: () => currentActivePeerKey };
  }

  // ------------------------------------------------------------------------
  // (1) Strict Causal Order + Tier 1 / Tier 2 Single-Source State Sync
  // ------------------------------------------------------------------------
  {
    const { bridge, rBridge, ipcCalls } = createCausalTestHarness();
    try {
      const res1 = await bridge.handleOneBotAction("send_private_msg", {
        user_id: 100020002,
        message: "first causal message",
      });
      assert.strictEqual(res1.status, "ok");

      assert.deepStrictEqual(
        ipcCalls.map((c) => c.cmd),
        [
          "nodeIKernelMsgService/setFocusOnBase",
          "nodeIKernelMsgService/enterOrExitAio",
          "nodeIKernelMsgService/setMsgRead",
          "nodeIKernelMsgService/sendMsg",
        ],
        "Direct send_private_msg must strictly follow setFocusOnBase(Contact) -> enterOrExitAio(option: 1) -> setMsgRead -> sendMsg without addActiveChatByUid or 0ms sendShowInputStatusReq"
      );
      assert.deepStrictEqual(ipcCalls[0].payload, {
        peer: { chatType: 1, peerUid: "u_uid_u1", guildId: "" },
        chatType: 1,
        peerUid: "u_uid_u1",
        guildId: "",
      });
      assert.strictEqual(ipcCalls[1].payload.info_list[0].option, 1);
      assert.strictEqual(ipcCalls[1].payload.info_list[0].peer.peerUid, "u_uid_u1");

      // Switch to second session (Group 888002): must exit U1 first, enterOrExitAio(G2, 1), without repeating setFocusOnBase
      ipcCalls.length = 0;
      const res2 = await bridge.handleOneBotAction("send_group_msg", {
        group_id: 888002,
        message: "second session message",
      });
      assert.strictEqual(res2.status, "ok");
      assert.deepStrictEqual(
        ipcCalls.map((c) => c.cmd),
        [
          "nodeIKernelMsgService/enterOrExitAio",
          "nodeIKernelMsgService/enterOrExitAio",
          "nodeIKernelMsgService/setMsgRead",
          "nodeIKernelMsgService/sendMsg",
        ],
        "Switching session must exit old AIO -> enterOrExitAio(new, option: 1) without repeating setFocusOnBase"
      );
      assert.strictEqual(ipcCalls[0].payload.info_list[0].option, 2);
      assert.strictEqual(ipcCalls[0].payload.info_list[0].peer.peerUid, "u_uid_u1");
      assert.strictEqual(ipcCalls[1].payload.info_list[0].option, 1);
      assert.strictEqual(ipcCalls[1].payload.info_list[0].peer.peerUid, "888002");

      // Simulate temporary Tier 2 degradation switching to Group 888003, then Tier 1 recovery back to Group 888002
      bridge.rendererSimulateSession = null;
      bridge.rendererExecute = null;
      ipcCalls.length = 0;
      await bridge.handleOneBotAction("send_group_msg", {
        group_id: 888003,
        message: "tier2 degraded switch",
      });
      assert.strictEqual(ipcCalls[0].tier, 2);
      assert.strictEqual(ipcCalls[0].cmd, "nodeIKernelMsgService/enterOrExitAio");
      assert.strictEqual(ipcCalls[0].payload.info_list[0].peer.peerUid, "888002");
      assert.strictEqual(ipcCalls[0].payload.info_list[0].option, 2);

      // Restore Tier 1 renderer (whose local state was still stuck on 888002 before sync!) and send to 888002
      bridge.rendererExecute = (cmd, args) => rBridge.invokeNtApi(cmd, args);
      bridge.rendererSimulateSession = (opts) => rBridge.simulateHumanSessionFlow(opts);
      ipcCalls.length = 0;
      await bridge.handleOneBotAction("send_group_msg", {
        group_id: 888002,
        message: "tier1 recovered switch back to 888002",
      });
      assert.strictEqual(ipcCalls[0].tier, 1);
      assert.strictEqual(ipcCalls[0].cmd, "nodeIKernelMsgService/enterOrExitAio");
      assert.strictEqual(
        ipcCalls[0].payload.info_list[0].peer.peerUid,
        "888003",
        "Tier 1 must sync knownActivePeer from main process and exit 888003"
      );
      assert.strictEqual(ipcCalls[0].payload.info_list[0].option, 2);
      assert.strictEqual(ipcCalls[1].cmd, "nodeIKernelMsgService/enterOrExitAio");
      assert.strictEqual(ipcCalls[1].payload.info_list[0].peer.peerUid, "888002");
      assert.strictEqual(ipcCalls[1].payload.info_list[0].option, 1);
    } finally {
      await bridge.stopServers();
    }
  }

  // ------------------------------------------------------------------------
  // (2) Slow Remote Image Concurrency Anti-Thrashing (Core Regression Test)
  // ------------------------------------------------------------------------
  {
    let imageServedAt = 0;
    const slowImgServer = http.createServer((_req, res) => {
      setTimeout(() => {
        imageServedAt = Date.now();
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": oneByOnePng.length,
        });
        res.end(oneByOnePng);
      }, 120);
    });
    await new Promise((resolve) => slowImgServer.listen(0, "127.0.0.1", resolve));
    const slowPort = slowImgServer.address().port;
    const { bridge, ipcCalls } = createCausalTestHarness({ allowPrivateUrls: true });

    try {
      // Group A starts sending a slow remote image (120ms HTTP download)
      const groupAPromise = bridge.handleOneBotAction("send_group_msg", {
        group_id: 900001,
        message: [{ type: "image", data: { file: `http://127.0.0.1:${slowPort}/slow.png` } }],
      });

      // 10ms later, Group B sends a plain text message
      await new Promise((r) => setTimeout(r, 10));
      const groupBResp = await bridge.handleOneBotAction("send_group_msg", {
        group_id: 900002,
        message: "fast text in group B",
      });
      const groupBDoneAt = Date.now();
      assert.strictEqual(groupBResp.status, "ok");
      assert.strictEqual(
        imageServedAt,
        0,
        `Group B must finish (${groupBDoneAt}) without waiting for Group A's 120ms slow image download`
      );

      const groupAResp = await groupAPromise;
      assert.strictEqual(groupAResp.status, "ok");

      const sendCalls = ipcCalls.filter((c) => c.cmd === "nodeIKernelMsgService/sendMsg");
      assert.strictEqual(sendCalls.length, 2);
      assert.strictEqual(
        sendCalls[0].payload.peer.peerUid,
        "900002",
        "Group B sendMsg must dispatch first"
      );
      assert.strictEqual(
        sendCalls[1].payload.peer.peerUid,
        "900001",
        "Group A sendMsg must dispatch after slow image finishes"
      );

      for (const sc of sendCalls) {
        const expectedKey = `${sc.payload.peer.chatType}:${sc.payload.peer.peerUid}:${sc.payload.peer.guildId || ""}`;
        assert.strictEqual(
          sc.activeAtCall,
          expectedKey,
          `sendMsg(${expectedKey}) must NEVER fire while active AIO is '${sc.activeAtCall}'`
        );
      }

      // Verify between sendMsg(Group B) and sendMsg(Group A): enterOrExitAio(B, option: 2) -> enterOrExitAio(A, option: 1)
      const idxSendB = ipcCalls.indexOf(sendCalls[0]);
      const idxSendA = ipcCalls.indexOf(sendCalls[1]);
      const betweenCmds = ipcCalls.slice(idxSendB + 1, idxSendA);
      const exitBIdx = betweenCmds.findIndex(
        (c) =>
          c.cmd === "nodeIKernelMsgService/enterOrExitAio" &&
          c.payload.info_list?.[0]?.peer?.peerUid === "900002" &&
          c.payload.info_list?.[0]?.option === 2
      );
      const enterAIdx = betweenCmds.findIndex(
        (c) =>
          c.cmd === "nodeIKernelMsgService/enterOrExitAio" &&
          c.payload.info_list?.[0]?.peer?.peerUid === "900001" &&
          c.payload.info_list?.[0]?.option === 1
      );
      assert.ok(exitBIdx >= 0, "Must exit Group B AIO after Group A finishes downloading image");
      assert.ok(enterAIdx > exitBIdx, "Must enter Group A AIO after exiting Group B AIO and before sendMsg(Group A)");
    } finally {
      await bridge.stopServers();
      await new Promise((resolve) => slowImgServer.close(resolve));
    }
  }

  // ------------------------------------------------------------------------
  // (3) set_input_status Preempted by Cross-Group Message -> Auto Re-Entry
  // ------------------------------------------------------------------------
  {
    const { bridge, ipcCalls } = createCausalTestHarness();
    try {
      // Private U1 triggers set_input_status
      const st = await bridge.handleOneBotAction("set_input_status", {
        user_id: 100020002,
        event_type: 1,
      });
      assert.strictEqual(st.status, "ok");

      // Group G1 sends a message and preempts AIO away from U1
      const g1 = await bridge.handleOneBotAction("send_group_msg", {
        group_id: 900011,
        message: "group preemption",
      });
      assert.strictEqual(g1.status, "ok");

      // Private U1 now sends the actual message -> must exit G1 and re-enter U1 before sendMsg!
      ipcCalls.length = 0;
      const u1Send = await bridge.handleOneBotAction("send_private_msg", {
        user_id: 100020002,
        message: "reply after typing preemption",
      });
      assert.strictEqual(u1Send.status, "ok");

      const exitG1Idx = ipcCalls.findIndex(
        (c) =>
          c.cmd === "nodeIKernelMsgService/enterOrExitAio" &&
          c.payload.info_list?.[0]?.peer?.peerUid === "900011" &&
          c.payload.info_list?.[0]?.option === 2
      );
      const enterU1Idx = ipcCalls.findIndex(
        (c) =>
          c.cmd === "nodeIKernelMsgService/enterOrExitAio" &&
          c.payload.info_list?.[0]?.peer?.peerUid === "u_uid_u1" &&
          c.payload.info_list?.[0]?.option === 1
      );
      const sendU1Idx = ipcCalls.findIndex((c) => c.cmd === "nodeIKernelMsgService/sendMsg");
      assert.ok(exitG1Idx >= 0, "Must exit preempting group G1 before sending private message");
      assert.ok(enterU1Idx > exitG1Idx, "Must re-enter private U1 AIO after exiting G1");
      assert.ok(sendU1Idx > enterU1Idx, "sendMsg(U1) must follow re-entering U1 AIO");
    } finally {
      await bridge.stopServers();
    }
  }

  // ------------------------------------------------------------------------
  // (4) Two-Stage Idle Exit (60ms) & Window Blur (260ms) + Offline Cleanup
  // ------------------------------------------------------------------------
  {
    const { bridge, ipcCalls } = createCausalTestHarness({
      aioIdleExitMs: 60,
      focusIdleBlurMs: 260,
    });
    try {
      await bridge.handleOneBotAction("send_group_msg", {
        group_id: 900021,
        message: "hello before idle",
      });
      ipcCalls.length = 0;

      // Wait 110ms (> 60ms aioIdleExitMs, < 260ms focusIdleBlurMs)
      await new Promise((r) => setTimeout(r, 110));
      assert.strictEqual(
        ipcCalls.some(
          (c) =>
            c.cmd === "nodeIKernelMsgService/enterOrExitAio" &&
            c.payload.info_list?.[0]?.peer?.peerUid === "900021" &&
            c.payload.info_list?.[0]?.option === 2
        ),
        true,
        "Must auto-exit AIO after aioIdleExitMs (60ms)"
      );
      assert.strictEqual(
        ipcCalls.some(
          (c) =>
            c.cmd === "nodeIKernelMsgService/setFocusOnBase" &&
            c.payload.chatType === 0 &&
            c.payload.peerUid === "" &&
            c.payload.peer?.chatType === 0 &&
            c.payload.peer?.peerUid === ""
        ),
        false,
        "Window must still remain focused before focusIdleBlurMs (260ms)"
      );

      // Wait until 300ms total (> 260ms focusIdleBlurMs)
      await new Promise((r) => setTimeout(r, 190));
      assert.strictEqual(
        ipcCalls.some(
          (c) =>
            c.cmd === "nodeIKernelMsgService/setFocusOnBase" &&
            c.payload.chatType === 0 &&
            c.payload.peerUid === "" &&
            c.payload.peer?.chatType === 0 &&
            c.payload.peer?.peerUid === ""
        ),
        true,
        "Must auto-blur window via empty Contact setFocusOnBase payload after focusIdleBlurMs (260ms)"
      );
      assert.strictEqual(
        ipcCalls.filter(
          (c) =>
            c.cmd === "nodeIKernelMsgService/enterOrExitAio" &&
            c.payload.info_list?.[0]?.option === 2
        ).length,
        1,
        "Must not emit duplicate enterOrExitAio(2) when blur timer fires"
      );

      // Subsequent message must re-focus window first
      ipcCalls.length = 0;
      await bridge.handleOneBotAction("send_group_msg", {
        group_id: 900021,
        message: "wake up from blur",
      });
      assert.strictEqual(ipcCalls[0].cmd, "nodeIKernelMsgService/setFocusOnBase");
      assert.deepStrictEqual(ipcCalls[0].payload, {
        peer: { chatType: 2, peerUid: "900021", guildId: "" },
        chatType: 2,
        peerUid: "900021",
        guildId: "",
      });
      assert.strictEqual(ipcCalls[1].cmd, "nodeIKernelMsgService/enterOrExitAio");
      assert.strictEqual(ipcCalls[1].payload.info_list[0].option, 1);

      // Verify onKickedOffLine clears active AIO, focus state, and idle timers
      assert.ok(bridge.sessionController.activeAioPeer !== null);
      assert.strictEqual(bridge.sessionController.windowFocused, true);
      await bridge.inboundPipeline._handleKernelEvent("nodeIKernelLoginListener", "onKickedOffLine", [
        { tipsTitle: "Kicked", tipsDesc: "Session expired" },
      ]);
      assert.strictEqual(bridge.sessionController.activeAioPeer, null);
      assert.strictEqual(bridge.sessionController.activeAioPeerKey, "");
      assert.strictEqual(bridge.sessionController.windowFocused, false);
      assert.strictEqual(bridge.sessionController.aioIdleTimer, null);
      assert.strictEqual(bridge.sessionController.focusBlurTimer, null);
    } finally {
      await bridge.stopServers();
    }
  }

  // ------------------------------------------------------------------------
  // (5) Dynamic Rich-Media Echo Timeout (Rich Media > Default Text Timeout)
  // ------------------------------------------------------------------------
  {
    // Text timeout = 50ms, Rich-media timeout = 450ms, simulated kernel echo delay = 110ms
    const { bridge, ipcCalls } = createCausalTestHarness(
      {
        sendEchoTimeoutMs: 50,
        richMediaEchoTimeoutMs: 450,
      },
      { echoDelayMs: 110 }
    );
    try {
      // Plain text message exceeds 50ms -> times out to synthetic sent_*
      const txtResp = await bridge.handleOneBotAction("send_group_msg", {
        group_id: 900031,
        message: "plain text with 110ms echo",
      });
      assert.strictEqual(txtResp.status, "ok");
      const txtStored = bridge.messageIdStore.getByShortId(txtResp.data.message_id);
      assert.ok(
        String(txtStored?.msgId || "").startsWith("sent_"),
        "Plain text exceeding sendEchoTimeoutMs (50ms) should fall back to sent_*"
      );

      // Wait for delayed text echo to pass before sending rich media
      await new Promise((r) => setTimeout(r, 80));

      // Image message uses richMediaEchoTimeoutMs (450ms > 110ms) -> captures real msgId and supports delete_msg!
      const imgResp = await bridge.handleOneBotAction("send_group_msg", {
        group_id: 900031,
        message: [
          {
            type: "image",
            data: { file: `base64://${oneByOnePng.toString("base64")}` },
          },
        ],
      });
      assert.strictEqual(imgResp.status, "ok");
      const imgStored = bridge.messageIdStore.getByShortId(imgResp.data.message_id);
      assert.ok(
        imgStored && /^7699\d+$/.test(String(imgStored.msgId)),
        `Rich media message must resolve real onAddSendMsg msgId instead of sent_*, got: ${imgStored?.msgId}`
      );

      const delResp = await bridge.handleOneBotAction("delete_msg", {
        message_id: imgResp.data.message_id,
      });
      assert.strictEqual(delResp.status, "ok");
      assert.ok(
        ipcCalls.some(
          (c) =>
            c.cmd === "nodeIKernelMsgService/recallMsg" &&
            Array.isArray(c.payload.msgIds) &&
            c.payload.msgIds[0] === imgStored.msgId
        ),
        "delete_msg must recall the real msgId of the rich-media message"
      );
    } finally {
      await bridge.stopServers();
    }
  }

  // ------------------------------------------------------------------------
  // (6) Upstream XIAO_BRIDGE_* Environment Variable Alias Compatibility
  // ------------------------------------------------------------------------
  {
    const savedEnv = {};
    const envKeys = [
      "ROSMONTIS_DISABLE",
      "ROSMONTIS_BRIDGE_DISABLE",
      "XIAO_BRIDGE_DISABLE",
      "ROSMONTIS_SELF_ID",
      "ONEBOT_SELF_ID",
      "XIAO_BRIDGE_SELF_ID",
      "ROSMONTIS_HTTP_PORT",
      "ONEBOT_HTTP_PORT",
      "XIAO_BRIDGE_HTTP_PORT",
      "ROSMONTIS_WS_PORT",
      "ONEBOT_WS_PORT",
      "XIAO_BRIDGE_WS_PORT",
      "ROSMONTIS_REVERSE_WS_URL",
      "ONEBOT_REVERSE_WS_URL",
      "XIAO_BRIDGE_REVERSE_WS_URL",
      "ROSMONTIS_ACCESS_TOKEN",
      "ONEBOT_ACCESS_TOKEN",
      "XIAO_BRIDGE_ACCESS_TOKEN",
      "ROSMONTIS_KEEP_MAP_HOOK",
      "XIAO_BRIDGE_KEEP_MAP_HOOK",
      "ROSMONTIS_TEMP_DIR",
      "XIAO_BRIDGE_TEMP_DIR",
    ];
    for (const k of envKeys) savedEnv[k] = process.env[k];
    const emptyCfgDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "rosmontis-xiao-env-"));
    const customTempDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "rosmontis-xiao-tmp-"));

    try {
      for (const k of envKeys) delete process.env[k];

      // XIAO_BRIDGE_DISABLE=1 bypasses bootBridgeMain()
      process.env.XIAO_BRIDGE_DISABLE = "1";
      const launcher = require("../../src/app_launcher_index.js");
      assert.strictEqual(launcher.bootBridgeMain(), null);
      delete process.env.XIAO_BRIDGE_DISABLE;

      // XIAO_BRIDGE_* fallbacks in loadBridgeConfig
      process.env.XIAO_BRIDGE_SELF_ID = "3956798580";
      process.env.XIAO_BRIDGE_HTTP_PORT = "13000";
      process.env.XIAO_BRIDGE_WS_PORT = "13001";
      process.env.XIAO_BRIDGE_REVERSE_WS_URL = "ws://127.0.0.1:18080/onebot/v11/ws";
      process.env.XIAO_BRIDGE_ACCESS_TOKEN = "xiao_legacy_token";

      const cfgLegacy = mainMod.loadBridgeConfig(emptyCfgDir);
      assert.strictEqual(cfgLegacy.selfUin, "3956798580");
      assert.strictEqual(cfgLegacy.httpServers[0].port, 13000);
      assert.strictEqual(cfgLegacy.wsServers[0].port, 13001);
      assert.strictEqual(cfgLegacy.wsClients[0].url, "ws://127.0.0.1:18080/onebot/v11/ws");
      assert.strictEqual(cfgLegacy.wsClients[0].accessToken, "xiao_legacy_token");

      // Priority check: ROSMONTIS_* > ONEBOT_* > XIAO_BRIDGE_*
      process.env.ONEBOT_HTTP_PORT = "14000";
      assert.strictEqual(mainMod.loadBridgeConfig(emptyCfgDir).httpServers[0].port, 14000);
      process.env.ROSMONTIS_HTTP_PORT = "15000";
      assert.strictEqual(mainMod.loadBridgeConfig(emptyCfgDir).httpServers[0].port, 15000);

      // XIAO_BRIDGE_KEEP_MAP_HOOK=1 disables Map hook release
      process.env.XIAO_BRIDGE_KEEP_MAP_HOOK = "1";
      const b = new mainMod.NtqqOneBotBridge({
        config: { httpServers: [], wsServers: [], wsClients: [] },
      });
      assert.strictEqual(b.ntCapture._mapHookReleaseDisabled(), true);

      // XIAO_BRIDGE_TEMP_DIR fallback in resolveMediaSource
      process.env.XIAO_BRIDGE_TEMP_DIR = customTempDir;
      const media = await onebot.resolveMediaSource(`base64://${oneByOnePng.toString("base64")}`);
      assert.strictEqual(path.dirname(media.localPath), customTempDir);
    } finally {
      for (const k of envKeys) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
      try {
        fs.rmSync(emptyCfgDir, { recursive: true, force: true });
        fs.rmSync(customTempDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }
});
