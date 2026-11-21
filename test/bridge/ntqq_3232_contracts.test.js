"use strict";

/**
 * Linux QQNT 3.2.32 ntStore.emitter, async list waiters, rkey-less image hydration, EXIF copy, MemberRole & Tier 3 positionalArgs
 * Migrated from test/test_bridge.js sections: 7, 8, 23.
 */

const test = require("node:test");
const assert = require("assert");
const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");
const { rendererMod, mainMod } = require("./_helpers");
// === Section 7: Testing Real NTQQ 3.2.32 ntStore.emitter, Async List Waiters & Map Revival ===

test("ntStore.emitter hyphenated events, async get_friend_list/get_group_list, and nested Map revival", async () => {
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
  bridge.ntCapture._inspectInversifyCache(fakeNtStore);

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
  const serialized = bridge.rendererIpc._serializeBridgePayload([
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

// === Section 8: Testing Inbound rkey-less Image Hydration, Outbound EXIF Copy & 3.2.32 Member List ===

test("Inbound rkey-less image hydration, outbound copyFileWithDelExifInfo & 3.2.32 member list", async () => {
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

  bridge.ntCapture._attachNtStoreRootEmitter(rootEmitter);
  const broadcasted = [];
  bridge.broadcastOneBotEvent = (ev) => broadcasted.push(ev);

  // 8a. Inbound NTQQv2 image without rkey= downloads and becomes base64://
  await bridge.inboundPipeline._processIncomingNtMessage({
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

// === Section 23: Testing Linux QQNT 3.2.32-52194 Verified Contracts & Tier 3 Positional Args ===

test("MemberRole (2/3/4), RichMedia getGroupFileList fileListForm, doubt buddy APIs, and Tier 3 wrapperSession positionalArgs", async () => {
  const ntCalls = [];
  const inboundEvents = [];
  const contractBridge = new mainMod.NtqqOneBotBridge({
    selfUin: "100010001",
    selfUid: "u_rosmontis_self",
    config: {
      selfUin: "100010001",
      httpServers: [],
      wsServers: [],
      wsClients: [],
      humanSimulation: false,
    },
    ntApi: new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== "string" || !prop.includes("/")) return undefined;
          return async (payload) => {
            ntCalls.push({ cmd: prop, payload });
            if (prop === "nodeIKernelGroupService/getAllMemberList") {
              return {
                infos: [
                  { uid: "u_role_2", uin: "30002", nick: "Member2", role: 2 },
                  { uid: "u_role_3", uin: "30003", nick: "Admin3", role: 3 },
                  { uid: "u_role_4", uin: "30004", nick: "Owner4", role: 4 },
                ],
              };
            }
            if (prop === "nodeIKernelGroupService/getMemberInfo") {
              const targetUid = payload?.uids?.[0];
              const roleByUid = { u_role_2: 2, u_role_3: 3, u_role_4: 4 };
              const uinByUid = { u_role_2: "30002", u_role_3: "30003", u_role_4: "30004" };
              return {
                result: {
                  infos: new Map([
                    [
                      targetUid,
                      {
                        uid: targetUid,
                        uin: uinByUid[targetUid],
                        nick: `Nick_${targetUid}`,
                        role: roleByUid[targetUid],
                      },
                    ],
                  ]),
                },
              };
            }
            if (prop === "nodeIKernelRichMediaService/getGroupFileList") {
              return {
                groupFileListResult: {
                  item: [
                    {
                      type: 1,
                      fileInfo: {
                        fileId: "/f_contract_1",
                        fileName: "spec.pdf",
                        fileSize: 4096,
                        busId: 102,
                        uploadTime: 1710000100,
                        deadTime: 0,
                        modifyTime: 1710000100,
                        downloadTimes: 3,
                        uploaderUin: "30003",
                        uploaderName: "Admin3",
                      },
                    },
                  ],
                },
              };
            }
            if (prop === "nodeIKernelBuddyService/getDoubtBuddyReq") {
              return {
                result: 0,
                errMsg: "",
                doubtList: [{ uid: "u_doubt_1", nick: "DoubtUser", msg: "hello" }],
              };
            }
            if (prop === "nodeIKernelBuddyService/approvalDoubtBuddyReq") {
              return { result: 0, errMsg: "" };
            }
            return { result: 0, errMsg: "" };
          };
        },
      }
    ),
  });
  contractBridge.on("onebot_event", (ev) => inboundEvents.push(ev));
  contractBridge.uinUidStore.record("30002", "u_role_2");
  contractBridge.uinUidStore.record("30003", "u_role_3");
  contractBridge.uinUidStore.record("30004", "u_role_4");

  try {
    // 1. MemberRole 2 -> "member", 3 -> "admin", 4 -> "owner" in get_group_member_list, get_group_member_info, and inbound sender.role
    const listResp = await contractBridge.handleOneBotAction("get_group_member_list", {
      group_id: 999001,
      no_cache: true,
    });
    assert.strictEqual(listResp.status, "ok");
    const roleMapFromList = Object.fromEntries(listResp.data.map((m) => [m.user_id, m.role]));
    assert.deepStrictEqual(roleMapFromList, {
      30002: "member",
      30003: "admin",
      30004: "owner",
    });

    for (const [uidNum, expectedRole] of [
      [30002, "member"],
      [30003, "admin"],
      [30004, "owner"],
    ]) {
      const infoResp = await contractBridge.handleOneBotAction("get_group_member_info", {
        group_id: 999001,
        user_id: uidNum,
        no_cache: true,
      });
      assert.strictEqual(infoResp.status, "ok");
      assert.strictEqual(infoResp.data.role, expectedRole);
    }

    await contractBridge.inboundPipeline._handleKernelEvent("nodeIKernelMsgListener", "onRecvMsg", [
      [
        {
          msgId: "7800000000000000002",
          msgSeq: "202",
          msgTime: "1710000202",
          chatType: 2,
          msgType: 2,
          peerUid: "999001",
          senderUid: "u_role_2",
          senderUin: "30002",
          sendNickName: "Member2",
          roleType: 2,
          elements: [{ elementType: 1, textElement: { content: "role 2 msg" } }],
        },
        {
          msgId: "7800000000000000003",
          msgSeq: "203",
          msgTime: "1710000203",
          chatType: 2,
          msgType: 2,
          peerUid: "999001",
          senderUid: "u_role_3",
          senderUin: "30003",
          sendNickName: "Admin3",
          roleType: 3,
          elements: [{ elementType: 1, textElement: { content: "role 3 msg" } }],
        },
        {
          msgId: "7800000000000000004",
          msgSeq: "204",
          msgTime: "1710000204",
          chatType: 2,
          msgType: 2,
          peerUid: "999001",
          senderUid: "u_role_4",
          senderUin: "30004",
          sendNickName: "Owner4",
          roleType: 4,
          elements: [{ elementType: 1, textElement: { content: "role 4 msg" } }],
        },
      ],
    ]);
    assert.strictEqual(inboundEvents.length, 3);
    assert.strictEqual(inboundEvents[0].sender.role, "member");
    assert.strictEqual(inboundEvents[1].sender.role, "admin");
    assert.strictEqual(inboundEvents[2].sender.role, "owner");

    // 2. get_group_root_files -> nodeIKernelRichMediaService/getGroupFileList with fileListForm
    ntCalls.length = 0;
    const rootFilesResp = await contractBridge.handleOneBotAction("get_group_root_files", {
      group_id: 999001,
      file_count: 25,
    });
    assert.strictEqual(rootFilesResp.status, "ok");
    assert.strictEqual(rootFilesResp.data.files.length, 1);
    assert.strictEqual(rootFilesResp.data.files[0].file_id, "/f_contract_1");
    assert.strictEqual(
      ntCalls.some((c) => c.cmd.startsWith("nodeIKernelGroupService/")),
      false,
      "get_group_root_files must NOT call nodeIKernelGroupService"
    );
    const fileListCall = ntCalls.find(
      (c) => c.cmd === "nodeIKernelRichMediaService/getGroupFileList"
    );
    assert.ok(fileListCall, "get_group_root_files must call nodeIKernelRichMediaService/getGroupFileList");
    assert.strictEqual(fileListCall.payload.groupId, "999001");
    assert.strictEqual(fileListCall.payload.groupFileListForm, undefined);
    assert.deepStrictEqual(fileListCall.payload.fileListForm, {
      sortType: 1,
      fileCount: 25,
      startIndex: 0,
      sortOrder: 2,
      showOnlinedocFolder: false,
      folderId: "/",
    });

    // 3. Doubt buddy request actions -> getDoubtBuddyReq & approvalDoubtBuddyReq
    ntCalls.length = 0;
    const doubtListResp = await contractBridge.handleOneBotAction(
      "get_doubt_friends_add_request",
      { count: 20 }
    );
    assert.strictEqual(doubtListResp.status, "ok");
    assert.strictEqual(doubtListResp.data.length, 1);
    assert.strictEqual(doubtListResp.data[0].uid, "u_doubt_1");
    const getDoubtCall = ntCalls.find(
      (c) => c.cmd === "nodeIKernelBuddyService/getDoubtBuddyReq"
    );
    assert.ok(getDoubtCall, "Expected nodeIKernelBuddyService/getDoubtBuddyReq");
    assert.strictEqual(getDoubtCall.payload.reqNum, 20);

    const approveDoubtResp = await contractBridge.handleOneBotAction(
      "set_doubt_friends_add_request",
      { flag: "u_doubt_1", approve: true, remark: "VerifiedFriend" }
    );
    assert.strictEqual(approveDoubtResp.status, "ok");
    const approveDoubtCall = ntCalls.find(
      (c) => c.cmd === "nodeIKernelBuddyService/approvalDoubtBuddyReq"
    );
    assert.ok(approveDoubtCall, "Expected nodeIKernelBuddyService/approvalDoubtBuddyReq");
    assert.deepStrictEqual(approveDoubtCall.payload, {
      uid: "u_doubt_1",
      groupId: "",
      remark: "VerifiedFriend",
    });
  } finally {
    await contractBridge.stopServers();
  }

  // 4. Tier 3 wrapperSession.get*Service() fallback passes exact positionalArgs
  const tier3Calls = [];
  const tier3Bridge = new mainMod.NtqqOneBotBridge({
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
  tier3Bridge.uinUidStore.record("100020002", "u_tier3_peer");
  tier3Bridge.capturedServices.wrapperSession = {
    getMsgService() {
      return {
        async setFocusOnBase(...args) {
          tier3Calls.push({ svc: "MsgService", method: "setFocusOnBase", args });
          return { result: 0, errMsg: "" };
        },
        async enterOrExitAio(...args) {
          tier3Calls.push({ svc: "MsgService", method: "enterOrExitAio", args });
          return { result: 0, errMsg: "" };
        },
        async setMsgRead(...args) {
          tier3Calls.push({ svc: "MsgService", method: "setMsgRead", args });
          return { result: 0, errMsg: "" };
        },
        async sendShowInputStatusReq(...args) {
          tier3Calls.push({ svc: "MsgService", method: "sendShowInputStatusReq", args });
          return { result: 0, errMsg: "" };
        },
      };
    },
    getNodeMiscService() {
      return {
        async querySystemProfile(...args) {
          tier3Calls.push({ svc: "NodeMiscService", method: "querySystemProfile", args });
          return { result: 0, os: "Linux" };
        },
      };
    },
  };

  try {
    const t3Typing = await tier3Bridge.handleOneBotAction("set_input_status", {
      user_id: 100020002,
      event_type: 1,
    });
    assert.strictEqual(t3Typing.status, "ok");

    const focusCall = tier3Calls.find((c) => c.method === "setFocusOnBase");
    assert.ok(focusCall);
    assert.deepStrictEqual(focusCall.args, [
      { chatType: 1, peerUid: "u_tier3_peer", guildId: "" },
    ]);

    const enterCall = tier3Calls.find((c) => c.method === "enterOrExitAio");
    assert.ok(enterCall);
    assert.strictEqual(enterCall.args.length, 1, "enterOrExitAio must receive 1 array positional arg");
    assert.deepStrictEqual(enterCall.args[0], [
      { peer: { chatType: 1, peerUid: "u_tier3_peer", guildId: "" }, option: 1 },
    ]);

    const typingCall = tier3Calls.find((c) => c.method === "sendShowInputStatusReq");
    assert.ok(typingCall);
    assert.strictEqual(
      typingCall.args.length,
      3,
      "sendShowInputStatusReq must receive 3 separate positional args (chatType, eventType, peerUid)"
    );
    assert.deepStrictEqual(typingCall.args, [1, 1, "u_tier3_peer"]);

    const miscRes = await tier3Bridge.invokeNt(
      "nodeIKernelNodeMiscService/querySystemProfile",
      { flag: 7, tag: "linux_qqnt" },
      [7, "linux_qqnt"]
    );
    assert.strictEqual(miscRes.os, "Linux");
    const miscCall = tier3Calls.find((c) => c.svc === "NodeMiscService");
    assert.ok(miscCall, "nodeIKernelNodeMiscService must route via session.getNodeMiscService()");
    assert.deepStrictEqual(miscCall.args, [7, "linux_qqnt"]);
  } finally {
    await tier3Bridge.stopServers();
  }
});
