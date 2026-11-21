// @ts-check
"use strict";

/**
 * Sanitized Anomaly Flight Recorder (`src/core/anomaly_recorder.js`)
 *
 * Captures unexpected NTQQ kernel payload structures or inbound formatting exceptions
 * into a bounded in-memory ring buffer and optional state-directory JSON files, after
 * stripping all PII, credentials, URLs, file paths, UINs, UIDs, and message text while
 * preserving structural keys, array cardinalities, enum numbers, and UID equality topology.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_MAX_ANOMALIES = 20;
const DEFAULT_DEDUPE_WINDOW_MS = 60000;

const ENUM_NUMERIC_KEY_RE =
  /(?:type|subtype|chattype|msgtype|busiid|result|code|role|sex|status|flag|option|scene|version|level|count|len|size|width|height|duration)$/i;
const UIN_KEY_RE = /(?:uin|user_id|self_id|operator_id|sender_id|target_id|qq)$/i;
const GROUP_KEY_RE = /(?:group_id|groupcode|discussid|guild_id|guildid|channel_id)$/i;
const UID_KEY_RE = /(?:uid|ntuid|uidstr|uid_str\d*)$/i;
const SECRET_OR_URL_KEY_RE =
  /(?:token|secret|cookie|skey|pskey|bkn|rkey|auth|passwd|password|qrcode|url|uri|sig|sign)$/i;
const PATH_KEY_RE = /(?:path|dir|folder|filename|filepath| thumbpath)$/i;
const FREE_TEXT_KEY_RE =
  /(?:content|text|nick|nickname|card|remark|wording|summary|prompt|title|raw_message|xml|json|markdown|name|reason|comment)$/i;
const HASH_KEY_RE = /(?:md5|sha1|sha256|uuid|fileuuid|file_uuid)$/i;

/**
 * @typedef {object} AnomalyRecord
 * @property {string} id
 * @property {number} ts
 * @property {string} kind
 * @property {string} eventName
 * @property {string} errorMessage
 * @property {string} shapeSignature
 * @property {any} sanitizedPayload
 */

/**
 * @typedef {object} AnomalySummary
 * @property {boolean} enabled
 * @property {number} totalRecorded
 * @property {number} persistedCount
 * @property {number} deduplicatedCount
 * @property {number} bufferSize
 * @property {AnomalyRecord[]} recent
 */

/**
 * Deeply clones and scrubs an arbitrary NTQQ payload so zero personal identifiers,
 * message contents, paths, or credentials remain, while preserving exact field names,
 * enum integers, nested shapes, and intra-payload UID/UIN relational identity.
 *
 * @param {any} input
 * @param {{ maxDepth?: number, maxKeys?: number, maxArrayItems?: number }} [options={}]
 * @returns {any}
 */
