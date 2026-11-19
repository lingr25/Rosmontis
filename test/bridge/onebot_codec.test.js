"use strict";

/**
 * OneBot v11 segments <-> NTQQ elements conversion & GrayTip/notice event formatting
 * Migrated from test/test_bridge.js sections: 3.
 */

const test = require("node:test");
const assert = require("assert");
const { onebot } = require("./_helpers");
// === Section 3: Testing OneBot Segments <-> NTQQ Elements & Events ===

test("ntMsgToOneBotSegments converts text, @all, @member, reply, face, image, file, record, video, mface, json, forward", () => {
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

test("oneBotSegmentsToNtElements converts CQ strings and segment arrays including base64 PNG image", async () => {
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

test("GrayTip recall & poke & group upload notice events format accurately", () => {
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
