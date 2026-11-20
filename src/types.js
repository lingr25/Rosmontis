// @ts-check
"use strict";

/**
 * Shared JSDoc Type Contracts for Rosmontis (`src/types.js`)
 *
 * Pure type-annotation module (zero runtime overhead, zero dependencies) enabling
 * IDE autocompletion and JSDoc contract verification across `src/` and `test/`.
 */

/**
 * Delay specification in milliseconds: either a fixed non-negative number or a
 * `[minMs, maxMs]` uniform jitter range.
 * @typedef {number | [number, number]} DelaySpec
 */

/**
 * OneBot v11 message payload encoding format.
 * @typedef {"array" | "string"} MessageFormat
 */

/**
 * Compatibility identity profile reported by `get_version_info`.
 * @typedef {"rosmontis" | "snowluma" | "napcat"} CompatProfile
 */

/**
 * HTTP API or Forward WebSocket listener endpoint configuration.
 * @typedef {object} EndpointServerConfig
 * @property {string} [name]
 * @property {string} host
 * @property {number} port
 * @property {string} [accessToken]
 * @property {boolean} [reportSelfMessage]
 * @property {MessageFormat} [messageFormat]
 * @property {boolean} [enable]
 * @property {boolean} [enabled]
 */

/**
 * Reverse WebSocket client endpoint configuration.
 * @typedef {object} ReverseWsClientConfig
 * @property {string} [name]
 * @property {string} url
 * @property {string} [accessToken]
 * @property {boolean} [reportSelfMessage]
 * @property {number} [reconnectIntervalMs]
 * @property {MessageFormat} [messageFormat]
 * @property {boolean} [enable]
 * @property {boolean} [enabled]
 */

/**
 * Outbound HTTP POST (Webhook) event push client configuration.
 * @typedef {object} HttpPostClientConfig
 * @property {string} [name]
 * @property {string} url
 * @property {string} [secret]
 * @property {string} [accessToken]
 * @property {number} [timeoutMs]
 * @property {boolean} [reportSelfMessage]
 * @property {boolean} [enableHeartbeat]
 * @property {MessageFormat} [messageFormat]
 * @property {CompatProfile} [compatProfile]
 * @property {boolean} [enable]
 * @property {boolean} [enabled]
 */

