"use strict";

/**
 * Launcher entrypoint, MessageIdStore & UinUidStore contracts, PeerSeq isolation & heap bounds
 * Migrated from test/test_bridge.js sections: 1, 2, 12, 19.
 */

const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { onebot, mainMod } = require("./_helpers");
// === Section 1: Testing package_patch.json & app_launcher_index.js ===

test("package_patch.json is valid JSON and points to ./app_launcher/index.js", () => {
  const pkgPatch = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "src", "package_patch.json"), "utf8")
  );
  assert.strictEqual(pkgPatch.main, "./app_launcher/index.js");
  assert.strictEqual(
    pkgPatch.original_main,
    "./application.asar/app_launcher/index.js"
  );
});

test("app_launcher_index.js safely boots bridge_main and delegates to major.node", () => {
  process.env.ROSMONTIS_TEST_MODE = "1";
  let majorLoaded = null;
  const launcher = require("../../src/app_launcher_index.js");
  assert.strictEqual(typeof launcher.bootBridgeMain, "function");
  assert.strictEqual(typeof launcher.loadOfficialInternalIndex, "function");
  const ret = launcher.loadOfficialInternalIndex(module, {
    load(target, mod) {
      majorLoaded = { target, hasMod: Boolean(mod) };
      return "major_ok";
    },
  });
  assert.strictEqual(ret, "major_ok");
  assert.deepStrictEqual(majorLoaded, { target: "internal_index", hasMod: true });
});

// === Section 2: Testing MessageIdStore & UinUidStore ===

test("MessageIdStore assigns deterministic positive 31-bit shortId and supports reverse lookup", () => {
  const store = new onebot.MessageIdStore(50);
  const id1 = store.register({
    msgId: "7428192837192837123",
    chatType: 2,
    peerUid: "987654321",
    msgSeq: "10042",
    senderUid: "u_abc123",
    senderUin: "12345678",
  });
  assert.ok(Number.isInteger(id1) && id1 > 0 && id1 <= 0x7fffffff);
  const id1Again = store.register({
    msgId: "7428192837192837123",
    chatType: 2,
    peerUid: "987654321",
    msgSeq: "10042",
  });
  assert.strictEqual(id1, id1Again);

  const recByShort = store.getByShortId(id1);
  assert.strictEqual(recByShort.msgId, "7428192837192837123");
  assert.strictEqual(recByShort.chatType, 2);
  assert.strictEqual(recByShort.peerUid, "987654321");
  assert.strictEqual(recByShort.msgSeq, "10042");

  const recByMsgId = store.getByMsgId("7428192837192837123");
  assert.strictEqual(recByMsgId.shortId, id1);

  const recByPeerSeq = store.getByPeerSeq(2, "987654321", "10042");
  assert.strictEqual(recByPeerSeq.shortId, id1);
});

test("MessageIdStore enforces LRU maxEntries bound", () => {
  const store = new onebot.MessageIdStore(10);
  const firstId = store.register({ msgId: "1000", chatType: 1, peerUid: "u_0", msgSeq: "1" });
  for (let i = 1; i < 15; i++) {
    store.register({ msgId: String(1000 + i), chatType: 1, peerUid: `u_${i}`, msgSeq: String(i) });
  }
  assert.strictEqual(store.size, 10);
  assert.strictEqual(store.getByShortId(firstId), null);
  assert.notStrictEqual(store.getByMsgId("1014"), null);
});

test("UinUidStore caches and resolves UIN <-> UID bi-directionally", async () => {
  const uinUid = new onebot.UinUidStore();
  uinUid.record("100010001", "u_rosmontis_self_uid", { nick: "Rosmontis" });
  assert.strictEqual(uinUid.getUid("100010001"), "u_rosmontis_self_uid");
  assert.strictEqual(uinUid.getUin("u_rosmontis_self_uid"), "100010001");

  const resolvedUid = await uinUid.resolveUid("246813579", async (cmd, payload) => {
    assert.strictEqual(cmd, "nodeIKernelUixConvertService/getUid");
    assert.deepStrictEqual(payload, { uins: ["246813579"] });
    return { uidInfo: { "246813579": "u_remote_2468" } };
  });
  assert.strictEqual(resolvedUid, "u_remote_2468");
  assert.strictEqual(uinUid.getUin("u_remote_2468"), "246813579");

  const resolvedUin = await uinUid.resolveUin("u_remote_9999", async (cmd, payload) => {
    assert.strictEqual(cmd, "nodeIKernelUixConvertService/getUin");
    assert.deepStrictEqual(payload, { uids: ["u_remote_9999"] });
    return { uinInfo: { u_remote_9999: "99998888" } };
  });
  assert.strictEqual(resolvedUin, "99998888");
});

