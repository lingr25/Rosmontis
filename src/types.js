// @ts-check
"use strict";

/**
 * Shared JSDoc Type Contracts for Rosmontis (`src/types.js`)
 *
 * Pure type-annotation module (zero runtime overhead, zero dependencies) enabling
 * IDE autocompletion and `strictNullChecks: true` JSDoc verification across `src/` and `test/`.
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
 * @property {string[]} [allowedOrigins]
 * @property {boolean} [reportSelfMessage]
 * @property {MessageFormat} [messageFormat]
 * @property {CompatProfile} [compatProfile]
 * @property {string} [compatAppName]
 * @property {string} [compatAppVersion]
 * @property {boolean} [enable]
 * @property {boolean} [enabled]
 */

/**
 * Reverse WebSocket client endpoint configuration.
 * @typedef {object} ReverseWsClientConfig
 * @property {string} [name]
 * @property {string} url
 * @property {string} [role]
 * @property {string} [accessToken]
 * @property {boolean} [reportSelfMessage]
 * @property {number} [reconnectIntervalMs]
 * @property {MessageFormat} [messageFormat]
 * @property {CompatProfile} [compatProfile]
 * @property {string} [compatAppName]
 * @property {string} [compatAppVersion]
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
 * @property {number} [maxRetries]
 * @property {number} [retryBaseMs]
 * @property {boolean} [reportSelfMessage]
 * @property {boolean} [enableHeartbeat]
 * @property {MessageFormat} [messageFormat]
 * @property {CompatProfile} [compatProfile]
 * @property {string} [compatAppName]
 * @property {string} [compatAppVersion]
 * @property {boolean} [enable]
 * @property {boolean} [enabled]
 */

/**
 * Resolved Rosmontis bridge runtime configuration.
 * @typedef {object} BridgeConfig
 * @property {string} [selfUin]
 * @property {string} [selfNickname]
 * @property {string} [tempDir]
 * @property {EndpointServerConfig[]} [httpServers]
 * @property {EndpointServerConfig[]} [wsServers]
 * @property {ReverseWsClientConfig[]} [wsClients]
 * @property {HttpPostClientConfig[]} [httpClients]
 * @property {number} [heartbeatIntervalMs]
 * @property {MessageFormat} [messageFormat]
 * @property {boolean} [humanSimulation]
 * @property {number} [aioIdleExitMs]
 * @property {number} [focusIdleBlurMs]
 * @property {number} [sendEchoTimeoutMs]
 * @property {number} [richMediaEchoTimeoutMs]
 * @property {number} [sendRichMediaEchoTimeoutMs]
 * @property {number} [maxSendEchoTimeoutMs]
 * @property {number} [forwardEchoTimeoutMs]
 * @property {number} [forwardMediaHydrationBudgetMs]
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
 * @property {boolean} [enableLocalFile2Url]
 * @property {string} [ffmpegPath]
 * @property {string} [silkDecoderPath]
 * @property {string} [silkEncoderPath]
 * @property {string | false} [silkAddonPath]
 * @property {string} [nodeBinPath]
 * @property {number} [maxTempFiles]
 * @property {string} [stateDir]
 * @property {boolean} [persistStores]
 * @property {number} [statePersistDebounceMs]
 * @property {number} [maxForwardCustomNodes]
 * @property {number} [forwardStageDelayMs]
 * @property {number} [inboundMediaConcurrency]
 * @property {number} [mediaHydrationTimeoutMs]
 * @property {number} [richMediaDownloadTimeoutMs]
 * @property {number} [uploadFileUuidWaitMs]
 * @property {boolean} [strictUploadGroupFileFolderMove]
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
 * @property {boolean} [enforceSwitchCooldownOnSend]
 * @property {number} [outboundQueueTimeoutMs]
 * @property {number} [outboundMaxQueueSize]
 * @property {string} [ntCacheDir]
 * @property {boolean} [cleanCachePrunesNtData]
 * @property {number} [ntCacheMaxAgeMs]
 * @property {number} [ntCacheAutoPruneIntervalMs]
 * @property {boolean} [recordAnomalies]
 * @property {boolean} [persistAnomalies]
 * @property {number} [livenessCheckIntervalMs]
 * @property {number} [livenessIdleThresholdMs]
 * @property {number} [livenessMaxFailures]
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
 * Cached capability probe entry stored on `BridgeHost._capabilityProbeCache`.
 * @typedef {object} CapabilityProbeCache
 * @property {number} at
 * @property {any} ntApiRef
 * @property {any} wrapperSessionRef
 * @property {BridgeConfig | null} configRef
 * @property {boolean} webCredentials
 * @property {boolean} online
 * @property {CapabilityProbeResult} result
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
 * Cumulative telemetry snapshot returned by `CausalSessionScheduler.getStats()`.
 * @typedef {object} SessionQueueStats
 * @property {boolean} locked
 * @property {number} queueLength
 * @property {number} maxQueueSize
 * @property {number} defaultQueueTimeoutMs
 * @property {number} enqueued
 * @property {number} timedOut
 * @property {number} overflowRejected
 * @property {number} aborted
 * @property {number} evictedAdvisory
 */

