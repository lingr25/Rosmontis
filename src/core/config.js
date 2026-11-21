// @ts-check
"use strict";

const fs = require("fs");
const path = require("path");

const envHelpers = require("./env");
const {
  buildPrefixedEnvKeys,
  pickPrefixedEnv,
  parseBoolString,
  parsePrefixedEnvBool,
  resolveConfigDirsFromEnv,
  resolveSilkDecoderPathFromEnv,
  resolveSilkEncoderPathFromEnv,
  resolveStateDirFromEnv,
} = envHelpers;

const {
  DEFAULT_MAX_HTTP_BODY_BYTES,
  DEFAULT_MAX_WS_PAYLOAD_BYTES,
} = require("./transport_security");
const { DEFAULT_MAX_WS_SEND_BUFFER_BYTES } = require("./ws_rfc6455");

function filterEnabledEntries(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (item) => item && typeof item === "object" && item.enable !== false && item.enabled !== false
    )
    .map((item) => ({ ...item }));
}

function _resolveBoolWithDefault(rawVal, defaultVal, suffix, extraKeys = []) {
  const parsedEnv = parsePrefixedEnvBool(suffix, extraKeys);
  if (parsedEnv !== undefined) return parsedEnv;
  if (rawVal !== undefined && rawVal !== null) {
    if (typeof rawVal === "string") {
      const parsedRaw = parseBoolString(rawVal);
      if (parsedRaw !== undefined) return parsedRaw;
    }
    return Boolean(rawVal);
  }
  return defaultVal;
}

