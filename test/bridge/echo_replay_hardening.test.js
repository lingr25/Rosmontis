"use strict";

/**
 * invokeNt side-effect replay guard, sendMsg <-> onAddSendMsg echo correlation, token env guard & socket safety
 * Migrated from test/test_bridge.js sections: 9, 10, 13.
 */

const test = require("node:test");
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { mainMod } = require("./_helpers");
// === Section 9: Testing invokeNt Side-Effect Replay Guard ===

test("invokeNt never replays dispatched side-effect commands but keeps read fallbacks", async () => {
  const makeBridge = (rendererImpl, ntApiImpl, tier3Calls) =>
    new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_self",
      online: true,
      config: { httpServers: [], wsServers: [], wsClients: [], heartbeatIntervalMs: 0, humanSimulation: false },
      rendererExecute: rendererImpl,
      ntApi: new Proxy(
        {},
        {
          get(_t, prop) {
            if (typeof prop !== "string" || !prop.includes("/")) return undefined;
            return async (payload) => ntApiImpl(prop, payload);
          },
        }
      ),
      wrapperSession: {
        getMsgService: () => ({
          sendMsg: async (...args) => {
            tier3Calls.push(["sendMsg", args]);
            return { result: 0 };
          },
          recallMsg: async (...args) => {
            tier3Calls.push(["recallMsg", args]);
            return { result: 0 };
          },
        }),
        getGroupService: () => ({}),
      },
    });

  // 9a. Renderer dispatched sendMsg then timed out -> surface error, no Tier 2 / Tier 3 replay
  {
    const ntApiCalls = [];
    const tier3Calls = [];
    const bridge = makeBridge(
      async () => {
        throw new Error("invokeNtApi timeout (15000ms): nodeIKernelMsgService/sendMsg");
      },
      async (cmd) => {
        ntApiCalls.push(cmd);
        return { result: 0 };
      },
      tier3Calls
    );
    await assert.rejects(
      () => bridge.invokeNt("nodeIKernelMsgService/sendMsg", { msgId: "0" }, ["0"]),
      /timeout/
    );
    assert.deepStrictEqual(ntApiCalls, []);
    assert.deepStrictEqual(tier3Calls, []);
    assert.strictEqual(bridge.invokeStats.blockedReplays, 1);
  }

  // 9b. Renderer bridge not injected (tagged unavailable) -> safe to fall back to Tier 2 exactly once
  {
    const ntApiCalls = [];
    const tier3Calls = [];
    const bridge = makeBridge(
      async () => {
        throw new Error("ROSMONTIS_BRIDGE_UNAVAILABLE: Renderer bridge not ready");
      },
      async (cmd) => {
        ntApiCalls.push(cmd);
        return { result: 0, msgId: "7500000000000000999" };
      },
      tier3Calls
    );
    const res = await bridge.invokeNt("nodeIKernelMsgService/sendMsg", { msgId: "0" }, ["0"]);
    assert.strictEqual(res.msgId, "7500000000000000999");
    assert.deepStrictEqual(ntApiCalls, ["nodeIKernelMsgService/sendMsg"]);
    assert.deepStrictEqual(tier3Calls, []);
    assert.strictEqual(bridge.invokeStats.tier2, 1);
    assert.strictEqual(bridge.invokeStats.degraded, 1);
  }

  // 9c. Tier 2 void (undefined) result for a side-effect command is success; Tier 3 not invoked
  {
    const tier3Calls = [];
    const bridge = makeBridge(
      async () => {
        throw new Error("ROSMONTIS_BRIDGE_UNAVAILABLE: Renderer bridge not ready");
      },
      async () => undefined,
      tier3Calls
    );
    const res = await bridge.invokeNt("nodeIKernelMsgService/recallMsg", { peer: {}, msgIds: ["1"] });
    assert.strictEqual(res, undefined);
    assert.deepStrictEqual(tier3Calls, []);
  }

  // 9d. Risk-control rejection from Tier 2 is not replayed via Tier 3
  {
    const tier3Calls = [];
    const bridge = makeBridge(
      async () => {
        throw new Error("ROSMONTIS_BRIDGE_UNAVAILABLE: Renderer bridge not ready");
      },
      async () => {
        throw new Error("send too frequently");
      },
      tier3Calls
    );
    await assert.rejects(
      () => bridge.invokeNt("nodeIKernelMsgService/sendMsg", { msgId: "0" }, ["0"]),
      /send too frequently/
    );
    assert.deepStrictEqual(tier3Calls, []);
  }

  // 9e. Read-only commands keep legacy fallback after a dispatched renderer failure
  {
    const ntApiCalls = [];
    const bridge = makeBridge(
      async () => {
        throw new Error("NTQQ IPC error (nodeIKernelGroupService/getGroupList): boom");
      },
      async (cmd) => {
        ntApiCalls.push(cmd);
        return { groupList: [] };
      },
      []
    );
    const res = await bridge.invokeNt("nodeIKernelGroupService/getGroupList", { forceFetch: true });
    assert.deepStrictEqual(res, { groupList: [] });
    assert.deepStrictEqual(ntApiCalls, ["nodeIKernelGroupService/getGroupList"]);
    const status = await bridge.handleOneBotAction("get_status", {});
    assert.strictEqual(status.data.bridge.invoke.tier2, 1);
  }
});

