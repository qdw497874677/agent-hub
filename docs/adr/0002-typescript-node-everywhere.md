# 技术栈：TypeScript 全栈 + Node 26 无构建 + SQLite 单文件

**Status**: accepted

## 背景与决定

前后端同用 **TypeScript**，运行时 **Node.js 26**（`.ts` 直跑、`node:sqlite`、`node --test` 全在核心里，无构建步骤），HTTP 用 **Hono**，实时用 **WebSocket + JSONL 帧**，存储用 **SQLite（WAL）单文件 + 文件系统存 Artifact**，前端 **React 19 + Vite 7 + Tailwind v4 + TanStack Router/Query + Base UI + React Flow**。完整选型见 [技术选型](../architecture/tech-stack.md)。

## 为什么不是 Go

Go 的真实优势只有一条在本产品上权重很高：**单一静态二进制让 `NodeProvisioner`（T2 自动下发安装）变简单**。另两条——PTY 成熟（L1 是 T2，且 tmux 可替代 node-pty）、goroutine 扛并发会话（单机重度用户的并发会话是个位数）——都不构成决定因素。

反方向的权重更高：**契约零成本**。Task / Session / Agent / Artifact 的类型必须在 server、worker、web 三处一致。同语言 = 一个 `contract` 包，改一处三处编译报错；跨语言 = OpenAPI/protobuf + 代码生成 + 生成物漂移，这是单人多包项目最容易烂掉的地方。

而且分发问题被端口隔离了：真被卡住，把 worker 重写为 Go 不触碰领域层。这正是端口存在的意义。

## 为什么没有单一厂商协议可押注

实测（2026-11）：**Pi 1.3.0 没有 ACP**，只有 `--mode rpc`（长驻 JSONL 双向）与 `--mode json`（一次性事件流）；**OpenCode 2.0.18 有 `opencode acp`**（ACP over stdio）与 `opencode serve`（HTTP v2）。两家说不同协议。

推论：协议层必须自有（`SessionEvent`），不押注任何一家的 SDK。语言选择的依据因此从「能不能调 SDK」转向「工程效率」，这也削弱了「必须用 TS 才能用 Pi SDK」这条本不存在的理由——我们用 RPC，不用 SDK。

## 为什么 SQLite 而不是 Postgres

Fork 要求固定的事件游标（用户故事 S6.2），所以日志必须追加式且每 Session 单调递增，需要 `(session_id, seq)` 主键与事务查询。纯 JSONL 文件做不到这两点。

单用户 v1 用 Postgres 是纯粹的运维负担。SQLite WAL 单文件让备份策略退化成「拷一个 .db + 拷一个 Artifact 目录」。`node:sqlite`（内置 `DatabaseSync`）取代 wemux-lite 的 `better-sqlite3`，去掉原生编译依赖。`TaskRepository` / `SessionRepository` / `ArtifactRepository` 端口让 Postgres 成为一个后续适配器。

## 后果

- 无构建步骤：不跑 `tsc` 产出、不用 `tsx`。代价是 Node 26 为最低版本要求。
- tmux 成为 L1 的实现载体（T2），并成为安装依赖。换来的是 L1 会话的持久化由 tmux 承载——Worker 重启后会话仍在，正好对上 S7.1/S7.3。
- `packages/domain` 零依赖，由 CI 强制（用户故事 X2）。Zod 只出现在 `packages/contract` 边界，不进入领域。
- 分发形态是 npm 包 + systemd user unit，不是 Docker：容器会切断 PTY/tmux 与宿主机凭据，而这两样正是产品的立身前提。