/**
 * Resolved Rosmontis bridge runtime configuration.
 * @typedef {object} BridgeConfig
 * @property {string} [selfUin]
 * @property {string} [selfNickname]
 * @property {string} [tempDir]
 * @property {EndpointServerConfig[]} httpServers
 * @property {EndpointServerConfig[]} wsServers
 * @property {ReverseWsClientConfig[]} wsClients
 * @property {HttpPostClientConfig[]} [httpClients]
 * @property {number} heartbeatIntervalMs
 * @property {MessageFormat} [messageFormat]
 * @property {boolean} [humanSimulation]
 * @property {number} [aioIdleExitMs]
 * @property {number} [focusIdleBlurMs]
 * @property {number} [sendEchoTimeoutMs]
 * @property {number} [richMediaEchoTimeoutMs]
 * @property {number} [sendRichMediaEchoTimeoutMs]
 * @property {number} [maxSendEchoTimeoutMs]
 * @property {number} [forwardEchoTimeoutMs]
 * @property {number} [dedupeWindowMs]
 * @property {boolean} [autoQuickLogin]
 * @property {boolean} [keepMapHook]
 * @property {number} [mapHookMaxLifetimeMs]
 * @property {number} [mapHookReleaseDelayMs]
 * @property {boolean} [quietLogs]
 * @property {boolean} [debugLogs]
 * @property {number} [maxMediaBytes]
 * @property {boolean} [allowPrivateMediaUrls]
 * @property {boolean} [allowPrivateUrls]
 * @property {boolean} [allowArbitraryLocalFiles]
 * @property {string[]} [allowedFileDirs]
 * @property {string} [ffmpegPath]
 * @property {string} [silkDecoderPath]
 * @property {string} [silkEncoderPath]
 * @property {string} [stateDir]
 * @property {boolean} [persistStores]
 * @property {number} [statePersistDebounceMs]
 * @property {number} [maxForwardCustomNodes]
 * @property {number} [forwardStageDelayMs]
 * @property {number} [inboundMediaConcurrency]
 * @property {number} [mediaHydrationTimeoutMs]
 * @property {number} [richMediaDownloadTimeoutMs]
 * @property {number} [uploadFileUuidWaitMs]
 * @property {number} [httpPostTimeoutMs]
 * @property {boolean} [enableWebCredentialApi]
 * @property {boolean} [allowUnauthenticatedPublicBind]
 * @property {boolean} [allowQueryAccessToken]
 * @property {string[]} [allowedOrigins]
 * @property {number} [maxHttpBodyBytes]
 * @property {number} [maxWsPayloadBytes]
 * @property {number} [maxWsSendBufferBytes]
 * @property {boolean} [allowUnmaskedClientFrames]
 * @property {number} [wsPingIntervalMs]
 * @property {number} [wsPongTimeoutMs]
 * @property {boolean} [allowPtloginJump]
 * @property {boolean} [allowExternalHttp]
 * @property {boolean} [autoReadAndTypeOnPrivateRecv]
 * @property {DelaySpec} [autoReadReactionDelayMs]
 * @property {number} [aioSwitchCooldownMs]
 * @property {DelaySpec} [humanReadToTypingDelayMs]
 * @property {boolean} [cleanupTempImmediately]
 * @property {number} [maxTempCleanupRing]
 * @property {number} [tempCleanupDelayMs]
 * @property {CompatProfile} [compatProfile]
 * @property {string} [compatAppName]
 * @property {string} [compatAppVersion]
 * @property {"text" | "json"} [logFormat]
 * @property {boolean} [enableMetrics]
 * @property {boolean} [reloadOnSighup]
 * @property {number} [webhookMaxConcurrency]
 * @property {number} [webhookMaxQueueSize]
 * @property {number} [webhookMaxRetries]
 * @property {number} [webhookRetryBaseMs]
 * @property {boolean} [rendererAutoReload]
 * @property {number} [rendererMaxReloadsPerMinute]
 * @property {number} [rendererReloadBackoffMs]
 * @property {boolean} [preferMainProcessForBulkReads]
 * @property {RateLimitConfig} [rateLimit]
 */

/**
 * Runtime capability probe snapshot returned by `probeRuntimeCapabilities` / `get_capabilities`.
 * @typedef {object} CapabilityProbeResult
 * @property {number} probedAt
 * @property {boolean} runtimeDetected
 * @property {number} ntApiMethodCount
 * @property {string[]} wrapperServices
 * @property {{ ffmpegPath: string, silkEncoderConfigured: boolean, silkDecoderConfigured: boolean }} mediaTools
 * @property {{
 *   send_msg: boolean,
 *   send_image: boolean,
 *   send_record: boolean,
 *   send_video: boolean,
 *   send_file: boolean,
 *   recall_msg: boolean,
 *   forward_msg: boolean,
 *   group_special_title: boolean,
 *   group_essence: boolean,
 *   group_notice: boolean,
 *   emoji_like: boolean,
 *   poke: boolean,
 *   ocr_image: boolean,
 *   voice_to_text: boolean,
 *   web_credentials: boolean
 * }} capabilities
 * @property {{
 *   copyFileWithDelExifInfo: boolean,
 *   getRichMediaFilePathForGuild: boolean,
 *   opaqueNtApiProxy: boolean,
 *   sessionInitialized: boolean
 * }} notes
 */

/**
 * Outbound token-bucket rate limiter & circuit breaker configuration.
 * @typedef {object} RateLimitConfig
 * @property {boolean} [enabled]
 * @property {number} [globalPerSec]
 * @property {number} [globalBurst]
 * @property {number} [perPeerPerSec]
 * @property {number} [perPeerBurst]
 * @property {number} [circuitBreakerThreshold]
 * @property {number} [circuitBreakerCooldownMs]
 * @property {number} [maxPeers]
 */

/**
 * Cumulative telemetry snapshot returned by `OutboundRateLimiter.getStats()`.
 * @typedef {object} RateLimitStats
 * @property {boolean} enabled
 * @property {number} allowed
 * @property {number} rejected
 * @property {number} globalRejected
 * @property {number} peerRejected
 * @property {number} circuitRejected
 * @property {number} circuitOpens
 * @property {"closed" | "open" | "half_open"} circuitState
 * @property {number} activePeers
 */