function sanitizeNtPayload(input, options = {}) {
  const maxDepth = Math.max(1, Math.min(Number(options.maxDepth) || 7, 12));
  const maxKeys = Math.max(4, Math.min(Number(options.maxKeys) || 64, 200));
  const maxArrayItems = Math.max(1, Math.min(Number(options.maxArrayItems) || 12, 50));

  /** @type {WeakSet<object>} */
  const seenObjects = new WeakSet();
  /** @type {Map<string, string>} */
  const uidPseudonyms = new Map();
  /** @type {Map<string, string>} */
  const uinPseudonyms = new Map();
  /** @type {Map<string, string>} */
  const groupPseudonyms = new Map();

  /**
   * @param {Map<string, string>} map
   * @param {string} raw
   * @param {string} prefix
   * @param {number} baseNum
   */
  const mapToken = (map, raw, prefix, baseNum = 0) => {
    let hit = map.get(raw);
    if (!hit) {
      const idx = map.size + 1;
      hit = baseNum > 0 ? String(baseNum + idx) : `${prefix}${idx}`;
      map.set(raw, hit);
    }
    return hit;
  };

  /**
   * @param {any} val
   * @param {string} keyName
   * @param {number} depth
   * @returns {any}
   */
  const walk = (val, keyName, depth) => {
    if (val === null || val === undefined || typeof val === "boolean") {
      return val;
    }
    if (typeof val === "bigint") {
      return "7000000000000000001";
    }
    if (typeof val === "number") {
      if (!Number.isFinite(val)) return null;
      if (UIN_KEY_RE.test(keyName) && val > 10000) {
        return Number(mapToken(uinPseudonyms, String(val), "", 100000));
      }
      if (GROUP_KEY_RE.test(keyName) && val > 10000) {
        return Number(mapToken(groupPseudonyms, String(val), "", 900000));
      }
      if (ENUM_NUMERIC_KEY_RE.test(keyName) || (val >= -100 && val <= 10000)) {
        return val;
      }
      if (val >= 1600000000 && val <= 2100000000) {
        return 1700000000;
      }
      if (val >= 1600000000000 && val <= 2100000000000) {
        return 1700000000000;
      }
      return Number(mapToken(uinPseudonyms, String(val), "", 100000));
    }
    if (typeof val === "string") {
      if (val === "") return "";
      if (SECRET_OR_URL_KEY_RE.test(keyName) || /^https?:\/\//i.test(val) || /rkey=/i.test(val)) {
        return `[REDACTED_URL len=${val.length}]`;
      }
      if (UID_KEY_RE.test(keyName) || /^u_[A-Za-z0-9_-]{6,}$/.test(val)) {
        return mapToken(uidPseudonyms, val, "u_redacted_");
      }
      if (UIN_KEY_RE.test(keyName) && /^\d{5,12}$/.test(val)) {
        return mapToken(uinPseudonyms, val, "", 100000);
      }
      if (GROUP_KEY_RE.test(keyName) && /^\d{5,12}$/.test(val)) {
        return mapToken(groupPseudonyms, val, "", 900000);
      }
      if (HASH_KEY_RE.test(keyName) || /^[0-9a-f]{32}$/i.test(val)) {
        return "00000000000000000000000000000000";
      }
      if (PATH_KEY_RE.test(keyName) || /^(?:\/|[A-Za-z]:[\\/])/.test(val)) {
        const ext = path.extname(val).slice(0, 8);
        return `[REDACTED_PATH${ext ? ` ext=${ext}` : ""}]`;
      }
      if (/^\d{15,22}$/.test(val)) {
        return "7500000000000000001";
      }
      if (/^\d{5,12}$/.test(val)) {
        return mapToken(uinPseudonyms, val, "", 100000);
      }
      if (ENUM_NUMERIC_KEY_RE.test(keyName) && val.length <= 24) {
        return val;
      }
      if (FREE_TEXT_KEY_RE.test(keyName) || val.length > 0) {
        return `[REDACTED_STR len=${val.length}]`;
      }
      return "[REDACTED_STR]";
    }
    if (typeof val === "function" || typeof val === "symbol") {
      return `[${typeof val}]`;
    }
    if (typeof val !== "object") {
      return String(val);
    }

    if (Buffer.isBuffer(val) || ArrayBuffer.isView(val)) {
      return `[Binary byteLength=${val.byteLength}]`;
    }
    if (seenObjects.has(val)) {
      return "[Circular]";
    }
    if (depth >= maxDepth) {
      return Array.isArray(val) ? `[Array len=${val.length}]` : "[Object maxDepth]";
    }
    seenObjects.add(val);

    if (val instanceof Map) {
      /** @type {Array<[any, any]>} */
      const entries = [];
      let count = 0;
      for (const [mk, mv] of val.entries()) {
        if (count >= maxArrayItems) break;
        const safeKey =
          typeof mk === "string" && mk.length <= 32 && /^[A-Za-z0-9_.-]+$/.test(mk)
            ? mk
            : walk(mk, "mapKey", depth + 1);
        entries.push([safeKey, walk(mv, String(mk || "mapVal"), depth + 1)]);
        count += 1;
      }
      return { __type: "Map", size: val.size, entries };
    }

    if (Array.isArray(val)) {
      const slice = val.slice(0, maxArrayItems).map((item) => walk(item, keyName, depth + 1));
      if (val.length > maxArrayItems) {
        slice.push(`[... +${val.length - maxArrayItems} items]`);
      }
      return slice;
    }

    const keys = Object.keys(val);
    /** @type {Record<string, any>} */
    const out = {};
    const limit = Math.min(keys.length, maxKeys);
    for (let i = 0; i < limit; i += 1) {
      const k = keys[i];
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      out[k] = walk(val[k], k, depth + 1);
    }
    if (keys.length > maxKeys) {
      out.__truncatedKeys = keys.length - maxKeys;
    }
    return out;
  };

  return walk(input, "", 0);
}

