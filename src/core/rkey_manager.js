// @ts-check
"use strict";

/**
 * NTv2 RichMedia Download RKey Manager (`src/core/rkey_manager.js`)
 *
 * Acquires account-wide CDN download `rkey` tokens via NTQQ's built-in SSO channel
 * (`OidbSvcTrpcTcp.0x9067_202` / `FetchDownloadRkeys`) and downloads cross-session
 * or merged-forward (`inVisit`) NTv2 media (`multimedia.nt.qq.com.cn/download`)
 * over HTTPS when `downloadRichMediaInVisit` / `downloadRichMedia` fails with
 * server `-6101` (`fileErrCode=2006021`).
 *
 * Binary / UTF-8 Transport Notes (`NodeIKernelMsgService::sendSsoCmdReqByContend`):
 * - Request `param` passes through `napi_get_value_string_utf8`, so raw protobuf bytes
 *   must be valid UTF-8 to avoid V8 `U+FFFD` replacement. Overlong varints with trailing
 *   `0x00` (`36967` -> `e7 a0 82 00`, `202` -> `ca 81 00`) and 1-byte unknown field 15
 *   guards (`7a 01 c2`) make the 49-byte `0x9067_202` packet 100% lossless UTF-8.
 * - Response `rsp` passes through `napi_create_string_utf8`. Pure ASCII `rkey` strings,
 *   single-byte tags (`< 0x80`), and varint terminating bytes (`< 0x80`) are invariant
 *   under UTF-8 replacement, enabling exact `(rkey, type)` extraction even when timestamp
 *   varints expand with `U+FFFD`.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { resolveTempDirFromEnv } = require("./env");
const { extractNtRichMediaAppId } = require("./nt_normalizer");
const {
  downloadMediaStreamToTempDir,
  pruneTempDirAsync,
  resolveMaxMediaBytes,
} = require("./media_security");

const SSO_CMD_FETCH_RKEYS = "OidbSvcTrpcTcp.0x9067_202";

const PRIVATE_IMAGE_RKEY_TYPE = 10;
const GROUP_IMAGE_RKEY_TYPE = 20;
const PRIVATE_VIDEO_RKEY_TYPE = 12;
const GROUP_VIDEO_RKEY_TYPE = 22;
const PRIVATE_PTT_RKEY_TYPE = 14;
const GROUP_PTT_RKEY_TYPE = 24;
const FALLBACK_IMAGE_RKEY_TYPE = 2;

const DEFAULT_RKEY_TTL_SEC = 1800;
const RKEY_EXPIRY_SKEW_SEC = 60;
const RKEY_FAIL_COOLDOWN_MS = 5000;
const RKEY_MIN_FORCE_INTERVAL_MS = 800;
const DEFAULT_SSO_TIMEOUT_MS = 5000;

// Verified 100% lossless UTF-8 `OidbBase<NTV2RichMediaReq>` payloads for `0x9067_202`
const OIDB_0X9067_202_SCENE_HEX =
  "08e7a0820010ca810022240a1a0a06080110ca8100120c7a01c2a806027a01c2b006011a0208022206080a081408026001";
const OIDB_0X9067_202_MINIMAL_HEX =
  "08e7a0820010ca810022160a0c0a06080110ca81001a0208022206080a081408026001";

/**
 * @param {{ includeScene?: boolean }} [options]
 * @returns {Buffer}
 */
function buildFetchDownloadRkeysRequestBuffer(options = {}) {
  const includeScene = options?.includeScene !== false;
  return Buffer.from(
    includeScene ? OIDB_0X9067_202_SCENE_HEX : OIDB_0X9067_202_MINIMAL_HEX,
    "hex"
  );
}

/**
 * @param {{ includeScene?: boolean }} [options]
 * @returns {string}
 */
function buildFetchDownloadRkeysUtf8Payload(options = {}) {
  return buildFetchDownloadRkeysRequestBuffer(options).toString("utf8");
}

/**
 * @param {any} rawRKey
 * @returns {string}
 */
function stripRKeyPrefix(rawRKey) {
  let s = String(rawRKey || "").trim();
  if (!s) return "";
  if (s.startsWith("&rkey=") || s.startsWith("?rkey=")) {
    s = s.slice(6);
  } else if (/^rkey=/i.test(s)) {
    s = s.slice(5);
  }
  return s.trim();
}

/**
 * @param {any} rawRKey
 * @returns {string}
 */
function formatRKeyWithPrefix(rawRKey) {
  const clean = stripRKeyPrefix(rawRKey);
  return clean ? `&rkey=${clean}` : "";
}

/**
 * @param {any} rawUrl
 * @returns {string}
 */
function normalizeNtMultimediaUrl(rawUrl) {
  const s = String(rawUrl || "").trim();
  if (!s) return "";
  if (s.startsWith("/download")) {
    return `https://multimedia.nt.qq.com.cn${s}`;
  }
  if (s.startsWith("//multimedia.nt.qq.com.cn/")) {
    return `https:${s}`;
  }
  if (/^https?:\/\//i.test(s)) {
    return s;
  }
  return "";
}

