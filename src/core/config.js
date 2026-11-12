"use strict";

const fs = require("fs");
const path = require("path");

const {
  DEFAULT_MAX_HTTP_BODY_BYTES,
  DEFAULT_MAX_WS_PAYLOAD_BYTES,
} = require("./transport_security");

function filterEnabledEntries(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (item) => item && typeof item === "object" && item.enable !== false && item.enabled !== false
    )
    .map((item) => ({ ...item }));
}

function _pickEnv(...keys) {
  for (const key of keys) {
    const val = process.env[key];
    if (val !== undefined && String(val).trim() !== "") {
      return String(val).trim();
    }
  }
  return "";
}

function _parseBoolString(str) {
  const lower = String(str || "").trim().toLowerCase();
  if (lower === "1" || lower === "true" || lower === "yes") return true;
  if (lower === "0" || lower === "false" || lower === "no") return false;
  return undefined;
}

function _resolveBoolWithDefault(rawVal, defaultVal, ...envKeys) {
  const envRaw = _pickEnv(...envKeys);
  if (envRaw !== "") {
    const parsedEnv = _parseBoolString(envRaw);
    if (parsedEnv !== undefined) return parsedEnv;
  }
  if (rawVal !== undefined && rawVal !== null) {
    return Boolean(rawVal);
  }
  return defaultVal;
}

function _resolvePositiveIntWithDefault(rawVal, defaultVal, ...envKeys) {
  const envRaw = _pickEnv(...envKeys);
  if (envRaw !== "") {
    const envNum = Number(envRaw);
    if (Number.isFinite(envNum) && envNum > 0) return Math.floor(envNum);
  }
  if (rawVal !== undefined && rawVal !== null && rawVal !== "") {
    const rawNum = Number(rawVal);
    if (Number.isFinite(rawNum) && rawNum > 0) return Math.floor(rawNum);
  }
  return defaultVal;
}

function _resolveNonNegativeNumberWithDefault(rawVal, defaultVal, ...envKeys) {
  const envRaw = _pickEnv(...envKeys);
  if (envRaw !== "") {
    const envNum = Number(envRaw);
    if (Number.isFinite(envNum) && envNum >= 0) return envNum;
  }
  if (rawVal !== undefined && rawVal !== null && rawVal !== "") {
    const rawNum = Number(rawVal);
    if (Number.isFinite(rawNum) && rawNum >= 0) return rawNum;
  }
  return defaultVal;
}

function _normalizeDelaySpec(candidate) {
  if (Array.isArray(candidate) && candidate.length >= 2) {
    const min = Number(candidate[0]);
    const max = Number(candidate[1]);
    if (Number.isFinite(min) && Number.isFinite(max) && min >= 0 && max >= 0) {
      return min <= max ? [min, max] : [max, min];
    }
    return undefined;
  }
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
    return candidate;
  }
  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    if (!trimmed) return undefined;
    try {
      const parsed = JSON.parse(trimmed);
      const norm = _normalizeDelaySpec(parsed);
      if (norm !== undefined) return norm;
    } catch (_) {}
    const rangeMatch = /^(\d+(?:\.\d+)?)\s*[,-]\s*(\d+(?:\.\d+)?)$/.exec(trimmed);
    if (rangeMatch) {
      const a = Number(rangeMatch[1]);
      const b = Number(rangeMatch[2]);
      return a <= b ? [a, b] : [b, a];
    }
    const single = Number(trimmed);
    if (Number.isFinite(single) && single >= 0) return single;
  }
  return undefined;
}

function _resolveDelaySpecWithDefault(rawVal, defaultVal, ...envKeys) {
  const envRaw = _pickEnv(...envKeys);
  if (envRaw !== "") {
    const fromEnv = _normalizeDelaySpec(envRaw);
    if (fromEnv !== undefined) return fromEnv;
  }
  if (rawVal !== undefined && rawVal !== null) {
    const fromRaw = _normalizeDelaySpec(rawVal);
    if (fromRaw !== undefined) return fromRaw;
  }
  return Array.isArray(defaultVal) ? [...defaultVal] : defaultVal;
}

