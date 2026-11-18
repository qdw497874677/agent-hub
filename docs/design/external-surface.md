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

## 5. 对外 MCP：在现有端点上收窄，不新写一套

现状（审查确认）：`POST /openapi/v1/mcp`（`apps/server/src/openapi/app.ts:386`）已经存在，
无状态 Streamable HTTP，工具由 v1 路由自动生成，并把调用原样转成内部 HTTP
（`apps/server/src/openapi/mcp.ts:75-125`）。问题不是「没有传输」，而是**全量投影 239 条路由**：
删项目、交资产版本、开会话、分叉都在里面。

因此 v1 的做法是**白名单 + 注解 + 描述 + 出参投影**，继续复用内部 HTTP 转调：

- 鉴权、404 语义、审计只有一套（`installAccess` + 各路由 `can()`），不在工具层重判。
- 令牌 scope 沿用现有 `api-token.ts` 的 `projects:read|write` 等，不新造 `task:read`。
- 不接内部 agent 的 38 个 `ToolGrant` 工具——那是会话内身份，和外部令牌不是一条链。

### 5.1 暴露规则：元数据写在路由上，不再有平行白名单

工具的来源是 `apps/server/src/openapi/routes.ts` 的第三参：

```ts
route('projects:read', { method: 'get', path: `${V1}/projects`, ... })
route('sessions:write', { ... }, { module: 'sessions', need: 'session.prompt', idempotent: true, expose: 'session_reply' })
route('projects:write', { ... }, { skip: '会改项目描述，留给界面' })
```

- **默认 `'auto'`**：`GET` 路由按 `tags[0]` 推 module 与权限，自动只读暴露；写路由必须显式声明，避免「加个路由就悄悄对外」。
- `{ skip: '<原因>' }` 必须写原因；`apps/server/src/openapi-mcp-parity.test.ts` 会校验每条路由都有归属、工具名唯一、数量与 skip 清单符合预期。
- 口径：37 条路由 → 31 个工具（只读 12 / 写 19），6 条不暴露：`health`、`me`、`stream`、`setProjectRepo`、`setProjectDescription`、`submitAssetRevision`。

| 分组 | 工具 |
| --- | --- |
| `projects` | `list_projects`、`get_project`、`project_create`、`project_update`、`project_repos`、`project_archive`、`workspace_changes` |
| `tasks` | `list_tasks`、`get_task`、`list_task_log`、`task_create`、`append_task_log`、`edit_task_log`、`set_task_status`、`set_task_summary` |
| `sessions` | `get_session`、`events`、`activity`、`session_start`、`session_reply`、`session_cancel`、`session_model`、`fork_session`、`change_option` |
| `assets` | `list_assets`、`get_asset`、`asset_create`、`asset_import`、`asset_publish`、`asset_assign` |
| `workers` | `list_workers` |

`MCP_MODULES` 用这些分组名做灰度；`MCP_READ_ONLY=1` 在 `tools/list` 与 `tools/call` 两边同时生效。

`workspace_changes` 与 `activity` 以前没暴露、现在由 `'auto'` 带出来，它们的 handler 都补了项目/会话权限判定
（`authorizeWorkspace(...,'project.read')` / `authorizeSession(...,'session.read')`），权限不够按策略返回 404。

### 5.2 描述与注解：给调用方 agent 看的

现有描述只有 `summary + METHOD path`（`openapi/mcp.ts:51-54`），不够。最小改法是在路由定义
上补 `description`，`toolOf()` 拼进去，并补注解：

```ts
description:
  '列出我可见的任务，按更新时间倒序。\n' +
  '参数：projectId（可选，过滤单个项目）、limit（1-200，默认 50）。\n' +
  '返回：{tasks:[{id,title,status,projectId,updatedAt}]}。\n' +
  '下一步：用 get_task 取详情，list_task_log 看进展。\n' +
  '错误：401 令牌无效；403 无 projects:read。'

annotations: {
  title: summary,
  readOnlyHint: true,          // 白名单里显式标，不用 method 猜
  destructiveHint: false,
  idempotentHint: true
}
```

描述统一四段：**何时用 → 参数 → 返回 → 下一步/错误**。写工具另加「会改变什么、能不能撤销」。
`readOnlyHint` 在表里显式声明，因为「只读但 POST」的路由用 method 推导会标错。

### 5.3 任务状态：只做投影，不改领域

任务与会话是两套状态，不能混：

- 任务：`todo | in_progress | blocked | in_review | done | abandoned`（`packages/domain/src/task.ts:10`）
- 会话：`running | stopped | done | interrupted | failed`（`packages/domain/src/session.ts:15`）

