"use strict";

/**
 * Downstream SnowLuma / NapCat / OneBot SDK compatibility profiles, quick operations & segment shorthands
 * Migrated from test/test_bridge.js sections: 18.
 */

const test = require("node:test");
const assert = require("assert");
const http = require("http");
const path = require("path");
const { onebot, mainMod } = require("./_helpers");
// === Section 18: Testing Downstream SnowLuma / NapCat / OneBot SDK Compatibility ===

test("compatProfile (global & per-endpoint), get_status.time, .handle_quick_operation, JSON/face/share/image shorthands & group compat actions", async () => {
  // 1. Config & env loading for compatProfile
  const prevCompatEnv = process.env.ROSMONTIS_COMPAT_PROFILE;
  try {
    process.env.ROSMONTIS_COMPAT_PROFILE = "snowluma";
    const slCfg = mainMod.loadBridgeConfig(path.join(__dirname, "non_existent_cfg_dir"));
    assert.strictEqual(slCfg.compatProfile, "snowluma");
    process.env.ROSMONTIS_COMPAT_PROFILE = "napcat";
    const ncCfg = mainMod.loadBridgeConfig(path.join(__dirname, "non_existent_cfg_dir"));
    assert.strictEqual(ncCfg.compatProfile, "napcat");
  } finally {
    if (prevCompatEnv === undefined) {
      delete process.env.ROSMONTIS_COMPAT_PROFILE;
    } else {
      process.env.ROSMONTIS_COMPAT_PROFILE = prevCompatEnv;
    }
  }

  // 2. Segment shorthands & round-trip codecs
  const pngBase64 =
    "base64://iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const conv = await onebot.oneBotSegmentsToNtElements([
    { type: "text", text: "顶层简写" },
    { type: "json", data: '{"app":"com.tencent.str"}' },
    { type: "json", data: { data: { app: "com.tencent.nested" } } },
    { type: "json", data: { app: "com.tencent.direct" } },
    {
      type: "share",
      data: {
        url: "https://example.com/post",
        title: "测试分享",
        content: "摘要",
        image: "https://example.com/thumb.png",
      },
    },
    { type: "face", data: { id: "394", resultId: "2" } },
    { type: "face", data: { id: "14" } },
    {
      type: "image",
      data: {
        file: "a1b2c3d4e5f6.png",
        url: pngBase64,
      },
    },
    {
      type: "image",
      data: {
        emoji_id: "0123456789abcdef0123456789abcdef",
        emoji_package_id: "2001",
        key: "mk_key_1",
        summary: "[狗狗]",
      },
    },
  ]);
  try {
    assert.strictEqual(conv.elements.length, 9);
    assert.strictEqual(conv.elements[0].textElement.content, "顶层简写");
    assert.deepStrictEqual(JSON.parse(conv.elements[1].arkElement.bytesData), {
      app: "com.tencent.str",
    });
    assert.deepStrictEqual(JSON.parse(conv.elements[2].arkElement.bytesData), {
      app: "com.tencent.nested",
    });
    assert.deepStrictEqual(JSON.parse(conv.elements[3].arkElement.bytesData), {
      app: "com.tencent.direct",
    });
    const shareArk = JSON.parse(conv.elements[4].arkElement.bytesData);
    assert.strictEqual(shareArk.app, "com.tencent.structmsg");
    assert.strictEqual(shareArk.meta.news.jumpUrl, "https://example.com/post");
    assert.strictEqual(shareArk.meta.news.title, "测试分享");
    assert.strictEqual(conv.elements[5].faceElement.faceIndex, 394);
    assert.strictEqual(conv.elements[5].faceElement.resultId, "2");
    assert.strictEqual(conv.elements[5].faceElement.faceType, 3);
    assert.strictEqual(conv.elements[6].faceElement.faceIndex, 14);
    assert.strictEqual(conv.elements[6].faceElement.resultId, "");
    assert.strictEqual(conv.elements[6].faceElement.faceType, 1);
    assert.strictEqual(conv.elements[7].elementType, 2); // echoed image fell back from bare md5 token to base64 url
    assert.strictEqual(conv.elements[8].elementType, 11); // image with emoji_id rebuilt as mface
    assert.strictEqual(
      conv.elements[8].marketFaceElement.emojiId,
      "0123456789abcdef0123456789abcdef"
    );
  } finally {
    for (const fn of conv.cleanupCallbacks) fn();
  }

  // Inbound animated face preserves resultId while regular face stays clean
  const inboundFaceSegs = onebot.ntMsgToOneBotSegments({
    chatType: 2,
    peerUid: "654321",
    elements: [
      { elementType: 6, faceElement: { faceIndex: 394, faceType: 3, resultId: "2" } },
      { elementType: 6, faceElement: { faceIndex: 14, faceType: 1, resultId: "" } },
    ],
  });
  assert.deepStrictEqual(inboundFaceSegs.segments, [
    { type: "face", data: { id: "394", resultId: "2" } },
    { type: "face", data: { id: "14" } },
  ]);

  // 3. Live Bridge + per-endpoint HTTP/WS compatProfile + .handle_quick_operation + group compat actions
  const ntCalls = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const compatBridge = new mainMod.NtqqOneBotBridge({
    selfUin: "100010001",
    selfUid: "u_self_compat",
    selfNickname: "Rosmontis",
    online: true,
    startedAtMs: Date.now() - 4200,
    config: {
      selfUin: "100010001",
      compatProfile: "rosmontis",
      humanSimulation: false,
      sendEchoTimeoutMs: 50,
      heartbeatIntervalMs: 0,
      httpServers: [
        { host: "127.0.0.1", port: 0, accessToken: "" },
        { host: "127.0.0.1", port: 0, accessToken: "", compatProfile: "snowluma" },
      ],
      wsServers: [
        { host: "127.0.0.1", port: 0, accessToken: "", compatProfile: "napcat" },
      ],
      wsClients: [],
    },
    rendererExecute: async (cmd, args) => {
      const payload = Array.isArray(args) ? args[0] : args;
      ntCalls.push({ cmd, payload });
      if (cmd === "nodeIKernelGroupService/getGroupList") {
        return {
          groupList: [
            {
              groupCode: "777888",
              groupName: "测试群",
              remarkName: "主测试群",
              memberCount: 42,
              maxMember: 500,
              createTime: 1700000000,
              groupLevel: 5,
              richFingerMemo: "群简介",
              shutUpAllTimestamp: nowSec + 3600,
            },
          ],
        };
      }
      if (cmd === "nodeIKernelGroupService/getGroupAllInfo") {
        return {
          groupInfo: {
            groupCode: "777888",
            groupName: "测试群",
            remarkName: "主测试群",
            memberCount: 42,
            maxMember: 500,
            createTime: 1700000000,
            groupLevel: 5,
            richFingerMemo: "群简介",
            shutUpAllTimestamp: 0,
          },
        };
      }
      if (cmd === "nodeIKernelGroupService/getGroupRecommendContactArkJson") {
        return {
          arkJson: JSON.stringify({
            app: "com.tencent.troopsharecard",
            meta: {
              contact: {
                jumpUrl: "https://qm.qq.com/cgi-bin/qm/qr?k=TEST_SHARE_KEY",
              },
            },
          }),
        };
      }
      if (cmd === "nodeIKernelGroupService/getGroupRemainAtTimes") {
        return {
          atInfo: {
            canAtAll: true,
            RemainAtAllCountForGroup: 8,
            RemainAtAllCountForUin: 3,
          },
        };
      }
      if (cmd === "nodeIKernelGroupService/getAllMemberList") {
        return {
          infos: [
            {
              uid: "u_muted_1",
              uin: "20001",
              nick: "被禁言群友",
              cardName: "禁言名片",
              role: 3,
              shutUpTime: nowSec + 600,
            },
            {
              uid: "u_normal_2",
              uin: "20002",
              nick: "正常群友",
              role: 2,
              shutUpTime: 0,
            },
          ],
        };
      }
      if (cmd === "nodeIKernelMsgService/getMsgEmojiLikesList") {
        return { emojiLikesList: [{ tinyId: "20002", nickName: "正常群友" }] };
      }
      if (cmd === "nodeIKernelMsgService/sendMsg") {
        return { result: 0, errMsg: "" };
      }
      return { result: 0, errMsg: "" };
    },
  });
  compatBridge.uinUidStore.record("20002", "u_normal_2");
  const recMsgId = compatBridge.messageIdStore.register({
    msgId: "7500000000000000099",
    chatType: 2,
    peerUid: "777888",
    msgSeq: "888",
    senderUin: "20002",
    senderUid: "u_normal_2",
  });

  const httpJson = (port, urlPath, bodyObj) =>
    new Promise((resolve, reject) => {
      const raw = JSON.stringify(bodyObj);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: urlPath,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(raw),
          },
        },
        (res) => {
          let buf = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (buf += c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(buf));
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on("error", reject);
      req.end(raw);
    });

  await compatBridge.startServers();
  let wsNapClient = null;
  try {
    const portDefault = compatBridge.serverRuntime._httpServers[0].address().port;
    const portSnow = compatBridge.serverRuntime._httpServers[1].address().port;
    const wsPortNap = compatBridge.serverRuntime._wsServers[0].address().port;

    // Default HTTP endpoint reports Rosmontis; SnowLuma HTTP endpoint reports SnowLuma
    const vDef = await httpJson(portDefault, "/get_version_info", {});
    assert.strictEqual(vDef.status, "ok");
    assert.strictEqual(vDef.data.app_name, "Rosmontis");
    assert.strictEqual(vDef.data.bridge_name, undefined);

    const vSnow = await httpJson(portSnow, "/get_version_info", {});
    assert.strictEqual(vSnow.status, "ok");
    assert.strictEqual(vSnow.data.app_name, "SnowLuma");
    assert.strictEqual(vSnow.data.bridge_name, "Rosmontis");

    // get_status includes uptime `time` in seconds
    const st = await httpJson(portSnow, "/get_status", {});
    assert.strictEqual(st.status, "ok");
    assert.strictEqual(st.data.online, true);
    assert.strictEqual(st.data.good, true);
    assert.ok(Number.isInteger(st.data.time) && st.data.time >= 3);

    // WS endpoint reports NapCat.Onebot
    wsNapClient = await new Promise((resolve, reject) => {
      const queue = [];
      const waiters = [];
      let handle = null;
      handle = mainMod.connectReverseWebSocket(
        `ws://127.0.0.1:${wsPortNap}/`,
        {},
        (conn) => {
          resolve({
            conn,
            handle,
            nextJson(pred) {
              const idx = queue.findIndex(pred);
              if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
              return new Promise((res, rej) => {
                const t = setTimeout(() => rej(new Error("WS wait timeout")), 3000);
                waiters.push({ pred, res, t });
              });
            },
          });
        },
        (txt) => {
          const msg = JSON.parse(txt);
          const wIdx = waiters.findIndex((w) => w.pred(msg));
          if (wIdx >= 0) {
            const w = waiters.splice(wIdx, 1)[0];
            clearTimeout(w.t);
            w.res(msg);
          } else {
            queue.push(msg);
          }
        },
        () => {}
      );
      setTimeout(() => reject(new Error("WS connect timeout")), 3000).unref();
    });

    wsNapClient.conn.sendJson({ action: "get_version_info", params: {}, echo: "v_nap" });
    const vNap = await wsNapClient.nextJson((m) => m.echo === "v_nap");
    assert.strictEqual(vNap.data.app_name, "NapCat.Onebot");
    assert.strictEqual(vNap.data.bridge_name, "Rosmontis");

    // .handle_quick_operation over HTTP: missing params -> 1400
    const badQuick = await httpJson(portSnow, "/.handle_quick_operation", {});
    assert.strictEqual(badQuick.status, "failed");
    assert.strictEqual(badQuick.retcode, 1400);

    // .handle_quick_operation on group message: reply (auto @sender) + delete + ban + kick
    ntCalls.length = 0;
    const quickGrp = await httpJson(portSnow, "/.handle_quick_operation", {
      context: {
        post_type: "message",
        message_type: "group",
        group_id: 777888,
        user_id: 20002,
        message_id: recMsgId,
      },
      operation: {
        reply: "收到 [CQ:face,id=14]",
        delete: true,
        ban: true,
        ban_duration: 300,
        kick: true,
        reject_add_request: true,
      },
    });
    assert.strictEqual(quickGrp.status, "ok");

    const sentCall = ntCalls.find((c) => c.cmd === "nodeIKernelMsgService/sendMsg");
    assert.ok(sentCall, "Expected sendMsg from quick_operation reply");
    assert.strictEqual(sentCall.payload.msgElements[0].textElement.atType, 2);
    assert.strictEqual(sentCall.payload.msgElements[0].textElement.atUid, "20002");
    assert.strictEqual(sentCall.payload.msgElements[1].textElement.content, "收到 ");
    assert.strictEqual(sentCall.payload.msgElements[2].faceElement.faceIndex, 14);
    assert.ok(ntCalls.some((c) => c.cmd === "nodeIKernelMsgService/recallMsg"));
    const banCall = ntCalls.find((c) => c.cmd === "nodeIKernelGroupService/setMemberShutUp");
    assert.ok(banCall, "Expected setMemberShutUp from quick_operation ban");
    assert.strictEqual(banCall.payload.groupCode, "777888");
    assert.strictEqual(banCall.payload.memList[0].uid, "u_normal_2");
    assert.strictEqual(banCall.payload.memList[0].timeStamp, 300);
    assert.ok(ntCalls.some((c) => c.cmd === "nodeIKernelGroupService/kickMember"));

    // .handle_quick_operation_async on friend & group request events
    ntCalls.length = 0;
    const quickFriendReq = await compatBridge.handleOneBotAction(
      ".handle_quick_operation_async",
      {
        context: { post_type: "request", request_type: "friend", flag: "u_req_friend|123" },
        operation: { approve: true, remark: "新好友" },
      }
    );
    assert.strictEqual(quickFriendReq.status, "ok");
    assert.ok(
      ntCalls.some((c) => c.cmd === "nodeIKernelBuddyService/approvalFriendRequest")
    );

    ntCalls.length = 0;
    const quickGroupReq = await compatBridge.handleOneBotAction("handle_quick_operation", {
      context: {
        post_type: "request",
        request_type: "group",
        sub_type: "add",
        flag: "777888|seq_99|1",
      },
      operation: { approve: false, reason: "暂不开放" },
    });
    assert.strictEqual(quickGroupReq.status, "ok");
    assert.ok(
      ntCalls.some((c) => c.cmd === "nodeIKernelGroupService/operateSysNotify")
    );

    // Exclusive forward node array passed directly to send_group_msg routes to forward pipeline
    ntCalls.length = 0;
    const exclFwd = await compatBridge.handleOneBotAction("send_group_msg", {
      group_id: 777888,
      message: [
        { type: "text", data: { text: "" } },
        {
          type: "node",
          data: { user_id: 100010001, nickname: "Rosmontis", content: "合并节点正文" },
        },
      ],
    });
    assert.strictEqual(exclFwd.status, "ok");
    assert.ok(
      ntCalls.some((c) => c.cmd === "nodeIKernelMsgService/multiForwardMsgWithComment")
    );

    // Group schema fields & new group/file helper actions
    const grpList = await compatBridge.handleOneBotAction("get_group_list", { no_cache: true });
    assert.strictEqual(grpList.status, "ok");
    assert.strictEqual(grpList.data[0].group_remark, "主测试群");
    assert.strictEqual(grpList.data[0].group_all_shut, -1);

    const grpInfoEx = await compatBridge.handleOneBotAction("get_group_info_ex", {
      group_id: 777888,
    });
    assert.strictEqual(grpInfoEx.status, "ok");
    assert.strictEqual(grpInfoEx.data.group_remark, "主测试群");
    assert.strictEqual(grpInfoEx.data.group_all_shut, 0);

    const shareLink = await compatBridge.handleOneBotAction("get_group_share_link", {
      group_id: 777888,
    });
    assert.strictEqual(shareLink.status, "ok");
    assert.strictEqual(
      shareLink.data.url,
      "https://qm.qq.com/cgi-bin/qm/qr?k=TEST_SHARE_KEY"
    );

    const atRemain = await compatBridge.handleOneBotAction("get_group_at_all_remain", {
      group_id: 777888,
    });
    assert.deepStrictEqual(atRemain.data, {
      can_at_all: true,
      remain_at_all_count_for_group: 8,
      remain_at_all_count_for_uin: 3,
    });

    const shutList = await compatBridge.handleOneBotAction("get_group_shut_list", {
      group_id: 777888,
    });
    assert.strictEqual(shutList.data.length, 1);
    assert.strictEqual(shutList.data[0].user_id, 20001);
    assert.strictEqual(shutList.data[0].role, "admin");

    const memList777 = await compatBridge.handleOneBotAction("get_group_member_list", {
      group_id: 777888,
      no_cache: true,
    });
    assert.strictEqual(memList777.status, "ok");
    const normalMem2 = memList777.data.find((m) => m.user_id === 20002);
    assert.ok(normalMem2, "Expected u_normal_2 in get_group_member_list");
    assert.strictEqual(normalMem2.role, "member", "MemberRole 2 must map to 'member', not 'admin'");

    const setRmk = await compatBridge.handleOneBotAction("set_group_remark", {
      group_id: 777888,
      remark: "新群备注",
    });
    assert.strictEqual(setRmk.status, "ok");

    const emojiLikes = await compatBridge.handleOneBotAction("get_msg_emoji_likes", {
      message_id: recMsgId,
      emoji_id: "14",
    });
    assert.strictEqual(emojiLikes.status, "ok");
    assert.strictEqual(emojiLikes.data.emoji_like_list.length, 1);

    const renFile = await compatBridge.handleOneBotAction("rename_group_file", {
      group_id: 777888,
      file_id: "/f_1",
      new_name: "renamed.pdf",
    });
    assert.strictEqual(renFile.status, "ok");

    const renFolder = await compatBridge.handleOneBotAction("rename_group_file_folder", {
      group_id: 777888,
      folder_id: "/d_1",
      new_folder_name: "共享目录",
    });
    assert.strictEqual(renFolder.status, "ok");
  } finally {
    if (wsNapClient) wsNapClient.handle.close();
    await compatBridge.stopServers();
  }
});
