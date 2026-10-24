# agent-hub 技术选型

状态：草案 v1。配套 [产品定位](../product/positioning.md)、[用户故事](../product/user-stories.md)、[ADR 0002](../adr/0002-typescript-node-everywhere.md)

---

## 1. 选型原则

三条，按优先级排。所有取舍都回到这三条：

1. **少一层就少一处腐化。** 能用一个进程解决的不用两个，能用一个依赖解决的不用三个。wemux-lite 的 `docs/design/` 体量与它的依赖数量是同一条曲线。
2. **端口决定技术可换，语言不决定。** 定位 §7 的 8 个端口是真正的解耦点。凡是端口挡住了的技术决定，都可以晚点再做，且做错代价有限。
3. **单人 v1 的开发速度 > 运行时性能。** 这个产品的瓶颈是"能不能在周末推进一个闭环"，不是 QPS。

## 2. 前置事实核查（2026-11 实测）

选型前先确认两个 agent 到底能说什么协议，因为这决定 adapter 层长什么样：

| 事实 | 出处 | 对选型的影响 |
|---|---|---|
| **Pi 1.3.0 没有 ACP**；提供 `--mode rpc`（长驻、JSONL 双向、stdio）与 `--mode json`（一次性、JSONL 事件流） | `pi/docs/cli-integration.md`、`pi/docs/rpc.md` | L2 adapter = 起进程 + JSONL 帧 + 关联 id。无需 SDK |
| **OpenCode 2.0.18 有 `opencode acp`**（Agent Client Protocol over stdio），另有 `opencode serve`（HTTP v2 API + `--stdio`） | `opencode acp --help` | L2 adapter = ACP 客户端，或 HTTP 客户端 |
| **两个 agent 说不同协议** | 上两行 | adapter 端口不是可选项，是必需项；也**没有单一厂商协议可押注**，所以协议层必须自有 |
| 本机 Node **v26.8.2**：`.ts` 直跑、内置 `node:sqlite`（实测 `DatabaseSync` 可用）、内置 `node --test` | 实测 | 不需要 tsx / ts 构建步骤 / better-sqlite3 原生编译 / jest |
| 本机 tmux 3.7c、sqlite3 3.53.4 | 实测 | L1 TUI 嵌入与本地调试都有现成载体 |

**关键推论**：既然没有哪家 SDK 值得绑死，语言选择的依据就从"能不能调 SDK"转向"工程效率"。这直接指向 TypeScript。

## 3. 总选型表

| 层 | 选择 | 一句话理由 |
|---|---|---|
| 语言 | **TypeScript**（前后端同语言） | 领域类型在 server、worker、web 三处本就相同，同语言让契约零成本一致 |
| 运行时 | **Node.js 26**，无构建步骤 | `.ts` 直跑、`node:sqlite`、`node --test` 都在核心里 |
| 仓库 | **npm workspaces** | 单人多包，pnpm/bun 的收益不抵多一个工具的认知成本 |
| HTTP | **Hono** | Web 标准 Request/Response、路由与中间件够用、不引入框架生命周期概念 |
| 实时 | **WebSocket（`ws`）+ JSONL 帧** | 双向：发消息、停止、审批都要上行。SSE 只能下行 |
| 存储 | **SQLite（`node:sqlite`, WAL）+ 文件系统存 Artifact** | 单文件即备份；事件日志要 `(session_id, seq)` 索引与事务，纯文件做不到 |
| 契约 | **Zod schema 定义边界 DTO，`z.infer` 出类型** | adapter 与 agent 送来的都是不可信输入，运行时校验本来就是必需的 |
| 前端框架 | **React 19 + Vite 7** | 画布节点必须是真实交互表面（DOM），React 生态最成熟 |
| 样式 | **Tailwind v4** | 单人项目不要手写 CSS 体系 |
| 路由/数据 | **TanStack Router + TanStack Query** | 文件无关的类型安全路由 + 服务端状态缓存，二者职责不重叠 |
| 组件 | **Base UI**（只此一家） | Radix 的官方后继。**不同时用 Radix**（wemux-lite 同时装了 Radix 与 Base UI，是重复依赖） |
| 画布 | **React Flow（`@xyflow/react`）** | 血缘边是一等公民；节点是 DOM，流式文本与输入框天然可用 |
| 画布局部状态 | **Zustand**（只存 viewport / 拖拽草稿） | 与 Query 严格分工：服务端状态归 Query，视口归 Zustand |
| 终端嵌入 | **xterm.js + tmux 控制模式**（T2） | 见 §7 F3 |
| 测试 | `node:test`（domain/adapter）+ **Vitest**（web）+ **Playwright**（7 步闭环） | 闭环测试是唯一能证明产品的测试 |

**明确不引入**：`ai`（Vercel AI SDK，产品不调模型，agent 才调）、tRPC（agent 要调 API，必须是普通 HTTP）、Next.js（无 SSR 需求，画布是纯客户端应用）、Prisma/Drizzle（`node:sqlite` 够用，ORM 会让领域模型向表结构妥协）、Electron/Tauri（桌面端是 T3）。

