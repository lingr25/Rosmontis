"use strict";

/**
 * Outbound rate limiter, circuit breaker, outbound pipeline retcode 1429 integration,
 * and Electron renderer process crash/hang self-healing tests.
 */

const test = require("node:test");
const assert = require("assert");
const EventEmitter = require("events");

const { mainMod, sleep } = require("./_helpers");
const { OutboundRateLimiter } = require("../../src/core/rate_limiter");

// ============================================================================
// 1. OutboundRateLimiter Unit Tests
// ============================================================================

test("OutboundRateLimiter is disabled by default and passes all traffic", () => {
  const rl = new OutboundRateLimiter();
  assert.strictEqual(rl.enabled, false);
  for (let i = 0; i < 50; i += 1) {
    const res = rl.consume("1:u_peer_1:");
    assert.strictEqual(res.allowed, true);
    assert.strictEqual(res.reason, "disabled");
    assert.strictEqual(res.retryAfterMs, 0);
    assert.strictEqual(res.state, "closed");
  }
  const stats = rl.getStats();
  assert.strictEqual(stats.enabled, false);
  assert.strictEqual(stats.rejected, 0);
  assert.strictEqual(stats.activePeers, 0);
});

test("OutboundRateLimiter enforces global token bucket burst, smooth refill, and retryAfterMs", () => {
  let now = 10000;
  const rl = new OutboundRateLimiter({
    enabled: true,
    globalPerSec: 2, // 1 token per 500ms
    globalBurst: 3,
    perPeerPerSec: 100,
    perPeerBurst: 100,
    circuitBreakerThreshold: 10,
    now: () => now,
  });

  // Consume initial burst of 3
  for (let i = 0; i < 3; i += 1) {
    const res = rl.consume(`1:u_${i}:`);
    assert.strictEqual(res.allowed, true);
    assert.strictEqual(res.reason, "ok");
  }

  // 4th call immediately rejected by global bucket
  const rej1 = rl.consume("1:u_4:");
  assert.strictEqual(rej1.allowed, false);
  assert.strictEqual(rej1.reason, "global_rate_limit");
  assert.strictEqual(rej1.retryAfterMs, 500);
  assert.strictEqual(rej1.state, "closed");

  // Advance 250ms -> 0.5 tokens refilled, still < 1, retryAfterMs = 250ms
  now += 250;
  const rej2 = rl.consume("1:u_4:");
  assert.strictEqual(rej2.allowed, false);
  assert.strictEqual(rej2.reason, "global_rate_limit");
  assert.strictEqual(rej2.retryAfterMs, 250);

  // Advance another 250ms -> 1.0 token available -> allowed
  now += 250;
  const okAfterRefill = rl.consume("1:u_4:");
  assert.strictEqual(okAfterRefill.allowed, true);
  assert.strictEqual(okAfterRefill.reason, "ok");

  const stats = rl.getStats();
  assert.strictEqual(stats.enabled, true);
  assert.strictEqual(stats.allowed, 4);
  assert.strictEqual(stats.rejected, 2);
  assert.strictEqual(stats.globalRejected, 2);
  assert.strictEqual(stats.peerRejected, 0);
});

test("OutboundRateLimiter isolates per-peer buckets and refunds global token on peer rejection", () => {
  let now = 20000;
  const rl = new OutboundRateLimiter({
    enabled: true,
    globalPerSec: 0, // disable refill to prove exact token refunding
    globalBurst: 5,
    perPeerPerSec: 1,
    perPeerBurst: 2,
    circuitBreakerThreshold: 100,
    now: () => now,
  });

  // Peer A exhausts its 2-token per-peer burst (uses 2 of 5 global tokens)
  assert.strictEqual(rl.consume("1:u_noisy:").allowed, true);
  assert.strictEqual(rl.consume("1:u_noisy:").allowed, true);

  // Peer A floods 10 more rejected attempts -> must refund global token every single time!
  for (let i = 0; i < 10; i += 1) {
    const rej = rl.consume("1:u_noisy:");
    assert.strictEqual(rej.allowed, false);
    assert.strictEqual(rej.reason, "peer_rate_limit");
    assert.strictEqual(rej.retryAfterMs, 1000);
  }

  // Quiet peers B and C must still have all 3 remaining global tokens available!
  assert.strictEqual(rl.consume("1:u_quiet_b:").allowed, true);
  assert.strictEqual(rl.consume("1:u_quiet_b:").allowed, true);
  assert.strictEqual(rl.consume("1:u_quiet_c:").allowed, true);

  // Now all 5 global tokens are genuinely consumed -> next call hits global limit
  const globalRej = rl.consume("1:u_quiet_d:");
  assert.strictEqual(globalRej.allowed, false);
  assert.strictEqual(globalRej.reason, "global_rate_limit");

  const stats = rl.getStats();
  assert.strictEqual(stats.allowed, 5);
  assert.strictEqual(stats.peerRejected, 10);
  assert.strictEqual(stats.globalRejected, 1);
  assert.strictEqual(stats.rejected, 11);
});

