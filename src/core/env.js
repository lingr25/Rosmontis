// @ts-check
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const BRIDGE_ENV_PREFIXES = Object.freeze(["ROSMONTIS", "ONEBOT", "XIAO_BRIDGE"]);

function _getEnv() {
  return (typeof process !== "undefined" && process && process.env) || {};
}

function _flattenKeyList(keys, moreKeys = []) {
  const out = [];
  const append = (item) => {
    if (Array.isArray(item)) {
      for (const sub of item) append(sub);
    } else if (typeof item === "string" && item.trim() !== "") {
      out.push(item.trim());
    }
  };
  if (keys !== undefined && keys !== null) {
    append(keys);
  }
  for (const extra of moreKeys) {
    if (extra !== undefined && extra !== null) {
      append(extra);
    }
  }
  return out;
}

function buildPrefixedEnvKeys(suffix, extraKeys = [], ...moreKeys) {
  const cleanSuffix = String(suffix || "")
    .trim()
    .replace(/^_+/, "");
  const prefixed = cleanSuffix
    ? BRIDGE_ENV_PREFIXES.map((prefix) => `${prefix}_${cleanSuffix}`)
    : [];
  const extras = _flattenKeyList(extraKeys, moreKeys);
  return [...prefixed, ...extras];
}

function pickEnv(...keys) {
  const env = _getEnv();
  const flatKeys = _flattenKeyList(keys);
  for (const key of flatKeys) {
    const val = env[key];
    if (val !== undefined && val !== null) {
      const trimmed = String(val).trim();
      if (trimmed !== "") {
        return trimmed;
      }
    }
  }
  return "";
}

function pickPrefixedEnv(suffix, extraKeys = [], ...moreKeys) {
  return pickEnv(...buildPrefixedEnvKeys(suffix, extraKeys, ...moreKeys));
}

function collectPrefixedEnvValues(suffix, extraKeys = [], ...moreKeys) {
  const env = _getEnv();
  const keys = buildPrefixedEnvKeys(suffix, extraKeys, ...moreKeys);
  const values = [];
  for (const key of keys) {
    const val = env[key];
    if (val !== undefined && val !== null) {
      const trimmed = String(val).trim();
      if (trimmed !== "") {
        values.push(trimmed);
      }
    }
  }
  return values;
}

function parseBoolString(str) {
  if (str === undefined || str === null) return undefined;
  const lower = String(str).trim().toLowerCase();
  if (lower === "1" || lower === "true" || lower === "yes") return true;
  if (lower === "0" || lower === "false" || lower === "no") return false;
  return undefined;
}

