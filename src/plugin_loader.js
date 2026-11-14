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

let activeBridge = null;

function _hasActiveConfigJson(dirPath) {
  try {
    if (!dirPath || !fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return false;
    }
    const files = fs.readdirSync(dirPath);
    return files.some((f) => CONFIG_FILE_RE.test(f) && !f.endsWith(".example.json"));
  } catch (_) {
    return false;
  }
}

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

  const liteLoaderObj =
    options.liteLoader || (typeof globalThis !== "undefined" ? globalThis.LiteLoader : null);
  const liteLoaderDataDir = liteLoaderObj?.plugins?.rosmontis?.path?.data;
  if (typeof liteLoaderDataDir === "string" && liteLoaderDataDir.trim() !== "") {
    const trimmed = liteLoaderDataDir.trim();
    if (_hasActiveConfigJson(trimmed) || fs.existsSync(trimmed)) {
      return trimmed;
    }
  }

  const qwqntObj =
    options.qwqnt || (typeof globalThis !== "undefined" ? globalThis.qwqnt : null);
  const qwqntSaveRoot = qwqntObj?.core?.configs?.core?.save;
  if (typeof qwqntSaveRoot === "string" && qwqntSaveRoot.trim() !== "") {
    const candidate = path.join(qwqntSaveRoot.trim(), "rosmontis");
    if (_hasActiveConfigJson(candidate) || fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function _appendBootLog(bootLogPath, message) {
  if (!bootLogPath) return;
  try {
    fs.appendFileSync(bootLogPath, `${new Date().toISOString()} [rosmontis] ${message}\n`);
  } catch (_) {}
}

function bootPluginBridge(options = {}) {
  if (isBridgeDisabledFromEnv()) {
    return null;
  }
  if (activeBridge && !options.forceNew) {
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
    } catch (_) {}
    return null;
  }
}

function onBrowserWindowCreated(window) {
  const bridge = activeBridge || (!isTestModeFromEnv() ? bootPluginBridge() : null);
  const wc = window && (window.webContents || window);
  if (bridge && wc && typeof bridge._attachToWebContents === "function") {
    try {
      bridge._attachToWebContents(wc);
    } catch (_) {}
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
