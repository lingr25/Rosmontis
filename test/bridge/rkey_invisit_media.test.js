// @ts-check
"use strict";

/**
 * NTv2 RichMedia RKey Manager (`0x9067_202`), `inVisit` Virtual-Node Probing,
 * `-6101` Fast-Fail, and Cross-Session CDN Fallback Contract Tests
 */

const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { REPO_ROOT, mainMod } = require("./_helpers");

const rkeyMod = require(path.join(REPO_ROOT, "src", "core", "rkey_manager.js"));
const normalizerMod = require(path.join(REPO_ROOT, "src", "core", "nt_normalizer.js"));
const rendererIpcMod = require(path.join(REPO_ROOT, "src", "core", "renderer_ipc.js"));

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC",
  "base64"
);

/**
 * @param {number} n
 * @returns {Buffer}
 */
function encodeVarint(n) {
  /** @type {number[]} */
  const out = [];
  let v = BigInt(n);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return Buffer.from(out);
}

/**
 * @param {number} fieldNo
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function pbBytes(fieldNo, payload) {
  return Buffer.concat([
    encodeVarint((fieldNo << 3) | 2),
    encodeVarint(payload.length),
    payload,
  ]);
}

/**
 * @param {number} fieldNo
 * @param {number} val
 * @returns {Buffer}
 */
function pbVarint(fieldNo, val) {
  return Buffer.concat([encodeVarint((fieldNo << 3) | 0), encodeVarint(val)]);
}

/**
 * Builds a realistic OIDB `0x9067_202` response containing private (type 10) and group (type 20) rkeys.
 * @param {{ privRkey?: string, grpRkey?: string, ttl?: number, createTime?: number }} [opts]
 */
function buildMock0x9067Response(opts = {}) {
  const privRkey = opts.privRkey || "CAESKPRIVATETESTTOKEN123456";
  const grpRkey = opts.grpRkey || "CAESKGROUPTESTTOKEN654321";
  const ttl = opts.ttl ?? 3600;
  const createTime = opts.createTime ?? Math.floor(Date.now() / 1000);

  const itemPriv = Buffer.concat([
    pbBytes(1, Buffer.from(privRkey, "ascii")),
    pbVarint(2, ttl),
    pbVarint(3, 1),
    pbVarint(4, createTime),
    pbVarint(5, 10),
  ]);
  const itemGrp = Buffer.concat([
    pbBytes(1, Buffer.from(grpRkey, "ascii")),
    pbVarint(2, ttl),
    pbVarint(3, 1),
    pbVarint(4, createTime),
    pbVarint(5, 20),
  ]);
  const dlResp = Buffer.concat([pbBytes(1, itemPriv), pbBytes(1, itemGrp)]);
  const body = pbBytes(4, dlResp);
  return Buffer.concat([pbVarint(3, 0), pbBytes(4, body)]);
}

test("OIDB 0x9067_202 request payloads are 100% lossless UTF-8 and response parser handles exact & U+FFFD-corrupted payloads", () => {
  for (const includeScene of [true, false]) {
    const raw = rkeyMod.buildFetchDownloadRkeysRequestBuffer({ includeScene });
    const utf8 = rkeyMod.buildFetchDownloadRkeysUtf8Payload({ includeScene });
    const roundTripped = Buffer.from(utf8, "utf8");
    assert.strictEqual(
      roundTripped.equals(raw),
      true,
      `0x9067_202 payload (includeScene=${includeScene}) must survive V8 UTF-8 round-trip losslessly`
    );
  }

  // Exact protobuf decode
  const exactBuf = buildMock0x9067Response({
    privRkey: "CAESK_EXACT_PRIV_111111",
    grpRkey: "CAESK_EXACT_GRP_222222",
    ttl: 1800,
  });
  const parsedExact = rkeyMod.parseFetchDownloadRkeysResponse({ result: 0, rsp: exactBuf });
  assert.strictEqual(parsedExact.ok, true);
  assert.strictEqual(parsedExact.rkeys.length, 2);
  assert.strictEqual(parsedExact.rkeys[0].type, 10);
  assert.strictEqual(parsedExact.rkeys[0].rkey, "CAESK_EXACT_PRIV_111111");
  assert.strictEqual(parsedExact.rkeys[1].type, 20);
  assert.strictEqual(parsedExact.rkeys[1].rkey, "CAESK_EXACT_GRP_222222");

  // UTF-8 corrupted string (simulating napi_create_string_utf8 replacing invalid bytes with U+FFFD)
  const corruptedStr = exactBuf.toString("utf8");
  const parsedScanned = rkeyMod.parseFetchDownloadRkeysResponse({ result: 0, rsp: corruptedStr });
  assert.strictEqual(parsedScanned.ok, true);
  assert.strictEqual(parsedScanned.rkeys.length, 2);
  assert.strictEqual(
    parsedScanned.rkeys.find((r) => r.type === 10)?.rkey,
    "CAESK_EXACT_PRIV_111111"
  );
  assert.strictEqual(
    parsedScanned.rkeys.find((r) => r.type === 20)?.rkey,
    "CAESK_EXACT_GRP_222222"
  );

  // Non-zero SSO error result
  const errRes = rkeyMod.parseFetchDownloadRkeysResponse({ result: -100, errMsg: "sso failed" });
  assert.strictEqual(errRes.ok, false);
  assert.strictEqual(errRes.result, -100);
});

