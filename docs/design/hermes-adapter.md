# Hermes Agent 运行时适配器（accepted，2026-10-31）

> 状态：**accepted**（2026-10-31 David 采纳 §12 全部推荐）。对应 ADR 0022。没有未决项。
> 依据：[API Server 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)、[bot mode](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode)、[ACP](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp)、[Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers)、[Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)，均于 2026-10-31 06:10 PDT 打开原文核对。文中标「**已核对**」的是原文写明的；标「**未核对**」的是推断或原文没写，实现前要实测。
> 编号说明：ADR 0019–0021 在 PR #123 上（未合并），所以本 ADR 用 0022。

## 1. 目标与非目标

**目标**：让 Hermes Agent 成为 agent-hub 的一个运行时，和 pi / grok / acp 并列：在 Worker 上起会话、流式事件、中断、恢复、人工批准、用 hub 的模型提供商和 hub 记忆工具。

**非目标**：不接管 Hermes 自己的 CLI / TUI / Desktop / 消息平台会话；不用 Hermes 的 Jobs API 做 hub 的定时任务（hub 有自己的 routines）；不把 Hermes 的 bot mode 群聊当作 hub 群聊（hub 群聊见 agent-messaging §5.5–5.7）。

## 2. 选哪个接口

Hermes 对外有两条可编程的路：

| 路 | 说明（已核对） | 用于 hub |
|---|---|---|
| **API Server**（`hermes gateway`，默认 `127.0.0.1:8642`） | OpenAI 兼容的 `/v1/chat/completions`、`/v1/responses`，以及 Hermes 自有的 **Runs API**（`/v1/runs`、轮询、SSE、stop、approval、clarify、resolve-unknown）和会话 API（`/api/sessions/...`） | **推荐**：控制面最完整（幂等、未知结果、并发上限、批准、用量和实际模型回报） |
| **ACP**（`hermes acp`，stdio JSON-RPC） | 编辑器可以渲染消息、工具活动、diff、终端命令、批准提示；`session/new` 带的 `mcpServers` 每个会话都会加上 | 备选：现有 `acp` 适配器配一条 `ACP_AGENTS` 就能跑，零新代码，但拿不到 Runs API 的幂等 / 未知结果 / 用量回报 |

**推荐**：P0 先用现有 `acp` 适配器做冒烟（只加配置），P1 起做专用的 `hermes` 适配器走 API Server（决定 D1）。

## 3. 映射到 RuntimeAdapter

现有契约（`packages/domain/src/ports/runtime-adapter.ts`、`agent-runtime.ts`）：`RuntimeAdapter.prepare(ctx) → PreparedRuntime[]`，每个带 `runtime`（`AgentRuntime.start(spec) → RuntimeSession`）、`readiness`、`hint`、可选 `installer`、`summary`。新包 `packages/adapters/hermes`：

| 契约 | Hermes 实现 |
|---|---|
| `id` | `'hermes'` |
| `prepare(ctx)` | `ctx.command('hermes', 'HERMES_COMMAND')`；为本 Worker 准备专属 profile 目录（§11）；拉起或复用 `hermes gateway`（只绑 127.0.0.1，§11）；`GET /v1/capabilities` 确认 `run_submission / run_status / run_events_sse / run_stop`；`GET /v1/models` 和 `/api/model/options` 填模型目录 |
| `readiness` | `GET /health`（存活）+ `GET /health/detailed`（就绪；降级时仍是 200，要看 `status` 字段，已核对） |
| `installer` | runtime bundle（ADR 0021，§10） |
| `start(spec)` | 建 hub 自己的 API 会话（§4），保存 `agentSessionRef` = Hermes session id，`ctx.onAgentSessionRef` 回报 |
| `prompt(input)` | `POST /v1/runs`，带 `session_id`、`Idempotency-Key`（§5）、`X-Hermes-Session-Key`（§7）；然后订阅 `GET /v1/runs/{id}/events` |
| `events()` | SSE → `SessionEvent`（§5.3 映射表） |
| `interrupt()` | `POST /v1/runs/{id}/stop`，返回 `stopping`，最终落为 `cancelled`（已核对） |
| `adopt(cursor)` | 断线重连：`GET /v1/runs/{id}` 补状态，再重连 SSE |
| `options / changeOption` | 模型、`reasoning_effort` 等走请求级 `model` / `provider` / `model_options`（Runs API 总是采用请求里的 model，已核对） |
| `pid()` | gateway 进程 pid（一个 gateway 服务多个会话时按会话统计不准，标注为近似） |
| `dispose()` | 不删 Hermes 会话（恢复要用）；hub 删除会话时才 `DELETE /api/sessions/{id}` |

