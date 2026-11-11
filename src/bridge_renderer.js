"use strict";

/**
 * NTQQ Renderer-Layer Bridge (`bridge_renderer.js`)
 *
 * Injected into `BrowserWindow.webContents` after page load, and also importable
 * in standard Node.js for unit tests.
 *
 * Exposes `window.__ROSMONTIS_RENDERER_BRIDGE__`:
 * - Discovers `windowId` (`window.webContentId` / `?webcontentsid=`) and `window.ipcRenderer` / `window.ipcImpl`.
 * - Executes `invokeNtApi(cmd, args)` over `RM_IPCFROM_RENDERER{windowId}` using the genuine
 *   NTQQ 3.2.32 frame structure:
 *     meta: `{ type: "request", callbackId, eventName: "ntApi", peerId: windowId }`
 *     data: `{ cmdName: cmd, cmdType: "invoke", payload: [args, null] }`
 *   and resolves/rejects when `RM_IPCFROM_MAIN{windowId}` replies with matching `callbackId`
 *   and `promiseStatue: "full" | "err"`.
 * - Registers `ntApi-register` listeners so the main process forwards kernel events to
 *   `RM_IPCFROM_MAIN{windowId}`.
 * - Supports authenticated IPC command/event envelopes (`__ROSMONTIS_BRIDGE_CMD__`,
 *   `__ROSMONTIS_BRIDGE_CMD_ACK__`, `__ROSMONTIS_BRIDGE_EVENT__`) with `ipcAuthToken`
 *   confined strictly to closure scope (never readable on `window.__ROSMONTIS_RENDERER_BRIDGE__`).
 * - Implements `simulateHumanSessionFlow({ chatType, peerUid, guildId, markRead, sendTyping, readToTypingDelayMs })`
 *   with session-switch state tracking (`enterType: 2` on old AIO, `enterType: 1` on new AIO)
 *   and 5-second anti-burst deduplication for `setMsgRead` and `sendShowInputStatusReq`.
 */

const DEFAULT_REGISTERED_EVENTS = [
  "nodeIKernelMsgListener/onRecvMsg",
  "nodeIKernelMsgListener/onMsgInfoListUpdate",
  "nodeIKernelMsgListener/onAddSendMsg",
  "nodeIKernelMsgListener/onRichMediaDownloadComplete",
  "nodeIKernelMsgListener/onKickedOffLine",
  "nodeIKernelGroupListener/onGroupListUpdate",
  "nodeIKernelGroupListener/onGroupNotifiesUpdated",
  "nodeIKernelGroupListener/onMemberInfoChange",
  "nodeIKernelBuddyListener/onBuddyListChange",
  "nodeIKernelBuddyListener/onBuddyListChangedV2",
  "nodeIKernelBuddyListener/onBuddyReqChange",
  "nodeIKernelProfileListener/onProfileSimpleChanged",
  "nodeIKernelLoginListener/onQRCodeGetPicture",
  "nodeIKernelLoginListener/onQRCodeSessionQuickLoginFailed",
  "nodeIKernelLoginListener/onQRCodeLoginSucceed",
  "nodeIKernelLoginListener/onUserLoggedIn",
  "nodeIKernelSessionListener/onSessionInitComplete",
];

const KNOWN_MAP_FIELDS = new Set(["msgAttributeInfos", "thumbPath", "picThumbPath"]);
const BRIDGE_EVENT_CHANNEL = "__ROSMONTIS_BRIDGE_EVENT__";
const BRIDGE_CMD_CHANNEL = "__ROSMONTIS_BRIDGE_CMD__";
const BRIDGE_CMD_ACK_CHANNEL = "__ROSMONTIS_BRIDGE_CMD_ACK__";
const _cleanupByWindow = typeof WeakMap === "function" ? new WeakMap() : null;
const _bootstrapAuthByWindow = typeof WeakMap === "function" ? new WeakMap() : null;

