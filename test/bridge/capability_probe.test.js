"use strict";

/**
 * Runtime Capability Probe, Dynamic Capability Gating & Telemetry Tests
 */

const test = require("node:test");
const assert = require("assert");
const path = require("path");
const { REPO_ROOT, mainMod, saveEnvVars } = require("./_helpers");
const {
  probeRuntimeCapabilities,
  hasKernelMethod,
} = require(path.join(REPO_ROOT, "src", "core", "capability_probe.js"));

function makeBaseConfig(overrides = {}) {
  return {
    selfUin: "100010001",
    httpServers: [],
    wsServers: [],
    wsClients: [],
    heartbeatIntervalMs: 0,
    humanSimulation: false,
    ...overrides,
  };
}

test("probeRuntimeCapabilities handles uncaptured runtime and preserves backward-compatible can_send_* defaults", async () => {
  const restoreEnv = saveEnvVars([
    "ROSMONTIS_FFMPEG_PATH",
    "ONEBOT_FFMPEG_PATH",
    "XIAO_BRIDGE_FFMPEG_PATH",
    "FFMPEG_PATH",
    "ROSMONTIS_SILK_ENCODER_PATH",
    "ONEBOT_SILK_ENCODER_PATH",
    "XIAO_BRIDGE_SILK_ENCODER_PATH",
    "SILK_ENCODER_PATH",
    "ROSMONTIS_SILK_DECODER_PATH",
    "ONEBOT_SILK_DECODER_PATH",
    "XIAO_BRIDGE_SILK_DECODER_PATH",
    "SILK_DECODER_PATH",
    "ROSMONTIS_SILK_CODEC_PATH",
    "ONEBOT_SILK_CODEC_PATH",
    "XIAO_BRIDGE_SILK_CODEC_PATH",
    "SILK_CODEC_PATH",
  ]);
  for (const k of [
    "ROSMONTIS_FFMPEG_PATH",
    "ONEBOT_FFMPEG_PATH",
    "XIAO_BRIDGE_FFMPEG_PATH",
    "FFMPEG_PATH",
    "ROSMONTIS_SILK_ENCODER_PATH",
    "ONEBOT_SILK_ENCODER_PATH",
    "XIAO_BRIDGE_SILK_ENCODER_PATH",
    "SILK_ENCODER_PATH",
    "ROSMONTIS_SILK_DECODER_PATH",
    "ONEBOT_SILK_DECODER_PATH",
    "XIAO_BRIDGE_SILK_DECODER_PATH",
    "SILK_DECODER_PATH",
    "ROSMONTIS_SILK_CODEC_PATH",
    "ONEBOT_SILK_CODEC_PATH",
    "XIAO_BRIDGE_SILK_CODEC_PATH",
    "SILK_CODEC_PATH",
  ]) {
    delete process.env[k];
  }

  try {
    const bridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_self",
      config: makeBaseConfig({ enableWebCredentialApi: false }),
      rendererExecute: async () => ({ result: 0 }),
    });

    const probe = probeRuntimeCapabilities(bridge);
    assert.strictEqual(typeof probe.probedAt, "number");
    assert.strictEqual(probe.runtimeDetected, false);
    assert.strictEqual(probe.ntApiMethodCount, 0);
    assert.deepStrictEqual(probe.wrapperServices, []);
    assert.deepStrictEqual(probe.mediaTools, {
      ffmpegPath: "ffmpeg",
      silkEncoderConfigured: false,
      silkDecoderConfigured: false,
    });

    for (const key of [
      "send_msg",
      "send_image",
      "send_record",
      "send_video",
      "send_file",
      "recall_msg",
      "forward_msg",
      "group_special_title",
      "group_essence",
      "group_notice",
      "emoji_like",
      "poke",
      "ocr_image",
      "voice_to_text",
      "web_credentials",
    ]) {
      assert.strictEqual(probe.capabilities[key], false, `Expected capability ${key} to be false`);
    }

    assert.strictEqual(hasKernelMethod(bridge, "nodeIKernelMsgService", "sendMsg"), false);

    // When runtimeDetected is false (e.g. rendererExecute-only mock), can_send_* remain { yes: true }
    const imgResp = await bridge.handleOneBotAction("can_send_image", {});
    assert.strictEqual(imgResp.status, "ok");
    assert.deepStrictEqual(imgResp.data, { yes: true });

    const recResp = await bridge.handleOneBotAction("can_send_record", {});
    assert.strictEqual(recResp.status, "ok");
    assert.deepStrictEqual(recResp.data, { yes: true });
  } finally {
    restoreEnv();
  }
});