test("OutboundRateLimiter circuit breaker transitions closed -> open -> half_open -> re-open -> half_open -> closed", () => {
  let now = 50000;
  const rl = new OutboundRateLimiter({
    enabled: true,
    globalPerSec: 1, // 1 token per 1000ms
    globalBurst: 1,
    perPeerPerSec: 10,
    perPeerBurst: 10,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 500, // shorter than 1s global refill so first half_open probe can fail
    now: () => now,
  });

  // Consume sole global token
  assert.strictEqual(rl.consume("1:u_1:").allowed, true);

  // 3 consecutive rejections trip the circuit breaker on the 3rd
  const r1 = rl.consume("1:u_1:");
  assert.strictEqual(r1.allowed, false);
  assert.strictEqual(r1.state, "closed");

  const r2 = rl.consume("1:u_1:");
  assert.strictEqual(r2.allowed, false);
  assert.strictEqual(r2.state, "closed");

  const r3 = rl.consume("1:u_1:");
  assert.strictEqual(r3.allowed, false);
  assert.strictEqual(r3.state, "open");
  assert.strictEqual(rl.getStats().circuitOpens, 1);
  assert.strictEqual(rl.getStats().circuitState, "open");

  // During cooldown, requests fail fast with circuit_open
  now += 200;
  const rOpen = rl.consume("1:u_2:");
  assert.strictEqual(rOpen.allowed, false);
  assert.strictEqual(rOpen.reason, "circuit_open");
  assert.strictEqual(rOpen.retryAfterMs, 300);
  assert.strictEqual(rOpen.state, "open");
  assert.strictEqual(rl.getStats().circuitRejected, 1);

  // Cooldown expires at +500ms total (now = 50500), but global bucket only refilled 0.5 tokens
  now += 300;
  assert.strictEqual(rl.getStats().circuitState, "half_open");

  // Failed probe in half_open re-opens circuit immediately
  const failedProbe = rl.consume("1:u_2:");
  assert.strictEqual(failedProbe.allowed, false);
  assert.strictEqual(failedProbe.reason, "global_rate_limit");
  assert.strictEqual(failedProbe.state, "open");
  assert.strictEqual(rl.getStats().circuitOpens, 2);

  // Advance another 600ms (total 1100ms elapsed since drain -> 1.0 full token + cooldown elapsed)
  now += 600;
  assert.strictEqual(rl.getStats().circuitState, "half_open");

  // Successful probe closes circuit and resets consecutive rejection streak
  const okProbe = rl.consume("1:u_2:");
  assert.strictEqual(okProbe.allowed, true);
  assert.strictEqual(okProbe.reason, "ok");
  assert.strictEqual(okProbe.state, "closed");
  assert.strictEqual(rl.getStats().circuitState, "closed");

  // Single subsequent rejection must NOT immediately re-open (streak was reset to 0)
  const postCloseRej = rl.consume("1:u_2:");
  assert.strictEqual(postCloseRej.allowed, false);
  assert.strictEqual(postCloseRej.state, "closed");
  assert.strictEqual(rl.getStats().circuitOpens, 2);
});

test("OutboundRateLimiter supports live updateConfig hot-reload, maxPeers LRU bound, and reset()", () => {
  let now = 100000;
  const rl = new OutboundRateLimiter({
    enabled: true,
    globalPerSec: 100,
    globalBurst: 100,
    perPeerPerSec: 10,
    perPeerBurst: 10,
    maxPeers: 3,
    now: () => now,
  });

  for (let i = 1; i <= 5; i += 1) {
    assert.strictEqual(rl.consume(`1:u_${i}:`).allowed, true);
  }
  assert.strictEqual(rl.getStats().activePeers, 3, "BoundedMap must cap activePeers at maxPeers");
  assert.strictEqual(rl.getStats().allowed, 5);

  // Hot-reload: lower burst & maxPeers while preserving cumulative stats
  rl.updateConfig({
    enabled: true,
    globalPerSec: 1,
    globalBurst: 1,
    perPeerPerSec: 1,
    perPeerBurst: 1,
    maxPeers: 2,
  });
  assert.strictEqual(rl.getStats().allowed, 5, "updateConfig must preserve cumulative stats");
  assert.strictEqual(rl.getStats().activePeers, 2, "updateConfig must shrink activePeers to new maxPeers");

  // Clamped burst=1 allows 1 then rejects
  assert.strictEqual(rl.consume("1:u_new:").allowed, true);
  assert.strictEqual(rl.consume("1:u_new:").allowed, false);
  assert.strictEqual(rl.getStats().allowed, 6);
  assert.strictEqual(rl.getStats().rejected, 1);

  // Hot-reload disable
  rl.updateConfig({ enabled: false });
  assert.strictEqual(rl.consume("1:u_new:").allowed, true);
  assert.strictEqual(rl.getStats().enabled, false);
  assert.strictEqual(rl.getStats().allowed, 6);

  // Reset wipes stats and peers
  rl.reset();
  const afterReset = rl.getStats();
  assert.strictEqual(afterReset.allowed, 0);
  assert.strictEqual(afterReset.rejected, 0);
  assert.strictEqual(afterReset.activePeers, 0);
  assert.strictEqual(afterReset.circuitState, "closed");
});