/**
 * Electron renderer process crash / responsiveness self-healing telemetry.
 * @typedef {object} RendererHealthStats
 * @property {number} crashes
 * @property {number} unresponsive
 * @property {boolean} unresponsiveActive
 * @property {number} recoveries
 * @property {number} recoveryFailures
 * @property {number} reloadSuppressed
 * @property {number} lastCrashAt
 * @property {string} lastCrashReason
 * @property {number} lastUnresponsiveAt
 */

/**
 * Outbound HTTP POST webhook delivery queue & retry counters.
 * @typedef {object} WebhookStats
 * @property {number} ok
 * @property {number} failed
 * @property {number} retries
 * @property {number} dropped
 * @property {number} inFlight
 * @property {number} queued
 */

/**
 * Result payload returned by `reloadConfig` / OneBot `reload_config` action.
 * @typedef {object} ReloadConfigResult
 * @property {boolean} reloaded
 * @property {boolean} network_restarted
 * @property {boolean} network_restart_scheduled
 * @property {string[]} changed_keys
 * @property {string[]} network_changed_keys
 * @property {Array<Record<string, any>>} [listen_errors]
 */

/**
 * NTQQ raw peer address passed to kernel IPC calls.
 * @typedef {object} NtPeer
 * @property {number} chatType - `1` private, `2` group, `4` guild, `100` temp session
 * @property {string} peerUid - NTQQ `u_...` UID (private) or group code string (group)
 * @property {string} [guildId]
 */

/**
 * Canonical normalized NTQQ peer descriptor with precomputed `peerKey`.
 * @typedef {object} NormalizedPeer
 * @property {number} chatType
 * @property {string} peerUid
 * @property {string} guildId
 * @property {string} peerKey - `${chatType}:${peerUid}:${guildId}` or `""` when `peerUid` is empty
 */

/**
 * Normalized NTQQ group summary record.
 * @typedef {object} NormalizedGroupSummary
 * @property {number} groupId
 * @property {string} groupIdStr
 * @property {string} groupName
 * @property {number} memberCount
 * @property {number} maxMemberCount
 * @property {string} groupRemark
 * @property {string} ownerUid
 * @property {number} memberRole
 * @property {Record<string, any>} raw
 */

/**
 * Normalized NTQQ buddy / stranger profile record.
 * @typedef {object} NormalizedBuddyProfile
 * @property {string} uid
 * @property {number} uin
 * @property {string} nickname
 * @property {string} remark
 * @property {"male" | "female" | "unknown"} sex
 * @property {number} age
 * @property {string} qid
 * @property {string} longNick
 */

/**
 * Normalized NTQQ group member record aligned with OneBot v11 `group_actions.js` conventions.
 * @typedef {object} NormalizedGroupMember
 * @property {number} group_id
 * @property {string} uid
 * @property {number} uin
 * @property {string} nickname
 * @property {string} card
 * @property {"male" | "female" | "unknown"} sex
 * @property {number} age
 * @property {string} area
 * @property {number} join_time
 * @property {number} last_sent_time
 * @property {string} level
 * @property {"owner" | "admin" | "member" | string} role
 * @property {number} roleNum
 * @property {boolean} unfriendly
 * @property {string} title
 * @property {number} title_expire_time
 * @property {boolean} card_changeable
 * @property {number} shut_up_timestamp
 */

/**
 * Normalized self login identity extracted from login/session kernel events.
 * @typedef {object} NormalizedLoginIdentity
 * @property {string} uin
 * @property {string} uid
 * @property {string} nick
 */

/**
 * Single OneBot v11 structured message segment.
 * @typedef {object} OneBotSegment
 * @property {string} type
 * @property {Record<string, any>} data
 */

/**
 * OneBot v11 action invocation context metadata.
 * @typedef {object} ActionContext
 * @property {string} [endpointName]
 * @property {"http" | "ws" | "ws_reverse" | "internal"} [transport]
 * @property {MessageFormat} [messageFormat]
 * @property {CompatProfile} [compatProfile]
 * @property {string} [compatAppName]
 * @property {string} [compatAppVersion]
 * @property {string} [remoteAddress]
 */

