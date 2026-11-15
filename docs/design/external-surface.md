# 对外能力面：工作台作为平台，资产与任务共用一套授权

状态：设计（2026-11-15）。覆盖 #226（资产集/快照/不可变版本库）、#216 P2（对外 MCP）、
任务进展订阅，以及它们共同依赖的身份与授权。

## 1. 问题：三条入口、三套语义

外部调用方今天能碰到的入口有三条，但彼此不一致：

| 入口 | 能做什么 | 身份 | 资产 | 进展 |
| --- | --- | --- | --- | --- |
| `/openapi/v1`（HTTP + token） | 任务、会话、日志 | `ApiToken`，`ahb_` 为 bot | 只能跟随项目生效集 | 读 `task_log_entries` |
| MCP（hub 内部工具面） | 5 组工具（task/message/memory/context/git/…） | `ToolGrant`，随会话签发 | 会话启动时定死 | 无 |
| 群 / Bot 会话 | 聊天即派活 | bot 授权 + 群成员 | 同项目 | 群帖 / 调度通知 |

结果是：同一个「派一个活给工作台、看它干到哪了、用到哪些技能」的需求，走不同入口要
用不同概念、不同权限模型，能力也不齐。资产是这条链上最明显的短板——外部调用方无法
指定「这次用哪些资产」，也无法知道实际用了哪些版本。

## 2. 收敛点：能力面（Capability Surface）

工作台对外只提供**一个**能力面，三条入口都是它的传输层：

```
调用方（外部 agent / bot / 群成员）
   │  HTTP /openapi/v1        MCP (Streamable HTTP)        群消息
   ▼
Capability Surface ── Actor（谁授权、以谁名义、经哪条渠道）
   │
   ├─ 任务：create / get / log / cancel / progress
   ├─ 资产：catalog / sets / pin（只读优先）
   ├─ 会话：get / events / derive / stop
   └─ 运行时工具：git、memory、context（按 scope）
```

规则：

- **能力即工具，工具即 scope**。HTTP 路由、MCP 工具、agent 内部工具共用同一个
  `ToolGateway` 与 `ToolScope`；新增能力只定义一次。
- **Actor 冻结在授权上**。`ToolGrant.actor` 记录 `{userId, via}`，工具执行时按冻结身份
  求权限（#221 步骤 3 已落地）；外部 MCP 的 `via: 'connector'`，群为 `'group'`，界面为
  `'web'`。
- **默认最小**：外部调用方默认 `task:read` + `task:log:read` + `asset:read`；写能力
  （`task:create`、`git`、`memory.write`）必须显式授权，且按项目边界校验。
- **一条调用链一个 correlation id**：`taskId` 作为回执，`sessionId` 与 `assetRevision`
  挂在任务详情上，调用方不需要理解会话。
- **v1 对外开三个模块**（§5.1）：任务、项目、资产，各自独立 scope 与审计前缀。
  资产模块只组合已审核资产，不做导入/审核/密钥。

## 3. 资产：AssetSet 是外部调用方唯一需要理解的单位

`#226` 的 P1–P4 按外部能力面重新排序，理由：外部调用方要的是「这次用哪套能力」，
而不是逐个资产 id。

### 3.1 名词

- **Asset**：一种内容（skill / instruction / mcp），有不可变版本（digest）。
- **AssetSet**：具名、可授权的资产清单，`items: [{assetId, pin: digest|'follow'}]`。
  作用域复用资产：personal / team / hub。只能引用**已发布**版本。
- **会话快照**：会话首次启动时解析出的 `{assetId, kind, name, digest}` 列表，落库为权威；
  resume / 重新托管一律按快照。

### 3.2 绑定优先级

会话启动请求（`assetSetId` 或临时 items）> Bot `defaultAssetSetId` > 项目生效集。

默认**叠加**（项目集打底，AssetSet 按名称覆盖同名项）；`mode: 'only'` 时只用 AssetSet。
理由：现有项目开关是团队共识的最小集，AssetSet 是调用方的临时需求，覆盖比替换更符合直觉。

### 3.3 版本策略

- 默认 **snapshot**：会话启动即锁定 digest，重托管不跟随更新；界面上提示「有新版本」，
  升级是显式动作（`POST /api/sessions/:id/assets/upgrade`）。
