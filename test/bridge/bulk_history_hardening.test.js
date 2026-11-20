"use strict";

const test = require("node:test");
const assert = require("assert");

const { mainMod } = require("./_helpers");
const { NtqqOneBotBridge } = mainMod;
const { loadBridgeConfig } = require("../../src/core/config");

function makeSilentConfig(extra = {}) {
  return {
    quietLogs: true,
    httpServers: [],
    wsServers: [],
    wsClients: [],
    httpClients: [],
    humanSimulation: false,
    ...extra,
  };
}

test("get_group_msg_history with skipRemoteDownload fires zero getRichMediaFilePathForGuild RPCs", async () => {
  const ntCalls = [];
  const bridge = new NtqqOneBotBridge({
    selfUin: "10001",
    selfUid: "u_self",
    config: makeSilentConfig(),
    ntApi: {
      "nodeIKernelMsgService/sendMsg": async () => ({ result: 0 }),
      "nodeIKernelMsgService/getMsgsIncludeSelf": async (payload) => {
        ntCalls.push({ cmd: "nodeIKernelMsgService/getMsgsIncludeSelf", payload });
        return {
          msgList: [
            {
              msgId: "7900000000000000001",
              msgSeq: "101",
              chatType: 2,
              peerUid: String(payload.peer.peerUid),
              senderUin: "20001",
              senderUid: "u_20001",
              msgTime: "1700000100",
              elements: [
                {
                  elementId: "el_pic_1",
                  elementType: 2,
                  picElement: {
                    md5HexStr: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    fileName: "uncached_1.jpg",
                    fileUuid: "uuid_pic_1",
                    sourcePath: "",
                    originImageUrl: "/download?appid=1407&fileid=abc",
                  },
                },
                {
                  elementId: "el_ptt_1",
                  elementType: 4,
                  pttElement: {
                    md5HexStr: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    fileName: "uncached_1.amr",
                    fileUuid: "uuid_ptt_1",
                    filePath: "",
                    duration: 3,
                  },
                },
              ],
            },
          ],
        };
      },
      "nodeIKernelMsgService/getRichMediaFilePathForGuild": async (payload) => {
        ntCalls.push({ cmd: "nodeIKernelMsgService/getRichMediaFilePathForGuild", payload });
        return "/tmp/should_not_be_called.jpg";
      },
    },
  });

  const reply = await bridge.handleOneBotAction("get_group_msg_history", {
    group_id: 998877,
    count: 60,
  });
  assert.strictEqual(reply.status, "ok");
  assert.strictEqual(reply.data.messages.length, 1);

  const pathGuildCalls = ntCalls.filter(
    (c) => c.cmd === "nodeIKernelMsgService/getRichMediaFilePathForGuild"
  );
  assert.strictEqual(
    pathGuildCalls.length,
    0,
    "Bulk history fetch must NOT fire getRichMediaFilePathForGuild(needCreate:true) RPCs"
  );
  const historyCalls = ntCalls.filter(
    (c) => c.cmd === "nodeIKernelMsgService/getMsgsIncludeSelf"
  );
  assert.strictEqual(historyCalls.length, 1);
  await bridge.stopServers();
});

