"use strict";

/**
 * Architectural & Core Submodule Unit Test Suite (`test/test_core_modules.js`)
 *
 * Directly verifies the modularized Rosmontis architecture:
 * 1. `src/core/env.js` & zero-scattered-`process.env` source invariant
 * 2. `src/core/primitives.js` (`BoundedMap`, `TtlDedupeSet`, `TempCleanupQueue`,
 *    event waiters, `BridgeLogger`, symmetric lossless wire codec, `createActionRouter`)
 * 3. `src/core/nt_normalizer.js` (V1/V2 anti-corruption normalizers & `"0"` UIN guards)
 * 4. `src/core/echo_correlator.js` (`EchoCorrelator` out-of-order & lifecycle drain)
 * 5. `src/core/session_controller.js` (`HumanSessionController` & causal step runners)
 * 6. `src/onebot/*` decomposed protocol modules & `MessageIdStore.prototype.resolve`
 * 7. Declarative action router collision & coverage guarantees + installer LF invariant
 * 8. `src/core/renderer_ipc.js` (`SERVICE_GETTER_MAP`, `SIDE_EFFECT_NT_METHODS` & Tier-3/replay guards)
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const envMod = require("../src/core/env");
const {
  BoundedMap,
  setBoundedMap,
  TtlDedupeSet,
  TempCleanupQueue,
  createEventWaiter,
  waitForEventOnce,
  BridgeLogger,
  safeJsJson,
  serializeBridgePayload,
  reviveBridgePayload,
  createActionRouter,
} = require("../src/core/primitives");
const ntNormalizerMod = require("../src/core/nt_normalizer");
const {
  isPositiveUin,
  pickPositiveUin,
  normalizePeer,
  normalizeGroupSummary,
  normalizeBuddyProfile,
  normalizeGroupMember,
  normalizeLoginIdentity,
} = ntNormalizerMod;
const {
  EchoCorrelator,
  hasRichMediaElements,
} = require("../src/core/echo_correlator");
const {
  HumanSessionController,
  runCausalActivateSteps,
  runCausalLeaveSteps,
} = require("../src/core/session_controller");
const {
  SERVICE_GETTER_MAP,
  SIDE_EFFECT_NT_METHODS,
  isSideEffectNtCmd,
  makeBridgeUnavailableError,
  rendererIpcMixin,
} = require("../src/core/renderer_ipc");
const storesMod = require("../src/onebot/stores");
const cqCodecMod = require("../src/onebot/cq_codec");
const segmentConverterMod = require("../src/onebot/segment_converter");
const eventFormatterMod = require("../src/onebot/event_formatter");
const bridgeOnebotFacade = require("../src/bridge_onebot");
const audioCodecMod = require("../src/core/audio_codec");

const messageActions = require("../src/actions/message_actions");
const contactActions = require("../src/actions/contact_actions");
const groupActions = require("../src/actions/group_actions");
const fileMediaActions = require("../src/actions/file_media_actions");

function walkJsFiles(dirPath) {
  const results = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      results.push(full);
    }
  }
  return results;
}

async function withSavedEnv(keys, fn) {
  const saved = new Map();
  for (const k of keys) {
    saved.set(k, Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined);
    delete process.env[k];
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function runTests() {
  console.log("=== Rosmontis Core Architecture Module Suite ===");

  // --------------------------------------------------------------------------
  // Suite 1: Unified Environment Module & Single-Source `process.env` Invariant
  // --------------------------------------------------------------------------
  {
    const srcRoot = path.resolve(__dirname, "..", "src");
    const envFile = path.resolve(srcRoot, "core", "env.js");
    const allSrcFiles = walkJsFiles(srcRoot);
    assert.ok(allSrcFiles.length >= 28, "Expected decomposed src/ module tree");

    for (const filePath of allSrcFiles) {
      if (path.resolve(filePath) === envFile) continue;
      const content = fs.readFileSync(filePath, "utf8");
      assert.strictEqual(
        /\bprocess\.env\b/.test(content),
        false,
        `Direct process.env access must be confined to src/core/env.js, found in ${path.relative(srcRoot, filePath)}`
      );
    }

    await withSavedEnv(
      [
        "ROSMONTIS_ACCESS_TOKEN",
        "ONEBOT_ACCESS_TOKEN",
        "XIAO_BRIDGE_ACCESS_TOKEN",
        "ROSMONTIS_ALLOWED_FILE_DIRS",
        "ONEBOT_ALLOWED_FILE_DIRS",
        "XIAO_BRIDGE_ALLOWED_FILE_DIRS",
        "ONEBOT_QUIET",
      ],
      async () => {
        process.env.XIAO_BRIDGE_ACCESS_TOKEN = "legacy-tok";
        assert.strictEqual(envMod.pickPrefixedEnv("ACCESS_TOKEN"), "legacy-tok");
        process.env.ONEBOT_ACCESS_TOKEN = "onebot-tok";
        assert.strictEqual(envMod.pickPrefixedEnv("ACCESS_TOKEN"), "onebot-tok");
        process.env.ROSMONTIS_ACCESS_TOKEN = "rosmontis-tok";
        assert.strictEqual(envMod.pickPrefixedEnv("ACCESS_TOKEN"), "rosmontis-tok");

        process.env.ROSMONTIS_ALLOWED_FILE_DIRS = "/a";
        process.env.XIAO_BRIDGE_ALLOWED_FILE_DIRS = "/b";
        assert.deepStrictEqual(envMod.collectPrefixedEnvValues("ALLOWED_FILE_DIRS"), ["/a", "/b"]);

        process.env.ONEBOT_QUIET = "true";
        assert.strictEqual(envMod.isQuietLogsEnabled({ quietLogs: false }), true);
      }
    );
    console.log("  [PASS] Suite 1: Unified env resolver & zero-scattered process.env invariant");
  }

  // --------------------------------------------------------------------------
  // Suite 2: Core Primitives, Wire Codec & Declarative Action Router
  // --------------------------------------------------------------------------
  {
    const lru = new BoundedMap(3);
    lru.set("a", 1).set("b", 2).set("c", 3);
    assert.strictEqual(lru.get("a"), 1); // refreshes "a" as MRU
    lru.set("d", 4); // evicts "b"
    assert.strictEqual(lru.has("b"), false);
    assert.deepStrictEqual([...lru.keys()], ["c", "a", "d"]);

    const plainMap = new Map();
    setBoundedMap(plainMap, "k1", 1, 2);
    setBoundedMap(plainMap, "k2", 2, 2);
    setBoundedMap(plainMap, "k1", 10, 2);
    setBoundedMap(plainMap, "k3", 3, 2);
    assert.deepStrictEqual([...plainMap.entries()], [["k1", 10], ["k3", 3]]);

    const dedupe = new TtlDedupeSet(3, 5000);
    assert.strictEqual(dedupe.isDuplicate("ev1"), false);
    assert.strictEqual(dedupe.isDuplicate("ev1"), true);
    assert.strictEqual(dedupe.isDuplicate("ev2"), false);
    assert.strictEqual(dedupe.isDuplicate("ev3"), false);
    assert.strictEqual(dedupe.isDuplicate("ev4"), false);
    assert.strictEqual(dedupe.entries.size, 3);

    let cleaned = 0;
    const cleanupQueue = new TempCleanupQueue(() => ({
      cleanupTempImmediately: false,
      maxTempCleanupRing: 8,
      tempCleanupDelayMs: 60000,
    }));
    for (let i = 0; i < 9; i++) {
      cleanupQueue.schedule(() => { cleaned += 1; });
    }
    assert.strictEqual(cleaned, 1); // 9th item overflows maxRing=8 -> runs oldest immediately
    cleanupQueue.flush();
    assert.strictEqual(cleaned, 9);

    const waiters = new Set();
    const waitPromise = waitForEventOnce(waiters, 500, (v) => v && v.ready === true);
    for (const fn of [...waiters]) fn({ ready: false });
    assert.strictEqual(waiters.size, 1, "Non-matching predicate must keep waiter active");
    for (const fn of [...waiters]) fn({ ready: true, count: 42 });
    const waitRes = await waitPromise;
    assert.deepStrictEqual(waitRes, { ready: true, count: 42 });
    assert.strictEqual(waiters.size, 0);

    const cancelableSet = new Set();
    const handle = createEventWaiter(cancelableSet, 5000);
    assert.strictEqual(cancelableSet.size, 1);
    handle.cancel();
    assert.strictEqual(await handle.promise, null);
    assert.strictEqual(cancelableSet.size, 0);

    const emittedLines = [];
    let cfgState = { quietLogs: false, debugLogs: false };
    const logger = new BridgeLogger({
      getConfig: () => cfgState,
      write: (line) => emittedLines.push(line),
    });
    assert.strictEqual(logger.debug("scope", "hidden when debugLogs=false"), false);
    cfgState.debugLogs = true;
    assert.strictEqual(logger.debug("scope", "visible debug"), true);
    assert.strictEqual(logger.warnThrottled("k", "warn once", 60000), true);
    assert.strictEqual(logger.warnThrottled("k", "warn duplicate", 60000), false);
    cfgState.quietLogs = true;
    assert.strictEqual(logger.error("suppressed in quiet mode"), false);
    assert.strictEqual(emittedLines.length, 2);

    // Symmetric cross-process wire codec (Map, Uint8Array, bigint, void, XSS chars)
    const nestedMap = new Map([
      ["thumb", new Map([[0, "/tmp/thumb_0.jpg"]])],
      ["bytes", new Uint8Array([1, 2, 255])],
      ["undefVal", undefined],
    ]);
    const rawPayload = {
      msgId: 7299999999999999999n,
      scriptTag: "</script>\u2028\u2029",
      attrs: nestedMap,
      arr: [undefined, "ok"],
    };
    const wireJson = serializeBridgePayload(rawPayload);
    assert.ok(!wireJson.includes("</script>"), "HTML script close must be escaped");
    assert.ok(!wireJson.includes("\u2028"), "JS line separator must be escaped");
    assert.strictEqual(safeJsJson("<tag>"), '"\\u003ctag\\u003e"');

    const revived = reviveBridgePayload(
      JSON.parse(wireJson),
    );
    assert.strictEqual(revived.msgId, "7299999999999999999");
    assert.strictEqual(revived.scriptTag, "</script>\u2028\u2029");
    assert.ok(revived.attrs instanceof Map);
    assert.strictEqual(revived.attrs.get("thumb").get(0), "/tmp/thumb_0.jpg");
    assert.ok(revived.attrs.get("bytes") instanceof Uint8Array);
    assert.deepStrictEqual(Array.from(revived.attrs.get("bytes")), [1, 2, 255]);
    assert.strictEqual(
      reviveBridgePayload({ __rosmontisVoid__: true }),
      undefined
    );

    // Declarative action router
    const router = createActionRouter(
      {
        canonical_act(p, ctx, invokedAction) {
          return { selfTag: this.tag, x: p.x, fmt: ctx.messageFormat, invokedAction };
        },
      },
      { alias_act: "canonical_act" }
    );
    assert.ok(router.HANDLED_ACTIONS.has("canonical_act"));
    assert.ok(router.HANDLED_ACTIONS.has("alias_act"));
    const aliasResult = await router.dispatch.call(
      { tag: "bridge-ctx" },
      "alias_act",
      { x: 9 },
      { messageFormat: "string" }
    );
    assert.deepStrictEqual(aliasResult, {
      selfTag: "bridge-ctx",
      x: 9,
      fmt: "string",
      invokedAction: "alias_act",
    });
    assert.throws(
      () => createActionRouter({ ok() {} }, { bad_alias: "nonexistent" }),
      /missing or invalid handler/
    );
    console.log("  [PASS] Suite 2: Core primitives, lossless wire codec & action router");
  }

  // --------------------------------------------------------------------------
  // Suite 3: NTQQ Anti-Corruption Normalizers (`src/core/nt_normalizer.js`)
  // --------------------------------------------------------------------------
  {
    assert.strictEqual(isPositiveUin("0"), false);
    assert.strictEqual(isPositiveUin(0), false);
    assert.strictEqual(isPositiveUin("-10"), false);
    assert.strictEqual(isPositiveUin("123456"), true);
    assert.strictEqual(pickPositiveUin("0", "", null, "987654321"), 987654321);

    assert.deepStrictEqual(normalizePeer({ chatType: "2", peerUid: " 888999 " }), {
      chatType: 2,
      peerUid: "888999",
      guildId: "",
      peerKey: "2:888999:",
    });

    const grp = normalizeGroupSummary({
      groupCode: "7654321",
      groupName: "Rosmontis Dev",
      memberCount: "42",
      maxMember: 500,
      remarkName: "Core Team",
    });
    assert.strictEqual(grp.groupId, 7654321);
    assert.strictEqual(grp.groupName, "Rosmontis Dev");
    assert.strictEqual(grp.memberCount, 42);
    assert.strictEqual(grp.maxMemberCount, 500);
    assert.strictEqual(grp.groupRemark, "Core Team");

    const buddy = normalizeBuddyProfile({
      uid: "u_top",
      uin: "0",
      simpleInfo: {
        coreInfo: { uid: "u_core", uin: "24681012", nick: "Amiya", remark: "Leader" },
        baseInfo: { sex: 2, age: 16, qid: "amiya_rhodes", longNick: "Working hard" },
      },
    });
    assert.strictEqual(buddy.uid, "u_core");
    assert.strictEqual(buddy.uin, 24681012);
    assert.strictEqual(buddy.nickname, "Amiya");
    assert.strictEqual(buddy.remark, "Leader");
    assert.strictEqual(buddy.sex, "female");
    assert.strictEqual(buddy.age, 16);

    const member = normalizeGroupMember(
      { uid: "u_m1", uin: "13579", nick: "Kal'tsit", role: 3, memberSpecialTitle: "Doctor" },
      "7654321"
    );
    assert.strictEqual(member.group_id, 7654321);
    assert.strictEqual(member.uin, 13579);
    assert.strictEqual(member.role, "admin");
    assert.strictEqual(member.roleNum, 3);
    assert.strictEqual(member.title, "Doctor");

    // QQNT 3.2.32-52194 MemberRole mapping: 4 -> owner, 3 -> admin, 2 -> member (ordinary member), 0 -> member
    const ownerMember = normalizeGroupMember({ uid: "u_m4", uin: "10004", role: 4 }, 7654321);
    assert.strictEqual(ownerMember.role, "owner");
    assert.strictEqual(ownerMember.roleNum, 4);
    assert.strictEqual(normalizeGroupMember({ uid: "u_m4s", uin: "10014", role: "4" }, 7654321).role, "owner");
    assert.strictEqual(normalizeGroupMember({ uid: "u_m3s", uin: "10013", role: "3" }, 7654321).role, "admin");

    const ordinaryMember = normalizeGroupMember({ uid: "u_m2", uin: "10002", role: 2 }, 7654321);
    assert.strictEqual(ordinaryMember.role, "member");
    assert.strictEqual(ordinaryMember.roleNum, 2);
    assert.strictEqual(normalizeGroupMember({ uid: "u_m2s", uin: "10012", role: "2" }, 7654321).role, "member");

    const zeroRoleMember = normalizeGroupMember({ uid: "u_m0", uin: "10000", role: 0 }, 7654321);
    assert.strictEqual(zeroRoleMember.role, "member");
    assert.strictEqual(zeroRoleMember.roleNum, 0);
    assert.strictEqual(normalizeGroupMember({ uid: "u_m0s", uin: "10010", role: "0" }, 7654321).role, "member");

    const strOwner = normalizeGroupMember({ uid: "u_so", uin: "20004", role: "owner" }, 7654321);
    assert.strictEqual(strOwner.role, "owner");
    assert.strictEqual(strOwner.roleNum, 4);
    const strAdmin = normalizeGroupMember({ uid: "u_sa", uin: "20003", role: "admin" }, 7654321);
    assert.strictEqual(strAdmin.role, "admin");
    assert.strictEqual(strAdmin.roleNum, 3);
    const strMember = normalizeGroupMember({ uid: "u_sm", uin: "20002", role: "member" }, 7654321);
    assert.strictEqual(strMember.role, "member");
    assert.strictEqual(strMember.roleNum, 2);

    if (typeof ntNormalizerMod.mapGroupRole === "function") {
      assert.strictEqual(ntNormalizerMod.mapGroupRole(4), "owner");
      assert.strictEqual(ntNormalizerMod.mapGroupRole(3), "admin");
      assert.strictEqual(ntNormalizerMod.mapGroupRole(2), "member");
      assert.strictEqual(ntNormalizerMod.mapGroupRole(0), "member");
      assert.strictEqual(ntNormalizerMod.mapGroupRole("owner"), "owner");
      assert.strictEqual(ntNormalizerMod.mapGroupRole("admin"), "admin");
    }

    assert.deepStrictEqual(
      normalizeLoginIdentity({ uin: "0", selfInfo: { uin: "10001", uid: "u_self", nickName: "Bot" } }),
      { uin: "10001", uid: "u_self", nick: "Bot" }
    );
    console.log("  [PASS] Suite 3: NTQQ anti-corruption normalizers & placeholder UIN guards");
  }

  // --------------------------------------------------------------------------
  // Suite 4: Standalone EchoCorrelator & HumanSessionController
  // --------------------------------------------------------------------------
  {
    const correlator = new EchoCorrelator();
    const peer = { chatType: 2, peerUid: "90001" };
    const picA = [{ elementType: 2, picElement: { md5HexStr: "aaaa", fileSize: 2 * 1024 * 1024 } }];
    const picB = [{ elementType: 2, picElement: { md5HexStr: "bbbb", fileSize: 512 } }];
    assert.strictEqual(hasRichMediaElements(picA), true);
    assert.ok(correlator.computeTimeoutMs(picA, { sendEchoTimeoutMs: 3000, richMediaEchoTimeoutMs: 15000 }) >= 17000);

    const wA = correlator.register(peer, picA);
    const wB = correlator.register(peer, picB);
    // Out-of-order echo: B arrives before A
    assert.strictEqual(
      correlator.match({ chatType: 2, peerUid: "90001", msgId: "7002", msgSeq: "22", elements: picB }),
      true
    );
    assert.strictEqual(
      correlator.match({ chatType: 2, peerUid: "90001", msgId: "7001", msgSeq: "21", elements: picA }),
      true
    );
    assert.strictEqual((await wB.wait(100)).msgId, "7002");
    assert.strictEqual((await wA.wait(100)).msgId, "7001");

    // Pending waiter cleanly drained via clear()
    const wPending = correlator.register(peer, picA);
    const pendingPromise = wPending.wait(10000);
    correlator.clear();
    assert.strictEqual(await pendingPromise, null);
    assert.strictEqual(correlator.waiters.size, 0);

    // HumanSessionController causal steps & deduplication (QQNT 3.2.32-52194 contracts)
    const ntCalls = [];
    const controller = new HumanSessionController({
      getConfig: () => ({
        humanSimulation: true,
        aioSwitchCooldownMs: 0,
        dedupeWindowMs: 5000,
        humanReadToTypingDelayMs: 0,
        aioIdleExitMs: 0,
        focusIdleBlurMs: 0,
      }),
      invokeNt: async (cmd, payload, positionalArgs) => {
        ntCalls.push({ cmd, payload, positionalArgs });
        return { result: 0 };
      },
    });

    const peer1 = { chatType: 1, peerUid: "u_peer_1", guildId: "" };
    const firstAct = await controller.simulate({
      chatType: 1,
      peerUid: "u_peer_1",
      markRead: true,
      sendTyping: true,
    });
    assert.strictEqual(firstAct.markRead, true);
    assert.strictEqual(firstAct.sendTyping, true);
    assert.strictEqual(controller.activeAioPeerKey, "1:u_peer_1:");
    assert.strictEqual(controller.windowFocused, true);
    assert.strictEqual(
      ntCalls.some((c) => c.cmd.includes("addActiveChatByUid")),
      false,
      "addActiveChatByUid must never be called in QQNT 3.2.32 causal steps"
    );
    assert.deepStrictEqual(ntCalls, [
      {
        cmd: "nodeIKernelMsgService/setFocusOnBase",
        payload: { peer: peer1, ...peer1 },
        positionalArgs: [peer1],
      },
      {
        cmd: "nodeIKernelMsgService/enterOrExitAio",
        payload: { info_list: [{ peer: peer1, option: 1 }] },
        positionalArgs: [[{ peer: peer1, option: 1 }]],
      },
      {
        cmd: "nodeIKernelMsgService/setMsgRead",
        payload: { peer: peer1 },
        positionalArgs: [peer1],
      },
      {
        cmd: "nodeIKernelMsgService/sendShowInputStatusReq",
        payload: { chatType: 1, eventType: 1, peerUid: "u_peer_1" },
        positionalArgs: [1, 1, "u_peer_1"],
      },
    ]);

    // Immediate second call within dedupeWindowMs skips duplicate read & typing IPCs
    const secondAct = await controller.simulate({
      chatType: 1,
      peerUid: "u_peer_1",
      markRead: true,
      sendTyping: true,
    });
    assert.strictEqual(secondAct.alreadyInAio, true);
    assert.strictEqual(secondAct.markRead, false);
    assert.strictEqual(secondAct.sendTyping, false);
    assert.strictEqual(ntCalls.length, 4);

    const blurPeer = { chatType: 0, peerUid: "", guildId: "" };
    const leaveRes = await controller.leave({ exitAio: true, blurWindow: true });
    assert.strictEqual(leaveRes.exitedAio, true);
    assert.strictEqual(leaveRes.blurredWindow, true);
    assert.strictEqual(controller.activeAioPeerKey, "");
    assert.strictEqual(controller.windowFocused, false);
    assert.deepStrictEqual(ntCalls.slice(4), [
      {
        cmd: "nodeIKernelMsgService/enterOrExitAio",
        payload: { info_list: [{ peer: peer1, option: 2 }] },
        positionalArgs: [[{ peer: peer1, option: 2 }]],
      },
      {
        cmd: "nodeIKernelMsgService/setFocusOnBase",
        payload: { peer: blurPeer, ...blurPeer },
        positionalArgs: [blurPeer],
      },
    ]);

    // Direct standalone step runners: AIO switch (exit option=2 -> enter option=1) + typing + leave
    const directCalls = [];
    const recordDirect = async (cmd, payload, positionalArgs) => {
      directCalls.push({ cmd, payload, positionalArgs });
      return { result: 0 };
    };
    const nextPeer = { chatType: 1, peerUid: "u_peer_2", guildId: "" };
    const actStepRes = await runCausalActivateSteps({
      peer: nextPeer,
      peerKey: "1:u_peer_2:",
      prevPeer: peer1,
      prevPeerKey: "1:u_peer_1:",
      windowFocused: false,
      shouldMarkRead: true,
      shouldSendTyping: true,
      effEventType: 2,
      readToTypingDelayMs: 0,
      invokeNt: recordDirect,
    });
    assert.strictEqual(actStepRes.exitedPreviousAio, true);
    assert.strictEqual(actStepRes.setFocusOnBase, true);
    assert.strictEqual(actStepRes.markRead, true);
    assert.strictEqual(actStepRes.sendTyping, true);
    assert.deepStrictEqual(directCalls, [
      {
        cmd: "nodeIKernelMsgService/setFocusOnBase",
        payload: { peer: nextPeer, ...nextPeer },
        positionalArgs: [nextPeer],
      },
      {
        cmd: "nodeIKernelMsgService/enterOrExitAio",
        payload: { info_list: [{ peer: peer1, option: 2 }] },
        positionalArgs: [[{ peer: peer1, option: 2 }]],
      },
      {
        cmd: "nodeIKernelMsgService/enterOrExitAio",
        payload: { info_list: [{ peer: nextPeer, option: 1 }] },
        positionalArgs: [[{ peer: nextPeer, option: 1 }]],
      },
      {
        cmd: "nodeIKernelMsgService/setMsgRead",
        payload: { peer: nextPeer },
        positionalArgs: [nextPeer],
      },
      {
        cmd: "nodeIKernelMsgService/sendShowInputStatusReq",
        payload: { chatType: 1, eventType: 2, peerUid: "u_peer_2" },
        positionalArgs: [1, 2, "u_peer_2"],
      },
    ]);

    directCalls.length = 0;
    const leaveStepRes = await runCausalLeaveSteps({
      shouldExitAio: true,
      shouldBlur: true,
      prevPeer: nextPeer,
      invokeNt: recordDirect,
    });
    assert.strictEqual(leaveStepRes.exitedAio, true);
    assert.strictEqual(leaveStepRes.blurredWindow, true);
    assert.strictEqual(
      directCalls.some((c) => c.cmd.includes("addActiveChatByUid")),
      false
    );
    assert.deepStrictEqual(directCalls, [
      {
        cmd: "nodeIKernelMsgService/enterOrExitAio",
        payload: { info_list: [{ peer: nextPeer, option: 2 }] },
        positionalArgs: [[{ peer: nextPeer, option: 2 }]],
      },
      {
        cmd: "nodeIKernelMsgService/setFocusOnBase",
        payload: { peer: blurPeer, ...blurPeer },
        positionalArgs: [blurPeer],
      },
    ]);

    controller.reset();
    console.log("  [PASS] Suite 4: EchoCorrelator & HumanSessionController lifecycle");
  }

  // --------------------------------------------------------------------------
  // Suite 5: Decomposed `src/onebot/*` Submodules, Action Disjointness & Installer LF
  // --------------------------------------------------------------------------
  {
    assert.strictEqual(bridgeOnebotFacade.MessageIdStore, storesMod.MessageIdStore);
    assert.strictEqual(bridgeOnebotFacade.segmentsToCqCode, cqCodecMod.segmentsToCqCode);
    assert.strictEqual(bridgeOnebotFacade.ntMsgToOneBotSegments, segmentConverterMod.ntMsgToOneBotSegments);
    assert.strictEqual(bridgeOnebotFacade.formatNtMsgToOneBotEvent, eventFormatterMod.formatNtMsgToOneBotEvent);

    const store = new storesMod.MessageIdStore(100);
    const shortId = store.register("7300000000000000123", { chatType: 2, peerUid: "555666" }, "88");
    const byShort = store.resolve(shortId);
    const byRawNt = store.resolve("7300000000000000123");
    assert.ok(byShort && byRawNt);
    assert.strictEqual(byShort.msgId, "7300000000000000123");
    assert.strictEqual(byRawNt.entry.oneBotId, shortId);

    // Verify 4 action routers have zero overlapping action names and >= 130 total routes
    const seenActions = new Set();
    for (const mod of [messageActions, contactActions, groupActions, fileMediaActions]) {
      assert.ok(mod.HANDLED_ACTIONS instanceof Set && mod.HANDLED_ACTIONS.size > 0);
      assert.strictEqual(typeof mod.dispatch, "function");
      for (const act of mod.HANDLED_ACTIONS) {
        assert.strictEqual(seenActions.has(act), false, `Overlapping action route: ${act}`);
        seenActions.add(act);
      }
    }
    assert.ok(seenActions.size >= 130, `Expected >= 130 total OneBot routes, got ${seenActions.size}`);

    // Shell scripts mounted into Linux containers must retain LF line endings
    for (const relScript of ["scripts/install_bridge.sh", "scripts/entrypoint.sh"]) {
      const scriptBytes = fs.readFileSync(path.resolve(__dirname, "..", relScript), "utf8");
      assert.strictEqual(
        scriptBytes.includes("\r\n"),
        false,
        `${relScript} must use LF line endings for Linux container execution`
      );
    }
    console.log(
      `  [PASS] Suite 5: Decomposed onebot/* facade, ${seenActions.size} disjoint action routes & LF shell scripts`
    );
  }

  // --------------------------------------------------------------------------
  // Suite 6: Pure-JS Audio Codec (SILK v3 / AMR-NB / WAV) & Normalization
  // --------------------------------------------------------------------------
  {
    const os = require("os");
    const crypto = require("crypto");
    const tmpAudioDir = fs.mkdtempSync(path.join(os.tmpdir(), "rosmontis_audio_codec_"));

    try {
      // 6a. Build 250 frames (5.0s) of Tencent SILK v3 (\x02#!SILK_V3 + 2-byte LE blocks + 0xFFFF EOF)
      const silkFrameChunks = [audioCodecMod.TENCENT_SILK_MAGIC];
      for (let i = 0; i < 250; i++) {
        const payloadLen = 12 + (i % 20);
        const hdr = Buffer.alloc(2);
        hdr.writeInt16LE(payloadLen, 0);
        const payload = Buffer.alloc(payloadLen);
        for (let j = 0; j < payloadLen; j++) {
          payload[j] = (i * 17 + j * 31) & 0xff;
        }
        silkFrameChunks.push(hdr, payload);
      }
      const eofFooter = Buffer.alloc(2);
      eofFooter.writeInt16LE(-1, 0);
      silkFrameChunks.push(eofFooter);
      const tencentSilkBuf = Buffer.concat(silkFrameChunks);

      const silkInfo = audioCodecMod.inspectAudioBuffer(tencentSilkBuf);
      assert.strictEqual(silkInfo.format, "silk_tencent");
      assert.strictEqual(silkInfo.isNtNativeVoice, true);
      assert.strictEqual(silkInfo.frameCount, 250);
      assert.strictEqual(silkInfo.duration, 5);
      assert.ok(
        Array.isArray(silkInfo.waveAmplitudes) &&
          silkInfo.waveAmplitudes.length >= 8 &&
          silkInfo.waveAmplitudes.every((v) => Number.isInteger(v) && v >= 12 && v <= 95)
      );

      // 6b. Raw SILK v3 (#!SILK_V3 without leading 0x02, 200 frames = 4.0s) -> pure-JS 0x02 normalization
      const rawSilkBody = tencentSilkBuf.subarray(1, 1 + 9); // "#!SILK_V3"
      const rawFrames = [];
      for (let i = 0; i < 200; i++) {
        const hdr = Buffer.alloc(2);
        hdr.writeInt16LE(16, 0);
        rawFrames.push(hdr, Buffer.alloc(16, (i * 13) & 0xff));
      }
      const rawSilkBuf = Buffer.concat([rawSilkBody, ...rawFrames, eofFooter]);
      const rawSilkPath = path.join(tmpAudioDir, "raw_voice.silk");
      fs.writeFileSync(rawSilkPath, rawSilkBuf);
      const rawSilkMd5 = crypto.createHash("md5").update(rawSilkBuf).digest("hex");

      const normalizedSilk = await audioCodecMod.prepareVoiceMedia(
        {
          localPath: rawSilkPath,
          fileName: "raw_voice.silk",
          fileSize: rawSilkBuf.length,
          md5HexStr: rawSilkMd5,
        },
        { tempDir: tmpAudioDir }
      );
      assert.strictEqual(normalizedSilk.format, "silk_tencent");
      assert.strictEqual(normalizedSilk.duration, 4);
      assert.strictEqual(normalizedSilk.fileSize, rawSilkBuf.length + 1);
      assert.ok(normalizedSilk.extraTempMedia && normalizedSilk.extraTempMedia.isTempFile);
      const normalizedBytes = fs.readFileSync(normalizedSilk.localPath);
      assert.strictEqual(normalizedBytes[0], 0x02);
      assert.strictEqual(
        normalizedSilk.md5HexStr,
        crypto.createHash("md5").update(normalizedBytes).digest("hex")
      );

      // 6c. AMR-NB (#!AMR\n + 150 mode-7 32-byte frames = 3.0s)
      const amrFrames = [audioCodecMod.AMR_NB_MAGIC];
      for (let i = 0; i < 150; i++) {
        const frame = Buffer.alloc(32);
        frame[0] = (7 << 3) | 0x04; // Mode 7 (12.2 kbps -> 32 bytes), Q=1
        for (let j = 1; j < 32; j++) {
          frame[j] = (i * 29 + j * 7) & 0xff;
        }
        amrFrames.push(frame);
      }
      const amrBuf = Buffer.concat(amrFrames);
      const amrInfo = audioCodecMod.inspectAudioBuffer(amrBuf);
      assert.strictEqual(amrInfo.format, "amr_nb");
      assert.strictEqual(amrInfo.isNtNativeVoice, true);
      assert.strictEqual(amrInfo.frameCount, 150);
      assert.strictEqual(amrInfo.duration, 3);

      // 6d. 16-bit PCM WAV (8000 Hz mono, 2.0s = 16000 samples) + clear error when ffmpeg binary is missing
      const sampleRate = 8000;
      const numSamples = sampleRate * 2;
      const pcmBytes = numSamples * 2;
      const wavBuf = Buffer.alloc(44 + pcmBytes);
      wavBuf.write("RIFF", 0, "ascii");
      wavBuf.writeUInt32LE(36 + pcmBytes, 4);
      wavBuf.write("WAVE", 8, "ascii");
      wavBuf.write("fmt ", 12, "ascii");
      wavBuf.writeUInt32LE(16, 16);
      wavBuf.writeUInt16LE(1, 20); // PCM
      wavBuf.writeUInt16LE(1, 22); // mono
      wavBuf.writeUInt32LE(sampleRate, 24);
      wavBuf.writeUInt32LE(sampleRate * 2, 28);
      wavBuf.writeUInt16LE(2, 32);
      wavBuf.writeUInt16LE(16, 34);
      wavBuf.write("data", 36, "ascii");
      wavBuf.writeUInt32LE(pcmBytes, 40);
      for (let i = 0; i < numSamples; i++) {
        const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000);
        wavBuf.writeInt16LE(sample, 44 + i * 2);
      }
      const wavInfo = audioCodecMod.inspectAudioBuffer(wavBuf);
      assert.strictEqual(wavInfo.format, "wav");
      assert.strictEqual(wavInfo.isNtNativeVoice, false);
      assert.strictEqual(wavInfo.sampleRate, 8000);
      assert.strictEqual(wavInfo.duration, 2);

      const wavPath = path.join(tmpAudioDir, "tone.wav");
      fs.writeFileSync(wavPath, wavBuf);
      await assert.rejects(
        () =>
          audioCodecMod.prepareVoiceMedia(
            {
              localPath: wavPath,
              fileName: "tone.wav",
              fileSize: wavBuf.length,
              md5HexStr: crypto.createHash("md5").update(wavBuf).digest("hex"),
            },
            {
              tempDir: tmpAudioDir,
              ffmpegPath: path.join(tmpAudioDir, "nonexistent_ffmpeg_bin"),
            }
          ),
        (err) => err && err.code === "ERR_VOICE_TRANSCODE_FAILED" && /WAV/.test(err.message)
      );
    } finally {
      fs.rmSync(tmpAudioDir, { recursive: true, force: true });
    }
    console.log("  [PASS] Suite 6: Pure-JS SILK/AMR/WAV audio inspector & voice normalizer");
  }

  // --------------------------------------------------------------------------
  // Suite 7: Pure-JS cross-platform plugin loader & desktop QQ media cache LFI
  // --------------------------------------------------------------------------
  {
    const tmpPluginRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "rosmontis_plugin_test_"));
    const prevTestMode = process.env.ROSMONTIS_TEST_MODE;
    const prevDisable = process.env.ROSMONTIS_DISABLE;
    const prevCfgDir = process.env.ROSMONTIS_CONFIG_DIR;
    const prevHome = process.env.HOME;
    try {
      process.env.ROSMONTIS_TEST_MODE = "1";
      delete process.env.ROSMONTIS_DISABLE;
      delete process.env.ROSMONTIS_CONFIG_DIR;

      const repoRoot = path.resolve(__dirname, "..");
      const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "manifest.json"), "utf8"));
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
      assert.strictEqual(manifest.manifest_version, 4);
      assert.strictEqual(manifest.injects.main, "./src/plugin_loader.js");
      assert.strictEqual(pkg.qwqnt.injects.main, "./src/plugin_loader.js");

      const pluginLoader = require("../src/plugin_loader");
      assert.strictEqual(
        pluginLoader.getBridgeInstance(),
        null,
        "plugin_loader must not auto-boot when ROSMONTIS_TEST_MODE=1"
      );

      const llDataDir = path.join(tmpPluginRoot, "liteloader_data");
      const qwqSaveRoot = path.join(tmpPluginRoot, "qwqnt_save");
      const qwqPluginDir = path.join(qwqSaveRoot, "rosmontis");
      const explicitDir = path.join(tmpPluginRoot, "explicit_cfg");
      fs.mkdirSync(llDataDir, { recursive: true });
      fs.mkdirSync(qwqPluginDir, { recursive: true });
      fs.mkdirSync(explicitDir, { recursive: true });

      assert.strictEqual(
        pluginLoader.resolvePluginConfigDir({
          qwqnt: { core: { configs: { core: { save: qwqSaveRoot } } } },
        }),
        qwqPluginDir
      );
      assert.strictEqual(
        pluginLoader.resolvePluginConfigDir({
          liteLoader: { plugins: { rosmontis: { path: { data: llDataDir } } } },
          qwqnt: { core: { configs: { core: { save: qwqSaveRoot } } } },
        }),
        llDataDir
      );
      process.env.ROSMONTIS_CONFIG_DIR = explicitDir;
      assert.strictEqual(pluginLoader.resolvePluginConfigDir({}), explicitDir);
      delete process.env.ROSMONTIS_CONFIG_DIR;

      process.env.ROSMONTIS_DISABLE = "1";
      assert.strictEqual(pluginLoader.bootPluginBridge({ forceNew: true }), null);
      delete process.env.ROSMONTIS_DISABLE;

      const bootLogPath = path.join(tmpPluginRoot, "boot.log");
      fs.writeFileSync(
        path.join(explicitDir, "rosmontis.json"),
        JSON.stringify({ selfUin: "10001", networks: { httpServers: [], wsServers: [] } })
      );
      const bridge = pluginLoader.bootPluginBridge({
        forceNew: true,
        configDir: explicitDir,
        autoStartServers: false,
        bootLogPath,
      });
      assert.ok(bridge && bridge.selfUin === "10001");
      assert.ok(fs.existsSync(bootLogPath));
      assert.match(fs.readFileSync(bootLogPath, "utf8"), /installMainBridge ok/);

      let attachedWc = null;
      const origAttach = bridge._attachToWebContents;
      bridge._attachToWebContents = (wc) => {
        attachedWc = wc;
      };
      const fakeWc = { id: 42 };
      pluginLoader.onBrowserWindowCreated({ webContents: fakeWc });
      assert.strictEqual(attachedWc, fakeWc);
      bridge._attachToWebContents = origAttach;
      bridge.releaseMapPrototypeHook("test_cleanup");

      // Desktop Windows QQ "Documents/Tencent Files/<uin>/nt_qq/nt_data/Pic/..." cache whitelist vs nt_db block
      const fakeHome = path.join(tmpPluginRoot, "win_home");
      const winPicDir = path.join(
        fakeHome,
        "Documents",
        "Tencent Files",
        "10001",
        "nt_qq",
        "nt_data",
        "Pic",
        "2026-11",
        "Ori"
      );
      const winDbDir = path.join(
        fakeHome,
        "Documents",
        "Tencent Files",
        "10001",
        "nt_qq",
        "nt_db"
      );
      fs.mkdirSync(winPicDir, { recursive: true });
      fs.mkdirSync(winDbDir, { recursive: true });

      const pngBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64"
      );
      const allowedPicFile = path.join(winPicDir, "cached.png");
      const blockedSecretFile = path.join(winDbDir, "nt_msg.raw");
      fs.writeFileSync(allowedPicFile, pngBytes);
      fs.writeFileSync(blockedSecretFile, pngBytes);

      process.env.HOME = fakeHome;
      const { resolveMediaSource } = require("../src/core/media_security");
      const resolvedPic = await resolveMediaSource(allowedPicFile, {
        tempDir: path.join(tmpPluginRoot, "media_tmp"),
      });
      assert.strictEqual(resolvedPic.width, 1);
      assert.strictEqual(resolvedPic.height, 1);

      await assert.rejects(
        () =>
          resolveMediaSource(blockedSecretFile, {
            tempDir: path.join(tmpPluginRoot, "media_tmp"),
          }),
        (err) => err && err.code === "ERR_LFI_BLOCKED"
      );
    } finally {
      if (prevTestMode === undefined) delete process.env.ROSMONTIS_TEST_MODE;
      else process.env.ROSMONTIS_TEST_MODE = prevTestMode;
      if (prevDisable === undefined) delete process.env.ROSMONTIS_DISABLE;
      else process.env.ROSMONTIS_DISABLE = prevDisable;
      if (prevCfgDir === undefined) delete process.env.ROSMONTIS_CONFIG_DIR;
      else process.env.ROSMONTIS_CONFIG_DIR = prevCfgDir;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      fs.rmSync(tmpPluginRoot, { recursive: true, force: true });
    }
    console.log("  [PASS] Suite 7: Pure-JS cross-platform plugin loader & desktop QQ media cache LFI");
  }

  // --------------------------------------------------------------------------
  // Suite 8: Renderer IPC Service Map & Side-Effect Non-Replay Contracts (`src/core/renderer_ipc.js`)
  // --------------------------------------------------------------------------
  {
    assert.strictEqual(SERVICE_GETTER_MAP.nodeIKernelNodeMiscService, "getNodeMiscService");
    assert.strictEqual(SERVICE_GETTER_MAP.nodeIKernelMiscService, "getNodeMiscService");
    assert.strictEqual(SERVICE_GETTER_MAP.nodeIKernelMsgService, "getMsgService");
    assert.strictEqual(SERVICE_GETTER_MAP.nodeIKernelGroupService, "getGroupService");
    assert.strictEqual(SERVICE_GETTER_MAP.nodeIKernelRichMediaService, "getRichMediaService");

    const expectedMutationMethods = [
      "sendMsg",
      "recallMsg",
      "sendShowInputStatusReq",
      "kickMember",
      "setMemberShutUp",
      "setGroupShutUp",
      "quitGroup",
      "delBuddy",
      "approvalFriendRequest",
      "approvalDoubtBuddyReq",
      "delDoubtBuddyReq",
      "operateSysNotify",
      "createGroupFolder",
      "deleteGroupFile",
      "deleteGroupFolder",
      "moveGroupFile",
      "renameGroupFile",
      "renameGroupFolder",
      "transGroupFile",
      "modifyGroupName",
      "modifyGroupRemark",
      "modifyGroupExtInfo",
      "modifyMemberRole",
      "modifyMemberCardName",
      "setStatus",
    ];
    for (const method of expectedMutationMethods) {
      assert.strictEqual(
        SIDE_EFFECT_NT_METHODS.has(method),
        true,
        `Expected SIDE_EFFECT_NT_METHODS to contain ${method}`
      );
      assert.strictEqual(isSideEffectNtCmd(`nodeIKernelGroupService/${method}`), true);
    }

    for (const staleOrReadMethod of [
      "banMember",
      "setOnlineStatus",
      "modifyMemberSpecialTitle",
      "setIdentityTitleInfo",
      "getMsgsIncludeSelf",
      "getGroupFileList",
      "wantWinScreenOCR",
    ]) {
      assert.strictEqual(
        SIDE_EFFECT_NT_METHODS.has(staleOrReadMethod),
        false,
        `Did not expect SIDE_EFFECT_NT_METHODS to contain ${staleOrReadMethod}`
      );
      assert.strictEqual(isSideEffectNtCmd(`nodeIKernelMiscService/${staleOrReadMethod}`), false);
    }

    // Verify Tier 3 wrapperSession dispatch for nodeIKernelNodeMiscService & legacy alias + side-effect replay block
    const tier3Calls = [];
    const mockHost = Object.assign(
      {
        config: { quietLogs: true },
        activeWebContents: null,
        rendererExecute: null,
        invokeStats: {
          tier1: 0,
          tier2: 0,
          tier3: 0,
          degraded: 0,
          blockedReplays: 0,
          failed: 0,
        },
        capturedServices: {
          wrapperSession: {
            getNodeMiscService: () => ({
              wantWinScreenOCR: async (...args) => {
                tier3Calls.push({ svc: "misc", method: "wantWinScreenOCR", args });
                return { result: 0, texts: ["hello"] };
              },
            }),
            getGroupService: () => ({
              setMemberShutUp: async (...args) => {
                tier3Calls.push({ svc: "group", method: "setMemberShutUp", args });
                return { result: 0 };
              },
            }),
          },
        },
      },
      rendererIpcMixin
    );

    const ocrRes1 = await mockHost.invokeNt(
      "nodeIKernelNodeMiscService/wantWinScreenOCR",
      { url: "/tmp/ocr1.png" },
      ["/tmp/ocr1.png"]
    );
    assert.deepStrictEqual(ocrRes1, { result: 0, texts: ["hello"] });

    const ocrRes2 = await mockHost.invokeNt(
      "nodeIKernelMiscService/wantWinScreenOCR",
      { url: "/tmp/ocr2.png" },
      ["/tmp/ocr2.png"]
    );
    assert.deepStrictEqual(ocrRes2, { result: 0, texts: ["hello"] });
    assert.deepStrictEqual(tier3Calls, [
      { svc: "misc", method: "wantWinScreenOCR", args: ["/tmp/ocr1.png"] },
      { svc: "misc", method: "wantWinScreenOCR", args: ["/tmp/ocr2.png"] },
    ]);

    // Dispatched Tier 1 failure on a real mutation command must NOT replay onto Tier 3
    mockHost.rendererExecute = async () => {
      throw new Error("risk control timeout after dispatch");
    };
    await assert.rejects(
      () =>
        mockHost.invokeNt(
          "nodeIKernelGroupService/setMemberShutUp",
          { groupCode: "7654321", memList: [{ uid: "u_m2", timeStamp: 60 }] },
          ["7654321", [{ uid: "u_m2", timeStamp: 60 }]]
        ),
      /risk control timeout after dispatch/
    );
    assert.strictEqual(mockHost.invokeStats.blockedReplays, 1);
    assert.strictEqual(
      tier3Calls.some((c) => c.method === "setMemberShutUp"),
      false,
      "Side-effect command must not replay on Tier 3 after dispatched Tier 1 error"
    );

    // Bridge-unavailable Tier 1 failure safely falls through to Tier 3 with exact positionalArgs
    mockHost.rendererExecute = async () => {
      throw makeBridgeUnavailableError("renderer gone before dispatch");
    };
    await mockHost.invokeNt(
      "nodeIKernelGroupService/setMemberShutUp",
      { groupCode: "7654321", memList: [{ uid: "u_m2", timeStamp: 60 }] },
      ["7654321", [{ uid: "u_m2", timeStamp: 60 }]]
    );
    assert.deepStrictEqual(tier3Calls[tier3Calls.length - 1], {
      svc: "group",
      method: "setMemberShutUp",
      args: ["7654321", [{ uid: "u_m2", timeStamp: 60 }]],
    });

    console.log("  [PASS] Suite 8: Renderer IPC service map & side-effect non-replay contracts");
  }

  console.log("=== All 8 Core Architecture Module Suites Passed ===");
}

runTests().catch((err) => {
  console.error("Core module test suite failed:", err);
  process.exit(1);
});