- `follow` 只作为 AssetSet 项的显式开关（等价于今天的「跟随钉住版本」），供长跑 bot 使用。

### 3.4 下发（协议级冻结）

`start_session` 从 `assetIds: string[]` 改为 `assets: [{assetId, kind, name, digest}]`。
Worker 只按 digest 加载，缺什么就按哈希取；取不到就报 `missing` 诊断，而不是静默用磁盘
上的当前版本。`digestsForWorker()` 从快照表收集，不再从会话实时的项目集推导。

没有这一步，P2 的「快照」只是展示层的谎话：#226 的 P4（不可变版本库 + 每会话视图）
必须先于对外自选资产集上线。

### 3.5 权限

- 读 catalog / AssetSet：`asset:read`，仍受 `assetVisibleIn` 约束（不能借 AssetSet 越权
  引用别人的个人资产）。
- 写 AssetSet：`asset.write`（个人）或 `project.update`（项目默认集）。
- MCP 资产（把外部 MCP server 注入会话）额外受 Actor 门控：外部调用方只能注入它被授权的
  资产集里的 MCP。

## 4. 任务进展：写入是规范流，推送是可选加速

- 规范流：`task_log_entries`，每行 `{seq, kind, text, sessionId}`。外部调用方按 `after=seq`
  拉取即可，天然支持断线重连与多订阅者。
- 推送：MCP 侧提供 `task.progress({taskId, after, wait})`（长轮询，`wait ≤ 30s`），
  内部实现为对工作日志的 `seq` 等待；不新开 SSE 通道，避免第二条连接语义。
- 分发（谁额外收到通知）由组合根决定，与调用方无关：群来源发系统帖、bot 私聊走调度
  通知、连接器走 outbox（已在 `836fd63` 落地）。
- 节流属于产出端：stage 级进展 90s / 8 条上限，`started` / `finished` 不受限。

## 5. 对外 MCP 端点

- 传输：Streamable HTTP，`POST/GET /api/mcp`，`Authorization: Bearer <token>`。
- 认签：`ApiToken` → `ToolGrant`（按项目 + scope 预置），每次调用实时求值；
  审计记 `mcp.tool`（token、tool、taskId、耗时、结果码）。
- 限流：每 token 每分钟 60 次；单次 `wait` 只占一个连接；响应体上限 1 MB。
- 资产访问遵循 §3.5；MCP 端点不直接改资产内容，只读 catalog 与引用。
- 写调用带 `idempotencyKey`（客户端生成，24h 内同键返回首次结果），避免重试造成重复项目/任务。

### 5.1 模块划分

对外 MCP 按 领域模块 拆，一个端点（`/api/mcp`）挂全部工具，靠 token scope 决定可见性；
代码上每个模块独立文件、独立 scope、独立审计前缀，互不依赖：

| 模块 | 文件 | scope | 工具 |
| --- | --- | --- | --- |
| 任务 | `tools/external/tasks.ts` | `task:read` / `task:create` | `task.create`、`task.get`、`task.messages`、`task.reply`、`task.cancel` |
| 项目 | `tools/external/projects.ts` | `project:read` / `project:create` / `project:update` | `project.list`、`project.get`、`project.create`、`project.update`、`project.repos.set` |
| 资产 | `tools/external/assets.ts` | `asset:read` / `asset:write` | `asset.list`、`asset.get`、`assetSet.list`、`assetSet.get`、`assetSet.create`、`assetSet.update`、`assetSet.bind` |

规则：

- **一个模块 = 一个文件 + 一组 scope + 一份审计前缀**；模块之间不互相 import，只用领域用例。
- 工具名前缀即模块名；客户端看到多少个工具由 token scope 决定（没有 `asset:write` 就看不到
  `assetSet.create`），而不是调用时才 403。
- 传输层只做「MCP 调用 → 工具定义 → 领域用例」；HTTP 路由如需同类能力，复用同一批工具
  定义，不复制校验。
- 每个模块可单独下线（配置 `MCP_MODULES=tasks,projects`），便于灰度与事故止损。

### 5.1.1 任务模块（五件）