/**
 * @param {any} rawUrl
 * @returns {boolean}
 */
function urlNeedsRKey(rawUrl) {
  const s = String(rawUrl || "").trim();
  if (!s) return false;
  if (/[?&]rkey=[^&\s]+/i.test(s)) return false;
  if (s.includes("gchat.qpic.cn")) return false;
  if (s.startsWith("/download")) return true;
  if (/^https?:\/\/[^/]*\.nt\.qq\.com(?:\.cn)?\/download\b/i.test(s)) return true;
  return /^https?:\/\/[^/]+\/download\?(?=[^#]*\bappid=(?:1402|1403|1406|1407|1413|1415)\b)/i.test(
    s
  );
}

/**
 * @param {any} rawUrl
 * @returns {boolean}
 */
function isNtMultimediaDownloadUrl(rawUrl) {
  const s = String(rawUrl || "").trim();
  if (!s) return false;
  if (s.startsWith("/download")) return true;
  if (/^https?:\/\/[^/]*\.nt\.qq\.com(?:\.cn)?\/download\b/i.test(s)) return true;
  return /^https?:\/\/[^/]+\/download\?(?=[^#]*\bappid=(?:1402|1403|1406|1407|1413|1415)\b)/i.test(
    s
  );
}

/**
 * @param {any} rawUrl
 * @param {{ appId?: number, mediaKind?: string, isGroup?: boolean }} [options]
 * @returns {number}
 */
function inferRKeyTypeFromUrlOrContext(rawUrl, options = {}) {
  const explicitAppId = Number(options?.appId || 0);
  const urlAppId = extractNtRichMediaAppId(String(rawUrl || ""));
  const appId = explicitAppId || urlAppId;
  if (appId === 1406) return PRIVATE_IMAGE_RKEY_TYPE;
  if (appId === 1407) return GROUP_IMAGE_RKEY_TYPE;
  if (appId === 1413) return PRIVATE_VIDEO_RKEY_TYPE;
  if (appId === 1415) return GROUP_VIDEO_RKEY_TYPE;
  if (appId === 1402) return PRIVATE_PTT_RKEY_TYPE;
  if (appId === 1403) return GROUP_PTT_RKEY_TYPE;

  const mediaKind = String(options?.mediaKind || "image").toLowerCase();
  const isGroup = Boolean(options?.isGroup);
  if (mediaKind === "video") {
    return isGroup ? GROUP_VIDEO_RKEY_TYPE : PRIVATE_VIDEO_RKEY_TYPE;
  }
  if (mediaKind === "record" || mediaKind === "ptt") {
    return isGroup ? GROUP_PTT_RKEY_TYPE : PRIVATE_PTT_RKEY_TYPE;
  }
  return isGroup ? GROUP_IMAGE_RKEY_TYPE : PRIVATE_IMAGE_RKEY_TYPE;
}

/**
 * @param {any} rawUrl
 * @param {any} rawRKey
 * @returns {string}
 */
function appendRKeyToUrl(rawUrl, rawRKey) {
  const fullUrl = normalizeNtMultimediaUrl(rawUrl);
  const cleanRKey = stripRKeyPrefix(rawRKey);
  if (!fullUrl || !cleanRKey) return fullUrl;
  const cleanedBase = fullUrl
    .replace(/([?&])rkey=[^&]*(&?)/gi, (_m, lead, tail) => {
      if (lead === "?" && tail === "&") return "?";
      if (lead === "&" && tail === "&") return "&";
      return "";
    })
    .replace(/[?&]$/, "");
  const encodedRKey = /%[0-9A-Fa-f]{2}/.test(cleanRKey)
    ? cleanRKey
    : encodeURIComponent(cleanRKey);
  return `${cleanedBase}${cleanedBase.includes("?") ? "&" : "?"}rkey=${encodedRKey}`;
}

/**
 * @param {Buffer} buf
 * @param {number} [start=0]
 * @param {number} [end=buf.length]
 * @returns {boolean}
 */
function _bufferHasUtf8Replacement(buf, start = 0, end = buf.length) {
  for (let i = start; i + 2 < end; i++) {
    if (buf[i] === 0xef && buf[i + 1] === 0xbf && buf[i + 2] === 0xbd) {
      return true;
    }
  }
  return false;
}

/**
 * @param {Buffer} buf
 * @param {number} offset
 * @param {number} [limit=buf.length]
 * @returns {{ value: number, next: number } | null}
 */
function _readExactVarint(buf, offset, limit = buf.length) {
  let value = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < limit && shift <= 63n) {
    const b = buf[pos++];
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return { value: Number(value), next: pos };
    }
    shift += 7n;
  }
  return null;
}

/**
 * @param {Buffer} buf
 * @param {number} offset
 * @param {number} wireType
 * @param {number} limit
 * @returns {number}
 */
