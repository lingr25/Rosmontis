// @ts-check
"use strict";

/**
 * Renderer IPC, Electron Window Injection & 3-Tier NTQQ Dispatch Subsystem (`src/core/renderer_ipc.js`)
 *
 * Composed controller (`RendererIpcController`) managing trusted Electron `webContents`
 * injection, IPC auth token verification, structured `__ROSMONTIS_BRIDGE_CMD__` round-trips,
 * renderer crash/unresponsive self-healing, and 3-tier `invokeNt` dispatch with side-effect
 * non-replay protection.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { verifyAccessTokenConstantTime } = require("./transport_security");
const {
  safeJsJson,
  serializeBridgePayload,
  reviveBridgePayload,
  setBoundedMap,
} = require("./primitives");
const { isQuietLogsEnabled } = require("./env");
const { injectWireCodecIntoRendererSource } = require("./wire_codec");

/** @typedef {import("../types").BridgeHost} BridgeHost */
/** @typedef {import("../types").BridgeConfig} BridgeConfig */
/** @typedef {import("../types").CapturedServices} CapturedServices */
/** @typedef {import("../types").InvokeStats} InvokeStats */
/** @typedef {import("../types").RendererHealthStats} RendererHealthStats */

/** @type {Record<string, string>} */
const SERVICE_GETTER_MAP = {
  nodeIKernelMsgService: "getMsgService",
  nodeIKernelGroupService: "getGroupService",
  nodeIKernelBuddyService: "getBuddyService",
  nodeIKernelProfileService: "getProfileService",
  nodeIKernelProfileLikeService: "getProfileLikeService",
  nodeIKernelRichMediaService: "getRichMediaService",
  nodeIKernelRecentContactService: "getRecentContactService",
  nodeIKernelTicketService: "getTicketService",
  nodeIKernelUixConvertService: "getUixConvertService",
  nodeIKernelOnlineStatusService: "getOnlineStatusService",
  nodeIKernelRobotService: "getRobotService",
  nodeIKernelSearchService: "getSearchService",
  nodeIKernelFileAssistantService: "getFileAssistantService",
  nodeIKernelUnitedConfigService: "getUnitedConfigService",
  nodeIKernelTipOffService: "getTipOffService",
  nodeIKernelNodeMiscService: "getNodeMiscService",
  nodeIKernelMiscService: "getNodeMiscService",
  nodeIKernelLoginService: "getLoginService",
};

// Error tag for "this tier could not even dispatch the call" (renderer bridge not injected,
// ipcRenderer missing, webContents gone). Only such errors allow side-effect commands to
// fall through to the next tier; any other failure means the call may already have reached
// the kernel/server and must NOT be replayed.
const BRIDGE_UNAVAILABLE_TAG = "ROSMONTIS_BRIDGE_UNAVAILABLE";
const RENDERER_HEALTH_ATTACHED = Symbol("rosmontisRendererHealthAttached");

// Kernel commands whose duplicate execution is user-visible or harmful (double messages,
// double recalls, repeated admin actions, burst retries under risk control).
const SIDE_EFFECT_NT_METHODS = new Set([
  "sendMsg",
  "forwardMsg",
  "forwardMsgWithComment",
  "multiForwardMsg",
  "multiForwardMsgWithComment",
  "recallMsg",
  "sendNudge",
  "sendPoke",
  "setMsgEmojiLikes",
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
  "publishGroupBulletin",
  "addGroupEssence",
  "removeGroupEssence",
  "setBuddyProfileLike",
  "setBuddyRemark",
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
  "setHeader",
  "setLongNick",
  "modifySelfProfile",
  "modifyDesktopMiniProfile",
  "setStatus",
  "setAutoLogin",
  "setAutoLoginSwitch",
  "quickLogin",
  "quickLoginWithUin",
]);

/**
 * @param {string} cmd
 * @returns {boolean}
 */
function isSideEffectNtCmd(cmd) {
  const method = String(cmd || "").split("/").pop() || "";
  return SIDE_EFFECT_NT_METHODS.has(method);
}

/**
 * @param {string} message
 * @returns {Error & { rosmontisUnavailable?: boolean }}
 */
function makeBridgeUnavailableError(message) {
  /** @type {Error & { rosmontisUnavailable?: boolean }} */
  const err = new Error(`${BRIDGE_UNAVAILABLE_TAG}: ${message}`);
  err.rosmontisUnavailable = true;
  return err;
}

/**
 * @param {any} err
 * @returns {boolean}
 */
function isBridgeUnavailableError(err) {
  if (!err) return false;
  if (err.rosmontisUnavailable === true) return true;
  return String(err.message || err).includes(BRIDGE_UNAVAILABLE_TAG);
}

/** @type {string | null} */
let cachedRendererBridgeSource = null;

/**
 * Loads and caches the self-contained `src/bridge_renderer.js` script source.
 * @returns {string}
 */
function getRendererBridgeSource() {
  if (cachedRendererBridgeSource !== null) {
    return cachedRendererBridgeSource;
  }
  try {
    const candidates = [
      path.join(__dirname, "..", "bridge_renderer.js"),
      path.join(__dirname, "bridge_renderer.js"),
    ];
    const rendererPath = candidates.find((p) => fs.existsSync(p));
    if (!rendererPath) {
      cachedRendererBridgeSource = "";
      return "";
    }
    const rawSource = fs.readFileSync(rendererPath, "utf8");
    cachedRendererBridgeSource = injectWireCodecIntoRendererSource(rawSource);
    return cachedRendererBridgeSource;
  } catch (_readErr) {
    // Benign: return empty string when renderer bundle cannot be read (e.g., stripped test env).
    return "";
  }
}

/**
 * Composed Electron renderer IPC & 3-tier NTQQ invocation controller.
 */