test("extractNtRichMediaAppId and RKey URL helpers classify NTv2 URLs and protobuf fileUuids", () => {
  assert.strictEqual(
    normalizerMod.extractNtRichMediaAppId("/download?appid=1406&fileid=abc&spec=0"),
    1406
  );
  assert.strictEqual(
    normalizerMod.extractNtRichMediaAppId({
      picElement: { originImageUrl: "https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=xyz" },
    }),
    1407
  );

  // Base64url-encoded protobuf with field 4 = 1407 (Group NTv2 RichMedia)
  const protoUuid = Buffer.concat([
    pbBytes(1, Buffer.from("dummy-node-id-0123456789")),
    pbVarint(4, 1407),
  ])
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assert.strictEqual(normalizerMod.extractNtRichMediaAppId({ picElement: { fileUuid: protoUuid } }), 1407);

  assert.strictEqual(rkeyMod.urlNeedsRKey("/download?appid=1406&fileid=abc"), true);
  assert.strictEqual(rkeyMod.urlNeedsRKey("/download?appid=1406&fileid=abc&rkey=ALREADY"), false);
  assert.strictEqual(rkeyMod.urlNeedsRKey("https://gchat.qpic.cn/gchatpic_new/1/2/0"), false);
  assert.strictEqual(
    rkeyMod.appendRKeyToUrl("/download?appid=1407&fileid=xyz", "&rkey=TOK_ABC_123"),
    "https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=xyz&rkey=TOK_ABC_123"
  );
  assert.strictEqual(
    rkeyMod.inferRKeyTypeFromUrlOrContext("/download?appid=1407&fileid=xyz"),
    rkeyMod.GROUP_IMAGE_RKEY_TYPE
  );
  assert.strictEqual(
    rkeyMod.inferRKeyTypeFromUrlOrContext("/download?appid=1406&fileid=xyz"),
    rkeyMod.PRIVATE_IMAGE_RKEY_TYPE
  );
});

test("Tier 2 void-async downloadRichMediaInVisit does not fall through to Tier 3", async () => {
  assert.strictEqual(
    rendererIpcMod.isVoidAsyncNtCmd("nodeIKernelRichMediaService/downloadRichMediaInVisit"),
    true
  );
  assert.strictEqual(
    rendererIpcMod.isVoidAsyncNtCmd("nodeIKernelMsgService/downloadRichMedia"),
    true
  );

  let tier2Calls = 0;
  let tier3Calls = 0;
  const bridge = new mainMod.NtqqOneBotBridge({
    config: {
      selfUin: "100010001",
      httpServers: [],
      wsServers: [],
      wsClients: [],
      heartbeatIntervalMs: 0,
      humanSimulation: false,
      quietLogs: true,
    },
  });
  bridge.capturedServices.ntApi = {
    "nodeIKernelMsgService/sendMsg": async () => ({ result: 0 }),
    "nodeIKernelRichMediaService/downloadRichMediaInVisit": async () => {
      tier2Calls += 1;
      return undefined;
    },
  };
  bridge.capturedServices.wrapperSession = {
    getRichMediaService: () => ({
      downloadRichMediaInVisit: async () => {
        tier3Calls += 1;
        return { result: 0 };
      },
    }),
  };

  const res = await bridge.invokeNt("nodeIKernelRichMediaService/downloadRichMediaInVisit", {
    downReq: {},
  });
  assert.strictEqual(res, undefined);
  assert.strictEqual(tier2Calls, 1);
  assert.strictEqual(tier3Calls, 0);
});