function _skipWireFieldExact(buf, offset, wireType, limit) {
  if (wireType === 0) {
    const v = _readExactVarint(buf, offset, limit);
    return v ? v.next : -1;
  }
  if (wireType === 1) {
    return offset + 8 <= limit ? offset + 8 : -1;
  }
  if (wireType === 2) {
    const lenVar = _readExactVarint(buf, offset, limit);
    if (!lenVar || lenVar.value < 0 || lenVar.next + lenVar.value > limit) return -1;
    return lenVar.next + lenVar.value;
  }
  if (wireType === 5) {
    return offset + 4 <= limit ? offset + 4 : -1;
  }
  return -1;
}

/**
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end
 * @returns {{ rkey: string, ttlSeconds: number, storeId: number, createTime: number, type: number } | null}
 */
function _decodeNtv2RKeyInfoExact(buf, start, end) {
  let pos = start;
  let rkey = "";
  let ttlSeconds = 0;
  let storeId = 0;
  let createTime = 0;
  let type = 0;

  while (pos < end) {
    const tagVar = _readExactVarint(buf, pos, end);
    if (!tagVar) return null;
    pos = tagVar.next;
    const fieldNo = tagVar.value >>> 3;
    const wireType = tagVar.value & 7;
    if (fieldNo === 1 && wireType === 2) {
      const lenVar = _readExactVarint(buf, pos, end);
      if (!lenVar || lenVar.next + lenVar.value > end) return null;
      rkey = buf.subarray(lenVar.next, lenVar.next + lenVar.value).toString("utf8");
      pos = lenVar.next + lenVar.value;
    } else if (fieldNo === 2 && wireType === 0) {
      const v = _readExactVarint(buf, pos, end);
      if (!v) return null;
      ttlSeconds = v.value;
      pos = v.next;
    } else if (fieldNo === 3 && wireType === 0) {
      const v = _readExactVarint(buf, pos, end);
      if (!v) return null;
      storeId = v.value;
      pos = v.next;
    } else if (fieldNo === 4 && wireType === 0) {
      const v = _readExactVarint(buf, pos, end);
      if (!v) return null;
      createTime = v.value;
      pos = v.next;
    } else if (fieldNo === 5 && wireType === 0) {
      const v = _readExactVarint(buf, pos, end);
      if (!v) return null;
      type = v.value;
      pos = v.next;
    } else {
      const skipped = _skipWireFieldExact(buf, pos, wireType, end);
      if (skipped < 0) return null;
      pos = skipped;
    }
  }
  if (!rkey || !type) return null;
  return { rkey, ttlSeconds, storeId, createTime, type };
}

/**
 * @param {Buffer} buf
 * @returns {{ ok: boolean, result: number, errMsg: string, rkeys: Array<{ rkey: string, ttlSeconds: number, storeId: number, createTime: number, type: number }> } | null}
 */
function _tryExactProtobufDecode(buf) {
  if (!buf || buf.length === 0 || _bufferHasUtf8Replacement(buf)) {
    return null;
  }
  let pos = 0;
  let oidbErrCode = 0;
  let oidbErrMsg = "";
  /** @type {Buffer | null} */
  let bodySlice = null;

  while (pos < buf.length) {
    const tagVar = _readExactVarint(buf, pos, buf.length);
    if (!tagVar) return null;
    pos = tagVar.next;
    const fieldNo = tagVar.value >>> 3;
    const wireType = tagVar.value & 7;
    if (fieldNo === 3 && wireType === 0) {
      const v = _readExactVarint(buf, pos, buf.length);
      if (!v) return null;
      oidbErrCode = v.value;
      pos = v.next;
    } else if (fieldNo === 4 && wireType === 2) {
      const lenVar = _readExactVarint(buf, pos, buf.length);
      if (!lenVar || lenVar.next + lenVar.value > buf.length) return null;
      bodySlice = buf.subarray(lenVar.next, lenVar.next + lenVar.value);
      pos = lenVar.next + lenVar.value;
    } else if (fieldNo === 5 && wireType === 2) {
      const lenVar = _readExactVarint(buf, pos, buf.length);
      if (!lenVar || lenVar.next + lenVar.value > buf.length) return null;
      oidbErrMsg = buf.subarray(lenVar.next, lenVar.next + lenVar.value).toString("utf8");
      pos = lenVar.next + lenVar.value;
    } else {
      const skipped = _skipWireFieldExact(buf, pos, wireType, buf.length);
      if (skipped < 0) return null;
      pos = skipped;
    }
  }

  if (oidbErrCode !== 0) {
    return { ok: false, result: oidbErrCode, errMsg: oidbErrMsg, rkeys: [] };
  }
  if (!bodySlice || bodySlice.length === 0) {
    return null;
  }

  let bPos = 0;
  /** @type {Array<{ rkey: string, ttlSeconds: number, storeId: number, createTime: number, type: number }>} */
  const rkeys = [];
  while (bPos < bodySlice.length) {
    const tagVar = _readExactVarint(bodySlice, bPos, bodySlice.length);
    if (!tagVar) return null;
    bPos = tagVar.next;
    const fieldNo = tagVar.value >>> 3;
    const wireType = tagVar.value & 7;
    if (fieldNo === 4 && wireType === 2) {
      const lenVar = _readExactVarint(bodySlice, bPos, bodySlice.length);
      if (!lenVar || lenVar.next + lenVar.value > bodySlice.length) return null;
      const dlEnd = lenVar.next + lenVar.value;
      let dPos = lenVar.next;
      while (dPos < dlEnd) {
        const dTag = _readExactVarint(bodySlice, dPos, dlEnd);
        if (!dTag) return null;
        dPos = dTag.next;
        const dField = dTag.value >>> 3;
        const dWire = dTag.value & 7;
        if (dField === 1 && dWire === 2) {
          const itemLen = _readExactVarint(bodySlice, dPos, dlEnd);
          if (!itemLen || itemLen.next + itemLen.value > dlEnd) return null;
          const info = _decodeNtv2RKeyInfoExact(
            bodySlice,
            itemLen.next,
            itemLen.next + itemLen.value
          );
          if (info) rkeys.push(info);
          dPos = itemLen.next + itemLen.value;
        } else {
          const sk = _skipWireFieldExact(bodySlice, dPos, dWire, dlEnd);
          if (sk < 0) return null;
          dPos = sk;
        }
      }
      bPos = dlEnd;
    } else {
      const sk = _skipWireFieldExact(bodySlice, bPos, wireType, bodySlice.length);
      if (sk < 0) return null;
      bPos = sk;
    }
  }
  return { ok: rkeys.length > 0, result: 0, errMsg: "", rkeys };
}