## 4. 会话：hub 必须自己建

- **已核对**：`session_id` / `X-Hermes-Session-Id` 只能指向 API Server 自己建的（或可以建的）会话；指向 CLI、TUI、Desktop、ACP、消息平台拥有的会话会被拒：**HTTP 409 `permission_denied`**，不建 run、不保留幂等键，原样重试还是 409。
- 所以 hub **只用自己建的会话**，id 由 hub 生成（例如 `ahub-<hubSessionId>`），这样 Worker 重启后也能对上。
- 适配器把 409 `permission_denied` 映射为 `DomainError('foreign_session')`，界面提示「这个 Hermes 会话属于别的入口，不能接管」。不尝试走 gateway WebSocket 接管（非目标）。
- 会话删除后 id 永久作废，不会复用（已核对）；hub 新建会话总是生成新 id。

## 5. Runs API、幂等与 SSE

### 5.1 提交

- `POST /v1/runs` 返回 `{run_id, status: "started"}`（已核对）。
- **幂等**（已核对）：`Idempotency-Key` 1–255 个可见 ASCII 字符；同样的重试返回原 `run_id`、HTTP 202、`Idempotency-Replayed: true`，重启后、run 结束后也一样；同键不同内容 → 409 `idempotency_key_conflict`；键按 API 凭据隔离，保留 24 小时。
- hub 的键 = `ahub:<hubSessionId>:<promptSeq>`（再加随机后缀防猜），持久化在 hub 的 prompt 记录里；Worker 重连、hub 重试都用同一个键。**轮换 `API_SERVER_KEY` 后旧键视为新请求**（已核对），所以轮换前要等进行中的提交落定。
- 503 `runtime_draining` / `storage_unavailable` 带 `Retry-After`（已核对）→ 按头部退避重试，用同一个键。

### 5.2 并发上限

- `gateway.api_server.max_concurrent_runs` 默认 10，到上限返回 **429 Too many concurrent runs**（已核对）。
- 适配器：429 → 指数退避（1s 起，最多 30s，总时长 2 分钟），仍用同一个幂等键；超时后报 `rate_limited`（与 agent-messaging §5.6 的类型码一致）。
- Worker 侧把 Hermes 的上限设成 Worker 资源配额（ADR 0014）允许的会话数，hub 调度时把它当作这台 Worker 的 Hermes 容量。

### 5.3 SSE 事件映射

| Hermes 事件（已核对） | hub `SessionEvent` |
|---|---|
| `message.delta` | 文本增量 |
| `message.interim`（`already_streamed: true` 时跳过） | 中途说明 |
| `tool.started` / `tool.completed`（预览已脱敏、截断到 500 字符，`error` 标志） | 工具开始 / 结束 |
| `subagent.start` / `subagent.complete`（带 `child_session_id`、`delegation_id`、用量） | 子任务事件（显示在会话内，不进 hub 的会话树） |
| `approval.request` | 待批准（§6） |
| `run.completed`（带 `usage`、`runtime`） | 轮次结束 + 用量 + 实际使用的 provider / model |
| `run.failed` / `run.cancelled` / `run.interrupted` | 失败 / 取消 / 中断 |
| 澄清请求事件 | 待回答（§6）——**事件名未核对**（原文只写了 `POST /v1/runs/{id}/clarify` 和 `pending_controls`） |

- SSE 每 10 秒发一行 `:` 注释保活（已核对），解析器要跳过。
- 用迭代预算耗尽的回答（`iteration_budget_exhausted`）当作「可用但没做完」，不是失败（已核对）。
- 「助手最终帧」本身不能证明执行成功（已核对）——以 `run.completed` / 轮询状态为准。

