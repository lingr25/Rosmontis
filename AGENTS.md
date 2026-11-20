# 项目背景

## 定位与技术约束

- **Rosmontis（迷迭香）** 是面向官方 Linux QQ NT 的纯 JavaScript OneBot v11 协议桥接器。
- 核心技术边界：**0 行 C/C++ 代码、0 个原生 `.so` / `LD_PRELOAD` / `ptrace` Hook、0 个第三方 npm 运行时依赖**（仅使用 Node.js `>=18` 与 Electron 内置模块），通过官方渲染层 IPC（`RM_IPCFROM_RENDERER` / `RM_IPCFROM_MAIN`）与客户端会话因果状态机收发事件和调用内核能力。

## 与小晓（`little_xiao`）的关系

- 本项目最初由小晓仓库（本机同级目录 `D:\Desktop\litte_xiao` 下的 `deploy/ntqq_renderer_bridge/`）孵化并独立开源。
- 现阶段 **Rosmontis 作为通用开源项目独立演进，同时充当小晓 QQ 接入层的唯一上游（Single Source of Truth）**：
  - 需保持对通用第三方 OneBot v11 客户端（AstrBot、NoneBot2、Koishi 等）的标准协议兼容；
  - 同时保留对小晓运行环境的向后兼容（包括 `XIAO_BRIDGE_*` 旧环境变量别名，以及小晓跨容器共享媒体挂载目录 `/opt/xiao-data`）。

## 目录结构与测试入口

- `src/app_launcher_index.js`：Linux QQ `app_launcher` 纯 JS 引导入口
- `src/plugin_loader.js` & `manifest.json`：跨平台纯 JS 外部插件框架（LiteLoaderQQNT v4 / QwQNT / 自定义主进程引导）轻量接入入口（仓库不内置任何原生 `.dll` / `.exe` 注入器）
- `src/bridge_main.js`：Electron 主进程精简协调器，以显式组合方式装配 5 个核心运行时控制器类（`NtCaptureController`、`RendererIpcController`、`InboundPipeline`、`OutboundPipeline`、`ServerRuntime`，取代 `Object.assign` 原型混入），并整合通用基础组件与 OneBot v11 动作分发路由
- `src/bridge_renderer.js`：注入 `BrowserWindow` 渲染层的受信任 IPC 桥接与客户端会话状态机
- `src/types.js`、`jsconfig.json` & `scripts/typecheck.js`：零编译开销的 JSDoc 协议与内部运行时类型契约及静态检查工具（全部 41 个 `src/**/*.js` 模块 100% 启用 `// @ts-check`，本地执行 `npm run typecheck`、CI 执行 `node scripts/typecheck.js --install`，均在隔离临时环境运行，仓库保持 0 运行时 npm 依赖）
- `src/bridge_onebot.js`：OneBot v11 协议与富媒体转换统一门面导出，底层拆分为 `src/onebot/`（4 个高内聚子模块）：
  - `stores.js`：纯存储域模块，提供有界 LRU 31-bit 消息 ID 映射（`MessageIdStore`）与 UIN/UID 双向索引缓存（`UinUidStore`），支持防抖原子快照持久化与重启恢复
  - `cq_codec.js`：CQ 码转义/反转义与 OneBot v11 消息段/字符串双向归一化编解码
  - `segment_converter.js`：NTQQ 内核 `elements` 与 OneBot v11 消息段双向转换、非阻塞 `file://` 富媒体 URL 构建、`buildNtMarketFaceUrl` / `stripTransientNtMedia` 富媒体规范化及短视频缩略图合成
  - `event_formatter.js`：NTQQ 消息、灰条通知（撤回/戳一戳/精华/专属头衔/运气王）、群名片变更、消息表情回应、群文件上传、好友/加群请求与元事件格式化器
