# agent-hub

运行时无关的 agent 工作台。你自带机器和 agent（Pi、OpenCode……），它把任务拆成多个可并行的会话，并把「派生」与「分叉」的关系变成画布上看得见、重开浏览器还在的东西。

一句话验收：重度用户工作一天后，第二天打开浏览器，能认出昨天哪条思路走到哪、哪些是死路，并接着干活。

## 它不是什么

- 不管你的模型 key（那是 agent 自己的事），不做多租户，不做评测排行。
- 不做低代码画布：v1 的节点类型固定，自定义的是布局与视图。
- 不提供「没有任务的新建会话」入口：会话永远挂在一个 Task 上，因为它存在的理由就是推进那件事。

完整定位见 [`docs/product/positioning.md`](docs/product/positioning.md)，用户故事见 [`docs/product/user-stories.md`](docs/product/user-stories.md)。

## 快速开始

> 📖 **第一次用？看 [使用指南](docs/guide.md)**：从安装、加机器、建项目、派生会话到资产中心，一步一图。

需要 Node ≥ 26（直接用 `node` 跑 TypeScript，没有构建步骤）、`pi`、`opencode`、`grok` 中至少一个已经在 PATH 上、以及可用的模型凭据（`pi` 自己那套）。

```bash
npm install
npm run build        # 只构建前端；后端没有构建步骤
npm run up           # 起 server，默认同时拉起本机 worker
```

打开 <http://127.0.0.1:7878>，用邮箱注册或登录（第一个账号是这台 hub 的主人）；之后新建项目、建任务、派生会话，详见[使用指南](docs/guide.md)。

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
| `GROK_COMMAND` | `grok` | Grok Build（xAI 官方 CLI）可执行文件；需先 `grok login` 或设 `XAI_API_KEY` |
| `WORKER_ID` / `WORKER_LABEL` / `WORKER_ORIGIN` | 首次生成后固定 / `本机`（远程为主机名） / `local` | Worker 的身份、显示名、来源；id 存在 `~/.config/agent-hub/worker-id` |
| `WORKER_ROOTS` | `$HOME` | 这台 Worker 允许 hub 访问的目录（冒号分隔）：目录浏览、`@` 文件、附件、开会话都只在这里面。远程 Worker 和本机 Worker 都强制；没设置时只放开 `$HOME` |
| `HUB_STALL_MS` | `300000` | 一轮跑着却这么久（毫秒）没有新输出，就在卡片上提醒「可能卡住了，可以中断」并写日志；设 0 关掉巡检 |

### 多台机器：任何机器都可以登记成 Worker

在 Worker 面板点「＋ 添加机器」，把弹出的一行命令拿到新机器上跑（只需要 git 和 curl，配对码 15 分钟、一次性）：

```bash
curl -fsSL http://100.x.y.z:7878/install-worker.sh | HUB_PAIR=ahw_pair_… bash
```

每台机器拿到自己的凭据，可以单独吊销。老方式（共享 `HUB_TOKEN`）仍可用：
`HUB_URL=ws://100.x.y.z:7878/worker HUB_TOKEN=… WORKER_LABEL=工作站 scripts/install-worker.sh`。