### 5.4 结果未知的 run

- **已核对**：会话权威进程在一轮中途重启后，`GET /v1/runs/{id}` 返回 `status: "unknown"`（**不是终态**），该会话后续的工作都暂停；要用 `POST /v1/runs/{id}/resolve-unknown` 带 `admission_id`、`execution_generation` 确认，返回 `outcome: "interrupted"` 的回执后才放行。`/stop` 对未知的 admission 返回 409 `unknown_execution`。
- hub 的处理：
  1. 适配器看到 `unknown` → 发 `SessionEvent('outcome_unknown')`，会话显示「上一轮结果未知（Hermes 重启）」，**不自动重发**（第一次可能已经执行了，可能有副作用）；
  2. 给人两个按钮：「标记为中断并继续」（调 `resolve-unknown`）和「查看 Hermes 记录」（`GET /api/sessions/{id}/messages`）；
  3. 默认不自动 resolve（决定 D3）。
- 关机排空时非终态 run 带 `shutdown_requested_at`，最终落为 `interrupted`（已核对）→ hub 显示「Worker 上的 Hermes 正在重启」。

## 6. 批准与澄清 → hub 的人工介入

- **已核对**：需要批准的工具调用发出 `approval.request`，run 停在 `waiting_for_approval`；用 `POST /v1/runs/{id}/approval` 回复 `{request_id, execution_generation, choice}`（`once` 执行、`deny` 阻止）；过期的 generation、别人的 prompt id、已结束的 run → 409。不接受无标识或批量回复。不受信 MCP 服务器上的写工具也走同一条路。
- **已核对**：澄清用 `POST /v1/runs/{id}/clarify`，带 `request_id`、`execution_generation`、`answer`，不会触发新一轮推理。
- 映射：批准 → hub 现有的运行时权限确认卡（与其他运行时一致，带工具名、参数预览）；澄清 → 会话里的「agent 在问你」输入框。回复时原样带回 `request_id` 和 `execution_generation`；409 → 卡片显示「已过期」。
- 群聊 / agent 调 agent 时，批准卡发给**链头那个人**（agent-messaging §6），被调 agent 不能替人批准。
- `choice` 的取值只核对到 `once` / `deny`；其他取值（例如「总是允许」）**未核对**，P1 只做这两个。

## 7. 记忆：Hermes 自己的 vs hub 的

- **已核对**：`X-Hermes-Session-Key`（最多 256 字符，回显在响应里）给长期记忆（例如 Honcho）一个稳定的作用域，独立于会轮换的 `X-Hermes-Session-Id`；`/v1/capabilities` 里有 `session_key_header`。
- hub 的规则（ADR 0019：hub 记忆只通过 MCP 工具）：
  - **hub 记忆**：照常通过 hub MCP 工具提供（`StartSpec.tools` / `mcp`），所有运行时一样；
  - **Hermes 自己的记忆**：当作**原生能力（L3）**，hub 不读不写、不同步，只控制作用域；
  - `X-Hermes-Session-Key` = `ahub:<teamId>:<roleId>`（持久型角色，同一角色跨群共享，与 agent-messaging §16 第 10–11 条一致）或 `ahub:<teamId>:session:<hubSessionId>`（任务型，用完即弃）；
  - 项目可以关掉 Hermes 原生记忆（决定 D4，推荐默认**关**，避免两套记忆互相矛盾、也避免记忆跨出 hub 的权限边界）。**怎么关未核对**（需要查 Hermes 的 memory provider 配置）。
- hub 的 MCP 工具怎么交给 Hermes：API Server 文档**没有写**按请求传 MCP 服务器（**未核对**）；ACP 路径有 `session/new.mcpServers`（已核对）。API Server 路径的做法：在 Worker 专属 profile 的 `config.yaml` 里登记 Worker 本机的 hub MCP 中转入口（URL + 引用环境变量的令牌），每个会话用不同令牌的方式**未核对**，P1 先做每个 Worker 一个令牌、在中转处按 `X-Hermes-Session-Key` 区分会话（需要实测 Hermes 是否把该头带给 MCP——**未核对**；不行就退回 ACP 路径）。