test("get_group_msg_history uses main-process ntApi fast-path without degraded count, respects opt-out & keeps send_group_msg on Tier 1", async () => {
  const rendererCalls = [];
  const mainCalls = [];

  const makeMockWebContents = () => ({
    id: 1,
    isDestroyed: () => false,
    getURL: () => "app://./main/index.html",
    executeJavaScript: async (js) => {
      const m = /invokeNtApiSerialized\("([^"]+)"/.exec(String(js));
      const cmd = m ? m[1] : "unknown";
      rendererCalls.push(cmd);
      if (cmd === "nodeIKernelMsgService/getMsgsIncludeSelf") {
        return JSON.stringify({
          msgList: [
            {
              msgId: "7900000000000000010",
              msgSeq: "201",
              chatType: 2,
              peerUid: "776655",
              senderUin: "20002",
              msgTime: "1700000200",
              elements: [{ elementType: 1, textElement: { content: "from-renderer" } }],
            },
          ],
        });
      }
      if (cmd === "nodeIKernelMsgService/sendMsg") {
        return JSON.stringify({ result: 0, errMsg: "" });
      }
      return JSON.stringify({ result: 0 });
    },
  });

  // 1. Default: preferMainProcessForBulkReads === true -> direct Tier 2 fast-path, degraded === 0
  const bridge = new NtqqOneBotBridge({
    selfUin: "10001",
    selfUid: "u_self",
    config: makeSilentConfig({ sendEchoTimeoutMs: 50 }),
    ntApi: {
      "nodeIKernelMsgService/sendMsg": async () => {
        mainCalls.push("nodeIKernelMsgService/sendMsg");
        return { result: 0 };
      },
      "nodeIKernelMsgService/getMsgsIncludeSelf": async () => {
        mainCalls.push("nodeIKernelMsgService/getMsgsIncludeSelf");
        return {
          msgList: [
            {
              msgId: "7900000000000000009",
              msgSeq: "200",
              chatType: 2,
              peerUid: "776655",
              senderUin: "20002",
              msgTime: "1700000200",
              elements: [{ elementType: 1, textElement: { content: "from-main-fastpath" } }],
            },
          ],
        };
      },
    },
  });
  bridge.activeWebContents = makeMockWebContents();

  const histRes = await bridge.handleOneBotAction("get_group_msg_history", {
    group_id: 776655,
    count: 60,
  });
  assert.strictEqual(histRes.status, "ok");
  assert.strictEqual(histRes.data.messages[0].raw_message, "from-main-fastpath");
  assert.deepStrictEqual(mainCalls, ["nodeIKernelMsgService/getMsgsIncludeSelf"]);
  assert.deepStrictEqual(rendererCalls, [], "Renderer IPC must be bypassed for bulk history read");
  assert.strictEqual(bridge.invokeStats.directMain, 1);
  assert.strictEqual(bridge.invokeStats.degraded, 0, "Intentional directMain fast-path must not count as degraded");

  // Side-effect send_group_msg must still go through Tier 1 renderer IPC
  await bridge.handleOneBotAction("send_group_msg", {
    group_id: 776655,
    message: "hello-tier1",
  });
  assert.ok(
    rendererCalls.includes("nodeIKernelMsgService/sendMsg"),
    "Side-effect sendMsg must stay on Tier 1 renderer IPC"
  );
  assert.strictEqual(
    mainCalls.includes("nodeIKernelMsgService/sendMsg"),
    false,
    "sendMsg must not bypass Tier 1"
  );
  await bridge.stopServers();

  // 2. Opt-out: preferMainProcessForBulkReads === false -> routes history via Tier 1 renderer IPC
  rendererCalls.length = 0;
  mainCalls.length = 0;
  const bridgeOptOut = new NtqqOneBotBridge({
    selfUin: "10001",
    selfUid: "u_self",
    config: makeSilentConfig({ preferMainProcessForBulkReads: false }),
    ntApi: {
      "nodeIKernelMsgService/sendMsg": async () => ({ result: 0 }),
      "nodeIKernelMsgService/getMsgsIncludeSelf": async () => {
        mainCalls.push("nodeIKernelMsgService/getMsgsIncludeSelf");
        return { msgList: [] };
      },
    },
  });
  bridgeOptOut.activeWebContents = makeMockWebContents();
  const optOutRes = await bridgeOptOut.handleOneBotAction("get_group_msg_history", {
    group_id: 776655,
    count: 20,
  });
  assert.strictEqual(optOutRes.status, "ok");
  assert.strictEqual(optOutRes.data.messages[0].raw_message, "from-renderer");
  assert.deepStrictEqual(rendererCalls, ["nodeIKernelMsgService/getMsgsIncludeSelf"]);
  assert.deepStrictEqual(mainCalls, []);
  await bridgeOptOut.stopServers();

  // 3. Env var parsing check
  const prevEnv = process.env.ROSMONTIS_PREFER_MAIN_PROCESS_FOR_BULK_READS;
  try {
    delete process.env.ROSMONTIS_PREFER_MAIN_PROCESS_FOR_BULK_READS;
    assert.strictEqual(loadBridgeConfig("/nonexistent-dir-xyz").preferMainProcessForBulkReads, true);
    process.env.ROSMONTIS_PREFER_MAIN_PROCESS_FOR_BULK_READS = "0";
    assert.strictEqual(loadBridgeConfig("/nonexistent-dir-xyz").preferMainProcessForBulkReads, false);
  } finally {
    if (prevEnv === undefined) delete process.env.ROSMONTIS_PREFER_MAIN_PROCESS_FOR_BULK_READS;
    else process.env.ROSMONTIS_PREFER_MAIN_PROCESS_FOR_BULK_READS = prevEnv;
  }
});

test("onMsgInfoListUpdate deduplicates identical main + renderer deliveries while preserving distinct updates", async () => {
  let getUinCalls = 0;
  const emitted = [];
  const bridge = new NtqqOneBotBridge({
    selfUin: "10001",
    selfUid: "u_self",
    config: makeSilentConfig(),
    ntApi: {
      "nodeIKernelMsgService/sendMsg": async () => ({ result: 0 }),
      "nodeIKernelUixConvertService/getUin": async () => {
        getUinCalls += 1;
        return { uinInfo: new Map() };
      },
    },
  });
  bridge.on("onebot_event", (ev) => emitted.push(ev));

  const dupPayload = [
    [
      {
        msgId: "7900000000000000333",
        msgSeq: "333",
        chatType: 2,
        peerUid: "888333",
        senderUid: "u_unknown_333",
        senderUin: "0",
        elements: [{ elementType: 1, textElement: { content: "hi" } }],
        emojiLikesList: [{ emojiId: "128077", emojiType: 2, likesCnt: 1 }],
      },
    ],
  ];

  // Deliver twice (simulating main ntStore.emitter + renderer-forwarded RM_IPCFROM_MAIN)
  await bridge._handleKernelEvent("nodeIKernelMsgListener", "onMsgInfoListUpdate", dupPayload);
  await bridge._handleKernelEvent("nodeIKernelMsgListener", "onMsgInfoListUpdate", dupPayload);

  assert.strictEqual(
    getUinCalls,
    1,
    "Duplicate onMsgInfoListUpdate must be deduplicated before _resolveNtMsgUids"
  );

  // Distinct update (emoji likes count changed 1 -> 2) must still be processed
  const updatedPayload = [
    [
      {
        msgId: "7900000000000000333",
        msgSeq: "333",
        chatType: 2,
        peerUid: "888333",
        senderUid: "u_known_334",
        senderUin: "334455",
        elements: [{ elementType: 1, textElement: { content: "hi" } }],
        emojiLikesList: [{ emojiId: "128077", emojiType: 2, likesCnt: 2 }],
      },
    ],
  ];
  await bridge._handleKernelEvent("nodeIKernelMsgListener", "onMsgInfoListUpdate", updatedPayload);
  const emojiNotices = emitted.filter((e) => e.notice_type === "group_msg_emoji_like");
  assert.strictEqual(
    emojiNotices.length,
    2,
    "Expected 1 notice from initial delivery + 1 from updated count (duplicate suppressed)"
  );
  assert.strictEqual(emojiNotices[0].likes[0].count, 1);
  assert.strictEqual(emojiNotices[1].likes[0].count, 2);

  await bridge.stopServers();
});
