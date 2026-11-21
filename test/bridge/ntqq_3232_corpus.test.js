// @ts-check
"use strict";

/**
 * NTQQ 3.2.32 Desensitized Real-World Fixture Corpus Contract Tests
 * (`test/fixtures/ntqq_3_2_32_corpus.json`)
 */

const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { REPO_ROOT, onebot, mainMod } = require("./_helpers");

const CORPUS_PATH = path.join(REPO_ROOT, "test", "fixtures", "ntqq_3_2_32_corpus.json");
const CORPUS = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8"));

function createPopulatedStores() {
  const uinUidStore = new onebot.UinUidStore(1000);
  const messageIdStore = new onebot.MessageIdStore(1000);
  for (const [uid, uin] of Object.entries(CORPUS.uid_uin_map || {})) {
    uinUidStore.remember(String(uin), String(uid));
  }
  return { uinUidStore, messageIdStore };
}

test("Corpus case 1: marketFaceElement synthesizes gxh.vip.qq.com URL & quote resolves string '0' UIN via UID map", () => {
  const { uinUidStore, messageIdStore } = createPopulatedStores();
  const c = CORPUS.cases.mface_standalone_and_quote;

  const mfaceEv = onebot.formatNtMsgToOneBotEvent(c.mface_msg, {
    selfId: "1000000002",
    uinUidStore,
    messageIdStore,
    messageFormat: "array",
  });
  assert.ok(mfaceEv);
  const mfaceSeg = mfaceEv.message.find((/** @type {any} */ s) => s.type === "mface");
  assert.ok(mfaceSeg, "mface segment must be emitted");
  assert.match(String(mfaceSeg.data.url || ""), /gxh\.vip\.qq\.com/);
  assert.strictEqual(mfaceSeg.data.summary, "[抱着尾巴睡]");

  const quoteEv = onebot.formatNtMsgToOneBotEvent(c.quote_ask_msg, {
    selfId: "1000000002",
    uinUidStore,
    messageIdStore,
    messageFormat: "array",
  });
  assert.ok(quoteEv);
  assert.strictEqual(quoteEv.user_id, 10001001, "senderUin='0' must resolve via senderUid map");
  const replySeg = quoteEv.message.find((/** @type {any} */ s) => s.type === "reply");
  assert.ok(replySeg, "reply segment must be emitted");
  assert.strictEqual(String(replySeg.data.id), String(mfaceEv.message_id));
  const atSeg = quoteEv.message.find((/** @type {any} */ s) => s.type === "at");
  assert.ok(atSeg && String(atSeg.data.qq) === "1000000002");
});

