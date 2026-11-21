// @ts-check
"use strict";

/**
 * Runtime Capability Probe (`src/core/capability_probe.js`)
 *
 * Read-only inspection of captured NTQQ main-process services (`ntApi` / `ntApi.invoke`,
 * `wrapperSession`, `ntStore.wrapperSession`, `ntSessionManager.ntStore.wrapperSession`)
 * to report actual exposed kernel RPC capabilities and configured media tools without
 * invoking any side-effecting kernel calls.
 */

const { SERVICE_GETTER_MAP } = require("./renderer_ipc");
const {
  resolveFfmpegPathFromEnv,
  resolveSilkEncoderPathFromEnv,
  resolveSilkDecoderPathFromEnv,
} = require("./env");

const DEFAULT_PROBE_CACHE_TTL_MS = 10000;
const WILDCARD_PROBE_KEY = "__rosmontis_probe__/__nonexistent__";

function countNtApiMethods(ntApiTarget) {
  if (!ntApiTarget || (typeof ntApiTarget !== "object" && typeof ntApiTarget !== "function")) {
    return 0;
  }
  let count = 0;
  try {
    const keys = Object.getOwnPropertyNames(ntApiTarget);
    for (const key of keys) {
      if (typeof key !== "string" || !key.includes("/")) continue;
      try {
        if (typeof ntApiTarget[key] === "function") {
          count += 1;
        }
      } catch (_err) {
        // Ignore inaccessible proxy/getter properties while counting callable ntApi routes
      }
    }
  } catch (_err) {
    // Ignore proxy/object reflection errors when enumerating ntApi keys
  }
  return count;
}

function isWildcardNtApiProxy(ntApiTarget) {
  if (!ntApiTarget || (typeof ntApiTarget !== "object" && typeof ntApiTarget !== "function")) {
    return false;
  }
  try {
    return typeof ntApiTarget[WILDCARD_PROBE_KEY] === "function";
  } catch (_) {
    return false;
  }
}

/**
 * @param {import("../types").CapabilityProbeHost | null | undefined} bridge
 */
function resolveNtApiTarget(bridge) {
  const raw = bridge?.capturedServices?.ntApi;
  if (!raw || (typeof raw !== "object" && typeof raw !== "function")) {
    return null;
  }
  try {
    if (typeof raw["nodeIKernelMsgService/sendMsg"] === "function") {
      return raw;
    }
  } catch (_err) {
    // Property probe threw on host proxy; fall through to ntApi.invoke check
  }
  try {
    const inv = raw.invoke;
    if (inv && (typeof inv === "object" || typeof inv === "function")) {
      if (typeof inv["nodeIKernelMsgService/sendMsg"] === "function") {
        return inv;
      }
      if (countNtApiMethods(raw) === 0) {
        return inv;
      }
    }
  } catch (_err) {
    // Ignore errors probing raw.invoke; fall back to raw ntApi target
  }
  return raw;
}

/**
 * @param {import("../types").CapabilityProbeHost | null | undefined} bridge
 */
function resolveWrapperSession(bridge) {
  const cs = bridge?.capturedServices;
  if (!cs || typeof cs !== "object") return null;
  return (
    cs.wrapperSession ||
    cs.ntStore?.wrapperSession ||
    cs.ntStore?.session ||
    cs.ntSessionManager?.ntStore?.wrapperSession ||
    cs.ntSessionManager?.ntStore?.session ||
    null
  );
}

function resolveServiceGetterName(serviceName) {
  if (!serviceName || typeof serviceName !== "string") return "";
  if (SERVICE_GETTER_MAP[serviceName]) {
    return SERVICE_GETTER_MAP[serviceName];
  }
  if (serviceName.startsWith("nodeIKernel") && serviceName.endsWith("Service")) {
    return `get${serviceName.slice("nodeIKernel".length)}`;
  }
  return "";
}

function listWrapperServices(session) {
  if (!session || (typeof session !== "object" && typeof session !== "function")) {
    return [];
  }
  const found = new Set();

  // Check known NTQQ service getters from SERVICE_GETTER_MAP
  const knownGetters = new Set(Object.values(SERVICE_GETTER_MAP));
  for (const getterName of knownGetters) {
    try {
      if (typeof session[getterName] === "function") {
        found.add(getterName);
      }
    } catch (_err) {
      // Ignore throwing getter descriptors during read-only service discovery
    }
  }

  // Also scan own and prototype method descriptors (skipping accessors) for additional get*Service getters
  let cursor = session;
  let depth = 0;
  while (cursor && cursor !== Object.prototype && depth < 5) {
    try {
      const names = Object.getOwnPropertyNames(cursor);
      for (const name of names) {
        if (!/^get[A-Z].*Service$/.test(name)) continue;
        try {
          const desc = Object.getOwnPropertyDescriptor(cursor, name);
          if (desc && "value" in desc && typeof desc.value === "function") {
            found.add(name);
          }
        } catch (_err) {
          // Ignore non-inspectable descriptors on native wrapper prototypes
        }
      }
    } catch (_err) {
      // Ignore prototype levels whose own property names cannot be enumerated
    }
    try {
      cursor = Object.getPrototypeOf(cursor);
    } catch (_) {
      break;
    }
    depth += 1;
  }

  return Array.from(found).sort();
}

