"use strict";

/**
 * Truthy "0" UIN hardening, GrayTip/Recall UID->UIN resolution, recursive forward & upload_group_file fileUuid
 * Migrated from test/test_bridge.js sections: 20.
 */

const test = require("node:test");
const assert = require("assert");
const { onebot, mainMod } = require("./_helpers");
// === Section 20: Testing Truthy "0" UIN Hardening, GrayTip/Recall UID->UIN, Forward Enhancements & upload_group_file fileUuid ===

test("UinUidStore/pickPositiveUin \"0\" hardening, grayTip/recall/request UID->UIN resolution, recursive forward & upload_group_file moveGroupFile", async () => {
  // 20a. UinUidStore ignores "0"/0 and pickPositiveUin skips non-positive candidates
  assert.strictEqual(onebot.pickPositiveUin("0", 0, "", "123456"), 123456);
  assert.strictEqual(onebot.pickPositiveUin("0", 0, "", false, null, undefined), 0);

  const uinStore = new onebot.UinUidStore();
  uinStore.register("0", "u_should_ignore");
  uinStore.register(0, "u_should_ignore_2");
  uinStore.register("654321", "0");
  uinStore.register("654321", 0);
  assert.strictEqual(uinStore.getUid("0"), "");
  assert.strictEqual(uinStore.getUin("u_should_ignore"), "");
  assert.strictEqual(uinStore.getUin("u_should_ignore_2"), "");
  assert.strictEqual(uinStore.getUid("654321"), "");

  let zeroInvokeCount = 0;
  assert.strictEqual(
    await uinStore.resolveUin("0", async () => {
      zeroInvokeCount += 1;
      return { uinInfo: { "0": "999" } };
    }),
    ""
  );
  assert.strictEqual(
    await uinStore.resolveUin(0, async () => {
      zeroInvokeCount += 1;
      return { uinInfo: { "0": "999" } };
    }),
    ""
  );
  assert.strictEqual(
    await uinStore.resolveUid("0", async () => {
      zeroInvokeCount += 1;
      return { uidInfo: { "0": "u_bad" } };
    }),
    ""
  );
  assert.strictEqual(
    await uinStore.resolveUid(0, async () => {
      zeroInvokeCount += 1;
      return { uidInfo: { "0": "u_bad" } };
    }),
    ""
  );
  assert.strictEqual(zeroInvokeCount, 0);
  assert.strictEqual(
    await uinStore.resolveUin("u_returns_zero", async () => ({
      uinInfo: { u_returns_zero: "0" },
      uins: { u_returns_zero: 0 },
    })),
    ""
  );
  assert.strictEqual(
    await uinStore.resolveUid("888000", async () => ({
      uidInfo: { "888000": "0" },
      uids: { "888000": "0" },
    })),
    ""
  );

  // 20b-d. Inbound UID->UIN resolution, recursive forward staging & upload_group_file
  const uidDirectory = {
    u_admin: "111222",
    u_member: "222333",
    u_friend: "333444",
    u_poker: "444555",
    u_poked: "555666",
    u_joiner: "666777",
    u_req: "777888",
    u_recall_op: "888111",
    u_recall_sender: "888222",
  };

  const ntCalls = [];
  const emitted = [];
  let stagedMsgCounter = 1000;
  let forwardEchoCounter = 9000;

  const bridge = new mainMod.NtqqOneBotBridge({
    selfUin: "100010001",
    selfUid: "u_self_20",
    selfNickname: "Rosmontis",
    online: true,
    config: {
      httpServers: [],
      wsServers: [],
      wsClients: [],
      heartbeatIntervalMs: 0,
      wsPingIntervalMs: 0,
      humanSimulation: false,
      sendEchoTimeoutMs: 150,
      forwardEchoTimeoutMs: 150,
    },
    rendererExecute: async (cmd, args) => {
      const payload = Array.isArray(args) ? args[0] : args;
      ntCalls.push({ cmd, payload });

      if (
        cmd === "nodeIKernelUixConvertService/getUin" ||
        cmd === "nodeIKernelGroupService/getUinByUids"
      ) {
        const list = payload?.uids || payload?.uidList || [];
        const uinInfo = {};
        for (const uid of list) {
          if (uidDirectory[uid]) uinInfo[uid] = uidDirectory[uid];
        }
        return { uinInfo, uins: uinInfo };
      }

      if (cmd === "nodeIKernelMsgService/sendMsg") {
        const peer = payload.peer;
        const els = payload.msgElements || [];
        const fileEl = els.find((e) => e?.elementType === 3 && e.fileElement)?.fileElement;
        if (fileEl) {
          setImmediate(() => {
            bridge
              ._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
                {
                  msgId: "7720000999",
                  msgSeq: "301",
                  chatType: peer.chatType,
                  peerUid: peer.peerUid,
                  senderUin: "100010001",
                  senderUid: "u_self_20",
                  elements: [
                    {
                      elementType: 3,
                      fileElement: {
                        fileMd5: fileEl.fileMd5,
                        fileName: fileEl.fileName,
                        fileSize: fileEl.fileSize,
                        fileUuid: "/uuid_doc_suite20",
                      },
                    },
                  ],
                },
              ])
              .catch(() => {});
          });
          return { result: 0, errMsg: "" };
        }
        stagedMsgCounter += 1;
        return {
          result: 0,
          msgId: `772000${stagedMsgCounter}`,
          msgSeq: String(stagedMsgCounter),
        };
      }

      if (cmd === "nodeIKernelMsgService/multiForwardMsgWithComment") {
        const dstPeer = payload.dstContact;
        forwardEchoCounter += 1;
        const fwdMsgId = `772999${forwardEchoCounter}`;
        setImmediate(() => {
          bridge
            ._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
              {
                msgId: fwdMsgId,
                msgSeq: String(forwardEchoCounter),
                chatType: dstPeer.chatType,
                peerUid: dstPeer.peerUid,
                senderUin: "100010001",
                senderUid: "u_self_20",
                elements: [
                  {
                    elementType: 16,
                    multiForwardMsgElement: { xmlContent: "<msg/>", resId: `res_${fwdMsgId}` },
                  },
                ],
              },
            ])
            .catch(() => {});
        });
        return { result: 0, errMsg: "" };
      }

      return { result: 0, errMsg: "" };
    },
  });
  bridge.broadcastOneBotEvent = (ev) => emitted.push(ev);

  try {
    // 1) revokeElement via _processIncomingNtMessage & onMsgInfoListUpdate
    await bridge._processIncomingNtMessage({
      msgId: "772001",
      msgSeq: "11",
      msgType: 5,
      chatType: 2,
      peerUid: "90020",
      senderUin: "0",
      elements: [
        {
          elementType: 8,
          grayTipElement: {
            revokeElement: {
              operatorUin: "0",
              operatorUid: "u_admin",
              origMsgSenderUin: "0",
              origMsgSenderUid: "u_member",
            },
          },
        },
      ],
    });
    const revIncoming = emitted.pop();
    assert.strictEqual(revIncoming.notice_type, "group_recall");
    assert.strictEqual(revIncoming.operator_id, 111222);
    assert.strictEqual(revIncoming.user_id, 222333);

    await bridge._handleKernelEvent("nodeIKernelMsgListener", "onMsgInfoListUpdate", [
      [
        {
          msgId: "772002",
          msgSeq: "12",
          msgType: 5,
          recallTime: "1760002000",
          chatType: 2,
          peerUid: "90020",
          senderUin: "0",
          elements: [
            {
              elementType: 8,
              grayTipElement: {
                revokeElement: {
                  operatorUin: "0",
                  operatorUid: "u_recall_op",
                  origMsgSenderUin: "0",
                  origMsgSenderUid: "u_recall_sender",
                },
              },
            },
          ],
        },
      ],
    ]);
    const revUpdate = emitted.pop();
    assert.strictEqual(revUpdate.notice_type, "group_recall");
    assert.strictEqual(revUpdate.operator_id, 888111);
    assert.strictEqual(revUpdate.user_id, 888222);

    // 2) groupElement single-member shutUp vs whole-group mute, and type:3 kick with memberUin===0
    await bridge._processIncomingNtMessage({
      msgId: "772003",
      msgSeq: "13",
      msgType: 5,
      chatType: 2,
      peerUid: "90020",
      elements: [
        {
          elementType: 8,
          grayTipElement: {
            groupElement: {
              type: 4,
              adminUin: "0",
              adminUid: "u_admin",
              shutUp: {
                duration: 600,
                admin: { uin: "0", uid: "u_admin" },
                member: { uin: "0", uid: "u_member" },
              },
            },
          },
        },
      ],
    });
    const singleBan = emitted.pop();
    assert.strictEqual(singleBan.notice_type, "group_ban");
    assert.strictEqual(singleBan.user_id, 222333);
    assert.strictEqual(singleBan.operator_id, 111222);

    await bridge._processIncomingNtMessage({
      msgId: "772004",
      msgSeq: "14",
      msgType: 5,
      chatType: 2,
      peerUid: "90020",
      elements: [
        {
          elementType: 8,
          grayTipElement: {
            groupElement: {
              type: 4,
              memberUin: "222333",
              adminUin: "0",
              adminUid: "u_admin",
              shutUp: {
                duration: 1800,
                admin: { uin: "0", uid: "u_admin" },
                member: { uin: "0", uid: "" },
              },
            },
          },
        },
      ],
    });
    const wholeBan = emitted.pop();
    assert.strictEqual(wholeBan.notice_type, "group_ban");
    assert.strictEqual(wholeBan.user_id, 0);
    assert.strictEqual(wholeBan.operator_id, 111222);

    await bridge._processIncomingNtMessage({
      msgId: "772005",
      msgSeq: "15",
      msgType: 5,
      chatType: 2,
      peerUid: "90020",
      elements: [
        {
          elementType: 8,
          grayTipElement: {
            groupElement: {
              type: 3,
              memberUin: "0",
              memberUid: "u_unknown_kicked",
              adminUin: "0",
              adminUid: "u_admin",
            },
          },
        },
      ],
    });
    const kickNotice = emitted.pop();
    assert.strictEqual(kickNotice.notice_type, "group_decrease");
    assert.strictEqual(kickNotice.user_id, 0);
    assert.strictEqual(kickNotice.sub_type, "kick");

    // 3) buddyElement friend_add with peerUin: "0", peerUid: "u_friend"
    await bridge._processIncomingNtMessage({
      msgId: "772006",
      msgSeq: "16",
      msgType: 5,
      chatType: 1,
      peerUin: "0",
      peerUid: "u_friend",
      senderUin: "0",
      elements: [
        {
          elementType: 8,
          grayTipElement: {
            buddyElement: {
              peerUin: "0",
              peerUid: "u_friend",
            },
          },
        },
      ],
    });
    const friendAdd = emitted.pop();
    assert.strictEqual(friendAdd.notice_type, "friend_add");
    assert.strictEqual(friendAdd.user_id, 333444);

    // 4) templParam uid_str1 / uid_str2 poke
    await bridge._processIncomingNtMessage({
      msgId: "772007",
      msgSeq: "17",
      msgType: 5,
      chatType: 2,
      peerUid: "90020",
      senderUin: "0",
      elements: [
        {
          elementType: 8,
          grayTipElement: {
            xmlElement: {
              busiId: "1061",
              content: "<gtip>戳了戳</gtip>",
              templParam: new Map([
                ["uin_str1", "0"],
                ["uid_str1", "u_poker"],
                ["uin_str2", "0"],
                ["uid_str2", "u_poked"],
              ]),
            },
          },
        },
      ],
    });
    const pokeEv = emitted.pop();
    assert.strictEqual(pokeEv.notice_type, "notify");
    assert.strictEqual(pokeEv.sub_type, "poke");
    assert.strictEqual(pokeEv.user_id, 444555);
    assert.strictEqual(pokeEv.target_id, 555666);

    // 5) onGroupNotifiesUpdated & onBuddyReqChange with "0" UIN
    await bridge._handleKernelEvent("nodeIKernelGroupListener", "onGroupNotifiesUpdated", [
      false,
      [
        {
          seq: "seq_20_1",
          type: 1,
          status: 1,
          group: { groupCode: "90020" },
          user1: { uin: "0", uid: "u_joiner", nickName: "Joiner" },
          postscript: "let me in",
        },
      ],
    ]);
    const grpReqEv = emitted.pop();
    assert.strictEqual(grpReqEv.post_type, "request");
    assert.strictEqual(grpReqEv.request_type, "group");
    assert.strictEqual(grpReqEv.user_id, 666777);

    await bridge._handleKernelEvent("nodeIKernelBuddyListener", "onBuddyReqChange", [
      {
        buddyReqs: [
          {
            isDecide: false,
            reqType: 1,
            friendUin: "0",
            friendUid: "u_req",
            reqTime: "1760002100",
            extWords: "add me",
          },
        ],
      },
    ]);
    const buddyReqEv = emitted.pop();
    assert.strictEqual(buddyReqEv.post_type, "request");
    assert.strictEqual(buddyReqEv.request_type, "friend");
    assert.strictEqual(buddyReqEv.user_id, 777888);

    // 20c. send_group_forward_msg: distinct senderShowName, recursive depth <=3, flatten depth 4, firstRefPeer & sendEchoStats isolation
    ntCalls.length = 0;
    const customFwdRes = await bridge.handleOneBotAction("send_group_forward_msg", {
      group_id: 90020,
      messages: [
        {
          type: "node",
          data: {
            name: "Alice",
            uin: "10001",
            content: [
              {
                type: "node",
                data: {
                  name: "Depth2User",
                  uin: "10002",
                  content: [
                    {
                      type: "node",
                      data: {
                        name: "Depth3User",
                        uin: "10003",
                        content: [
                          { type: "text", data: { text: "L3-prefix:" } },
                          {
                            type: "node",
                            data: { name: "Depth4User", uin: "10004", content: "deep-secret" },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
        {
          type: "node",
          data: { nickname: "Bob", user_id: "10005", content: "Hello from Bob" },
        },
      ],
    });
    assert.strictEqual(customFwdRes.status, "ok");

    const multiFwdCalls = ntCalls.filter(
      (c) => c.cmd === "nodeIKernelMsgService/multiForwardMsgWithComment"
    );
    // Depth 3 node flattens depth 4 to text, Depth 2 packs Depth 3 (1), Depth 1 packs Depth 2 (2), outer packs Alice+Bob (3)
    assert.strictEqual(multiFwdCalls.length, 3);
    const outerFwd = multiFwdCalls[multiFwdCalls.length - 1].payload;
    assert.deepStrictEqual(
      outerFwd.msgInfos.map((m) => m.senderShowName),
      ["Alice", "Bob"]
    );

    const stagedSendTexts = ntCalls
      .filter((c) => c.cmd === "nodeIKernelMsgService/sendMsg")
      .map((c) =>
        (c.payload.msgElements || [])
          .map((e) => e.textElement?.content || "")
          .join("")
      );
    assert.ok(
      stagedSendTexts.includes("L3-prefix:[转发消息]"),
      `Expected depth-4 node flattened to [转发消息], got: ${JSON.stringify(stagedSendTexts)}`
    );
    assert.ok(!stagedSendTexts.some((t) => t.includes("deep-secret")));

    // Reference-only forward: uses firstRefPeer as srcContact & correlates onAddSendMsg without touching sendEchoStats
    const refId1 = bridge.messageIdStore.register({
      msgId: "7720801",
      chatType: 1,
      peerUid: "u_ref_peer_first",
      msgSeq: "81",
      senderUin: "111222",
    });
    const refId2 = bridge.messageIdStore.register({
      msgId: "7720802",
      chatType: 2,
      peerUid: "99999",
      msgSeq: "82",
      senderUin: "222333",
    });
    ntCalls.length = 0;
    const statsBeforeRefFwd = { ...bridge.sendEchoStats };
    const refFwdRes = await bridge.handleOneBotAction("send_group_forward_msg", {
      group_id: 90020,
      messages: [
        { type: "node", data: { id: refId1, name: "Alice" } },
        { type: "node", data: { id: refId2, name: "Bob" } },
      ],
    });
    assert.strictEqual(refFwdRes.status, "ok");
    assert.deepStrictEqual(bridge.sendEchoStats, statsBeforeRefFwd);
    assert.match(String(refFwdRes.data.res_id), /^772999\d+$/);
    assert.strictEqual(
      bridge.messageIdStore.getByShortId(refFwdRes.data.message_id)?.msgId,
      refFwdRes.data.res_id
    );
    const refFwdCall = ntCalls.find(
      (c) => c.cmd === "nodeIKernelMsgService/multiForwardMsgWithComment"
    );
    assert.deepStrictEqual(refFwdCall.payload.srcContact, {
      chatType: 1,
      peerUid: "u_ref_peer_first",
      guildId: "",
    });
    assert.deepStrictEqual(
      refFwdCall.payload.msgInfos.map((m) => m.senderShowName),
      ["Alice", "Bob"]
    );

    // 20d. upload_group_file extracts fileElement.fileUuid from echoRawMsg & invokes moveGroupFile for folder="/docs"
    ntCalls.length = 0;
    const fileB64 = Buffer.from("suite20 group document payload", "utf8").toString("base64");
    const uploadRes = await bridge.handleOneBotAction("upload_group_file", {
      group_id: 90020,
      file: `base64://${fileB64}`,
      name: "handbook.pdf",
      folder: "/docs",
    });
    assert.strictEqual(uploadRes.status, "ok");
    assert.strictEqual(uploadRes.data.file_id, "/uuid_doc_suite20");
    const moveCall = ntCalls.find((c) => c.cmd === "nodeIKernelRichMediaService/moveGroupFile");
    assert.ok(moveCall, "Expected moveGroupFile call when folder=/docs");
    assert.deepStrictEqual(moveCall.payload, {
      groupId: "90020",
      busIdList: [102],
      fileIdList: ["/uuid_doc_suite20"],
      curFolderId: "/",
      dstFolderId: "/docs",
    });
  } finally {
    await bridge.stopServers();
  }
});
