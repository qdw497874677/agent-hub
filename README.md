# agent-hub

运行时无关的 agent 工作台。你自带机器和 agent（Pi、OpenCode……），它把任务拆成多个可并行的会话，并把「派生」与「分叉」的关系变成画布上看得见、重开浏览器还在的东西。

一句话验收：重度用户工作一天后，第二天打开浏览器，能认出昨天哪条思路走到哪、哪些是死路，并接着干活。

## 它不是什么

- 不管你的模型 key（那是 agent 自己的事），不做多租户，不做评测排行。
- 不做低代码画布：v1 的节点类型固定，自定义的是布局与视图。
- 不提供「没有任务的新建会话」入口：会话永远挂在一个 Task 上，因为它存在的理由就是推进那件事。

完整定位见 [`docs/product/positioning.md`](docs/product/positioning.md)，用户故事见 [`docs/product/user-stories.md`](docs/product/user-stories.md)。

## 快速开始

需要 Node ≥ 26（直接用 `node` 跑 TypeScript，没有构建步骤）、`pi` 和/或 `opencode` 已经在 PATH 上、以及可用的模型凭据（`pi` 自己那套）。

```bash
npm install
npm run build        # 只构建前端；后端没有构建步骤
npm run up           # 起 server，默认同时拉起本机 worker
```

打开 <http://127.0.0.1:7878>。首次会让你指一个本地目录——任务就活在它里面。

开发时用 `npm run dev`（server + Vite 热更新并行跑）。

装成 systemd 用户服务：

```bash
scripts/install.sh                # 装服务并 enable --now
scripts/install.sh --no-systemd   # 只装依赖与构建
```

### 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `HUB_HOST` / `HUB_PORT` | `127.0.0.1` / `7878` | 绑非 loopback 却**没有** `HUB_TOKEN` 时拒绝启动 |
| `HUB_TOKEN` | 空 | server 与 worker 之间的共享密钥；也是 HTTP 的 Bearer token |
| `HUB_DATA_DIR` | `~/.local/share/agent-hub` | SQLite（WAL）与运行数据 |
| `HUB_SPAWN_WORKER` | `1` | 是否由 server 拉起本机 worker |
| `PI_COMMAND` / `PI_SESSION_DIR` | `pi` / Pi 自己的 | 换一个 Pi 可执行文件或会话目录 |
| `PI_DEFAULT_MODEL` | 空 | 强制指定模型（`provider/model,provider/model`）；留空则问 Pi 自己 |
| `OPENCODE_COMMAND` | `opencode` | OpenCode 可执行文件 |
| `WORKER_ID` / `WORKER_LABEL` / `WORKER_ORIGIN` | 随机 / `本机` / `local` | 远程机器上部署 worker 时用 |

## 架构：内核不认识进程

```
apps/server   ── 控制面：HTTP + SSE，组合根，持有 SQLite
apps/worker   ── 数据面：跑在本机（或远程机器），持有 agent 进程
apps/web      ── 画布

packages/domain       零依赖。四个聚合 + 11 个端口 + 用例
packages/contract     Zod 定边界，z.infer 出类型
packages/storage-sqlite、node-gateway、adapters/{pi,opencode}
```

四个聚合是 `Task / Session / Agent / Artifact`。**Server 与 Worker 不是领域概念**，它们是适配器：内核里没有「进程」「节点」「连接」这些词。`packages/domain` 的 `dependencies` 为空，由 `npm run check:domain` 强制。

判据是可机械检查的：**删掉任一适配器包，`packages/domain` 仍能编译。**

## 新增第三个 agent

这正是这套架构要守住的事，而且它是个自动门槛，不是人工清单：

1. 在 `packages/adapters/<name>/` 建包，实现 `AgentRuntime`（`descriptor` + `start(spec)`），把 agent 自己的事件映射成六种 `SessionEvent` 之一。
2. 按能力如实填 `CapabilityMatrix`：做不到就写 `limited(reason)` 或 `denied(reason)`，画布会把原因显示出来，而不是假装支持。
3. 加一组 conformance fixture（`src/conformance.test.ts`），跑同一套 runner。
4. 在 `apps/worker/src/main.ts` 的 runtimes 里挂上。

完成的标志：`npm test` 绿，且 `git diff --stat` 显示 `packages/domain` 与 `apps/web` **零改动**。OpenCode 就是这样加进来的。

L1（把 agent 的原生 TUI 嵌进来，走 tmux 控制模式）是 T2：降级规则已经定好——不能 fork、不能作为血缘端点、不能结构化检索。它不进 MVP 的原因不是难，是它会稀释「画布上看见血缘」这条主线。

## 开发

```bash
npm run ci     # check（三层架构约束）+ typecheck + 单测
npm run e2e    # Playwright：真浏览器 + 真 agent，从建项目到模型吐出第一段文字
```

`npm run check` 是三个零依赖脚本：domain 纯净性、包间 import 边界、端口签名不许出现 `sqlite`/`zod`/`Row`/`Request` 等实现细节。它们挡的是「架构在三个月后自己腐化」这件事。

用系统 chromium 跑 e2e（不下载 Playwright 自带浏览器），路径写死在 `playwright.config.ts` 的 `launchOptions.executablePath`。

## 文档

| 文件 | 内容 |
| --- | --- |
| [`GLOSSARY.md`](GLOSSARY.md) | 术语表。写代码前先看，用词不一致比实现错误更贵 |
| [`docs/product/positioning.md`](docs/product/positioning.md) | 定位、能力分层（T1/T2/T3）、反故事 |
| [`docs/product/user-stories.md`](docs/product/user-stories.md) | 22 条用户故事，顺序即优先级 |
| [`docs/plan/mvp-plan.md`](docs/plan/mvp-plan.md) | 六个纵切 milestone 与端口契约 |
| [`docs/architecture/tech-stack.md`](docs/architecture/tech-stack.md) | 选型与理由 |
| [`docs/design/visual-direction.md`](docs/design/visual-direction.md) | 深色控制室：色板、线型语义、状态位 |
| [`docs/adr/`](docs/adr) | 三个不可轻易回退的决定：重写与四聚合、TS 全栈、模型列表来自 agent |
