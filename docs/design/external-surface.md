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

### 5.1 工具面

三层，按 scope 开放；默认 token 只有第 1 层。

**第 1 层：只读 / 交付物**

| 工具 | 说明 |
| --- | --- |
| `project.list` / `project.get` | 我可见的项目、配置摘要（仓库、检查命令、默认资产集） |
| `asset.list` / `asset.get` / `assetSet.list` | 可引用的资产与资产集 |
| `task.get` / `task.log` / `task.progress` | 任务详情、工作日志（`after=seq`）、长轮询进展 |
| `session.get` / `session.events` | 会话状态与事件（只读，`after=seq`） |
| `preview.list` | 预览端口与链接（不含分享令牌） |

**第 2 层：组织与配置（`project.update` / `asset.write`）**

| 工具 | 说明 |
| --- | --- |
| `project.create` | 建项目：名称、仓库清单（`repos[]`，第一个为主仓库）、默认分支、可见性；需 `project.create` |
| `project.update` | 改说明、检查命令、默认分支、预览默认端口、worktree 策略；不动代码 |
| `project.repo.add/remove` | 改仓库清单（≤8），保存前跑 `repos/check`，失败即拒 |
| `assetSet.create` / `assetSet.update` | 建/改资产集（引用已发布资产；越权引用拒绝） |
| `assetSet.bind` | 绑定到项目默认、Bot 默认，或作为任务默认 |
| `bot.list` / `bot.get` | 团队内可委派的 Bot（只读；改 Bot 仍走界面） |

**第 3 层：委派与执行（`task.create` / `session:control` / `git`）**

| 工具 | 说明 |
| --- | --- |
| `task.create` | 派活：见 §5.2 的任务形态；返回 `taskId`，后续靠 `task.progress` 跟 |
| `task.cancel` | 取消排队或打断运行中的任务（与界面同一套 409 语义） |
| `session.derive` | 从某会话分叉（保留上下文、换机器/工作目录） |
| `session.stop` | 停掉跑偏的会话 |
| `run.checks` | 跑项目声明的检查命令，返回 exit code 与失败摘要 |
| `git.state` / `git.commit` / `git.push` / `git.pr` | 提交与推送（默认禁止推默认分支）、建 PR |

### 5.2 任务形态：编码、校验、起服务

外部调用方不需要理解「会话/工作目录」，只需要说清「要产出什么」。`task.create` 用
`kind` 描述形态，服务端决定 worktree 策略、资产集、检查与预览：

| kind | 干什么 | 工作目录 | 产出 |
| --- | --- | --- | --- |
| `code`（默认） | 改代码、跑检查、提交 | `isolated` worktree（或调用方指定 `shared`） | 分支 + commit（可要求 `openPr`） |
| `check` | 只跑检查/测试，不改代码 | `shared`，只读优先 | 检查报告（exit code、失败摘要、日志 seq 区间） |
| `serve` | 本地起服务供预览 | `shared` 或调用方指定 | `previewLink`（端口、URL、存活状态） |
| `review` | 审一个分支/PR，输出意见 | `isolated`（按 base 检出） | 审阅结论 + 行内引用 |

请求形状（示意）：

```json
{
  "projectId": "p_...",
  "kind": "code",
  "title": "补外部 MCP 的 task.progress",
  "goal": "...markdown...",
  "baseBranch": "main",
  "assetSetId": "as_...",
  "agent": { "runtime": "opencode", "model": "" },
  "workspace": { "mode": "isolated" },
  "checks": true,
  "deliver": { "branch": "agent-hub/xxx", "openPr": true }
}
```

- `kind` 只是默认值的组合，不新增领域实体；后续可以加 `TaskTemplate`（团队保存的预设），
  复用同一字段。
- `serve` 的预览链接沿用现有 preview link（端口映射 / 前缀两种模式），权限是
  `preview.create`；MCP 不签发分享令牌，只返回会话内可见的链接。
- `checks: true` 时，任务结束前自动跑 `Project.checks`，结果写进任务日志最后一段。

### 5.3 一次完整委派

```
1. project.get / project.list          → 找到项目，确认仓库与检查命令
2. assetSet.list（可选）               → 选一套资产
3. task.create({kind:'code', ...})     → {taskId}
4. task.progress({taskId, after, wait})→ 阶段进展（正在改文件 / 正在跑命令）
5. task.get                            → 分支、commit、检查结果、失败原因
6. git.pr（可选）或 preview.list（serve 任务）
```

任何一步失败都返回结构化 `{code, message, hint}`，且同一个 `taskId` 在 `task.get` 里能
看到完整原因（包括超时、模型无额度、资产缺失）。

### 5.4 安全与配额

- `project.create` 需要团队级 `project.create`；个人 token 只在个人空间建项目。
- 外部调用方的写能力受项目配额约束：并发任务数、每分钟创建数、每项目资产集数。
- 不可信输入：`goal` / 外部消息一律按不可信文本注入（`<untrusted>` 包裹、禁 `@all`）；
  外部调用方不能通过 MCP 指定 `createdBy`、workspace 绝对路径或 workerId（由放置策略决定）。
- 审计：`mcp.project.create`、`mcp.task.create`、`mcp.assetSet.bind`、`mcp.git.push` 等
  动作记 token、项目、taskId；git 推送仍受「禁止推默认分支」与 `git.push` 权限约束。

## 6. 分期

| 期 | 内容 | 依赖 | 验收 |
| --- | --- | --- | --- |
| E1 | #226 P1 剩余（track/locked、显式凭据、批量、稀疏检出、审核报告） | 已完成的 URL 拆分 | 一次导入多个技能并锁定 commit |
| E2 | 协议级冻结（§3.4）+ P4 不可变版本库/每会话视图 | E1 的 digest 语义 | 两个并发会话用同名资产不同版本互不干扰 |
| E3 | AssetSet 实体 + 绑定优先级 + 会话创建界面 | E2 | 同项目两个会话选不同资产集，注入互不相同 |
| E4 | 对外 MCP 端点的第 1–2 层（只读 + 项目/资产配置）+ 审计/限流 | E2、Actor | 外部 agent 用自己的 token 建项目、配资产集、读进展 |
| E5 | 第 3 层（`task.create` 的 code/check/serve/review、derive/stop、git 分支策略） | E4 + 安全评审 | 外部调用方能派编码任务、拿到分支/PR 与预览链接 |

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

待拍板：

1. 「按 Worker 安装」是否保留为硬门槛？建议降级为预热/白名单，会话可用性由「能否按 digest 取到」决定（P4 已含）。
2. GitHub 凭据归属：个人 PAT / 团队 App / hub 级。建议先只支持团队级，个人 PAT 仅限个人资产。
3. 含脚本的资产是否在 AssetSet 层标记「需更高审核」？建议标记 + 团队管理员审核。
4. 群/Bot 会话的个人资产：按当前触发人还是按 Bot 创建者？建议 Bot 会话不带个人资产。
5. 外部 MCP 是否允许跨项目调用（一个 token 多项目）？建议 v1 单项目，多项目靠多个 token。