function _resolvePositiveIntWithDefault(rawVal, defaultVal, suffix, extraKeys = []) {
  const envRaw = pickPrefixedEnv(suffix, extraKeys);
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

function _resolveNonNegativeNumberWithDefault(rawVal, defaultVal, suffix, extraKeys = []) {
  const envRaw = pickPrefixedEnv(suffix, extraKeys);
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

function _resolveNonNegativeIntWithDefault(rawVal, defaultVal, suffix, extraKeys = []) {
  const envRaw = pickPrefixedEnv(suffix, extraKeys);
  if (envRaw !== "") {
    const envNum = Number(envRaw);
    if (Number.isFinite(envNum) && envNum >= 0) return Math.floor(envNum);
  }
  if (rawVal !== undefined && rawVal !== null && rawVal !== "") {
    const rawNum = Number(rawVal);
    if (Number.isFinite(rawNum) && rawNum >= 0) return Math.floor(rawNum);
  }
  return defaultVal;
}

function _resolvePositiveNumberWithDefault(rawVal, defaultVal, suffix, extraKeys = []) {
  const envRaw = pickPrefixedEnv(suffix, extraKeys);
  if (envRaw !== "") {
    const envNum = Number(envRaw);
    if (Number.isFinite(envNum) && envNum > 0) return envNum;
  }
  if (rawVal !== undefined && rawVal !== null && rawVal !== "") {
    const rawNum = Number(rawVal);
    if (Number.isFinite(rawNum) && rawNum > 0) return rawNum;
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
    } catch (_) {
      // Non-JSON delay spec (e.g. "500-1800" or plain number); fall through to range/numeric parser.
    }
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

function _resolveDelaySpecWithDefault(rawVal, defaultVal, suffix, extraKeys = []) {
  const envRaw = pickPrefixedEnv(suffix, extraKeys);
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

function _applyOptionalBoolOverride(target, key, rawObj, suffix, extraKeys = []) {
  const parsed = parsePrefixedEnvBool(suffix, extraKeys);
  if (parsed !== undefined) {
    target[key] = parsed;
    return;
  }
  if (rawObj && rawObj[key] !== undefined) {
    if (typeof rawObj[key] === "string") {
      const parsedRaw = parseBoolString(rawObj[key]);
      if (parsedRaw !== undefined) {
        target[key] = parsedRaw;
        return;
      }
    }
    target[key] = Boolean(rawObj[key]);
  }
}

function _applyOptionalNumberOverride(target, key, rawObj, suffix, extraKeys = []) {
  const envRaw = pickPrefixedEnv(suffix, extraKeys);
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

/**
 * @param {string} [customConfigDir]
 * @returns {import("../types").BridgeConfig & Record<string, any>}
 */
function loadBridgeConfig(customConfigDir) {
  const envSelfUin = pickPrefixedEnv("SELF_ID");
  const envHeartbeatRaw = pickPrefixedEnv("HEARTBEAT_MS");
  const envMessageFormatRaw = pickPrefixedEnv("MESSAGE_FORMAT").toLowerCase();

  /** @type {Record<string, any>} */
  const defaultConfig = {
    selfUin: envSelfUin,
    selfNickname: pickPrefixedEnv("SELF_NICKNAME") || "Rosmontis",
    httpServers: [],
    wsServers: [],
    wsClients: [],
    httpClients: [],
    heartbeatIntervalMs: envHeartbeatRaw !== "" ? Number(envHeartbeatRaw) : 5000,
  };

  const searchDirs = customConfigDir
    ? [customConfigDir]
    : [
        ...resolveConfigDirsFromEnv(),
        "/etc/rosmontis",
        "/app/data/config",
        "/app/config",
        "/opt/QQ/config",
        path.resolve(__dirname, "..", "..", "config"),
        path.resolve(process.cwd(), "config"),
      ].filter(Boolean);

  let loadedFromFile = false;
  let hasExplicitHttpServersKey = false;
  let hasExplicitWsServersKey = false;
  /** @type {Record<string, any>} */
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
          const enabledHttpClients = filterEnabledEntries(
            nets.httpClients || nets.httpPost || raw?.httpClients
          );
          const hasWsClients =
            enabledWsClients.length > 0 || enabledHttpClients.length > 0;
          parsedEntries.push({
            file,
            uin,
            raw: raw && typeof raw === "object" ? raw : {},
            nets,
            hasWsClients,
            mtimeMs: Number(stat?.mtimeMs || 0),
          });
        } catch (_) {
          // Skip unreadable or malformed candidate config JSON and continue scanning.
        }
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
        if (!defaultConfig.selfUin) {
          const rawSelfUin = String(raw.selfUin ?? raw.self_id ?? uin ?? "").trim();
          if (/^[1-9]\d*$/.test(rawSelfUin)) {
            defaultConfig.selfUin = rawSelfUin;
          }
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
          "mediaHydrationTimeoutMs",
          "richMediaDownloadTimeoutMs",
          "forwardMediaHydrationBudgetMs",
          "dedupeWindowMs",
          "autoQuickLogin",
          "maxMediaBytes",
          "allowPrivateMediaUrls",
          "allowPrivateUrls",
          "allowArbitraryLocalFiles",
          "allowedFileDirs",
          "ffmpegPath",
          "silkDecoderPath",
          "silkEncoderPath",
          "silkAddonPath",
          "nodeBinPath",
          "stateDir",
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
        defaultConfig.httpClients.push(
          ...filterEnabledEntries(nets.httpClients || nets.httpPost || raw?.httpClients)
        );
        loadedFromFile = true;
      }
      if (loadedFromFile) break;
    } catch (_) {
      // Candidate config directory may not exist or lack read permissions; try next searchDir.
    }
  }

  // Logging, diagnostics & runtime flags (JSON + env overrides)
  defaultConfig.debugLogs = _resolveBoolWithDefault(loadedRaw.debugLogs, false, "DEBUG");
  defaultConfig.quietLogs = _resolveBoolWithDefault(loadedRaw.quietLogs, false, "QUIET");
  const envLogFormat = pickPrefixedEnv("LOG_FORMAT").toLowerCase();
  const rawLogFormat = String(
    envLogFormat || loadedRaw.logFormat || loadedRaw.log_format || "text"
  )
    .trim()
    .toLowerCase();
  defaultConfig.logFormat = rawLogFormat === "json" ? "json" : "text";
  defaultConfig.enableMetrics = _resolveBoolWithDefault(
    loadedRaw.enableMetrics ?? loadedRaw.enable_metrics,
    true,
    "ENABLE_METRICS"
  );
  defaultConfig.reloadOnSighup = _resolveBoolWithDefault(
    loadedRaw.reloadOnSighup ?? loadedRaw.reload_on_sighup,
    true,
    "RELOAD_ON_SIGHUP"
  );
  defaultConfig.webhookMaxConcurrency = _resolvePositiveIntWithDefault(
    loadedRaw.webhookMaxConcurrency ?? loadedRaw.webhook_max_concurrency,
    8,
    "WEBHOOK_MAX_CONCURRENCY"
  );
  defaultConfig.webhookMaxQueueSize = _resolvePositiveIntWithDefault(
    loadedRaw.webhookMaxQueueSize ?? loadedRaw.webhook_max_queue_size,
    256,
    "WEBHOOK_MAX_QUEUE_SIZE"
  );
  defaultConfig.webhookMaxRetries = _resolveNonNegativeIntWithDefault(
    loadedRaw.webhookMaxRetries ?? loadedRaw.webhook_max_retries,
    2,
    "WEBHOOK_MAX_RETRIES"
  );
  defaultConfig.webhookRetryBaseMs = _resolveNonNegativeIntWithDefault(
    loadedRaw.webhookRetryBaseMs ?? loadedRaw.webhook_retry_base_ms,
    250,
    "WEBHOOK_RETRY_BASE_MS"
  );
  defaultConfig.rendererAutoReload = _resolveBoolWithDefault(
    loadedRaw.rendererAutoReload ?? loadedRaw.renderer_auto_reload,
    true,
    "RENDERER_AUTO_RELOAD"
  );
  defaultConfig.rendererMaxReloadsPerMinute = _resolvePositiveIntWithDefault(
    loadedRaw.rendererMaxReloadsPerMinute ?? loadedRaw.renderer_max_reloads_per_minute,
    3,
    "RENDERER_MAX_RELOADS_PER_MINUTE"
  );
  defaultConfig.rendererReloadBackoffMs = _resolveNonNegativeIntWithDefault(
    loadedRaw.rendererReloadBackoffMs ?? loadedRaw.renderer_reload_backoff_ms,
    1500,
    "RENDERER_RELOAD_BACKOFF_MS"
  );
  const rawRateLimit =
    loadedRaw.rateLimit &&
    typeof loadedRaw.rateLimit === "object" &&
    !Array.isArray(loadedRaw.rateLimit)
      ? loadedRaw.rateLimit
      : loadedRaw.rate_limit &&
        typeof loadedRaw.rate_limit === "object" &&
        !Array.isArray(loadedRaw.rate_limit)
      ? loadedRaw.rate_limit
      : {};
  defaultConfig.rateLimit = {
    enabled: _resolveBoolWithDefault(
      rawRateLimit.enabled ?? rawRateLimit.enable,
      false,
      "RATE_LIMIT_ENABLE",
      buildPrefixedEnvKeys("RATE_LIMIT_ENABLED")
    ),
    globalPerSec: _resolvePositiveNumberWithDefault(
      rawRateLimit.globalPerSec ?? rawRateLimit.global_per_sec,
      10,
      "RATE_LIMIT_GLOBAL_PER_SEC"
    ),
    globalBurst: _resolvePositiveNumberWithDefault(
      rawRateLimit.globalBurst ?? rawRateLimit.global_burst,
      20,
      "RATE_LIMIT_GLOBAL_BURST"
    ),
    perPeerPerSec: _resolvePositiveNumberWithDefault(
      rawRateLimit.perPeerPerSec ?? rawRateLimit.per_peer_per_sec,
      2,
      "RATE_LIMIT_PER_PEER_PER_SEC"
    ),
    perPeerBurst: _resolvePositiveNumberWithDefault(
      rawRateLimit.perPeerBurst ?? rawRateLimit.per_peer_burst,
      5,
      "RATE_LIMIT_PER_PEER_BURST"
    ),
    circuitBreakerThreshold: _resolvePositiveIntWithDefault(
      rawRateLimit.circuitBreakerThreshold ?? rawRateLimit.circuit_breaker_threshold,
      5,
      "RATE_LIMIT_CB_THRESHOLD"
    ),
    circuitBreakerCooldownMs: _resolveNonNegativeIntWithDefault(
      rawRateLimit.circuitBreakerCooldownMs ?? rawRateLimit.circuit_breaker_cooldown_ms,
      30000,
      "RATE_LIMIT_CB_COOLDOWN_MS"
    ),
  };
  defaultConfig.keepMapHook = _resolveBoolWithDefault(
    loadedRaw.keepMapHook,
    false,
    "KEEP_MAP_HOOK"
  );

  const envTempDir = pickPrefixedEnv("TEMP_DIR");
  const rawTempDir = typeof loadedRaw.tempDir === "string" ? loadedRaw.tempDir.trim() : "";
  if (envTempDir || rawTempDir) {
    defaultConfig.tempDir = envTempDir || rawTempDir;
  }

  // Security & transport configuration keys (JSON + env overrides)
  defaultConfig.enableWebCredentialApi = _resolveBoolWithDefault(
    loadedRaw.enableWebCredentialApi,
    false,
    "ENABLE_WEB_CREDENTIAL_API"
  );

  defaultConfig.allowUnauthenticatedPublicBind = _resolveBoolWithDefault(
    loadedRaw.allowUnauthenticatedPublicBind,
    false,
    "ALLOW_UNAUTHENTICATED_PUBLIC"
  );

  defaultConfig.allowQueryAccessToken = _resolveBoolWithDefault(
    loadedRaw.allowQueryAccessToken,
    true,
    "ALLOW_QUERY_TOKEN"
  );

  const envAllowedOrigins = pickPrefixedEnv("ALLOWED_ORIGINS");
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
    "MAX_HTTP_BODY_BYTES"
  );

  defaultConfig.maxWsPayloadBytes = _resolvePositiveIntWithDefault(
    loadedRaw.maxWsPayloadBytes,
    DEFAULT_MAX_WS_PAYLOAD_BYTES,
    "MAX_WS_PAYLOAD_BYTES"
  );

  defaultConfig.maxWsSendBufferBytes = _resolvePositiveIntWithDefault(
    loadedRaw.maxWsSendBufferBytes,
    DEFAULT_MAX_WS_SEND_BUFFER_BYTES,
    "MAX_WS_SEND_BUFFER_BYTES"
  );

  defaultConfig.wsPingIntervalMs = _resolveNonNegativeNumberWithDefault(
    loadedRaw.wsPingIntervalMs,
    30000,
    "WS_PING_INTERVAL_MS"
  );

  defaultConfig.wsPongTimeoutMs = _resolvePositiveIntWithDefault(
    loadedRaw.wsPongTimeoutMs,
    90000,
    "WS_PONG_TIMEOUT_MS"
  );

  defaultConfig.forwardEchoTimeoutMs = _resolveNonNegativeNumberWithDefault(
    loadedRaw.forwardEchoTimeoutMs,
    0,
    "FORWARD_ECHO_TIMEOUT_MS"
  );

  defaultConfig.forwardMediaHydrationBudgetMs = _resolvePositiveIntWithDefault(
    loadedRaw.forwardMediaHydrationBudgetMs,
    3500,
    "FORWARD_MEDIA_HYDRATION_BUDGET_MS"
  );

  _applyOptionalBoolOverride(
    defaultConfig,
    "allowPtloginJump",
    loadedRaw,
    "ALLOW_PTLOGIN_JUMP"
  );

  _applyOptionalBoolOverride(
    defaultConfig,
    "allowExternalHttp",
    loadedRaw,
    "ALLOW_EXTERNAL_HTTP"
  );

  // Causal timeline & runtime lifecycle keys
  defaultConfig.autoReadAndTypeOnPrivateRecv = _resolveBoolWithDefault(
    loadedRaw.autoReadAndTypeOnPrivateRecv,
    false,
    "AUTO_READ_AND_TYPE_ON_PRIVATE_RECV"
  );

  defaultConfig.autoReadReactionDelayMs = _resolveDelaySpecWithDefault(
    loadedRaw.autoReadReactionDelayMs,
    [500, 1800],
    "AUTO_READ_REACTION_DELAY_MS"
  );

  defaultConfig.aioSwitchCooldownMs = _resolveNonNegativeNumberWithDefault(
    loadedRaw.aioSwitchCooldownMs,
    800,
    "AIO_SWITCH_COOLDOWN_MS"
  );

  defaultConfig.humanReadToTypingDelayMs = _resolveDelaySpecWithDefault(
    loadedRaw.humanReadToTypingDelayMs,
    0,
    "HUMAN_READ_TO_TYPING_DELAY_MS"
  );

  _applyOptionalBoolOverride(
    defaultConfig,
    "cleanupTempImmediately",
    loadedRaw,
    "CLEANUP_TEMP_IMMEDIATELY"
  );

  _applyOptionalNumberOverride(
    defaultConfig,
    "maxTempCleanupRing",
    loadedRaw,
    "MAX_TEMP_CLEANUP_RING"
  );

  _applyOptionalNumberOverride(
    defaultConfig,
    "tempCleanupDelayMs",
    loadedRaw,
    "TEMP_CLEANUP_DELAY_MS"
  );

  _applyOptionalNumberOverride(
    defaultConfig,
    "mapHookMaxLifetimeMs",
    loadedRaw,
    "MAP_HOOK_MAX_LIFETIME_MS"
  );

  _applyOptionalNumberOverride(
    defaultConfig,
    "mapHookReleaseDelayMs",
    loadedRaw,
    "MAP_HOOK_RELEASE_DELAY_MS"
  );

  _applyOptionalNumberOverride(
    defaultConfig,
    "maxSendEchoTimeoutMs",
    loadedRaw,
    "MAX_SEND_ECHO_TIMEOUT_MS"
  );

  defaultConfig.messageFormat =
    (envMessageFormatRaw ||
      loadedRaw.messageFormat ||
      loadedRaw.post_message_format ||
      "array") === "string"
      ? "string"
      : "array";

  const envFfmpegPath = pickPrefixedEnv("FFMPEG_PATH", ["FFMPEG_PATH"]);
  const rawFfmpegPath = String(
    envFfmpegPath || loadedRaw.ffmpegPath || loadedRaw.ffmpeg_path || ""
  ).trim();
  if (rawFfmpegPath) {
    defaultConfig.ffmpegPath = rawFfmpegPath;
  }

  const resolvedSilkDecoder = resolveSilkDecoderPathFromEnv(
    loadedRaw.silkDecoderPath || loadedRaw.silk_decoder_path || loadedRaw.silkCodecPath || ""
  );
  if (resolvedSilkDecoder) {
    defaultConfig.silkDecoderPath = resolvedSilkDecoder;
  }

  const resolvedSilkEncoder = resolveSilkEncoderPathFromEnv(
    loadedRaw.silkEncoderPath || loadedRaw.silk_encoder_path || ""
  );
  if (resolvedSilkEncoder) {
    defaultConfig.silkEncoderPath = resolvedSilkEncoder;
  }

  const envSilkAddonPath = pickPrefixedEnv("SILK_ADDON_PATH", ["FFMPEG_ADDON_PATH"]);
  const rawSilkAddonPath = String(
    envSilkAddonPath || loadedRaw.silkAddonPath || loadedRaw.silk_addon_path || ""
  ).trim();
  if (rawSilkAddonPath) {
    defaultConfig.silkAddonPath = rawSilkAddonPath;
  } else if (loadedRaw.silkAddonPath === false || loadedRaw.silk_addon_path === false) {
    defaultConfig.silkAddonPath = false;
  }

  const envNodeBinPath = pickPrefixedEnv("NODE_BIN", ["NODE_BIN"]);
  const rawNodeBinPath = String(
    envNodeBinPath || loadedRaw.nodeBinPath || loadedRaw.node_bin_path || ""
  ).trim();
  if (rawNodeBinPath) {
    defaultConfig.nodeBinPath = rawNodeBinPath;
  }

  const resolvedStateDir = resolveStateDirFromEnv(
    loadedRaw.stateDir || loadedRaw.state_dir || ""
  );
  if (resolvedStateDir) {
    defaultConfig.stateDir = resolvedStateDir;
  }

  _applyOptionalBoolOverride(defaultConfig, "persistStores", loadedRaw, "PERSIST_STORES");
  _applyOptionalNumberOverride(
    defaultConfig,
    "statePersistDebounceMs",
    loadedRaw,
    "STATE_PERSIST_DEBOUNCE_MS"
  );
  _applyOptionalNumberOverride(
    defaultConfig,
    "maxForwardCustomNodes",
    loadedRaw,
    "MAX_FORWARD_CUSTOM_NODES"
  );
  _applyOptionalNumberOverride(
    defaultConfig,
    "forwardStageDelayMs",
    loadedRaw,
    "FORWARD_STAGE_DELAY_MS"
  );
  _applyOptionalNumberOverride(
    defaultConfig,
    "inboundMediaConcurrency",
    loadedRaw,
    "INBOUND_MEDIA_CONCURRENCY"
  );
  _applyOptionalNumberOverride(
    defaultConfig,
    "uploadFileUuidWaitMs",
    loadedRaw,
    "UPLOAD_FILE_UUID_WAIT_MS"
  );
  _applyOptionalNumberOverride(
    defaultConfig,
    "httpPostTimeoutMs",
    loadedRaw,
    "HTTP_POST_TIMEOUT_MS"
  );

  defaultConfig.preferMainProcessForBulkReads = _resolveBoolWithDefault(
    loadedRaw.preferMainProcessForBulkReads ?? loadedRaw.prefer_main_process_for_bulk_reads,
    false,
    "PREFER_MAIN_PROCESS_FOR_BULK_READS"
  );

  const envCompatProfile = pickPrefixedEnv("COMPAT_PROFILE").toLowerCase();
  const rawCompatProfile = String(
    envCompatProfile || loadedRaw.compatProfile || loadedRaw.compat_profile || "rosmontis"
  )
    .trim()
    .toLowerCase();
  defaultConfig.compatProfile =
    rawCompatProfile === "snowluma" || rawCompatProfile === "napcat"
      ? rawCompatProfile
      : "rosmontis";

  const envCompatAppName = pickPrefixedEnv("COMPAT_APP_NAME");
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

  const envHttpPort = Number(pickPrefixedEnv("HTTP_PORT") || 0);
  const envWsPort = Number(pickPrefixedEnv("WS_PORT") || 0);
  const envRevWsUrl = pickPrefixedEnv("REVERSE_WS_URL");
  const envHttpPostUrl = pickPrefixedEnv("HTTP_POST_URL");
  const envHttpSecret = pickPrefixedEnv("HTTP_SECRET");
  const envToken = pickPrefixedEnv("ACCESS_TOKEN");
  const listenHost = pickPrefixedEnv("HOST") || "0.0.0.0";

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

  if (envHttpPostUrl) {
    defaultConfig.httpClients = [
      {
        name: "httpclient-env",
        url: envHttpPostUrl,
        accessToken: envToken,
        ...(envHttpSecret ? { secret: envHttpSecret } : {}),
        reportSelfMessage: false,
        timeoutMs: 5000,
      },
    ];
  }

  for (const entry of [
    ...defaultConfig.httpServers,
    ...defaultConfig.wsServers,
    ...defaultConfig.wsClients,
    ...defaultConfig.httpClients,
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
    for (const c of defaultConfig.httpClients) c.accessToken = envToken;
  }

  if (envHttpSecret) {
    for (const c of defaultConfig.httpClients) c.secret = envHttpSecret;
  }

  return /** @type {import("../types").BridgeConfig & Record<string, any>} */ (defaultConfig);
}

/**
 * @param {Record<string, any>} [config]
 * @param {Record<string, any>} [context]
 */
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
  ...envHelpers,
  filterEnabledEntries,
  loadBridgeConfig,
  resolveCompatVersionInfo,
};
