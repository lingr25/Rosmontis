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
/** @typedef {import("../types").LoginErrorInfo} LoginErrorInfo */
/** @typedef {import("../types").LoginStateSnapshot} LoginStateSnapshot */

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
    "onQRCodeSessionFailed",
    "onQRCodeSessionQuickLoginFailed",
    "onLoginFailed",
    "onQuickLoginFailed",
    "onPasswordLoginFailed",
    "onLoginState",
    "onLoginDisConnected",
    "onLogoutSucceed",
    "onQQLoginNumLimited",
    "OnConfirmUnusualDeviceFailed",
    "onUserLoggedIn",
    "onQRCodeLoginSucceed",
    "onSessionInitComplete",
    "onKickedOffLine",
  ])
);

const LOGIN_ERROR_MESSAGE_KEYS = Object.freeze([
  "tipsTitle",
  "tipsContent",
  "tipsDesc",
  "errMsg",
  "errorMsg",
  "error_msg",
  "strErrMsg",
  "tips",
  "message",
  "msg",
  "desc",
]);

const LOGIN_ERROR_CODE_KEYS = Object.freeze([
  "serverErrorCode",
  "errCode",
  "errorCode",
  "error_code",
  "subRet",
  "retCode",
  "resultCode",
  "result",
  "code",
]);

const LOGIN_ERROR_NESTED_KEYS = Object.freeze([
  "loginErrorInfo",
  "errInfo",
  "errorInfo",
  "error",
  "result",
  "data",
  "info",
]);

const RELOGIN_PROMPT_PATTERN =
  /(?:重新登录|重新扫码|身份验证失败|安全提示|验证失败|登录已过期|登录过期|登录失败|登录异常|账号异常|请扫码|re-?login|verification\s+failed|authentication\s+failed)/i;

const MAX_LOGIN_ERROR_MESSAGE_LEN = 300;

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

/**
 * Extracts a user-facing QQ error code (e.g. `w21`, `k1`, `140022015`) from
 * a localized prompt or error message string.
 * @param {any} text
 * @returns {string}
 */
function extractQqErrorCodeFromText(text) {
  const s = String(text || "").trim();
  if (!s) return "";
  const parenMatch = s.match(/(?:\(|（)\s*([a-zA-Z]\d{1,6})\s*(?:\)|）)/);
  if (parenMatch && parenMatch[1]) {
    return parenMatch[1];
  }
  const labeledMatch = s.match(
    /(?:错误码|error\s*code|errcode)\s*[:：=]?\s*([a-zA-Z]?\d{1,12})/i
  );
  if (labeledMatch && labeledMatch[1]) {
    return labeledMatch[1];
  }
  return "";
}

/**
 * @param {any} rawCode
 * @returns {string}
 */
function normalizeNonZeroErrorCode(rawCode) {
  if (rawCode === undefined || rawCode === null || typeof rawCode === "boolean") return "";
  if (typeof rawCode === "number") {
    if (!Number.isFinite(rawCode) || rawCode === 0) return "";
    return String(rawCode);
  }
  if (typeof rawCode === "string") {
    const trimmed = rawCode.trim();
    if (!trimmed) return "";
    const lower = trimmed.toLowerCase();
    if (lower === "0" || lower === "ok" || lower === "success" || lower === "none") return "";
    return trimmed;
  }
  return "";
}

/**
 * @param {string[]} parts
 * @returns {string}
 */
function joinUniqueMessageParts(parts) {
  /** @type {string[]} */
  const unique = [];
  for (const raw of parts) {
    const cleaned = String(raw || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) continue;
    let covered = false;
    for (let i = 0; i < unique.length; i += 1) {
      if (unique[i].includes(cleaned)) {
        covered = true;
        break;
      }
      if (cleaned.includes(unique[i])) {
        unique[i] = cleaned;
        covered = true;
        break;
      }
    }
    if (!covered) {
      unique.push(cleaned);
    }
  }
  return unique.join(" - ").slice(0, MAX_LOGIN_ERROR_MESSAGE_LEN);
}

/**
 * Recursively extracts normalized `{ code, message, hasError }` from NTQQ
 * login kernel event payloads or `quickLogin*` RPC responses.
 * @param {any} payload
 * @param {string} [fallbackSource="login"]
 * @returns {{ source: string, code: string, message: string, hasError: boolean }}
 */
