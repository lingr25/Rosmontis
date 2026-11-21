"use strict";

const assert = require("assert");
const http = require("http");
const test = require("node:test");

const { CausalSessionScheduler } = require("../../src/core/session_scheduler");
const { NtqqOneBotBridge } = require("../../src/bridge_main");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("CausalSessionScheduler enforces queue timeout, advisory eviction, and maxQueueSize", async () => {
  const scheduler = new CausalSessionScheduler({
    defaultQueueTimeoutMs: 60,
    maxQueueSize: 2,
  });

  let releaseFirst;
  const firstBarrier = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const executed = [];
  const pFirst = scheduler.runExclusive("2:100:", async () => {
    executed.push("first");
    await firstBarrier;
    return "ok-1";
  });

  // Queue slot 1: advisory background task (should be evicted when explicit task arrives at capacity)
  const pAdvisory = scheduler.runExclusive(
    "1:u_adv:",
    async () => {
      executed.push("advisory");
      return "adv";
    },
    { advisory: true }
  );

  // Queue slot 2: explicit task with short 35ms timeout (will time out before firstBarrier releases)
  const pTimedOut = scheduler.runExclusive(
    "2:200:",
    async () => {
      executed.push("timed_out_should_not_run");
      return "bad";
    },
    { timeoutMs: 35 }
  );

  // Queue is now full (2/2: [pAdvisory, pTimedOut]).
  // Submitting another explicit task should evict pAdvisory and take its slot!
  const pExplicitEvictor = scheduler.runExclusive(
    "2:300:",
    async () => {
      executed.push("evictor");
      return "ok-evictor";
    },
    { timeoutMs: 500 }
  );

  await assert.rejects(
    pAdvisory,
    (err) => err.code === "ERR_SESSION_QUEUE_EVICTED" && err.retcode === 1429
  );

  // Queue is now full of 2 explicit tasks ([pTimedOut, pExplicitEvictor]); next explicit task overflows!
  await assert.rejects(
    scheduler.runExclusive("2:400:", async () => {
      executed.push("overflow_should_not_run");
    }),
    (err) => err.code === "ERR_SESSION_QUEUE_FULL" && err.retcode === 1429
  );

  // Wait for pTimedOut to expire while firstBarrier is still held
  await assert.rejects(
    pTimedOut,
    (err) => err.code === "ERR_SESSION_QUEUE_TIMEOUT" && err.retcode === 1429
  );

  releaseFirst();
  const [res1, resEvictor] = await Promise.all([pFirst, pExplicitEvictor]);
  assert.strictEqual(res1, "ok-1");
  assert.strictEqual(resEvictor, "ok-evictor");
  assert.deepStrictEqual(executed, ["first", "evictor"]);

  const stats = scheduler.getStats();
  assert.strictEqual(stats.timedOut, 1);
  assert.strictEqual(stats.evictedAdvisory, 1);
  assert.strictEqual(stats.overflowRejected, 1);
  assert.strictEqual(stats.queueLength, 0);
  scheduler.dispose();
});