test("get_forward_msg + get_image probes inVisit, fast-fails on -6101, and falls back to 0x9067_202 RKey CDN with 403 retry", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rosmontis-rkey-e2e-"));
  let httpRequests = 0;
  let expiredFirst = true;

  const server = http.createServer((req, res) => {
    httpRequests += 1;
    const reqUrl = String(req.url || "");
    if (reqUrl.includes("rkey=STALE_RKEY_111111") && expiredFirst) {
      expiredFirst = false;
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("expired rkey");
      return;
    }
    if (reqUrl.includes("rkey=FRESH_RKEY_222222")) {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": String(TINY_PNG.length),
      });
      res.end(TINY_PNG);
      return;
    }
    res.writeHead(400);
    res.end("missing rkey");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const addr = /** @type {import("net").AddressInfo} */ (server.address());
  const localCdnUrl = `http://127.0.0.1:${addr.port}/download?appid=1406&fileid=EhRmockfile&spec=0`;

  try {
    let ssoCalls = 0;
    /** @type {any[]} */
    const inVisitCalls = [];

    const bridge = new mainMod.NtqqOneBotBridge({
      config: {
        selfUin: "100010001",
        httpServers: [],
        wsServers: [],
        wsClients: [],
        heartbeatIntervalMs: 0,
        humanSimulation: false,
        quietLogs: true,
        tempDir: tmpDir,
        allowPrivateMediaUrls: true,
        allowPrivateUrls: true,
        forwardMediaHydrationBudgetMs: 2500,
      },
    });
    bridge.online = true;

    const picMd5 = "0123456789abcdef0123456789abcdef";
    const childMsg = {
      msgId: "7770001",
      msgSeq: "42",
      msgRandom: "999",
      msgTime: String(Math.floor(Date.now() / 1000)),
      chatType: 0,
      peerUid: "0",
      senderUin: "200020002",
      senderUid: "u_sender_20002",
      sendNickName: "Alice",
      elements: [
        {
          elementType: 2,
          elementId: "8880001",
          picElement: {
            md5HexStr: picMd5,
            fileName: `${picMd5}.png`,
            fileUuid: "uuid-fwd-pic-1",
            fileSize: String(TINY_PNG.length),
            sourcePath: path.join(tmpDir, "missing_kernel_pic.png"),
            originImageUrl: localCdnUrl,
          },
        },
      ],
    };

    const outerPeer = { chatType: 1, peerUid: "u_friend_outer", guildId: "" };
    const outerShortId = bridge.messageIdStore.register("6660001", outerPeer, "10", {
      senderUid: "u_friend_outer",
      rawMsg: {
        msgId: "6660001",
        chatType: 1,
        peerUid: "u_friend_outer",
        senderUid: "u_friend_outer",
        elements: [
          {
            elementType: 16,
            elementId: "6660002",
            multiForwardMsgElement: {
              resId: "RES_FWD_TEST_1",
              fileName: "RES_FWD_TEST_1",
              xmlContent: "",
            },
          },
        ],
      },
    });
    assert.ok(outerShortId > 0);

    bridge.rendererExecute = async (/** @type {string} */ cmd, /** @type {any[]} */ args) => {
      const payload = args?.[0] || {};
      if (cmd === "nodeIKernelMsgService/getMultiMsg") {
        return { result: 0, msgList: [childMsg] };
      }
      if (cmd === "nodeIKernelMsgService/getRichMediaFilePathForGuild") {
        return path.join(tmpDir, "missing_kernel_pic.png");
      }
      if (cmd === "nodeIKernelRichMediaService/downloadRichMediaInVisit") {
        inVisitCalls.push(payload.downReq);
        // Immediately emit -6101 (fileErrCode=2006021) failure notification to trigger fast-fail
        setImmediate(() => {
          bridge.inboundPipeline._handleKernelEvent(
            "nodeIKernelMsgListener",
            "onRichMediaDownloadComplete",
            [
              {
                msgId: "7770001",
                msgElementId: "8880001",
                filePath: path.join(tmpDir, "missing_kernel_pic.png"),
                fileErrCode: 2006021,
                fileSrvErrCode: -6101,
                trasferStatus: 5,
              },
            ]
          );
        });
        return undefined;
      }
      if (cmd === "nodeIKernelMsgService/sendSsoCmdReqByContend") {
        ssoCalls += 1;
        const tok = ssoCalls === 1 ? "STALE_RKEY_111111" : "FRESH_RKEY_222222";
        return {
          result: 0,
          rsp: buildMock0x9067Response({ privRkey: tok, grpRkey: tok }),
        };
      }
      return { result: 0 };
    };

    const fwdRes = await bridge._dispatchAction("get_forward_msg", { id: "RES_FWD_TEST_1" });
    assert.ok(Array.isArray(fwdRes.messages) && fwdRes.messages.length === 1);
    assert.ok(inVisitCalls.length >= 1, "downloadRichMediaInVisit must be probed for inVisit forward nodes");
    assert.ok(ssoCalls >= 2, "0x9067_202 SSO must be called and refreshed after HTTP 403");
    assert.ok(httpRequests >= 2, "CDN fallback must retry once after refreshing expired rkey");

    const savedPath = path.join(tmpDir, "missing_kernel_pic.png");
    assert.strictEqual(fs.existsSync(savedPath), true, "RKey CDN fallback must write image to targetPath");
    assert.strictEqual(fs.readFileSync(savedPath).equals(TINY_PNG), true);

    // get_rkey should now return cached SSO rkeys cleanly
    const rkeyActionRes = await bridge._dispatchAction("get_rkey", {});
    assert.ok(Array.isArray(rkeyActionRes.rkeys) && rkeyActionRes.rkeys.length === 2);
    assert.strictEqual(rkeyActionRes.rkeys[0].rkey, "&rkey=FRESH_RKEY_222222");
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