/**
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end
 * @returns {boolean}
 */
function _isLikelyAsciiRKeyBytes(buf, start, end) {
  const len = end - start;
  if (len < 10 || len >= 256) return false;
  for (let i = start; i < end; i++) {
    const c = buf[i];
    if (c < 0x21 || c > 0x7e) return false;
  }
  const str = buf.subarray(start, end).toString("ascii");
  return /^(?:[&?]?rkey=)?[A-Za-z0-9_%=-]{10,}$/.test(str);
}

/**
 * @param {Buffer} buf
 * @param {number} offset
 * @param {number} [limit=buf.length]
 * @returns {{ next: number, corrupted: boolean, value: number } | null}
 */
function _advanceUtf8ExpandedVarint(buf, offset, limit = buf.length) {
  let pos = offset;
  const start = offset;
  while (pos < limit && buf[pos] >= 0x80) {
    pos++;
  }
  if (pos >= limit) return null;
  const end = pos + 1;
  const corrupted = _bufferHasUtf8Replacement(buf, start, end);
  let value = 0;
  if (!corrupted) {
    const exact = _readExactVarint(buf, start, end);
    if (exact && exact.next === end) {
      value = exact.value;
    }
  }
  return { next: end, corrupted, value };
}

/**
 * @param {Buffer} buf
 * @returns {Array<{ rkey: string, ttlSeconds: number, storeId: number, createTime: number, type: number }>}
 */
function _scanNtv2RKeyEntries(buf) {
  /** @type {Array<{ rkey: string, ttlSeconds: number, storeId: number, createTime: number, type: number }>} */
  const rkeys = [];
  if (!buf || buf.length < 14) return rkeys;

  for (let i = 0; i + 12 < buf.length; i++) {
    if (buf[i] !== 0x0a) continue;
    let strLen = 0;
    let strStart = 0;
    if (buf[i + 1] >= 10 && buf[i + 1] < 0x80) {
      strLen = buf[i + 1];
      strStart = i + 2;
    } else if (
      i + 2 < buf.length &&
      buf[i + 1] >= 0x80 &&
      buf[i + 1] < 0xc0 &&
      buf[i + 2] === 0x01
    ) {
      strLen = (buf[i + 1] & 0x7f) | 0x80;
      strStart = i + 3;
    } else {
      continue;
    }
    const strEnd = strStart + strLen;
    if (strEnd > buf.length) continue;
    if (!_isLikelyAsciiRKeyBytes(buf, strStart, strEnd)) continue;

    const rkey = buf.subarray(strStart, strEnd).toString("ascii");
    let cursor = strEnd;
    let ttlSeconds = 0;
    let storeId = 0;
    let createTime = 0;
    let type = 0;

    for (let step = 0; step < 8 && cursor < buf.length; step++) {
      const tag = buf[cursor];
      if (tag >= 0x80 || tag === 0x0a) break;
      const wireType = tag & 7;
      if (wireType !== 0) break;
      const v = _advanceUtf8ExpandedVarint(buf, cursor + 1, buf.length);
      if (!v) break;
      cursor = v.next;
      if (tag === 0x10 && !v.corrupted) {
        ttlSeconds = v.value;
      } else if (tag === 0x18 && !v.corrupted) {
        storeId = v.value;
      } else if (tag === 0x20 && !v.corrupted) {
        createTime = v.value;
      } else if (tag === 0x28) {
        const lastByte = buf[v.next - 1];
        type = v.corrupted ? lastByte : v.value;
        break;
      }
    }

    if (type > 0 && type < 128) {
      rkeys.push({
        rkey,
        ttlSeconds: ttlSeconds > 0 ? ttlSeconds : DEFAULT_RKEY_TTL_SEC,
        storeId,
        createTime,
        type,
      });
      i = cursor - 1;
    }
  }
  return rkeys;
}