class RendererIpcController {
  /**
   * @param {BridgeHost | Partial<BridgeHost>} [bridge={}]
   */
  constructor(bridge = {}) {
    /** @type {BridgeHost} */
    this.bridge = /** @type {BridgeHost} */ (bridge || {});
    /** @type {any} */
    this.activeWebContents = Object.prototype.hasOwnProperty.call(this.bridge, "activeWebContents")
      ? this.bridge.activeWebContents
      : null;
    /** @type {Set<any>} */
    this._knownWebContents = new Set();
    /** @type {string} */
    this._ipcAuthToken = crypto.randomBytes(32).toString("hex");
    /** @type {Map<string, any>} */
    this._pendingRendererCmds = new Map();
    /** @type {boolean} */
    this._ipcCmdAckInstalled = false;
    /** @type {InvokeStats} */
    this.invokeStats =
      Object.prototype.hasOwnProperty.call(this.bridge, "invokeStats") &&
      this.bridge.invokeStats &&
      typeof this.bridge.invokeStats === "object"
        ? this.bridge.invokeStats
        : {
            tier1: 0,
            tier2: 0,
            tier3: 0,
            directMain: 0,
            degraded: 0,
            blockedReplays: 0,
            failed: 0,
            lastDegraded: null,
          };
    /** @type {RendererHealthStats | null} */
    this.rendererHealthStats = Object.prototype.hasOwnProperty.call(
      this.bridge,
      "rendererHealthStats"
    )
      ? this.bridge.rendererHealthStats ?? null
      : null;
    /** @type {number[]} */
    this._rendererReloadTimestamps = [];
    /** @type {Map<any, ReturnType<typeof setTimeout>>} */
    this._rendererReloadTimers = new Map();
    /** @type {Map<string, number>} */
    this._fallbackLogThrottle = new Map();
  }

  /** @returns {BridgeConfig | undefined} */
  get config() {
    return this.bridge.config;
  }

  /** @returns {InstanceType<typeof import("./primitives").BridgeLogger> | undefined} */
  get logger() {
    return this.bridge.logger;
  }

  /** @returns {CapturedServices | undefined} */
  get capturedServices() {
    return this.bridge.capturedServices;
  }

  /** @param {any} err */
  _debugSafe(err) {
    try {
      this.logger?.debug?.("renderer_ipc", err);
    } catch (_logErr) {
      // Benign: never let debug logging interrupt IPC handlers.
    }
  }

  /**
   * @param {any} val
   * @returns {string}
   */
  _safeJsJson(val) {
    return safeJsJson(val);
  }

  /**
   * @param {any} url
   * @returns {boolean}
   */
  _isTrustedRendererUrl(url) {
    if (url === undefined || url === null) return true;
    const trimmed = String(url).trim().toLowerCase();
    if (trimmed === "") return true;
    if (
      trimmed.startsWith("http:") ||
      trimmed.startsWith("https:") ||
      trimmed.startsWith("devtools:") ||
      trimmed.startsWith("chrome-extension:") ||
      trimmed.startsWith("data:") ||
      trimmed.startsWith("blob:") ||
      trimmed.startsWith("javascript:") ||
      trimmed.startsWith("about:")
    ) {
      return false;
    }
    if (
      trimmed.startsWith("app:") ||
      trimmed.startsWith("file:") ||
      trimmed.startsWith("qq:") ||
      trimmed.startsWith("ntqq:") ||
      trimmed.startsWith("local-resource:")
    ) {
      return true;
    }
    return false;
  }

  /**
   * @param {any} event
   * @param {any} payload
   * @returns {boolean}
   */
  _isTrustedIpcEvent(event, payload) {
    if (!event || !event.sender) {
      if (payload && typeof payload === "object" && payload.__ipcToken !== undefined) {
        return verifyAccessTokenConstantTime(String(payload.__ipcToken || ""), this._ipcAuthToken);
      }
      return true;
    }
    const sender = event.sender;
    if (!this._knownWebContents.has(sender) || !this._isWebContentsAlive(sender)) {
      return false;
    }
    if (typeof sender.getURL === "function") {
      let senderUrl = "";
      try {
        senderUrl = sender.getURL();
      } catch (err) {
        this._debugSafe(err);
        return false;
      }
      if (!this._isTrustedRendererUrl(senderUrl)) {
        return false;
      }
    }
    if (event.senderFrame && sender.mainFrame && event.senderFrame !== sender.mainFrame) {
      return false;
    }
    if (sender.__rosmontisIpcTokenInjected) {
      const provided =
        payload && typeof payload === "object" && typeof payload.__ipcToken === "string"
          ? payload.__ipcToken
          : "";
      if (!verifyAccessTokenConstantTime(provided, this._ipcAuthToken)) {
        return false;
      }
    }
    return true;
  }

  /**
   * @param {any} _event
   * @param {any} ack
   */
  _handleRendererCmdAck(_event, ack) {
    if (!this._isTrustedIpcEvent(_event, ack)) return;
    if (!ack || typeof ack !== "object" || !ack.reqId) return;
    const reqId = String(ack.reqId);
    const pending = this._pendingRendererCmds.get(reqId);
    if (!pending) return;
    if (pending.webContents && _event && _event.sender && _event.sender !== pending.webContents) {
      return;
    }
    this._pendingRendererCmds.delete(reqId);
    if (pending.timer) clearTimeout(pending.timer);

    if (ack.ok) {
      let val = ack.result !== undefined ? ack.result : ack.data;
      if (typeof ack.resultSerialized === "string") {
        try {
          val = JSON.parse(ack.resultSerialized);
        } catch (err) {
          this._debugSafe(err);
          val = ack.resultSerialized;
        }
      }
      pending.resolve(this._reviveBridgeResult(val));
    } else {
      const errMsg = String(ack.error?.message || ack.error || "Renderer bridge command failed");
      /** @type {Error & { code?: string, rosmontisUnavailable?: boolean }} */
      const err = new Error(errMsg);
      if (ack.error?.code) {
        err.code = String(ack.error.code);
      }
      if (err.code === BRIDGE_UNAVAILABLE_TAG || errMsg.includes(BRIDGE_UNAVAILABLE_TAG)) {
        err.rosmontisUnavailable = true;
      }
      pending.reject(err);
    }
  }