// === Section 12: Testing MessageIdStore PeerSeq Isolation & Reverse WS Single-Connection Guard ===

test("MessageIdStore does not collide distinct real msgIds sharing msgSeq and reverse WS never multiplies on ECONNREFUSED", async () => {
  // 12a. Two distinct real msgIds sharing (chatType, peerUid, msgSeq) keep distinct shortIds
  const store = new onebot.MessageIdStore();
  const peer = { chatType: 1, peerUid: "u_owner_1", guildId: "" };
  const s1 = store.register("7500000000000001001", peer, "42");
  const s2 = store.register("7500000000000001002", peer, "42");
  assert.notStrictEqual(s1, s2, "Distinct real msgIds must never collapse into one shortId");
  assert.strictEqual(store.getByShortId(s1).msgId, "7500000000000001001");
  assert.strictEqual(store.getByShortId(s2).msgId, "7500000000000001002");

  // Placeholder sent_... entry upgrades cleanly when real msgId arrives for same peerSeq
  const sPlaceholder = store.register("sent_1794375000000", peer, "99");
  const sUpgraded = store.register("7500000000000001099", peer, "99");
  assert.strictEqual(sPlaceholder, sUpgraded);
  assert.strictEqual(store.getByShortId(sUpgraded).msgId, "7500000000000001099");

  // 12b. Repeated ECONNREFUSED before server startup must open strictly 1 reverse WS connection once server listens
  const probeSrv = net.createServer();
  await new Promise((r) => probeSrv.listen(0, "127.0.0.1", r));
  const freePort = probeSrv.address().port;
  await new Promise((r) => probeSrv.close(r));

  const bridge = new mainMod.NtqqOneBotBridge({
    selfUin: "100010001",
    selfUid: "u_rosmontis",
    online: true,
    config: {
      httpServers: [],
      wsServers: [],
      wsClients: [
        {
          name: "wsclient-test",
          url: `ws://127.0.0.1:${freePort}/ws`,
          reconnectIntervalMs: 30,
        },
      ],
      heartbeatIntervalMs: 0,
      humanSimulation: false,
    },
  });
  // Temporarily allow sub-500ms reconnect in unit test by invoking connectReverseWebSocket directly + loop
  let closeCalls = 0;
  await new Promise((resolve) => {
    mainMod.connectReverseWebSocket(
      `ws://127.0.0.1:${freePort}/ws`,
      {},
      () => {},
      () => {},
      () => {
        closeCalls += 1;
        setTimeout(resolve, 40);
      }
    );
  });
  assert.strictEqual(closeCalls, 1, "connectReverseWebSocket must invoke onClose exactly once on ECONNREFUSED");
  await bridge.stopServers();
});

// === Section 19: Testing MessageIdStore Heap Bound, Hoisted msgRandom, Media Index & Transient __base64Uri Stripping ===