function parsePrefixedEnvBool(suffix, extraKeys = [], ...moreKeys) {
  const env = _getEnv();
  const keys = buildPrefixedEnvKeys(suffix, extraKeys, ...moreKeys);
  for (const key of keys) {
    const parsed = parseBoolString(env[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function isPrefixedEnvTruthy(suffix, extraKeys = [], ...moreKeys) {
  return parsePrefixedEnvBool(suffix, extraKeys, ...moreKeys) === true;
}

function isEnvFlagOne(keys, ...moreKeys) {
  const env = _getEnv();
  const flatKeys = _flattenKeyList(keys, moreKeys);
  for (const key of flatKeys) {
    if (env[key] === "1") {
      return true;
    }
  }
  return false;
}

function isPrefixedEnvFlagOne(suffix, extraKeys = [], ...moreKeys) {
  return isEnvFlagOne(buildPrefixedEnvKeys(suffix, extraKeys, ...moreKeys));
}

function isBridgeDisabledFromEnv() {
  return isEnvFlagOne([
    "ROSMONTIS_DISABLE",
    "ROSMONTIS_BRIDGE_DISABLE",
    "XIAO_BRIDGE_DISABLE",
  ]);
}

function isAutoInstallDisabledFromEnv() {
  return isEnvFlagOne([
    "ROSMONTIS_NO_AUTOINSTALL",
    "ROSMONTIS_BRIDGE_NO_AUTOINSTALL",
    "XIAO_BRIDGE_NO_AUTOINSTALL",
  ]);
}

function withAutoInstallDisabled(fn) {
  const env = _getEnv();
  const hasPrev = Object.prototype.hasOwnProperty.call(env, "ROSMONTIS_NO_AUTOINSTALL");
  const prev = env.ROSMONTIS_NO_AUTOINSTALL;
  env.ROSMONTIS_NO_AUTOINSTALL = "1";
  try {
    return fn();
  } finally {
    if (!hasPrev) {
      delete env.ROSMONTIS_NO_AUTOINSTALL;
    } else {
      env.ROSMONTIS_NO_AUTOINSTALL = prev;
    }
  }
}

function isTestModeFromEnv() {
  return isEnvFlagOne(["ROSMONTIS_TEST_MODE", "XIAO_BRIDGE_TEST_MODE"]);
}

function isQuietLogsEnabled(config) {
  return Boolean(config?.quietLogs) || isPrefixedEnvTruthy("QUIET");
}

function isDebugLogsEnabled(config) {
  return Boolean(config?.debugLogs) || isPrefixedEnvTruthy("DEBUG");
}

function getLogFormat(config) {
  const cfgFmt =
    config && typeof config.logFormat === "string"
      ? config.logFormat.trim().toLowerCase()
      : "";
  if (cfgFmt === "json" || cfgFmt === "text") {
    return cfgFmt;
  }
  const envFmt = pickPrefixedEnv("LOG_FORMAT").toLowerCase();
  return envFmt === "json" ? "json" : "text";
}

function getHomeDir() {
  const env = _getEnv();
  return env.HOME || env.USERPROFILE || os.homedir();
}

function getTempBaseDir() {
  const env = _getEnv();
  return env.HOME || os.tmpdir();
}

function getXdgConfigHome() {
  const env = _getEnv();
  return env.XDG_CONFIG_HOME || "";
}

function resolveTempDirFromEnv(explicitTempDir) {
  if (typeof explicitTempDir === "string" && explicitTempDir.trim() !== "") {
    return explicitTempDir.trim();
  }
  return pickPrefixedEnv("TEMP_DIR") || path.join(getTempBaseDir(), ".rosmontis_tmp");
}

function resolveFfmpegPathFromEnv(explicitFfmpegPath) {
  if (typeof explicitFfmpegPath === "string" && explicitFfmpegPath.trim() !== "") {
    return explicitFfmpegPath.trim();
  }
  return pickPrefixedEnv("FFMPEG_PATH", ["FFMPEG_PATH"]) || "ffmpeg";
}

function resolveSilkDecoderPathFromEnv(explicitPath) {
  if (typeof explicitPath === "string" && explicitPath.trim() !== "") {
    return explicitPath.trim();
  }
  return (
    pickPrefixedEnv("SILK_DECODER_PATH", ["SILK_DECODER_PATH"]) ||
    pickPrefixedEnv("SILK_CODEC_PATH", ["SILK_CODEC_PATH"]) ||
    ""
  );
}

function resolveSilkEncoderPathFromEnv(explicitPath) {
  if (typeof explicitPath === "string" && explicitPath.trim() !== "") {
    return explicitPath.trim();
  }
  return pickPrefixedEnv("SILK_ENCODER_PATH", ["SILK_ENCODER_PATH"]) || "";
}

/**
 * @param {any} raw
 * @returns {boolean}
 */
function _isDisabledPathSentinel(raw) {
  return /^(?:none|off|false|0|disabled)$/i.test(String(raw || "").trim());
}

/**
 * Resolve an optional external native SILK v3 `.node` addon (loaded strictly inside
 * an isolated Node child worker process, never inside the Electron main process).
 * @param {string | false | null} [explicitAddonPath]
 * @returns {string}
 */
function resolveSilkAddonPathFromEnv(explicitAddonPath) {
  if (explicitAddonPath === false || explicitAddonPath === null) {
    return "";
  }
  if (typeof explicitAddonPath === "string") {
    const trimmed = explicitAddonPath.trim();
    if (!trimmed || _isDisabledPathSentinel(trimmed)) {
      return "";
    }
    return trimmed;
  }

  const envAddon = pickPrefixedEnv("SILK_ADDON_PATH", ["FFMPEG_ADDON_PATH"]);
  if (envAddon) {
    return _isDisabledPathSentinel(envAddon) ? "" : envAddon;
  }

  const fileName = `ffmpegAddon.${process.platform}.${process.arch}.node`;
  const candidates = [
    path.join("/app/runtime/native/ffmpeg", fileName),
    path.join(getHomeDir(), "runtime", "native", "ffmpeg", fileName),
    path.resolve(__dirname, "..", "native", "ffmpeg", fileName),
    path.resolve(process.cwd(), "native", "ffmpeg", fileName),
  ];

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    } catch (_) {
      // Candidate path may be inaccessible in restricted containers; probe next location.
    }
  }
  return "";
}

/**
 * Resolve a standalone `node` executable for running isolated worker child processes
 * (important when running inside Electron where `process.execPath` is the QQ binary).
 * @param {string} [explicitNodePath]
 * @param {string} [addonPath]
 * @returns {string}
 */
function resolveNodeBinaryFromEnv(explicitNodePath, addonPath = "") {
  if (typeof explicitNodePath === "string" && explicitNodePath.trim() !== "") {
    return explicitNodePath.trim();
  }
  const envNode = pickPrefixedEnv("NODE_BIN", ["NODE_BIN"]);
  if (envNode) {
    return envNode;
  }

  const isElectronRuntime = Boolean(
    typeof process !== "undefined" && process && process.versions && process.versions.electron
  );
  if (
    !isElectronRuntime &&
    typeof process?.execPath === "string" &&
    /^node(?:\.exe)?$/i.test(path.basename(process.execPath))
  ) {
    return process.execPath;
  }

  if (typeof addonPath === "string" && addonPath.trim() !== "") {
    const nodeExe = process.platform === "win32" ? "node.exe" : "node";
    const bundledNode = path.resolve(path.dirname(addonPath), "..", "..", nodeExe);
    try {
      if (fs.existsSync(bundledNode)) {
        return bundledNode;
      }
    } catch (_) {
      // Ignore permission/stat errors while probing optional bundled node binary.
    }
  }

  if (process.platform !== "win32") {
    for (const posixNode of ["/usr/local/bin/node", "/usr/bin/node"]) {
      try {
        if (fs.existsSync(posixNode)) {
          return posixNode;
        }
      } catch (_) {
        // Probe next standard POSIX node path.
      }
    }
  }

  return "node";
}

function resolveStateDirFromEnv(explicitStateDir) {
  if (typeof explicitStateDir === "string" && explicitStateDir.trim() !== "") {
    return explicitStateDir.trim();
  }
  return pickPrefixedEnv("STATE_DIR") || "";
}

/**
 * @returns {string[]}
 */
function resolveConfigDirsFromEnv() {
  const env = _getEnv();
  return [
    env.ROSMONTIS_CONFIG_DIR,
    env.ONEBOT_CONFIG_DIR,
    env.XIAO_BRIDGE_CONFIG_DIR,
  ].filter(/** @returns {d is string} */ (d) => typeof d === "string" && d.length > 0);
}

module.exports = {
  BRIDGE_ENV_PREFIXES,
  buildPrefixedEnvKeys,
  pickEnv,
  pickPrefixedEnv,
  collectPrefixedEnvValues,
  parseBoolString,
  parsePrefixedEnvBool,
  isPrefixedEnvTruthy,
  isEnvFlagOne,
  isPrefixedEnvFlagOne,
  isBridgeDisabledFromEnv,
  isAutoInstallDisabledFromEnv,
  withAutoInstallDisabled,
  isTestModeFromEnv,
  isQuietLogsEnabled,
  isDebugLogsEnabled,
  getLogFormat,
  getHomeDir,
  getTempBaseDir,
  getXdgConfigHome,
  resolveTempDirFromEnv,
  resolveFfmpegPathFromEnv,
  resolveSilkDecoderPathFromEnv,
  resolveSilkEncoderPathFromEnv,
  resolveSilkAddonPathFromEnv,
  resolveNodeBinaryFromEnv,
  resolveStateDirFromEnv,
  resolveConfigDirsFromEnv,
};