  /** @returns {RendererHealthStats} */
  _ensureRendererHealthStats() {
    if (!this.rendererHealthStats || typeof this.rendererHealthStats !== "object") {
      this.rendererHealthStats = {
        crashes: 0,
        unresponsive: 0,
        unresponsiveActive: false,
        recoveries: 0,
        recoveryFailures: 0,
        reloadSuppressed: 0,
        lastCrashAt: 0,
        lastCrashReason: "",
        lastUnresponsiveAt: 0,
      };
    }
    if (!Array.isArray(this._rendererReloadTimestamps)) {
      this._rendererReloadTimestamps = [];
    }
    if (!(this._rendererReloadTimers instanceof Map)) {
      this._rendererReloadTimers = new Map();
    }
    return this.rendererHealthStats;
  }

  /** @param {any} [webContents=null] */
  _clearRendererReloadTimers(webContents = null) {
    if (!(this._rendererReloadTimers instanceof Map)) return;
    if (webContents) {
      const timer = this._rendererReloadTimers.get(webContents);
      if (timer) {
        clearTimeout(timer);
        this._rendererReloadTimers.delete(webContents);
      }
      return;
    }
    for (const timer of this._rendererReloadTimers.values()) {
      if (timer) clearTimeout(timer);
    }
    this._rendererReloadTimers.clear();
  }

  /**
   * @param {any} [webContents=null]
   * @param {string} [reason="Renderer command channel closed"]
   */
  _rejectPendingRendererCmds(webContents = null, reason = "Renderer command channel closed") {
    if (!webContents) {
      this._clearRendererReloadTimers(null);
    }
    for (const [reqId, pending] of Array.from(this._pendingRendererCmds.entries())) {
      if (!webContents || pending.webContents === webContents) {
        this._pendingRendererCmds.delete(reqId);
        if (pending.timer) clearTimeout(pending.timer);
        try {
          pending.reject(makeBridgeUnavailableError(reason));
        } catch (err) {
          this._debugSafe(err);
        }
      }
    }
  }

  /**
   * @param {any} [electronModule]
   * @returns {boolean}
   */
  installElectronHooks(electronModule) {
    let electron = electronModule;
    if (!electron) {
      try {
        const electronModuleId = "electron";
        electron = require(electronModuleId);
      } catch (err) {
        this._debugSafe(err);
        return false;
      }
    }
    if (!electron || typeof electron !== "object") return false;

    const attachWc = (/** @type {any} */ wc) => {
      this._attachToWebContents(wc);
    };

    const { app, ipcMain } = electron;
    if (ipcMain) {
      try {
        ipcMain.on("__ROSMONTIS_BRIDGE_EVENT__", (/** @type {any} */ _event, /** @type {any} */ payload) => {
          if (!this._isTrustedIpcEvent(_event, payload)) return;
          this._handleRendererForwardedEvent(payload);
        });
        if (typeof ipcMain.handle === "function") {
          ipcMain.handle(
            "__ROSMONTIS_BRIDGE_EVENT__",
            (/** @type {any} */ _event, /** @type {any} */ payload) => {
              if (!this._isTrustedIpcEvent(_event, payload)) return { ok: false };
              this._handleRendererForwardedEvent(payload);
              return { ok: true };
            }
          );
        }
        ipcMain.on("__ROSMONTIS_BRIDGE_CMD_ACK__", (/** @type {any} */ _event, /** @type {any} */ ack) => {
          this._handleRendererCmdAck(_event, ack);
        });
        if (typeof ipcMain.handle === "function") {
          ipcMain.handle(
            "__ROSMONTIS_BRIDGE_CMD_ACK__",
            (/** @type {any} */ _event, /** @type {any} */ ack) => {
              this._handleRendererCmdAck(_event, ack);
              return { ok: true };
            }
          );
        }
        this._ipcCmdAckInstalled = true;
        for (const wc of this._knownWebContents) {
          if (wc && wc.__rosmontisIpcTokenInjected && typeof wc.send === "function") {
            wc.__rosmontisCmdChannelReady = true;
          }
        }
      } catch (err) {
        this._debugSafe(err);
      }
    }

    if (app && typeof app.on === "function") {
      app.on("web-contents-created", (/** @type {any} */ _event, /** @type {any} */ webContents) => {
        attachWc(webContents);
      });
      app.on("browser-window-created", (/** @type {any} */ _event, /** @type {any} */ win) => {
        if (win && win.webContents) {
          attachWc(win.webContents);
        }
      });
    }
    try {
      const existing = electron.webContents?.getAllWebContents?.();
      if (Array.isArray(existing)) {
        for (const wc of existing) {
          attachWc(wc);
        }
      }
    } catch (err) {
      this._debugSafe(err);
    }
    try {
      const windows = electron.BrowserWindow?.getAllWindows?.();
      if (Array.isArray(windows)) {
        for (const win of windows) {
          const wc = win && win.webContents;
          if (wc && !this._knownWebContents.has(wc)) {
            attachWc(wc);
          }
        }
      }
    } catch (err) {
      this._debugSafe(err);
    }
    return true;
  }

  /**
   * @param {any} wc
   * @returns {boolean}
   */
  _isWebContentsAlive(wc) {
    if (!wc) return false;
    if (typeof wc.isDestroyed === "function" && wc.isDestroyed()) return false;
    return true;
  }

  /**
   * @param {any} wc
   * @returns {boolean}
   */
  _canInvokeRenderer(wc) {
    if (!this._isWebContentsAlive(wc)) return false;
    if (this._ipcCmdAckInstalled && wc.__rosmontisCmdChannelReady && typeof wc.send === "function") {
      return true;
    }
    return typeof wc.executeJavaScript === "function";
  }

  /**
   * @param {any} url
   * @returns {boolean}
   */
  _isMainChatUrl(url) {
    const u = String(url || "").trim().toLowerCase();
    return Boolean(u && (u.includes("main") || (u.includes("index.html") && !u.includes("login"))));
  }