| 工具 | 说明 |
| --- | --- |
| `task.create` | 给项目下派任务：`{projectId, prompt, kind:'code'\|'serve', assetSetId?, baseBranch?, deliver?}`；返回 `{taskId, sessionId}` |
| `task.get` | 状态、分支、commit、PR URL、`lastSeq`、最后一句话 |
| `task.messages` | `after=seq` 拉消息（text / question / tool 摘要 / ended），`limit≤200` |
| `task.reply` | 给运行中的会话补一句话；走送达队列，不新开会话 |
| `task.cancel` | 取消排队或打断运行中的会话 |

### 5.1.2 项目模块

| 工具 | 说明 |
| --- | --- |
| `project.list` / `project.get` | 可见项目与配置摘要（仓库、检查命令、预览端口、默认资产集、成员数） |
| `project.create` | `{name, repos[], description?}`；第一个仓库为主仓库；需 `project:create` |
| `project.update` | `{projectId, description?, previewPort?, worktree?}`；不动代码、不动成员 |
| `project.repos.set` | 整体替换仓库清单（≤8）；保存前跑 `repos/check`，不可达/分支不存在则整单拒绝并给出逐项原因 |

项目模块**不**做：删除项目、成员/权限变更、集群级设置（仍走界面，需二次确认）。

### 5.1.3 资产模块

| 工具 | 说明 |
| --- | --- |
| `asset.list` / `asset.get` | 可引用资产（skill / instruction / mcp）与版本摘要 |
| `assetSet.list` / `assetSet.get` | 资产集与 items（`assetId` + `pin`） |
| `assetSet.create` / `assetSet.update` | 新建/修改资产集；只能引用已发布且 `assetVisibleIn` 通过的资产 |
| `assetSet.bind` | 绑定到项目默认或 Bot 默认（`{assetSetId, projectId?|botId?}`） |

资产模块**不**做：导入/上传/审核/删除资产、改资产内容、签发密钥——这些涉及供应链与密钥，
必须留在界面与人工审核流程里。MCP 只能组合「已经审过的资产」。

### 5.1.4 场景剧本（建项目 → 绑仓库 → 装资产 → 开发 → 本地起服务）

一次完整的「从零到能看」在 MCP 上是一条直线，不需要切界面：

```jsonc
// 1. 建项目：一次给齐多个仓库（第一个是主仓库）
project.create({
  "name": "agent-hub",
  "repos": [
    {"name":"agent-hub","url":"https://github.com/o/agent-hub.git","defaultBranch":"main"},
    {"name":"web-kit","url":"https://github.com/o/web-kit.git"}
  ],
  "description": "运行时无关的 agent 工作台"
})
// → { projectId, repos:[...], primary:"agent-hub" }

// 2. 建两个场景资产包（技能 + 指令的组合，只能选已发布资产）
assetSet.create({ "name":"开发", "items":[{"assetId":"a_ts","pin":"follow"},{"assetId":"a_review"}] })
assetSet.create({ "name":"本地部署", "items":[{"assetId":"a_deploy"},{"assetId":"a_ops"}] })

// 3. 绑默认：项目默认用「开发」；部署任务显式用「本地部署」
assetSet.bind({ "assetSetId":"as_dev", "projectId":"p_1" })

// 4. 开发任务（隔离 worktree，产出分支/PR）
task.create({
  "projectId":"p_1", "kind":"code", "assetSetId":"as_dev",
  "prompt":"把会话页的预览面板接上自动发现……",
  "deliver": {"branch":"agent-hub/preview-autodetect","openPr":true}
})

// 5. 本地部署任务（同一项目，共享目录，起服务并登记预览）
task.create({
  "projectId":"p_1", "kind":"serve", "assetSetId":"as_deploy",
  "prompt":"用 pnpm dev 起前端与 server，确认 /api/health 200；把端口登记为预览"
})
// → 6. task.get(taskId) 里出现 previewLink { port, url, state }

// 7. 过程中反问
//    会话调用 task.ask("要 npm ci 还是复用现有 node_modules？")
//    → task.messages 看到 question → task.reply("复用") → 同一会话继续
```

`kind` 的差别只在于默认值与收尾动作，不是新实体：

| kind | 工作目录 | 收尾 |
| --- | --- | --- |
| `code` | 隔离 worktree（可指定 shared） | 提交 → 推送分支 → 可选开 PR |
| `serve` | 共享目录 | 起服务 → 登记预览链接 → 保持进程；`task.get` 返回 `previewLink` |