## 4. 后端设计

### 4.1 为什么是 TypeScript 而不是 Go

Go 的三个真实优势，逐个称一下：

| Go 的优势 | 在本产品的实际权重 | 结论 |
|---|---|---|
| 单一静态二进制，`NodeProvisioner` 自动下发安装（T2）变得简单 | **真实且重要**。Node 要分发要么带运行时、要么用 `bun build --compile` | 这是 Go 唯一的强论点，见 §7 F1 |
| PTY / 进程监督（creack/pty）成熟 | 中等。L1 是 T2，且 tmux 可替代 node-pty | 不构成决定因素 |
| Goroutine 支撑大量并发会话 | 低。单机重度用户同时在跑的会话是个位数 | 否定 |

TypeScript 的两个优势，权重更高：

- **契约零成本。** Task/Session/Agent/Artifact 的类型在 server、worker、web 三处必须一致。同语言 = 一个 `contract` 包，改一处三处编译报错。跨语言 = OpenAPI/protobuf + 代码生成 + 生成物漂移，这是单人多包项目最容易烂掉的地方。
- **协议处理的同构。** Pi 的 RPC 与 ACP 都是 JSON 帧；前端也在处理同一批 JSON 帧。一种 JSON 处理习惯贯穿全栈。

**结论**：TS。Go 的优势集中在"分发"这一件事上，而这件事被 `NodeProvisioner` 端口隔离了——将来真被分发卡住，重写 worker 为 Go 不触碰领域层，这正是端口的价值。

### 4.2 复核：为什么不是 DuckDB

用 DuckDB 的直觉是对的——agent 产生的数据看起来是分析型的。但它落在错的一层。四条理由，前两条是硬的：

1. **并发模型对不上进程拓扑。** DuckDB 官方文档只给两种 in-process 模式：*一个*进程读写，或多个进程**只读**。官方 discussion #4899 说得更直接：「多个进程对同一个 DuckDB 文件的并发写不受支持，且未来也不太可能支持——它们会争同一份 WAL、同一批 block。」而我们必然是 server + worker 两个进程，且开发期每天都在服务运行时用 CLI 看一眼库——这在 SQLite WAL 下是免费的，在 DuckDB 下是硬冲突。
2. **依赖代价把我们刚解决掉的问题装回来。** `node:sqlite` 是 Node 26 内置；DuckDB 要 `@duckdb/node-api` 原生绑定，这正是砍掉 `better-sqlite3` 时去掉的那类麻烦。
3. **负载形状是 OLTP。** 点查（`session by id`）、游标范围扫（`seq > cursor`）、小事务 upsert（状态位、画布布局、`last_acked_seq`）——DuckDB 是列存，最擅长的是大范围聚合，最不擅长的是单行更新与逐条小事务提交。
4. **数据量差两个数量级。** 重度用户一年约 10^6 量级事件行；DuckDB 的优势门槛在 10^7–10^8。

**但两者不是竞争关系，是分工关系**：控制面用行存（SQLite），分析面用列存（DuckDB）。DuckDB 的 `sqlite` 扩展可以 `ATTACH 'agent-hub.db' (TYPE SQLITE)` 直接查现有库，所以选 SQLite **不锁死** DuckDB。T2 的用量统计（token / 时长 / 工具分布）就是它的位置——那时是只读、独立进程、离线聚合，刚好绕开单写者限制。

### 4.3 与 wemux-lite 的三处刻意差异

| 维度 | wemux-lite | agent-hub | 理由 |
|---|---|---|---|
| 构建 | `tsc` 逐包构建 + `tsx` 运行 + `build:packages` 串行脚本 | **无构建**，Node 26 直跑 `.ts` | Node 26 已原生支持；构建管线是纯损耗 |
| SQLite | `better-sqlite3`（原生模块，需编译） | **`node:sqlite`**（内置 `DatabaseSync`） | 去掉原生编译，装起来不再依赖编译器 |
| HTTP | 裸 `node:http` + `ws`（依赖表里只有 jose/ws，说明路由是手写的） | **Hono + ws** | 手写路由是单人项目里最不产生价值的那类代码 |

### 4.4 事件日志：fork 的地基

Fork 要求"固定的事件游标"（用户故事 S6.2），所以日志必须是**追加式且每 Session 单调递增**：

```
journal(session_id TEXT, seq INTEGER, type TEXT, payload JSON, at INTEGER,
        PRIMARY KEY (session_id, seq))
```

- fork = 新 Session + `origin_session_id` + `origin_seq`，读历史时只回放 `seq <= origin_seq`
- 来源续写不进入目标上下文 —— 靠游标天然成立，不需要拷贝消息
- Session 恢复 = 重放 `seq > last_acked_seq`
- 崩溃后状态标"中断"而非"运行中"（S7.1）= 启动时把无终态记录的 Session 批量改写

Artifact 存文件系统（按 Session 分目录），SQLite 只存元数据与路径。**不把二进制塞进 SQLite**——备份策略因此变成"拷一个 .db + 拷一个目录"。

### 4.5 协议版本

