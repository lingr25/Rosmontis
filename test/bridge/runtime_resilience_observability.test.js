"use strict";

const assert = require("assert");
const EventEmitter = require("events");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { NtqqOneBotBridge } = require("../../src/bridge_main");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("nt_cache_pruner & clean_cache prune expired allowlisted media/logs while protecting DBs, File, mmkv & symlinks", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rosmontis-ntcache-test-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "rosmontis-ntcache-outside-"));
  try {
    const ntData = path.join(tmpRoot, "nt_qq_profile1", "nt_data");
    const picOldDir = path.join(ntData, "Pic", "2026-10");
    const picNewDir = path.join(ntData, "Pic", "2026-11");
    const emojiDir = path.join(ntData, "Emoji");
    const logDir = path.join(ntData, "log");
    const mmkvDir = path.join(ntData, "mmkv");
    const userFileDir = path.join(ntData, "File");

    for (const d of [picOldDir, picNewDir, emojiDir, logDir, mmkvDir, userFileDir]) {
      fs.mkdirSync(d, { recursive: true });
    }

    const oldPic = path.join(picOldDir, "expired_pic.jpg");
    const protectedDbInPic = path.join(ntData, "Pic", "thumb_index.db");
    const freshPic = path.join(picNewDir, "fresh_pic.jpg");
    const oldEmoji = path.join(emojiDir, "expired_sticker.png");
    const oldLog = path.join(logDir, "nt_old.log");
    const protectedMmkv = path.join(mmkvDir, "mmkv_auth_state");
    const protectedUserDoc = path.join(userFileDir, "contract.pdf");
    const outsideSecret = path.join(outsideDir, "do_not_delete.jpg");

    fs.writeFileSync(oldPic, Buffer.alloc(2048, 0xaa));
    fs.writeFileSync(protectedDbInPic, "sqlite-header");
    fs.writeFileSync(freshPic, Buffer.alloc(1024, 0xbb));
    fs.writeFileSync(oldEmoji, Buffer.alloc(512, 0xcc));
    fs.writeFileSync(oldLog, Buffer.alloc(4096, 0xdd));
    fs.writeFileSync(protectedMmkv, "secret-mmkv-login");
    fs.writeFileSync(protectedUserDoc, "important-user-file");
    fs.writeFileSync(outsideSecret, "outside-secret");

    const tenDaysAgoSec = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;
    for (const f of [
      oldPic,
      protectedDbInPic,
      oldEmoji,
      oldLog,
      protectedMmkv,
      protectedUserDoc,
      outsideSecret,
    ]) {
      fs.utimesSync(f, tenDaysAgoSec, tenDaysAgoSec);
    }

    // Attempt symlink creation (skipped gracefully if Windows developer mode lacks symlink privilege)
    const symlinkPath = path.join(emojiDir, "linked_outside.jpg");
    try {
      fs.symlinkSync(outsideSecret, symlinkPath);
    } catch (_) {}

    const bridge = new NtqqOneBotBridge({
      selfUin: "10001",
      online: true,
      autoStartServers: false,
      config: {
        selfUin: "10001",
        ntCacheDir: tmpRoot,
        cleanCachePrunesNtData: true,
        httpServers: [],
        wsServers: [],
        wsClients: [],
        httpClients: [],
      },
    });

    const usageBefore = await bridge.handleOneBotAction("get_nt_cache_info", {});
    assert.strictEqual(usageBefore.retcode, 0);
    assert.strictEqual(usageBefore.data.totalFiles, 4); // oldPic + freshPic + oldEmoji + oldLog
    assert.strictEqual(usageBefore.data.totalBytes, 2048 + 1024 + 512 + 4096);

    const cleanRes = await bridge.handleOneBotAction("clean_cache", { max_age_hours: 72 });
    assert.strictEqual(cleanRes.retcode, 0);
    assert.strictEqual(cleanRes.data.nt_cache_pruned.deletedFiles, 3);
    assert.strictEqual(cleanRes.data.nt_cache_pruned.freedBytes, 2048 + 512 + 4096);
    assert.strictEqual(cleanRes.data.nt_cache_pruned.remainingFiles, 1);

    // Expired media/logs and empty date leaf dir removed
    assert.strictEqual(fs.existsSync(oldPic), false);
    assert.strictEqual(fs.existsSync(picOldDir), false);
    assert.strictEqual(fs.existsSync(oldEmoji), false);
    assert.strictEqual(fs.existsSync(oldLog), false);

    // Recent cache + protected directories/extensions + outside symlink target strictly preserved
    assert.strictEqual(fs.existsSync(freshPic), true);
    assert.strictEqual(fs.existsSync(protectedDbInPic), true);
    assert.strictEqual(fs.existsSync(protectedMmkv), true);
    assert.strictEqual(fs.existsSync(protectedUserDoc), true);
    assert.strictEqual(fs.existsSync(outsideSecret), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("AnomalyRecorder captures unhandled elementType payloads with 100% PII/secret scrubbing and disk persistence", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "rosmontis-anomaly-test-"));
  try {
    const bridge = new NtqqOneBotBridge({
      selfUin: "10001",
      selfUid: "u_botSelfSecret99",
      online: true,
      autoStartServers: false,
      config: {
        selfUin: "10001",
        stateDir,
        persistStores: false,
        recordAnomalies: true,
        persistAnomalies: true,
        httpServers: [],
        wsServers: [],
        wsClients: [],
        httpClients: [],
      },
    });

    await bridge.inboundPipeline._handleKernelEvent("NodeIKernelMsgListener", "onRecvMsg", [
      [
        {
          msgId: "7499912345678901234",
          msgSeq: "88",
          msgTime: 1730000123,
          chatType: 2,
          msgType: 2,
          peerUid: "876543210",
          senderUin: "3904429615",
          senderUid: "u_realSensitiveAlpha777",
          sendNickName: "秘密昵称Alice",
          elements: [
            {
              elementType: 99,
              subElementType: 4,
              futureWidgetElement: {
                creatorUid: "u_realSensitiveAlpha777",
                secretToken: "super-secret-rkey-token",
                downloadUrl: "https://multimedia.nt.qq.com.cn/download?appid=1407&rkey=PRIVATE_RKEY_999",
                localCachePath: "/app/.config/QQ/nt_qq_abc/nt_data/Pic/private.png",
                title: "机密群公告正文",
              },
            },
          ],
        },
      ],
    ]);

    await sleep(40);

    const anomRes = await bridge.handleOneBotAction("get_bridge_anomalies", {
      include_payloads: true,
    });
    assert.strictEqual(anomRes.retcode, 0);
    assert.strictEqual(anomRes.data.totalRecorded, 1);
    const rec = anomRes.data.recent[0];
    assert.strictEqual(rec.kind, "unhandled_element_type");
    assert.strictEqual(rec.sanitizedPayload.elements[0].elementType, 99);
    assert.strictEqual(rec.sanitizedPayload.elements[0].subElementType, 4);
    // Relational UID equality preserved across fields while raw UID is scrubbed!
    assert.strictEqual(
      rec.sanitizedPayload.senderUid,
      rec.sanitizedPayload.elements[0].futureWidgetElement.creatorUid
    );

    const serialized = JSON.stringify(rec);
    for (const secret of [
      "3904429615",
      "876543210",
      "u_realSensitiveAlpha777",
      "秘密昵称Alice",
      "super-secret-rkey-token",
      "PRIVATE_RKEY_999",
      "nt_qq_abc",
      "机密群公告正文",
    ]) {
      assert.ok(!serialized.includes(secret), `Secret leaked in anomaly record: ${secret}`);
    }

    const savedFiles = fs.readdirSync(path.join(stateDir, "anomalies")).filter((f) => f.endsWith(".json"));
    assert.strictEqual(savedFiles.length, 1);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("check_liveness self-heals drifted wrapperSession, flips /ready to 503 on silent logout, and recovers on login", async () => {
  let loggedInState = true;
  const oldSession = { id: "old_session" };
  const driftedSession = { id: "new_session_after_reconnect" };
  const newMsgEmitter = new EventEmitter();
  const fakeNtStore = {
    wrapperSession: oldSession,
    listenerEventEmitterMap: new Map(),
  };

  const bridge = new NtqqOneBotBridge({
    selfUin: "10001",
    selfUid: "u_self",
    online: true,
    autoStartServers: false,
    wrapperSession: oldSession,
    rendererExecute: async (cmd) => {
      if (cmd === "nodeIKernelLoginService/getLoginList") {
        return {
          LocalLoginInfoList: [
            { uin: "10001", uid: "u_self", isUserLogin: loggedInState, isAutoLogin: true },
          ],
        };
      }
      return { result: 0 };
    },
    config: {
      selfUin: "10001",
      livenessCheckIntervalMs: 0,
      livenessIdleThresholdMs: 50,
      enableMetrics: true,
      httpServers: [{ name: "http", host: "127.0.0.1", port: 0, accessToken: "tok" }],
      wsServers: [],
      wsClients: [],
      httpClients: [],
    },
  });
  bridge.capturedServices.ntStore = fakeNtStore;

  await bridge.startServers();
  try {
    const port = bridge.serverRuntime._httpServers[0].address().port;
    const httpGet = (reqPath) =>
      new Promise((resolve, reject) => {
        http
          .get(
            {
              hostname: "127.0.0.1",
              port,
              path: reqPath,
              headers: { Authorization: "Bearer tok", Connection: "close" },
            },
            (res) => {
              let body = "";
              res.on("data", (c) => (body += c));
              res.on("end", () => resolve({ status: res.statusCode, body }));
            }
          )
          .on("error", reject);
      });

    // 1. Simulate silent wrapperSession replacement on ntStore + new listener emitter
    fakeNtStore.wrapperSession = driftedSession;
    fakeNtStore.listenerEventEmitterMap.set("NodeIKernelMsgListener", newMsgEmitter);

    const liveRes1 = await bridge.handleOneBotAction("check_liveness", { force: true });
    assert.strictEqual(liveRes1.retcode, 0);
    assert.strictEqual(liveRes1.data.sessionRebinds, 1);
    assert.strictEqual(bridge.capturedServices.wrapperSession, driftedSession);

    // 2. Simulate silent account logout while bridge.online was still true in memory
    loggedInState = false;
    const liveRes2 = await bridge.handleOneBotAction("check_liveness", { force: true });
    assert.strictEqual(liveRes2.data.healthy, false);
    assert.strictEqual(liveRes2.data.degradedReason, "self_account_logged_out");

    const readyDegraded = await httpGet("/ready");
    assert.strictEqual(readyDegraded.status, 503);
    const readyDegradedJson = JSON.parse(readyDegraded.body);
    assert.strictEqual(readyDegradedJson.liveness_ok, false);
    assert.strictEqual(readyDegradedJson.degraded_reason, "self_account_logged_out");

    const metricsDegraded = await httpGet("/metrics");
    assert.match(metricsDegraded.body, /rosmontis_liveness_ok 0/);
    assert.match(metricsDegraded.body, /rosmontis_session_rebinds_total 1/);

    // 3. Simulate fresh login recovery -> /ready returns 200 OK again
    loggedInState = true;
    bridge.inboundPipeline._updateSelfIdentity({ uin: "10001", uid: "u_self", markOnline: true });
    const readyRecovered = await httpGet("/ready");
    assert.strictEqual(readyRecovered.status, 200);
    assert.strictEqual(JSON.parse(readyRecovered.body).ready, true);
  } finally {
    await bridge.stopServers();
  }
});