`check` / `review` 作为 v2 的 `code` 预设（`checks:true` / `baseRef`），不单列。

### 5.1.5 运行感知：别让会话「静悄悄地卡住」

外部调用方看不到终端，必须能从 `task.get` 判断「在干活 / 慢 / 卡住 / 机器没了」。这些
全部由 hub 侧的既有事件推导，不改协议：

- 每条 journal 事件落库时更新 `lastEventAt`；`task.get` 返回
  `{ phase, lastEventAt, idleMs, lastSeq, workerOnline, processAlive }`。
- `phase`：`starting | thinking | tool:<name> | waiting_user | ended`（复用现有 attention 推导）。
- `liveness` 四档：
  - `active`：60s 内有事件；
  - `slow`：60s–5min 没有事件，但回合未结束（模型可能在想）；
  - `stalled`：>5min 没有事件且回合未结束（`HUB_STALL_MS=300000`）；
  - `detached`：worker 离线、或会话在 worker 上没有进程（`hosting.has` 为假）。

处理策略（按可恢复性，不是一律杀）：

1. `detached` + 投递仍 `delivered`：由 `recoverOrphanedTurns`（2 分钟）收尾并在 journal
   写 `ended{failed, reason:'这一轮没有在机器上跑起来…'}`，同时把 `task.get` 标 `stalled`。
2. `stalled` 且正在跑工具：先发一条 `diagnostic{warn}` 进 journal（调用方在 `task.messages`
   能看到「已 6 分钟没有输出，可能卡在 <tool>」），不打断。
3. `stalled` 超过 `HUB_STALL_INTERRUPT_MS=1200000`（20 分钟）：打断会话、写 `ended{failed,
   reason:'20 分钟没有输出，已停止'}`，调用方从 `task.get` 立刻看到终态，不必轮询到超时。
4. 用户/调用方主动 `task.cancel` 永远优先。

这样「卡住」有确定语义和时间上限，而不是靠外部猜测。阈值做成环境变量，默认值偏保守
（编译、`npm ci` 这类长工具在 5 分钟内仍算 `slow`）。

### 5.2 提示词与交付

- `prompt` 是任务的全部输入（markdown，≤ 32 KB），服务端只在前后补「交付要求」与
  「遇到阻塞就提问」两段固定说明，不替调用方写实现细节。
- `deliver.branch` 给定时写进任务，任务结束前由 agent 在 worktree 里提交并推送；
  `openPr` 为真时建 PR 并把 URL 写回 `task.get`。默认分支仍禁止直接推送。
- `kind` 字段不要了：v1 只有一种「编码任务」。起服务/跑检查由提示词决定，agent 用现有
  工具（`run.checks`、终端、预览）自行完成，产物在 `task.get` 里可见。

### 5.3 反问与消息（关键交互）

工作台里的会话本来就能多轮交谈，不需要新的阻塞式问答协议：

```
task.create(prompt) ──► 会话开跑
        │
        ├─ agent 需要确认：调用 `task.ask(question)`
        │     → 作为一条 outbound 消息写进 journal（kind:'question'）
        │     → 本轮结束，会话进入 idle（进程保活）
        │
        └─ 调用方 task.messages(after) 看到 question
              → task.reply(text)
              → 送达队列把这句话投给同一个会话，开启下一轮
```

- `task.ask` 不是阻塞调用：agent 问完就结束本轮，避免长时间占用模型与 worker。
- `task.reply` 复用 ADR 0031 的送达队列：会话在跑时排队、空闲时立刻投递；同一任务多条
  回复按序执行，不会打架。
- `task.messages` 是唯一读通道，`seq` 单调，断线重连用 `after` 补齐；消息里带
  `{kind:'text'|'question'|'tool'|'ended', author, text, at}`，调用方不需要理解事件类型全集。

### 5.4 安全与配额

- token 绑定单个项目（v1）；越权访问其他项目一律 404，不泄露存在性。
- `prompt` 与 `reply` 按不可信文本注入（`<untrusted>` 包裹），不能触发 `@all`、不能指定
  `createdBy`、workspace 路径或 workerId。
