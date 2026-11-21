// @ts-check
"use strict";

/**
 * Stateful Hot-Reload Engine (`reload_bridge`), Renderer Channel Mux Deduplication,
 * and IPC Auth Token Rotation Contract Tests
 */

const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { REPO_ROOT, mainMod, rendererMod } = require("./_helpers");

const { HotReloadController, computeBridgeCodeDigest } = require(
  path.join(REPO_ROOT, "src", "core", "hot_reload.js")
);

/**
 * @param {string} srcDir
 * @param {string} destDir
 */
function copyDirSync(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, ent.name);
    const d = path.join(destDir, ent.name);
    if (ent.isDirectory()) {
      copyDirSync(s, d);
    } else if (ent.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

test("Renderer channelMux prevents duplicate IPC listener firing across hot-reloads and preserves sessionState", () => {
  /** @type {Map<string, Function[]>} */
  const listenersByChannel = new Map();
  /** @type {Array<{ channel: string, payload: any }>} */
  const sentEvents = [];

  // Simulate Electron preload ipcRenderer wrapper WITHOUT removeListener/off support
  const fakeIpcRenderer = {
    on(/** @type {string} */ channel, /** @type {Function} */ fn) {
      if (!listenersByChannel.has(channel)) listenersByChannel.set(channel, []);
      listenersByChannel.get(channel)?.push(fn);
    },
    send(/** @type {string} */ channel, /** @type {any} */ payload) {
      sentEvents.push({ channel, payload });
    },
  };

  /** @type {any} */
  const win = {
    ipcRenderer: fakeIpcRenderer,
  };

  const b1 = rendererMod.installRendererBridge(win, {
    windowId: 1,
    ipcRenderer: fakeIpcRenderer,
    ipcAuthToken: "token-v1",
    autoRegisterListeners: false,
  });
  b1.syncSessionState({
    activeAioPeer: { chatType: 2, peerUid: "88888", guildId: "" },
    activeAioPeerKey: "2:88888:",
    focused: true,
  });

  const b2 = rendererMod.installRendererBridge(win, {
    windowId: 1,
    ipcRenderer: fakeIpcRenderer,
    ipcAuthToken: "token-v2",
    forceReinstall: true,
    preserveSessionState: true,
    autoRegisterListeners: false,
  });

  // Only ONE physical wrapper listener must be registered on RM_IPCFROM_MAIN1
  assert.strictEqual(listenersByChannel.get("RM_IPCFROM_MAIN1")?.length, 1);
  assert.strictEqual(listenersByChannel.get("__ROSMONTIS_BRIDGE_CMD__")?.length, 1);

  // Session state preserved across hot-reload
  assert.strictEqual(b2.sessionState.activeAioPeerKey, "2:88888:");
  assert.strictEqual(b2.sessionState.focused, true);

  // Incoming main IPC must fire exactly ONCE (using new token-v2)
  const wrapper = listenersByChannel.get("RM_IPCFROM_MAIN1")?.[0];
  assert.ok(typeof wrapper === "function");
  wrapper({}, { eventName: "ntApi" }, { cmdName: "nodeIKernelMsgListener/onRecvMsg", payload: { x: 1 } });

  const forwarded = sentEvents.filter((e) => e.channel === "__ROSMONTIS_BRIDGE_EVENT__");
  assert.strictEqual(forwarded.length, 1);
  assert.strictEqual(forwarded[0].payload.__ipcToken, "token-v2");
});

test("Renderer IPC auth token rotates atomically on hot-reload and validates in-flight commands with expectedToken", async () => {
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

  const initialToken = bridge.rendererIpc._ipcAuthToken;
  let execCalls = 0;
  /** @type {any} */
  const fakeWc = {
    id: 1,
    isDestroyed: () => false,
    getURL: () => "app://./renderer/index.html",
    send: () => {},
    executeJavaScript: async () => {
      execCalls += 1;
      return true;
    },
  };
  fakeWc.__rosmontisIpcTokenInjected = true;
  fakeWc.__rosmontisCmdChannelReady = true;
  bridge.rendererIpc._knownWebContents.add(fakeWc);
  bridge.activeWebContents = fakeWc;
  bridge.rendererIpc._ipcCmdAckInstalled = true;

  // Simulate an in-flight command issued under initialToken right before hot-reload
  let resolvedVal = null;
  const inflightPromise = new Promise((resolve, reject) => {
    bridge.rendererIpc._pendingRendererCmds.set("req-inflight-1", {
      reqId: "req-inflight-1",
      type: "invokeNt",
      webContents: fakeWc,
      expectedToken: initialToken,
      timer: null,
      resolve: (/** @type {any} */ v) => {
        resolvedVal = v;
        resolve(v);
      },
      reject,
    });
  });

  const reloadRes = await bridge.rendererIpc._reloadRendererWebContents(
    "function installRendererBridge(){ return {}; }"
  );
  assert.strictEqual(reloadRes.reloadedCount, 1);
  assert.strictEqual(execCalls, 1);
  assert.notStrictEqual(bridge.rendererIpc._ipcAuthToken, initialToken);

  // ACK arriving with initialToken for the pre-reload in-flight command must still be accepted
  bridge.rendererIpc._handleRendererCmdAck(
    { sender: fakeWc },
    { reqId: "req-inflight-1", ok: true, result: { ok: true }, __ipcToken: initialToken }
  );
  await inflightPromise;
  assert.deepStrictEqual(resolvedVal, { ok: true });

  // Failed reload on all windows must roll back _ipcAuthToken
  const tokenBeforeFailure = bridge.rendererIpc._ipcAuthToken;
  fakeWc.executeJavaScript = async () => {
    throw new Error("renderer crashed during reload");
  };
  const failRes = await bridge.rendererIpc._reloadRendererWebContents(
    "function installRendererBridge(){ return {}; }"
  );
  assert.strictEqual(failRes.reloadedCount, 0);
  assert.strictEqual(failRes.failedCount, 1);
  assert.strictEqual(bridge.rendererIpc._ipcAuthToken, tokenBeforeFailure);
});

test("HotReloadController preserves stores/services on reload and rolls back transactionally on syntax error", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rosmontis-hotreload-"));
  const stagingSrc = path.join(tmpRoot, "src");
  copyDirSync(path.join(REPO_ROOT, "src"), stagingSrc);

  try {
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
    assert.ok(bridge.hotReload instanceof HotReloadController);

    // Seed state that MUST survive hot-reload
    const shortId = bridge.messageIdStore.register(
      "900001",
      { chatType: 2, peerUid: "777888", guildId: "" },
      "12",
      { senderUin: "20001" }
    );
    bridge.uinUidStore.remember("20001", "u_20001");
    const sentinelNtApi = { "nodeIKernelMsgService/sendMsg": async () => ({ result: 0 }) };
    bridge.capturedServices.ntApi = sentinelNtApi;

    const beforeDigest = computeBridgeCodeDigest(stagingSrc).codeDigest;

    // 1. Corrupt bridge_renderer.js syntax -> must fail cleanly without corrupting state
    const rendererPath = path.join(stagingSrc, "bridge_renderer.js");
    const origRenderer = fs.readFileSync(rendererPath, "utf8");
    fs.writeFileSync(rendererPath, "function broken( { syntax error", "utf8");
    await assert.rejects(
      () => bridge.reloadBridge({ moduleDir: stagingSrc, reloadConfig: false, reloadRenderer: true }),
      /bridge_renderer\.js syntax error/
    );
    assert.strictEqual(bridge.reloadStats.failed, 1);
    assert.strictEqual(bridge.messageIdStore.get(shortId)?.msgId, "900001");
    fs.writeFileSync(rendererPath, origRenderer, "utf8");

    // 2. Successful reload from staged copy via reload_bridge action
    const res = await bridge.reloadBridge({
      moduleDir: stagingSrc,
      source: "unit_test",
      reloadConfig: false,
      reloadRenderer: true,
    });
    assert.strictEqual(res.reloaded, true);
    assert.strictEqual(res.source, "unit_test");
    assert.strictEqual(res.code_digest, beforeDigest);
    assert.ok(res.action_count >= 100);
    assert.strictEqual(res.retained_messages, 1);
    assert.strictEqual(res.retained_users, 1);
    assert.strictEqual(bridge.capturedServices.ntApi, sentinelNtApi);
    assert.strictEqual(bridge.messageIdStore.get(shortId)?.msgId, "900001");
    assert.strictEqual(bridge.uinUidStore.getUinSync("u_20001"), "20001");

    // 3. OneBot action alias `_reload_bridge` is registered
    const actionRes = await bridge.handleOneBotAction("_reload_bridge", {
      reload_config: false,
      reload_renderer: false,
    });
    assert.strictEqual(actionRes.status, "ok");
    assert.strictEqual(actionRes.data.reloaded, true);
  } finally {
    // Clean any require.cache entries pointing into the temp staging directory
    for (const k of Object.keys(require.cache)) {
      if (k.startsWith(tmpRoot)) {
        delete require.cache[k];
      }
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