function hasKernelMethodOnResolved(
  ntApiTarget,
  ntApiWildcard,
  wrapperSession,
  serviceCache,
  serviceName,
  methodName
) {
  if (
    !serviceName ||
    typeof serviceName !== "string" ||
    !methodName ||
    typeof methodName !== "string"
  ) {
    return false;
  }

  // 1. Inspect live wrapperSession service instance (most authoritative)
  if (wrapperSession) {
    const getterName = resolveServiceGetterName(serviceName);
    if (getterName) {
      let svc = null;
      if (serviceCache && serviceCache.has(getterName)) {
        svc = serviceCache.get(getterName);
      } else {
        try {
          if (typeof wrapperSession[getterName] === "function") {
            svc = wrapperSession[getterName]() || null;
          }
        } catch (_) {
          svc = null;
        }
        if (serviceCache) {
          serviceCache.set(getterName, svc);
        }
      }
      if (svc && (typeof svc === "object" || typeof svc === "function")) {
        try {
          if (typeof svc[methodName] === "function") {
            return true;
          }
        } catch (_err) {
          // Ignore property probe failure on native service object; fall back to ntApi
        }
      }
    }
  }

  // 2. Inspect explicit / selective ntApi route table (never trust a catch-all wildcard Proxy)
  if (ntApiTarget && !ntApiWildcard) {
    const cmd = `${serviceName}/${methodName}`;
    try {
      if (typeof ntApiTarget[cmd] === "function") {
        return true;
      }
    } catch (_err) {
      // Ignore route probe failure on ntApi object
    }
  }

  return false;
}

/**
 * Read-only check for whether a specific NTQQ kernel RPC (`serviceName/methodName`)
 * is actually exposed by the captured `wrapperSession` or explicit `ntApi` runtime.
 *
 * @param {import("../types").CapabilityProbeHost | null | undefined} bridge
 * @param {string} serviceName
 * @param {string} methodName
 * @returns {boolean}
 */
function hasKernelMethod(bridge, serviceName, methodName) {
  const ntApiTarget = resolveNtApiTarget(bridge);
  const ntApiWildcard = isWildcardNtApiProxy(ntApiTarget);
  const wrapperSession = resolveWrapperSession(bridge);
  return hasKernelMethodOnResolved(
    ntApiTarget,
    ntApiWildcard,
    wrapperSession,
    null,
    serviceName,
    methodName
  );
}

/**
 * Probes runtime NTQQ kernel capabilities and configured media tools.
 * Results are lightly cached on `bridge._capabilityProbeCache` and auto-invalidated
 * when captured service references or web-credential gating change (or via `forceRefresh`).
 *
 * @param {import("../types").CapabilityProbeHost | null | undefined} bridge
 * @param {object} [options]
 * @param {boolean} [options.forceRefresh=false]
 * @param {number} [options.ttlMs=10000]
 * @returns {import("../types").CapabilityProbeResult}
 */