// ============================================================================
// 2. End-to-End Outbound Pipeline Rate Limit Integration (`retcode: 1429`)
// ============================================================================

test("send_private_msg returns retcode 1429 without invoking sendMsg or AIO lock when rate limit is exceeded, and supports hot-reload", async () => {
  let now = 200000;
  const kernelCalls = [];
  const bridge = new mainMod.NtqqOneBotBridge({
    selfUin: "100010001",
    selfUid: "u_self_rl",
    config: {
      selfUin: "100010001",
      httpServers: [],
      wsServers: [],
      wsClients: [],
      humanSimulation: true,
      quietLogs: true,
      rateLimit: {
        enabled: true,
        globalPerSec: 1,
        globalBurst: 5,
        perPeerPerSec: 0,
        perPeerBurst: 2,
        circuitBreakerThreshold: 5,
        now: () => now,
      },
    },
    ntApi: new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== "string" || !prop.includes("/")) return undefined;
          return async (payload) => {
            kernelCalls.push({ cmd: prop, payload });
            if (prop === "nodeIKernelMsgService/sendMsg") {
              return { result: 0, errMsg: "", msgId: `75000000000000${kernelCalls.length}` };
            }
            return { result: 0, errMsg: "" };
          };
        },
      }
    ),
  });
  bridge.uinUidStore.record("200020002", "u_rl_peer");
  bridge.uinUidStore.record("300030003", "u_rl_other");

  try {
    // 1st and 2nd private messages to u_rl_peer succeed
    const r1 = await bridge.handleOneBotAction("send_private_msg", {
      user_id: 200020002,
      message: "msg 1",
    });
    assert.strictEqual(r1.status, "ok");
    assert.strictEqual(r1.retcode, 0);

    const r2 = await bridge.handleOneBotAction("send_private_msg", {
      user_id: 200020002,
      message: "msg 2",
    });
    assert.strictEqual(r2.status, "ok");
    assert.strictEqual(r2.retcode, 0);

    const callsBeforeLimit = kernelCalls.length;
    const sendCallsBefore = kernelCalls.filter((c) => c.cmd === "nodeIKernelMsgService/sendMsg").length;
    assert.strictEqual(sendCallsBefore, 2);

    // 3rd private message to same peer must fail with retcode 1429 and ZERO kernel calls
    const r3 = await bridge.handleOneBotAction("send_private_msg", {
      user_id: 200020002,
      message: "msg 3 blocked",
    });
    assert.strictEqual(r3.status, "failed");
    assert.strictEqual(r3.retcode, 1429);
    assert.match(r3.message, /Rate limit exceeded/i);
    assert.match(r3.message, /peer_rate_limit/);
    assert.strictEqual(
      kernelCalls.length,
      callsBeforeLimit,
      "Rate-limited send must not invoke sendMsg or AIO activation kernel APIs"
    );

    // Different peer still succeeds (global token was refunded)
    const rOther = await bridge.handleOneBotAction("send_private_msg", {
      user_id: 300030003,
      message: "other peer unaffected",
    });
    assert.strictEqual(rOther.status, "ok");
    assert.strictEqual(rOther.retcode, 0);

    // Hot-reload bridge.config.rateLimit by replacing config reference -> disabling allows sends again
    bridge.config = {
      ...bridge.config,
      rateLimit: { enabled: false },
    };
    const rAfterReload = await bridge.handleOneBotAction("send_private_msg", {
      user_id: 200020002,
      message: "msg 4 after hot-reload disable",
    });
    assert.strictEqual(rAfterReload.status, "ok");
    assert.strictEqual(rAfterReload.retcode, 0);
  } finally {
    await bridge.stopServers();
  }
});

