"use strict";

/**
 * bridge_main.js end-to-end DI hooks, 65+ OneBot v11 actions, HTTP, Forward WS & Reverse WS
 * Migrated from test/test_bridge.js sections: 5.
 */

const test = require("node:test");
const assert = require("assert");
const EventEmitter = require("events");
const fs = require("fs");
const http = require("http");
const { mainMod } = require("./_helpers");
// === Section 5: Testing bridge_main.js End-to-End (DI Hooks + 65+ OneBot Actions + HTTP & WS) ===

test("bridge_main.js survives globalIPCMainMap ntApi overwrite, executes 65+ actions with real signatures, and serves HTTP/WS/ReverseWS", async () => {
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
      enableWebCredentialApi: true,
    },
  });

  // Install Map.prototype.set hook and simulate 908.background.jsc DI registration
  controller.installMapPrototypeHook();
  const diMap = new Map();

  const msgEmitter = new EventEmitter();
  const groupEmitter = new EventEmitter();
  const buddyEmitter = new EventEmitter();
  const loginEmitter = new EventEmitter();

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
          if (prop === "nodeIKernelBuddyService/getDoubtBuddyReq") {
            return { result: 0, errMsg: "", doubtList: [] };
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
            if (payload?.savePath) {
              fs.writeFileSync(payload.savePath, Buffer.from("GROUP_PDF_TEST"));
            }
            return { result: 0, errMsg: "" };
          }
          if (prop === "nodeIKernelMsgService/getMsgsIncludeSelf") {
            if (payload?.peer?.chatType === 1) {
              return {
                msgList: [
                  {
                    msgId: "7500000000000000201",
                    chatType: 1,
                    peerUid: payload.peer.peerUid,
                    elements: [
                      {
                        elementId: "el_file_priv_1",
                        elementType: 3,
                        fileElement: {
                          fileUuid: "file_priv_1",
                          fileName: "private_file_test.pdf",
                          fileSize: 13,
                        },
                      },
                    ],
                  },
                ],
              };
            }
            return { msgList: [] };
          }
          if (prop === "nodeIKernelMsgService/downloadRichMedia") {
            if (payload?.getReq?.filePath) {
              fs.writeFileSync(payload.getReq.filePath, Buffer.from("PRIV_PDF_TEST"));
              setImmediate(() => {
                msgEmitter.emit("onRichMediaDownloadComplete", {
                  notifyInfo: {
                    msgId: payload.getReq.msgId,
                    msgElementId: payload.getReq.elementId,
                    filePath: payload.getReq.filePath,
                  },
                });
              });
            }
            return { result: 0, errMsg: "" };
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
      assert.ok(
        resp.data.url.startsWith("file://"),
        `Expected file:// URL from get_group_file_url, got ${resp.data.url}`
      );
    }
    if (act === "get_private_file_url") {
      assert.ok(
        resp.data.url.startsWith("file://"),
        `Expected file:// URL from get_private_file_url, got ${resp.data.url}`
      );
    }
  }

  // Verify set_group_special_title fails honestly with retcode === 1404 on Linux QQNT 3.2.32
  const specialTitleResp = await controller.handleOneBotAction("set_group_special_title", {
    group_id: 654321,
    user_id: 100020002,
    special_title: "领袖",
  });
  assert.strictEqual(specialTitleResp.status, "failed");
  assert.strictEqual(specialTitleResp.retcode, 1404);

  // Verify get_cookies fails cleanly with status === "failed" & retcode === 1403 when enableWebCredentialApi is omitted or false
  for (const cfgOverride of [{}, { enableWebCredentialApi: false }]) {
    const gatedBridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_rosmontis_self",
      ntApi: fakeNtApi,
      config: {
        selfUin: "100010001",
        httpServers: [],
        wsServers: [],
        wsClients: [],
        ...cfgOverride,
      },
    });
    const gatedResp = await gatedBridge.handleOneBotAction("get_cookies", { domain: "qun.qq.com" });
    assert.strictEqual(gatedResp.status, "failed");
    assert.strictEqual(gatedResp.retcode, 1403);
  }

  // Confirm send_poke invoked real sendNudge
  assert.ok(
    calledNtApis.some((c) => c.cmd === "nodeIKernelMsgService/sendNudge"),
    "Expected send_poke / group_poke to invoke nodeIKernelMsgService/sendNudge"
  );
  // Confirm set_group_ban & set_group_whole_ban invoked real setMemberShutUp & setGroupShutUp
  assert.ok(
    calledNtApis.some((c) => c.cmd === "nodeIKernelGroupService/setMemberShutUp"),
    "Expected set_group_ban to invoke nodeIKernelGroupService/setMemberShutUp"
  );
  assert.ok(
    calledNtApis.some((c) => c.cmd === "nodeIKernelGroupService/setGroupShutUp"),
    "Expected set_group_whole_ban to invoke nodeIKernelGroupService/setGroupShutUp"
  );
  // Confirm ocr_image invoked real getScreenOCR & set_online_status invoked real setStatus
  assert.ok(
    calledNtApis.some((c) => c.cmd === "nodeIKernelRichMediaService/getScreenOCR"),
    "Expected ocr_image to invoke nodeIKernelRichMediaService/getScreenOCR"
  );
  assert.ok(
    calledNtApis.some((c) => c.cmd === "nodeIKernelMsgService/setStatus"),
    "Expected set_online_status to invoke nodeIKernelMsgService/setStatus"
  );
  // Confirm get_essence_msg_list invoked real fetchGroupEssenceListV2
  assert.ok(
    calledNtApis.some((c) => c.cmd === "nodeIKernelGroupService/fetchGroupEssenceListV2"),
    "Expected get_essence_msg_list to invoke nodeIKernelGroupService/fetchGroupEssenceListV2"
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
  const httpPort = controller.serverRuntime._httpServers[0].address().port;
  const wsPort = controller.serverRuntime._wsServers[0].address().port;

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
