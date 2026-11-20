"use strict";

/**
 * Login State, QR Code & Auto-Quick-Login Recovery Subsystem (`src/core/login_recovery.js`)
 *
 * Extracted from `src/core/inbound_pipeline.js`:
 * - Login / QR / session-init / kicked-offline kernel event handlers
 * - Self-identity synchronization helpers (`_syncSelfIdentityFromLogin`)
 * - Saved-account selection & auto-quick-login recovery (`_tryAutoQuickLogin`)
 */

const { formatNoticeEvent } = require("../bridge_onebot");
const { pickPositiveUin, normalizeLoginIdentity } = require("./nt_normalizer");

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

function isSessionInitSuccess(payload) {
  const code =
    payload && typeof payload === "object"
      ? Number(payload.result ?? 0)
      : Number(payload ?? 0);
  return !Number.isFinite(code) || code === 0;
}

function selectQuickLoginAccount(list, preferredUin = "") {
  if (!Array.isArray(list) || list.length === 0) return null;
  const targetUin = String(preferredUin || "").trim();
  return (
    (targetUin && list.find((item) => item && String(item.uin) === targetUin)) ||
    list.find((item) => item && (item.isQuickLogin || item.isAutoLogin) && item.uin) ||
    null
  );
}

function buildBotOfflineNoticePayload(selfUin, firstArg) {
  return {
    user_id: pickPositiveUin(selfUin),
    tag: String(firstArg?.tipsTitle || "kicked_offline"),
    message: String(firstArg?.tipsDesc || "QQ offline"),
  };
}