// ============================================================================
// 3. Renderer Process Crash & Hang Self-Healing (`src/core/renderer_ipc.js`)
// ============================================================================

function createFakeWebContents(id = 1, { reloadFn = null, url = "app://./renderer/index.html#/main" } = {}) {
  const ee = new EventEmitter();
  let destroyed = false;
  let reloadCount = 0;
  const wc = Object.assign(ee, {
    id,
    mainFrame: { id: `main-${id}` },
    isDestroyed: () => destroyed,
    getURL: () => url,
    isLoadingMainFrame: () => true,
    send() {},
    executeJavaScript: () => Promise.resolve(true),
    reload() {
      reloadCount += 1;
      if (typeof reloadFn === "function") {
        return reloadFn(reloadCount);
      }
      return undefined;
    },
    _markDestroyed() {
      destroyed = true;
      ee.emit("destroyed");
    },
    _getReloadCount: () => reloadCount,
  });
  return wc;
}

test("renderer_ipc self-heals on render-process-gone: rejects pending cmds, resets session, clears activeWebContents, reloads with crash-loop cap", async () => {
  const bridge = new mainMod.NtqqOneBotBridge({
    selfUin: "100010001",
    selfUid: "u_self_heal",
    config: {
      selfUin: "100010001",
      httpServers: [],
      wsServers: [],
      wsClients: [],
      quietLogs: true,
      rendererAutoReload: true,
      rendererMaxReloadsPerMinute: 3,
      rendererReloadBackoffMs: 0,
    },
  });

  const wc = createFakeWebContents(10);
  bridge.rendererIpc._ipcCmdAckInstalled = true;
  bridge.rendererIpc._attachToWebContents(wc);
  // Duplicate attach must be a no-op (no duplicate render-process-gone / unresponsive listeners)
  bridge.rendererIpc._attachToWebContents(wc);

  // Trigger initial injection
  wc.emit("did-finish-load");
  await sleep(10);

  assert.strictEqual(bridge.activeWebContents, wc);
  assert.strictEqual(wc.__rosmontisBridgeInjected, true);
  assert.strictEqual(wc.__rosmontisCmdChannelReady, true);

  // Seed human session state to verify crash resets it without invoking dead renderer
  bridge.sessionController.activeAioPeer = { chatType: 1, peerUid: "u_friend_1", guildId: "" };
  bridge.sessionController.activeAioPeerKey = "1:u_friend_1:";
  bridge.sessionController.windowFocused = true;

  // Create an in-flight pending renderer IPC command
  const pendingCmdPromise = bridge.rendererIpc._invokeRendererCommand("invokeNt", {
    cmd: "nodeIKernelGroupService/getGroupList",
    argsSerialized: "[{},null]",
  }, 10000);
  assert.strictEqual(bridge.rendererIpc._pendingRendererCmds.size, 1);

  try {
    // Emit render-process-gone (#1)
    wc.emit("render-process-gone", {}, { reason: "crashed", exitCode: 139 });

    // Pending command must reject immediately with bridge unavailable error
    await assert.rejects(
      () => pendingCmdPromise,
      /ROSMONTIS_BRIDGE_UNAVAILABLE.*renderer process gone \(crashed\)/
    );
    assert.strictEqual(bridge.rendererIpc._pendingRendererCmds.size, 0);

    // Flags, session state, activeWebContents cleared
    assert.strictEqual(wc.__rosmontisBridgeInjected, false);
    assert.strictEqual(wc.__rosmontisCmdChannelReady, false);
    assert.strictEqual(bridge.activeWebContents, null);
    assert.strictEqual(bridge.sessionController.activeAioPeer, null);
    assert.strictEqual(bridge.sessionController.activeAioPeerKey, "");
    assert.strictEqual(bridge.sessionController.windowFocused, false);

    // Wait for backoff=0 reload timer to fire
    await sleep(25);
    assert.strictEqual(wc._getReloadCount(), 1);
    assert.strictEqual(bridge.rendererHealthStats.crashes, 1);
    assert.strictEqual(bridge.rendererHealthStats.lastCrashReason, "crashed");
    assert.ok(bridge.rendererHealthStats.lastCrashAt > 0);
    assert.strictEqual(bridge.rendererHealthStats.recoveries, 1);
    assert.strictEqual(bridge.rendererHealthStats.reloadSuppressed, 0);

    // After reload completes, did-finish-load re-injects and restores activeWebContents
    wc.emit("did-finish-load");
    await sleep(10);
    assert.strictEqual(wc.__rosmontisBridgeInjected, true);
    assert.strictEqual(bridge.activeWebContents, wc);

    // Trigger crashes #2 and #3 (within 1 minute) -> allowed up to maxReloads=3
    wc.emit("render-process-gone", {}, { reason: "oom", exitCode: 137 });
    await sleep(25);
    wc.emit("render-process-gone", {}, { reason: "oom", exitCode: 137 });
    await sleep(25);
    assert.strictEqual(wc._getReloadCount(), 3);
    assert.strictEqual(bridge.rendererHealthStats.crashes, 3);
    assert.strictEqual(bridge.rendererHealthStats.recoveries, 3);
    assert.strictEqual(bridge.rendererHealthStats.reloadSuppressed, 0);

    // Crash #4 within 60s hits crash-loop cap -> reload suppressed!
    wc.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    await sleep(25);
    assert.strictEqual(wc._getReloadCount(), 3, "Crash-loop protection must cap reloads at rendererMaxReloadsPerMinute");
    assert.strictEqual(bridge.rendererHealthStats.crashes, 4);
    assert.strictEqual(bridge.rendererHealthStats.reloadSuppressed, 1);

    // Age out old reload timestamps (> 60s) -> reload is permitted again
    bridge.rendererIpc._rendererReloadTimestamps = bridge.rendererIpc._rendererReloadTimestamps.map((ts) => ts - 65000);
    wc.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    await sleep(25);
    assert.strictEqual(wc._getReloadCount(), 4);
    assert.strictEqual(bridge.rendererHealthStats.recoveries, 4);
  } finally {
    await bridge.stopServers();
  }
});