- `src/core/`：零依赖核心子模块（25 个）：
  - `env.js`：`ROSMONTIS_*` / `ONEBOT_*` / `XIAO_BRIDGE_*` 多前缀环境变量统一解析器（仓库内唯一允许读取 `process.env` 的源码模块）
  - `primitives.js`：有界 LRU `BoundedMap`、TTL 去重集（`TtlDedupeSet`）、临时文件清理环（`TempCleanupQueue`）、一次性事件等待器、限流与 JSON 结构化日志（`BridgeLogger`，支持 `ROSMONTIS_LOG_FORMAT=json`）、跨进程 `Map`/`Uint8Array`/`void` 无损编解码与声明式动作路由器（`createActionRouter`）
  - `nt_normalizer.js`：NTQQ 多版本内核数据结构防腐层（Peer、群摘要、好友资料、群成员、登录身份与正整数 UIN 强校验）
  - `echo_correlator.js`：出站 `sendMsg` 与异步 `onAddSendMsg` 真实 64-bit `msgId` 签名匹配关联器（`EchoCorrelator`）
  - `session_controller.js`：独立人类会话因果控制器（`HumanSessionController`，统筹渲染层钩子、跨进程指令回退、已读/输入去重与两级空闲退场）
  - `session_scheduler.js`：会话级亲和公平互斥锁、AIO 切换冷却、已读→输入抖动与私聊延迟响应调度器（`CausalSessionScheduler`）
  - `nt_capture.js`：瞬态捕获控制器（`NtCaptureController`），负责 `Map.prototype.set` / `Module._load` 瞬态无痕捕获、外部插件晚加载存量探测（`probeExistingRuntime`）与 V8 原生原型链自动归还
  - `renderer_ipc.js`：渲染层 IPC 控制器（`RendererIpcController`），负责渲染窗口注入（含已就绪窗口立即注入）、受信任 IPC 鉴权、`render-process-gone` / `unresponsive` 崩溃自愈、三级 `invokeNt` 调度与防重复发送保护
  - `inbound_pipeline.js`：入站事件管线控制器（`InboundPipeline`），负责内核事件监听、表情回应/群名片变更及入站事件分发编排
  - `media_hydrator.js`：按会话因果串行+跨会话有界并发入站富媒体（图片/语音/合并转发）内核水合与 `file://`/`base64://` 落盘
  - `login_recovery.js`：本地快登凭据读取、`setAutoLogin` 与免扫码快速登录恢复
  - `outbound_pipeline.js`：出站发送管线控制器（`OutboundPipeline`），负责两阶段发送（锁外图片/语音/短视频富媒体暂存 + 频控校验 + 会话激活、`sendMsg` 派发与回显关联）
  - `rate_limiter.js`：全局 + 单会话有界 LRU 令牌桶限流与连续拒绝熔断器（`OutboundRateLimiter`，拒绝返回 `retcode: 1429`）
  - `capability_probe.js`：只读运行时内核 RPC 能力与媒体工具探测器（驱动 `get_capabilities`、`get_status.bridge.capabilities` 与动态动作门控）
  - `server_runtime.js`：网络服务运行时控制器（`ServerRuntime`），负责内置 HTTP API（含 `/health`、`/ready` 就绪探针、Prometheus `/metrics`）、正向 WS 分离路径（`/` `/api` `/event`）、反向 WS 重连、HTTP POST Webhook（HMAC-SHA1 `X-Signature` + Quick Operation + 有界并发队列与指数退避重试）、`reload_config` / `SIGHUP` 热重载与心跳/事件广播
  - `ws_rfc6455.js`：RFC 6455 WebSocket 编解码、掩码校验、负载上限与反向 WS 客户端
  - `transport_security.js`：恒定时间鉴权、`Origin` 校验、非回环地址受保护模式（Protected Mode）自动鉴权与 HTTP 请求体上限
  - `media_security.js`：媒体源 IPv4/IPv6 SSRF 防护、严格本地 LFI 目录白名单校验、敏感凭据/持久化快照防泄露与 `resolveMediaSource`（同时向后兼容重导出已拆分的图片嗅探、版本元信息与流式下载工具）
  - `media_downloader.js`：配额受控的流式 HTTP/HTTPS 媒体下载、原子 `.part` 临时文件落盘与有界临时目录清理
  - `image_probe.js`：零依赖 PNG / GIF / WebP（VP8/VP8L/VP8X）/ JPEG 二进制文件头尺寸与扩展名嗅探器
  - `ntqq_meta.js`：已安装 QQ NT 清单版本元信息读取与动态桌面 Chromium User-Agent 构造器
  - `audio_codec.js`：纯 JS 语音帧解析（SILK v3 / AMR / WAV 时长与波形提取、`\x02#!SILK_V3` 规范化、PCM→WAV 封装）与可选外部 SILK CLI / `ffmpeg` 语音编解码器
  - `config.js`：多路径 JSON 配置与环境变量加载器
  - `web_http.js`：受限腾讯域重定向校验的 HTTPS Cookie / HTTP 文本与 JSONP 工具
  - `qzone_actions.js`：默认关闭（`enableWebCredentialApi` 显式门控）的 Web 凭据提取与 QQ 空间（QZone）动作模块
- `src/actions/`：OneBot v11 动作域处理子模块（6 个）：
  - `message_actions.js`：登录/状态/能力探测（`get_capabilities`）/热重载（`reload_config`）、私聊与群聊收发、合并转发、历史记录、已读标记、表情回应与戳一戳动作
  - `contact_actions.js`：好友列表、陌生人资料、好友备注/删除、好友分组与加好友请求处理动作
  - `group_actions.js`：群列表/群资料/群成员查询、踢人/禁言/管理员/头衔（动态能力门控）/精华消息与入群请求管理动作
  - `file_actions.js`：群文件与私聊文件上传、下载链接解析、目录创建/移动/重命名/删除动作
  - `media_profile_actions.js`：图片/语音/文件解析、OCR/语音转文字、个人资料状态与 Ark 卡片分享动作
  - `file_media_actions.js`：组合 `file_actions.js` 与 `media_profile_actions.js` 的向后兼容门面路由
- `scripts/`、`docker/` & `.github/workflows/`：无头 Linux QQ 容器构建（官方 `.deb` 拉取、默认 `ROSMONTIS_STATE_DIR=/app/data/state`、可选 `INSTALL_VNC=0` 精简模式）、`Xvfb` 启动、桥接安装脚本、零依赖类型检查脚本（`scripts/typecheck.js`）、CI 测试/类型检查与每周官方 `.deb` 金丝雀冒烟工作流（`.github/workflows/canary.yml`）
- `test/`：零依赖契约、安全与端到端模拟测试套件（含基于 `node --test` 并行运行的 20 个 `test/bridge/*.test.js` 领域文件——含 `composition_architecture.test.js` 与 `wire_codec_parity.test.js`——加上 `test/test_core_modules.js` 与 `test/test_media_security.js`，共 70 项测试），直接运行 `npm test` 与 `npm run typecheck` 验证