/**
 * Computes a compact structural shape signature for deduplicating repeated anomalies.
 * @param {any} rawPayload
 * @returns {string}
 */
function computePayloadShapeSignature(rawPayload) {
  if (!rawPayload || typeof rawPayload !== "object") {
    return typeof rawPayload;
  }
  if (Array.isArray(rawPayload)) {
    return `Array(${rawPayload.length > 0 ? computePayloadShapeSignature(rawPayload[0]) : "empty"})`;
  }
  const topKeys = Object.keys(rawPayload).sort().slice(0, 16).join(",");
  const elTypes = Array.isArray(rawPayload.elements)
    ? rawPayload.elements
        .slice(0, 8)
        .map((/** @type {any} */ e) => `${e?.elementType ?? "?"}:${e?.subElementType ?? 0}`)
        .join("+")
    : "";
  return elTypes ? `{${topKeys}}|els=${elTypes}` : `{${topKeys}}`;
}

class AnomalyRecorder {
  /**
   * @param {{
   *   getConfig?: () => (import("../types").BridgeConfig | undefined),
   *   maxEntries?: number,
   *   dedupeWindowMs?: number,
   *   logger?: { debug?: (scope: string, err: any) => void } | null
   * }} [options={}]
   */
  constructor(options = {}) {
    this._getConfig =
      typeof options.getConfig === "function" ? options.getConfig : () => undefined;
    this.maxEntries =
      Number.isFinite(Number(options.maxEntries)) && Number(options.maxEntries) > 0
        ? Math.floor(Number(options.maxEntries))
        : DEFAULT_MAX_ANOMALIES;
    this.dedupeWindowMs =
      Number.isFinite(Number(options.dedupeWindowMs)) && Number(options.dedupeWindowMs) >= 0
        ? Math.floor(Number(options.dedupeWindowMs))
        : DEFAULT_DEDUPE_WINDOW_MS;
    this._logger = options.logger || null;

    /** @type {AnomalyRecord[]} */
    this.records = [];
    /** @type {Map<string, number>} */
    this._recentSignatures = new Map();
    this.totalRecorded = 0;
    this.persistedCount = 0;
    this.deduplicatedCount = 0;
    this._seq = 0;
  }

  /**
   * Records a sanitized structural snapshot of an unexpected payload or exception.
   *
   * @param {{
   *   kind: string,
   *   eventName?: string,
   *   error?: any,
   *   payload?: any
   * }} entry
   * @returns {AnomalyRecord | null}
   */
  record(entry) {
    const cfg = this._getConfig();
    if (cfg && cfg.recordAnomalies === false) {
      return null;
    }

    const now = Date.now();
    const kind = String(entry?.kind || "inbound_anomaly");
    const eventName = String(entry?.eventName || "");
    const rawErr = entry?.error;
    const rawErrMsg = rawErr?.message ? String(rawErr.message) : rawErr ? String(rawErr) : "";
    // Scrub any accidental UIN/UID/token substrings in errorMessage as well
    const cleanErrMsg = rawErrMsg
      .replace(/u_[A-Za-z0-9_-]{6,}/g, "u_redacted")
      .replace(/\b\d{6,12}\b/g, "[ID]")
      .slice(0, 240);