test("probeRuntimeCapabilities inspects NTQQ 3.2.32-like ntApi/invoke & wrapperSession accurately", async () => {
  const ntApi3232 = {
    "nodeIKernelMsgService/sendMsg": async () => ({ result: 0 }),
    "nodeIKernelMsgService/copyFileWithDelExifInfo": async () => ({ newPath: "/tmp/a.png" }),
    "nodeIKernelMsgService/getRichMediaFilePathForGuild": async () => "/tmp/a.png",
    "nodeIKernelMsgService/recallMsg": async () => ({ result: 0 }),
    "nodeIKernelMsgService/multiForwardMsgWithComment": async () => ({ result: 0 }),
    "nodeIKernelGroupService/addGroupEssence": async () => ({ result: 0 }),
    "nodeIKernelGroupService/publishGroupBulletin": async () => ({ result: 0 }),
    "nodeIKernelMsgService/setMsgEmojiLikes": async () => ({ result: 0 }),
    "nodeIKernelMsgService/sendNudge": async () => ({ result: 0 }),
    "nodeIKernelMsgService/translatePtt2Text": async () => ({ result: 0 }),
    "nodeIKernelRichMediaService/uploadGroupFile": async () => ({ result: 0 }),
    "nodeIKernelRichMediaService/getScreenOCR": async () => ({ result: 0 }),
  };

  const bridge = new mainMod.NtqqOneBotBridge({
    selfUin: "100010001",
    selfUid: "u_self",
    ntApi: { emit: () => {}, invoke: ntApi3232 },
    config: makeBaseConfig({
      enableWebCredentialApi: true,
      ffmpegPath: "/usr/local/bin/ffmpeg",
      silkEncoderPath: "/opt/silk/encoder",
      silkDecoderPath: "/opt/silk/decoder",
    }),
  });
  bridge.capturedServices.ntSessionManager = {
    ntStore: {
      wrapperSession: {
        getRichMediaService: () => ({}),
        getMsgService: () => ({ sendMsg: async () => ({ result: 0 }) }),
        getGroupService: () => ({ modifyMemberCardName: async () => ({ result: 0 }) }),
      },
    },
  };

  const probe = probeRuntimeCapabilities(bridge);
  assert.strictEqual(probe.runtimeDetected, true);
  assert.strictEqual(probe.ntApiMethodCount, Object.keys(ntApi3232).length);
  assert.deepStrictEqual(probe.wrapperServices, [
    "getGroupService",
    "getMsgService",
    "getRichMediaService",
  ]);
  assert.deepStrictEqual(probe.mediaTools, {
    ffmpegPath: "/usr/local/bin/ffmpeg",
    silkEncoderConfigured: true,
    silkDecoderConfigured: true,
  });

  assert.strictEqual(probe.capabilities.send_msg, true);
  assert.strictEqual(probe.capabilities.send_image, true);
  assert.strictEqual(probe.capabilities.send_record, true);
  assert.strictEqual(probe.capabilities.send_video, true);
  assert.strictEqual(probe.capabilities.send_file, true);
  assert.strictEqual(probe.capabilities.recall_msg, true);
  assert.strictEqual(probe.capabilities.forward_msg, true);
  assert.strictEqual(probe.capabilities.group_special_title, false);
  assert.strictEqual(probe.capabilities.group_essence, true);
  assert.strictEqual(probe.capabilities.group_notice, true);
  assert.strictEqual(probe.capabilities.emoji_like, true);
  assert.strictEqual(probe.capabilities.poke, true);
  assert.strictEqual(probe.capabilities.ocr_image, true);
  assert.strictEqual(probe.capabilities.voice_to_text, true);
  assert.strictEqual(probe.capabilities.web_credentials, true);
  assert.strictEqual(probe.notes.copyFileWithDelExifInfo, true);
  assert.strictEqual(probe.notes.getRichMediaFilePathForGuild, true);

  const imgResp = await bridge.handleOneBotAction("can_send_image", {});
  assert.strictEqual(imgResp.status, "ok");
  assert.deepStrictEqual(imgResp.data, { yes: true });

  const recResp = await bridge.handleOneBotAction("can_send_record", {});
  assert.strictEqual(recResp.status, "ok");
  assert.deepStrictEqual(recResp.data, { yes: true });

  // On 3.2.32-like kernel without modifyMemberSpecialTitle, set_group_special_title keeps returning 1404
  const specialResp = await bridge.handleOneBotAction("set_group_special_title", {
    group_id: 654321,
    user_id: 100020002,
    special_title: "博士",
  });
  assert.strictEqual(specialResp.status, "failed");
  assert.strictEqual(specialResp.retcode, 1404);
  assert.match(specialResp.message, /modifyMemberSpecialTitle/);

  // Light caching returns same cached object until forceRefresh
  const cachedProbe = probeRuntimeCapabilities(bridge);
  assert.strictEqual(cachedProbe, probe);
  assert.ok(bridge._capabilityProbeCache);
  const refreshedProbe = probeRuntimeCapabilities(bridge, { forceRefresh: true });
  assert.notStrictEqual(refreshedProbe, probe);
  assert.strictEqual(refreshedProbe.capabilities.send_image, true);
});