## 8. 上下文与压缩（ADR 0020）

- **L1（运行时自带压缩）**：Hermes 自己做上下文压缩（已核对：会话消息接口有 `include_compacted=true` 可以拿回被压缩归档的轮次；压缩后要继续用同一个 session id）。hub 不替它压缩。
- **L2（hub 注入策略引导）**：ADR 0020 的静态引导和记忆引导行（≤80 token）放进 `instructions` 字段（Runs API 接受 `instructions`，已核对）；角色提示词（agent-messaging §3.5）也走这里。
- **L3（原生能力）**：Hermes 记忆、技能、子 agent 委派，hub 只观察（`subagent.*` 事件），不控制。
- hub 不传 `conversation_history`（非空时它会覆盖会话记录，已核对），始终让 Hermes 用自己会话里的记录。
- `GET /api/sessions/{id}/messages` 用于 hub 侧的记录补齐和导出。

## 9. 模型提供商：经 Worker 中继，agent 看不到密钥

- 现有机制（model-providers.md §4）：hub 只给 Worker 下发**本机中继地址 + 中继令牌**（`StartSpec.provider`），真实密钥留在 hub / Worker 中继里。
- Hermes 侧：在 Worker 专属 profile 里配一个「Custom endpoint」/ `openai-api` provider（`OPENAI_BASE_URL` 指向 Worker 本机中继，已核对 provider 存在），密钥位置放**中继令牌**，用环境变量传，不写文件。
- Hermes 的路由优先级（已核对）：会话的 `/model` 覆盖 → `model_routes` 别名 → 请求里的 model / provider → 全局默认；和 `model_routes` 冲突的 provider 请求会被 400 拒绝。适配器总是显式带 `provider`。
- `run.completed.runtime` 报告**实际**服务这一轮的 provider / model（包括回退之后的），hub 用它记账（已核对）。
- **风险**：Hermes 的 Nous Portal / Tool Gateway 等自带后端会绕过 hub 中继——Worker profile 里不配置这些，只留 hub 中继（决定 D6）。
- 中继令牌是会话级、可吊销的；即使 agent 通过终端工具读到环境变量，拿到的也只是本机中继令牌，出不了这台 Worker。

## 10. 安装：作为 runtime bundle（ADR 0021）

- 官方安装：`curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`；用固定版本的 uv，当前一方安装跑 Python 3.14（已核对）。
- bundle 内容：固定版本的 Hermes + 它的 uv / Python（不用系统 PATH 上的 uv，与官方脚本一致），装到 hub 管理的目录；ADR 0021 的安全措施照用：安装脚本在审核 diff 里可见、在 staging 里以无特权用户运行、记审计、强制哈希。
- 不直接 `curl | bash`：bundle 构建时把 install.sh 和依赖锁定、算哈希，Worker 只装 bundle。
- 安装器实现 `HarnessInstaller`，`readiness` 失败时提示「在 Worker 页安装 Hermes bundle」。

## 11. API 密钥管理与安全

- **已核对**：`API_SERVER_KEY` 对所有部署都必需，包括默认的 127.0.0.1；API Server 能用 Hermes 全部工具，**包括终端命令**；默认不开 CORS；每个 profile 用不同的 key，否则命名前缀上的默认 key 会 401。
- 规则：
  1. 每个 Worker（每个 Hermes profile）一个随机 `API_SERVER_KEY`，Worker 启动时生成，**只在内存和 Worker 私有目录（0600）**，不上报 hub、不进日志、不进 agent 的环境变量；
  2. `API_SERVER_HOST` 固定 `127.0.0.1`，不开 CORS；端口随机分配，避免和用户自己的 Hermes（默认 8642）冲突；
  3. 用户机器上已有的 Hermes（`~/.hermes`）**不复用**：Worker 用自己的 `HERMES_HOME` / profile（**变量名未核对**，Installation / profile 文档提到 profile 隔离配置、记忆、技能）；
  4. 轮换：Worker 重启或每 30 天轮换；轮换前等进行中的 run 落定（因为幂等键按凭据隔离）；
  5. 工作区：Hermes 的终端 / 文件工具只在 `StartSpec.workspaceRoot` 里——**Hermes 怎么限制工作目录未核对**，P1 前必须实测；做不到就用 Worker 现有的沙箱（容器 / 无特权用户）运行 gateway；
  6. 工具预览已经过 Hermes 的强制脱敏（已核对），hub 仍然再过一遍自己的脱敏器；
  7. 事件里的文本一律当不可信内容处理（与其他运行时一致）。