function _applyOptionalBoolOverride(target, key, rawObj, ...envKeys) {
  const envRaw = _pickEnv(...envKeys);
  if (envRaw !== "") {
    const parsed = _parseBoolString(envRaw);
    if (parsed !== undefined) {
      target[key] = parsed;
      return;
    }
  }
  if (rawObj && rawObj[key] !== undefined) {
    target[key] = Boolean(rawObj[key]);
  }
}

function _applyOptionalNumberOverride(target, key, rawObj, ...envKeys) {
  const envRaw = _pickEnv(...envKeys);
  if (envRaw !== "") {
    const num = Number(envRaw);
    if (Number.isFinite(num) && num >= 0) {
      target[key] = num;
      return;
    }
  }
  if (rawObj && rawObj[key] !== undefined) {
    const num = Number(rawObj[key]);
    if (Number.isFinite(num) && num >= 0) {
      target[key] = num;
    }
  }
}

function loadBridgeConfig(customConfigDir) {
  const envSelfUin = _pickEnv("ROSMONTIS_SELF_ID", "ONEBOT_SELF_ID", "XIAO_BRIDGE_SELF_ID");
  const envHeartbeatRaw = _pickEnv(
    "ROSMONTIS_HEARTBEAT_MS",
    "ONEBOT_HEARTBEAT_MS",
    "XIAO_BRIDGE_HEARTBEAT_MS"
  );
  const envMessageFormatRaw = _pickEnv(
    "ROSMONTIS_MESSAGE_FORMAT",
    "ONEBOT_MESSAGE_FORMAT",
    "XIAO_BRIDGE_MESSAGE_FORMAT"
  ).toLowerCase();

  const defaultConfig = {
    selfUin: envSelfUin,
    selfNickname:
      _pickEnv("ROSMONTIS_SELF_NICKNAME", "ONEBOT_SELF_NICKNAME", "XIAO_BRIDGE_SELF_NICKNAME") ||
      "Rosmontis",
    httpServers: [],
    wsServers: [],
    wsClients: [],
    heartbeatIntervalMs: envHeartbeatRaw !== "" ? Number(envHeartbeatRaw) : 5000,
  };

  const searchDirs = customConfigDir
    ? [customConfigDir]
    : [
        process.env.ROSMONTIS_CONFIG_DIR,
        process.env.ONEBOT_CONFIG_DIR,
        process.env.XIAO_BRIDGE_CONFIG_DIR,
        "/etc/rosmontis",
        "/app/data/config",
        "/app/config",
        "/opt/QQ/config",
        path.resolve(process.cwd(), "config"),
      ].filter(Boolean);

  let loadedFromFile = false;
  let hasExplicitHttpServersKey = false;
  let hasExplicitWsServersKey = false;
  let loadedRaw = {};

  for (const dir of searchDirs) {
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      const cfgPattern = /^(?:rosmontis|onebot|xiao_bridge)(?:_([a-zA-Z0-9_-]+))?\.json$/;
      const files = fs
        .readdirSync(dir)
        .filter((f) => cfgPattern.test(f) && !f.endsWith(".example.json"));
      if (files.length === 0) continue;

      const parsedEntries = [];
      for (const file of files) {
        try {
          const fullPath = path.join(dir, file);
          const m = cfgPattern.exec(file);
          const suffix = m && m[1] ? m[1] : "";
          const uin = /^\d+$/.test(suffix) ? suffix : "";
          const raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));
          const stat = fs.statSync(fullPath);
          const nets = raw?.networks || {};
          const enabledWsClients = filterEnabledEntries(nets.wsClients);
          const hasWsClients = enabledWsClients.length > 0;
          parsedEntries.push({
            file,
            uin,
            raw: raw && typeof raw === "object" ? raw : {},
            nets,
            hasWsClients,
            mtimeMs: Number(stat?.mtimeMs || 0),
          });
        } catch (_) {}
      }
      if (parsedEntries.length === 0) continue;

      parsedEntries.sort((a, b) => {
        if (envSelfUin) {
          if (a.uin === envSelfUin && b.uin !== envSelfUin) return -1;
          if (b.uin === envSelfUin && a.uin !== envSelfUin) return 1;
        }
        if (a.hasWsClients !== b.hasWsClients) {
          return a.hasWsClients ? -1 : 1;
        }
        if (Boolean(a.uin) !== Boolean(b.uin)) {
          return a.uin ? -1 : 1;
        }
        if (b.mtimeMs !== a.mtimeMs) {
          return b.mtimeMs - a.mtimeMs;
        }
        return a.file.localeCompare(b.file);
      });

      const bestEntry = parsedEntries[0];
      if (bestEntry) {
        const { uin, raw, nets } = bestEntry;
        loadedRaw = raw;
        if (!defaultConfig.selfUin && uin) {
          defaultConfig.selfUin = uin;
        }
        if (envHeartbeatRaw === "" && raw.heartbeatIntervalMs !== undefined) {
          const fileHb = Number(raw.heartbeatIntervalMs);
          if (Number.isFinite(fileHb) && fileHb >= 0) {
            defaultConfig.heartbeatIntervalMs = fileHb;
          }
        }
        for (const optKey of [
          "humanSimulation",
          "aioIdleExitMs",
          "focusIdleBlurMs",
          "sendEchoTimeoutMs",
          "richMediaEchoTimeoutMs",
          "dedupeWindowMs",
          "autoQuickLogin",
          "keepMapHook",
          "quietLogs",
          "maxMediaBytes",
          "allowPrivateMediaUrls",
          "allowPrivateUrls",
          "allowArbitraryLocalFiles",
          "allowedFileDirs",
        ]) {
          if (raw && raw[optKey] !== undefined) {
            defaultConfig[optKey] = raw[optKey];
          }
        }
        hasExplicitHttpServersKey = Array.isArray(nets.httpServers);
        hasExplicitWsServersKey = Array.isArray(nets.wsServers);
        defaultConfig.httpServers.push(...filterEnabledEntries(nets.httpServers));
        defaultConfig.wsServers.push(...filterEnabledEntries(nets.wsServers));
        defaultConfig.wsClients.push(...filterEnabledEntries(nets.wsClients));
        loadedFromFile = true;
      }
      if (loadedFromFile) break;
    } catch (_) {}
  }

  // Security & transport configuration keys (JSON + env overrides)
  defaultConfig.enableWebCredentialApi = _resolveBoolWithDefault(
    loadedRaw.enableWebCredentialApi,
    false,
    "ROSMONTIS_ENABLE_WEB_CREDENTIAL_API",
    "ONEBOT_ENABLE_WEB_CREDENTIAL_API",
    "XIAO_BRIDGE_ENABLE_WEB_CREDENTIAL_API"
  );

  defaultConfig.allowUnauthenticatedPublicBind = _resolveBoolWithDefault(
    loadedRaw.allowUnauthenticatedPublicBind,
    false,
    "ROSMONTIS_ALLOW_UNAUTHENTICATED_PUBLIC",
    "ONEBOT_ALLOW_UNAUTHENTICATED_PUBLIC",
    "XIAO_BRIDGE_ALLOW_UNAUTHENTICATED_PUBLIC"
  );

  defaultConfig.allowQueryAccessToken = _resolveBoolWithDefault(
    loadedRaw.allowQueryAccessToken,
    true,
    "ROSMONTIS_ALLOW_QUERY_TOKEN",
    "ONEBOT_ALLOW_QUERY_TOKEN",
    "XIAO_BRIDGE_ALLOW_QUERY_TOKEN"
  );

  const envAllowedOrigins = _pickEnv(
    "ROSMONTIS_ALLOWED_ORIGINS",
    "ONEBOT_ALLOWED_ORIGINS",
    "XIAO_BRIDGE_ALLOWED_ORIGINS"
  );
  if (envAllowedOrigins !== "") {
    defaultConfig.allowedOrigins = envAllowedOrigins
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (Array.isArray(loadedRaw.allowedOrigins)) {
    defaultConfig.allowedOrigins = loadedRaw.allowedOrigins
      .map((s) => String(s ?? "").trim())
      .filter(Boolean);
  } else {
    defaultConfig.allowedOrigins = [];
  }

  defaultConfig.maxHttpBodyBytes = _resolvePositiveIntWithDefault(
    loadedRaw.maxHttpBodyBytes,
    DEFAULT_MAX_HTTP_BODY_BYTES,
    "ROSMONTIS_MAX_HTTP_BODY_BYTES",
    "ONEBOT_MAX_HTTP_BODY_BYTES",
    "XIAO_BRIDGE_MAX_HTTP_BODY_BYTES"
  );

  defaultConfig.maxWsPayloadBytes = _resolvePositiveIntWithDefault(
    loadedRaw.maxWsPayloadBytes,
    DEFAULT_MAX_WS_PAYLOAD_BYTES,
    "ROSMONTIS_MAX_WS_PAYLOAD_BYTES",
    "ONEBOT_MAX_WS_PAYLOAD_BYTES",
    "XIAO_BRIDGE_MAX_WS_PAYLOAD_BYTES"
  );

  _applyOptionalBoolOverride(
    defaultConfig,
    "allowPtloginJump",
    loadedRaw,
    "ROSMONTIS_ALLOW_PTLOGIN_JUMP",
    "ONEBOT_ALLOW_PTLOGIN_JUMP",
    "XIAO_BRIDGE_ALLOW_PTLOGIN_JUMP"
  );

  _applyOptionalBoolOverride(
    defaultConfig,
    "allowExternalHttp",
    loadedRaw,
    "ROSMONTIS_ALLOW_EXTERNAL_HTTP",
    "ONEBOT_ALLOW_EXTERNAL_HTTP",
    "XIAO_BRIDGE_ALLOW_EXTERNAL_HTTP"
  );

  // Causal timeline & runtime lifecycle keys
  defaultConfig.autoReadAndTypeOnPrivateRecv = _resolveBoolWithDefault(
    loadedRaw.autoReadAndTypeOnPrivateRecv,
    false,
    "ROSMONTIS_AUTO_READ_AND_TYPE_ON_PRIVATE_RECV",
    "ONEBOT_AUTO_READ_AND_TYPE_ON_PRIVATE_RECV",
    "XIAO_BRIDGE_AUTO_READ_AND_TYPE_ON_PRIVATE_RECV"
  );

  defaultConfig.autoReadReactionDelayMs = _resolveDelaySpecWithDefault(
    loadedRaw.autoReadReactionDelayMs,
    [500, 1800],
    "ROSMONTIS_AUTO_READ_REACTION_DELAY_MS",
    "ONEBOT_AUTO_READ_REACTION_DELAY_MS",
    "XIAO_BRIDGE_AUTO_READ_REACTION_DELAY_MS"
  );

  defaultConfig.aioSwitchCooldownMs = _resolveNonNegativeNumberWithDefault(
    loadedRaw.aioSwitchCooldownMs,
    800,
    "ROSMONTIS_AIO_SWITCH_COOLDOWN_MS",
    "ONEBOT_AIO_SWITCH_COOLDOWN_MS",
    "XIAO_BRIDGE_AIO_SWITCH_COOLDOWN_MS"
  );

  defaultConfig.humanReadToTypingDelayMs = _resolveDelaySpecWithDefault(
    loadedRaw.humanReadToTypingDelayMs,
    0,
    "ROSMONTIS_HUMAN_READ_TO_TYPING_DELAY_MS",
    "ONEBOT_HUMAN_READ_TO_TYPING_DELAY_MS",
    "XIAO_BRIDGE_HUMAN_READ_TO_TYPING_DELAY_MS"
  );

  _applyOptionalBoolOverride(
    defaultConfig,
    "cleanupTempImmediately",
    loadedRaw,
    "ROSMONTIS_CLEANUP_TEMP_IMMEDIATELY",
    "ONEBOT_CLEANUP_TEMP_IMMEDIATELY",
    "XIAO_BRIDGE_CLEANUP_TEMP_IMMEDIATELY"
  );

  _applyOptionalNumberOverride(
    defaultConfig,
    "maxTempCleanupRing",
    loadedRaw,
    "ROSMONTIS_MAX_TEMP_CLEANUP_RING",
    "ONEBOT_MAX_TEMP_CLEANUP_RING",
    "XIAO_BRIDGE_MAX_TEMP_CLEANUP_RING"
  );

  _applyOptionalNumberOverride(
    defaultConfig,
    "tempCleanupDelayMs",
    loadedRaw,
    "ROSMONTIS_TEMP_CLEANUP_DELAY_MS",
    "ONEBOT_TEMP_CLEANUP_DELAY_MS",
    "XIAO_BRIDGE_TEMP_CLEANUP_DELAY_MS"
  );

  _applyOptionalNumberOverride(
    defaultConfig,
    "mapHookMaxLifetimeMs",
    loadedRaw,
    "ROSMONTIS_MAP_HOOK_MAX_LIFETIME_MS",
    "ONEBOT_MAP_HOOK_MAX_LIFETIME_MS",
    "XIAO_BRIDGE_MAP_HOOK_MAX_LIFETIME_MS"
  );

  _applyOptionalNumberOverride(
    defaultConfig,
    "mapHookReleaseDelayMs",
    loadedRaw,
    "ROSMONTIS_MAP_HOOK_RELEASE_DELAY_MS",
    "ONEBOT_MAP_HOOK_RELEASE_DELAY_MS",
    "XIAO_BRIDGE_MAP_HOOK_RELEASE_DELAY_MS"
  );

  _applyOptionalNumberOverride(
    defaultConfig,
    "maxSendEchoTimeoutMs",
    loadedRaw,
    "ROSMONTIS_MAX_SEND_ECHO_TIMEOUT_MS",
    "ONEBOT_MAX_SEND_ECHO_TIMEOUT_MS",
    "XIAO_BRIDGE_MAX_SEND_ECHO_TIMEOUT_MS"
  );

  defaultConfig.messageFormat =
    (envMessageFormatRaw ||
      loadedRaw.messageFormat ||
      loadedRaw.post_message_format ||
      "array") === "string"
      ? "string"
      : "array";

  const envCompatProfile = _pickEnv(
    "ROSMONTIS_COMPAT_PROFILE",
    "ONEBOT_COMPAT_PROFILE",
    "XIAO_BRIDGE_COMPAT_PROFILE"
  ).toLowerCase();
  const rawCompatProfile = String(
    envCompatProfile || loadedRaw.compatProfile || loadedRaw.compat_profile || "rosmontis"
  )
    .trim()
    .toLowerCase();
  defaultConfig.compatProfile =
    rawCompatProfile === "snowluma" || rawCompatProfile === "napcat"
      ? rawCompatProfile
      : "rosmontis";

  const envCompatAppName = _pickEnv(
    "ROSMONTIS_COMPAT_APP_NAME",
    "ONEBOT_COMPAT_APP_NAME",
    "XIAO_BRIDGE_COMPAT_APP_NAME"
  );
  const rawCompatAppName = String(
    envCompatAppName || loadedRaw.compatAppName || loadedRaw.compat_app_name || ""
  ).trim();
  if (rawCompatAppName) {
    defaultConfig.compatAppName = rawCompatAppName;
  }
  if (loadedRaw.compatAppVersion || loadedRaw.compat_app_version) {
    defaultConfig.compatAppVersion = String(
      loadedRaw.compatAppVersion || loadedRaw.compat_app_version
    ).trim();
  }

  const envHttpPort = Number(
    _pickEnv("ROSMONTIS_HTTP_PORT", "ONEBOT_HTTP_PORT", "XIAO_BRIDGE_HTTP_PORT") || 0
  );
  const envWsPort = Number(
    _pickEnv("ROSMONTIS_WS_PORT", "ONEBOT_WS_PORT", "XIAO_BRIDGE_WS_PORT") || 0
  );
  const envRevWsUrl = _pickEnv(
    "ROSMONTIS_REVERSE_WS_URL",
    "ONEBOT_REVERSE_WS_URL",
    "XIAO_BRIDGE_REVERSE_WS_URL"
  );
  const envToken = _pickEnv(
    "ROSMONTIS_ACCESS_TOKEN",
    "ONEBOT_ACCESS_TOKEN",
    "XIAO_BRIDGE_ACCESS_TOKEN"
  );
  const listenHost =
    _pickEnv("ROSMONTIS_HOST", "ONEBOT_HOST", "XIAO_BRIDGE_HOST") || "0.0.0.0";

  if (
    defaultConfig.httpServers.length === 0 &&
    (!loadedFromFile || !hasExplicitHttpServersKey || envHttpPort > 0)
  ) {
    defaultConfig.httpServers.push({
      name: "http-default",
      host: listenHost,
      port: envHttpPort || 3000,
      accessToken: envToken,
      reportSelfMessage: false,
    });
  } else if (envHttpPort > 0 && defaultConfig.httpServers.length > 0) {
    defaultConfig.httpServers[0].port = envHttpPort;
  }

  if (
    defaultConfig.wsServers.length === 0 &&
    (!loadedFromFile || !hasExplicitWsServersKey || envWsPort > 0)
  ) {
    defaultConfig.wsServers.push({
      name: "ws-default",
      host: listenHost,
      port: envWsPort || 3001,
      accessToken: envToken,
      reportSelfMessage: false,
    });
  } else if (envWsPort > 0 && defaultConfig.wsServers.length > 0) {
    defaultConfig.wsServers[0].port = envWsPort;
  }

  if (envRevWsUrl) {
    defaultConfig.wsClients = [
      {
        name: "wsclient-env",
        url: envRevWsUrl,
        accessToken: envToken,
        reportSelfMessage: false,
        reconnectIntervalMs: 5000,
      },
    ];
  }

  for (const entry of [
    ...defaultConfig.httpServers,
    ...defaultConfig.wsServers,
    ...defaultConfig.wsClients,
  ]) {
    entry.messageFormat =
      (entry.messageFormat ||
        entry.post_message_format ||
        loadedRaw.messageFormat ||
        loadedRaw.post_message_format ||
        envMessageFormatRaw ||
        "array") === "string"
        ? "string"
        : "array";
  }

  if (envToken) {
    for (const s of defaultConfig.httpServers) s.accessToken = envToken;
    for (const s of defaultConfig.wsServers) s.accessToken = envToken;
    for (const c of defaultConfig.wsClients) c.accessToken = envToken;
  }

  return defaultConfig;
}

function resolveCompatVersionInfo(config = {}, context = {}) {
  const appNameOverride = String(
    context?.compatAppName ?? config?.compatAppName ?? ""
  ).trim();
  const profileRaw = String(
    context?.compatProfile ?? config?.compatProfile ?? "rosmontis"
  )
    .trim()
    .toLowerCase();

  let appName = "Rosmontis";
  if (appNameOverride) {
    appName = appNameOverride;
  } else if (profileRaw === "snowluma") {
    appName = "SnowLuma";
  } else if (profileRaw === "napcat") {
    appName = "NapCat.Onebot";
  }

  const appVersion =
    String(context?.compatAppVersion ?? config?.compatAppVersion ?? "1.0.0").trim() ||
    "1.0.0";

  return {
    app_name: appName,
    app_version: appVersion,
    protocol_version: "v11",
    ...(appName !== "Rosmontis"
      ? { bridge_name: "Rosmontis", bridge_version: "1.0.0" }
      : {}),
  };
}

module.exports = {
  filterEnabledEntries,
  loadBridgeConfig,
  resolveCompatVersionInfo,
};