function extractLoginErrorInfo(payload, fallbackSource = "login") {
  /** @type {string[]} */
  const messages = [];
  let structuredCode = "";
  const seen = new Set();

  /**
   * @param {any} node
   * @param {number} depth
   */
  const visit = (node, depth) => {
    if (node === undefined || node === null || depth > 4) return;
    if (typeof node === "string") {
      const trimmed = node.trim();
      if (trimmed && !trimmed.startsWith("data:image/")) {
        messages.push(trimmed);
      }
      return;
    }
    if (node instanceof Error) {
      if (node.message) messages.push(node.message);
      return;
    }
    if (typeof node !== "object") return;
    if (
      (typeof Buffer !== "undefined" && Buffer.isBuffer(node)) ||
      node instanceof Uint8Array
    ) {
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);

    for (const key of LOGIN_ERROR_MESSAGE_KEYS) {
      const val = node[key];
      if (typeof val === "string" && val.trim() && !val.trim().startsWith("data:image/")) {
        messages.push(val.trim());
      }
    }
    if (!structuredCode) {
      for (const key of LOGIN_ERROR_CODE_KEYS) {
        const normalized = normalizeNonZeroErrorCode(node[key]);
        if (normalized) {
          structuredCode = normalized;
          break;
        }
      }
    }
    for (const nestedKey of LOGIN_ERROR_NESTED_KEYS) {
      const nested = node[nestedKey];
      if (nested && typeof nested === "object") {
        visit(nested, depth + 1);
      }
    }
  };

  visit(payload, 0);

  const message = joinUniqueMessageParts(messages);
  const textCode = extractQqErrorCodeFromText(message);
  const code = textCode || structuredCode;
  return {
    source: String(fallbackSource || "login"),
    code,
    message,
    hasError: Boolean(code || message),
  };
}

/**
 * Pure parser for visible text scraped from the QQ login window to detect
 * security / re-login prompts such as `身份验证失败，请你重新登录。(w21)`.
 * @param {any} rawText
 * @returns {{ code: string, message: string } | null}
 */