const loginRecoveryMixin = {
  _syncSelfIdentityFromLogin(rawIdentity, { markOnline = true } = {}) {
    const identity = normalizeLoginIdentity(rawIdentity);
    if (typeof this._updateSelfIdentity === "function") {
      this._updateSelfIdentity({
        ...identity,
        markOnline: Boolean(markOnline),
      });
      return identity;
    }
    if (identity.uin && /^\d+$/.test(String(identity.uin))) {
      this.selfUin = String(identity.uin);
    }
    if (identity.uid) {
      this.selfUid = String(identity.uid);
    }
    if (identity.nick) {
      this.selfNickname = String(identity.nick);
    }
    if (markOnline) {
      this.online = true;
    }
    return identity;
  },

  _handleQrCodeEvent(firstArg) {
    const pngBase64 = extractQrCodeBase64(firstArg);
    if (pngBase64) {
      this.lastQrCodeBase64 = pngBase64;
      if (this._qrCodeWaiters && this._qrCodeWaiters.size > 0) {
        for (const resolveWaiter of Array.from(this._qrCodeWaiters)) {
          try {
            resolveWaiter(pngBase64);
          } catch (_) {}
        }
        this._qrCodeWaiters.clear();
      }
      this.logger?.debug?.("login", `QR code updated (length=${pngBase64.length})`);
    } else {
      const argShape =
        firstArg && typeof firstArg === "object"
          ? Object.keys(firstArg).slice(0, 16).join(",")
          : typeof firstArg;
      const nestedInfo = firstArg?.qrcodeInfo || firstArg?.qrCodeInfo || firstArg?.result || firstArg?.data;
      const nestedShape =
        nestedInfo && typeof nestedInfo === "object"
          ? Object.keys(nestedInfo).slice(0, 16).join(",")
          : "";
      this.logger?.debug?.(
        "login",
        `QR event without base64 payload (shape=${argShape}${nestedShape ? `, nested=${nestedShape}` : ""})`
      );
    }
  },

  _handleUserLoggedInEvent(firstArg) {
    this._syncSelfIdentityFromLogin(firstArg, { markOnline: true });
  },

  _handleSessionInitCompleteEvent(firstArg) {
    if (isSessionInitSuccess(firstArg)) {
      this.online = true;
    }
  },

  _handleKickedOffLineEvent(firstArg) {
    this.online = false;
    this._resetHumanSessionState?.({ resetRenderer: true });
    this._dispatchInboundEvent?.(
      formatNoticeEvent(
        "bot_offline",
        buildBotOfflineNoticePayload(this.selfUin, firstArg),
        { selfId: this.selfUin }
      )
    );
  },

  _handleLoginKernelEvent(eventName, args) {
    const firstArg = args && args.length > 0 ? args[0] : undefined;
    if (eventName === "onQRCodeGetPicture" || eventName === "onQRCodeSessionQuickLoginFailed") {
      this._handleQrCodeEvent(firstArg);
      return true;
    }
    if (eventName === "onUserLoggedIn" || eventName === "onQRCodeLoginSucceed") {
      this._handleUserLoggedInEvent(firstArg);
      return true;
    }
    if (eventName === "onSessionInitComplete") {
      this._handleSessionInitCompleteEvent(firstArg);
      return true;
    }
    if (eventName === "onKickedOffLine") {
      this._handleKickedOffLineEvent(firstArg);
      return true;
    }
    return false;
  },

  async _tryAutoQuickLogin({ uin: explicitUin = "", force = false, webContents = null } = {}) {
    if (this.online && !force) {
      return { skipped: true, reason: "already_online", online: true };
    }
    const now = Date.now();
    if (!force) {
      if ((this._autoQuickLoginAttempts || 0) >= 3) {
        return { skipped: true, reason: "max_attempts_reached", online: Boolean(this.online) };
      }
      if (this._lastAutoQuickLoginAt && now - this._lastAutoQuickLoginAt < 12000) {
        return { skipped: true, reason: "cooldown", online: Boolean(this.online) };
      }
      this._lastAutoQuickLoginAt = now;
      this._autoQuickLoginAttempts = (this._autoQuickLoginAttempts || 0) + 1;
    }

    try {
      await this.invokeNt("nodeIKernelLoginService/setAutoLogin", { shouldAutoLogin: true }, [true]);
    } catch (_) {}

    let loginRes = null;
    try {
      loginRes = await this.invokeNt("nodeIKernelLoginService/getLoginList", {}, []);
    } catch (_) {}
    const list = Array.isArray(loginRes?.LocalLoginInfoList) ? loginRes.LocalLoginInfoList : [];
    const targetUin = String(explicitUin || this.selfUin || "").trim();
    const acc = selectQuickLoginAccount(list, targetUin);

    if (!acc || (!acc.isQuickLogin && !acc.isAutoLogin && !force)) {
      return {
        skipped: true,
        reason: acc ? "quick_login_unavailable" : "no_saved_account",
        accounts: list.map((x) => ({
          uin: String(x?.uin || ""),
          isQuickLogin: Boolean(x?.isQuickLogin),
          isAutoLogin: Boolean(x?.isAutoLogin),
        })),
      };
    }

    const uin = String(acc.uin);
    if (typeof this._updateSelfIdentity === "function") {
      this._updateSelfIdentity({
        uin,
        uid: acc.uid || this.selfUid,
        nick: acc.nickName || acc.nick || this.selfNickname,
        markOnline: false,
      });
    } else {
      this._syncSelfIdentityFromLogin(
        { uin, uid: acc.uid || this.selfUid, nick: acc.nickName || acc.nick || this.selfNickname },
        { markOnline: false }
      );
    }

    try {
      await this.invokeNt("nodeIKernelSettingService/setAutoLoginSwitch", { state: true }, [true]);
    } catch (_) {}

    let quickRes = null;
    let methodUsed = "";
    for (const cmd of [
      "nodeIKernelLoginService/quickLoginWithUin",
      "nodeIKernelLoginService/quickLogin",
    ]) {
      try {
        quickRes = await this.invokeNt(cmd, { uin }, [uin]);
        const code = Number(quickRes?.result ?? quickRes?.resultCode ?? 0);
        if (!Number.isNaN(code) && code === 0) {
          methodUsed = cmd;
          break;
        }
      } catch (_) {}
    }

    const wc = webContents || this.activeWebContents;
    const isAlive =
      typeof this._isWebContentsAlive === "function"
        ? this._isWebContentsAlive(wc)
        : Boolean(wc && (typeof wc.isDestroyed !== "function" || !wc.isDestroyed()));
    const isTrusted =
      !wc ||
      typeof wc.getURL !== "function" ||
      (typeof this._isTrustedRendererUrl === "function"
        ? this._isTrustedRendererUrl(wc.getURL())
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
      } catch (_) {}
    }

    return {
      triggered: Boolean(methodUsed),
      uin,
      method: methodUsed,
      result: quickRes || null,
      online: Boolean(this.online),
    };
  },
};

module.exports = {
  loginRecoveryMixin,
  LOGIN_KERNEL_EVENTS,
  extractQrCodeBase64,
  isSessionInitSuccess,
  selectQuickLoginAccount,
  buildBotOfflineNoticePayload,
};