  /**
   * @param {any} webContents
   * @returns {boolean}
   */
  _shouldPromoteWebContents(webContents) {
    if (!this._isWebContentsAlive(webContents)) return false;
    let url = "";
    try {
      if (typeof webContents.getURL === "function") {
        url = String(webContents.getURL() || "").trim().toLowerCase();
      }
    } catch (err) {
      this._debugSafe(err);
    }
    if (!this._isTrustedRendererUrl(url)) {
      return false;
    }
    if (!this._isWebContentsAlive(this.activeWebContents)) {
      return true;
    }
    if (this.activeWebContents === webContents) {
      return true;
    }
    const isAuxiliaryPopup =
      url.includes("image-viewer") ||
      url.includes("media-viewer") ||
      url.includes("video") ||
      url.includes("popup") ||
      url.includes("tray") ||
      url.includes("notification") ||
      url.includes("about:blank");
    if (isAuxiliaryPopup) {
      return false;
    }
    let currentUrl = "";
    try {
      if (typeof this.activeWebContents.getURL === "function") {
        currentUrl = String(this.activeWebContents.getURL() || "").trim().toLowerCase();
      }
    } catch (err) {
      this._debugSafe(err);
    }
    const currentIsMain = this._isMainChatUrl(currentUrl);
    if (!url) {
      return !currentIsMain;
    }
    if (this._isMainChatUrl(url)) {
      return true;
    }
    if (url.includes("login") && !currentIsMain) {
      return true;
    }
    return false;
  }

