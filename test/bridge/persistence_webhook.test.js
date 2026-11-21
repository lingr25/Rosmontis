"use strict";

/**
 * StateDir persistence recovery, forward custom node cap, member pagination, async upload retry, concurrent inbound & HTTP Webhook Quick-Op
 * Migrated from test/test_bridge.js sections: 24.
 */

const test = require("node:test");
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { onebot, mainMod } = require("./_helpers");
// === Section 24: Testing StateDir Persistence, Forward Node Cap, Member Pagination, Async Upload, Concurrent Inbound & HTTP Webhook ===

test(
  "StateDir restart recovery, forward custom cap, multi-page members, upload retry, per-peer inbound concurrency, extended notices & HTTP Webhook Quick-Op",
  async () => {
    const os = require("os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rosmontis-e2e-s24-"));
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });

    // Start a local HTTP Webhook receiver with HMAC-SHA1 verification & Quick Operation reply
    const webhookDeliveries = [];
    const webhookSecret = "rosmontis-webhook-secret-2026";
    const webhookServer = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const rawBuf = Buffer.concat(chunks);
        const bodyStr = rawBuf.toString("utf8");
        const expectedSig =
          "sha1=" +
          crypto.createHmac("sha1", webhookSecret).update(rawBuf).digest("hex");
        const parsed = JSON.parse(bodyStr);
        webhookDeliveries.push({
          headers: req.headers,
          sigValid: req.headers["x-signature"] === expectedSig,
          event: parsed,
        });
        if (parsed.post_type === "message" && parsed.raw_message === "trigger-quick-op") {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ reply: "quick-op-pong", at_sender: true }));
        } else {
          res.writeHead(204);
          res.end();
        }
      });
    });
    await new Promise((resolve) => webhookServer.listen(0, "127.0.0.1", resolve));
    const webhookPort = webhookServer.address().port;

    let bridgeA = null;
    let bridgeB = null;
    try {
      let sendSeq = 9000;
      const sentPeerLog = [];
      let memberListPageCalls = 0;
      let getMsgsPollCalls = 0;
      let moveGroupFileAttempts = 0;
      let slowPeerDownloadStarted = false;
      let fastPeerDeliveredWhileSlowPending = false;
      let releaseSlowDownload = null;
      const slowDownloadBarrier = new Promise((resolve) => {
        releaseSlowDownload = resolve;
      });

      const sampleUploadFile = path.join(tmpDir, "report.pdf");
      fs.writeFileSync(sampleUploadFile, Buffer.from("%PDF-1.4 mock content"));
      const fastPicPath = path.join(tmpDir, "fast.jpg");
      fs.writeFileSync(fastPicPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

      const makeNtApi = (getBridge) => ({
        "nodeIKernelMsgService/sendMsg": async (payload) => {
          const curBridge = getBridge();
          const myId = `75000000000000${++sendSeq}`;
          sentPeerLog.push({
            peer: payload.peer,
            elements: payload.msgElements,
            msgId: myId,
          });
          setImmediate(() => {
            curBridge.inboundPipeline._handleKernelEvent("KernelMsgListener", "onAddSendMsg", [
              {
                msgId: myId,
                msgSeq: String(sendSeq),
                msgTime: String(Math.floor(Date.now() / 1000)),
                chatType: payload.peer.chatType,
                peerUid: payload.peer.peerUid,
                senderUin: "1000001",
                senderUid: "u_self_1000001",
                elements: payload.msgElements,
              },
            ]);
          });
          return { result: 0, errMsg: "" };
        },
        "nodeIKernelMsgService/multiForwardMsgWithComment": async (payload) => {
          const curBridge = getBridge();
          const fwdId = `75990000000000${++sendSeq}`;
          setImmediate(() => {
            curBridge.inboundPipeline._handleKernelEvent("KernelMsgListener", "onAddSendMsg", [
              {
                msgId: fwdId,
                msgSeq: String(sendSeq),
                msgTime: String(Math.floor(Date.now() / 1000)),
                chatType: payload.dstContact.chatType,
                peerUid: payload.dstContact.peerUid,
                senderUin: "1000001",
                senderUid: "u_self_1000001",
                elements: [{ elementType: 16, multiForwardMsgElement: { xmlContent: "<msg/>" } }],
              },
            ]);
          });
          return { result: 0, errMsg: "" };
        },
        "nodeIKernelGroupService/createMemberListScene": async () => ({
          sceneId: "scene_5000",
        }),
        "nodeIKernelGroupService/destroyMemberListScene": async () => ({ result: 0 }),
        "nodeIKernelGroupService/getNextMemberList": async (payload) => {
          memberListPageCalls += 1;
          if (memberListPageCalls === 1) {
            assert.strictEqual(payload.lastId, undefined);
            return {
              result: {
                finished: false,
                lastId: "u_mem_2",
                infos: new Map([
                  ["u_mem_1", { uid: "u_mem_1", uin: "20001", nick: "M1", role: 4 }],
                  ["u_mem_2", { uid: "u_mem_2", uin: "20002", nick: "M2", role: 3 }],
                ]),
              },
            };
          }
          assert.strictEqual(payload.lastId, "u_mem_2");
          return {
            result: {
              finished: true,
              lastId: "u_mem_3",
              infos: new Map([
                ["u_mem_3", { uid: "u_mem_3", uin: "20003", nick: "M3", role: 2 }],
              ]),
            },
          };
        },
        "nodeIKernelMsgService/getMsgsByMsgId": async (payload) => {
          getMsgsPollCalls += 1;
          const ready = getMsgsPollCalls >= 2;
          return {
            result: 0,
            msgList: [
              {
                msgId: payload.msgIds[0],
                elements: [
                  {
                    elementType: 3,
                    fileElement: {
                      fileName: "report.pdf",
                      fileUuid: ready ? "/uuid_delayed_999" : "",
                      bizId: 102,
                      transferStatus: ready ? 4 : 2,
                    },
                  },
                ],
              },
            ],
          };
        },
        "nodeIKernelRichMediaService/getGroupFileList": async () => ({
          groupFileListResult: {
            retCode: 0,
            item: [{ type: 1, fileInfo: { fileId: "/uuid_delayed_999", busId: 102 } }],
          },
        }),
        "nodeIKernelRichMediaService/moveGroupFile": async () => {
          moveGroupFileAttempts += 1;
          if (moveGroupFileAttempts === 1) {
            throw new Error("transient folder lock");
          }
          return { moveGroupFileResult: { result: { retCode: 0 } } };
        },
        "nodeIKernelMsgService/downloadRichMedia": async (payload) => {
          const getInfo = payload.getReq || payload;
          if (String(getInfo.peerUid) === "888001") {
            slowPeerDownloadStarted = true;
            await slowDownloadBarrier;
            return { filePath: fastPicPath };
          }
          return { filePath: fastPicPath };
        },
        "nodeIKernelMsgService/enterOrExitAio": async () => ({ result: 0 }),
        "nodeIKernelMsgService/setFocusOnBase": async () => ({ result: 0 }),
        "nodeIKernelMsgService/setMsgRead": async () => ({ result: 0 }),
        "nodeIKernelUixConvertService/getUid": async (p) => ({
          uidInfo: new Map((p.uins || []).map((u) => [String(u), `u_${u}`])),
        }),
        "nodeIKernelUixConvertService/getUin": async (p) => ({
          uinInfo: new Map(
            (p.uids || []).map((uid) => [String(uid), String(uid).replace(/^u_/, "")])
          ),
        }),
      });

      bridgeA = new mainMod.NtqqOneBotBridge({
        selfUin: "1000001",
        selfUid: "u_self_1000001",
        online: true,
        config: {
          selfUin: "1000001",
          stateDir,
          tempDir: tmpDir,
          allowedFileDirs: [tmpDir],
          humanSimulation: false,
          maxForwardCustomNodes: 3,
          inboundMediaConcurrency: 4,
          uploadFileUuidWaitMs: 1500,
          httpServers: [],
          wsServers: [],
          wsClients: [],
          httpClients: [
            {
              name: "test-webhook",
              url: `http://127.0.0.1:${webhookPort}/onebot/v11/http`,
              secret: webhookSecret,
              accessToken: "wh-token-123",
              timeoutMs: 3000,
              reportSelfMessage: false,
            },
          ],
          heartbeatIntervalMs: 0,
          wsPingIntervalMs: 0,
        },
        ntApi: makeNtApi(() => bridgeA),
      });
      await bridgeA.startServers();

      // 1. Multi-page get_group_member_list
      const memRes = await bridgeA.handleOneBotAction("get_group_member_list", {
        group_id: 777001,
      });
      assert.strictEqual(memRes.status, "ok");
      assert.strictEqual(memberListPageCalls, 2, "Must paginate until finished === true");
      assert.strictEqual(memRes.data.length, 3);
      assert.deepStrictEqual(
        memRes.data.map((m) => m.user_id).sort((a, b) => a - b),
        [20001, 20002, 20003]
      );

      // 2. Forward custom node cap (maxForwardCustomNodes: 3 with 7 custom nodes + 1 ref node)
      const refSend = await bridgeA.handleOneBotAction("send_group_msg", {
        group_id: 777001,
        message: "existing-ref-msg",
      });
      assert.strictEqual(refSend.status, "ok");
      const countBeforeFwd = sentPeerLog.length;
      const fwdNodes = [
        { type: "node", data: { id: String(refSend.data.message_id) } },
        ...Array.from({ length: 7 }, (_, idx) => ({
          type: "node",
          data: { name: `User${idx + 1}`, uin: "20001", content: `custom body ${idx + 1}` },
        })),
      ];
      const fwdRes = await bridgeA.handleOneBotAction("send_group_forward_msg", {
        group_id: 777001,
        messages: fwdNodes,
      });
      assert.strictEqual(fwdRes.status, "ok");
      const stagedDuringFwd = sentPeerLog.length - countBeforeFwd;
      assert.ok(
        stagedDuringFwd <= 4,
        `Custom forward nodes must be capped at maxForwardCustomNodes + 1 summary (got ${stagedDuringFwd})`
      );

      // 3. Delayed fileUuid polling + moveGroupFile retry in upload_group_file
      const upRes = await bridgeA.handleOneBotAction("upload_group_file", {
        group_id: 777001,
        file: sampleUploadFile,
        name: "report.pdf",
        folder: "/docs",
      });
      assert.strictEqual(upRes.status, "ok");
      assert.strictEqual(upRes.data.file_id, "/uuid_delayed_999");
      assert.ok(getMsgsPollCalls >= 2, "upload_group_file must poll until fileUuid settles");
      assert.strictEqual(moveGroupFileAttempts, 2, "moveGroupFile must retry transient error");

      // 4. Per-peer inbound concurrency: slow Group 888001 media must NOT block Group 888002 text
      const receivedEvents = [];
      bridgeA.on("onebot_event", (ev) => receivedEvents.push(ev));

      const slowBatchPromise = bridgeA.inboundPipeline._handleKernelEvent("KernelMsgListener", "onRecvMsg", [
        [
          {
            msgId: "7600001",
            msgSeq: "101",
            msgTime: "1710000101",
            chatType: 2,
            peerUid: "888001",
            senderUin: "30001",
            senderUid: "u_30001",
            elements: [
              {
                elementType: 2,
                elementId: "el_pic_slow",
                picElement: { fileUuid: "slow_pic_uuid", fileName: "slow.jpg", fileSize: 1024 },
              },
            ],
          },
        ],
      ]);

      while (!slowPeerDownloadStarted) {
        await new Promise((r) => setTimeout(r, 10));
      }

      await bridgeA.inboundPipeline._handleKernelEvent("KernelMsgListener", "onRecvMsg", [
        [
          {
            msgId: "7600002",
            msgSeq: "102",
            msgTime: "1710000102",
            chatType: 2,
            peerUid: "888002",
            senderUin: "30002",
            senderUid: "u_30002",
            elements: [{ elementType: 1, textElement: { content: "trigger-quick-op" } }],
          },
        ],
      ]);

      fastPeerDeliveredWhileSlowPending = receivedEvents.some(
        (e) => e.post_type === "message" && e.group_id === 888002
      );
      assert.strictEqual(
        fastPeerDeliveredWhileSlowPending,
        true,
        "Fast peer message must be delivered while slow peer media hydration is still awaiting download"
      );
      releaseSlowDownload();
      await slowBatchPromise;

      // 5. Extended inbound notices: group_msg_emoji_like, group_card, notify/title & lucky_king
      await bridgeA.inboundPipeline._handleKernelEvent("KernelMsgListener", "onMsgInfoListUpdate", [
        [
          {
            msgId: "7600002",
            msgSeq: "102",
            chatType: 2,
            peerUid: "888002",
            senderUin: "30002",
            senderUid: "u_30002",
            emojiLikesList: [{ emojiId: "128077", emojiType: 2, likesCnt: 3 }],
          },
        ],
      ]);
      assert.ok(
        receivedEvents.some(
          (e) =>
            e.post_type === "notice" &&
            e.notice_type === "group_msg_emoji_like" &&
            e.group_id === 888002 &&
            Array.isArray(e.likes) &&
            e.likes[0]?.emoji_id === "128077"
        ),
        "Must emit group_msg_emoji_like notice on emojiLikesList update"
      );

      await bridgeA.inboundPipeline._handleKernelEvent("KernelGroupListener", "onMemberInfoChange", [
        "888002",
        1,
        new Map([["u_30002", { uid: "u_30002", uin: "30002", cardName: "OldCard" }]]),
      ]);
      await bridgeA.inboundPipeline._handleKernelEvent("KernelGroupListener", "onMemberInfoChange", [
        "888002",
        1,
        new Map([["u_30002", { uid: "u_30002", uin: "30002", cardName: "NewCard" }]]),
      ]);
      assert.ok(
        receivedEvents.some(
          (e) =>
            e.post_type === "notice" &&
            e.notice_type === "group_card" &&
            e.group_id === 888002 &&
            e.user_id === 30002 &&
            e.card_old === "OldCard" &&
            e.card_new === "NewCard"
        ),
        "Must emit group_card notice when known member cardName changes"
      );

      await bridgeA.inboundPipeline._handleKernelEvent("KernelMsgListener", "onRecvMsg", [
        [
          {
            msgId: "7600003",
            msgSeq: "103",
            msgTime: "1710000103",
            chatType: 2,
            peerUid: "888002",
            elements: [
              {
                elementType: 8,
                grayTipElement: {
                  subElementType: 12,
                  xmlElement: {
                    busiId: "2403",
                    content: "<gtip>恭喜获得群主授予的“首席架构师”专属头衔</gtip>",
                    templParam: new Map([
                      ["uin_str2", "30002"],
                      ["title", "首席架构师"],
                    ]),
                  },
                },
              },
            ],
          },
          {
            msgId: "7600004",
            msgSeq: "104",
            msgTime: "1710000104",
            chatType: 2,
            peerUid: "888002",
            elements: [
              {
                elementType: 8,
                grayTipElement: {
                  subElementType: 12,
                  xmlElement: {
                    content: "<gtip>红包已被领完，运气王产生</gtip>",
                    templParam: new Map([
                      ["uin_str1", "30001"],
                      ["uin_str2", "30002"],
                    ]),
                  },
                },
              },
            ],
          },
        ],
      ]);
      assert.ok(
        receivedEvents.some(
          (e) =>
            e.post_type === "notice" &&
            e.notice_type === "notify" &&
            e.sub_type === "title" &&
            e.user_id === 30002 &&
            e.title === "首席架构师"
        ),
        "Must emit notify/title notice from exclusive title grayTip"
      );
      assert.ok(
        receivedEvents.some(
          (e) =>
            e.post_type === "notice" &&
            e.notice_type === "notify" &&
            e.sub_type === "lucky_king" &&
            e.user_id === 30001 &&
            e.target_id === 30002
        ),
        "Must emit notify/lucky_king notice without misclassifying as poke"
      );

      // 6. Verify HTTP Webhook delivery, HMAC-SHA1 X-Signature & Quick Operation auto-reply
      const waitDeadline = Date.now() + 2500;
      while (
        Date.now() < waitDeadline &&
        !sentPeerLog.some(
          (s) =>
            String(s.peer?.peerUid) === "888002" &&
            JSON.stringify(s.elements).includes("quick-op-pong")
        )
      ) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(webhookDeliveries.length > 0, "Webhook server must receive POST deliveries");
      assert.ok(
        webhookDeliveries.every((d) => d.sigValid),
        "Every HTTP POST webhook delivery must carry valid HMAC-SHA1 X-Signature"
      );
      assert.strictEqual(webhookDeliveries[0].headers["authorization"], "Bearer wh-token-123");
      assert.strictEqual(webhookDeliveries[0].headers["x-self-id"], "1000001");
      assert.ok(
        sentPeerLog.some(
          (s) =>
            String(s.peer?.peerUid) === "888002" &&
            JSON.stringify(s.elements).includes("quick-op-pong")
        ),
        "Webhook 200 Quick Operation response must dispatch reply back to group 888002"
      );

      // 7. Stop bridgeA -> flushes stateDir stores -> boot bridgeB and recover message_id + UIN/UID
      const persistedMsgShortId = refSend.data.message_id;
      await bridgeA.stopServers();
      bridgeA = null;

      bridgeB = new mainMod.NtqqOneBotBridge({
        selfUin: "1000001",
        selfUid: "u_self_1000001",
        online: true,
        config: {
          selfUin: "1000001",
          stateDir,
          httpServers: [],
          wsServers: [],
          wsClients: [],
          httpClients: [],
          heartbeatIntervalMs: 0,
          wsPingIntervalMs: 0,
        },
        ntApi: makeNtApi(() => bridgeB),
      });
      assert.strictEqual(
        bridgeB.uinUidStore.getUinSync("u_mem_3"),
        "20003",
        "BridgeB must restore UinUidStore mappings from stateDir on startup"
      );
      const recoveredEntry = bridgeB.messageIdStore.resolveByOneBotId(persistedMsgShortId);
      assert.ok(
        recoveredEntry && recoveredEntry.peer?.peerUid === "777001",
        "BridgeB must restore MessageIdStore shortId mappings from stateDir on startup"
      );
    } finally {
      if (bridgeA) await bridgeA.stopServers();
      if (bridgeB) await bridgeB.stopServers();
      await new Promise((resolve) => webhookServer.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
);