## 12. 决定（accepted，2026-10-31 David：全部选 A）

- **D1 接口**：**A. P0 用现有 acp 适配器冒烟，P1 起专用适配器走 API Server**；B. 只用 ACP；C. 只用 API Server。
- **D2 gateway 进程**：**A. 每个 Worker 一个 gateway，多会话共享（受 `max_concurrent_runs` 限制）**；B. 每个会话一个 gateway（隔离强，资源多）。
- **D3 结果未知**：**A. 不自动重发，让人选择「标记中断并继续」**；B. 超过 10 分钟自动 resolve 为中断。
- **D4 Hermes 原生记忆**：**A. 默认关，项目可开（开时按 §7 的 Session-Key 作用域）**；B. 默认开。
- **D5 并发**：**A. 429 退避 2 分钟后报 `rate_limited`；Hermes 上限 = Worker 配额**；B. 不退避，直接排进 hub 队列。
- **D6 模型来源**：**A. 只走 hub 中继，Worker profile 里不配置 Nous Portal 等自带后端**；B. 允许项目用 Hermes 自带后端（密钥不经 hub）。
- **D7 hub MCP 工具**：**A. P1 用 profile 配置 + Worker 本机中转；如果 Hermes 不把会话标识带给 MCP，就退回 ACP 路径**；B. 一开始就走 ACP。

## 13. 分期

| 期 | 内容 | 验收 |
|---|---|---|
| **P0 冒烟** | `ACP_AGENTS` 加一条 `hermes acp`；手工装 Hermes；用 hub 中继做 provider | 在 hub 里起 Hermes 会话、对话、中断 |
| **P1 专用适配器** | `packages/adapters/hermes`：gateway 生命周期、密钥、hub 自建会话、Runs + 幂等 + SSE、stop、429 / 503 退避、批准 / 澄清卡、结果未知处理、用量记账；先实测本文所有「未核对」项 | 过 conformance 套件；断网重连不重复执行；Worker 重启后 `unknown` 正确显示 |
| **P2 bundle 与记忆** | ADR 0021 bundle；`X-Hermes-Session-Key` 作用域；原生记忆开关；hub MCP 工具接入 | 在干净 Worker 上一键安装；角色跨群共享 Hermes 记忆 |
| **P3 群聊** | 作为群成员参与（agent-messaging §5.5–5.7）；`[SILENT]` 沉默标记交给 Hermes 角色提示词 | 群里 volunteer 策略能跑 |

## 14. P1 验证任务（原未核对项，P1 开工前实测；结果不影响已决方向，D7 已给出退路）

1. 澄清请求的 SSE 事件名；
2. 批准 `choice` 除 `once` / `deny` 外的取值；
3. API Server 路径怎么给每个会话不同的 MCP 服务器 / 令牌，以及 Hermes 是否把会话标识带给 MCP；
4. 关闭 Hermes 原生记忆的配置项；
5. 专属 profile 目录的环境变量名；
6. 终端 / 文件工具能否限定在工作区；
7. 一个 gateway 下各会话的进程 / 资源归属（`pid()` 只能近似）。

## 15. P1 实施记录（2026-11-01，Hermes v0.22.5，本机全新安装 + 假模型服务实测）

### 15.1 §14 验证结果