/**
 * @param {any} rawResp
 */
function parseFetchDownloadRkeysResponse(rawResp) {
  if (rawResp === null || rawResp === undefined) {
    return { ok: false, result: -1, errMsg: "empty SSO response", rkeys: [] };
  }

  let rspPayload = rawResp;
  if (
    typeof rawResp === "object" &&
    !Buffer.isBuffer(rawResp) &&
    !(rawResp instanceof Uint8Array)
  ) {
    const ssoResult = Number(rawResp.result ?? 0);
    if (Number.isFinite(ssoResult) && ssoResult !== 0) {
      return {
        ok: false,
        result: ssoResult,
        errMsg: String(rawResp.errMsg || `SSO result=${ssoResult}`),
        rkeys: [],
      };
    }
    rspPayload = rawResp.rsp ?? rawResp.response ?? rawResp.buf ?? "";
  }

  const buf = Buffer.isBuffer(rspPayload)
    ? rspPayload
    : rspPayload instanceof Uint8Array
    ? Buffer.from(rspPayload)
    : Buffer.from(String(rspPayload || ""), "utf8");

  if (buf.length === 0) {
    return { ok: false, result: -1, errMsg: "empty rsp buffer", rkeys: [] };
  }

  const exact = _tryExactProtobufDecode(buf);
  if (exact && (!exact.ok || exact.rkeys.length > 0)) {
    const normalized = exact.rkeys.map((item) => ({
      ...item,
      ttlSeconds: item.ttlSeconds > 0 ? item.ttlSeconds : DEFAULT_RKEY_TTL_SEC,
    }));
    return {
      ok: exact.ok && normalized.length > 0,
      result: exact.result,
      errMsg: exact.errMsg,
      rkeys: normalized,
    };
  }

  const scanned = _scanNtv2RKeyEntries(buf);
  return {
    ok: scanned.length > 0,
    result: scanned.length > 0 ? 0 : -1,
    errMsg: scanned.length > 0 ? "" : "no rkeys decoded from SSO payload",
    rkeys: scanned,
  };
}

/**
 * @param {any} bridge
 */
function _ensureBridgeRKeyState(bridge) {
  if (!bridge || typeof bridge !== "object") {
    return {
      cache: new Map(),
      inflight: null,
      lastAttemptMs: 0,
      lastSuccessMs: 0,
      lastError: null,
    };
  }
  if (!bridge._rkeyState || !(bridge._rkeyState.cache instanceof Map)) {
    bridge._rkeyState = {
      cache: new Map(),
      inflight: null,
      lastAttemptMs: 0,
      lastSuccessMs: 0,
      lastError: null,
    };
  }
  return bridge._rkeyState;
}

/**
 * @param {any} bridge
 */
function _resolveDirectKernelMsgService(bridge) {
  const cs = bridge?.capturedServices;
  if (!cs || typeof cs !== "object") return null;
  for (const sessionCand of [
    cs.wrapperSession,
    cs.ntStore?.wrapperSession,
    cs.ntStore?.session,
  ]) {
    if (sessionCand && typeof sessionCand.getMsgService === "function") {
      try {
        const svc = sessionCand.getMsgService();
        if (svc && typeof svc.sendSsoCmdReqByContend === "function") {
          return svc;
        }
      } catch (err) {
        bridge?.logger?.debug?.("rkey_manager", err);
      }
    }
  }
  return null;
}

/**
 * @param {any} bridge
 * @param {string} utf8Payload
 * @param {number} [timeoutMs]
 */
