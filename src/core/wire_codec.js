// @ts-check
"use strict";

/**
 * Unified Zero-Dependency Cross-Process Wire Codec (`src/core/wire_codec.js`)
 *
 * Single source of truth for lossless main <-> renderer IPC serialization and
 * revival (`Map`, `Set`, `Uint8Array`, `Buffer`, `BigInt`, `Date`, `undefined`,
 * circular references, `__proto__` own-property safety, and NTQQ `KNOWN_MAP_FIELDS`),
 * plus standalone inline source generation for Electron `BrowserWindow` injection.
 */

const KNOWN_MAP_FIELDS = new Set(["msgAttributeInfos", "thumbPath", "picThumbPath"]);
const MAX_CODEC_DEPTH = 32;
const WIRE_CODEC_INJECTION_MARKER = "/* __ROSMONTIS_WIRE_CODEC_INJECT__ */";

/**
 * Escapes HTML-sensitive and JS line-terminator characters inside a JSON string.
 *
 * @param {string} raw
 * @returns {string}
 */
function _escapeJsJsonChars(raw) {
  return raw.replace(
    /[<>&\u2028\u2029]/g,
    (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

/**
 * JSON-encodes `val` safely for embedding inside JavaScript source/IPC strings.
 *
 * @param {any} val
 * @returns {string}
 */
function safeJsJson(val) {
  const raw = JSON.stringify(val);
  if (typeof raw !== "string") return "undefined";
  return _escapeJsJsonChars(raw);
}

/**
 * Returns the canonical `Object.prototype.toString` tag for `val`.
 *
 * @param {any} val
 * @returns {string}
 */
function getObjectTag(val) {
  return Object.prototype.toString.call(val);
}

/**
 * Checks whether `val` is a `Map` (including cross-realm `Map` instances).
 *
 * @param {any} val
 * @returns {val is Map<any, any>}
 */
function isMapLike(val) {
  return val instanceof Map || getObjectTag(val) === "[object Map]";
}

/**
 * Checks whether `val` is a `Set` (including cross-realm `Set` instances).
 *
 * @param {any} val
 * @returns {val is Set<any>}
 */
function isSetLike(val) {
  return val instanceof Set || getObjectTag(val) === "[object Set]";
}

/**
 * Coerces `Uint8Array`, `Buffer`, `ArrayBufferView`, or cross-realm `Uint8Array`
 * values to a `Uint8Array` view, returning `null` for all other inputs.
 *
 * @param {any} val
 * @returns {Uint8Array | null}
 */
function toUint8View(val) {
  if (val instanceof Uint8Array) return val;
  if (ArrayBuffer.isView(val)) {
    return new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
  }
  if (getObjectTag(val) === "[object Uint8Array]") {
    return Uint8Array.from(val);
  }
  return null;
}

/**
 * Defines or assigns an own property on `target` without triggering `__proto__`
 * prototype mutation.
 *
 * @param {Record<string, any>} target
 * @param {string} key
 * @param {any} value
 */
function setOwnProp(target, key, value) {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  } else {
    target[key] = value;
  }
}

/**
 * Recursively encodes `Map`, `Set`, `Uint8Array`, `BigInt`, `Date`, `undefined`,
 * circular references, and `__proto__` keys for cross-process transport.
 *
 * @param {any} val
 * @param {{ forJson?: boolean, depth?: number, seen?: Set<any> | null }} [options]
 * @returns {any}
 */
function encodeBridgeValue(val, { forJson = false, depth = 0, seen = null } = {}) {
  if (val === undefined) {
    return forJson ? { __rosmontisVoid__: true } : undefined;
  }
  if (val === null) return null;
  if (typeof val === "bigint") return val.toString();
  if (typeof val === "function" || typeof val === "symbol") {
    return forJson ? { __rosmontisVoid__: true } : undefined;
  }
  if (typeof val !== "object") return val;

  const u8 = toUint8View(val);
  if (u8) {
    return forJson ? { __rosmontisUint8Array__: Array.from(u8) } : u8;
  }
  if (val instanceof Date || getObjectTag(val) === "[object Date]") {
    return forJson ? val.toISOString() : val;
  }
  if (depth > MAX_CODEC_DEPTH) {
    return val;
  }

  const ancestors = seen || new Set();
  if (ancestors.has(val)) {
    return null;
  }
  ancestors.add(val);

  try {
    const nextOpts = { forJson, depth: depth + 1, seen: ancestors };

    if (isMapLike(val)) {
      return {
        __rosmontisMap__: Array.from(val.entries(), ([k, v]) => [
          encodeBridgeValue(k, nextOpts),
          encodeBridgeValue(v, nextOpts),
        ]),
      };
    }
    if (isSetLike(val)) {
      return Array.from(val.values(), (v) => encodeBridgeValue(v, nextOpts));
    }
    if (Array.isArray(val)) {
      return val.map((item) => encodeBridgeValue(item, nextOpts));
    }

    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      setOwnProp(out, k, encodeBridgeValue(v, nextOpts));
    }
    return out;
  } finally {
    ancestors.delete(val);
  }
}

/**
 * Encodes `Map` / `Set` / `BigInt` / circular refs while preserving `Date` and
 * `Uint8Array` instances for Electron structured-clone IPC channels.
 *
 * @param {any} val
 * @param {number} [depth=0]
 * @returns {any}
 */
function encodeBridgeMaps(val, depth = 0) {
  return encodeBridgeValue(val, { forJson: false, depth });
}

/**
 * Serializes a renderer return value into a JSON string with lossless `undefined`,
 * `Map`, `Uint8Array`, `BigInt`, `Date`, and cycle handling.
 *
 * @param {any} val
 * @returns {string}
 */
function serializeBridgeResult(val) {
  const encoded = encodeBridgeValue(val, { forJson: true, depth: 0 });
  const raw = JSON.stringify(encoded, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item
  );
  return typeof raw === "string" ? raw : '{"__rosmontisVoid__":true}';
}

/**
 * Serializes cross-process bridge payloads while preserving `Map` and
 * `Uint8Array` instances and `bigint` values losslessly, handling top-level
 * `undefined`, and escaping HTML/JS line-terminator characters (`[<>&\u2028\u2029]`).
 *
 * @param {any} value
 * @returns {string}
 */
function serializeBridgePayload(value) {
  const raw = JSON.stringify(value, (_key, val) => {
    if (isMapLike(val)) {
      return {
        __rosmontisMap__: Array.from(val.entries(), ([k, v]) => [
          k === undefined ? { __rosmontisVoid__: true } : k,
          v === undefined ? { __rosmontisVoid__: true } : v,
        ]),
      };
    }
    const u8 = toUint8View(val);
    if (u8) {
      return { __rosmontisUint8Array__: Array.from(u8) };
    }
    if (typeof val === "bigint") {
      return val.toString();
    }
    return val;
  });
  if (typeof raw !== "string") return "undefined";
  return _escapeJsJsonChars(raw);
}

/**
 * Revives wire-decoded payloads produced by `serializeBridgePayload`,
 * `serializeBridgeResult`, `encodeBridgeMaps`, or NTQQ IPC frames
 * (`{ __rosmontisMap__ }`, `{ __rosmontisVoid__ }`, `{ __rosmontisUint8Array__ }`,
 * `{ __rosmontisBytes__ }`, `{ type: "Buffer", data }`, and `KNOWN_MAP_FIELDS`).
 *
 * @param {any} val
 * @param {string} [fieldName=""]
 * @param {number} [depth=0]
 * @param {Set<any> | null} [seen=null]
 * @returns {any}
 */
function reviveBridgePayload(val, fieldName = "", depth = 0, seen = null) {
  if (val === null || val === undefined || typeof val !== "object") {
    return val;
  }

  const u8 = toUint8View(val);
  if (u8) return u8;

  if (val instanceof Date || getObjectTag(val) === "[object Date]") {
    return val;
  }

  const effFieldName = typeof fieldName === "string" ? fieldName : "";
  const effDepth = typeof depth === "number" ? depth : 0;
  if (effDepth > MAX_CODEC_DEPTH) {
    return val;
  }

  const ancestors = isSetLike(seen) ? seen : new Set();
  if (ancestors.has(val)) {
    return val;
  }
  ancestors.add(val);

  try {
    if (isMapLike(val)) {
      const revivedMap = new Map();
      for (const [k, v] of val.entries()) {
        revivedMap.set(
          reviveBridgePayload(k, "", effDepth + 1, ancestors),
          reviveBridgePayload(v, "", effDepth + 1, ancestors)
        );
      }
      return revivedMap;
    }

    if (Array.isArray(val)) {
      return val.map((item) => reviveBridgePayload(item, "", effDepth + 1, ancestors));
    }

    const keys = Object.keys(val);
    if (keys.length === 1) {
      if (val.__rosmontisVoid__ === true) {
        return undefined;
      }
      if (Array.isArray(val.__rosmontisMap__)) {
        return new Map(
          val.__rosmontisMap__.map((/** @type {any} */ entry) => [
            Array.isArray(entry)
              ? reviveBridgePayload(entry[0], "", effDepth + 1, ancestors)
              : undefined,
            Array.isArray(entry)
              ? reviveBridgePayload(entry[1], "", effDepth + 1, ancestors)
              : undefined,
          ])
        );
      }
      if (Array.isArray(val.__rosmontisUint8Array__)) {
        return Uint8Array.from(val.__rosmontisUint8Array__);
      }
      if (Array.isArray(val.__rosmontisBytes__)) {
        return Uint8Array.from(val.__rosmontisBytes__);
      }
    } else if (
      keys.length === 2 &&
      val.type === "Buffer" &&
      Array.isArray(val.data) &&
      val.data.every((/** @type {any} */ b) => typeof b === "number")
    ) {
      return Uint8Array.from(val.data);
    }

    if (KNOWN_MAP_FIELDS.has(effFieldName)) {
      return new Map(
        Object.entries(val).map(([k, v]) => [
          /^\d+$/.test(k) && effFieldName !== "msgAttributeInfos" ? Number(k) : k,
          reviveBridgePayload(v, "", effDepth + 1, ancestors),
        ])
      );
    }

    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      setOwnProp(out, k, reviveBridgePayload(v, k, effDepth + 1, ancestors));
    }
    return out;
  } finally {
    ancestors.delete(val);
  }
}