WebSocket 帧与 HTTP API 各带一个整数版本，握手时协商。v1 只需要"版本不一致就拒绝并给出人话原因"，不需要兼容矩阵——那是 T2 的 `NodeGateway` 里的事。

## 5. 端口 ↔ 实现映射

| 端口（定位 §7） | v1 实现 | T2 时的第二个实现 |
|---|---|---|
| `TaskRepository` / `SessionRepository` / `ArtifactRepository` | SQLite | Postgres |
| `AgentRuntime` | `adapter-pi`（RPC JSONL）、`adapter-opencode`（ACP） | `adapter-l1`（tmux + xterm） |
| `SessionEventStream` | WS 广播 + journal 回放 | 更多事件类型 |
| `NodeGateway` | ws：Worker 主动出站连 Server | 能力协商、远程升级 |
| `NodeProvisioner` | **空实现（抛「未实现」）** | 下发安装包 + 校验 |
| `CapacityPolicy` | **空实现（抛「未实现」）** | 配额 / 调度 |
| `WorkspaceFS` | 本地目录（`node:fs`） | 多目录、远端仓库 |
| HTTP API | Hono | CLI、移动端 |

## 6. 仓库布局

```
agent-hub/
├── apps/
│   ├── server/          入站适配器：Hono HTTP + ws；装配
│   ├── worker/          出站适配器：spawn agent、tmux、连 Server
│   └── web/             React + Vite
├── packages/
│   ├── domain/          Task/Session/Agent/Artifact + 端口声明。**零依赖**
│   ├── contract/        Zod DTO、WS 帧、HTTP 形状
│   ├── storage-sqlite/  实现三个 Repository
│   ├── node-gateway/    Worker↔Server 连接（双端复用）
│   └── adapters/
│       ├── pi/          RPC JSONL → SessionEvent
│       ├── opencode/    ACP → SessionEvent
│       └── l1/          tmux + PTY → SessionEvent（T2）
└── e2e/                 Playwright：7 步闭环
```

对比 wemux-lite 的 6 个共享包（`domain`、`server-domain`、`connector`、`agent-interchange`、`wire-protocol`、`web-contract`、`web-client`）——**边界不清是包数量增多的原因，不是结果**。这里只留 5 个，且每个包能用一句话说清它是什么、不是什么：

- `domain`：业务不变量。不认识 HTTP/DB/进程。
- `contract`：跨进程字节长什么样。不含业务规则。
- `storage-sqlite`：只做持久化与查询。
- `node-gateway`：只做连接、重连、补传。
- `adapters/*`：只做"厂商协议 → SessionEvent"翻译。

**CI 强制一条**（用户故事 X2）：`packages/domain` 的 `package.json` 不允许出现任何 `dependencies`，任何 import 都不允许指向 `apps/*` 或 Node 内置模块（`node:crypto` 之类除外，且需逐个批准）。

## 7. 需要你拍板的四个分叉

### F1 · Worker 用 TS 还是 Go

**TS（推荐）**：与 Server 共用 `contract` 与 `domain`，一个工具链，`NodeProvisioner` 将来靠下发 Node 单文件包（`bun build --compile` 或 `node --experimental-sea`）解决。
**Go**：分发与 PTY 天然更好，但 `SessionEvent` 协议要在两处各写一遍。
➡️ **TS**。理由：分发问题可以延后到 T2 才痛，而跨语言契约问题从第一天就开始痛。

### F2 · 画布库：React Flow / tldraw / 自绘

**React Flow**：血缘边一等公民、节点是 DOM、有现成的拖拽/缩放/小地图。
**tldraw**：自由画布手感最好，但边不是一等公民，血缘要么画成箭头贴纸要么自己补。
**自绘**（绝对定位 + `dnd-kit` + 手写 transform）：零依赖，但缩放/平移/吸附/连线要自己写，约 2–3 周。
➡️ **React Flow**。理由：S6.3/S6.4 要的是"能读出哪条思路从哪来"，那是有向图语义，不是自由画布语义。手感是次要的。

### F3 · L1 终端：tmux 控制模式 还是 node-pty

**tmux 控制模式（推荐）**：本机已有 tmux 3.7c；**顺带解决持久化**——Worker 重启后 tmux session 仍在，正好对上 S7.1/S7.3；无原生模块。
**node-pty**：更贴"原生 PTY"，但要原生编译，且进程随 Worker 死。
➡️ **tmux**。但要求写进定位的实现约束：**L1 会话的持久性由 tmux 承载，不由平台承载**。代价是 tmux 成为安装依赖（可检测并给出人话提示）。

### F4 · 分发形态

**npm 包 + `bin` + systemd user unit（推荐）**：`npx agent-hub up` 起步；Worker 由 systemd user 常驻。
**Docker compose**：安装最省心，但容器里的 PTY/tmux 会破坏 L1 与"会话在宿主机存活"这两条。
**单二进制**：需要先选 Go（F1）。
➡️ **npm + systemd**。理由：这是给"自己机器上跑 agent"的人用的东西，agent 本来就需要宿主机环境与凭据，容器化会切断这层。