- 写调用带 `idempotencyKey`（24h），重复提交返回同一个 `taskId`。
- 配额：每 token 并发任务数、每分钟创建数；`task.reply` 计入消息速率。
- 审计：`mcp.task.create` / `mcp.task.reply` / `mcp.task.cancel`，记 token、项目、taskId。

## 6. 分期

| 期 | 内容 | 依赖 | 验收 |
| --- | --- | --- | --- |
| E1 | #226 P1 剩余（track/locked、显式凭据、批量导入、审核报告） | URL 拆分已完成 | 一次导入多个技能并锁定 commit |
| E2 | 资产协议级冻结 + 不可变版本库/每会话视图 | E1 的 digest 语义 | 两个并发会话用同名资产不同版本互不干扰 |
| E3 | AssetSet 实体与绑定（界面内使用；暂不开放给 MCP） | E2 | 同项目两个会话选不同资产集，注入互不相同 |
| E4a | MCP 传输层 + **任务模块**（5 工具）+ 审计/限流/幂等 | `836fd63` 进展流 | 外部 agent 派编码任务、回答反问、拿到分支与 PR |
| E4b | **项目模块**（5 工具，含 `repos.set` 前置检查） | E4a 的工具注册骨架 | 外部 agent 能建项目、改配置、绑仓库 |
| E4c | **资产模块**（7 工具，只组合已发布资产） | E2 的 digest 语义；E4a 骨架 | 外部 agent 能建资产集并绑到项目/Bot，不能导入或改内容 |
| E5 | 会话内 `task.ask` 反问与交付收尾（PR URL 回写）打磨 | E4a | 双向消息闭环，不需要外部轮询事件全集 |

## 6.1 现状差距（要写代码的部分）

已有、可直接包成工具的：

- `POST /api/projects`、`PATCH /api/projects/:id`（说明/检查命令/预览端口/worktree）、`POST /api/projects/:id/repos/check`；
- `POST /api/tasks`（`baseBranch`）、`GET /api/tasks/:id`、任务日志、`task.cancel`；
- `session.derive` / `session.stop` / `run.checks` / `git.*` 已作为 agent 工具存在（`#216 P1`）；
- `preview_links`（`preview.create/remove`）、`/api/sessions/:id/events?after=`。

缺的：

1. **MCP 传输层**：`/api/mcp`（Streamable HTTP）、token→grant、审计、限流、`idempotencyKey`。
2. **工具映射**：把上面的 HTTP/用例包装成工具定义（一次定义，HTTP 与 MCP 共用）；
   `project.create` 与 `project.repo.*` 是新工具面，需要单独校验（仓库 ≤8、主仓库不可删）。
3. **AssetSet 实体**（P3）与 `assetSet.*` 工具。
4. **任务形态 `kind`** 的默认值组合与字段校验（不新增实体，先在 `TaskDispatch` 上映射）。
5. **进展长轮询** `task.progress`（对工作日志 seq 等待）——`836fd63` 已写入规范流。
6. **`serve` 的预览返回**：MCP 只读现有 link，创建仍在会话内（agent 起服务 → 终端端口识别）。

## 7. 决策与开放问题

已定：

- 资产集默认叠加、同名覆盖（可 `only`）。
- 会话默认 snapshot，`follow` 需显式声明。
- 进展以工作日志为规范流，MCP 用长轮询而不是第二条 SSE。
- 资产集必须先上线 E2（协议冻结），才能对外开放自选。

v2 才考虑：资产导入/审核、项目删除、成员与权限变更、任意 git 操作、`kind` 多形态
（check/serve/review）。这些不阻塞 v1 的三个模块。

待拍板：

1. 「按 Worker 安装」是否保留为硬门槛？建议降级为预热/白名单，会话可用性由「能否按 digest 取到」决定（P4 已含）。
2. GitHub 凭据归属：个人 PAT / 团队 App / hub 级。建议先只支持团队级，个人 PAT 仅限个人资产。
3. 含脚本的资产是否在 AssetSet 层标记「需更高审核」？建议标记 + 团队管理员审核。
4. 群/Bot 会话的个人资产：按当前触发人还是按 Bot 创建者？建议 Bot 会话不带个人资产。
5. 外部 MCP 是否允许跨项目调用（一个 token 多项目）？建议 v1 单项目，多项目靠多个 token。
