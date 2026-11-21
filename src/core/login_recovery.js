// @ts-check
"use strict";

/**
 * Login State, QR Code & Auto-Quick-Login Recovery Subsystem (`src/core/login_recovery.js`)
 *
 * Typed helper class (`LoginRecovery`) composed by `InboundPipeline`:
 * - Login / QR / session-init / kicked-offline kernel event handlers
 * - Self-identity synchronization helpers (`syncSelfIdentityFromLogin`)
 * - Saved-account selection & auto-quick-login recovery (`tryAutoQuickLogin`)
 */

const { formatNoticeEvent } = require("../bridge_onebot");
const { pickPositiveUin, normalizeLoginIdentity } = require("./nt_normalizer");

/** @typedef {import("../types").InvokeNtFn} InvokeNtFn */
/** @typedef {import("../types").NormalizedLoginIdentity} NormalizedLoginIdentity */

/**
 * Host contract required by `LoginRecovery` (satisfied by `InboundPipeline`).
 * @typedef {object} LoginRecoveryHost
 * @property {boolean} online
 * @property {string} selfUin
 * @property {string} selfUid
 * @property {string} selfNickname
 * @property {string} lastQrCodeBase64
 * @property {any} activeWebContents
 * @property {Set<(qrBase64: string) => void>} _qrCodeWaiters
 * @property {number} _autoQuickLoginAttempts
 * @property {number} _lastAutoQuickLoginAt
 * @property {InstanceType<typeof import("./primitives").BridgeLogger>} [logger]
 * @property {InvokeNtFn} invokeNt
 * @property {(identity?: Record<string, any>) => void} _updateSelfIdentity
 * @property {(opts?: Record<string, any>) => any} _resetHumanSessionState
 * @property {(ev: any) => void} _dispatchInboundEvent
 * @property {(wc: any) => boolean} _isWebContentsAlive
 * @property {(url: any) => boolean} _isTrustedRendererUrl
 */

const LOGIN_KERNEL_EVENTS = Object.freeze(
  new Set([
    "onQRCodeGetPicture",
    "onQRCodeSessionQuickLoginFailed",
    "onUserLoggedIn",
    "onQRCodeLoginSucceed",
    "onSessionInitComplete",
    "onKickedOffLine",
  ])
);

const QR_BASE64_KEYS = Object.freeze([
  "pngBase64QrcodeData",
  "qrcodeImage",
  "qrCodeImage",
  "qrcode_base64",
  "pngBase64",
  "imageBase64",
  "imgBase64",
  "qrcodeBase64",
  "qrCodeBase64",
]);

const QR_CONTAINER_KEYS = Object.freeze([
  "qrcodeInfo",
  "qrCodeInfo",
  "result",
  "data",
  "info",
]);

/**
 * @param {any} payload
 * @param {number} [depth=0]
 * @returns {string}
 */
function extractQrCodeBase64(payload, depth = 0) {
  if (!payload || depth > 4) return "";
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    return trimmed.startsWith("data:image/") ? trimmed : "";
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(payload) && payload.length > 0) {
    return `data:image/png;base64,${payload.toString("base64")}`;
  }
  if (payload instanceof Uint8Array && payload.byteLength > 0) {
    return `data:image/png;base64,${Buffer.from(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength
    ).toString("base64")}`;
  }
  if (typeof payload !== "object") return "";
  for (const key of QR_BASE64_KEYS) {
    const val = payload[key];
    if (typeof val === "string" && val.trim()) {
      return val.trim();
    }
    if (
      val &&
      ((typeof Buffer !== "undefined" && Buffer.isBuffer(val)) || val instanceof Uint8Array) &&
      val.byteLength > 0
    ) {
      return extractQrCodeBase64(val, depth + 1);
    }
  }
  for (const containerKey of QR_CONTAINER_KEYS) {
    const nested = payload[containerKey];
    if (nested && typeof nested === "object") {
      const found = extractQrCodeBase64(nested, depth + 1);
      if (found) return found;
    }
  }
  return "";
}

/**
 * @param {any} payload
 * @returns {boolean}
 */
function isSessionInitSuccess(payload) {
  const code =
    payload && typeof payload === "object"
      ? Number(payload.result ?? 0)
      : Number(payload ?? 0);
  return !Number.isFinite(code) || code === 0;
}

/**
 * @param {any[]} list
 * @param {string} [preferredUin=""]
 * @returns {any | null}
 */
function selectQuickLoginAccount(list, preferredUin = "") {
  if (!Array.isArray(list) || list.length === 0) return null;
  const targetUin = String(preferredUin || "").trim();
  return (
    (targetUin ? list.find((item) => item && String(item.uin) === targetUin) : null) ||
    list.find((item) => item && (item.isQuickLogin || item.isAutoLogin) && item.uin) ||
    null
  );
}