| 项 | 结果 |
| --- | --- |
| 14.1 澄清事件 | SSE 事件名 `clarify.request`（还有 `approval.responded`）；回复 `POST /v1/runs/{id}/clarify`，body 必须恰好是 `{request_id, execution_generation, answer}` |
| 14.2 批准选项 | `once / session / always / deny`；body 恰好 `{request_id, execution_generation, choice}` |
| 14.3 session key 转给 MCP | **不转**（只用于计费）。MCP 是 profile 级 → 按会话写进 profile 的 `mcp_servers`，D7 退回 ACP 不需要 |
| 14.4 关原生记忆 | `memory.memory_enabled=false`、`memory.user_profile_enabled=false` |
| 14.5 profile 环境变量 | `HERMES_HOME`；配置里 `${VAR}` 读时展开（model 和 mcp env 都实测可用） |
| 14.6 每轮 cwd | **没有**。只有 profile 的 `terminal.cwd`（默认目录，不是沙箱） |
| 其他 | 一个 HERMES_HOME 只能起一个网关；`X-Hermes-Session-Key` 是幂等指纹的一部分（换了就 409 `idempotency_key_conflict`）；完整 HERMES_HOME 约 424 MB，共享 installs/cache 后一个会话约 5.5 MB |

### 15.2 实际形状（相对 D2-A 的偏离，保守选择，待 David 确认）

- **每个 hub 会话一个网关**（不是每 worker 一个）：中继令牌按会话发、没有每轮 cwd、MCP 是 profile 级、一个网关绑一个 HERMES_HOME，四条都指向「每会话」。网关只听 127.0.0.1 随机端口，API 密钥随机、只在内存。会话目录 `~/.local/state/agent-hub/hermes/sessions/ahub-<会话 id>` 不删，resume 时 Hermes 自己的 state.db 接着用（实测跨网关重启能接上历史）。
- **默认不注册**：要设 `HERMES_COMMAND` 或 `WORKER_HERMES=1`。只能用 hub 模型提供商（D6）；worker 环境里像密钥的变量（`*KEY*`、`*TOKEN*` 等）不传给 Hermes。
- **批准**：hub 还没有批准卡片，和 ACP 运行时一样自动放行，但只回 `once`，从不回 session/always；每次记一条诊断。
- **澄清**：回固定一句「用户不在，自己判断并说明假设」，记诊断。
- **结果未知（unknown）**：不自动处理（D3）——发 warn 诊断 + `ended interrupted`。界面上的「标记已解决」按钮留到后续。
- **幂等键** `ahub:<会话>:<轮次>:<随机>`，429/503/网络错误用同一个键退避（最多 2 分钟）。键只在 worker 内存里：worker 自己重启时不跨进程复用（已知缺口）。
- 不发 `conversation_history`；不支持 fork（descriptor 里 denied）。

## 16. 加固（2026-11-01）

拓扑不变：仍是每会话一个网关（§15）。

1. **进行中一轮记盘**：`<HERMES_HOME>/ahub-pending.json`（0600，原子改名写）记 `{key, inputHash, runId, at}`。
   - 提交前写（runId 为 null），拿到 run_id 后补上，这一轮有了结局再清；收尾只清 runId 对得上的那份（下一轮可能已经记上）。
   - 幂等键跨 worker 重启：上次同一条输入没确认收到（5xx / 断线），这次沿用同一个键，Hermes 只跑一次；明确 4xx 被拒就清掉；换了输入就换键。
   - 开会话对账：记着 runId 的，查 `GET /v1/runs/{id}`。还在跑 → 接着跟；结果未知或查不到 → 一条警告诊断 + `ended interrupted`（原因带 `outcome_unknown`）；已结束 → 只记一条诊断（不补 ended，免得一轮旧结局冒充新一轮）。
2. **结果未知的处理界面**：`ended interrupted` 且原因带 `outcome_unknown` 时，对话里出一张说明卡（不确定在哪、平台不会自动重试、先看工作区）。卡是最后一块且不在跑时给两个按钮：「重发这一轮」（把上一句文字原样再发；附件不带，卡上写明），「不用了」（只在这台浏览器记成已处理）。画布卡片上只显示一行提示。
3. **真网关中断测试**：`HERMES_LIVE=1 node --test packages/adapters/hermes/src/live-interrupt.test.ts`。全新 HERMES_HOME + 本地假 OpenAI 兼容模型（慢慢吐字，不用密钥）：发一轮 → 出字 → 中断 → 落 `stopped`（实测 0.4–0.6s），收到 ended 马上发下一轮也能接。CI 默认跳过（没装 Hermes）。
   - 测出并修了一个竞态：以前先推 ended、后放开「正在跑」，收到 ended 马上发下一轮会撞「上一轮还没结束」。现在终态先放开再推。