/**
 * Silent kernel liveness & wrapperSession drift self-healing telemetry.
 * @typedef {object} LivenessStats
 * @property {boolean} healthy
 * @property {string} degradedReason
 * @property {number} lastKernelEventAt
 * @property {number} lastProbeAt
 * @property {number} probeCount
 * @property {number} consecutiveFailures
 * @property {number} sessionRebinds
 */

/**
 * Outbound send-echo correlation telemetry counters.
 * @typedef {object} SendEchoStats
 * @property {number} matched
 * @property {number} fromResult
 * @property {number} timedOut
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
 * @property {AbortSignal} [signal]
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
 * Optional per-call dispatch hints accepted by `invokeNt`.
 * @typedef {object} InvokeNtOptions
 * @property {boolean} [preferMainProcess]
 * @property {number} [timeoutMs]
 */

/**
 * 3-tier NTQQ kernel service invocation function signature.
 * @callback InvokeNtFn
 * @param {string} cmd - `"<serviceName>/<methodName>"` (e.g. `"nodeIKernelMsgService/sendMsg"`)
 * @param {Record<string, any>} [payload]
 * @param {any[] | null} [positionalArgs]
 * @param {InvokeNtOptions | null} [invokeOptions]
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
 * OneBot v11 action handler method bound to `BridgeHost` as `this`.
 * @callback BridgeActionHandler
 * @this {BridgeHost}
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
 * @property {number} [directMain]
 * @property {number} degraded
 * @property {number} blockedReplays
 * @property {number} failed
 * @property {{ cmd: string, tier: number, at: number } | null} [lastDegraded]
 */

/**
 * Captured NTQQ kernel service registry populated by `NtCaptureController`.
 * @typedef {object} CapturedServices
 * @property {any} [ntApi]
 * @property {any} [ntApiContainer]
 * @property {any} [ntStore]
 * @property {any} [WindowApi]
 * @property {any} [PerformanceApi]
 * @property {any} [LoggerApi]
 * @property {any} [UserBehaviorReportService]
 * @property {any} [SubWindowApi]
 * @property {any} [ScreenRecordApi]
 * @property {any} [ntCall]
 * @property {any} [ntSessionManager]
 * @property {any} [wrapperSession]
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
 * Narrow read-only host contract accepted by `probeRuntimeCapabilities` / `hasKernelMethod`.
 * @typedef {object} CapabilityProbeHost
 * @property {Partial<CapturedServices> | null} [capturedServices]
 * @property {Partial<BridgeConfig> | null} [config]
 * @property {boolean} [online]
 * @property {CapabilityProbeCache | null} [_capabilityProbeCache]
 */

/**
 * Narrow host contract accepted by `qzone_actions.js` web-credential & QZone helpers.
 * @typedef {object} WebCredentialHost
 * @property {InvokeNtFn} invokeNt
 * @property {string | number} [selfUin]
 * @property {Partial<BridgeConfig> | null} [config]
 * @property {{ debug?: (scope: string, err: any) => any } | null} [logger]
 */