/**
 * @param {string | number} selfUin
 * @param {any} firstArg
 */
function buildBotOfflineNoticePayload(selfUin, firstArg) {
  return {
    user_id: pickPositiveUin(selfUin),
    tag: String(firstArg?.tipsTitle || "kicked_offline"),
    message: String(firstArg?.tipsDesc || "QQ offline"),
  };
}

class LoginRecovery {
  /**
   * @param {LoginRecoveryHost} host
   */
  constructor(host) {
    /** @type {LoginRecoveryHost} */
    this.host = host;
  }

  /**
   * @param {any} rawIdentity
   * @param {{ markOnline?: boolean }} [options={}]
   * @returns {NormalizedLoginIdentity}
   */
  syncSelfIdentityFromLogin(rawIdentity, { markOnline = true } = {}) {
    const identity = normalizeLoginIdentity(rawIdentity);
    if (typeof this.host._updateSelfIdentity === "function") {
      this.host._updateSelfIdentity({
        ...identity,
        markOnline: Boolean(markOnline),
      });
      return identity;
    }
    if (identity.uin && /^\d+$/.test(String(identity.uin))) {
      this.host.selfUin = String(identity.uin);
    }
    if (identity.uid) {
      this.host.selfUid = String(identity.uid);
    }
    if (identity.nick) {
      this.host.selfNickname = String(identity.nick);
    }
    if (markOnline) {
      this.host.online = true;
    }
    return identity;
  }

  /**
   * @param {any} firstArg
   */
  handleQrCodeEvent(firstArg) {
    const pngBase64 = extractQrCodeBase64(firstArg);
    if (pngBase64) {
      this.host.lastQrCodeBase64 = pngBase64;
      if (this.host._qrCodeWaiters && this.host._qrCodeWaiters.size > 0) {
        for (const resolveWaiter of Array.from(this.host._qrCodeWaiters)) {
          try {
            resolveWaiter(pngBase64);
          } catch (err) {
            this.host.logger?.debug?.("login_recovery", err);
          }
        }
        this.host._qrCodeWaiters.clear();
      }
      this.host.logger?.debug?.("login", `QR code updated (length=${pngBase64.length})`);
    } else {
      const argShape =
        firstArg && typeof firstArg === "object"
          ? Object.keys(firstArg).slice(0, 16).join(",")
          : typeof firstArg;
      const nestedInfo =
        firstArg?.qrcodeInfo || firstArg?.qrCodeInfo || firstArg?.result || firstArg?.data;
      const nestedShape =
        nestedInfo && typeof nestedInfo === "object"
          ? Object.keys(nestedInfo).slice(0, 16).join(",")
          : "";
      this.host.logger?.debug?.(
        "login",
        `QR event without base64 payload (shape=${argShape}${nestedShape ? `, nested=${nestedShape}` : ""})`
      );
    }
  }

  /**
   * @param {any} firstArg
   */
  handleUserLoggedInEvent(firstArg) {
    this.host.lastQrCodeBase64 = "";
    this.syncSelfIdentityFromLogin(firstArg, { markOnline: true });
  }

  /**
   * @param {any} firstArg
   */
  handleSessionInitCompleteEvent(firstArg) {
    if (isSessionInitSuccess(firstArg)) {
      this.host.online = true;
    }
  }

  /**
   * @param {any} firstArg
   */
  handleKickedOffLineEvent(firstArg) {
    this.host.online = false;
    this.host.lastQrCodeBase64 = "";
    this.host._resetHumanSessionState?.({ resetRenderer: true });
    this.host._dispatchInboundEvent?.(
      formatNoticeEvent(
        "bot_offline",
        buildBotOfflineNoticePayload(this.host.selfUin, firstArg),
        { selfId: this.host.selfUin }
      )
    );
  }

  /**
   * @param {string} eventName
   * @param {any[]} args
   * @returns {boolean}
   */
  handleLoginKernelEvent(eventName, args) {
    const firstArg = args && args.length > 0 ? args[0] : undefined;
    if (eventName === "onQRCodeGetPicture" || eventName === "onQRCodeSessionQuickLoginFailed") {
      this.handleQrCodeEvent(firstArg);
      return true;
    }
    if (eventName === "onUserLoggedIn" || eventName === "onQRCodeLoginSucceed") {
      this.handleUserLoggedInEvent(firstArg);
      return true;
    }
    if (eventName === "onSessionInitComplete") {
      this.handleSessionInitCompleteEvent(firstArg);
      return true;
    }
    if (eventName === "onKickedOffLine") {
      this.handleKickedOffLineEvent(firstArg);
      return true;
    }
    return false;
  }