test("degraded ntApi missing sendMsg causes can_send_image and can_send_record to report { yes: false }", async () => {
  const bridge = new mainMod.NtqqOneBotBridge({
    selfUin: "100010001",
    selfUid: "u_self",
    ntApi: {
      "nodeIKernelGroupService/getGroupList": async () => ({ groupList: [] }),
      "nodeIKernelRichMediaService/uploadGroupFile": async () => ({ result: 0 }),
    },
    config: makeBaseConfig(),
  });

  const probe = probeRuntimeCapabilities(bridge);
  assert.strictEqual(probe.runtimeDetected, true);
  assert.strictEqual(probe.ntApiMethodCount, 2);
  assert.strictEqual(probe.capabilities.send_msg, false);
  assert.strictEqual(probe.capabilities.send_image, false);
  assert.strictEqual(probe.capabilities.send_record, false);
  assert.strictEqual(probe.capabilities.send_video, false);
  assert.strictEqual(probe.capabilities.send_file, true);

  const imgResp = await bridge.handleOneBotAction("can_send_image", {});
  assert.strictEqual(imgResp.status, "ok");
  assert.deepStrictEqual(imgResp.data, { yes: false });

  const recResp = await bridge.handleOneBotAction("can_send_record", {});
  assert.strictEqual(recResp.status, "ok");
  assert.deepStrictEqual(recResp.data, { yes: false });
});