test("Corpus case 2 & 3: nested forward preserves rootMsgId and multi-image virtual nodes honor hydration budget", async () => {
  const { uinUidStore, messageIdStore } = createPopulatedStores();
  const bridge = new mainMod.NtqqOneBotBridge({
    config: {
      selfUin: "1000000002",
      httpServers: [],
      wsServers: [],
      wsClients: [],
      heartbeatIntervalMs: 0,
      humanSimulation: false,
      quietLogs: true,
      forwardMediaHydrationBudgetMs: 300,
    },
    uinUidStore,
    messageIdStore,
  });

  // Case 2: multi-image virtual forward bounded by hydration budget
  const c2 = CORPUS.cases.forward_multi_image_virtual_hang;
  const outer2Id = messageIdStore.register(
    c2.outer_msg.msgId,
    { chatType: c2.outer_msg.chatType, peerUid: c2.outer_msg.peerUid, guildId: "" },
    c2.outer_msg.msgSeq,
    { rawMsg: c2.outer_msg, senderUid: c2.outer_msg.senderUid }
  );
  assert.ok(outer2Id > 0);

  // Case 3: nested forward preserving outer rootMsgId
  const c3 = CORPUS.cases.nested_forward_root_msgid;
  const outer3Id = messageIdStore.register(
    c3.outer_msg.msgId,
    { chatType: c3.outer_msg.chatType, peerUid: c3.outer_msg.peerUid, guildId: "" },
    c3.outer_msg.msgSeq,
    { rawMsg: c3.outer_msg, senderUid: c3.outer_msg.senderUid }
  );
  assert.ok(outer3Id > 0);

  /** @type {Array<{ rootMsgId: string, parentMsgId: string }>} */
  const multiCalls = [];
  bridge.rendererExecute = async (/** @type {string} */ cmd, /** @type {any[]} */ args) => {
    const p = args?.[0] || {};
    if (cmd === "nodeIKernelMsgService/getMultiMsg") {
      multiCalls.push({ rootMsgId: String(p.rootMsgId), parentMsgId: String(p.parentMsgId) });
      if (String(p.parentMsgId) === c2.outer_msg.msgId) {
        return { result: 0, msgList: c2.virtual_nodes };
      }
      if (String(p.parentMsgId) === c3.outer_msg.msgId) {
        return { result: 0, msgList: c3.outer_children };
      }
      if (String(p.parentMsgId) === "759300312") {
        return { result: 0, msgList: c3.inner_children };
      }
    }
    return { result: 0 };
  };

  const t0 = Date.now();
  const res2 = await bridge._dispatchAction("get_forward_msg", {
    id: "v3_b64_ForwardResId_MultiImg_001",
  });
  const elapsedMs = Date.now() - t0;
  assert.strictEqual(res2.messages.length, 2);
  assert.strictEqual(res2.messages[1].data.user_id, 20002002);
  assert.ok(elapsedMs < 4000, `bounded forward hydration should complete promptly (${elapsedMs}ms)`);

  // Expand outer nested forward, then inner nested forward — inner must keep rootMsgId=759300301
  const res3Outer = await bridge._dispatchAction("get_forward_msg", {
    id: "v3_OuterNestedResId_301",
  });
  assert.strictEqual(res3Outer.messages.length, 2);

  const res3Inner = await bridge._dispatchAction("get_forward_msg", {
    id: "v3_InnerNestedResId_312",
  });
  assert.strictEqual(res3Inner.messages.length, 1);
  assert.strictEqual(res3Inner.messages[0].data.user_id, 20002002);
  const innerCall = multiCalls.find((call) => call.parentMsgId === "759300312");
  assert.ok(innerCall);
  assert.strictEqual(innerCall.rootMsgId, c3.outer_msg.msgId);
});

test("Corpus case 4 & 5: wallet redbag, Ark JSON card, and grayTip UID-only recall events", () => {
  const { uinUidStore, messageIdStore } = createPopulatedStores();
  const c4 = CORPUS.cases.wallet_redbag_and_ark_json;

  const redbagEv = onebot.formatNtMsgToOneBotEvent(c4.redbag_msg, {
    selfId: "1000000002",
    uinUidStore,
    messageIdStore,
    messageFormat: "array",
  });
  assert.ok(redbagEv);
  const redbagSeg = redbagEv.message.find((/** @type {any} */ s) => s.type === "redbag");
  assert.ok(redbagSeg, "walletElement must serialize as OneBot redbag segment");
  assert.strictEqual(redbagSeg.data.title, "版本上线大吉");

  const arkEv = onebot.formatNtMsgToOneBotEvent(c4.ark_bili_msg, {
    selfId: "1000000002",
    uinUidStore,
    messageIdStore,
    messageFormat: "array",
  });
  assert.ok(arkEv);
  const jsonSeg = arkEv.message.find((/** @type {any} */ s) => s.type === "json");
  assert.ok(jsonSeg && String(jsonSeg.data.data || "").includes("BV1xx411c7mD"));

  const c5 = CORPUS.cases.graytip_recall_truthy_zero_uin;
  const recallNotice = onebot.formatNtMsgToOneBotEvent(c5.recall_msg, {
    selfId: "1000000002",
    uinUidStore,
    messageIdStore,
  });
  assert.ok(recallNotice);
  assert.strictEqual(recallNotice.post_type, "notice");
  assert.strictEqual(recallNotice.notice_type, "group_recall");
  assert.strictEqual(recallNotice.operator_id, 10001001);
  assert.strictEqual(recallNotice.user_id, 20002002);
});