function encodeBridgeMaps(val, depth = 0) {
  if (val === null || val === undefined || depth > 8) return val;
  if (typeof val === "bigint") return val.toString();
  if (typeof val !== "object") return val;
  if (val instanceof Map) {
    return {
      __rosmontisMap__: Array.from(val.entries()).map(([k, v]) => [
        encodeBridgeMaps(k, depth + 1),
        encodeBridgeMaps(v, depth + 1),
      ]),
    };
  }
  if (val instanceof Set) {
    return Array.from(val.values()).map((v) => encodeBridgeMaps(v, depth + 1));
  }
  if (val instanceof Uint8Array || ArrayBuffer.isView(val)) {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map((item) => encodeBridgeMaps(item, depth + 1));
  }
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    out[k] = encodeBridgeMaps(v, depth + 1);
  }
  return out;
}

function reviveBridgePayload(val, fieldName = "") {
  if (val === null || val === undefined || typeof val !== "object") {
    return val;
  }
  if (val instanceof Map || val instanceof Uint8Array || ArrayBuffer.isView(val)) {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map((item) => reviveBridgePayload(item));
  }
  if (Array.isArray(val.__rosmontisMap__) && Object.keys(val).length === 1) {
    return new Map(
      val.__rosmontisMap__.map((entry) => [
        Array.isArray(entry) ? entry[0] : undefined,
        Array.isArray(entry) ? reviveBridgePayload(entry[1]) : undefined,
      ])
    );
  }
  if (KNOWN_MAP_FIELDS.has(fieldName)) {
    return new Map(
      Object.entries(val).map(([k, v]) => [
        /^\d+$/.test(k) && fieldName !== "msgAttributeInfos" ? Number(k) : k,
        reviveBridgePayload(v),
      ])
    );
  }
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    out[k] = reviveBridgePayload(v, k);
  }
  return out;
}

function serializeBridgeResult(val) {
  return JSON.stringify(val === undefined ? { __rosmontisVoid__: true } : encodeBridgeMaps(val));
}