function probeRuntimeCapabilities(bridge, options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const forceRefresh = Boolean(opts.forceRefresh);
  const ttlMs =
    Number.isFinite(Number(opts.ttlMs)) && Number(opts.ttlMs) >= 0
      ? Number(opts.ttlMs)
      : DEFAULT_PROBE_CACHE_TTL_MS;

  const now = Date.now();
  const ntApiTarget = resolveNtApiTarget(bridge);
  const wrapperSession = resolveWrapperSession(bridge);
  const configRef = bridge?.config || null;
  const webCredentialsEnabled = Boolean(configRef?.enableWebCredentialApi);
  const isOnline = Boolean(bridge?.online);

  const cached = bridge && typeof bridge === "object" ? bridge._capabilityProbeCache : null;
  if (
    !forceRefresh &&
    cached &&
    cached.result &&
    cached.result.notes?.sessionInitialized !== false &&
    ttlMs > 0 &&
    now - cached.at < ttlMs &&
    cached.ntApiRef === ntApiTarget &&
    cached.wrapperSessionRef === wrapperSession &&
    cached.configRef === configRef &&
    cached.webCredentials === webCredentialsEnabled &&
    cached.online === isOnline
  ) {
    return cached.result;
  }

  const ntApiWildcard = isWildcardNtApiProxy(ntApiTarget);
  const serviceCache = new Map();
  const hasMethod = (serviceName, methodName) =>
    hasKernelMethodOnResolved(
      ntApiTarget,
      ntApiWildcard,
      wrapperSession,
      serviceCache,
      serviceName,
      methodName
    );
  const hasAny = (pairs) => pairs.some(([svc, method]) => hasMethod(svc, method));

  const hasSendMsg = hasMethod("nodeIKernelMsgService", "sendMsg");
  const hasCopyExif = hasMethod("nodeIKernelMsgService", "copyFileWithDelExifInfo");
  const hasRichMediaPath = hasMethod("nodeIKernelMsgService", "getRichMediaFilePathForGuild");

  const capabilities = {
    send_msg: hasSendMsg,
    send_image: hasSendMsg,
    send_record: hasSendMsg,
    send_video: hasSendMsg,
    send_file:
      hasSendMsg || hasMethod("nodeIKernelRichMediaService", "uploadGroupFile"),
    recall_msg: hasMethod("nodeIKernelMsgService", "recallMsg"),
    forward_msg: hasAny([
      ["nodeIKernelMsgService", "forwardMsg"],
      ["nodeIKernelMsgService", "multiForwardMsg"],
      ["nodeIKernelMsgService", "forwardMsgWithComment"],
      ["nodeIKernelMsgService", "multiForwardMsgWithComment"],
    ]),
    group_special_title: hasAny([
      ["nodeIKernelGroupService", "modifyMemberSpecialTitle"],
      ["nodeIKernelGroupService", "setMemberSpecialTitle"],
    ]),
    group_essence: hasAny([
      ["nodeIKernelGroupService", "addGroupEssence"],
      ["nodeIKernelMsgService", "addGroupEssence"],
    ]),
    group_notice: hasMethod("nodeIKernelGroupService", "publishGroupBulletin"),
    emoji_like: hasMethod("nodeIKernelMsgService", "setMsgEmojiLikes"),
    poke: hasAny([
      ["nodeIKernelMsgService", "sendNudge"],
      ["nodeIKernelMsgService", "sendPoke"],
    ]),
    ocr_image: hasAny([
      ["nodeIKernelNodeMiscService", "ocrImage"],
      ["nodeIKernelMsgService", "ocrImage"],
      ["nodeIKernelRichMediaService", "getScreenOCR"],
      ["nodeIKernelNodeMiscService", "wantWinScreenOCR"],
    ]),
    voice_to_text: hasMethod("nodeIKernelMsgService", "translatePtt2Text"),
    web_credentials: webCredentialsEnabled,
  };

  const ffmpegPath = resolveFfmpegPathFromEnv(bridge?.config?.ffmpegPath);
  const silkEncoderPath = resolveSilkEncoderPathFromEnv(bridge?.config?.silkEncoderPath);
  const silkDecoderPath = resolveSilkDecoderPathFromEnv(bridge?.config?.silkDecoderPath);
  const ntApiMethodCount = countNtApiMethods(ntApiTarget);

  const hasMsgServiceGetter = Boolean(
    wrapperSession && typeof wrapperSession.getMsgService === "function"
  );
  const hasGroupServiceGetter = Boolean(
    wrapperSession && typeof wrapperSession.getGroupService === "function"
  );
  const wrapperSessionInitialized = Boolean(
    wrapperSession &&
      ((hasMsgServiceGetter && Boolean(serviceCache.get("getMsgService"))) ||
        (hasGroupServiceGetter && Boolean(serviceCache.get("getGroupService"))) ||
        (!hasMsgServiceGetter && !hasGroupServiceGetter))
  );
  const hasExplicitNtApi = Boolean(ntApiTarget && !ntApiWildcard && ntApiMethodCount > 0);
  const sessionInitialized = wrapperSessionInitialized || hasExplicitNtApi;

  const result = {
    probedAt: now,
    runtimeDetected: Boolean(ntApiTarget || wrapperSession),
    ntApiMethodCount,
    wrapperServices: listWrapperServices(wrapperSession),
    mediaTools: {
      ffmpegPath,
      silkEncoderConfigured: Boolean(silkEncoderPath),
      silkDecoderConfigured: Boolean(silkDecoderPath),
    },
    capabilities,
    notes: {
      copyFileWithDelExifInfo: hasCopyExif,
      getRichMediaFilePathForGuild: hasRichMediaPath,
      opaqueNtApiProxy: Boolean(ntApiWildcard && !wrapperSessionInitialized),
      sessionInitialized,
    },
  };

  if (bridge && typeof bridge === "object") {
    bridge._capabilityProbeCache = {
      at: now,
      ntApiRef: ntApiTarget,
      wrapperSessionRef: wrapperSession,
      configRef,
      webCredentials: webCredentialsEnabled,
      online: isOnline,
      result,
    };
  }

  return result;
}

module.exports = {
  DEFAULT_PROBE_CACHE_TTL_MS,
  hasKernelMethod,
  probeRuntimeCapabilities,
};
