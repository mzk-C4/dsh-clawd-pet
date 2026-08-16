# dsh-clawd-pet

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)
[![DSH](https://img.shields.io/badge/DSH%20Desktop-2.x-blue)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](package.json)

让 Clawd on Desk 桌面宠物跟着 DeepSeek Harness（DSH）的状态一起动起来：DSH 在思考、调工具、等审批、出错、完成回合时，宠物会实时切换对应的动画。

DSH 侧以 Cordis 插件形式运行，监听 DSH 会话事件总线（`session/created` / `session/event` / `session/disposed` / `agent/error`），把事件翻译成 Clawd 的宠物状态，POST 到 Clawd 本地服务器（`127.0.0.1:23333+/state`），以 Clawd「自定义应用（custom application）」的身份上报。

## 功能特性

- **实时宠物遥测** — 思考 / 工作 / 杂耍 / 通知 / 庆祝 / 报错 / 打扫 / 睡觉，全部由 DSH 实时会话事件驱动（映射表见下）。
- **子代理与 workflow 感知** — 子代理（subagent）会话和 `tool-workflow` 运行统一折算到父会话，表现为 *juggling*（抛球），HUD 不会被子代理卡片刷屏。
- **审批提醒** — DSH 等你批准时（`approval/asked`），宠物切到 *notification* 提醒你去看 DSH。
- **上下文用量圆环** — 回合完成时附带 `context_usage` 估算（used/limit/percent），显示在会话 HUD 上。
- **完成文本** — 完成事件附带最后一条助手消息（按 Clawd 2400 字符上限截断）。
- **零侵入** — 不修改 DSH/Clawd 任何既有文件；上报全部 fire-and-forget + 串行队列，失败只记日志，绝不阻塞 agent 主循环。
- **自动发现** — Clawd 端口从 `~/.clawd/runtime.json` + 23333–23337 端口段自动探测；agent id 优先匹配 Clawd 已注册的自定义应用，否则按宿主 exe 路径的确定性哈希计算。
- **零额外运行依赖** — 只用 Node 内置模块（`node:http`、`node:crypto` 等）+ 极小的 `@deepseek-ai/schemastery` 校验包；可在 DSH 任意宿主（DSH Desktop Electron 主进程、`dsh web` node 服务）内加载。

## 状态映射

| DSH 事件 | Clawd 状态 | 宠物动画 |
|---|---|---|
| 用户提交 prompt / `turn/start` / 模型开始输出 | `thinking` | 思考 |
| `tool/call`、`tool/result` | `working` | 敲键盘干活 |
| 子代理（subagent）会话激活 / workflow 运行 | `juggling` | 抛球杂耍 |
| `approval/asked`（等你批准） | `notification` | 提醒你去看 DSH |
| `turn/end`（reason=completed/max-tokens） | `attention` | 庆祝完成 |
| `turn/end`（reason=error）、`agent/error`、工具失败 | `error` | 报错 |
| `compaction/start`（上下文压缩） | `sweeping` | 打扫卫生 |
| 会话结束 / DSH 关闭 | `sleeping` | 收起会话卡片 |

子代理会话统一折算到父会话上报（`SubagentStart`/`SubagentStop`），不会刷屏 HUD。完成回合时附带最后一条助手消息文本（`assistant_last_output`）、模型名与上下文用量估算（`context_usage`）。

## 工作原理

```
DSH 会话事件流                       dsh-clawd-pet (Cordis 插件)                Clawd on Desk
─────────────────────────           ──────────────────────────────             ──────────────
session/created ──────────┐         ┌──────────────────────────┐   POST /state   ┌─────────────┐
session/event   ──────────┼───────▶ │ 事件 → Clawd 状态映射      │ ─────────────▶ │ 本地 HTTP   │
agent/error     ──────────┘         │ agent id 解析             │  x-clawd-server │ 服务器      │
session/disposed                    │ 端口自动发现               │  200/204/400   │ 127.0.0.1   │
                                    │ 节流 + 串行队列            │                │ :23333-23337│
                                    │ fire-and-forget POST      │                └─────────────┘
                                    └──────────────────────────┘
```

- **线上协议** 逆向自 Clawd on Desk 的 `hooks/server-config.js`、`src/server-route-state.js`、`src/custom-applications.js`：`/state` POST + `x-clawd-server: clawd-on-desk` 头校验；200 = 接受，204 = 丢弃（agent id 未注册/被禁用），400 = 未知状态。
- **Agent id 确定性生成**：`custom-<slug>-<sha256(小写 exe 路径)[:12]>`（Windows），与 Clawd `custom-applications.js` 的哈希算法一致——插件算出来的 id 永远等于 Clawd 为同一可执行文件注册的 id。
- **会话收养** — 插件加载时通过 `sessions.list()` 收养已存在的会话，宿主重启后宠物状态能自动恢复。
- **退出清理** — dispose 时尽力补发 `sleeping`；即便没发出去，Clawd 会按 `agent_pid` 存活检测自动清理（DSH 进程退出即收卡）。

## 前置条件

> **可用性说明（先读这个）**：本仓库只包含 DSH 侧插件，**不包含** Clawd on Desk 应用本体。截至撰写时，Clawd on Desk 通过封闭渠道分发（私有 GitHub Releases / 自带更新器，观察到 v0.15.0），**没有公开下载**——网上流传的 `anthropics/clawd-on-desk` GitHub 链接实际无法公开访问；DSH Desktop 同样不是公开开源下载。拿不到 Clawd on Desk 应用本体的人，装了这个插件也不会有宠物出现——请把本插件理解成"已有宠物应用的遥控器"。

1. 已安装并运行 Clawd on Desk（本地端口 23333–23337 之一，`~/.clawd/runtime.json` 有记录）。
2. 在 Clawd 设置里把 DSH 注册为**自定义应用**（Settings → Agents → Add custom application，选择 `DSH Desktop.exe` 或其所在文件夹都行）。注册的 id 是确定性的：`custom-dsh-desktop-<sha256(exe路径小写)[:12]>`。
3. DSH Desktop 2.x（desktop profile，`~/.dsh/profiles/desktop`）。

## 安装

```powershell
cd dsh-clawd-pet
pnpm install   # 安装 schemastery 依赖
dsh plugin --profile desktop add /绝对/路径/dsh-clawd-pet
# 然后重启 DSH Desktop
```

> 注意：`dsh plugin add` 的 pnpm 参数转发在路径含空格/全角字符时会断开。如果你的 checkout 在这样的路径下（比如本机），请手动安装：在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 里加 `"dsh-clawd-pet": "link:<绝对路径>"`，把 `dsh-clawd-pet` 追加进 `dsh.profile.bundles`，然后在 profile 目录里执行 `pnpm install`。

## 验证

```powershell
# 1) 合成配置应包含 clawd-pet 行
dsh --profile desktop --dump-config | Select-String clawd

# 2) 直接对 Clawd 发一条测试状态（宠物应当场表演）
node test/e2e.mjs
```

重启 DSH Desktop 后随便发起一个对话：宠物应在提交时思考、调工具时敲键盘、结束时庆祝。

## 配置（Web 设置 → 插件 → clawd-pet）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `agentId` | `""` | 强制指定 Clawd agent id（留空自动解析：先匹配 Clawd 配置里注册的自定义应用，再按本进程 exe 路径计算） |
| `port` | `0` | 强制 Clawd 端口（0 = 自动发现） |
| `subagents` | `true` | 子代理映射为 juggling |
| `contextUsage` | `true` | 上报上下文用量估算（HUD 圆环） |
| `toolFailures` | `true` | 单个工具失败也播放一次错误动画 |
| `completionText` | `true` | 完成时附带最后一条助手消息文本 |
| `minIntervalMs` | `200` | 同一会话节流窗口（关键状态转换不受限） |
| `timeoutMs` | `1200` | POST 超时 |

## 项目结构

```
dsh-clawd-pet/
├── index.js               # Cordis 插件：配置 schema、事件处理、状态机
├── lib/
│   └── clawd-client.js    # Clawd 本地服务器客户端：id 哈希、端口发现、POST/探测
├── test/
│   ├── smoke.mjs          # 用 mock 会话存储验证插件可加载
│   ├── mapping.mjs        # DSH 事件 → Clawd 状态映射单元测试
│   ├── clawd-id-roundtrip.mjs  # 自定义应用 id 哈希往返测试
│   ├── live-protocol.mjs  # 对运行中的 Clawd 做协议测试（如有）
│   ├── e2e.mjs            # 对 Clawd 的线上协议 + 动画测试
│   └── ...
├── cordis.patch.yml       # DSH bundle patch 元数据
├── package.json
└── README.md / README.zh.md
```

## 开发

```bash
pnpm install
node test/smoke.mjs          # 离线冒烟测试，不需要 Clawd
node test/mapping.mjs        # 状态映射单元测试
node test/e2e.mjs            # 需要 Clawd on Desk 在运行
```

欢迎贡献：请保持插件零额外依赖（只用 Node 内置模块）、上报非阻塞，并为每个新的事件映射补一个测试。

## 故障排查

- **宠物完全不动**：确认 Clawd 在运行（`~/.clawd/runtime.json` 存在且端口可探测）；确认 DSH Desktop 已重启加载插件（日志应出现 `clawd-pet: loaded`）。
- **日志报 "Clawd on Desk is dropping our events"**：agent id 没注册或被禁用。去 Clawd 设置 → Agents 确认 DSH Desktop 已在自定义应用列表且启用；改完后重启 Clawd。
- **卸载**：`dsh plugin --profile desktop remove dsh-clawd-pet`（或从 profile package.json 删掉依赖与 bundles 项后 `pnpm install`），再重启 DSH Desktop；Clawd 侧删除自定义应用即可。

## 实现说明

- 逆向自 Clawd on Desk 的 `hooks/server-config.js`、`src/server-route-state.js`、`src/custom-applications.js`：本地 HTTP 协议（`/state` POST，`x-clawd-server` 头校验，200/204/400 语义）、自定义应用 id 的哈希算法（`custom-<slug>-sha256(lower(exePath))[:12]`，Windows 下路径小写）。
- 插件零侵入：不修改 DSH/Clawd 任何既有文件；上报失败只记日志，绝不影响 agent 主循环（POST 全部 fire-and-forget，串行队列）。
- 会话关闭时尽力补发 `sleeping`；即便没发出去，Clawd 会按 `agent_pid` 存活检测自动清理（DSH 进程退出即收卡）。

## 更新日志

### 0.1.0 (2026-08-16)

- 首个版本：完整的 DSH → Clawd 状态映射、子代理/workflow 折算、审批通知、上下文用量圆环、完成文本、端口与 agent id 自动发现、会话收养、零侵入退出清理。

## 相关项目

- Clawd on Desk — 本插件驱动的桌面宠物（封闭分发，需从其官方更新渠道获取）
- DeepSeek Harness（DSH）— 本插件运行所在的 Agent 框架（DSH Desktop 2.x）

## License

MIT