// === Section 10: Testing Outbound sendMsg <-> onAddSendMsg Echo Correlation ===

test("send_private_msg maps message_id to the real onAddSendMsg msgId so delete_msg can recall it", async () => {
  const recallCalls = [];
  const pendingEchoes = [];
  let bridge = null;
  const textOf = (elements) =>
    (elements || [])
      .filter((e) => e && e.elementType === 1)
      .map((e) => e.textElement.content)
      .join("");
  const echoFor = (msgId, text, msgSeq) => ({
    msgRecord: {
      msgId,
      msgSeq,
      msgTime: "1794380000",
      chatType: 1,
      peerUid: "u_friend",
      senderUid: "u_self",
      senderUin: "100010001",
      elements: [{ elementType: 1, textElement: { content: text, atType: 0 } }],
    },
  });
  bridge = new mainMod.NtqqOneBotBridge({
    selfUin: "100010001",
    selfUid: "u_self",
    online: true,
    config: {
      httpServers: [],
      wsServers: [],
      wsClients: [],
      heartbeatIntervalMs: 0,
      humanSimulation: false,
      sendEchoTimeoutMs: 80,
    },
    rendererExecute: async (cmd, args) => {
      const payload = args[0];
      if (cmd === "nodeIKernelMsgService/sendMsg") {
        const text = textOf(payload.msgElements);
        const plan = pendingEchoes.shift() || {};
        if (plan.foreignFirst) {
          // A manual send from the QQ UI to the same peer must not be mistaken for ours
          await bridge.inboundPipeline._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
            echoFor("7600000000000000900", "我是手动发的", "90"),
          ]);
        }
        if (plan.mode === "before") {
          await bridge.inboundPipeline._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
            echoFor(plan.msgId, text, plan.msgSeq),
          ]);
        } else if (plan.mode === "after") {
          setTimeout(() => {
            bridge.inboundPipeline
              ._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
                echoFor(plan.msgId, text, plan.msgSeq),
              ])
              .catch(() => {});
          }, 20);
        }
        return { result: 0, errMsg: "" };
      }
      if (cmd === "nodeIKernelMsgService/recallMsg") {
        recallCalls.push(payload);
        return { result: 0, errMsg: "" };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    },
  });
  bridge.uinUidStore.record("100020002", "u_friend");

  // 10a. Echo arrives before sendMsg resolves
  pendingEchoes.push({ mode: "before", msgId: "7600000000000000001", msgSeq: "55" });
  const r1 = await bridge.handleOneBotAction("send_private_msg", { user_id: 100020002, message: "你好" });
  assert.strictEqual(r1.status, "ok");
  assert.strictEqual(r1.data.real_id, "7600000000000000001");
  await bridge.handleOneBotAction("delete_msg", { message_id: r1.data.message_id });
  assert.deepStrictEqual(recallCalls[0].msgIds, ["7600000000000000001"]);
  assert.strictEqual(recallCalls[0].peer.peerUid, "u_friend");

  // 10b. Echo arrives after sendMsg resolves; a foreign manual send to the same peer is skipped
  pendingEchoes.push({ mode: "after", msgId: "7600000000000000002", msgSeq: "56", foreignFirst: true });
  const r2 = await bridge.handleOneBotAction("send_private_msg", { user_id: 100020002, message: "第二条" });
  assert.strictEqual(r2.data.real_id, "7600000000000000002");
  assert.notStrictEqual(r2.data.message_id, r1.data.message_id);

  // 10c. No echo at all -> bounded wait, placeholder id, counted as timed out
  pendingEchoes.push({ mode: "none" });
  const r3 = await bridge.handleOneBotAction("send_private_msg", { user_id: 100020002, message: "第三条" });
  assert.strictEqual(r3.status, "ok");
  assert.ok(String(r3.data.real_id).startsWith("sent_"));
  assert.deepStrictEqual(bridge.sendEchoStats, { matched: 2, fromResult: 0, timedOut: 1 });
  assert.strictEqual(bridge.echoCorrelator.waiters.size, 0, "waiter queues must be drained");
});