## 17. 每个 worker 一个网关（2026-11-01，回到 D2-A）

David 要求按 ADR 0022 D2-A：一个 worker 只起一个 Hermes 网关，会话用 Hermes 自己的会话机制隔开。§15 里「每会话一个网关」的四个理由逐个处理如下。

### 17.1 中继凭据按会话：worker 内分流器

- 实测（v0.22.5，假模型服务抓包）：Hermes 发给上游的请求里**没有任何会话标识**——header 只有 OpenAI SDK 的 `x-stainless-*` 和 `authorization`，body 只有 `model/messages/tools/stream/...`。
- 所以靠模型名带路由：网关的 custom provider 指 worker 内的 `provider-mux.ts`（127.0.0.1 随机端口 + 随机密钥，密钥只在内存和网关进程环境里）。每个会话开起来时登记一条路由 `{中继 baseUrl, 会话令牌, 模型}`，拿到一个随机路由 id；每轮提交 `model: "<路由>~<真模型>"`。分流器认出路由、换回真模型、带上**这个会话自己的**中继令牌转给 hub 中继——用量照旧按会话 / 提供商 / 项目记（ADR 0013 不变）。
- 未知路由 / 会话已关 → 404，绝不会落到别的会话的凭据上。会话令牌只在内存里，不落盘。

### 17.2 会话隔离

- 每个 hub 会话 `ahub-<id>` 一条 Hermes 会话（`POST /api/sessions`，409 = resume，`permission_denied` = 别人的，拒绝）；每个请求带它自己的 `X-Hermes-Session-Key`，幂等键也按会话。
- 进行中一轮的记录（幂等 / 对账，§16）放在 `root/worker/sessions/ahub-<id>/ahub-pending.json`，各管各的。
- 网关按引用计数：第一个会话来时起，最后一个会话关时停；网关意外退出，所有开着的会话各自收尾（interrupted），下一个会话来时重起。关一个会话只 stop 它自己那一轮，不动网关。

### 17.3 无每轮 cwd（保守选择，列给 David）

Runs API 和 REST `/api/sessions` 都没有 cwd（只有 TUI JSON-RPC 的 `session.create` 有会话级 cwd，那要接 websocket 协议，P1 不做）。所以：
- 网关的 `terminal.cwd` 是一个**中性的空目录**（`root/worker/cwd`），不拿任何一个会话的工作区当大家的默认目录；
- 每轮 instructions 开头写明这个会话的工作区绝对路径，要求文件工具用绝对路径、终端命令先 `cd` 进去。这是提示不是沙箱（§15 也不是）。

### 17.4 MCP（hub 工具）暂不提供（保守选择，列给 David）

MCP 是 profile 级，session key 不会转给 MCP（§14.3）。共用网关下 hub 工具垫片分不清是哪个会话在调——按「宁缺不串」，共用网关不配 `mcp_servers`。以后的路：接 TUI JSON-RPC 的会话级策略，或 Hermes 把会话 id 转给 MCP。

### 17.5 实测（本机全新 Hermes v0.22.5 + 假模型服务，`HERMES_LIVE=1`）

- 两个会话同一个网关 pid；A 在慢慢吐字时 B 正常跑完（`done`）；中断 A → `stopped`；
- 上游看到：A 的请求全是 A 的令牌、真模型名 `slow-1`；B 的请求全是 B 的令牌，消息里没有 A 的话，有 B 自己的工作区路径；
- 关 A 后网关还在、B 还能再跑一轮；B 也关了网关退出；
- 原来的单会话中断用例照旧通过（中断 → `stopped`，约 0.4s；收到 ended 马上能发下一轮）。幂等键 / 对账 / 结果未知的单测照旧通过。