test("HTTP client disconnect evicts queued send_group_msg before sendMsg IPC and updates telemetry/metrics", async () => {
  const sentTexts = [];
  let releaseSlowFirstSend = null;
  const firstSendStarted = new Promise((resolve) => {
    releaseSlowFirstSend = resolve;
  });
  let unblockFirstSend = null;
  const firstSendGate = new Promise((resolve) => {
    unblockFirstSend = resolve;
  });

  const bridge = new NtqqOneBotBridge({
    selfUin: "10001",
    selfUid: "u_self",
    online: true,
    autoStartServers: false,
    config: {
      selfUin: "10001",
      humanSimulation: true,
      outboundQueueTimeoutMs: 5000,
      outboundMaxQueueSize: 32,
      sendEchoTimeoutMs: 50,
      enableMetrics: true,
      httpServers: [
        {
          name: "http-test",
          host: "127.0.0.1",
          port: 0,
          accessToken: "test-secret-token",
        },
      ],
      wsServers: [],
      wsClients: [],
      httpClients: [],
    },
    rendererExecute: async (cmd, args) => {
      const payload = Array.isArray(args) ? args[0] : args;
      if (cmd === "nodeIKernelMsgService/sendMsg") {
        const text = payload?.msgElements?.[0]?.textElement?.content || "";
        sentTexts.push(text);
        if (text === "first-slow") {
          releaseSlowFirstSend();
          await firstSendGate;
        }
        return { result: 0, msgId: `75000${sentTexts.length}`, msgSeq: String(sentTexts.length) };
      }
      return { result: 0 };
    },
  });

  await bridge.startServers();
  try {
    const srv = bridge.serverRuntime._httpServers[0];
    const port = srv.address().port;

    const postJson = (reqPath, body) =>
      new Promise((resolve, reject) => {
        const buf = Buffer.from(JSON.stringify(body), "utf8");
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: reqPath,
            method: "POST",
            headers: {
              Authorization: "Bearer test-secret-token",
              "Content-Type": "application/json",
              "Content-Length": String(buf.length),
            },
          },
          (res) => {
            let out = "";
            res.on("data", (c) => (out += c));
            res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(out) }));
          }
        );
        req.on("error", reject);
        req.write(buf);
        req.end();
      });

    // 1. Start first send (holds AIO mutex while inside firstSendGate)
    const firstReqPromise = postJson("/send_group_msg", {
      group_id: 90001,
      message: "first-slow",
    });
    await firstSendStarted;

    // 2. Start second HTTP send, then prematurely destroy client socket after 35ms (simulating downstream timeout!)
    await new Promise((resolve) => {
      const buf = Buffer.from(
        JSON.stringify({ group_id: 90002, message: "second-aborted-by-timeout" }),
        "utf8"
      );
      const req2 = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/send_group_msg",
        method: "POST",
        headers: {
          Authorization: "Bearer test-secret-token",
          "Content-Type": "application/json",
          "Content-Length": String(buf.length),
        },
      });
      req2.on("error", () => {});
      req2.write(buf);
      req2.end();
      setTimeout(() => {
        req2.destroy();
        resolve();
      }, 35);
    });

    await sleep(40);

    // 3. Start third send that stays connected — should succeed once first completes!
    const thirdReqPromise = postJson("/send_group_msg", {
      group_id: 90003,
      message: "third-valid",
    });

    await sleep(20);
    unblockFirstSend();

    const [firstRes, thirdRes] = await Promise.all([firstReqPromise, thirdReqPromise]);
    assert.strictEqual(firstRes.json.retcode, 0);
    assert.strictEqual(thirdRes.json.retcode, 0);

    // Crucial invariant: the aborted second request NEVER called sendMsg!
    assert.deepStrictEqual(sentTexts, ["first-slow", "third-valid"]);

    // Verify get_status & /metrics expose session_queue stats AND reload_config updates queue settings live
    const statusRes = await postJson("/get_status", {});
    assert.strictEqual(statusRes.json.data.bridge.session_queue.aborted, 1);
    assert.strictEqual(statusRes.json.data.bridge.session_queue.defaultQueueTimeoutMs, 5000);

    const reloadRes = await postJson("/reload_config", {
      config: {
        ...bridge.config,
        outboundQueueTimeoutMs: 12000,
        outboundMaxQueueSize: 64,
      },
    });
    assert.strictEqual(reloadRes.json.retcode, 0);
    assert.strictEqual(reloadRes.json.data.network_restarted, false);

    // Trigger withLock sync and verify updated config + Prometheus /metrics
    await bridge.sessionController.withLock(async () => {});
    const metricsText = await new Promise((resolve, reject) => {
      http
        .get(
          {
            hostname: "127.0.0.1",
            port,
            path: "/metrics",
            headers: { Authorization: "Bearer test-secret-token" },
          },
          (res) => {
            let s = "";
            res.on("data", (c) => (s += c));
            res.on("end", () => resolve(s));
          }
        )
        .on("error", reject);
    });
    assert.match(metricsText, /rosmontis_session_queue_dropped_total\{reason="aborted"\} 1/);
    assert.strictEqual(bridge.sessionController.scheduler.defaultQueueTimeoutMs, 12000);
    assert.strictEqual(bridge.sessionController.scheduler.maxQueueSize, 64);
  } finally {
    await bridge.stopServers();
  }
});