/**
 * Core instance members of `NtqqOneBotBridge` exposed to composed subsystem controllers
 * and OneBot v11 action routers (`src/actions/*.js`).
 * @typedef {object} BridgeHostMembers
 * @property {string | undefined} [_configDir]
 * @property {boolean} [_explicitConfig]
 * @property {string} [_bridgeRootDir]
 * @property {Record<string, any>} [_rkeyState]
 * @property {Map<string, (action: string, p: Record<string, any>, context?: ActionContext) => Promise<any>>} [_actionDispatchMap]
 * @property {(nextMap: Map<string, any>) => void} [_syncModuleActionDispatchMap]
 * @property {BridgeConfig} config
 * @property {InstanceType<typeof import("./onebot/stores").MessageIdStore>} messageIdStore
 * @property {InstanceType<typeof import("./onebot/stores").UinUidStore>} uinUidStore
 * @property {InstanceType<typeof import("./core/primitives").BridgeLogger>} logger
 * @property {InstanceType<typeof import("./core/primitives").TtlDedupeSet>} eventDedupe
 * @property {InstanceType<typeof import("./core/primitives").TempCleanupQueue>} tempCleanupQueue
 * @property {InstanceType<typeof import("./core/echo_correlator").EchoCorrelator>} echoCorrelator
 * @property {InstanceType<typeof import("./core/session_controller").HumanSessionController>} sessionController
 * @property {string} selfUin
 * @property {string} selfUid
 * @property {string} selfNickname
 * @property {number} startedAtMs
 * @property {boolean} online
 * @property {string} lastQrCodeBase64
 * @property {CapturedServices} capturedServices
 * @property {((cmd: string, args: any[]) => Promise<any>) | null} rendererExecute
 * @property {((opts?: Record<string, any>) => Promise<any>) | null} rendererSimulateSession
 * @property {((opts?: Record<string, any>) => Promise<any>) | null} rendererLeaveSession
 * @property {CapabilityProbeCache | null} [_capabilityProbeCache]
 * @property {{ track: (filePath: string) => void } | null} [tempFileCleaner]
 * @property {{ ready?: boolean } | null} [dispatcher]
 * @property {((service: string, method: string, args: any[]) => Promise<any>) | null} [ntCall]
 * @property {((ev: any) => void) | null} [_dispatchEvent]
 * @property {InstanceType<typeof import("./core/nt_capture").NtCaptureController>} ntCapture
 * @property {InstanceType<typeof import("./core/renderer_ipc").RendererIpcController>} rendererIpc
 * @property {InstanceType<typeof import("./core/inbound_pipeline").InboundPipeline>} inboundPipeline
 * @property {InstanceType<typeof import("./core/outbound_pipeline").OutboundPipeline>} outboundPipeline
 * @property {InstanceType<typeof import("./core/server_runtime").ServerRuntime>} serverRuntime
 * @property {InstanceType<typeof import("./core/hot_reload").HotReloadController>} hotReload
 * @property {Record<string, any>} richMediaStats
 * @property {Record<string, any>} reloadStats
 * @property {SendEchoStats} sendEchoStats
 * @property {MapHookReleaseRecord | null} mapHookRelease
 * @property {any} activeWebContents
 * @property {InvokeStats} invokeStats
 * @property {RendererHealthStats | null} rendererHealthStats
 * @property {InstanceType<typeof import("./core/rate_limiter").OutboundRateLimiter> | null} rateLimiter
 * @property {WebhookStats} webhookStats
 * @property {ListenErrorEntry[]} listenErrors
 * @property {Set<any>} wsClients
 * @property {any[]} reverseWsClients
 * @property {() => Promise<void>} flushStateStores
 * @property {() => void} flushTempCleanup
 * @property {(opts?: Record<string, any>) => Promise<any>} simulateHumanSession
 * @property {(opts?: Record<string, any>) => Promise<any>} leaveHumanSession
 * @property {() => void} installMapPrototypeHook
 * @property {(reason?: string) => boolean} releaseMapPrototypeHook
 * @property {() => void} installWrapperHook
 * @property {(options?: Record<string, any>) => { wrapperModulesFound: number, mapsScanned: number, rmIpcChannels: string[] }} probeExistingRuntime
 * @property {(electronModule?: any) => boolean} installElectronHooks
 * @property {InvokeNtFn} invokeNt
 * @property {() => Promise<void>} startServers
 * @property {() => Promise<void>} stopServers
 * @property {(options?: Record<string, any>) => Promise<ReloadConfigResult>} reloadConfig
 * @property {(customRootDir?: string | null) => { codeDigest: string, fileCount: number, files: string[] }} getCodeDigestInfo
 * @property {(options?: Record<string, any>) => Promise<Record<string, any>>} reloadBridge
 * @property {(eventObj: any, messageFormat: string) => any} _formatEventForEndpoint
 * @property {(event: any) => void} broadcastOneBotEvent
 * @property {() => Promise<{ clientKey: string, expireTime: string, keyIndex: string, url: string }>} _fetchClientKey
 * @property {(domain?: string) => Promise<Record<string, string>>} _getCookiesObject
 * @property {(action: string, params?: Record<string, any>, echo?: any, context?: ActionContext) => Promise<OneBotActionResponse>} handleOneBotAction
 * @property {(action: string, p: Record<string, any>, context?: ActionContext) => Promise<any>} _dispatchAction
 */

/**
 * Full coordinator host interface implemented by `NtqqOneBotBridge` (`src/bridge_main.js`).
 * @typedef {import("events").EventEmitter & BridgeHostMembers} BridgeHost
 */

/**
 * Constructor options accepted by `NtqqOneBotBridge` and `installMainBridge`.
 * @typedef {object} BridgeOptions
 * @property {string} [configDir]
 * @property {BridgeConfig} [config]
 * @property {InstanceType<typeof import("./onebot/stores").MessageIdStore>} [messageIdStore]
 * @property {InstanceType<typeof import("./onebot/stores").UinUidStore>} [uinUidStore]
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