const INLINE_WIRE_CODEC_FUNCTIONS = [
  _escapeJsJsonChars,
  safeJsJson,
  getObjectTag,
  isMapLike,
  isSetLike,
  toUint8View,
  setOwnProp,
  encodeBridgeValue,
  encodeBridgeMaps,
  serializeBridgeResult,
  serializeBridgePayload,
  reviveBridgePayload,
];

/** @type {string | null} */
let _cachedInlineWireCodecSource = null;

/**
 * Builds a self-contained pure-JS wire codec source snippet with zero external
 * dependencies suitable for embedding into Electron renderer contexts or VMs.
 *
 * @returns {string}
 */
function getInlineWireCodecSource() {
  if (_cachedInlineWireCodecSource !== null) {
    return _cachedInlineWireCodecSource;
  }
  const knownFieldsJson = JSON.stringify(Array.from(KNOWN_MAP_FIELDS));
  _cachedInlineWireCodecSource = [
    `const KNOWN_MAP_FIELDS = new Set(${knownFieldsJson});`,
    `const MAX_CODEC_DEPTH = ${MAX_CODEC_DEPTH};`,
    ...INLINE_WIRE_CODEC_FUNCTIONS.map((fn) => fn.toString()),
  ].join("\n\n");
  return _cachedInlineWireCodecSource;
}

