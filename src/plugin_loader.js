// @ts-check
"use strict";

/**
 * Pure-JS Cross-Platform Plugin & External Loader Entrypoint (`src/plugin_loader.js`)
 *
 * Mounts Rosmontis inside Electron main process when loaded by community desktop
 * plugin frameworks (LiteLoaderQQNT v4, QwQNT) or a custom main-process bootstrap,
 * while keeping the repository 100% pure JavaScript with zero native binaries.
 */

const fs = require("fs");
const path = require("path");
const {
  isBridgeDisabledFromEnv,
  isTestModeFromEnv,
  pickPrefixedEnv,
  resolveConfigDirsFromEnv,
  withAutoInstallDisabled,
} = require("./core/env");

const REPO_ROOT = path.resolve(__dirname, "..");
const REPO_CONFIG_DIR = path.join(REPO_ROOT, "config");
const CONFIG_FILE_RE = /^(?:rosmontis|onebot|xiao_bridge)(?:_[a-zA-Z0-9_-]+)?\.json$/;

/** @type {any} */
let activeBridge = null;

/**
 * @param {string} dirPath
 * @returns {boolean}
 */
function _hasActiveConfigJson(dirPath) {
  try {
    if (!dirPath || !fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return false;
    }
    const files = fs.readdirSync(dirPath);
    return files.some((f) => CONFIG_FILE_RE.test(f) && !f.endsWith(".example.json"));
  } catch (_) {
    // Directory may not exist or be readable during plugin config discovery.
    return false;
  }
}

/**
 * @param {Record<string, any>} [options]
 * @returns {string | undefined}
 */
function resolvePluginConfigDir(options = {}) {
  if (typeof options.configDir === "string" && options.configDir.trim() !== "") {
    return options.configDir.trim();
  }

  const envDirs = resolveConfigDirsFromEnv();
  if (envDirs.length > 0) {
    return envDirs[0];
  }

  if (_hasActiveConfigJson(REPO_CONFIG_DIR)) {
    return REPO_CONFIG_DIR;
  }

  const globalObj = /** @type {any} */ (typeof globalThis !== "undefined" ? globalThis : null);
  const liteLoaderObj = options.liteLoader || globalObj?.LiteLoader || null;
  const liteLoaderDataDir = liteLoaderObj?.plugins?.rosmontis?.path?.data;
  if (typeof liteLoaderDataDir === "string" && liteLoaderDataDir.trim() !== "") {
    const trimmed = liteLoaderDataDir.trim();
    if (_hasActiveConfigJson(trimmed) || fs.existsSync(trimmed)) {
      return trimmed;
    }
  }

  const qwqntObj = options.qwqnt || globalObj?.qwqnt || null;
  const qwqntSaveRoot = qwqntObj?.core?.configs?.core?.save;
  if (typeof qwqntSaveRoot === "string" && qwqntSaveRoot.trim() !== "") {
    const candidate = path.join(qwqntSaveRoot.trim(), "rosmontis");
    if (_hasActiveConfigJson(candidate) || fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * @param {string} bootLogPath
 * @param {string} message
 */
function _appendBootLog(bootLogPath, message) {
  if (!bootLogPath) return;
  try {
    fs.appendFileSync(bootLogPath, `${new Date().toISOString()} [rosmontis] ${message}\n`);
  } catch (_) {
    // Best-effort diagnostic boot log; ignore unwritable paths or permission errors.
  }
}

/**
 * @param {Record<string, any>} [options]
 * @returns {any}
 */
function bootPluginBridge(options = {}) {
  if (isBridgeDisabledFromEnv()) {
    return null;
  }
  if (activeBridge && !options.forceNew) {
    try {
      activeBridge.probeExistingRuntime?.({ electron: options.electron });
    } catch (err) {
      activeBridge?.logger?.debug?.("plugin_loader", err);
    }
    return activeBridge;
  }

  const bootLogPath =
    (typeof options.bootLogPath === "string" && options.bootLogPath.trim()) ||
    pickPrefixedEnv("BOOT_LOG") ||
    "";

  _appendBootLog(
    bootLogPath,
    `plugin_loader start (pid=${process.pid}, platform=${process.platform})`
  );

  try {
    const bridgeMain = withAutoInstallDisabled(() =>
      require(path.join(__dirname, "bridge_main.js"))
    );
    const configDir = resolvePluginConfigDir(options);
    const installOpts = {
      ...options,
      ...(configDir ? { configDir } : {}),
      autoStartServers: options.autoStartServers !== false,
    };
    activeBridge = bridgeMain.installMainBridge(installOpts);
    try {
      activeBridge?.probeExistingRuntime?.({ electron: options.electron });
    } catch (err) {
      activeBridge?.logger?.debug?.("plugin_loader", err);
    }
    _appendBootLog(
      bootLogPath,
      `installMainBridge ok (configDir=${configDir || "auto"}, selfUin=${activeBridge?.selfUin || ""})`
    );
    return activeBridge;
  } catch (err) {
    const detail = err && err.stack ? err.stack : String(err);
    _appendBootLog(bootLogPath, `error: ${detail}`);
    try {
      process.stderr.write(`[rosmontis] Plugin bridge initialization error (non-fatal): ${detail}\n`);
    } catch (_) {
      // Ignore stderr write failure when desktop host launches without an attached stdio stream.
    }
    return null;
  }
}

/**
 * @param {any} window
 */
function onBrowserWindowCreated(window) {
  if (isBridgeDisabledFromEnv()) {
    return;
  }
  const bridge =
    activeBridge || bootPluginBridge({ autoStartServers: !isTestModeFromEnv() });
  const wc = window && (window.webContents || window);
  if (bridge && wc) {
    try {
      bridge._attachToWebContents?.(wc);
    } catch (err) {
      bridge.logger?.debug?.("plugin_loader", err);
    }
  }
}

function getBridgeInstance() {
  return activeBridge;
}

if (!isTestModeFromEnv() && require.main !== module) {
  bootPluginBridge();
}

module.exports = {
  bootPluginBridge,
  resolvePluginConfigDir,
  onBrowserWindowCreated,
  getBridgeInstance,
};