function installRendererBridge(targetWindow, options = {}) {
  const win =
    targetWindow ||
    (typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : {});

  if (win.__ROSMONTIS_RENDERER_BRIDGE__ && !options.forceReinstall) {
    if (options.ipcAuthToken && _bootstrapAuthByWindow && typeof win === "object" && win !== null) {
      const bootstrapFn = _bootstrapAuthByWindow.get(win);
      if (typeof bootstrapFn === "function") {
        bootstrapFn(options.ipcAuthToken);
      }
    }
    if (options.windowId && !win.__ROSMONTIS_RENDERER_BRIDGE__.windowId) {
      win.__ROSMONTIS_RENDERER_BRIDGE__.setWindowId(options.windowId);
    }
    if (typeof win.__ROSMONTIS_RENDERER_BRIDGE__.reattachListeners === "function") {
      win.__ROSMONTIS_RENDERER_BRIDGE__.reattachListeners();
    }
    return win.__ROSMONTIS_RENDERER_BRIDGE__;
  }

  if (options.forceReinstall && _cleanupByWindow && typeof win === "object" && win !== null) {
    const prevCleanup = _cleanupByWindow.get(win);
    if (typeof prevCleanup === "function") {
      try {
        prevCleanup();
      } catch (_) {}
    }
  }

  let ipcAuthToken =
    typeof options.ipcAuthToken === "string" && options.ipcAuthToken.length > 0
      ? options.ipcAuthToken
      : "";

  function setIpcAuthTokenOnce(nextToken) {
    if (ipcAuthToken) return false;
    if (typeof nextToken === "string" && nextToken.length > 0) {
      ipcAuthToken = nextToken;
      return true;
    }
    return false;
  }

  if (_bootstrapAuthByWindow && typeof win === "object" && win !== null) {
    _bootstrapAuthByWindow.set(win, setIpcAuthTokenOnce);
  }

  function resolveIpcRenderer() {
    if (options.ipcRenderer) return options.ipcRenderer;
    if (win.ipcImpl && typeof win.ipcImpl.send === "function") {
      return win.ipcImpl;
    }
    if (
      win.ipcRenderer &&
      (typeof win.ipcRenderer.send === "function" || typeof win.ipcRenderer.invoke === "function")
    ) {
      return win.ipcRenderer;
    }
    if (win.ntqq && win.ntqq.ipcRenderer) return win.ntqq.ipcRenderer;
    if (win.electron && win.electron.ipcRenderer) return win.electron.ipcRenderer;
    if (win.qqnt && win.qqnt.ipcRenderer) return win.qqnt.ipcRenderer;
    try {
      if (typeof require === "function") {
        const el = require("electron");
        if (el && el.ipcRenderer) return el.ipcRenderer;
      }
    } catch (_) {}
    return null;
  }

  function discoverWindowId(ipc) {
    if (options.windowId && Number(options.windowId) > 0) {
      return Number(options.windowId);
    }
    if (typeof win.webContentId === "number" && win.webContentId > 0) {
      return win.webContentId;
    }
    if (win.__ROSMONTIS_WINDOW_ID__ && Number(win.__ROSMONTIS_WINDOW_ID__) > 0) {
      return Number(win.__ROSMONTIS_WINDOW_ID__);
    }
    try {
      if (ipc && typeof ipc.eventNames === "function") {
        for (const name of ipc.eventNames()) {
          const m = /^RM_IPCFROM_MAIN(\d+)$/.exec(String(name));
          if (m) return Number(m[1]);
        }
      }
    } catch (_) {}
    try {
      const urlParams = new URLSearchParams(win.location ? win.location.search : "");
      const wid = Number(
        urlParams.get("webcontentsid") ||
          urlParams.get("webContentsId") ||
          urlParams.get("windowId") ||
          0
      );
      if (Number.isFinite(wid) && wid > 0) return wid;
    } catch (_) {}
    return 1;
  }

  const ipcRenderer = resolveIpcRenderer();
  let windowId = discoverWindowId(ipcRenderer);
  const pendingCallbacks = new Map();
  const observedChannels = new Set();
  const attachedIpcByChannel = new Map();
  const attachedHandlerByChannel = new Map();
  const registeredWindowIds = new Set();

  const sessionState = {
    activeAioPeer: null,
    activeAioPeerKey: "",
    focused: false,
    lastReadAtByPeer: new Map(),
    lastTypingAtByPeer: new Map(),
  };

  function resetSessionState() {
    sessionState.activeAioPeer = null;
    sessionState.activeAioPeerKey = "";
    sessionState.focused = false;
    sessionState.lastReadAtByPeer.clear();
    sessionState.lastTypingAtByPeer.clear();
  }

  function setBoundedMap(map, key, value, maxEntries = 2000) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  function makeCallbackId() {
    try {
      if (win.crypto && typeof win.crypto.randomUUID === "function") {
        return win.crypto.randomUUID();
      }
    } catch (_) {}
    try {
      if (typeof crypto !== "undefined" && crypto && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
      if (typeof require === "function") {
        const nodeCrypto = require("crypto");
        if (nodeCrypto && typeof nodeCrypto.randomUUID === "function") {
          return nodeCrypto.randomUUID();
        }
      }
    } catch (_) {}
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function forwardToMain(payload) {
    const ipc = resolveIpcRenderer() || ipcRenderer;
    if (!ipc) return;
    const envelope =
      ipcAuthToken && payload && typeof payload === "object" && !Array.isArray(payload)
        ? { ...payload, __ipcToken: ipcAuthToken }
        : payload;
    const encoded = encodeBridgeMaps(envelope);
    try {
      if (typeof ipc.send === "function") {
        ipc.send(BRIDGE_EVENT_CHANNEL, encoded);
        return;
      }
      if (typeof ipc.invoke === "function") {
        Promise.resolve(ipc.invoke(BRIDGE_EVENT_CHANNEL, encoded)).catch(() => {});
      }
    } catch (_) {}
  }

  function sendCommandAck(reply) {
    const ipc = resolveIpcRenderer() || ipcRenderer;
    if (!ipc) return;
    const replyEnvelope = ipcAuthToken ? { ...reply, __ipcToken: ipcAuthToken } : reply;
    try {
      if (typeof ipc.send === "function") {
        ipc.send(BRIDGE_CMD_ACK_CHANNEL, replyEnvelope);
        return;
      }
      if (typeof ipc.invoke === "function") {
        Promise.resolve(ipc.invoke(BRIDGE_CMD_ACK_CHANNEL, replyEnvelope)).catch(() => {});
      }
    } catch (_) {}
  }

  function handleIncomingMainIpc(_event, header, body) {
    try {
      // 1. Resolve or reject any pending invokeNtApi callback if callbackId matches
      if (header && typeof header === "object" && header.callbackId) {
        const pending = pendingCallbacks.get(header.callbackId);
        if (pending) {
          pendingCallbacks.delete(header.callbackId);
          clearTimeout(pending.timer);
          if (
            header.promiseStatue &&
            header.promiseStatue !== "full" &&
            header.promiseStatue !== "fulfilled"
          ) {
            const errMsg =
              body instanceof Error
                ? body.message
                : typeof body === "string"
                ? body
                : JSON.stringify(body);
            pending.reject(new Error(`NTQQ IPC error (${pending.cmd}): ${errMsg}`));
          } else {
            pending.resolve(body);
          }
          return;
        }
      }

      // 2. Passively forward kernel listener events to main process
      if (body && typeof body === "object" && !Array.isArray(body) && typeof body.cmdName === "string") {
        forwardToMain({
          source: "renderer_ipc",
          windowId,
          eventName: header?.eventName || "ntApi",
          cmdName: body.cmdName,
          payload: body.payload,
          timestamp: Date.now(),
        });
      } else if (Array.isArray(body) && body.length >= 1) {
        const first = body[0];
        if (first && typeof first === "object" && typeof first.cmdName === "string") {
          forwardToMain({
            source: "renderer_ipc",
            windowId,
            eventName: header?.eventName || "ntApi",
            cmdName: first.cmdName,
            payload: first.payload !== undefined ? first.payload : body[1],
            rawBody: body,
            timestamp: Date.now(),
          });
        } else if (typeof first === "string" && (first.startsWith("nodeIKernel") || first.startsWith("on"))) {
          forwardToMain({
            source: "renderer_ipc",
            windowId,
            eventName: header?.eventName || "ntApi",
            cmdName: first,
            payload: body[1],
            rawBody: body,
            timestamp: Date.now(),
          });
        }
      }
    } catch (_) {}
  }

  async function handleBridgeCommand(_eventOrEnvelope, maybeEnvelope) {
    const cmdEnvelope =
      maybeEnvelope !== undefined
        ? maybeEnvelope
        : _eventOrEnvelope &&
          typeof _eventOrEnvelope === "object" &&
          ("reqId" in _eventOrEnvelope || "type" in _eventOrEnvelope)
        ? _eventOrEnvelope
        : null;

    if (!cmdEnvelope || typeof cmdEnvelope !== "object") return;
    if (!cmdEnvelope.reqId) return;
    if (ipcAuthToken && cmdEnvelope.__ipcToken !== ipcAuthToken) {
      return;
    }

    try {
      switch (cmdEnvelope.type) {
        case "invokeNt": {
          const rawArgs =
            typeof cmdEnvelope.argsSerialized === "string"
              ? JSON.parse(cmdEnvelope.argsSerialized)
              : cmdEnvelope.args;
          const res = await invokeNtApi(
            cmdEnvelope.cmd,
            rawArgs,
            cmdEnvelope.timeoutMs !== undefined ? cmdEnvelope.timeoutMs : 15000
          );
          sendCommandAck({
            reqId: cmdEnvelope.reqId,
            ok: true,
            resultSerialized: serializeBridgeResult(res),
          });
          break;
        }

        case "simulateSession": {
          const opts =
            typeof cmdEnvelope.optsSerialized === "string"
              ? JSON.parse(cmdEnvelope.optsSerialized)
              : cmdEnvelope.opts;
          const res = await simulateHumanSessionFlow(opts || {});
          sendCommandAck({
            reqId: cmdEnvelope.reqId,
            ok: true,
            resultSerialized: serializeBridgeResult(res),
          });
          break;
        }

        case "leaveSession": {
          const opts =
            typeof cmdEnvelope.optsSerialized === "string"
              ? JSON.parse(cmdEnvelope.optsSerialized)
              : cmdEnvelope.opts;
          const res = await leaveHumanSessionFlow(opts || {});
          sendCommandAck({
            reqId: cmdEnvelope.reqId,
            ok: true,
            resultSerialized: serializeBridgeResult(res),
          });
          break;
        }

        case "syncSession": {
          const patch =
            typeof cmdEnvelope.patchSerialized === "string"
              ? JSON.parse(cmdEnvelope.patchSerialized)
              : cmdEnvelope.patch;
          syncSessionState(patch || {});
          sendCommandAck({
            reqId: cmdEnvelope.reqId,
            ok: true,
          });
          break;
        }

        case "resetSession": {
          resetSessionState();
          sendCommandAck({
            reqId: cmdEnvelope.reqId,
            ok: true,
          });
          break;
        }

        case "bootstrapAuth": {
          const ok = setIpcAuthTokenOnce(
            cmdEnvelope.token || cmdEnvelope.ipcAuthToken || cmdEnvelope.__ipcToken
          );
          sendCommandAck({
            reqId: cmdEnvelope.reqId,
            ok,
          });
          break;
        }

        default: {
          const unknownErr = new Error(
            `Unsupported renderer bridge command type: ${String(cmdEnvelope.type || "")}`
          );
          unknownErr.code = "ERR_UNKNOWN_BRIDGE_CMD";
          throw unknownErr;
        }
      }
    } catch (err) {
      const message = String(err?.message || err || "Renderer command failed");
      const code =
        err?.code !== undefined && err?.code !== null
          ? String(err.code)
          : message.includes("ROSMONTIS_BRIDGE_UNAVAILABLE")
          ? "ROSMONTIS_BRIDGE_UNAVAILABLE"
          : "";
      sendCommandAck({
        reqId: cmdEnvelope.reqId,
        ok: false,
        error: {
          message,
          code,
        },
      });
    }
  }

  function attachChannelListener(channel, handler, force = false) {
    const ipc = resolveIpcRenderer() || ipcRenderer;
    if (!ipc || typeof ipc.on !== "function") return;
    if (observedChannels.has(channel) && attachedIpcByChannel.get(channel) === ipc) {
      if (!force) return;
      const prevHandler = attachedHandlerByChannel.get(channel) || handler;
      if (typeof ipc.removeListener === "function") {
        try {
          ipc.removeListener(channel, prevHandler);
        } catch (_) {}
      } else if (typeof ipc.off === "function") {
        try {
          ipc.off(channel, prevHandler);
        } catch (_) {}
      } else {
        return;
      }
    }
    observedChannels.add(channel);
    attachedIpcByChannel.set(channel, ipc);
    attachedHandlerByChannel.set(channel, handler);
    try {
      ipc.on(channel, handler);
    } catch (_) {}
  }

  function attachPassiveListener(wid, force = false) {
    attachChannelListener(`RM_IPCFROM_MAIN${wid}`, handleIncomingMainIpc, force);
  }

  function attachCommandListener(force = false) {
    attachChannelListener(BRIDGE_CMD_CHANNEL, handleBridgeCommand, force);
  }

  function detachAllListeners() {
    for (const [channel, ipc] of attachedIpcByChannel.entries()) {
      const handler = attachedHandlerByChannel.get(channel);
      if (!ipc || !handler) continue;
      if (typeof ipc.removeListener === "function") {
        try {
          ipc.removeListener(channel, handler);
        } catch (_) {}
      } else if (typeof ipc.off === "function") {
        try {
          ipc.off(channel, handler);
        } catch (_) {}
      }
    }
    observedChannels.clear();
    attachedIpcByChannel.clear();
    attachedHandlerByChannel.clear();
  }

  if (_cleanupByWindow && typeof win === "object" && win !== null) {
    _cleanupByWindow.set(win, detachAllListeners);
  }

  function reattachListeners() {
    attachPassiveListener(windowId, true);
    if (windowId === 1) {
      attachPassiveListener(2, true);
    }
    attachCommandListener(true);
  }

  function registerNtApiListeners(wid = windowId, eventNames = DEFAULT_REGISTERED_EVENTS) {
    const ipc = resolveIpcRenderer() || ipcRenderer;
    if (!ipc || typeof ipc.send !== "function") return false;
    const targetWid = Number(wid) || windowId || 1;
    if (registeredWindowIds.has(targetWid)) return true;
    registeredWindowIds.add(targetWid);
    const channel = `RM_IPCFROM_RENDERER${targetWid}`;
    try {
      for (const evtName of eventNames) {
        ipc.send(
          channel,
          {
            type: "request",
            eventName: "ntApi-register",
            peerId: targetWid,
          },
          evtName
        );
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  // Attach passive listener on discovered windowId (and fallback 2 when windowId === 1) + command listener
  attachPassiveListener(windowId);
  if (windowId === 1) {
    attachPassiveListener(2);
  }
  attachCommandListener();

  if (options.autoRegisterListeners) {
    registerNtApiListeners(windowId);
  }

  function inspectVueAppState() {
    try {
      const doc = win.document;
      if (!doc || typeof doc.querySelector !== "function") {
        return { mounted: false };
      }
      const appEl = doc.querySelector("#app");
      const vueApp = appEl && appEl.__vue_app__;
      if (!vueApp) {
        return { mounted: false };
      }
      const globalProps = vueApp.config?.globalProperties || {};
      const router = globalProps.$router;
      const route = globalProps.$route;
      const pinia = globalProps.$pinia;
      const store = globalProps.$store;
      return {
        mounted: true,
        currentRoute:
          router?.currentRoute?.value?.fullPath ||
          router?.currentRoute?.fullPath ||
          route?.fullPath ||
          route?.path ||
          "",
        hasPinia: Boolean(pinia),
        hasVuex: Boolean(store),
      };
    } catch (_) {
      return { mounted: false };
    }
  }

  async function invokeNtApi(cmd, args, timeoutMs = 15000) {
    const ipc = resolveIpcRenderer();
    if (!ipc || (typeof ipc.send !== "function" && typeof ipc.invoke !== "function")) {
      // Tagged so the main process knows nothing was dispatched and fallback is safe.
      throw new Error("ROSMONTIS_BRIDGE_UNAVAILABLE: Renderer ipcRenderer (send/invoke) is not available");
    }
    attachPassiveListener(windowId);
    attachCommandListener();

    const callbackId = makeCallbackId();
    const requestHeader = {
      type: "request",
      callbackId,
      eventName: "ntApi",
      peerId: windowId,
    };
    const rawPayloadList =
      args === undefined || args === null
        ? [null, null]
        : Array.isArray(args)
        ? args.length === 1
          ? [args[0], null]
          : [...args]
        : [args, null];
    const payloadList = rawPayloadList.map((item) => reviveBridgePayload(item));
    const requestPayload = {
      cmdName: cmd,
      cmdType: "invoke",
      payload: payloadList,
    };
    const channel = `RM_IPCFROM_RENDERER${windowId}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCallbacks.delete(callbackId);
        reject(new Error(`invokeNtApi timeout (${timeoutMs}ms): ${cmd}`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      pendingCallbacks.set(callbackId, {
        resolve,
        reject,
        timer,
        cmd,
      });

      try {
        if (typeof ipc.send === "function") {
          ipc.send(channel, requestHeader, requestPayload);
        } else {
          Promise.resolve(ipc.invoke(channel, requestHeader, requestPayload)).then(
            (directResult) => {
              if (directResult !== undefined && pendingCallbacks.has(callbackId)) {
                pendingCallbacks.delete(callbackId);
                clearTimeout(timer);
                resolve(directResult);
              }
            },
            (err) => {
              if (pendingCallbacks.has(callbackId)) {
                pendingCallbacks.delete(callbackId);
                clearTimeout(timer);
                reject(err);
              }
            }
          );
        }
      } catch (err) {
        pendingCallbacks.delete(callbackId);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  function rethrowIfBridgeUnavailable(err) {
    if (err && String(err.message || err).includes("ROSMONTIS_BRIDGE_UNAVAILABLE")) {
      throw err;
    }
  }

  function syncSessionState(patch = {}) {
    if (!patch || typeof patch !== "object") {
      return {
        activeAioPeer: sessionState.activeAioPeer,
        activeAioPeerKey: sessionState.activeAioPeerKey,
        focused: sessionState.focused,
      };
    }
    if ("activeAioPeer" in patch && patch.activeAioPeer !== undefined) {
      sessionState.activeAioPeer = patch.activeAioPeer || null;
    }
    if ("activeAioPeerKey" in patch && patch.activeAioPeerKey !== undefined) {
      sessionState.activeAioPeerKey = String(patch.activeAioPeerKey || "");
      if (!sessionState.activeAioPeerKey) {
        sessionState.activeAioPeer = null;
      }
    }
    if ("focused" in patch && patch.focused !== undefined) {
      sessionState.focused = Boolean(patch.focused);
    }
    if (patch.clearDedupe) {
      sessionState.lastReadAtByPeer.clear();
      sessionState.lastTypingAtByPeer.clear();
    }
    return {
      activeAioPeer: sessionState.activeAioPeer,
      activeAioPeerKey: sessionState.activeAioPeerKey,
      focused: sessionState.focused,
    };
  }

  async function leaveHumanSessionFlow({
    exitAio = true,
    blurWindow = false,
    knownActivePeer = undefined,
    knownActivePeerKey = undefined,
    knownFocused = undefined,
  } = {}) {
    syncSessionState({
      activeAioPeer: knownActivePeer,
      activeAioPeerKey: knownActivePeerKey,
      focused: knownFocused,
    });

    const result = {
      exitedAio: false,
      blurredWindow: false,
      activeAioPeer: sessionState.activeAioPeer,
      activeAioPeerKey: sessionState.activeAioPeerKey,
      focused: sessionState.focused,
    };

    if (exitAio && sessionState.activeAioPeer && sessionState.activeAioPeerKey) {
      const prevPeer = sessionState.activeAioPeer;
      sessionState.activeAioPeer = null;
      sessionState.activeAioPeerKey = "";
      try {
        await invokeNtApi(
          "nodeIKernelMsgService/enterOrExitAio",
          [
            {
              info: {
                peer: prevPeer,
                enterType: 2,
              },
            },
            null,
          ],
          4000
        );
        result.exitedAio = true;
      } catch (err) {
        rethrowIfBridgeUnavailable(err);
      }
    }

    if (blurWindow && sessionState.focused) {
      sessionState.focused = false;
      try {
        await invokeNtApi(
          "nodeIKernelMsgService/setFocusOnBase",
          [{ isFocus: false }, null],
          4000
        );
        result.blurredWindow = true;
      } catch (err) {
        rethrowIfBridgeUnavailable(err);
      }
    }

    result.activeAioPeer = sessionState.activeAioPeer;
    result.activeAioPeerKey = sessionState.activeAioPeerKey;
    result.focused = sessionState.focused;
    return result;
  }

  async function simulateHumanSessionFlow({
    chatType = 1,
    peerUid = "",
    guildId = "",
    markRead = true,
    sendTyping = false,
    eventType = 1,
    dedupeWindowMs = 5000,
    bypassDedupe = false,
    readToTypingDelayMs = 0,
    knownActivePeer = undefined,
    knownActivePeerKey = undefined,
    knownFocused = undefined,
  } = {}) {
    syncSessionState({
      activeAioPeer: knownActivePeer,
      activeAioPeerKey: knownActivePeerKey,
      focused: knownFocused,
    });

    const peer = {
      chatType: Number(chatType),
      peerUid: String(peerUid || ""),
      guildId: String(guildId || ""),
    };
    const vueState = inspectVueAppState();
    const steps = {
      vueState,
      exitedPreviousAio: false,
      alreadyInAio: false,
      enterOrExitAio: false,
      addActiveChatByUid: false,
      setFocusOnBase: false,
      focusActivated: false,
      markRead: false,
      markReadSkipped: false,
      sendTyping: false,
      sendTypingSkipped: false,
    };

    if (!peer.peerUid) {
      return steps;
    }

    const peerKey = `${peer.chatType}:${peer.peerUid}:${peer.guildId}`;
    const now = Date.now();

    // 1. Causal step 1: bring window to foreground focus BEFORE touching chat list / AIO
    if (!sessionState.focused) {
      try {
        await invokeNtApi(
          "nodeIKernelMsgService/setFocusOnBase",
          [{ isFocus: true }, null],
          4000
        );
        steps.setFocusOnBase = true;
        steps.focusActivated = true;
        sessionState.focused = true;
      } catch (err) {
        rethrowIfBridgeUnavailable(err);
      }
    } else {
      steps.setFocusOnBase = true;
    }

    // 2. Causal step 2: leave previous AIO (if any) -> addActiveChatByUid -> enterOrExitAio(1)
    if (sessionState.activeAioPeerKey !== peerKey) {
      if (sessionState.activeAioPeer && sessionState.activeAioPeerKey) {
        try {
          await invokeNtApi(
            "nodeIKernelMsgService/enterOrExitAio",
            [
              {
                info: {
                  peer: sessionState.activeAioPeer,
                  enterType: 2,
                },
              },
              null,
            ],
            4000
          );
          steps.exitedPreviousAio = true;
        } catch (err) {
          rethrowIfBridgeUnavailable(err);
        }
      }

      try {
        await invokeNtApi(
          "nodeIKernelMsgService/addActiveChatByUid",
          [{ peer }, null],
          4000
        );
        steps.addActiveChatByUid = true;
      } catch (err) {
        rethrowIfBridgeUnavailable(err);
      }

      try {
        await invokeNtApi(
          "nodeIKernelMsgService/enterOrExitAio",
          [
            {
              info: {
                peer,
                enterType: 1,
              },
            },
            null,
          ],
          4000
        );
        steps.enterOrExitAio = true;
      } catch (err) {
        rethrowIfBridgeUnavailable(err);
      }

      sessionState.activeAioPeer = peer;
      sessionState.activeAioPeerKey = peerKey;
    } else {
      steps.alreadyInAio = true;
      steps.enterOrExitAio = true;
      steps.addActiveChatByUid = true;
    }

    // 3. Causal step 3: mark conversation read
    if (markRead) {
      const lastReadAt = sessionState.lastReadAtByPeer.get(peerKey) || 0;
      if (bypassDedupe || now - lastReadAt >= dedupeWindowMs) {
        try {
          await invokeNtApi(
            "nodeIKernelMsgService/setMsgRead",
            [{ peer }, null],
            4000
          );
          steps.markRead = true;
          setBoundedMap(sessionState.lastReadAtByPeer, peerKey, Date.now());
        } catch (err) {
          rethrowIfBridgeUnavailable(err);
        }
      } else {
        steps.markReadSkipped = true;
      }
    }

    // Optional micro-pause between setMsgRead and sendShowInputStatusReq
    const pauseMs = Number(readToTypingDelayMs);
    if (
      steps.markRead &&
      sendTyping &&
      Number(chatType) === 1 &&
      Number.isFinite(pauseMs) &&
      pauseMs > 0
    ) {
      await new Promise((r) => setTimeout(r, pauseMs));
    }

    // 4. Causal step 4: show typing indicator in private chat
    if (sendTyping && Number(chatType) === 1) {
      const effEventType = Number(eventType ?? 1);
      const lastTypingAt = sessionState.lastTypingAtByPeer.get(peerKey) || 0;
      if (bypassDedupe || effEventType !== 1 || Date.now() - lastTypingAt >= dedupeWindowMs) {
        try {
          await invokeNtApi(
            "nodeIKernelMsgService/sendShowInputStatusReq",
            [
              {
                eventType: effEventType,
                peer: {
                  chatType: 1,
                  peerUid: peer.peerUid,
                  guildId: "",
                },
              },
              null,
            ],
            4000
          );
          steps.sendTyping = true;
          if (effEventType === 1) {
            setBoundedMap(sessionState.lastTypingAtByPeer, peerKey, Date.now());
          }
        } catch (err) {
          rethrowIfBridgeUnavailable(err);
        }
      } else {
        steps.sendTypingSkipped = true;
      }
    }

    steps.activeAioPeer = sessionState.activeAioPeer;
    steps.activeAioPeerKey = sessionState.activeAioPeerKey;
    steps.focused = sessionState.focused;
    return steps;
  }

  const bridgeApi = {
    version: "1.3.0",
    get windowId() {
      return windowId;
    },
    setWindowId(newId) {
      if (Number(newId) > 0) {
        windowId = Number(newId);
        attachPassiveListener(windowId);
        attachCommandListener();
      }
      return windowId;
    },
    get sessionState() {
      return sessionState;
    },
    syncSessionState,
    resetSessionState,
    makeCallbackId,
    reattachListeners,
    registerNtApiListeners,
    inspectVueAppState,
    invokeNtApi,
    async invokeNtApiSerialized(cmd, args, timeoutMs = 15000) {
      const res = await invokeNtApi(cmd, args, timeoutMs);
      return serializeBridgeResult(res);
    },
    simulateHumanSessionFlow,
    leaveHumanSessionFlow,
    _handleIncomingMainIpc: handleIncomingMainIpc,
  };

  Object.defineProperty(bridgeApi, "setIpcAuthToken", {
    value: setIpcAuthTokenOnce,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  win.__ROSMONTIS_RENDERER_BRIDGE__ = bridgeApi;
  return bridgeApi;
}

if (typeof window !== "undefined") {
  try {
    installRendererBridge(window, { autoRegisterListeners: true });
  } catch (_) {}
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    installRendererBridge,
    DEFAULT_REGISTERED_EVENTS,
  };
}