  /**
   * @param {Record<string, any>} [options={}]
   */
  async tryAutoQuickLogin({ uin: explicitUin = "", force = false, webContents = null } = {}) {
    if (this.host.online && !force) {
      return { skipped: true, reason: "already_online", online: true };
    }
    const now = Date.now();
    if (!force) {
      if ((this.host._autoQuickLoginAttempts || 0) >= 3) {
        return { skipped: true, reason: "max_attempts_reached", online: Boolean(this.host.online) };
      }
      if (this.host._lastAutoQuickLoginAt && now - this.host._lastAutoQuickLoginAt < 12000) {
        return { skipped: true, reason: "cooldown", online: Boolean(this.host.online) };
      }
      this.host._lastAutoQuickLoginAt = now;
      this.host._autoQuickLoginAttempts = (this.host._autoQuickLoginAttempts || 0) + 1;
    }

    try {
      await this.host.invokeNt(
        "nodeIKernelLoginService/setAutoLogin",
        { shouldAutoLogin: true },
        [true]
      );
    } catch (err) {
      this.host.logger?.debug?.("login_recovery", err);
    }

    /** @type {any} */
    let loginRes = null;
    try {
      loginRes = await this.host.invokeNt("nodeIKernelLoginService/getLoginList", {}, []);
    } catch (err) {
      this.host.logger?.debug?.("login_recovery", err);
    }
    const list = Array.isArray(loginRes?.LocalLoginInfoList) ? loginRes.LocalLoginInfoList : [];
    const targetUin = String(explicitUin || this.host.selfUin || "").trim();
    const acc = selectQuickLoginAccount(list, targetUin);

    if (!acc || (!acc.isQuickLogin && !acc.isAutoLogin && !force)) {
      return {
        skipped: true,
        reason: acc ? "quick_login_unavailable" : "no_saved_account",
        accounts: list.map((/** @type {any} */ x) => ({
          uin: String(x?.uin || ""),
          isQuickLogin: Boolean(x?.isQuickLogin),
          isAutoLogin: Boolean(x?.isAutoLogin),
        })),
      };
    }

    const uin = String(acc.uin);
    if (typeof this.host._updateSelfIdentity === "function") {
      this.host._updateSelfIdentity({
        uin,
        uid: acc.uid || this.host.selfUid,
        nick: acc.nickName || acc.nick || this.host.selfNickname,
        markOnline: false,
      });
    } else {
      this.syncSelfIdentityFromLogin(
        {
          uin,
          uid: acc.uid || this.host.selfUid,
          nick: acc.nickName || acc.nick || this.host.selfNickname,
        },
        { markOnline: false }
      );
    }

    try {
      await this.host.invokeNt(
        "nodeIKernelSettingService/setAutoLoginSwitch",
        { state: true },
        [true]
      );
    } catch (err) {
      this.host.logger?.debug?.("login_recovery", err);
    }

    /** @type {any} */
    let quickRes = null;
    let methodUsed = "";
    for (const cmd of [
      "nodeIKernelLoginService/quickLoginWithUin",
      "nodeIKernelLoginService/quickLogin",
    ]) {
      try {
        quickRes = await this.host.invokeNt(cmd, { uin }, [uin]);
        const code = Number(quickRes?.result ?? quickRes?.resultCode ?? 0);
        if (!Number.isNaN(code) && code === 0) {
          methodUsed = cmd;
          break;
        }
      } catch (err) {
        this.host.logger?.debug?.("login_recovery", err);
      }
    }

    const wc = webContents || this.host.activeWebContents;
    const isAlive =
      typeof this.host._isWebContentsAlive === "function"
        ? this.host._isWebContentsAlive(wc)
        : Boolean(wc && (typeof wc.isDestroyed !== "function" || !wc.isDestroyed()));
    const isTrusted =
      !wc ||
      typeof wc.getURL !== "function" ||
      (typeof this.host._isTrustedRendererUrl === "function"
        ? this.host._isTrustedRendererUrl(wc.getURL())
        : true);

    if (
      !methodUsed &&
      wc &&
      isAlive &&
      typeof wc.executeJavaScript === "function" &&
      isTrusted
    ) {
      try {
        const clicked = await wc.executeJavaScript(
          `(function(){
            const btns = Array.from(document.querySelectorAll("button, .q-button, [role='button']"));
            const loginBtn = btns.find((el) => /^\\s*登\\s*录\\s*$/.test(String(el.textContent || "")));
            if (loginBtn) { loginBtn.click(); return true; }
            return false;
          })()`,
          true
        );
        if (clicked) methodUsed = "dom_button_click";
      } catch (err) {
        this.host.logger?.debug?.("login_recovery", err);
      }
    }

    return {
      triggered: Boolean(methodUsed),
      uin,
      method: methodUsed,
      result: quickRes || null,
      online: Boolean(this.host.online),
    };
  }
}

module.exports = {
  LoginRecovery,
  LOGIN_KERNEL_EVENTS,
  extractQrCodeBase64,
  isSessionInitSuccess,
  selectQuickLoginAccount,
  buildBotOfflineNoticePayload,
};