/**
 * Replaces `WIRE_CODEC_INJECTION_MARKER` in `rendererSource` with the inline
 * pure-JS wire codec definitions so Electron `BrowserWindow.webContents.executeJavaScript`
 * receives a 100% standalone script.
 *
 * @param {string} rendererSource
 * @returns {string}
 */
function injectWireCodecIntoRendererSource(rendererSource) {
  if (typeof rendererSource !== "string" || rendererSource.length === 0) {
    return "";
  }
  if (!rendererSource.includes(WIRE_CODEC_INJECTION_MARKER)) {
    return rendererSource;
  }
  const inlineBody = getInlineWireCodecSource();
  if (rendererSource.includes("_wireCodecInlined")) {
    const iifeAssignment = [
      "_wireCodecInlined = (() => {",
      inlineBody,
      "  return {",
      "    KNOWN_MAP_FIELDS,",
      "    MAX_CODEC_DEPTH,",
      "    safeJsJson,",
      "    getObjectTag,",
      "    isMapLike,",
      "    isSetLike,",
      "    toUint8View,",
      "    setOwnProp,",
      "    encodeBridgeValue,",
      "    encodeBridgeMaps,",
      "    serializeBridgeResult,",
      "    serializeBridgePayload,",
      "    reviveBridgePayload,",
      "  };",
      "})();",
    ].join("\n");
    return rendererSource.replace(WIRE_CODEC_INJECTION_MARKER, () => iifeAssignment);
  }
  return rendererSource.replace(WIRE_CODEC_INJECTION_MARKER, () => inlineBody);
}

module.exports = {
  KNOWN_MAP_FIELDS,
  MAX_CODEC_DEPTH,
  WIRE_CODEC_INJECTION_MARKER,
  safeJsJson,
  getObjectTag,
  isMapLike,
  isSetLike,
  toUint8View,
  setOwnProp,
  encodeBridgeValue,
  encodeBridgeMaps,
  serializeBridgeResult,
  serializeBridgePayload,
  reviveBridgePayload,
  getInlineWireCodecSource,
  injectWireCodecIntoRendererSource,
};