它会出现在顶栏的 Worker 面板里（在线/离线、最后在线、agent、会话数、主机、目录）。新建项目时选「目录在哪台机器上」，
目录选择器浏览的就是那台的文件系统；项目里开的会话都跑在那台。断线会自动重连并接回还在跑的会话，
心跳超时的 Worker 标为离线。细节见 [docs/remote-access.md](docs/remote-access.md#多台机器)。

**更新 Worker**：运营后台「机器」页显示每台的版本（package 版本 + 提交号），和 hub 不一致的标「过期」。
主人可以点单台的「更新」或「更新全部过期」：hub 只下发自己的提交号，Worker 检查工作区干净 → `git fetch` →
快进到该提交 → `npm ci --omit=dev` → 退出由 systemd 重启；失败自动回滚到原提交，进度和日志尾巴回到页面上，操作进审计。
新版本**起不来**也会回滚：退出重启前 Worker 写下 `~/.config/agent-hub/update-pending`（原提交、目标提交、启动次数），连上 hub 稳定 15 秒后自己删掉；systemd 的 `ExecStartPre` 跑 `scripts/worker-boot-guard.sh`，连续 2 次启动（`WORKER_BOOT_ATTEMPTS`）都没删掉就回到原提交、重装依赖再启动。守卫是纯 bash，不依赖新代码。老的安装重跑一次 `scripts/install-worker.sh` 才会带上这一行。
本机 Worker 与 hub 共用代码，更新 hub（`git pull` 后重启）即可；点它的「更新」只做演练。
协议版本不兼容的 Worker 会被拒绝并提示在那台机器上手动运行 `scripts/update-worker.sh [提交号]`。

## 架构：内核不认识进程

```
apps/server   ── 控制面：HTTP + SSE，组合根，持有 SQLite
apps/worker   ── 数据面：跑在本机（或远程机器），持有 agent 进程
apps/web      ── 画布

packages/domain       零依赖。四个聚合 + 11 个端口 + 用例
packages/contract     Zod 定边界，z.infer 出类型
packages/storage-sqlite、node-gateway、adapters/{acp,pi,grok}
```

四个聚合是 `Task / Session / Agent / Artifact`。**Server 与 Worker 不是领域概念**，它们是适配器：内核里没有「进程」「节点」「连接」这些词。`packages/domain` 的 `dependencies` 为空，由 `npm run check:domain` 强制。

判据是可机械检查的：**删掉任一适配器包，`packages/domain` 仍能编译。**

## 两种扩展方式

agent 说的是**不同**的协议，所以「可拓展」在实践里只有两条路：

**一、它说 ACP —— 加一条配置，不写代码。**

```bash
ACP_AGENTS='[{"id":"opencode","label":"OpenCode","command":"opencode","args":["acp"]},
             {"id":"claude","label":"Claude Code","command":"claude-code-acp","args":[]}]'
```

`packages/adapters/acp` 是通用的：握手、会话、事件、可调项（模型 / 思考强度 / 模式）全部按
ACP 规范走，它不知道自己在跟哪个 agent 说话。OpenCode 就是这么接进来的。

**二、它自顾自说话 —— 写一个 adapter。**

1. 在 `packages/adapters/<name>/` 建包，实现 `AgentRuntime`（`descriptor` + `start(spec)`），把 agent 自己的事件映射成七种 `SessionEvent` 之一。
2. 按能力如实填 `CapabilityMatrix`：做不到就写 `limited(reason)` 或 `denied(reason)`，画布会把原因显示出来，而不是假装支持。
3. 把可调项也如实报上来（`RuntimeOption[]`）：**不要**在平台侧维护模型表，见 ADR 0003、0007。
4. 加一组 conformance fixture（`src/conformance.test.ts`），跑同一套 runner。
5. 在 `apps/worker/src/main.ts` 的 runtimes 里挂上。

完成的标志：`npm test` 绿，且 `git diff --stat` 显示 `packages/domain` 与 `apps/web` **零改动**。Pi 就是这样加进来的——它没有 ACP，只能走第二种。

L1（把 agent 的原生 TUI 嵌进来，走 tmux 控制模式）是 T2：降级规则已经定好——不能 fork、不能作为血缘端点、不能结构化检索。它不进 MVP 的原因不是难，是它会稀释「画布上看见血缘」这条主线。

## 界面

### 三个词

- **任务（Task）**：一件要达成的事，绑在一个本地目录上。它是画布上的锚点。
- **会话（Session）**：一次具体的尝试，由一个 agent 在跑。
- **派生（derive）**：**从任务开出一条会话**。任务说清要什么，会话是试着达成它的一条路。
  同一个任务可以派生很多条，它们并排跑，每条都有一条实线连回任务。

于是「这活儿怎么走到今天的」变成一张图：任务在左，会话在右，会话之间还能**分叉**（从那句话
说的位置重新长出一条），分叉用虚线标出切在第几条事件。

### 三层分辨率

同一个项目有三种看法，切换不丢草稿、不丢选中：

| 视图 | 回答什么问题 |
| --- | --- |
| **画布** | 这些思路之间是什么关系？哪条是死路？ |
| **列表** | 一共开了多少条，各自什么状态？（画布的低成本降级形态，不做看板） |
| **专注对话** | 它到底说了什么？现在我要接着说一句。 |

**专注对话**是说话的地方：双击画布上的会话卡（或点卡片上的「对话」、首页点一条最近会话、
列表里点一行）就进去，一条会话整屏，问与答同屏，下面是输入框——`⌘↵` 发送，运行中的 `■` 是中断。
对话记录来自 journal，所以刷新、换机器、第二天回来都还在。

首页是门厅，两栏：左窄栏是「在哪儿干」（项目列表 + 节点状态），右宽栏是
「接着干哪条」（最近的会话，按今天 / 昨天 / 更早分组，顶部能过滤）。点一条会话直接进去说话——
「接着干」不该先看画布再自己找。

新建项目时目录可以从目录树里点选（`GET /api/fs/directories`），也可以直接打绝对路径。

其它：

- **画布**：任务与会话自由排布，`派生` 实线与 `分叉` 虚线区分两种血缘；节点可拖动，布局持久化。
- **搜索（⌘K / Ctrl+K）**：搜任务标题与会话正文，回车跳到画布上那个节点。
- **检查器**（画布右栏）：能力矩阵三态（可用 / 受限 / 无权限，都带原因）、产出物、分叉点、事件流。

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
| [`docs/remote-access.md`](docs/remote-access.md) | 从手机 / 另一台电脑安全访问：Tailscale、HUB_TOKEN、PWA；多台机器 |
| [`docs/design/visual-direction.md`](docs/design/visual-direction.md) | 深色控制室：色板、线型语义、状态位 |
| [`docs/guide.md`](docs/guide.md) | **使用指南**：安装、加机器、项目与任务、派生会话与工作空间、画布、资产中心、常见问题 |
| [`docs/design/accounts.md`](docs/design/accounts.md) | 账号体系：邮箱注册、主人与成员、测试账号 |
| [`docs/design/worker-enrollment.md`](docs/design/worker-enrollment.md) | Worker 接入：一次性配对码 + 每台机器专属凭据 |
| [`docs/design/multi-worker-research.md`](docs/design/multi-worker-research.md) | 多台 Worker 的界面调研（截图在 `docs/design/multi-worker/`） |
| [`docs/design/harness-readiness.md`](docs/design/harness-readiness.md) | Harness 就绪探测：装了不等于能用，变灰与原因 |
| [`docs/design/workspaces.md`](docs/design/workspaces.md) | 工作空间：持久 / 临时、按机器、运行面板 |
| [`docs/design/tasks-and-capabilities.md`](docs/design/tasks-and-capabilities.md) | 任务模型 v2（工作日志）与 agent 能力接入层 |
| [`docs/design/asset-hub.md`](docs/design/asset-hub.md) | 资产中心：技能、指令、MCP、密钥、按机器下发 |
| [`docs/adr/`](docs/adr) | 八个不可轻易回退的决定，见下表 |

| ADR | 决定 |
| --- | --- |
| [0001](docs/adr/0001-rewrite-hexagonal-core-four-aggregates.md) | 重写：六边形内核与四个聚合 |
| [0002](docs/adr/0002-typescript-node-everywhere.md) | TypeScript + Node 全栈 |
| [0003](docs/adr/0003-model-list-comes-from-the-agent.md) | 模型列表来自 agent |
| [0004](docs/adr/0004-serialize-events-per-session.md) | 每条会话的事件串行落盘 |
| [0005](docs/adr/0005-search-the-session-text-not-events.md) | 搜索查文本投影，不查事件 |
| [0006](docs/adr/0006-prompts-are-journal-events.md) | 用户的提问也是事件 |
| [0007](docs/adr/0007-options-come-from-the-agent.md) | 可调项（思考强度等）来自 agent，不是来自平台 |
| [0008](docs/adr/0008-accounts.md) | 账号体系：单 Workspace、主人 + 成员、按机器签发接入凭据 |
