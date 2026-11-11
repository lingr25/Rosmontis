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
- `src/bridge_main.js`：Electron 主进程协调器、三级 `invokeNt` 调度、OneBot v11 动作实现与内置 HTTP / WebSocket 服务入口
- `src/bridge_renderer.js`：注入 `BrowserWindow` 渲染层的受信任 IPC 桥接与客户端会话状态机
- `src/bridge_onebot.js`：OneBot v11 消息段/CQ 码编解码、媒体文件解析与 ID 映射存储
- `src/core/`：零依赖核心子模块：
  - `ws_rfc6455.js`：RFC 6455 WebSocket 编解码、掩码校验、负载上限与反向 WS 客户端
  - `transport_security.js`：恒定时间鉴权、`Origin` 校验、非回环地址受保护模式（Protected Mode）自动鉴权与 HTTP 请求体上限
  - `config.js`：多路径 JSON 配置与 `ROSMONTIS_*` / `ONEBOT_*` / `XIAO_BRIDGE_*` 环境变量加载器
  - `web_http.js`：受限腾讯域重定向校验的 HTTPS Cookie / HTTP 文本与 JSONP 工具
  - `qzone_actions.js`：默认关闭（`enableWebCredentialApi` 显式门控）的 Web 凭据提取与 QQ 空间（QZone）动作模块
  - `session_scheduler.js`：会话级公平互斥锁、AIO 切换冷却、已读→输入抖动与私聊延迟响应调度器（`CausalSessionScheduler`）
  - `media_security.js`：媒体源 SSRF 防护、本地目录白名单校验与临时文件生命周期管理
- `scripts/` & `docker/`：无头 Linux QQ 容器构建（官方 `.deb` 拉取）、`Xvfb` 启动与桥接安装脚本
- `test/`：零依赖契约与端到端模拟测试套件，直接运行 `npm test` 验证