对外 `get_task` 返回 `{status, session:{status, phase, liveness}}`，`phase` 复用
`derivePhase`（`working | needs_answer | idle | failed`）。**不发明 `cancelled` 主状态**；
人取消是 `stopped`，进程消失是 `interrupted`。`input_required` 只在 MCP tasks 扩展
（v2）里出现，v1 用 `needs_answer` 表达。

### 5.4 消息投影：不能原样返回 journal

`GET /api/sessions/:id/events` 原样返回事件（`openapi/app.ts:329`），里面有
`tool_call.input`、`tool_result.output`（截断到 16k）、`prompt.text`、`thinking`、
`diagnostic`、审批详情。外部只给投影后的四类：

| 对外 kind | 来自 | 保留字段 |
| --- | --- | --- |
| `text` | text delta 合并 | `text`, `at` |
| `tool` | tool_call / tool_result | `name`, `ok`, `durationMs`（**丢弃 input/output**） |
| `ended` | ended | `outcome`, `reason` |
| `diagnostic` | diagnostic | 只保留 `level` 与「已脱敏」的通用文案 |

`?after=seq` 的分页保持现有语义；投影在 MCP 层做，HTTP v1 保持不变。

### 5.5 运行感知：只报告，不自动杀

已有 `HUB_STALL_MS=300000` 与 `flagStalledSessions`，但它只写一条 warn、不打断
（`packages/domain/src/use-cases/stall.ts:12-16`）。v1 把它投影成四档，阈值沿用：

- `active`：60s 内有事件；
- `slow`：60s–5min 无事件、回合未结束；
- `stalled`：>5min 无事件、回合未结束（已有 warn 事件）；
- `detached`：worker 离线，或 `hosting.has` 为假（2 分钟 `recoverOrphanedTurns` 会收尾成 `failed`）。

**不自动打断**：20 分钟杀进程会误伤 `npm ci` / 长测试；打断只由 `task.cancel`（v1 走
`promptSessionUseCase` 的 stop 语义）或人触发。文档里原先的 `HUB_STALL_INTERRUPT_MS` 撤销。

### 5.6 委派开发（E4b：令牌要有对应写 scope；只读模式可一键关掉）

外部 agent 委派工作台的最小闭环：

```
task_create  → session_start → session_reply → 轮询 list_task_log / events → session_cancel（可选）
```

| 工具 | v1 路由 | 幂等 |
| --- | --- | --- |
| `task_create` | `POST /tasks` | 需要 `clientRequestId`，24h 内返回同一任务 |
| `session_start` | `POST /sessions` | 需要 `clientRequestId`，不会重复开会话 |
| `session_reply` | `POST /sessions/:id/prompt` | 需要 `clientRequestId`，另有 `clientMessageId` 做送达去重 |
| `session_cancel` | `POST /sessions/:id/interrupt` | 天然幂等（重复打断无副作用） |
| `session_model` | `POST /sessions/:id/model` | 需要 `clientRequestId`；同提供商标改选项、换提供商重启进程并接回历史 |

- 写工具**默认暴露**，能不能调由令牌 scope 决定（工具清单也按令牌权限筛，不列用不了的）。
  外部接入页的「只读模式」是一键压回只读（写 `mcpReadOnly`）；`MCP_READ_ONLY=1`（或旧变量 `MCP_WRITE=0`）
  是同一层的硬闸门。趋势从「能力灰度默认关」改成「权限控、只读可选」，避免为了一个人开全局开关。
- `clientRequestId` 由 MCP 层取走、不转发给内部 HTTP；回放键是
  `<令牌哈希>|<工具名>|<clientRequestId>`，存第一次成功的结果（`mcp_replays` 表，保留 24h）。
- `session_start` 必须点名的机器不能是 hub 本机（开放 API 的既有约束）；调用方用
  `list_workers` 挑机器。机器离线/没装 runtime 返回 409。
- `session_model` 与界面「模型」下拉走同一条路：同提供商只改选项（下一轮生效）；换到 hub 提供商
  或反向回原生模型会停掉会话进程、按新模型重新托管，靠 `resume{agentSessionRef, cursor}` 接回历史，
  正在跑的回合会中断。权限是 `session.prompt`，模型本身还要过调用方可见的提供商/运行时名单。
- 已知欠缺：资产还没有协议级 digest 冻结（E4c），所以委派出去的会话在别人同步资产新版后
  可能换内容；这一步完成前，「对外委派」适合内部可信调用方。

#### 私有仓库凭据：`project_repos`

外部 agent 配「项目从哪几个仓库拉代码」用 `project_repos`（`PUT /openapi/v1/projects/{id}/repos`，
权限 `projects:write`，写工具开关同上一节）：