test("future kernel exposing modifyMemberSpecialTitle or setMemberSpecialTitle enables set_group_special_title", async () => {
  // 1. Via ntApi exposing nodeIKernelGroupService/modifyMemberSpecialTitle
  const ntCalls = [];
  const futureNtApiBridge = new mainMod.NtqqOneBotBridge({
    selfUin: "100010001",
    selfUid: "u_self",
    ntApi: {
      "nodeIKernelMsgService/sendMsg": async () => ({ result: 0 }),
      "nodeIKernelGroupService/modifyMemberSpecialTitle": async (payload) => {
        ntCalls.push(payload);
        return { result: 0, errMsg: "" };
      },
    },
    config: makeBaseConfig(),
  });
  futureNtApiBridge.uinUidStore.record("100020002", "u_doctor_future");

  const probe1 = probeRuntimeCapabilities(futureNtApiBridge);
  assert.strictEqual(probe1.capabilities.group_special_title, true);
  assert.strictEqual(
    hasKernelMethod(futureNtApiBridge, "nodeIKernelGroupService", "modifyMemberSpecialTitle"),
    true
  );

  const resp1 = await futureNtApiBridge.handleOneBotAction("set_group_special_title", {
    group_id: 654321,
    user_id: 100020002,
    special_title: "罗德岛博士",
    duration: 3600,
  });
  assert.strictEqual(resp1.status, "ok");
  assert.strictEqual(resp1.retcode, 0);
  assert.strictEqual(ntCalls.length, 1);
  assert.deepStrictEqual(ntCalls[0], {
    groupCode: "654321",
    uid: "u_doctor_future",
    specialTitle: "罗德岛博士",
    duration: 3600,
  });

  // 2. Via wrapperSession exposing getGroupService().setMemberSpecialTitle
  const wrapperCalls = [];
  const futureWrapperBridge = new mainMod.NtqqOneBotBridge({
    selfUin: "100010001",
    selfUid: "u_self",
    wrapperSession: {
      getGroupService() {
        return {
          async setMemberSpecialTitle(...args) {
            wrapperCalls.push(args);
            return { result: 0 };
          },
        };
      },
    },
    config: makeBaseConfig(),
  });
  futureWrapperBridge.uinUidStore.record("100030003", "u_amiya_future");

  const probe2 = probeRuntimeCapabilities(futureWrapperBridge);
  assert.strictEqual(probe2.capabilities.group_special_title, true);
  assert.strictEqual(
    hasKernelMethod(futureWrapperBridge, "nodeIKernelGroupService", "setMemberSpecialTitle"),
    true
  );

  const resp2 = await futureWrapperBridge.handleOneBotAction("set_group_special_title", {
    group_id: 987654,
    user_id: 100030003,
    special_title: "领袖",
  });
  assert.strictEqual(resp2.status, "ok");
  assert.strictEqual(resp2.retcode, 0);
  assert.deepStrictEqual(wrapperCalls, [["987654", "u_amiya_future", "领袖", -1]]);
});

test("get_status, get_capabilities, and reload_config delegation work end-to-end", async () => {
  const ntApi = {
    "nodeIKernelMsgService/sendMsg": async () => ({ result: 0 }),
    "nodeIKernelNodeMiscService/ocrImage": async () => ({ result: 0 }),
  };
  const bridge = new mainMod.NtqqOneBotBridge({
    selfUin: "100010001",
    selfUid: "u_self",
    ntApi,
    config: makeBaseConfig(),
  });

  // Default telemetry: renderer_health and rate_limit are null until sibling subsystems exist
  const status1 = await bridge.handleOneBotAction("get_status", {});
  assert.strictEqual(status1.status, "ok");
  assert.ok(status1.data.bridge.capabilities);
  assert.strictEqual(status1.data.bridge.capabilities.runtimeDetected, true);
  assert.strictEqual(status1.data.bridge.capabilities.capabilities.send_msg, true);
  assert.strictEqual(status1.data.bridge.capabilities.capabilities.ocr_image, true);
  assert.strictEqual(status1.data.bridge.renderer_health, null);
  assert.strictEqual(status1.data.bridge.rate_limit, null);

  // When sibling modules populate rendererHealthStats & rateLimiter, get_status surfaces them defensively
  bridge.rendererHealthStats = { status: "healthy", reInjects: 1 };
  bridge.rateLimiter = {
    getStats() {
      return { totalRequests: 42, rejected: 0 };
    },
  };
  const status2 = await bridge.handleOneBotAction("get_status", {});
  assert.strictEqual(status2.status, "ok");
  assert.deepStrictEqual(status2.data.bridge.renderer_health, {
    status: "healthy",
    reInjects: 1,
  });
  assert.notStrictEqual(status2.data.bridge.renderer_health, bridge.rendererHealthStats);
  assert.deepStrictEqual(status2.data.bridge.rate_limit, {
    totalRequests: 42,
    rejected: 0,
  });

  // get_capabilities action supports refresh flag
  const cap1 = await bridge.handleOneBotAction("get_capabilities", {});
  assert.strictEqual(cap1.status, "ok");
  assert.strictEqual(cap1.data.capabilities.recall_msg, false);
  ntApi["nodeIKernelMsgService/recallMsg"] = async () => ({ result: 0 });
  // Without refresh, cached result still shows recall_msg: false
  const capCached = await bridge.handleOneBotAction("get_capabilities", {});
  assert.strictEqual(capCached.data.capabilities.recall_msg, false);
  // With refresh: true, re-probes and detects recall_msg: true
  const capRefreshed = await bridge.handleOneBotAction("get_capabilities", { refresh: true });
  assert.strictEqual(capRefreshed.status, "ok");
  assert.strictEqual(capRefreshed.data.capabilities.recall_msg, true);

  // reload_config returns retcode 1404 when bridge.reloadConfig is not implemented
  const reloadMissing = await bridge.handleOneBotAction("reload_config", {});
  assert.strictEqual(reloadMissing.status, "failed");
  assert.strictEqual(reloadMissing.retcode, 1404);

  // When bridge.reloadConfig is attached (by Wave 2 sibling), reload_config delegates to it
  const receivedParams = [];
  bridge.reloadConfig = async (params) => {
    receivedParams.push(params);
    return { reloaded: true, applied: ["rateLimit"] };
  };
  const reloadOk = await bridge.handleOneBotAction("reload_config", { dry_run: true });
  assert.strictEqual(reloadOk.status, "ok");
  assert.strictEqual(reloadOk.retcode, 0);
  assert.deepStrictEqual(reloadOk.data, { reloaded: true, applied: ["rateLimit"] });
  assert.deepStrictEqual(receivedParams, [{ dry_run: true }]);
});