function extractPromptFromRendererText(rawText) {
  const normalized = String(rawText || "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!normalized) return null;

  const lines = normalized
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  /** @type {{ code: string, message: string } | null} */
  let fallbackMatch = null;
  for (const line of lines) {
    const code = extractQqErrorCodeFromText(line);
    if (code) {
      return {
        code,
        message: line.slice(0, MAX_LOGIN_ERROR_MESSAGE_LEN),
      };
    }
    if (!fallbackMatch && RELOGIN_PROMPT_PATTERN.test(line)) {
      fallbackMatch = {
        code: "",
        message: line.slice(0, MAX_LOGIN_ERROR_MESSAGE_LEN),
      };
    }
  }
  if (fallbackMatch) {
    return fallbackMatch;
  }

  const collapsed = lines.join(" ").trim();
  const code = extractQqErrorCodeFromText(collapsed);
  if (code || RELOGIN_PROMPT_PATTERN.test(collapsed)) {
    return {
      code,
      message: collapsed.slice(0, MAX_LOGIN_ERROR_MESSAGE_LEN),
    };
  }
  return null;
}

class LoginRecovery {
  /**
   * @param {LoginRecoveryHost} host
   */
  constructor(host) {
    /** @type {LoginRecoveryHost} */
    this.host = host;
    /** @type {boolean} */
    this._reloginRequired = false;
    /** @type {LoginErrorInfo | null} */
    this._loginError = null;
    /** @type {string} */
    this._lastWarnSignature = "";
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._promptCheckTimer = null;
  }

  /**
   * Clears any recorded login/re-login error state (called upon successful login).
   */
  clearLoginError() {
    this._reloginRequired = false;
    this._loginError = null;
    this._lastWarnSignature = "";
    if (this._promptCheckTimer) {
      clearTimeout(this._promptCheckTimer);
      this._promptCheckTimer = null;
    }
  }

  /**
   * Records a login failure or re-login requirement and emits a deduplicated WARN log.
   * Preserves a previously captured specific QQ error code (e.g. `w21`) if a later
   * generic fallback lacks a code.
   * @param {{ source?: string, reason?: string, code?: string, message?: string, reloginRequired?: boolean }} info
   * @returns {LoginErrorInfo}
   */
  recordLoginError(info) {
    const source = String(info?.source || "login").trim() || "login";
    const reason = String(info?.reason || "relogin_required").trim() || "relogin_required";
    const incomingCode = String(info?.code || "").trim();
    const incomingMessage = String(info?.message || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_LOGIN_ERROR_MESSAGE_LEN);
    const reloginRequired = info?.reloginRequired !== false;

    const prev = this._loginError;
    const keepPrevCode = !incomingCode && Boolean(prev?.code);
    const finalCode = incomingCode || (keepPrevCode ? String(prev?.code || "") : "");
    const finalMessage =
      incomingMessage || (keepPrevCode ? String(prev?.message || "") : String(prev?.message || ""));
    const finalSource = keepPrevCode && !incomingMessage && prev?.source ? prev.source : source;
    const finalReason = keepPrevCode && !incomingMessage && prev?.reason ? prev.reason : reason;

    /** @type {LoginErrorInfo} */
    const next = {
      source: finalSource,
      reason: finalReason,
      code: finalCode,
      message: finalMessage,
      at: Date.now(),
    };

    if (reloginRequired) {
      this._reloginRequired = true;
    }
    this._loginError = next;

    const warnSig = `${this._reloginRequired ? 1 : 0}|${next.reason}|${next.code}|${next.message}`;
    if (warnSig !== this._lastWarnSignature) {
      this._lastWarnSignature = warnSig;
      const codePart = next.code ? `, code=${next.code}` : "";
      const msgPart = next.message ? `: ${next.message}` : "";
      const actionHint = this._reloginRequired
        ? "QQ requires re-login (scan QR code or re-authenticate)"
        : "QQ login error detected";
      this.host.logger?.warn?.(
        `[login] ${actionHint} (source=${next.source}, reason=${next.reason}${codePart})${msgPart}`
      );
    }

    return next;
  }

  /**
   * Returns a normalized snapshot of the current login / re-login state.
   * @returns {LoginStateSnapshot}
   */
  getLoginState() {
    if (this.host.online) {
      return {
        state: "online",
        relogin_required: false,
      };
    }
    const err = this._loginError;
    if (this._reloginRequired) {
      return {
        state: "relogin_required",
        relogin_required: true,
        reason: err?.reason || "relogin_required",
        ...(err?.code ? { error_code: err.code } : {}),
        ...(err?.message ? { error_message: err.message } : {}),
        ...(err?.source ? { source: err.source } : {}),
        ...(err?.at ? { updated_at: err.at } : {}),
      };
    }
    return {
      state: "offline",
      relogin_required: false,
      ...(err?.reason ? { reason: err.reason } : {}),
      ...(err?.code ? { error_code: err.code } : {}),
      ...(err?.message ? { error_message: err.message } : {}),
      ...(err?.source ? { source: err.source } : {}),
      ...(err?.at ? { updated_at: err.at } : {}),
    };
  }

  /**
   * @param {any} rawIdentity
   * @param {{ markOnline?: boolean }} [options={}]
   * @returns {NormalizedLoginIdentity}
   */
  syncSelfIdentityFromLogin(rawIdentity, { markOnline = true } = {}) {
    const identity = normalizeLoginIdentity(rawIdentity);
    if (markOnline) {
      this.clearLoginError();
    }
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
    this.clearLoginError();
    this.syncSelfIdentityFromLogin(firstArg, { markOnline: true });
  }

  /**
   * @param {any} firstArg
   */
  handleSessionInitCompleteEvent(firstArg) {
    if (isSessionInitSuccess(firstArg)) {
      this.host.online = true;
      this.clearLoginError();
    } else {
      const parsed = extractLoginErrorInfo(firstArg, "onSessionInitComplete");
      if (parsed.hasError) {
        this.recordLoginError({
          source: "onSessionInitComplete",
          reason: "session_init_failed",
          code: parsed.code,
          message: parsed.message,
          reloginRequired: true,
        });
      }
    }
  }

  /**
   * @param {any} firstArg
   */
  handleKickedOffLineEvent(firstArg) {
    this.host.online = false;
    this.host.lastQrCodeBase64 = "";
    this.host._resetHumanSessionState?.({ resetRenderer: true });
    const parsed = extractLoginErrorInfo(firstArg, "onKickedOffLine");
    this.recordLoginError({
      source: "onKickedOffLine",
      reason: "kicked_offline",
      code: parsed.code,
      message: parsed.message || String(firstArg?.tipsDesc || firstArg?.tipsTitle || "QQ kicked offline"),
      reloginRequired: true,
    });
    this.host._dispatchInboundEvent?.(
      formatNoticeEvent(
        "bot_offline",
        buildBotOfflineNoticePayload(this.host.selfUin, firstArg),
        { selfId: this.host.selfUin }
      )
    );
  }

  /**
   * Handles explicit login failure / disconnect / logout kernel events.
   * @param {string} eventName
   * @param {any[]} args
   */
  handleLoginFailureEvent(eventName, args) {
    const payload = args && args.length > 1 ? { primary: args[0], extra: args.slice(1) } : args?.[0];
    const parsed = extractLoginErrorInfo(payload, eventName);

    if (eventName === "onLoginState") {
      if (!parsed.hasError) return;
      this.host.online = false;
      this.recordLoginError({
        source: eventName,
        reason: "relogin_required",
        code: parsed.code,
        message: parsed.message,
        reloginRequired: true,
      });
      return;
    }

    if (eventName === "onLoginDisConnected") {
      this.host.online = false;
      if (parsed.hasError) {
        this.recordLoginError({
          source: eventName,
          reason: "login_disconnected",
          code: parsed.code,
          message: parsed.message,
          reloginRequired: true,
        });
      }
      return;
    }

    if (eventName === "onQRCodeSessionFailed") {
      if (!this.host.online) {
        this.recordLoginError({
          source: eventName,
          reason: "qr_session_failed",
          code: parsed.code,
          message: parsed.message || "QR login session failed",
          reloginRequired: true,
        });
      }
      return;
    }

    if (eventName === "onLogoutSucceed") {
      this.host.online = false;
      this.host.lastQrCodeBase64 = "";
      this.host._resetHumanSessionState?.({ resetRenderer: true });
      this.recordLoginError({
        source: eventName,
        reason: "logged_out",
        code: parsed.code,
        message: parsed.message || "QQ account logged out",
        reloginRequired: true,
      });
      return;
    }

    this.host.online = false;
    const reason =
      eventName === "onQRCodeSessionQuickLoginFailed" || eventName === "onQuickLoginFailed"
        ? "quick_login_failed"
        : eventName === "OnConfirmUnusualDeviceFailed"
          ? "unusual_device_verify_failed"
          : eventName === "onQQLoginNumLimited"
            ? "login_num_limited"
            : "relogin_required";

    this.recordLoginError({
      source: eventName,
      reason,
      code: parsed.code,
      message: parsed.message || `QQ login failed (${eventName})`,
      reloginRequired: true,
    });
  }

  /**
   * @param {string} eventName
   * @param {any[]} args
   * @returns {boolean}
   */
  handleLoginKernelEvent(eventName, args) {
    const firstArg = args && args.length > 0 ? args[0] : undefined;
    if (eventName === "onQRCodeGetPicture") {
      this.handleQrCodeEvent(firstArg);
      return true;
    }
    if (eventName === "onQRCodeSessionQuickLoginFailed") {
      this.handleQrCodeEvent(firstArg);
      this.handleLoginFailureEvent(eventName, args);
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
    if (
      eventName === "onLoginFailed" ||
      eventName === "onQuickLoginFailed" ||
      eventName === "onPasswordLoginFailed" ||
      eventName === "onQRCodeSessionFailed" ||
      eventName === "onLoginState" ||
      eventName === "onLoginDisConnected" ||
      eventName === "onLogoutSucceed" ||
      eventName === "onQQLoginNumLimited" ||
      eventName === "OnConfirmUnusualDeviceFailed"
    ) {
      this.handleLoginFailureEvent(eventName, args);
      return true;
    }
    return false;
  }

  /**
   * Read-only inspection of the trusted QQ login renderer window for visible
   * security / re-login dialogs (e.g. `身份验证失败，请你重新登录。(w21)`).
   * @param {any} [webContents]
   * @returns {Promise<{ code: string, message: string } | null>}
   */
  async inspectRendererLoginPrompt(webContents = null) {
    if (this.host.online) return null;
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
    if (!wc || !isAlive || !isTrusted || typeof wc.executeJavaScript !== "function") {
      return null;
    }
    try {
      const rawPromptText = await wc.executeJavaScript(
        `(function(){
          try {
            var selectors = [
              ".q-dialog", ".q-modal", "[role='dialog']", "[role='alert']",
              ".error-tips", ".login-error", ".toast", ".q-message", ".tips"
            ];
            var out = [];
            for (var i = 0; i < selectors.length; i++) {
              var nodes = document.querySelectorAll(selectors[i]);
              for (var j = 0; j < nodes.length; j++) {
                var el = nodes[j];
                if (!el) continue;
                var txt = String(el.innerText || el.textContent || "").trim();
                if (txt) out.push(txt);
              }
            }
            if (out.length > 0) return out.join("\\n").slice(0, 2000);
            var bodyTxt = String((document.body && document.body.innerText) || "").trim();
            return bodyTxt.slice(0, 2000);
          } catch (_e) {
            return "";
          }
        })()`,
        true
      );
      const hit = extractPromptFromRendererText(rawPromptText);
      if (hit && !this.host.online) {
        this.recordLoginError({
          source: "renderer_prompt",
          reason: "relogin_required",
          code: hit.code,
          message: hit.message,
          reloginRequired: true,
        });
        return hit;
      }
    } catch (err) {
      this.host.logger?.debug?.("login_recovery", err);
    }
    return null;
  }

  /**
   * Schedules a single unref'd delayed check for login-page security dialogs
   * (e.g. `w21` popping up a few seconds after quick-login starts).
   * @param {any} [webContents]
   * @param {number} [delayMs=3000]
   */
  scheduleRendererPromptCheck(webContents = null, delayMs = 3000) {
    if (this.host.online) return;
    if (this._promptCheckTimer) {
      clearTimeout(this._promptCheckTimer);
      this._promptCheckTimer = null;
    }
    const timer = setTimeout(() => {
      this._promptCheckTimer = null;
      if (this.host.online) return;
      this.inspectRendererLoginPrompt(webContents).catch((err) =>
        this.host.logger?.debug?.("login_recovery", err)
      );
    }, delayMs);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
    this._promptCheckTimer = timer;
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
    const wc = webContents || this.host.activeWebContents;

    if (!acc || (!acc.isQuickLogin && !acc.isAutoLogin && !force)) {
      const skipReason = acc ? "quick_login_unavailable" : "no_saved_account";
      const promptHit = await this.inspectRendererLoginPrompt(wc);
      if (!promptHit) {
        this.recordLoginError({
          source: "login_list",
          reason: skipReason,
          message:
            skipReason === "quick_login_unavailable"
              ? "Saved QQ account cannot use quick/auto login; please re-login via QR code"
              : "No saved QQ login credential available; please login via QR code",
          reloginRequired: true,
        });
      }
      return {
        skipped: true,
        reason: skipReason,
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
    /** @type {any} */
    let lastFailureRes = null;
    /** @type {any} */
    let lastFailureErr = null;
    let methodUsed = "";
    for (const cmd of [
      "nodeIKernelLoginService/quickLoginWithUin",
      "nodeIKernelLoginService/quickLogin",
    ]) {
      try {
        quickRes = await this.host.invokeNt(cmd, { uin }, [uin]);
        const code = Number(quickRes?.result ?? quickRes?.resultCode ?? 0);
        const parsedErr = extractLoginErrorInfo(quickRes, cmd);
        if (!Number.isNaN(code) && code === 0 && !parsedErr.hasError) {
          methodUsed = cmd;
          break;
        }
        lastFailureRes = quickRes;
      } catch (err) {
        lastFailureErr = err;
        this.host.logger?.debug?.("login_recovery", err);
      }
    }

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

    if (!methodUsed && !this.host.online) {
      const parsedFailure = extractLoginErrorInfo(
        lastFailureRes || lastFailureErr,
        "quick_login"
      );
      if (parsedFailure.hasError) {
        this.recordLoginError({
          source: "quick_login",
          reason: "quick_login_failed",
          code: parsedFailure.code,
          message: parsedFailure.message,
          reloginRequired: true,
        });
      }
      await this.inspectRendererLoginPrompt(wc);
    } else if (!this.host.online) {
      this.scheduleRendererPromptCheck(wc, 3000);
    }

    return {
      triggered: Boolean(methodUsed),
      uin,
      method: methodUsed,
      result: quickRes || null,
      online: Boolean(this.host.online),
      login_state: this.getLoginState(),
    };
  }
}

module.exports = {
  LoginRecovery,
  LOGIN_KERNEL_EVENTS,
  extractQrCodeBase64,
  extractQqErrorCodeFromText,
  extractLoginErrorInfo,
  extractPromptFromRendererText,
  isSessionInitSuccess,
  selectQuickLoginAccount,
  buildBotOfflineNoticePayload,
};