  /** @param {any} webContents */
  _attachToWebContents(webContents) {
    if (!webContents || typeof webContents.on !== "function") return;
    if (this._knownWebContents.has(webContents)) return;
    this._knownWebContents.add(webContents);
    this._ensureRendererHealthStats();

    if (this._shouldPromoteWebContents(webContents)) {
      this.activeWebContents = webContents;
    }
    let isWcDestroyed = false;
    const onDestroyed = () => {
      isWcDestroyed = true;
      webContents.__rosmontisBridgeInjected = false;
      webContents.__rosmontisCmdChannelReady = false;
      this._clearRendererReloadTimers(webContents);
      this._rejectPendingRendererCmds(webContents, "renderer webContents destroyed");
      this._knownWebContents.delete(webContents);
      if (this.activeWebContents === webContents) {
        this.activeWebContents = null;
        for (const candidate of this._knownWebContents) {
          if (this._shouldPromoteWebContents(candidate)) {
            this.activeWebContents = candidate;
            break;
          }
        }
      }
    };
    if (typeof webContents.once === "function") {
      webContents.once("destroyed", onDestroyed);
    } else {
      webContents.on("destroyed", onDestroyed);
    }

    let pageInjected = false;
    let injectPending = false;
    let injectGen = 0;
    const resetPageInjected = () => {
      injectGen += 1;
      pageInjected = false;
      injectPending = false;
      webContents.__rosmontisBridgeInjected = false;
      webContents.__rosmontisCmdChannelReady = false;
      webContents.__rosmontisIpcTokenInjected = false;
      this._rejectPendingRendererCmds(webContents, "renderer navigated");
    };

    const injectScript = () => {
      try {
        if (
          isWcDestroyed ||
          !this._knownWebContents.has(webContents) ||
          !this._isWebContentsAlive(webContents)
        ) {
          return;
        }
        let rawUrl = "";
        try {
          if (typeof webContents.getURL === "function") {
            rawUrl = String(webContents.getURL() || "");
          }
        } catch (err) {
          this._debugSafe(err);
          return;
        }
        if (!this._isTrustedRendererUrl(rawUrl)) return;
        const url = rawUrl.trim().toLowerCase();
        if (this._isMainChatUrl(url)) {
          this.bridge.online = true;
        }
        if (this._shouldPromoteWebContents(webContents)) {
          this.activeWebContents = webContents;
        }
        const maybeTriggerQuickLogin = () => {
          if (!this.bridge.online && url.includes("login") && this.config?.autoQuickLogin !== false) {
            const timer = setTimeout(() => {
              this._tryAutoQuickLogin({ webContents }).catch((/** @type {any} */ err) =>
                this._debugSafe(err)
              );
            }, 1500);
            if (timer && typeof timer.unref === "function") timer.unref();
          }
        };
        if (pageInjected || injectPending) {
          maybeTriggerQuickLogin();
          return;
        }
        const code = getRendererBridgeSource();
        if (!code) return;
        const rawWid = Number(webContents.id || 1);
        const widJson = this._safeJsJson(Number.isFinite(rawWid) && rawWid > 0 ? rawWid : 1);
        const ipcAuthTokenJson = this._safeJsJson(this._ipcAuthToken);
        const sc = this.bridge.sessionController;
        const syncPatchJson = this._safeJsJson({
          activeAioPeer: sc ? sc.activeAioPeer : null,
          activeAioPeerKey: sc ? sc.activeAioPeerKey : "",
          focused: sc ? sc.windowFocused : false,
        });
        const script = `(function(){ var wid = ${widJson}; var ipcAuthToken = ${ipcAuthTokenJson}; var syncPatch = ${syncPatchJson}; if (window.__ROSMONTIS_RENDERER_BRIDGE__) { if (typeof window.__ROSMONTIS_RENDERER_BRIDGE__.setIpcAuthToken === "function") window.__ROSMONTIS_RENDERER_BRIDGE__.setIpcAuthToken(ipcAuthToken); window.__ROSMONTIS_RENDERER_BRIDGE__.setWindowId(wid); if (typeof window.__ROSMONTIS_RENDERER_BRIDGE__.reattachListeners === "function") window.__ROSMONTIS_RENDERER_BRIDGE__.reattachListeners(); if (typeof window.__ROSMONTIS_RENDERER_BRIDGE__.syncSessionState === "function") window.__ROSMONTIS_RENDERER_BRIDGE__.syncSessionState(syncPatch); return true; } window.__ROSMONTIS_WINDOW_ID__ = wid;\n${code}\nif (typeof installRendererBridge === "function") { var b = installRendererBridge(window, { windowId: wid, autoRegisterListeners: true, ipcAuthToken: ipcAuthToken }); if (b && typeof b.setIpcAuthToken === "function") b.setIpcAuthToken(ipcAuthToken); if (b && typeof b.syncSessionState === "function") b.syncSessionState(syncPatch); } return true; })();`;
        const genAtStart = injectGen;
        injectPending = true;
        Promise.resolve(webContents.executeJavaScript(script, true))
          .then(() => {
            if (
              isWcDestroyed ||
              genAtStart !== injectGen ||
              !this._knownWebContents.has(webContents) ||
              !this._isWebContentsAlive(webContents)
            ) {
              return;
            }
            if (typeof webContents.getURL === "function") {
              try {
                if (!this._isTrustedRendererUrl(webContents.getURL())) return;
              } catch (err) {
                this._debugSafe(err);
                return;
              }
            }
            injectPending = false;
            pageInjected = true;
            webContents.__rosmontisBridgeInjected = true;
            webContents.__rosmontisIpcTokenInjected = true;
            if (typeof webContents.send === "function" && this._ipcCmdAckInstalled) {
              webContents.__rosmontisCmdChannelReady = true;
            }
            maybeTriggerQuickLogin();
          })
          .catch((err) => {
            this._debugSafe(err);
            if (genAtStart === injectGen) {
              injectPending = false;
            }
          });
      } catch (err) {
        this._debugSafe(err);
        injectPending = false;
      }
    };

    webContents.on("did-start-loading", resetPageInjected);
    webContents.on("did-navigate", resetPageInjected);
    webContents.on("dom-ready", injectScript);
    webContents.on("did-finish-load", injectScript);
    webContents.on("did-navigate-in-page", injectScript);

    if (!webContents[RENDERER_HEALTH_ATTACHED]) {
      Object.defineProperty(webContents, RENDERER_HEALTH_ATTACHED, {
        value: true,
        enumerable: false,
        configurable: true,
      });

      const onRenderProcessGone = (/** @type {any} */ _event, /** @type {any} */ details) => {
        const stats = this._ensureRendererHealthStats();
        const now = Date.now();
        const reason = String(details?.reason || "unknown");

        stats.crashes += 1;
        stats.lastCrashAt = now;
        stats.lastCrashReason = reason;
        stats.unresponsiveActive = false;

        injectGen += 1;
        pageInjected = false;
        injectPending = false;
        webContents.__rosmontisBridgeInjected = false;
        webContents.__rosmontisCmdChannelReady = false;
        webContents.__rosmontisIpcTokenInjected = false;

        this._rejectPendingRendererCmds(webContents, `renderer process gone (${reason})`);
        try {
          this.bridge.sessionController?.reset({ resetRenderer: false });
        } catch (err) {
          this._debugSafe(err);
        }

        if (this.activeWebContents === webContents) {
          this.activeWebContents = null;
        }

        this._logWarn(
          `renderer-gone:${webContents.id || 0}:${reason}`,
          `WARN: Renderer process gone (wc=${webContents.id || 0}, reason=${reason}, exitCode=${details?.exitCode ?? "n/a"})`,
          10000
        );

        if (
          this.config?.rendererAutoReload !== false &&
          typeof webContents.reload === "function" &&
          !isWcDestroyed &&
          !webContents.isDestroyed?.()
        ) {
          const rawMaxReloads = this.config?.rendererMaxReloadsPerMinute;
          const maxReloads =
            rawMaxReloads !== undefined &&
            rawMaxReloads !== null &&
            Number.isFinite(Number(rawMaxReloads))
              ? Math.max(0, Math.trunc(Number(rawMaxReloads)))
              : 3;

          this._rendererReloadTimestamps = this._rendererReloadTimestamps.filter(
            (ts) => now - ts < 60000
          );
          if (this._rendererReloadTimestamps.length >= maxReloads) {
            stats.reloadSuppressed += 1;
            this._logWarn(
              `renderer-reload-suppressed:${webContents.id || 0}`,
              `WARN: Renderer auto-reload suppressed (exceeded ${maxReloads} reloads/min)`,
              30000
            );
            return;
          }

          this._rendererReloadTimestamps.push(now);
          const attempt = this._rendererReloadTimestamps.length;
          const rawBackoff = this.config?.rendererReloadBackoffMs;
          const baseBackoffMs =
            rawBackoff !== undefined &&
            rawBackoff !== null &&
            Number.isFinite(Number(rawBackoff))
              ? Math.max(0, Number(rawBackoff))
              : 1500;
          const delayMs = baseBackoffMs * attempt;

          this._clearRendererReloadTimers(webContents);
          const timer = setTimeout(() => {
            this._rendererReloadTimers?.delete(webContents);
            if (
              isWcDestroyed ||
              !this._knownWebContents.has(webContents) ||
              !this._isWebContentsAlive(webContents) ||
              typeof webContents.reload !== "function"
            ) {
              return;
            }
            try {
              webContents.reload();
              stats.recoveries += 1;
            } catch (/** @type {any} */ err) {
              stats.recoveryFailures += 1;
              this._logWarn(
                `renderer-reload-fail:${webContents.id || 0}`,
                `WARN: Renderer auto-reload failed (wc=${webContents.id || 0}): ${err?.message || err}`,
                10000
              );
            }
          }, delayMs);
          if (timer && typeof timer.unref === "function") {
            timer.unref();
          }
          this._rendererReloadTimers.set(webContents, timer);
        }
      };

      const onUnresponsive = () => {
        const stats = this._ensureRendererHealthStats();
        stats.unresponsive += 1;
        stats.unresponsiveActive = true;
        stats.lastUnresponsiveAt = Date.now();
        this._logWarn(
          `renderer-unresponsive:${webContents.id || 0}`,
          `WARN: Renderer process unresponsive (wc=${webContents.id || 0})`,
          10000
        );
      };

      const onResponsive = () => {
        const stats = this._ensureRendererHealthStats();
        stats.unresponsiveActive = false;
      };

      webContents.on("render-process-gone", onRenderProcessGone);
      webContents.on("unresponsive", onUnresponsive);
      webContents.on("responsive", onResponsive);
    }

    try {
      const isLoading =
        typeof webContents.isLoadingMainFrame === "function"
          ? Boolean(webContents.isLoadingMainFrame())
          : typeof webContents.isLoading === "function"
          ? Boolean(webContents.isLoading())
          : false;
      if (!isLoading && typeof webContents.executeJavaScript === "function") {
        let shouldInjectNow = true;
        if (typeof webContents.getURL === "function") {
          const currentUrl = String(webContents.getURL() || "").trim();
          shouldInjectNow = Boolean(currentUrl) && this._isTrustedRendererUrl(currentUrl);
        }
        if (shouldInjectNow) {
          injectScript();
        }
      }
    } catch (err) {
      this._debugSafe(err);
    }
  }

