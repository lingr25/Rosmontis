"use strict";

const assert = require("assert");
const crypto = require("crypto");
const EventEmitter = require("events");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");

// Silence throttled degrade/blocked-replay warnings from bridge_main during tests.
process.env.ROSMONTIS_QUIET = process.env.ROSMONTIS_QUIET || "1";

const onebot = require("../src/bridge_onebot.js");
const rendererMod = require("../src/bridge_renderer.js");
const mainMod = require("../src/bridge_main.js");

async function runTests() {
  let passed = 0;
  function check(name, fn) {
    return Promise.resolve()
      .then(fn)
      .then(() => {
        passed += 1;
        console.log(`  [PASS] ${name}`);
      });
  }

  console.log("=== 1. Testing package_patch.json & app_launcher_index.js ===");
  await check("package_patch.json is valid JSON and points to ./app_launcher/index.js", () => {
    const pkgPatch = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "src", "package_patch.json"), "utf8")
    );
    assert.strictEqual(pkgPatch.main, "./app_launcher/index.js");
    assert.strictEqual(
      pkgPatch.original_main,
      "./application.asar/app_launcher/index.js"
    );
  });

  await check("app_launcher_index.js safely boots bridge_main and delegates to major.node", () => {
    process.env.ROSMONTIS_TEST_MODE = "1";
    let majorLoaded = null;
    const launcher = require("../src/app_launcher_index.js");
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

  console.log("=== 2. Testing MessageIdStore & UinUidStore ===");
  await check("MessageIdStore assigns deterministic positive 31-bit shortId and supports reverse lookup", () => {
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

  await check("MessageIdStore enforces LRU maxEntries bound", () => {
    const store = new onebot.MessageIdStore(10);
    const firstId = store.register({ msgId: "1000", chatType: 1, peerUid: "u_0", msgSeq: "1" });
    for (let i = 1; i < 15; i++) {
      store.register({ msgId: String(1000 + i), chatType: 1, peerUid: `u_${i}`, msgSeq: String(i) });
    }
    assert.strictEqual(store.size, 10);
    assert.strictEqual(store.getByShortId(firstId), null);
    assert.notStrictEqual(store.getByMsgId("1014"), null);
  });

  await check("UinUidStore caches and resolves UIN <-> UID bi-directionally", async () => {
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

  console.log("=== 3. Testing OneBot Segments <-> NTQQ Elements & Events ===");
  await check("ntMsgToOneBotSegments converts text, @all, @member, reply, face, image, file, record, video, mface, json, forward", () => {
    const msgIdStore = new onebot.MessageIdStore();
    const uinUidStore = new onebot.UinUidStore();
    uinUidStore.record("111222333", "u_target_111");

    const repliedShortId = msgIdStore.register({
      msgId: "7000000000000000001",
      chatType: 2,
      peerUid: "888888",
      msgSeq: "55",
    });

    const ntMsg = {
      msgId: "7000000000000000002",
      msgSeq: "56",
      msgTime: "1730000000",
      chatType: 2,
      peerUid: "888888",
      peerUin: "888888",
      senderUid: "u_sender_1",
      senderUin: "123456789",
      sendMemberName: "博士卡片",
      sendNickName: "博士昵称",
      elements: [
        {
          elementType: 7,
          replyElement: {
            replayMsgId: "7000000000000000001",
            replayMsgSeq: "55",
            senderUin: "111222333",
          },
        },
        {
          elementType: 1,
          textElement: {
            content: "@全体成员",
            atType: 1,
          },
        },
        {
          elementType: 1,
          textElement: {
            content: "@某人",
            atType: 2,
            atNtUid: "u_target_111",
          },
        },
        {
          elementType: 1,
          textElement: {
            content: " 你好 [a,b]&c ",
            atType: 0,
          },
        },
        {
          elementType: 6,
          faceElement: {
            faceIndex: 178,
            faceText: "/斜眼笑",
          },
        },
        {
          elementType: 2,
          picElement: {
            fileName: "cat.png",
            sourcePath: "/tmp/cat.png",
            originImageUrl: "/download?rkey=abc",
            md5HexStr: "0123456789abcdef0123456789abcdef",
            fileSize: "2048",
            picSubType: 0,
          },
        },
        {
          elementType: 4,
          pttElement: {
            fileName: "voice.amr",
            filePath: "/tmp/voice.amr",
          },
        },
        {
          elementType: 5,
          videoElement: {
            fileName: "clip.mp4",
            filePath: "/tmp/clip.mp4",
          },
        },
        {
          elementType: 3,
          fileElement: {
            fileName: "report.pdf",
            filePath: "/tmp/report.pdf",
            fileSize: "4096",
            fileUuid: "uuid-pdf",
          },
        },
        {
          elementType: 10,
          arkElement: {
            bytesData: '{"app":"com.tencent.miniapp"}',
          },
        },
        {
          elementType: 11,
          marketFaceElement: {
            emojiPackageId: 100,
            emojiId: "mface_01",
            key: "key_01",
            faceName: "[大哭]",
          },
        },
        {
          elementType: 16,
          multiForwardMsgElement: {
            resId: "res_forward_123",
            xmlContent: "<msg resid=\"res_forward_123\"/>",
          },
        },
      ],
    };

    const { segments, raw_message } = onebot.ntMsgToOneBotSegments(ntMsg, {
      msgIdStore,
      uinUidStore,
    });

    assert.strictEqual(segments.length, 12);
    assert.deepStrictEqual(segments[0], {
      type: "reply",
      data: { id: String(repliedShortId) },
    });
    assert.strictEqual(segments[1].type, "at");
    assert.strictEqual(segments[1].data.qq, "all");
    assert.strictEqual(segments[2].type, "at");
    assert.strictEqual(segments[2].data.qq, "111222333");
    assert.deepStrictEqual(segments[3], {
      type: "text",
      data: { text: " 你好 [a,b]&c " },
    });
    assert.strictEqual(segments[4].type, "face");
    assert.strictEqual(segments[4].data.id, "178");
    assert.strictEqual(segments[5].type, "image");
    assert.strictEqual(segments[5].data.url, "https://multimedia.nt.qq.com.cn/download?rkey=abc");
    assert.strictEqual(segments[6].type, "record");
    assert.strictEqual(segments[7].type, "video");
    assert.strictEqual(segments[8].type, "file");
    assert.strictEqual(segments[9].type, "json");
    assert.strictEqual(segments[10].type, "mface");
    assert.strictEqual(segments[11].type, "forward");
    assert.strictEqual(segments[11].data.id, "res_forward_123");
    assert.ok(raw_message.includes(`[CQ:reply,id=${repliedShortId}]`));
    assert.ok(raw_message.includes("&#91;a,b&#93;&amp;c"));

    const obEvent = onebot.formatNtMsgToOneBotEvent(ntMsg, {
      selfId: 100010001,
      selfUid: "u_self",
      msgIdStore,
      uinUidStore,
    });
    assert.strictEqual(obEvent.post_type, "message");
    assert.strictEqual(obEvent.message_type, "group");
    assert.strictEqual(obEvent.sub_type, "normal");
    assert.strictEqual(obEvent.group_id, 888888);
    assert.strictEqual(obEvent.user_id, 123456789);
    assert.strictEqual(obEvent.sender.card, "博士卡片");
  });

  await check("oneBotSegmentsToNtElements converts CQ strings and segment arrays including base64 PNG image", async () => {
    const msgIdStore = new onebot.MessageIdStore();
    const uinUidStore = new onebot.UinUidStore();
    uinUidStore.record("555666777", "u_member_555");
    const replyShort = msgIdStore.register({
      msgId: "7111111111111111111",
      chatType: 2,
      peerUid: "999999",
      msgSeq: "88",
      senderUid: "u_member_555",
      senderUin: "555666777",
    });

    // 1x1 valid PNG in base64
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    const { elements, cleanupCallbacks, pokeTargets } =
      await onebot.oneBotSegmentsToNtElements(
        [
          { type: "reply", data: { id: String(replyShort) } },
          { type: "at", data: { qq: "555666777", name: "测试员" } },
          { type: "at", data: { qq: "all" } },
          { type: "text", data: { text: " 收到！" } },
          { type: "face", data: { id: "14" } },
          { type: "image", data: { file: `base64://${pngBase64}`, summary: "[图片]" } },
          { type: "json", data: { data: '{"app":"test"}' } },
          { type: "poke", data: { qq: "555666777" } },
        ],
        {
          chatType: 2,
          peerUid: "999999",
          msgIdStore,
          uinUidStore,
        }
      );

    try {
      assert.strictEqual(elements.length, 7);
      assert.strictEqual(elements[0].elementType, 7);
      assert.strictEqual(elements[0].replyElement.replayMsgId, "7111111111111111111");
      assert.strictEqual(elements[1].elementType, 1);
      assert.strictEqual(elements[1].textElement.atType, 2);
      assert.strictEqual(elements[1].textElement.atNtUid, "u_member_555");
      assert.strictEqual(elements[2].elementType, 1);
      assert.strictEqual(elements[2].textElement.atType, 1);
      assert.strictEqual(elements[3].elementType, 1);
      assert.strictEqual(elements[3].textElement.content, " 收到！");
      assert.strictEqual(elements[4].elementType, 6);
      assert.strictEqual(elements[4].faceElement.faceIndex, 14);
      assert.strictEqual(elements[5].elementType, 2);
      assert.strictEqual(elements[5].picElement.picWidth, 1);
      assert.strictEqual(elements[5].picElement.picHeight, 1);
      assert.strictEqual(elements[6].elementType, 10);
      assert.strictEqual(pokeTargets.length, 1);
    } finally {
      for (const fn of cleanupCallbacks) fn();
    }
  });

  await check("GrayTip recall & poke & group upload notice events format accurately", () => {
    const msgIdStore = new onebot.MessageIdStore();
    const uinUidStore = new onebot.UinUidStore();
    uinUidStore.record("10001", "u_10001");
    uinUidStore.record("10002", "u_10002");

    const recalledShortId = msgIdStore.register({
      msgId: "7222222222222222222",
      chatType: 2,
      peerUid: "777777",
      msgSeq: "99",
    });

    const recallNtMsg = {
      msgId: "7222222222222222222",
      msgSeq: "99",
      msgTime: "1730000100",
      chatType: 2,
      peerUid: "777777",
      senderUid: "u_10001",
      senderUin: "10001",
      elements: [
        {
          elementType: 8,
          grayTipElement: {
            subElementType: 1,
            revokeElement: {
              operatorUid: "u_10002",
              origMsgSenderUid: "u_10001",
            },
          },
        },
      ],
    };
    const recallEv = onebot.formatNtMsgToOneBotEvent(recallNtMsg, {
      selfId: 100010001,
      msgIdStore,
      uinUidStore,
    });
    assert.strictEqual(recallEv.post_type, "notice");
    assert.strictEqual(recallEv.notice_type, "group_recall");
    assert.strictEqual(recallEv.group_id, 777777);
    assert.strictEqual(recallEv.user_id, 10001);
    assert.strictEqual(recallEv.operator_id, 10002);
    assert.strictEqual(recallEv.message_id, recalledShortId);

    const pokeNtMsg = {
      msgId: "7222222222222222223",
      msgSeq: "100",
      msgTime: "1730000200",
      chatType: 2,
      peerUid: "777777",
      senderUid: "u_10001",
      senderUin: "10001",
      elements: [
        {
          elementType: 8,
          grayTipElement: {
            subElementType: 17,
            jsonGrayTipElement: {
              busiId: "1061",
              xmlToJsonParam: {
                templParam: new Map([
                  ["uin_str1", "10001"],
                  ["uin_str2", "100010001"],
                  ["action_str", "戳了戳"],
                  ["suffix_str", "的小脑袋"],
                ]),
              },
            },
          },
        },
      ],
    };
    const pokeEv = onebot.formatNtMsgToOneBotEvent(pokeNtMsg, {
      selfId: 100010001,
      msgIdStore,
      uinUidStore,
    });
    assert.strictEqual(pokeEv.post_type, "notice");
    assert.strictEqual(pokeEv.notice_type, "notify");
    assert.strictEqual(pokeEv.sub_type, "poke");
    assert.strictEqual(pokeEv.user_id, 10001);
    assert.strictEqual(pokeEv.target_id, 100010001);
  });

  console.log("=== 4. Testing bridge_renderer.js in Simulated Window Environment ===");
  await check("bridge_renderer.js sends RM_IPCFROM_RENDERER frames, handles promiseStatue, deduplicates session state, and forwards RM_IPCFROM_MAIN", async () => {
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
    assert.strictEqual(simRes1.addActiveChatByUid, true);
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

  console.log("=== 5. Testing bridge_main.js End-to-End (DI Hooks + 65+ OneBot Actions + HTTP & WS) ===");
  await check("bridge_main.js survives globalIPCMainMap ntApi overwrite, executes 65+ actions with real signatures, and serves HTTP/WS/ReverseWS", async () => {
    const controller = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_rosmontis_self",
      selfNickname: "Rosmontis",
      config: {
        selfUin: "100010001",
        selfNickname: "Rosmontis",
        httpServers: [{ host: "127.0.0.1", port: 0, accessToken: "" }],
        wsServers: [{ host: "127.0.0.1", port: 0, accessToken: "" }],
        wsClients: [],
        heartbeatIntervalMs: 0,
        humanSimulation: false,
        allowExternalHttp: false,
        allowPtloginJump: false,
      },
    });

    // Install Map.prototype.set hook and simulate 908.background.jsc DI registration
    controller.installMapPrototypeHook();
    const diMap = new Map();

    const calledNtApis = [];
    const fakeNtApi = new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop !== "string" || !prop.includes("/")) return undefined;
          // Real NTQQ 3.2.32 ntApi.invoke[cmd] takes (payload, ipcEvent) directly!
          return async (payload, ipcEvent) => {
            assert.ok(
              !Array.isArray(payload),
              `Expected payload for ${prop} to be an object, not an array`
            );
            calledNtApis.push({ cmd: prop, payload, ipcEvent });
            if (prop === "nodeIKernelMsgService/sendMsg") {
              return { result: 0, errMsg: "", msgId: "7500000000000000100" };
            }
            if (prop === "nodeIKernelUixConvertService/getUid") {
              const uidInfo = {};
              for (const u of payload.uins || []) uidInfo[u] = `u_uid_${u}`;
              return { uidInfo };
            }
            if (prop === "nodeIKernelUixConvertService/getUin") {
              const uinInfo = {};
              for (const uid of payload.uids || []) {
                uinInfo[uid] = uid.replace(/^u_uid_/, "") || "123456";
              }
              return { uinInfo };
            }
            if (prop === "nodeIKernelBuddyService/getBuddyList") {
              return {
                data: [
                  {
                    categoryId: 0,
                    categroyName: "我的好友",
                    buddyList: [
                      { uin: "100020002", uid: "u_uid_100020002", nick: "Doctor", remark: "博士" },
                    ],
                  },
                ],
              };
            }
            if (prop === "nodeIKernelGroupService/getGroupList") {
              return {
                groupList: [
                  { groupCode: "654321", groupName: "罗德岛作战群", memberCount: 42, maxMember: 500 },
                ],
              };
            }
            if (
              prop === "nodeIKernelGroupService/getMemberInfo" ||
              prop === "nodeIKernelGroupService/getNextMemberList"
            ) {
              return {
                result: {
                  infos: new Map([
                    [
                      "u_uid_100020002",
                      {
                        uid: "u_uid_100020002",
                        uin: "100020002",
                        nick: "Doctor",
                        cardName: "博士",
                        role: 4,
                      },
                    ],
                  ]),
                },
              };
            }
            if (prop === "nodeIKernelGroupService/createMemberListScene") {
              return { sceneId: "scene_1" };
            }
            if (prop === "nodeIKernelMsgService/translatePtt2Text") {
              return { result: 0, text: "博士你好，这是语音转文字结果" };
            }
            if (prop === "nodeIKernelMsgService/getMsgEmojiLikesList") {
              return {
                result: 0,
                emojiLikesList: [{ emojiId: "128077", emojiType: 2, likesCnt: 1, isClicked: true }],
              };
            }
            if (prop === "nodeIKernelTicketService/forceFetchClientKey") {
              return { result: 0, clientKey: "ck_test_12345" };
            }
            if (prop === "nodeIKernelTipOffService/getPskey") {
              return {
                domainPskeyMap: new Map([
                  ["qun.qq.com", "pskey_qun_123"],
                  ["qzone.qq.com", "pskey_qzone_123"],
                ]),
              };
            }
            if (prop === "nodeIKernelUnitedConfigService/loadUnitedConfig") {
              return { configData: { content: "rkey_private=1&rkey_group=2" } };
            }
            if (prop === "nodeIKernelRichMediaService/downloadFileForModelId") {
              return { url: "https://multimedia.nt.qq.com.cn/group_file_test.pdf" };
            }
            if (prop === "nodeIKernelRichMediaService/downloadFileForFileUuid") {
              return { url: "https://multimedia.nt.qq.com.cn/private_file_test.pdf" };
            }
            return { result: 0, errMsg: "" };
          };
        },
      }
    );

    // 1st Map.set("ntApi", fakeNtApi) in Inversify
    diMap.set("ntApi", fakeNtApi);
    // 2nd Map.set("ntApi", { emit, invoke }) in globalIPCMainMap (real NTQQ 3.2.32 behavior)
    diMap.set("ntApi", { emit: () => {}, invoke: fakeNtApi });

    assert.strictEqual(controller.capturedServices.ntApi, fakeNtApi);

    const msgEmitter = new EventEmitter();
    const groupEmitter = new EventEmitter();
    const buddyEmitter = new EventEmitter();
    const loginEmitter = new EventEmitter();
    const listenerMap = new Map([
      ["nodeIKernelMsgListener", msgEmitter],
      ["nodeIKernelGroupListener", groupEmitter],
    ]);

    const fakeNtStore = {
      listenerEventEmitterMap: listenerMap,
      setNewListenEmitter(name, emitter) {
        this.listenerEventEmitterMap.set(name, emitter);
      },
    };

    function FakeSessionManager() {}
    FakeSessionManager.prototype.createNt = function () {};
    FakeSessionManager.prototype.ntStore = fakeNtStore;
    const fakeSessionMgrInstance = new FakeSessionManager();
    Object.defineProperty(fakeSessionMgrInstance, "ntStore", {
      value: fakeNtStore,
      enumerable: true,
    });

    diMap.set(Symbol("ntSessionManager"), [{ cache: fakeSessionMgrInstance }]);
    // Dynamically register buddy & login listeners via setNewListenEmitter (real post-login flow)
    fakeNtStore.setNewListenEmitter("nodeIKernelBuddyListener", buddyEmitter);
    fakeNtStore.setNewListenEmitter("nodeIKernelLoginListener", loginEmitter);

    assert.strictEqual(controller.capturedServices.ntSessionManager, fakeSessionMgrInstance);

    // Verify group member role cache is NOT polluted by ordinary chat messages (rememberFromNtMsg)
    controller.uinUidStore.rememberFromNtMsg({
      chatType: 2,
      peerUid: "654321",
      senderUin: "100020002",
      senderUid: "u_uid_100020002",
      sendNickName: "Doctor",
      sendMemberName: "博士",
    });
    const memberInfoResp = await controller.handleOneBotAction("get_group_member_info", {
      group_id: 654321,
      user_id: 100020002,
    });
    assert.strictEqual(memberInfoResp.status, "ok");
    assert.strictEqual(
      memberInfoResp.data.role,
      "owner",
      "Expected get_group_member_info to fetch real role ('owner') instead of polluted 'member'"
    );

    // Verify send_group_forward_msg stages custom nodes to selfUid (srcContact) and forwards to group (dstContact)
    calledNtApis.length = 0;
    const fwdResp = await controller.handleOneBotAction("send_group_forward_msg", {
      group_id: 654321,
      messages: [
        {
          type: "node",
          data: {
            name: "Rosmontis",
            uin: "100010001",
            content: [{ type: "text", data: { text: "合并转发分片1" } }],
          },
        },
      ],
    });
    assert.strictEqual(fwdResp.status, "ok");
    const stagedSend = calledNtApis.find((c) => c.cmd === "nodeIKernelMsgService/sendMsg");
    const multiFwd = calledNtApis.find(
      (c) => c.cmd === "nodeIKernelMsgService/multiForwardMsgWithComment"
    );
    assert.ok(stagedSend, "Expected staging sendMsg call");
    assert.strictEqual(stagedSend.payload.peer.chatType, 1);
    assert.strictEqual(stagedSend.payload.peer.peerUid, "u_rosmontis_self");
    assert.ok(multiFwd, "Expected multiForwardMsgWithComment call");
    assert.strictEqual(multiFwd.payload.srcContact.peerUid, "u_rosmontis_self");
    assert.strictEqual(multiFwd.payload.dstContact.peerUid, "654321");

    // Verify all core OneBot actions execute cleanly
    const actionsToVerify = [
      ["get_login_info", {}],
      ["get_status", {}],
      ["get_version_info", {}],
      ["send_private_msg", { user_id: 100020002, message: "你好博士 [CQ:face,id=14]" }],
      ["send_group_msg", { group_id: 654321, message: [{ type: "text", data: { text: "群消息测试" } }] }],
      ["send_msg", { message_type: "group", group_id: 654321, message: "通用发送" }],
      ["get_friend_list", {}],
      ["get_stranger_info", { user_id: 100020002 }],
      ["get_group_list", {}],
      ["get_group_info", { group_id: 654321 }],
      ["get_group_member_list", { group_id: 654321 }],
      ["get_group_member_info", { group_id: 654321, user_id: 100020002 }],
      ["mark_msg_as_read", { group_id: 654321 }],
      ["mark_private_msg_as_read", { user_id: 100020002 }],
      ["mark_group_msg_as_read", { group_id: 654321 }],
      ["mark_all_as_read", {}],
      ["set_input_status", { user_id: 100020002, event_type: 1 }],
      ["send_like", { user_id: 100020002, times: 5 }],
      ["group_poke", { group_id: 654321, user_id: 100020002 }],
      ["friend_poke", { user_id: 100020002 }],
      ["send_poke", { group_id: 654321, user_id: 100020002 }],
      ["set_group_kick", { group_id: 654321, user_id: 100020002 }],
      ["set_group_ban", { group_id: 654321, user_id: 100020002, duration: 60 }],
      ["set_group_whole_ban", { group_id: 654321, enable: true }],
      ["set_group_admin", { group_id: 654321, user_id: 100020002, enable: true }],
      ["set_group_card", { group_id: 654321, user_id: 100020002, card: "阿米娅" }],
      ["set_group_name", { group_id: 654321, group_name: "新罗德岛" }],
      ["set_group_special_title", { group_id: 654321, user_id: 100020002, special_title: "领袖" }],
      ["set_group_leave", { group_id: 654321 }],
      ["set_qq_profile", { nickname: "Rosmontis", personal_note: "常驻干员" }],
      ["set_self_longnick", { longNick: "常驻干员" }],
      ["set_online_status", { status: 10, ext_status: 0 }],
      ["set_diy_online_status", { face_id: 1, wording: "执勤中" }],
      ["get_cookies", { domain: "qun.qq.com" }],
      ["get_csrf_token", {}],
      ["get_credentials", { domain: "qun.qq.com" }],
      ["get_clientkey", {}],
      ["get_rkey", {}],
      ["can_send_image", {}],
      ["can_send_record", {}],
      ["clean_cache", {}],
      [
        "ocr_image",
        {
          image:
            "base64://iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        },
      ],
      ["translate_en2zh", { words: ["hello"] }],
      ["_get_group_notice", { group_id: 654321 }],
      ["get_essence_msg_list", { group_id: 654321 }],
      ["get_group_honor_info", { group_id: 654321, type: "all" }],
      ["get_group_system_msg", {}],
      ["get_group_ignore_add_request", {}],
      ["get_doubt_friends_add_request", {}],
      ["get_friend_With_category", {}],
      ["get_robot_uin_range", {}],
      ["get_group_root_files", { group_id: 654321 }],
      ["get_group_files_by_folder", { group_id: 654321, folder_id: "/" }],
      ["get_group_file_system_info", { group_id: 654321 }],
      ["create_group_file_folder", { group_id: 654321, name: "作战记录" }],
      ["delete_group_folder", { group_id: 654321, folder_id: "f1" }],
      ["delete_group_file", { group_id: 654321, file_id: "file1" }],
      ["get_group_file_url", { group_id: 654321, file_id: "file1" }],
      ["get_private_file_url", { user_id: 100020002, file_id: "file_priv_1" }],
      ["get_group_msg_history", { group_id: 654321, count: 10 }],
      ["get_friend_msg_history", { user_id: 100020002, count: 10 }],
    ];

    let sentMessageId = null;
    for (const [act, params] of actionsToVerify) {
      const resp = await controller.handleOneBotAction(act, params, `echo_${act}`);
      assert.strictEqual(resp.status, "ok", `Action ${act} failed: ${resp.message}`);
      assert.strictEqual(resp.retcode, 0);
      assert.strictEqual(resp.echo, `echo_${act}`);
      if (act === "send_group_msg") {
        sentMessageId = resp.data.message_id;
        assert.ok(Number.isInteger(sentMessageId) && sentMessageId > 0);
      }
      if (act === "get_group_file_url") {
        assert.strictEqual(
          resp.data.url,
          "https://multimedia.nt.qq.com.cn/group_file_test.pdf"
        );
      }
      if (act === "get_private_file_url") {
        assert.strictEqual(
          resp.data.url,
          "https://multimedia.nt.qq.com.cn/private_file_test.pdf"
        );
      }
    }

    // Confirm send_poke invoked real sendNudge
    assert.ok(
      calledNtApis.some((c) => c.cmd === "nodeIKernelMsgService/sendNudge"),
      "Expected send_poke / group_poke to invoke nodeIKernelMsgService/sendNudge"
    );
    // Confirm set_group_special_title invoked real setIdentityTitleInfo
    assert.ok(
      calledNtApis.some((c) => c.cmd === "nodeIKernelGroupService/setIdentityTitleInfo"),
      "Expected set_group_special_title to invoke nodeIKernelGroupService/setIdentityTitleInfo"
    );
    // Confirm get_essence_msg_list invoked real getGroupLatestEssenceList
    assert.ok(
      calledNtApis.some((c) => c.cmd === "nodeIKernelGroupService/getGroupLatestEssenceList"),
      "Expected get_essence_msg_list to invoke nodeIKernelGroupService/getGroupLatestEssenceList"
    );

    // Verify message-dependent actions using the registered message_id
    const msgDepActions = [
      ["get_msg", { message_id: sentMessageId }],
      ["set_msg_emoji_like", { message_id: sentMessageId, emoji_id: "128077", set: true }],
      ["fetch_emoji_like", { message_id: sentMessageId, emojiId: "128077", emojiType: "2" }],
      ["voice_msg_to_text", { message_id: sentMessageId }],
      ["fetch_ptt_text", { message_id: sentMessageId }],
      ["set_essence_msg", { message_id: sentMessageId }],
      ["delete_essence_msg", { message_id: sentMessageId }],
      ["delete_msg", { message_id: sentMessageId }],
    ];
    for (const [act, params] of msgDepActions) {
      const resp = await controller.handleOneBotAction(act, params, `echo_${act}`);
      assert.strictEqual(resp.status, "ok", `Msg action ${act} failed: ${resp.message}`);
    }

    const pttResp = await controller.handleOneBotAction("fetch_ptt_text", {
      message_id: sentMessageId,
    });
    assert.strictEqual(pttResp.data.text, "博士你好，这是语音转文字结果");

    // Start HTTP & WebSocket servers and test real network transport + kernel event broadcast
    await controller.startServers();
    const httpPort = controller._httpServers[0].address().port;
    const wsPort = controller._wsServers[0].address().port;

    try {
      // Test HTTP POST /get_login_info
      const httpResp = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: httpPort,
            path: "/get_login_info",
            method: "POST",
            headers: { "Content-Type": "application/json" },
          },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
          }
        );
        req.on("error", reject);
        req.write(JSON.stringify({}));
        req.end();
      });
      assert.strictEqual(httpResp.status, "ok");
      assert.strictEqual(httpResp.data.user_id, 100010001);

      // Connect a Reverse WS client to our WS server and verify lifecycle + incoming msg event
      const wsEvents = [];
      const wsHandle = mainMod.connectReverseWebSocket(
        `ws://127.0.0.1:${wsPort}`,
        { "X-Self-ID": "100010001" },
        () => {},
        (text) => {
          wsEvents.push(JSON.parse(text));
        },
        () => {}
      );

      // Wait for lifecycle connect event
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.ok(
        wsEvents.some((e) => e.post_type === "meta_event" && e.meta_event_type === "lifecycle"),
        "Expected lifecycle connect event over WebSocket"
      );

      // Emit an incoming message on nodeIKernelMsgListener and confirm it broadcasts to WS
      msgEmitter.emit("onRecvMsg", [
        {
          msgId: "7999999999999999999",
          msgSeq: "2001",
          msgTime: "1730000999",
          chatType: 1,
          peerUid: "u_uid_100020002",
          peerUin: "100020002",
          senderUid: "u_uid_100020002",
          senderUin: "100020002",
          sendNickName: "Doctor",
          elements: [{ elementType: 1, textElement: { content: "来自内核监听器的私聊消息" } }],
        },
      ]);

      await new Promise((resolve) => setTimeout(resolve, 100));
      const msgEv = wsEvents.find((e) => e.post_type === "message");
      assert.ok(msgEv, "Expected OneBot message event broadcast via WebSocket");
      assert.strictEqual(msgEv.message_type, "private");
      assert.strictEqual(msgEv.user_id, 100020002);
      assert.strictEqual(msgEv.raw_message, "来自内核监听器的私聊消息");

      wsHandle.close();
    } finally {
      await controller.stopServers();
    }
  });

  console.log("=== 6. Testing Anti-Cheat Hardening, Causal Order, Config Isolation & Resource Hygiene ===");
  await check("bridge_renderer.js generates native RFC 4122 v4 UUID callbackIds without rosmontis_cb_ prefix and prevents duplicate listeners on reattachListeners()", async () => {
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

    await rBridge.invokeNtApi("nodeIKernelMsgService/setFocusOnBase", [{ isFocus: true }, null]);
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

  await check("set_input_status activates AIO before sendShowInputStatusReq and coordinates with subsequent send_private_msg deduplication", async () => {
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

    // 1. Trigger set_input_status (event_type: 1)
    const statusResp = await controller.handleOneBotAction("set_input_status", {
      user_id: 100020002,
      event_type: 1,
    });
    assert.strictEqual(statusResp.status, "ok");

    const cmdsAfterTyping = callOrder.map((c) => c.cmd);
    const enterIdx = cmdsAfterTyping.indexOf("nodeIKernelMsgService/enterOrExitAio");
    const activeIdx = cmdsAfterTyping.indexOf("nodeIKernelMsgService/addActiveChatByUid");
    const focusIdx = cmdsAfterTyping.indexOf("nodeIKernelMsgService/setFocusOnBase");
    const typingIdx = cmdsAfterTyping.indexOf("nodeIKernelMsgService/sendShowInputStatusReq");
    assert.ok(enterIdx >= 0 && enterIdx < typingIdx, "enterOrExitAio must precede sendShowInputStatusReq");
    assert.ok(activeIdx >= 0 && activeIdx < typingIdx, "addActiveChatByUid must precede sendShowInputStatusReq");
    assert.ok(focusIdx >= 0 && focusIdx < typingIdx, "setFocusOnBase must precede sendShowInputStatusReq");
    assert.strictEqual(
      cmdsAfterTyping.includes("nodeIKernelMsgService/setMsgRead"),
      false,
      "set_input_status alone should not mark read"
    );

    // 2. Immediately send_private_msg -> setMsgRead MUST still execute, while sendShowInputStatusReq is deduplicated!
    callOrder.length = 0;
    const sendResp = await controller.handleOneBotAction("send_private_msg", {
      user_id: 100020002,
      message: "你好博士",
    });
    assert.strictEqual(sendResp.status, "ok");

    const cmdsAfterSend = callOrder.map((c) => c.cmd);
    assert.ok(
      cmdsAfterSend.includes("nodeIKernelMsgService/setMsgRead"),
      "setMsgRead must still run on send_private_msg after set_input_status"
    );
    assert.strictEqual(
      cmdsAfterSend.includes("nodeIKernelMsgService/sendShowInputStatusReq"),
      false,
      "sendShowInputStatusReq must be deduplicated within the 5s window"
    );
    assert.ok(cmdsAfterSend.includes("nodeIKernelMsgService/sendMsg"));
  });

  await check("mark_msg_as_read & mark_group_msg_as_read resolve group/private peers even when message_id is absent from MessageIdStore", async () => {
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

  await check("loadBridgeConfig supports onebot_sandbox.json, honors empty wsClients: [], filters disabled entries, and isolates multiple account files", () => {
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

  await check("Dynamic User-Agent, temp file cleanup, multi-window activeWebContents contention, and onAddSendMsg deduplication", async () => {
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

    controller._attachToWebContents(mainWc);
    assert.strictEqual(controller.activeWebContents, mainWc);

    // Auxiliary devtools window must NOT overwrite active main window
    controller._attachToWebContents(devtoolsWc);
    assert.strictEqual(controller.activeWebContents, mainWc);

    // When mainWc is destroyed, activeWebContents is cleared
    mainWc.emit("destroyed");
    assert.strictEqual(controller.activeWebContents, null);

    // Verify onAddSendMsg deduplication
    let sendBroadcastCount = 0;
    controller._broadcastOneBotEvent = () => {
      sendBroadcastCount += 1;
    };
    const sampleSentMsg = {
      msgId: "7888888888888888888",
      msgSeq: "301",
      chatType: 1,
      peerUid: "u_friend_1",
      elements: [],
    };
    await controller._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [sampleSentMsg]);
    await controller._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [sampleSentMsg]);
    assert.strictEqual(sendBroadcastCount, 0);
    assert.notStrictEqual(controller.messageIdStore.getByMsgId("7888888888888888888"), null);
  });

  console.log("=== 7. Testing Real NTQQ 3.2.32 ntStore.emitter, Async List Waiters & Map Revival ===");

  await check("ntStore.emitter hyphenated events, async get_friend_list/get_group_list, and nested Map revival", async () => {
    const rootEmitter = new EventEmitter();
    const fakeNtStore = {
      emitter: rootEmitter,
      listenerEventEmitterMap: new Map(),
      wrapperSession: null,
    };
    const bridge = new mainMod.NtqqOneBotBridge({
      selfUin: "",
      online: false,
      config: { httpServers: [], wsServers: [], wsClients: [], heartbeatIntervalMs: 0 },
      rendererExecute: async (cmd) => {
        if (cmd === "nodeIKernelBuddyService/getBuddyList") {
          setTimeout(() => {
            rootEmitter.emit("nodeIKernelBuddyListener-onBuddyListChange", [
              {
                categoryId: 0,
                buddyList: [
                  { uin: "100020002", uid: "u_doctor_1", nick: "Doctor", remark: "博士" },
                ],
              },
            ]);
          }, 15);
          return { result: 0, errMsg: "" };
        }
        if (cmd === "nodeIKernelGroupService/getGroupList") {
          setTimeout(() => {
            rootEmitter.emit("nodeIKernelGroupListener-onGroupListUpdate", 1, [
              { groupCode: "888999000", groupName: "罗德岛作战室", memberCount: 42, maxMember: 200 },
            ]);
          }, 15);
          return { result: 0, errMsg: "" };
        }
        return { result: 0, errMsg: "" };
      },
    });

    assert.strictEqual(bridge.online, false);
    bridge._inspectInversifyCache(fakeNtStore);

    const friendsResp = await bridge.handleOneBotAction("get_friend_list", { no_cache: true });
    assert.strictEqual(friendsResp.status, "ok");
    assert.strictEqual(friendsResp.data.length, 1);
    assert.strictEqual(friendsResp.data[0].user_id, 100020002);
    assert.strictEqual(friendsResp.data[0].remark, "博士");
    assert.strictEqual(bridge.online, true);

    const groupsResp = await bridge.handleOneBotAction("get_group_list", { no_cache: true });
    assert.strictEqual(groupsResp.status, "ok");
    assert.strictEqual(groupsResp.data.length, 1);
    assert.strictEqual(groupsResp.data[0].group_id, 888999000);
    assert.strictEqual(groupsResp.data[0].group_name, "罗德岛作战室");

    // Verify nested Map serialization from bridge_main -> bridge_renderer
    const sentFrames = [];
    const mockWin = {
      webContentId: 2,
      ipcImpl: {
        on() {},
        send(channel, meta, data) {
          sentFrames.push({ channel, meta, data });
        },
      },
    };
    const rBridge = rendererMod.installRendererBridge(mockWin, { windowId: 2, autoRegisterListeners: false });
    const serialized = bridge._serializeBridgePayload([
      {
        msgId: "0",
        msgAttributeInfos: new Map(),
        msgElements: [
          {
            elementType: 2,
            picElement: {
              thumbPath: new Map([[0, "/tmp/thumb.png"]]),
            },
          },
        ],
      },
      null,
    ]);
    const pInvoke = rBridge.invokeNtApi("nodeIKernelMsgService/sendMsg", JSON.parse(serialized), 50);
    pInvoke.catch(() => {});
    const sendFrame = sentFrames.find((f) => f.data?.cmdName === "nodeIKernelMsgService/sendMsg");
    assert.ok(sendFrame, "Expected sendMsg IPC frame");
    assert.ok(sendFrame.data.payload[0].msgAttributeInfos instanceof Map);
    assert.ok(sendFrame.data.payload[0].msgElements[0].picElement.thumbPath instanceof Map);
    assert.strictEqual(sendFrame.data.payload[0].msgElements[0].picElement.thumbPath.get(0), "/tmp/thumb.png");
  });

  console.log("=== 8. Testing Inbound rkey-less Image Hydration, Outbound EXIF Copy & 3.2.32 Member List ===");

  await check("Inbound rkey-less image hydration, outbound copyFileWithDelExifInfo & 3.2.32 member list", async () => {
    const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "rosmontis-bridge-img-"));
    const rootEmitter = new EventEmitter();
    const calls = [];
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    );
    const dlFilePath = path.join(tmpDir, "inbound_dl.png");
    const exifFilePath = path.join(tmpDir, "outbound_noexif.png");
    fs.writeFileSync(exifFilePath, pngBytes);

    let sceneDestroyed = false;
    const bridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_rosmontis_self",
      online: true,
      config: { httpServers: [], wsServers: [], wsClients: [], heartbeatIntervalMs: 0, humanSimulation: false },
      rendererExecute: async (cmd, args) => {
        const payload = Array.isArray(args) ? args[0] : args;
        calls.push({ cmd, payload });
        if (cmd === "nodeIKernelMsgService/getRichMediaFilePathForGuild") {
          return dlFilePath;
        }
        if (cmd === "nodeIKernelMsgService/downloadRichMedia") {
          setTimeout(() => {
            fs.writeFileSync(dlFilePath, pngBytes);
            rootEmitter.emit("nodeIKernelMsgListener-onRichMediaDownloadComplete", {
              notifyInfo: {
                msgId: "750001",
                msgElementId: "9001",
                filePath: dlFilePath,
              },
            });
          }, 15);
          return undefined;
        }
        if (cmd === "nodeIKernelMsgService/copyFileWithDelExifInfo") {
          return {
            errorMsg: "",
            md5: "deadbeefcafebabe0011223344556677",
            newPath: exifFilePath,
          };
        }
        if (cmd === "nodeIKernelMsgService/sendMsg") {
          return { result: 0, msgId: "750002", msgSeq: "12" };
        }
        if (cmd === "nodeIKernelGroupService/createMemberListScene") {
          return "scene_3232";
        }
        if (cmd === "nodeIKernelLoginService/getLoginList") {
          return {
            result: 0,
            LocalLoginInfoList: [
              { uin: "100010001", uid: "u_rosmontis", nickName: "Rosmontis", isQuickLogin: true, isAutoLogin: false },
            ],
          };
        }
        if (cmd === "nodeIKernelLoginService/setAutoLogin") {
          return { result: 0 };
        }
        if (cmd === "nodeIKernelLoginService/quickLoginWithUin") {
          assert.strictEqual(payload.uin, "100010001");
          return { result: 0 };
        }
        if (cmd === "nodeIKernelGroupService/getNextMemberList") {
          assert.strictEqual(payload.sceneId, "scene_3232");
          assert.strictEqual(payload.num, 3000);
          return {
            result: {
              finished: true,
              ids: ["u_m1"],
              infos: new Map([
                [
                  "u_m1",
                  {
                    uid: "u_m1",
                    uin: "0",
                    nick: "阿米娅",
                    cardName: "兔兔",
                    role: 4,
                  },
                ],
              ]),
            },
          };
        }
        if (cmd === "nodeIKernelGroupService/destroyMemberListScene") {
          sceneDestroyed = true;
          return { result: 0 };
        }
        if (cmd === "nodeIKernelUixConvertService/getUin") {
          return { uinInfo: new Map([["u_m1", "1008611"]]) };
        }
        return { result: 0 };
      },
    });

    bridge._attachNtStoreRootEmitter(rootEmitter);
    const broadcasted = [];
    bridge.broadcastOneBotEvent = (ev) => broadcasted.push(ev);

    // 8a. Inbound NTQQv2 image without rkey= downloads and becomes base64://
    await bridge._processIncomingNtMessage({
      msgId: "750001",
      msgSeq: "88",
      msgTime: "1760000000",
      chatType: 1,
      peerUid: "u_doctor_1",
      senderUid: "u_doctor_1",
      senderUin: "100020002",
      elements: [
        {
          elementId: "9001",
          elementType: 2,
          picElement: {
            md5HexStr: "0123456789abcdef0123456789abcdef",
            fileName: "test.png",
            fileSize: String(pngBytes.length),
            sourcePath: "",
            originImageUrl: "/download?appid=1406&fileid=EhTks1thsAOGmQ&spec=0",
          },
        },
      ],
    });

    assert.strictEqual(broadcasted.length, 1);
    const imgSeg = broadcasted[0].message.find((s) => s.type === "image");
    assert.ok(imgSeg, "Expected image segment");
    assert.strictEqual(imgSeg.data.url, `base64://${pngBytes.toString("base64")}`);

    // 8b. Outbound PNG image uses copyFileWithDelExifInfo, picType=1001, and thumbPath Map
    const sendResp = await bridge.handleOneBotAction("send_private_msg", {
      user_id: 100020002,
      message: [{ type: "image", data: { file: `base64://${pngBytes.toString("base64")}` } }],
    });
    assert.strictEqual(sendResp.status, "ok");
    const sendCall = calls.find((c) => c.cmd === "nodeIKernelMsgService/sendMsg");
    assert.ok(sendCall, "Expected sendMsg call");
    const sentPe = sendCall.payload.msgElements[0].picElement;
    assert.strictEqual(sentPe.sourcePath, exifFilePath);
    assert.strictEqual(sentPe.md5HexStr, "deadbeefcafebabe0011223344556677");
    assert.strictEqual(sentPe.picType, 1001);
    assert.ok(sentPe.thumbPath instanceof Map);

    // 8c. NTQQ 3.2.32 get_group_member_list resolves missing uin and destroys scene
    const membersResp = await bridge.handleOneBotAction("get_group_member_list", {
      group_id: 888999000,
    });
    assert.strictEqual(membersResp.status, "ok");
    assert.strictEqual(membersResp.data.length, 1);
    assert.strictEqual(membersResp.data[0].user_id, 1008611);
    assert.strictEqual(membersResp.data[0].card, "兔兔");
    assert.strictEqual(membersResp.data[0].role, "owner");
    assert.strictEqual(sceneDestroyed, true);

    // 8d. Auto quick-login recovery invokes setAutoLogin + quickLoginWithUin when offline
    bridge.online = false;
    const qlResp = await bridge.handleOneBotAction("quick_login", {});
    assert.strictEqual(qlResp.status, "ok");
    assert.strictEqual(qlResp.data.triggered, true);
    assert.strictEqual(qlResp.data.uin, "100010001");
    assert.strictEqual(qlResp.data.method, "nodeIKernelLoginService/quickLoginWithUin");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  console.log("=== 9. Testing invokeNt Side-Effect Replay Guard ===");

  await check("invokeNt never replays dispatched side-effect commands but keeps read fallbacks", async () => {
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

  console.log("=== 10. Testing Outbound sendMsg <-> onAddSendMsg Echo Correlation ===");

  await check("send_private_msg maps message_id to the real onAddSendMsg msgId so delete_msg can recall it", async () => {
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
            await bridge._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
              echoFor("7600000000000000900", "我是手动发的", "90"),
            ]);
          }
          if (plan.mode === "before") {
            await bridge._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
              echoFor(plan.msgId, text, plan.msgSeq),
            ]);
          } else if (plan.mode === "after") {
            setTimeout(() => {
              bridge
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
    assert.strictEqual(bridge._sendEchoWaiters.size, 0, "waiter queues must be drained");
  });

  console.log("=== 11. Testing Map.prototype.set Capture Hook Release ===");

  await check("Map.prototype.set hook is restored to native once ntApi/ntStore/session are captured", async () => {
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
    assert.strictEqual(bridge._mapSetHook, Map.prototype.set);

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
    assert.ok(bridge._mapSetHook, "must not release before ntStore/session are captured");

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
    bridge._handleKernelEvent = async (listenerName, eventName) => {
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

  console.log("=== 12. Testing MessageIdStore PeerSeq Isolation & Reverse WS Single-Connection Guard ===");

  await check("MessageIdStore does not collide distinct real msgIds sharing msgSeq and reverse WS never multiplies on ECONNREFUSED", async () => {
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

  console.log("=== 13. Testing Token Env Guard, Echo Element Isolation, Poke Replay Guard, HTTP Null Body & Forward WS Error Safety ===");

  await check("Empty env token preserves config token; sendEcho isolates element types/md5; poke honors replay guard; HTTP null body & Forward WS socket errors never crash", async () => {
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
              await echoBridge._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
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
              await echoBridge._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
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
                echoBridge
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
      const wImgA = echoBridge._registerSendEchoWaiter(peer, [
        { elementType: 2, picElement: { md5HexStr: "aaaa1111", fileName: "a.png", picSubType: 0 } },
      ]);
      const wImgB = echoBridge._registerSendEchoWaiter(peer, [
        { elementType: 2, picElement: { md5HexStr: "bbbb2222", fileName: "b.png", picSubType: 0 } },
      ]);
      // Foreign text echo must match neither image waiter
      assert.strictEqual(
        echoBridge._matchSendEcho({
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
        echoBridge._matchSendEcho({
          msgId: "7700000000000000202",
          msgSeq: "202",
          chatType: 1,
          peerUid: "u_friend",
          elements: [{ elementType: 2, picElement: { md5HexStr: "BBBB2222", fileName: "b.png", picSubType: 0 } }],
        }),
        true
      );
      assert.strictEqual(
        echoBridge._matchSendEcho({
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
        const httpPort = netBridge._httpServers[0].address().port;
        const wsPort = netBridge._wsServers[0].address().port;

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

        assert.strictEqual(netBridge._wsServerClients.size, 1);
        const srvConn = Array.from(netBridge._wsServerClients)[0];
        // Directly emit a socket error on the server-side upgraded socket (simulating ECONNRESET)
        srvConn.socket.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
        clientSock.destroy();
        await new Promise((r) => setTimeout(r, 30));

        assert.strictEqual(netBridge._wsServerClients.size, 0, "errored Forward WS client must be evicted");
        assert.strictEqual(unhandled, null, `Unexpected unhandled error: ${unhandled}`);
      } finally {
        process.removeListener("unhandledRejection", onUnhandled);
        process.removeListener("uncaughtException", onUnhandled);
        await netBridge.stopServers();
      }
    }
  });

  console.log(`\nALL ${passed} TEST SUITES PASSED SUCCESSFULLY!`);
}

runTests().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