- `repos[]`：`url`、`name`（可选）、`defaultBranch`（可选，`null` = 远端默认），最多 8 个，第 0 个是主仓库。
- `credential` **只写不读**：非空存进密钥箱（`repo-git:<repoId>`）、空串清掉、省略不动。
  响应只给 `hasToken: true|false`，明文永不回显、不进审计 detail、不进日志。
- 存下之后，这条仓库的 clone / worktree / push 都由 hub 按 URL 或目录前缀自动取令牌下发，
  worker 端只拿到一次性的 `http.extraHeader`。
- 要确认机器能不能拉到：先 `POST /api/projects/{id}/repos/check`（界面入口；开放 API 暂未开）。

### 5.7 交付与幂等

- 交付意图仍可用现有字段表达：任务 `branch`、`pullRequests`（`task.get` 聚合 PR URL）。
  没有 `kind: code|serve` —— v1 不发明任务形态；起服务/跑检查由提示词与现有工具决定。
- `task.cancel`：包 `interruptSessionUseCase`，语义与会话页一致。
- 外部补话：复用 `promptSessionUseCase`（送达队列、`releaseAfterTurn`、`clientMessageId`
  都在），幂等键是 `(sessionId, clientMessageId)`，不是 `(token,tool,key)`。
- 真正的「会话内提问工具」`task.ask` 不存在，也不在 v1：`needs_answer` 目前来自启发式
  （`attention.ts` 的工具名正则 / 问号结尾）。v2 再设计「提问 → 结束本轮 → 外部回答」的
  显式协议。

### 5.8 一套能力面，两种调法

外部只有一份路由定义、一套令牌与权限；REST 与 MCP 是同一份能力面的两个视图：

| 场景 | 建议 |
| --- | --- |
| agent 规划与调用（多步、要工具描述） | MCP `POST /openapi/v1/mcp` |
| 长任务实时进度 | REST `GET /openapi/v1/sessions/{id}/stream`（SSE，MCP 不适合），或 MCP `events?sinceTurn=` 轮询 |
| 文件上传 / 附件 | REST `POST /openapi/v1/assets` 等（MCP 只走 JSON 工具参数） |
| 起步脚本、curl、CI | REST，直接照 `openapi.json` |

两个视图的差别只在「暴露多少」与「怎么读」：

- 写工具默认出现，但都要过令牌 scope 过滤；「只读模式」打开后写工具整体消失；
- `events` 在 MCP 侧过投影（见 §5.4），REST 给原文；
- 幂等：写请求带 `Idempotency-Key: <自己生成的值>`（MCP 用 `clientRequestId`，内部转成同一个头），
  同一令牌 + 方法 + 路径 + key 在 24h 内返回第一次的结果（`openapi/idempotency.ts`，表是 `mcp_replays`）。
  `5xx` 不留档，非 JSON 响应（SSE、附件）不缓存。

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

业界校准（2025–2026 官方 MCP server 对照后的修订）：

- 单端点 + surface/toolset 收窄（GitHub toolset、Sentry skills、Atlassian Primary 同构）；
  默认暴露面 ≤20 个，本设计 17 个。
- 工具注解必填（GitHub/Sentry/Cloudflare 都显式声明）；只读与写工具分开定义，避免
  `readOnlyHint` 失真。
- 状态用五态 + `detail` 双层（Devin `status`/`status_detail`、MCP tasks 扩展）。
- 分页：业务列表工具自己带 `nextCursor`（协议分页只管 `tools/list` 等），页大小 ≤50。
- 长轮询：保留 `task.get` 轮询模型；`task.progress` 若做，服务端每 15–20s 发心跳，
  并支持「客户端断开 = 取消当前等待」。
- 幂等键业界普遍没有（GitHub 连 `create_repository` 都标 `idempotentHint:false`），
  我们只在 `task.create` 强制，属于可用性增强而非协议要求。
- `project.create` 开放与 GitHub/Linear/Atlassian/Sentry 一致；前提：独立写 scope、
  可整体只读（`MCP_READ_ONLY=1`）、创建时即做 `repos/check`。

待拍板：

1. 「按 Worker 安装」是否保留为硬门槛？建议降级为预热/白名单，会话可用性由「能否按 digest 取到」决定（P4 已含）。
2. GitHub 凭据归属：个人 PAT / 团队 App / hub 级。建议先只支持团队级，个人 PAT 仅限个人资产。
3. 含脚本的资产是否在 AssetSet 层标记「需更高审核」？建议标记 + 团队管理员审核。
4. 群/Bot 会话的个人资产：按当前触发人还是按 Bot 创建者？建议 Bot 会话不带个人资产。
5. 外部 MCP 是否允许跨项目调用（一个 token 多项目）？建议 v1 单项目，多项目靠多个 token。