async function _invokeSsoFetchRKeysOnce(bridge, utf8Payload, timeoutMs = DEFAULT_SSO_TIMEOUT_MS) {
  const directSvc = _resolveDirectKernelMsgService(bridge);
  /** @type {Promise<any> | null} */
  let callPromise = null;

  if (directSvc) {
    callPromise = Promise.resolve(
      directSvc.sendSsoCmdReqByContend(SSO_CMD_FETCH_RKEYS, utf8Payload)
    );
  } else if (typeof bridge?.invokeNt === "function") {
    callPromise = bridge.invokeNt(
      "nodeIKernelMsgService/sendSsoCmdReqByContend",
      { cmd: SSO_CMD_FETCH_RKEYS, param: utf8Payload },
      [SSO_CMD_FETCH_RKEYS, utf8Payload]
    );
  } else if (typeof bridge?.ntCall === "function") {
    callPromise = bridge.ntCall("nodeIKernelMsgService", "sendSsoCmdReqByContend", [
      SSO_CMD_FETCH_RKEYS,
      utf8Payload,
    ]);
  } else {
    return null;
  }

  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  try {
    return await Promise.race([
      callPromise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`SSO ${SSO_CMD_FETCH_RKEYS} timed out after ${timeoutMs}ms`)),
          Math.max(200, Number(timeoutMs) || DEFAULT_SSO_TIMEOUT_MS)
        );
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * @param {any} state
 * @param {number} type
 * @param {number} [nowSec]
 */
function _getValidCachedRKey(state, type, nowSec = Math.floor(Date.now() / 1000)) {
  const entry = state.cache.get(Number(type));
  if (!entry || !entry.rkey) return null;
  if (entry.expiresAtSec <= nowSec + RKEY_EXPIRY_SKEW_SEC) {
    return null;
  }
  return entry;
}

/**
 * @param {any} bridge
 * @param {number} [type=0]
 */
function invalidateCachedRKeys(bridge, type = 0) {
  const state = _ensureBridgeRKeyState(bridge);
  if (type > 0) {
    state.cache.delete(Number(type));
  } else {
    state.cache.clear();
  }
  state.lastAttemptMs = 0;
  state.lastSuccessMs = 0;
}

/**
 * @param {any} bridge
 * @param {{ forceRefresh?: boolean, timeoutMs?: number }} [options]
 */
async function refreshRKeysFromBridge(bridge, options = {}) {
  const state = _ensureBridgeRKeyState(bridge);
  const forceRefresh = Boolean(options?.forceRefresh);
  const timeoutMs = Math.max(300, Number(options?.timeoutMs) || DEFAULT_SSO_TIMEOUT_MS);

  if (state.inflight) {
    return state.inflight;
  }

  const nowMs = Date.now();
  if (forceRefresh) {
    if (state.lastSuccessMs > 0 && nowMs - state.lastSuccessMs < RKEY_MIN_FORCE_INTERVAL_MS) {
      return Array.from(state.cache.values());
    }
  } else if (state.lastAttemptMs > 0 && nowMs - state.lastAttemptMs < RKEY_FAIL_COOLDOWN_MS) {
    return Array.from(state.cache.values());
  }

  state.lastAttemptMs = nowMs;
  const runRefresh = (async () => {
    /** @type {string | null} */
    let lastErr = null;
    for (const includeScene of [true, false]) {
      try {
        const payload = buildFetchDownloadRkeysUtf8Payload({ includeScene });
        const rawResp = await _invokeSsoFetchRKeysOnce(bridge, payload, timeoutMs);
        if (!rawResp) break;
        const parsed = parseFetchDownloadRkeysResponse(rawResp);
        if (parsed.ok && parsed.rkeys.length > 0) {
          const nowSec = Math.floor(Date.now() / 1000);
          for (const rk of parsed.rkeys) {
            const clean = stripRKeyPrefix(rk.rkey);
            if (!clean || !rk.type) continue;
            const ttlSec = Math.max(120, Number(rk.ttlSeconds) || DEFAULT_RKEY_TTL_SEC);
            const baseSec =
              rk.createTime > 1700000000 && rk.createTime <= nowSec + 300
                ? rk.createTime
                : nowSec;
            state.cache.set(Number(rk.type), {
              type: Number(rk.type),
              rkey: formatRKeyWithPrefix(clean),
              cleanRKey: clean,
              ttlSeconds: ttlSec,
              createTime: rk.createTime || nowSec,
              expiresAtSec: Math.max(nowSec + 120, baseSec + ttlSec),
            });
          }
          if (state.cache.size > 0) {
            state.lastSuccessMs = Date.now();
            state.lastError = null;
            return Array.from(state.cache.values());
          }
        } else if (parsed.errMsg) {
          lastErr = parsed.errMsg;
        }
      } catch (err) {
        lastErr = err?.message || String(err);
      }
    }
    if (lastErr) {
      state.lastError = lastErr;
    }
    return Array.from(state.cache.values());
  })();

  state.inflight = runRefresh;
  try {
    return await runRefresh;
  } finally {
    if (state.inflight === runRefresh) {
      state.inflight = null;
    }
  }
}

/**
 * @param {any} bridge
 * @param {string} rawUrl
 * @param {{ appId?: number, isGroup?: boolean, mediaKind?: string, forceRefresh?: boolean, timeoutMs?: number }} [options]
 */
async function resolveRKeyForUrl(bridge, rawUrl, options = {}) {
  const state = _ensureBridgeRKeyState(bridge);
  const primaryType = inferRKeyTypeFromUrlOrContext(rawUrl, options);
  const candidateTypes = [
    primaryType,
    FALLBACK_IMAGE_RKEY_TYPE,
    primaryType === GROUP_IMAGE_RKEY_TYPE ? PRIVATE_IMAGE_RKEY_TYPE : GROUP_IMAGE_RKEY_TYPE,
  ];

  if (!options?.forceRefresh) {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const t of candidateTypes) {
      const hit = _getValidCachedRKey(state, t, nowSec);
      if (hit) return hit;
    }
  }

  await refreshRKeysFromBridge(bridge, options);
  const nowSecAfter = Math.floor(Date.now() / 1000);
  for (const t of candidateTypes) {
    const hit = _getValidCachedRKey(state, t, nowSecAfter);
    if (hit) return hit;
  }
  return null;
}