  /**
   * Delegates auto-quick-login recovery to `InboundPipeline`.
   * @param {Record<string, any>} [options={}]
   * @returns {Promise<any>}
   */
  async _tryAutoQuickLogin(options = {}) {
    if (this.bridge.inboundPipeline) {
      return await this.bridge.inboundPipeline._tryAutoQuickLogin(options);
    }
    return { skipped: true, reason: "inbound_unavailable", online: Boolean(this.bridge.online) };
  }

  /**
   * Revives cross-process IPC payloads via `reviveBridgePayload` from `./primitives`.
   * @param {any} val
   * @returns {any}
   */
  _reviveBridgeResult(val) {
    return reviveBridgePayload(val);
  }

  /**
   * @param {any} val
   * @returns {any}
   */
  _reviveBridgePayload(val) {
    return this._reviveBridgeResult(val);
  }

  /** @param {any} rawData */
  _handleRendererForwardedEvent(rawData) {
    const data = this._reviveBridgeResult(rawData);
    if (!data || typeof data !== "object") return;
    const cmdName = String(data.cmdName || "");
    const eventName = String(data.eventName || "");
    const shortEvent = cmdName.includes("/") ? cmdName.split("/").pop() || "" : cmdName;
    const listenerName = cmdName.includes("/") ? cmdName.split("/")[0] : eventName;
    const payload = data.payload;
    if (shortEvent) {
      this.bridge.inboundPipeline?._handleKernelEvent(
        listenerName,
        shortEvent,
        Array.isArray(payload) ? payload : [payload]
      );
    }
  }

  /**
   * @param {any} value
   * @returns {string}
   */
  _serializeBridgeArgs(value) {
    return serializeBridgePayload(value);
  }

  /**
   * @param {any} value
   * @returns {string}
   */
  _serializeBridgePayload(value) {
    return serializeBridgePayload(value);
  }

  /**
   * @param {string} type
   * @param {Record<string, any>} [cmdPayload={}]
   * @param {number} [timeoutMs=15000]
   * @returns {Promise<any>}
   */
  async _invokeRendererCommand(type, cmdPayload = {}, timeoutMs = 15000) {
    const wc = this.activeWebContents;
    if (!this._isWebContentsAlive(wc)) {
      throw makeBridgeUnavailableError("no live renderer webContents");
    }
    if (typeof wc.getURL === "function") {
      let senderUrl = "";
      try {
        senderUrl = wc.getURL();
      } catch (err) {
        this._debugSafe(err);
        throw makeBridgeUnavailableError("failed to inspect renderer URL");
      }
      if (!this._isTrustedRendererUrl(senderUrl)) {
        throw makeBridgeUnavailableError("active renderer URL is untrusted");
      }
    }

    // Primary structured IPC channel (zero executeJavaScript per command)
    if (
      this._ipcCmdAckInstalled &&
      wc.__rosmontisCmdChannelReady &&
      typeof wc.send === "function"
    ) {
      const reqId = crypto.randomUUID();
      const envelope = {
        reqId,
        __ipcToken: this._ipcAuthToken,
        type,
        ...cmdPayload,
        timeoutMs,
      };
      return await new Promise((resolve, reject) => {
        const effectiveTimeout = Math.max(100, Number(timeoutMs) || 15000);
        const timer = setTimeout(() => {
          this._pendingRendererCmds.delete(reqId);
          reject(new Error(`Renderer IPC command timeout (${effectiveTimeout}ms): ${type}`));
        }, effectiveTimeout);
        if (typeof timer.unref === "function") timer.unref();

        this._pendingRendererCmds.set(reqId, {
          reqId,
          type,
          webContents: wc,
          timer,
          resolve,
          reject,
        });

        try {
          wc.send("__ROSMONTIS_BRIDGE_CMD__", envelope);
        } catch (/** @type {any} */ err) {
          clearTimeout(timer);
          this._pendingRendererCmds.delete(reqId);
          reject(makeBridgeUnavailableError(`webContents.send failed: ${err?.message || err}`));
        }
      });
    }

    // Fallback for synthetic unit-test mocks that only provide executeJavaScript
    if (typeof wc.executeJavaScript === "function") {
      let js = "";
      if (type === "invokeNt") {
        const cmdJson = this._safeJsJson(cmdPayload.cmd);
        const argsJson =
          typeof cmdPayload.argsSerialized === "string"
            ? cmdPayload.argsSerialized
            : this._serializeBridgeArgs(cmdPayload.args ?? [null, null]);
        const effectiveTimeout = Math.max(100, Number(timeoutMs) || 15000);
        const timeoutJson = this._safeJsJson(effectiveTimeout);
        const notReady = this._safeJsJson(`${BRIDGE_UNAVAILABLE_TAG}: Renderer bridge not ready`);
        js = `(window.__ROSMONTIS_RENDERER_BRIDGE__ && window.__ROSMONTIS_RENDERER_BRIDGE__.invokeNtApiSerialized) ? window.__ROSMONTIS_RENDERER_BRIDGE__.invokeNtApiSerialized(${cmdJson}, ${argsJson}, ${timeoutJson}) : (window.__ROSMONTIS_RENDERER_BRIDGE__ && window.__ROSMONTIS_RENDERER_BRIDGE__.invokeNtApi) ? window.__ROSMONTIS_RENDERER_BRIDGE__.invokeNtApi(${cmdJson}, ${argsJson}, ${timeoutJson}) : Promise.reject(new Error(${notReady}))`;
      } else if (type === "simulateSession") {
        const optsJson = this._safeJsJson(cmdPayload.opts || {});
        js = `(window.__ROSMONTIS_RENDERER_BRIDGE__ && window.__ROSMONTIS_RENDERER_BRIDGE__.simulateHumanSessionFlow) ? window.__ROSMONTIS_RENDERER_BRIDGE__.simulateHumanSessionFlow(${optsJson}) : null`;
      } else if (type === "leaveSession") {
        const optsJson = this._safeJsJson(cmdPayload.opts || {});
        js = `(window.__ROSMONTIS_RENDERER_BRIDGE__ && window.__ROSMONTIS_RENDERER_BRIDGE__.leaveHumanSessionFlow) ? window.__ROSMONTIS_RENDERER_BRIDGE__.leaveHumanSessionFlow(${optsJson}) : null`;
      } else if (type === "syncSession") {
        const patchJson = this._safeJsJson(cmdPayload.patch || {});
        js = `(window.__ROSMONTIS_RENDERER_BRIDGE__ && window.__ROSMONTIS_RENDERER_BRIDGE__.syncSessionState) ? window.__ROSMONTIS_RENDERER_BRIDGE__.syncSessionState(${patchJson}) : null`;
      } else if (type === "resetSession") {
        js = `(window.__ROSMONTIS_RENDERER_BRIDGE__ && window.__ROSMONTIS_RENDERER_BRIDGE__.resetSessionState) ? window.__ROSMONTIS_RENDERER_BRIDGE__.resetSessionState() : null`;
      } else {
        throw new Error(`Unsupported renderer command type: ${type}`);
      }
      const rawRes = await wc.executeJavaScript(js, true);
      if (typeof rawRes === "string" && type === "invokeNt") {
        try {
          return this._reviveBridgeResult(JSON.parse(rawRes));
        } catch (err) {
          this._debugSafe(err);
          return rawRes;
        }
      }
      return this._reviveBridgeResult(rawRes);
    }

    throw makeBridgeUnavailableError("no live renderer command transport");
  }