/**
 * Standard OneBot v11 action response envelope.
 * @typedef {object} OneBotActionResponse
 * @property {"ok" | "failed"} status
 * @property {number} retcode
 * @property {any} data
 * @property {string} message
 * @property {string} wording
 * @property {any} [echo]
 */

/**
 * OneBot v11 inbound event envelope (`message`, `message_sent`, `notice`, `request`, `meta_event`).
 * @typedef {object} OneBotEvent
 * @property {number} time
 * @property {number} self_id
 * @property {"message" | "message_sent" | "notice" | "request" | "meta_event"} post_type
 */

/**
 * 3-tier NTQQ kernel service invocation function signature.
 * @callback InvokeNtFn
 * @param {string} cmd - `"<serviceName>/<methodName>"` (e.g. `"nodeIKernelMsgService/sendMsg"`)
 * @param {Record<string, any>} [payload]
 * @param {any[] | null} [positionalArgs]
 * @returns {Promise<any>}
 */

/**
 * Matched `onAddSendMsg` echo correlation payload.
 * @typedef {object} EchoMatchResult
 * @property {string} msgId
 * @property {string} msgSeq
 * @property {number} [msgTime]
 * @property {Record<string, any>} [rawMsg]
 */

/**
 * One-shot event waiter handle returned by `createEventWaiter`.
 * @template T
 * @typedef {object} EventWaiterHandle
 * @property {Promise<T | null>} promise
 * @property {() => void} cancel
 */

/**
 * Bound OneBot v11 action handler function inside an action router.
 * @callback ActionHandlerFn
 * @param {Record<string, any>} p
 * @param {ActionContext} context
 * @param {string} action
 * @returns {Promise<any> | any}
 */

/**
 * 3-tier NTQQ kernel invocation telemetry counters.
 * @typedef {object} InvokeStats
 * @property {number} tier1
 * @property {number} tier2
 * @property {number} tier3
 * @property {number} directMain
 * @property {number} degraded
 * @property {number} blockedReplays
 * @property {number} failed
 * @property {{ cmd: string, tier: number, at: number } | null} lastDegraded
 */

/**
 * Captured NTQQ kernel service registry populated by `NtCaptureController`.
 * @typedef {object} CapturedServices
 * @property {any} ntApi
 * @property {any} ntApiContainer
 * @property {any} ntStore
 * @property {any} WindowApi
 * @property {any} PerformanceApi
 * @property {any} LoggerApi
 * @property {any} UserBehaviorReportService
 * @property {any} SubWindowApi
 * @property {any} ScreenRecordApi
 * @property {any} ntCall
 * @property {any} ntSessionManager
 * @property {any} wrapperSession
 */

/**
 * Metadata recorded when `NtCaptureController` releases its `Map.prototype.set` capture hook.
 * @typedef {object} MapHookReleaseRecord
 * @property {string} reason
 * @property {boolean} restored
 * @property {number} at
 */

/**
 * Recorded HTTP/WS server listener startup error entry.
 * @typedef {object} ListenErrorEntry
 * @property {string} kind
 * @property {string} host
 * @property {number} port
 * @property {string} code
 * @property {string} message
 * @property {number} ts
 */

/**
 * Constructor options accepted by `NtqqOneBotBridge` and `installMainBridge`.
 * @typedef {object} BridgeOptions
 * @property {string} [configDir]
 * @property {BridgeConfig} [config]
 * @property {any} [messageIdStore]
 * @property {any} [uinUidStore]
 * @property {string | number} [selfUin]
 * @property {string} [selfUid]
 * @property {string} [selfNickname]
 * @property {number} [startedAtMs]
 * @property {boolean} [online]
 * @property {any} [ntApi]
 * @property {any} [ntSessionManager]
 * @property {any} [wrapperSession]
 * @property {((cmd: string, args: any[]) => Promise<any>) | null} [rendererExecute]
 * @property {((opts?: Record<string, any>) => Promise<any>) | null} [rendererSimulateSession]
 * @property {((opts?: Record<string, any>) => Promise<any>) | null} [rendererLeaveSession]
 * @property {any} [electron]
 * @property {boolean} [forceNew]
 * @property {boolean} [autoStartServers]
 */

module.exports = {};