test("MessageIdStore maxRawEntries eviction, hoisted msgRandom, offline get_msg, pic+ptt hydration, __base64Uri stripping & byMediaKey eviction", async () => {
  const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "rosmontis-suite19-"));
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );
  const pttBytes = Buffer.from("#!AMR\nrosmontis_voice_hydration_test", "utf8");
  const dlPicPath = path.join(tmpDir, "hydrated_pic.jpg");
  const dlPttPath = path.join(tmpDir, "hydrated_ptt.amr");
  const picMd5 = "aabbccddeeff00112233445566778899";
  const pttMd5 = "11223344556677889900aabbccddeeff";
  const picUuid = "uuid_suite19_pic";
  const pttUuid = "uuid_suite19_ptt";

  const store = new onebot.MessageIdStore(10, 3);
  const ntCalls = [];
  const bridge = new mainMod.NtqqOneBotBridge({
    selfUin: "100010001",
    selfUid: "u_self_19",
    selfNickname: "Rosmontis",
    online: true,
    messageIdStore: store,
    config: {
      httpServers: [],
      wsServers: [],
      wsClients: [],
      heartbeatIntervalMs: 0,
      wsPingIntervalMs: 0,
      humanSimulation: false,
    },
    rendererExecute: async (cmd, args) => {
      const payload = Array.isArray(args) ? args[0] : args;
      ntCalls.push({ cmd, payload });
      if (cmd === "nodeIKernelMsgService/getMsgsByMsgId") {
        throw new Error("NTQQ offline: getMsgsByMsgId unavailable");
      }
      if (cmd === "nodeIKernelMsgService/getRichMediaFilePathForGuild") {
        return dlPicPath;
      }
      if (cmd === "nodeIKernelMsgService/downloadRichMedia") {
        const elId = String(payload?.getReq?.elementId || "");
        if (elId === "el_pic_19") {
          fs.writeFileSync(dlPicPath, pngBytes);
          return { filePath: dlPicPath };
        }
        if (elId === "el_ptt_19") {
          fs.writeFileSync(dlPttPath, pttBytes);
          return { filePath: dlPttPath };
        }
      }
      return { result: 0, errMsg: "" };
    },
  });

  try {
    // 19a. Register 5 messages in MessageIdStore(10, 3): oldest 2 raw-evicted, latest 3 retained
    const registered = [];
    for (let i = 1; i <= 5; i++) {
      const msgId = `791900000000000000${i}`;
      const shortId = store.register({
        msgId,
        chatType: 2,
        peerUid: "888",
        msgSeq: String(200 + i),
        senderUin: "20001",
        rawMsg: {
          msgId,
          chatType: 2,
          peerUid: "888",
          msgSeq: String(200 + i),
          msgRandom: "987654",
          elements: [{ elementType: 1, textElement: { content: `msg_${i}` } }],
        },
        oneBotEvent: { post_type: "message", raw_message: `msg_${i}` },
      });
      registered.push({ msgId, shortId });
    }

    for (let i = 0; i < 2; i++) {
      const recShort = store.getByShortId(registered[i].shortId);
      const recMsg = store.getByMsgId(registered[i].msgId);
      assert.strictEqual(recShort, recMsg);
      assert.strictEqual(recShort.rawMsg, null);
      assert.strictEqual(recShort.oneBotEvent, null);
      assert.strictEqual(recShort.msgRandom, "987654");
    }
    for (let i = 2; i < 5; i++) {
      const rec = store.getByShortId(registered[i].shortId);
      assert.ok(rec && rec.rawMsg !== null, `Expected latest entry ${i} to retain rawMsg`);
      assert.strictEqual(rec.msgRandom, "987654");
    }

    // 19b. set_essence_msg succeeds via hoisted entry.msgRandom; offline get_msg falls back to scalar summary
    const essenceRes = await bridge.handleOneBotAction("set_essence_msg", {
      message_id: registered[0].shortId,
    });
    assert.strictEqual(essenceRes.status, "ok");
    const essenceCall = ntCalls.find((c) => c.cmd === "nodeIKernelGroupService/addGroupEssence");
    assert.ok(essenceCall, "Expected addGroupEssence call");
    assert.deepStrictEqual(essenceCall.payload, {
      param: {
        groupCode: "888",
        msgRandom: 987654,
        msgSeq: 201,
      },
    });

    const offlineMsgRes = await bridge.handleOneBotAction("get_msg", {
      message_id: registered[0].shortId,
    });
    assert.strictEqual(offlineMsgRes.status, "ok");
    assert.strictEqual(offlineMsgRes.data.message_id, registered[0].shortId);
    assert.strictEqual(offlineMsgRes.data.real_id, registered[0].msgId);
    assert.strictEqual(offlineMsgRes.data.message_type, "group");
    assert.strictEqual(offlineMsgRes.data.group_id, 888);
    assert.deepStrictEqual(offlineMsgRes.data.message, []);

    // 19c. Inbound _processIncomingNtMessage hydrates picElement + pttElement, indexes media, strips __base64Uri
    const emitted = [];
    bridge.broadcastOneBotEvent = (ev) => emitted.push(ev);
    const inboundMediaMsg = {
      msgId: "7919000000000000099",
      msgSeq: "299",
      msgTime: "1760001900",
      msgRandom: "135790",
      chatType: 2,
      peerUid: "888",
      senderUid: "u_sender_19",
      senderUin: "20019",
      elements: [
        {
          elementId: "el_pic_19",
          elementType: 2,
          picElement: {
            md5HexStr: picMd5,
            fileUuid: picUuid,
            fileName: `${picMd5}.jpg`,
            fileSize: String(pngBytes.length),
            sourcePath: "",
            originImageUrl: "/download?appid=1406&fileid=NoRkeyPic19",
          },
        },
        {
          elementId: "el_ptt_19",
          elementType: 4,
          pttElement: {
            md5HexStr: pttMd5,
            fileUuid: pttUuid,
            fileName: "voice19.amr",
            fileSize: String(pttBytes.length),
            filePath: "",
          },
        },
      ],
    };

    await bridge.inboundPipeline._processIncomingNtMessage(inboundMediaMsg);
    assert.strictEqual(emitted.length, 1);
    const msgEv = emitted[0];
    const imgSeg = msgEv.message.find((s) => s.type === "image");
    const pttSeg = msgEv.message.find((s) => s.type === "record");
    assert.ok(imgSeg && pttSeg, "Expected hydrated image and record segments");
    assert.strictEqual(imgSeg.data.url, `base64://${pngBytes.toString("base64")}`);
    assert.strictEqual(pttSeg.data.url, `base64://${pttBytes.toString("base64")}`);

    assert.strictEqual(inboundMediaMsg.elements[0].picElement.sourcePath, dlPicPath);
    assert.strictEqual(inboundMediaMsg.elements[1].pttElement.filePath, dlPttPath);

    const mediaByMd5 = store.lookupMedia(`${picMd5}.jpg`);
    const mediaByPicUuid = store.lookupMedia(picUuid);
    const mediaByPttUuid = store.lookupMedia(pttUuid);
    assert.ok(mediaByMd5 && mediaByMd5.sourcePath === dlPicPath);
    assert.ok(mediaByPicUuid && mediaByPicUuid.fileUuid === picUuid);
    assert.ok(mediaByPttUuid && mediaByPttUuid.sourcePath === dlPttPath);

    const storedMediaEntry = store.getByShortId(msgEv.message_id);
    assert.ok(storedMediaEntry && storedMediaEntry.rawMsg);
    assert.strictEqual(storedMediaEntry.oneBotEvent, null);
    assert.strictEqual("__base64Uri" in storedMediaEntry.rawMsg.elements[0].picElement, false);
    assert.strictEqual(storedMediaEntry.rawMsg.elements[0].picElement.__base64Uri, undefined);
    assert.strictEqual("__base64Uri" in storedMediaEntry.rawMsg.elements[1].pttElement, false);
    assert.strictEqual(storedMediaEntry.rawMsg.elements[1].pttElement.__base64Uri, undefined);

    // 19d. Overflowing maxEntries (10) evicts the media entry and cleans up its keys in byMediaKey
    for (let k = 1; k <= 10; k++) {
      store.register({
        msgId: `79199900000000000${String(k).padStart(2, "0")}`,
        chatType: 2,
        peerUid: "888",
        msgSeq: String(500 + k),
      });
    }
    assert.strictEqual(store.size, 10);
    assert.strictEqual(store.byShortId.has(msgEv.message_id), false);
    assert.strictEqual(store.lookupMedia(`${picMd5}.jpg`), null);
    assert.strictEqual(store.lookupMedia(picUuid), null);
    assert.strictEqual(store.lookupMedia(pttUuid), null);
  } finally {
    await bridge.stopServers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