// === Section 13: Testing Token Env Guard, Echo Element Isolation, Poke Replay Guard, HTTP Null Body & Forward WS Error Safety ===

test("Empty env token preserves config token; sendEcho isolates element types/md5; poke honors replay guard; HTTP null body & Forward WS socket errors never crash", async () => {
  const os = require("os");

  // 13a. Empty ROSMONTIS_ACCESS_TOKEN / ONEBOT_ACCESS_TOKEN must not clobber config file accessToken
  const tmpCfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "rosmontis_tok_test_"));
  const prevRosTok = process.env.ROSMONTIS_ACCESS_TOKEN;
  const prevObTok = process.env.ONEBOT_ACCESS_TOKEN;
  try {
    fs.writeFileSync(
      path.join(tmpCfgDir, "rosmontis.json"),
      JSON.stringify({
        networks: {
          httpServers: [{ enable: true, host: "127.0.0.1", port: 3000, accessToken: "cfg-secret-token" }],
          wsServers: [{ enable: true, host: "127.0.0.1", port: 3001, accessToken: "cfg-secret-token" }],
          wsClients: [{ enable: true, url: "ws://127.0.0.1:8080/ws", accessToken: "cfg-secret-token" }],
        },
      }),
      "utf8"
    );
    process.env.ROSMONTIS_ACCESS_TOKEN = "";
    process.env.ONEBOT_ACCESS_TOKEN = "";
    const loadedEmptyEnv = mainMod.loadBridgeConfig(tmpCfgDir);
    assert.strictEqual(loadedEmptyEnv.httpServers[0].accessToken, "cfg-secret-token");
    assert.strictEqual(loadedEmptyEnv.wsServers[0].accessToken, "cfg-secret-token");
    assert.strictEqual(loadedEmptyEnv.wsClients[0].accessToken, "cfg-secret-token");

    process.env.ROSMONTIS_ACCESS_TOKEN = "env-override-token";
    const loadedOverride = mainMod.loadBridgeConfig(tmpCfgDir);
    assert.strictEqual(loadedOverride.httpServers[0].accessToken, "env-override-token");
    assert.strictEqual(loadedOverride.wsServers[0].accessToken, "env-override-token");
    assert.strictEqual(loadedOverride.wsClients[0].accessToken, "env-override-token");
  } finally {
    if (prevRosTok === undefined) delete process.env.ROSMONTIS_ACCESS_TOKEN;
    else process.env.ROSMONTIS_ACCESS_TOKEN = prevRosTok;
    if (prevObTok === undefined) delete process.env.ONEBOT_ACCESS_TOKEN;
    else process.env.ONEBOT_ACCESS_TOKEN = prevObTok;
    fs.rmSync(tmpCfgDir, { recursive: true, force: true });
  }

  // 13b. Outbound sendEcho rejects cross-type echoes (image/poke vs text) and matches concurrent images by md5
  {
    let echoBridge = null;
    echoBridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_self",
      online: true,
      config: {
        httpServers: [],
        wsServers: [],
        wsClients: [],
        heartbeatIntervalMs: 0,
        humanSimulation: false,
        sendEchoTimeoutMs: 120,
      },
      rendererExecute: async (cmd, args) => {
        const payload = args[0];
        if (cmd === "nodeIKernelMsgService/copyFileWithDelExifInfo") {
          return { errorMsg: "skip" };
        }
        if (cmd === "nodeIKernelMsgService/getRichMediaFilePathForGuild") {
          return { path: "" };
        }
        if (cmd === "nodeIKernelMsgService/sendMsg") {
          const firstEl = payload.msgElements[0];
          if (firstEl && firstEl.elementType === 1) {
            // Foreign image & poke echoes arrive first; neither may hijack our text waiter
            await echoBridge.inboundPipeline._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
              {
                msgRecord: {
                  msgId: "7700000000000000901",
                  msgSeq: "91",
                  chatType: 1,
                  peerUid: "u_friend",
                  senderUid: "u_self",
                  senderUin: "100010001",
                  elements: [{ elementType: 2, picElement: { md5HexStr: "deadbeef", fileName: "other.png" } }],
                },
              },
            ]);
            await echoBridge.inboundPipeline._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
              {
                msgRecord: {
                  msgId: "7700000000000000902",
                  msgSeq: "92",
                  chatType: 1,
                  peerUid: "u_friend",
                  senderUid: "u_self",
                  senderUin: "100010001",
                  elements: [],
                },
              },
            ]);
            setTimeout(() => {
              echoBridge.inboundPipeline
                ._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
                  {
                    msgRecord: {
                      msgId: "7700000000000000101",
                      msgSeq: "101",
                      chatType: 1,
                      peerUid: "u_friend",
                      senderUid: "u_self",
                      senderUin: "100010001",
                      elements: payload.msgElements,
                    },
                  },
                ])
                .catch(() => {});
            }, 15);
          }
          return { result: 0, errMsg: "" };
        }
        throw new Error(`unexpected cmd ${cmd}`);
      },
    });
    echoBridge.uinUidStore.record("100020002", "u_friend");
    const textRes = await echoBridge.handleOneBotAction("send_private_msg", {
      user_id: 100020002,
      message: "纯文本消息",
    });
    assert.strictEqual(textRes.data.real_id, "7700000000000000101");

    // Direct waiter out-of-order correlation for two distinct images
    const peer = { chatType: 1, peerUid: "u_friend" };
    const wImgA = echoBridge.outboundPipeline._registerSendEchoWaiter(peer, [
      { elementType: 2, picElement: { md5HexStr: "aaaa1111", fileName: "a.png", picSubType: 0 } },
    ]);
    const wImgB = echoBridge.outboundPipeline._registerSendEchoWaiter(peer, [
      { elementType: 2, picElement: { md5HexStr: "bbbb2222", fileName: "b.png", picSubType: 0 } },
    ]);
    // Foreign text echo must match neither image waiter
    assert.strictEqual(
      echoBridge.outboundPipeline._matchSendEcho({
        msgId: "7700000000000000903",
        msgSeq: "93",
        chatType: 1,
        peerUid: "u_friend",
        elements: [{ elementType: 1, textElement: { content: "干扰文本", atType: 0 } }],
      }),
      false
    );
    // Image B arrives before Image A
    assert.strictEqual(
      echoBridge.outboundPipeline._matchSendEcho({
        msgId: "7700000000000000202",
        msgSeq: "202",
        chatType: 1,
        peerUid: "u_friend",
        elements: [{ elementType: 2, picElement: { md5HexStr: "BBBB2222", fileName: "b.png", picSubType: 0 } }],
      }),
      true
    );
    assert.strictEqual(
      echoBridge.outboundPipeline._matchSendEcho({
        msgId: "7700000000000000201",
        msgSeq: "201",
        chatType: 1,
        peerUid: "u_friend",
        elements: [{ elementType: 2, picElement: { md5HexStr: "aaaa1111", fileName: "a.png", picSubType: 0 } }],
      }),
      true
    );
    assert.strictEqual((await wImgA.wait(50)).msgId, "7700000000000000201");
    assert.strictEqual((await wImgB.wait(50)).msgId, "7700000000000000202");
  }

  // 13c. _sendPokeInternal must NOT replay via sendPoke / sendMsg when sendNudge was already dispatched
  {
    const pokeCmds = [];
    const dispatchedFailBridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_self",
      online: true,
      config: { httpServers: [], wsServers: [], wsClients: [], heartbeatIntervalMs: 0, humanSimulation: false },
      rendererExecute: async (cmd) => {
        pokeCmds.push(cmd);
        throw new Error("invokeNtApi timeout (15000ms): nodeIKernelMsgService/sendNudge");
      },
    });
    dispatchedFailBridge.uinUidStore.record("100020002", "u_friend");
    const pokeFailResp = await dispatchedFailBridge.handleOneBotAction("send_poke", {
      group_id: 654321,
      user_id: 100020002,
    });
    assert.strictEqual(pokeFailResp.status, "failed");
    assert.deepStrictEqual(pokeCmds, ["nodeIKernelMsgService/sendNudge"]);

    // When sendNudge & sendPoke are genuinely unavailable, fallback to sendMsg poke faceElement still works
    const fallbackCmds = [];
    const fallbackBridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_self",
      online: true,
      config: { httpServers: [], wsServers: [], wsClients: [], heartbeatIntervalMs: 0, humanSimulation: false },
      rendererExecute: async (cmd) => {
        fallbackCmds.push(cmd);
        if (cmd === "nodeIKernelMsgService/sendNudge" || cmd === "nodeIKernelMsgService/sendPoke") {
          throw new Error("ROSMONTIS_BRIDGE_UNAVAILABLE: handler missing");
        }
        return { result: 0, errMsg: "" };
      },
    });
    fallbackBridge.uinUidStore.record("100020002", "u_friend");
    const pokeOkResp = await fallbackBridge.handleOneBotAction("send_poke", {
      group_id: 654321,
      user_id: 100020002,
    });
    assert.strictEqual(pokeOkResp.status, "ok");
    assert.deepStrictEqual(fallbackCmds, [
      "nodeIKernelMsgService/sendNudge",
      "nodeIKernelMsgService/sendPoke",
      "nodeIKernelMsgService/sendMsg",
    ]);
  }

  // 13d & 13e. HTTP null/non-object JSON body and Forward WS abrupt socket errors must never throw unhandled errors
  {
    let unhandled = null;
    const onUnhandled = (err) => {
      unhandled = err;
    };
    process.on("unhandledRejection", onUnhandled);
    process.on("uncaughtException", onUnhandled);

    const netBridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_self",
      online: true,
      config: {
        httpServers: [{ host: "127.0.0.1", port: 0, accessToken: "" }],
        wsServers: [{ host: "127.0.0.1", port: 0, accessToken: "" }],
        wsClients: [],
        heartbeatIntervalMs: 0,
        humanSimulation: false,
      },
    });
    await netBridge.startServers();
    try {
      const httpPort = netBridge.serverRuntime._httpServers[0].address().port;
      const wsPort = netBridge.serverRuntime._wsServers[0].address().port;

      const postRaw = (urlPath, rawBody) =>
        new Promise((resolve, reject) => {
          const req = http.request(
            {
              hostname: "127.0.0.1",
              port: httpPort,
              path: urlPath,
              method: "POST",
              headers: { "Content-Type": "application/json" },
            },
            (res) => {
              const bufs = [];
              res.on("data", (c) => bufs.push(c));
              res.on("end", () =>
                resolve({ statusCode: res.statusCode, json: JSON.parse(Buffer.concat(bufs).toString("utf8")) })
              );
            }
          );
          req.on("error", reject);
          req.end(rawBody);
        });

      const rNullAction = await postRaw("/get_status?foo=bar", "null");
      assert.strictEqual(rNullAction.statusCode, 200);
      assert.strictEqual(rNullAction.json.status, "ok");

      const rNullRoot = await postRaw("/", "null");
      assert.strictEqual(rNullRoot.statusCode, 200);
      assert.strictEqual(rNullRoot.json.status, "failed");

      const rPrim = await postRaw("/get_status", "123");
      assert.strictEqual(rPrim.json.status, "ok");

      const rArr = await postRaw("/get_status", "[1,2,3]");
      assert.strictEqual(rArr.json.status, "ok");

      const rNullNested = await postRaw("/", JSON.stringify({ action: "get_status", params: null }));
      assert.strictEqual(rNullNested.json.status, "ok");

      // Upgrade Forward WebSocket client and trigger socket error + TCP reset
      const clientSock = net.connect(wsPort, "127.0.0.1");
      await new Promise((resolve, reject) => {
        const secKey = crypto.randomBytes(16).toString("base64");
        let buf = "";
        clientSock.on("connect", () => {
          clientSock.write(
            [
              "GET / HTTP/1.1",
              `Host: 127.0.0.1:${wsPort}`,
              "Upgrade: websocket",
              "Connection: Upgrade",
              `Sec-WebSocket-Key: ${secKey}`,
              "Sec-WebSocket-Version: 13",
              "",
              "",
            ].join("\r\n")
          );
        });
        clientSock.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          if (buf.includes("101 Switching Protocols")) resolve();
        });
        clientSock.on("error", reject);
      });

      assert.strictEqual(netBridge.serverRuntime._wsServerClients.size, 1);
      const srvConn = Array.from(netBridge.serverRuntime._wsServerClients)[0];
      // Directly emit a socket error on the server-side upgraded socket (simulating ECONNRESET)
      srvConn.socket.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
      clientSock.destroy();
      await new Promise((r) => setTimeout(r, 30));

      assert.strictEqual(netBridge.serverRuntime._wsServerClients.size, 0, "errored Forward WS client must be evicted");
      assert.strictEqual(unhandled, null, `Unexpected unhandled error: ${unhandled}`);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      process.removeListener("uncaughtException", onUnhandled);
      await netBridge.stopServers();
    }
  }
});