    const shapeSig = computePayloadShapeSignature(entry?.payload);
    const dedupeKey = `${kind}|${eventName}|${cleanErrMsg}|${shapeSig}`;
    const prevAt = this._recentSignatures.get(dedupeKey);
    if (prevAt !== undefined && now - prevAt < this.dedupeWindowMs) {
      this.deduplicatedCount += 1;
      return null;
    }
    if (this._recentSignatures.size >= 256) {
      const oldestKey = this._recentSignatures.keys().next().value;
      if (oldestKey !== undefined) this._recentSignatures.delete(oldestKey);
    }
    this._recentSignatures.set(dedupeKey, now);

    this._seq += 1;
    /** @type {AnomalyRecord} */
    const recordObj = {
      id: `anom_${now}_${this._seq}`,
      ts: now,
      kind,
      eventName,
      errorMessage: cleanErrMsg,
      shapeSignature: shapeSig,
      sanitizedPayload: sanitizeNtPayload(entry?.payload),
    };

    this.totalRecorded += 1;
    this.records.push(recordObj);
    while (this.records.length > this.maxEntries) {
      this.records.shift();
    }

    const stateDir = typeof cfg?.stateDir === "string" ? cfg.stateDir.trim() : "";
    if (stateDir && cfg?.persistAnomalies !== false) {
      this._persistAsync(stateDir, recordObj).catch((err) => {
        this._logger?.debug?.("anomaly_recorder", err);
      });
    }

    return recordObj;
  }

  /**
   * @param {string} stateDir
   * @param {AnomalyRecord} recordObj
   */
  async _persistAsync(stateDir, recordObj) {
    const dirPath = path.join(stateDir, "anomalies");
    await fs.promises.mkdir(dirPath, { recursive: true });
    const safeKind = recordObj.kind.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
    const filePath = path.join(dirPath, `${recordObj.ts}_${this._seq}_${safeKind}.json`);
    const tmpPath = `${filePath}.part`;
    await fs.promises.writeFile(tmpPath, `${JSON.stringify(recordObj, null, 2)}\n`, "utf8");
    await fs.promises.rename(tmpPath, filePath);
    this.persistedCount += 1;

    // Keep at most `maxEntries` anomaly files on disk
    const names = (await fs.promises.readdir(dirPath))
      .filter((n) => n.endsWith(".json"))
      .sort();
    const excess = names.length - this.maxEntries;
    for (let i = 0; i < excess; i += 1) {
      try {
        await fs.promises.unlink(path.join(dirPath, names[i]));
      } catch (_unlinkErr) {
        // Ignore concurrent cleanup.
      }
    }
  }

  /**
   * @param {{ includePayloads?: boolean }} [options={}]
   * @returns {AnomalySummary}
   */
  getSummary(options = {}) {
    const cfg = this._getConfig();
    const includePayloads = Boolean(options.includePayloads);
    const recent = this.records.map((r) =>
      includePayloads
        ? r
        : {
            id: r.id,
            ts: r.ts,
            kind: r.kind,
            eventName: r.eventName,
            errorMessage: r.errorMessage,
            shapeSignature: r.shapeSignature,
            sanitizedPayload: undefined,
          }
    );
    return {
      enabled: cfg?.recordAnomalies !== false,
      totalRecorded: this.totalRecorded,
      persistedCount: this.persistedCount,
      deduplicatedCount: this.deduplicatedCount,
      bufferSize: this.records.length,
      recent,
    };
  }

  clear() {
    this.records = [];
    this._recentSignatures.clear();
  }
}

module.exports = {
  AnomalyRecorder,
  sanitizeNtPayload,
  computePayloadShapeSignature,
};