test("renderer_ipc tracks unresponsive/responsive state, reload failures, and cancels reload on stopServers or destroyed wc", async () => {
  let shouldThrowOnReload = true;
  const bridge = new mainMod.NtqqOneBotBridge({
    selfUin: "100010001",
    config: {
      selfUin: "100010001",
      httpServers: [],
      wsServers: [],
      wsClients: [],
      quietLogs: true,
      rendererAutoReload: true,
      rendererReloadBackoffMs: 0,
    },
  });

  const wc = createFakeWebContents(20, {
    reloadFn() {
      if (shouldThrowOnReload) {
        throw new Error("simulated reload error");
      }
    },
  });
  bridge.rendererIpc._attachToWebContents(wc);

  try {
    // Unresponsive -> responsive transitions
    assert.strictEqual(bridge.rendererHealthStats.unresponsiveActive, false);
    wc.emit("unresponsive");
    assert.strictEqual(bridge.rendererHealthStats.unresponsive, 1);
    assert.strictEqual(bridge.rendererHealthStats.unresponsiveActive, true);
    assert.ok(bridge.rendererHealthStats.lastUnresponsiveAt > 0);

    wc.emit("responsive");
    assert.strictEqual(bridge.rendererHealthStats.unresponsive, 1);
    assert.strictEqual(bridge.rendererHealthStats.unresponsiveActive, false);

    // Unresponsive followed by crash clears unresponsiveActive and records recoveryFailure if reload throws
    wc.emit("unresponsive");
    assert.strictEqual(bridge.rendererHealthStats.unresponsiveActive, true);
    wc.emit("render-process-gone", {}, { reason: "killed" });
    assert.strictEqual(bridge.rendererHealthStats.unresponsiveActive, false);

    await sleep(25);
    assert.strictEqual(bridge.rendererHealthStats.recoveryFailures, 1);
    assert.strictEqual(bridge.rendererHealthStats.recoveries, 0);

    // Schedule a slower reload, then destroy wc before timer fires -> reload must be skipped safely
    shouldThrowOnReload = false;
    bridge.config = {
      ...bridge.config,
      rendererReloadBackoffMs: 80,
    };
    const reloadsBeforeDestroy = wc._getReloadCount();
    wc.emit("render-process-gone", {}, { reason: "crashed" });
    wc._markDestroyed();
    await sleep(120);
    assert.strictEqual(
      wc._getReloadCount(),
      reloadsBeforeDestroy,
      "Destroyed webContents must not have reload() invoked after timer fires"
    );

    // Schedule reload on a second wc, then call stopServers() before timer fires -> reload skipped
    const wc2 = createFakeWebContents(21);
    bridge.rendererIpc._attachToWebContents(wc2);
    wc2.emit("render-process-gone", {}, { reason: "crashed" });
    await bridge.stopServers();
    await sleep(120);
    assert.strictEqual(
      wc2._getReloadCount(),
      0,
      "stopServers() must cancel pending renderer reload timers"
    );
  } finally {
    await bridge.stopServers();
  }
});