test("wildcard ntApi Proxy avoids false-positive group_special_title and defers to ntStore.wrapperSession when present", async () => {
  const wildcardProxy = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== "string" || !prop.includes("/")) return undefined;
        return async () => ({ result: 0 });
      },
    }
  );
  const bridge = new mainMod.NtqqOneBotBridge({
    selfUin: "100010001",
    selfUid: "u_self",
    ntApi: wildcardProxy,
    config: makeBaseConfig(),
  });

  const opaqueProbe = probeRuntimeCapabilities(bridge);
  assert.strictEqual(opaqueProbe.runtimeDetected, true);
  assert.strictEqual(opaqueProbe.notes.opaqueNtApiProxy, true);
  assert.strictEqual(opaqueProbe.capabilities.group_special_title, false);
  assert.strictEqual(
    hasKernelMethod(bridge, "nodeIKernelGroupService", "modifyMemberSpecialTitle"),
    false
  );

  // Wildcard proxy without wrapperSession keeps can_send_* safe and set_group_special_title at 1404
  assert.deepStrictEqual((await bridge.handleOneBotAction("can_send_image", {})).data, { yes: true });
  assert.deepStrictEqual((await bridge.handleOneBotAction("can_send_record", {})).data, { yes: true });
  const unsupportedTitle = await bridge.handleOneBotAction("set_group_special_title", {
    group_id: 654321,
    user_id: 100020002,
    special_title: "博士",
  });
  assert.strictEqual(unsupportedTitle.status, "failed");
  assert.strictEqual(unsupportedTitle.retcode, 1404);

  // Attaching ntStore.wrapperSession auto-invalidates cache and enables authoritative inspection
  bridge.capturedServices.ntStore = {
    wrapperSession: {
      getMsgService: () => ({}),
      getGroupService: () => ({}),
    },
  };
  const degradedWrapperProbe = probeRuntimeCapabilities(bridge);
  assert.strictEqual(degradedWrapperProbe.notes.opaqueNtApiProxy, false);
  assert.deepStrictEqual(degradedWrapperProbe.wrapperServices, [
    "getGroupService",
    "getMsgService",
  ]);
  assert.strictEqual(degradedWrapperProbe.capabilities.send_image, false);
  assert.deepStrictEqual((await bridge.handleOneBotAction("can_send_image", {})).data, {
    yes: false,
  });
});