/**
 * @param {any} bridge
 * @param {{ forceRefresh?: boolean, timeoutMs?: number }} [options]
 */
async function getOneBotRKeyList(bridge, options = {}) {
  const state = _ensureBridgeRKeyState(bridge);
  const nowSec = Math.floor(Date.now() / 1000);
  let priv = _getValidCachedRKey(state, PRIVATE_IMAGE_RKEY_TYPE, nowSec);
  let grp = _getValidCachedRKey(state, GROUP_IMAGE_RKEY_TYPE, nowSec);

  if (!priv || !grp || options?.forceRefresh) {
    await refreshRKeysFromBridge(bridge, options);
    const refreshedSec = Math.floor(Date.now() / 1000);
    priv =
      _getValidCachedRKey(state, PRIVATE_IMAGE_RKEY_TYPE, refreshedSec) ||
      _getValidCachedRKey(state, FALLBACK_IMAGE_RKEY_TYPE, refreshedSec);
    grp =
      _getValidCachedRKey(state, GROUP_IMAGE_RKEY_TYPE, refreshedSec) ||
      _getValidCachedRKey(state, FALLBACK_IMAGE_RKEY_TYPE, refreshedSec);
  }

  if (priv || grp) {
    const out = [];
    if (priv) {
      out.push({
        type: "private",
        rkey: priv.rkey,
        created_at: priv.createTime,
        ttl: String(priv.ttlSeconds),
      });
    }
    if (grp) {
      out.push({
        type: "group",
        rkey: grp.rkey,
        created_at: grp.createTime,
        ttl: String(grp.ttlSeconds),
      });
    }
    if (out.length === 1) {
      out.push({
        ...out[0],
        type: out[0].type === "private" ? "group" : "private",
      });
    }
    return out;
  }
  return null;
}

/**
 * Best-effort removal of a transient file without surfacing ENOENT cleanup errors.
 * @param {string} filePath
 */
async function _unlinkQuiet(filePath) {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch (_err) {
    // Expected when temp file was already moved or removed concurrently.
  }
}

/**
 * @param {string} srcPath
 * @param {string} targetPath
 * @returns {Promise<string>}
 */
async function _copyAtomicallyToTargetPath(srcPath, targetPath) {
  if (!targetPath || typeof targetPath !== "string") return "";
  const resolvedTarget = path.resolve(targetPath);
  if (path.resolve(srcPath) === resolvedTarget) return resolvedTarget;
  const parentDir = path.dirname(resolvedTarget);
  const lowerTarget = resolvedTarget.toLowerCase();
  if (
    lowerTarget.includes("nt_db") ||
    lowerTarget.includes(".ssh") ||
    lowerTarget.endsWith(".db") ||
    lowerTarget.endsWith(".sqlite")
  ) {
    return "";
  }
  await fs.promises.mkdir(parentDir, { recursive: true });
  const partPath = path.join(
    parentDir,
    `.rk.${process.pid}.${crypto.randomBytes(6).toString("hex")}.part`
  );
  try {
    await fs.promises.copyFile(srcPath, partPath);
    await fs.promises.rename(partPath, resolvedTarget);
    await _unlinkQuiet(srcPath);
    return resolvedTarget;
  } catch (_copyErr) {
    await _unlinkQuiet(partPath);
    try {
      const st = await fs.promises.stat(resolvedTarget);
      if (st.isFile() && st.size > 0) {
        await _unlinkQuiet(srcPath);
        return resolvedTarget;
      }
    } catch (_statErr) {
      // Target was not written by a concurrent worker; caller will fall back to temp file.
    }
    return "";
  }
}

/**
 * @param {any} bridge
 * @param {string} rawUrl
 * @param {Record<string, any>} [options]
 */