  /**
   * @param {string} cmd
   * @param {number} tier
   * @param {any[]} prevErrors
   * @param {{ intentionalDirect?: boolean } | null} [options=null]
   */
  _recordInvokeTier(cmd, tier, prevErrors, options = null) {
    const stats = /** @type {Record<string, any>} */ (this.invokeStats);
    stats[`tier${tier}`] = (stats[`tier${tier}`] || 0) + 1;
    if (options && options.intentionalDirect) {
      stats.directMain = (stats.directMain || 0) + 1;
      return;
    }
    if (tier > 1) {
      stats.degraded += 1;
      stats.lastDegraded = { cmd, tier, at: Date.now() };
      const reason = prevErrors.length > 0 ? String(prevErrors[0]?.message || prevErrors[0]) : "";
      this._logInvokeWarning(
        `degrade:${cmd}:${tier}`,
        `invokeNt degraded to Tier ${tier} for ${cmd}${reason ? ` (after: ${reason.slice(0, 200)})` : ""}`
      );
    }
  }

  /**
   * @param {string} key
   * @param {string} message
   */
  _logInvokeWarning(key, message) {
    if (this.logger && typeof this.logger.warnThrottled === "function") {
      this.logger.warnThrottled(key, `WARN: ${message}`, 60000);
      return;
    }
    if (isQuietLogsEnabled(this.config)) return;
    const now = Date.now();
    const last = this._fallbackLogThrottle.get(key);
    if (last !== undefined && now - last < 60000) return;
    setBoundedMap(this._fallbackLogThrottle, key, now, 500);
    try {
      process.stderr.write(`[rosmontis] WARN: ${message}\n`);
    } catch (_writeErr) {
      // Benign: stderr may be closed in detached daemon environments.
    }
  }

  /**
   * @param {string} key
   * @param {string} message
   * @param {number} [intervalMs=60000]
   */
  _logWarn(key, message, intervalMs = 60000) {
    if (this.logger && typeof this.logger.warnThrottled === "function") {
      this.logger.warnThrottled(key, message, intervalMs);
      return;
    }
    if (isQuietLogsEnabled(this.config)) return;
    const now = Date.now();
    const last = this._fallbackLogThrottle.get(key);
    if (last !== undefined && now - last < intervalMs) return;
    setBoundedMap(this._fallbackLogThrottle, key, now, 500);
    try {
      process.stderr.write(`[rosmontis] ${message}\n`);
    } catch (_writeErr) {
      // Benign: stderr may be closed in detached daemon environments.
    }
  }

  /**
   * @param {string} cmd
   * @param {any} payload
   * @param {boolean} sideEffect
   * @param {any[]} errors
   * @param {(err: any) => boolean} stopAfterDispatchedFailure
   * @param {{ intentionalDirect?: boolean } | null} [options=null]
   * @returns {Promise<{ handled: boolean, value: any }>}
   */
  async _invokeTier2NtApi(
    cmd,
    payload,
    sideEffect,
    errors,
    stopAfterDispatchedFailure,
    options = null
  ) {
    if (!this.capturedServices?.ntApi) {
      return { handled: false, value: undefined };
    }
    const ntApiTarget =
      typeof this.capturedServices.ntApi["nodeIKernelMsgService/sendMsg"] === "function"
        ? this.capturedServices.ntApi
        : this.capturedServices.ntApi.invoke &&
          typeof this.capturedServices.ntApi.invoke["nodeIKernelMsgService/sendMsg"] === "function"
        ? this.capturedServices.ntApi.invoke
        : this.capturedServices.ntApi;
    /** @type {any} */
    let handler = null;
    try {
      handler = ntApiTarget[cmd];
    } catch (err) {
      this._debugSafe(err);
    }
    if (typeof handler === "function") {
      try {
        const fakeIpcEvent = {
          sender: this.activeWebContents || {
            id: 1,
            send() {},
            isDestroyed: () => false,
          },
        };
        const res = await handler(payload, fakeIpcEvent);
        // A resolved side-effect call has been dispatched even if it returns void.
        if (res !== undefined || sideEffect) {
          this._recordInvokeTier(cmd, 2, errors, options);
          return { handled: true, value: res };
        }
      } catch (e) {
        if (stopAfterDispatchedFailure(e)) throw e;
      }
    } else {
      errors.push(makeBridgeUnavailableError(`ntApi has no handler for ${cmd}`));
    }
    return { handled: false, value: undefined };
  }