async function downloadNtMultimediaWithRKey(bridge, rawUrl, options = {}) {
  const fullUrl = normalizeNtMultimediaUrl(rawUrl);
  if (!fullUrl || !isNtMultimediaDownloadUrl(fullUrl)) {
    return null;
  }

  const needsRKey = urlNeedsRKey(fullUrl);
  const secOpts =
    typeof bridge?.outboundPipeline?._mediaSecurityOptions === "function"
      ? bridge.outboundPipeline._mediaSecurityOptions()
      : typeof bridge?._mediaSecurityOptions === "function"
      ? bridge._mediaSecurityOptions()
      : {};
  const tempDir = resolveTempDirFromEnv(
    options?.tempDir || bridge?.config?.tempDir || secOpts?.tempDir
  );
  const maxMediaBytes = resolveMaxMediaBytes({
    maxMediaBytes: options?.maxMediaBytes ?? secOpts?.maxMediaBytes ?? bridge?.config?.maxMediaBytes,
  });
  const totalBudgetMs = Math.max(400, Number(options?.timeoutMs) || 8000);
  const startedAt = Date.now();

  const md5Clean = String(options?.md5 || "")
    .trim()
    .toLowerCase();
  const rawExt = path.extname(String(options?.fileName || "")).toLowerCase();
  const safeExt = /^\.(?:jpg|jpeg|png|gif|webp|bmp|amr|silk|mp4)$/i.test(rawExt) ? rawExt : "";
  const preferredName =
    /^[0-9a-f]{32}$/.test(md5Clean) && safeExt ? `${md5Clean}${safeExt}` : undefined;

  /**
   * @param {boolean} forceRefresh
   */
  const runAttempt = async (forceRefresh) => {
    const elapsed = Date.now() - startedAt;
    const remMs = totalBudgetMs - elapsed;
    if (remMs <= 150) return null;

    let fetchUrl = fullUrl;
    let usedType = 0;
    if (needsRKey) {
      const rkEntry = await resolveRKeyForUrl(bridge, fullUrl, {
        appId: options?.appId,
        isGroup: options?.isGroup,
        mediaKind: options?.mediaKind,
        forceRefresh,
        timeoutMs: Math.min(remMs, 4000),
      });
      if (!rkEntry?.rkey) {
        return null;
      }
      usedType = rkEntry.type;
      fetchUrl = appendRKeyToUrl(fullUrl, rkEntry.rkey);
    }

    const dlBudgetMs = Math.max(200, totalBudgetMs - (Date.now() - startedAt));
    const dl = await downloadMediaStreamToTempDir(fetchUrl, tempDir, {
      ...secOpts,
      tempDir,
      maxMediaBytes,
      timeoutMs: dlBudgetMs,
      ...(safeExt ? { preferredExt: safeExt } : {}),
      ...(preferredName ? { preferredName } : {}),
      ...(options?.lookup ? { lookup: options.lookup } : {}),
      ...(options?.agent !== undefined ? { agent: options.agent } : {}),
    });
    return { dl, fetchUrl, usedType };
  };

  /** @type {Awaited<ReturnType<typeof runAttempt>>} */
  let attemptRes = null;
  try {
    attemptRes = await runAttempt(false);
  } catch (firstErr) {
    const msg = String(firstErr?.message || "");
    const isAuthOrExpiredHttp = /\bHTTP (?:400|401|403|404)\b/i.test(msg);
    if (!needsRKey || !isAuthOrExpiredHttp) {
      throw firstErr;
    }
    invalidateCachedRKeys(bridge, 0);
    attemptRes = await runAttempt(true);
  }

  if (!attemptRes?.dl?.localPath || !(attemptRes.dl.fileSize > 0)) {
    return null;
  }

  const { dl, fetchUrl } = attemptRes;
  let finalPath = dl.localPath;
  let isTempFile = true;

  if (options?.targetPath) {
    const copiedTarget = await _copyAtomicallyToTargetPath(dl.localPath, String(options.targetPath));
    if (copiedTarget) {
      finalPath = copiedTarget;
      isTempFile = false;
    }
  }

  if (isTempFile) {
    const maxTempFiles = Number(bridge?.config?.maxTempFiles) || 128;
    try {
      await pruneTempDirAsync(tempDir, maxTempFiles);
    } catch (pruneErr) {
      bridge?.logger?.debug?.("rkey_manager", pruneErr);
    }
  }

  return {
    localPath: finalPath,
    fileName: path.basename(finalPath),
    fileSize: dl.fileSize,
    md5HexStr: dl.md5HexStr,
    width: dl.width,
    height: dl.height,
    isGif: dl.isGif,
    signedUrl: fetchUrl,
    isTempFile,
  };
}

module.exports = {
  SSO_CMD_FETCH_RKEYS,
  PRIVATE_IMAGE_RKEY_TYPE,
  GROUP_IMAGE_RKEY_TYPE,
  PRIVATE_VIDEO_RKEY_TYPE,
  GROUP_VIDEO_RKEY_TYPE,
  PRIVATE_PTT_RKEY_TYPE,
  GROUP_PTT_RKEY_TYPE,
  FALLBACK_IMAGE_RKEY_TYPE,
  buildFetchDownloadRkeysRequestBuffer,
  buildFetchDownloadRkeysUtf8Payload,
  parseFetchDownloadRkeysResponse,
  stripRKeyPrefix,
  formatRKeyWithPrefix,
  normalizeNtMultimediaUrl,
  urlNeedsRKey,
  isNtMultimediaDownloadUrl,
  inferRKeyTypeFromUrlOrContext,
  appendRKeyToUrl,
  invalidateCachedRKeys,
  refreshRKeysFromBridge,
  resolveRKeyForUrl,
  getOneBotRKeyList,
  downloadNtMultimediaWithRKey,
};