  /**
   * 3-tier NTQQ invocation.
   *
   * Fallback policy:
   * - Read/idempotent commands: any Tier failure falls through to the next Tier (legacy behaviour).
   * - Bulk read-only commands (`invokeOptions.preferMainProcess === true` when
   *   `config.preferMainProcessForBulkReads !== false`): try main-process `ntApi` (Tier 2) first
   *   to avoid double Mojo structured-clone + JSON serialization round-trips through the renderer
   *   process, falling back cleanly to Tier 1 / Tier 3 if unavailable.
   * - Side-effect commands (`SIDE_EFFECT_NT_METHODS`, e.g. sendMsg/recallMsg): only fall through
   *   when the previous Tier could not dispatch at all (`BRIDGE_UNAVAILABLE_TAG`). Once a Tier has
   *   actually dispatched the call, its timeout/error is surfaced as-is and never replayed, so a
   *   slow upload or a risk-control rejection can not turn into duplicate messages.
   *
   * @param {string} cmd
   * @param {Record<string, any>} [payload={}]
   * @param {any[] | null} [positionalArgs=null]
   * @param {{ preferMainProcess?: boolean, timeoutMs?: number } | null} [invokeOptions=null]
   * @returns {Promise<any>}
   */
  async invokeNt(cmd, payload = {}, positionalArgs = null, invokeOptions = null) {
    /** @type {any[]} */
    const errors = [];
    const sideEffect = isSideEffectNtCmd(cmd);
    const stopAfterDispatchedFailure = (/** @type {any} */ err) => {
      errors.push(err);
      if (sideEffect && !isBridgeUnavailableError(err)) {
        this.invokeStats.blockedReplays += 1;
        this._logInvokeWarning(
          `blocked:${cmd}`,
          `invokeNt not replaying side-effect ${cmd} after dispatched failure: ${String(err?.message || err).slice(0, 200)}`
        );
        return true;
      }
      return false;
    };

    const rendererExecute = this.bridge.rendererExecute;
    const preferMainDirect =
      !sideEffect &&
      Boolean(invokeOptions && invokeOptions.preferMainProcess) &&
      this.config?.preferMainProcessForBulkReads === true &&
      typeof rendererExecute !== "function" &&
      Boolean(this.capturedServices?.ntApi);

    // Optional fast-path for bulk read-only queries (e.g. getMsgsIncludeSelf) to avoid
    // large double-hop Mojo/JSON payloads through the Electron renderer process.
    let tier2Attempted = false;
    if (preferMainDirect) {
      tier2Attempted = true;
      const directRes = await this._invokeTier2NtApi(
        cmd,
        payload,
        sideEffect,
        errors,
        stopAfterDispatchedFailure,
        { intentionalDirect: true }
      );
      if (directRes.handled) {
        return directRes.value;
      }
    }

    const canInvokeRenderer = this._canInvokeRenderer(this.activeWebContents);

    // Tier 1: Execute via Renderer structured IPC (`__ROSMONTIS_BRIDGE_CMD__`) or safe fallback
    if (typeof rendererExecute === "function") {
      try {
        const res = await rendererExecute(cmd, [payload, null]);
        this._recordInvokeTier(cmd, 1, errors);
        return this._reviveBridgeResult(res);
      } catch (e) {
        if (stopAfterDispatchedFailure(e)) throw e;
      }
    } else if (canInvokeRenderer) {
      try {
        const argsSerialized = this._serializeBridgeArgs([payload, null]);
        const cmdTimeoutMs =
          Number.isFinite(Number(invokeOptions?.timeoutMs)) && Number(invokeOptions?.timeoutMs) > 0
            ? Number(invokeOptions?.timeoutMs)
            : 15000;
        const res = await this._invokeRendererCommand(
          "invokeNt",
          {
            cmd,
            argsSerialized,
          },
          cmdTimeoutMs
        );
        this._recordInvokeTier(cmd, 1, errors);
        return res;
      } catch (e) {
        if (stopAfterDispatchedFailure(e)) throw e;
      }
    } else {
      errors.push(makeBridgeUnavailableError("no live renderer webContents"));
    }

    // Tier 2: Execute via Main-Process `ntApi[cmd]` Proxy
    // Note: Real NTQQ 3.2.32 `ntApi.invoke[cmd]` expects `(payload, ipcEvent)` directly
    // (NOT `([payload, null], ipcEvent)`).
    if (!tier2Attempted && this.capturedServices?.ntApi) {
      const tier2Res = await this._invokeTier2NtApi(
        cmd,
        payload,
        sideEffect,
        errors,
        stopAfterDispatchedFailure
      );
      if (tier2Res.handled) {
        return tier2Res.value;
      }
    }

    // Tier 3: Execute via live `NodeIQQNTWrapperSession.get*Service()[method](...positionalArgs)`
    const session =
      this.capturedServices?.wrapperSession ||
      this.capturedServices?.ntStore?.wrapperSession ||
      this.capturedServices?.ntStore?.session ||
      this.capturedServices?.ntSessionManager?.ntStore?.wrapperSession ||
      this.capturedServices?.ntSessionManager?.ntStore?.session;
    if (session && cmd.includes("/")) {
      const [serviceName, methodName] = cmd.split("/");
      const getterName = SERVICE_GETTER_MAP[serviceName];
      if (getterName && typeof session[getterName] === "function") {
        try {
          const svc = session[getterName]();
          if (svc && typeof svc[methodName] === "function") {
            const callArgs = Array.isArray(positionalArgs)
              ? positionalArgs
              : payload && typeof payload === "object"
              ? Object.values(payload)
              : [];
            const res = await svc[methodName](...callArgs);
            this._recordInvokeTier(cmd, 3, errors);
            return res;
          }
        } catch (e) {
          errors.push(e);
        }
      }
    }

    this.invokeStats.failed += 1;
    const dispatched = errors.find((e) => !isBridgeUnavailableError(e));
    if (dispatched) {
      throw dispatched;
    }
    /** @type {Error & { rosmontisUnavailable?: boolean }} */
    const unavailable = new Error(`NTQQ service unavailable for ${cmd}`);
    unavailable.rosmontisUnavailable = true;
    throw unavailable;
  }
}

module.exports = {
  safeJsJson,
  SERVICE_GETTER_MAP,
  BRIDGE_UNAVAILABLE_TAG,
  SIDE_EFFECT_NT_METHODS,
  isSideEffectNtCmd,
  makeBridgeUnavailableError,
  isBridgeUnavailableError,
  getRendererBridgeSource,
  RendererIpcController,
};
