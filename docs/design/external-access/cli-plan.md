# 外部接入与 `ahub` CLI 改造计划

状态：**设计待批准，尚未实施**。核对基线：agent-hub `99c585e4`；Orca `a91fc0a6`。本文定义新 CLI 的目标契约；现有客户端的行为以当前实现为准。

## 1. 要解决什么

让外部 Agent、自动化脚本和人在不打开画布的情况下，完成一条可对账的工作流：**确认接入身份 → 找到项目和执行位置 → 创建任务／开会话 → 发消息 → 等这一轮的可信结果 → 查看交付**。断网时最重要的不是自动重试，而是知道已确认什么、还未知什么，以及下一步怎么查。

借 Orca 的是三件事：可发现的目标、独立的就绪／回合状态、丢回执后按原请求恢复。[Orca 的 launch 恢复实现](https://github.com/stablyai/orca/blob/a91fc0a676e324b2630a78bdc6d885f513cc9d88/src/cli/agents/agent-launch-recovery.ts#L60-L89)也明确区分可重放和结果未知。我们不复制它的对象模型：**Project 是权限范围，Task 是工作意图，Session 是执行与历史，WorkDir 是 Worker 上的执行目录**。不引入新的 Run、编排 DAG、终端／浏览器遥控、本地守护进程，也不把设计扩成全量 API 的命令生成器。

CLI 使用现有 `/openapi/v1`；REST 和外部 MCP 继续共用路由、身份、授权、审计及领域用例。浏览器内部 `/api` 和 Agent 会话内的 MCP 是不同入口，不给 CLI 借用。Hub 仓库凭证托管、生产 HTTPS 迁移及生产启用不在本次范围；接入令牌不能代替仓库凭证。

## 2. 当前能力与缺口

| 现有能力 | 缺口与方向 |
| --- | --- |
| 73 条 OpenAPI 路径、83 个操作、76 个外部 MCP 工具；有访问令牌、预设、项目范围、审计 | 不再建一套接口体系；增加薄客户端和少量必要的只读发现／对账契约。基线见 [路由奇偶测试](../../../apps/server/src/openapi-mcp-parity.test.ts)。 |
| 项目、任务、Worker、模型、组件可查询；`GET /me` 可确认身份 | 用户缺少「这台机器、目录和运行时能否用来开这条会话」的一致答案。当前能列出 Hub 同机 Worker，但外部令牌不能使用；`session_start` 不指定目录还能隐式准备目录及触发组件引导。见 [会话入口](../../../apps/server/src/openapi/handlers/sessions.ts)、[工作目录选择](../../../apps/server/src/session-workspace.ts)。 |
| `POST /sessions/:id/prompt` 会回 `202`，带 `turn/seq/deliveryId/state` | `202` 只是 Hub 收件；最新 Session 状态不是指定回合的结果。**A 在跑、B 已排队时，A 的 `ended` 可能落到 B 的 `turn`**；即使 `ended.turn === B.turn` 也不够。旧脚本 `wait` 见到任何 `ended` 即返回成功。保持旧脚本兼容，在新 CLI 修正。 |
| 对外 `/events` 已投影、支持游标和长轮询 | MCP 二次投影会丢工具事件；`outcomeUnknown` 被省略；外部 SSE 历史／实时直接发原始事件，实时又缺 `turn`。不能只让新 CLI 避开 SSE 就认定外部泄漏风险已关闭。见 [投影](../../../apps/server/src/openapi/projection.ts)、[会话路由](../../../apps/server/src/openapi/routes/sessions.ts)。 |
| 现有 `Idempotency-Key`／MCP `clientRequestId` 和 prompt `clientMessageId` | 旧 HTTP/MCP 缓存按令牌、方法、路径和 key，保留约 24 小时；可能接管超时占位，5xx 不留档。消息 ID 只扫最近 200 条，旧重放还可能带回**当前**而非原始 `turn`。都不是跨重启或并发场景下的强恢复承诺。见 [幂等中间件](../../../apps/server/src/openapi/idempotency.ts)、[发送用例](../../../packages/domain/src/use-cases/conversation.ts)。 |

## 3. 使用体验与命令

命令名为本计划目标，以下不是当前可执行命令。首发命令运行在仓库要求的 Node 26 环境，不依赖 Orca、不要求客户端安装 Git 或 Agent；先提供源码检出和 CI 可调用的入口 `scripts/ahub.ts`，再依据试用决定是否发独立安装包。现有 [工作台 Skill 打包](../../../apps/server/src/workbench-skill.ts)只收 Markdown，接入说明可链接入口，不假定下载 Skill 就装好了 CLI。

| 命令 | 行为 |
| --- | --- |
| `ahub auth login --hub <https-base-url> --profile <name>`；`auth status`；`auth logout` | 令牌由现有外部接入页签发；终端可无回显录入，CI 从 `AHUB_API_TOKEN` 或 `--token-stdin` 注入，绝不收明文命令行参数。`status` 访问 `/me`，明确显示 Hub 和账户；`logout` 只清本地配置，远端撤销仍在 Hub。 |
| `ahub project list`、`task list/show`、`session show` | 读取当前令牌可见的资源；首发只接受完整 ID 进行写操作，名称用于搜索和显示，不把同名、第一个结果或「最近打开」当作写入目标。`task show` 同时列会话与已有 PR 链接，不把模型答复当作已创建 PR。 |
| `ahub doctor --task <id> [--worker <id>]` | 查令牌、目标及候选 Worker／工作目录／运行时与模型，显示已就绪、离线、无权限或不支持、无法确认等。只读；不装运行时、不启用组件、不 clone、不写配置。服务器执行时必须重查，doctor 不是授权或预留。 |
| `ahub task create --project <id> --title ...` | 只建 Task，不隐式开会话。返回完整 Task ID。 |
| `ahub session start --task <id> --worker <id> --workspace <id> --agent <id> [--model <id>]` | 第一阶段只选**已有单一工作目录**；需要临时 worktree、组合目录或初始化仓库，沿用现有界面／API 另做。模型可省略并由 Hub 解析；没有生效默认就给出可行动错误。不自动换 Worker、目录或模型。 |
| `ahub session send <id> --stdin [--wait]`；`session wait <id> --turn <n> [--after <seq>]` | send 先报 Hub ACK；`--wait` 等 ACK 的 `deliveryId` 对应的结果。单独 wait 由 Hub 把 `turn` 解析到原 prompt 和 delivery；找不到可信关联就报未知。`--after` 只影响进度读取，不影响结果查询。超时或 Ctrl-C 不向 Hub 发停止命令。 |
| `ahub operation status <id>`；后续 `operation retry <id>` | 首发只读返回本地请求快照和已掌握的远端证据，不会再次 POST。仅在服务端具备明确的操作回执协议后才开放同 ID 重放。 |

典型流程中，`auth login` → `project list` → `task create` → `doctor --task` → `session start` → `session send --wait` → `task show`。不提供一步式 `run`：它会把建任务、目录与启动和发送的副作用混在一起，出故障后难以判断该查哪一步。可脚本串联；每一步都有独立 ID 和退出结果。

## 4. 协议与实现

### 4.1 身份、配置与发现

- 新客户端只接收 `ahp_…`。CI 的 `AHUB_HUB_URL` 与 `AHUB_API_TOKEN` 成对显式注入、默认不落盘；只给其中之一即报错，不与已存 profile 混用。登录时 `--token-stdin` 只读令牌，不和 `send --stdin` 共占标准输入。配置存用户私有目录，原子写入，POSIX 文件 `0600`／目录 `0700`，Windows 发布前须有等价 ACL 验收。保存令牌前先向绑定的 Hub 验证；非 TTY 不弹交互提示。禁止读取 `.env.deploy.local`、`HUB_TOKEN`、Worker env、浏览器 cookie 或旧脚本配置来猜凭证。新格式不覆盖旧 `scripts/workbench-mcp.ts`，不改变旧脚本的 TTY、JSON 或退出码。
- 同一 profile 绑定规范 base URL（scheme/host/port 和反代路径前缀）；构建 v1 请求不得丢前缀或跳往其他路径域。拒绝带 userinfo、查询或片段的配置 URL；不跟随重定向。HTTPS 验证不降级，HTTP 只允许显式回环开发地址（含可信隧道终点），不在现有公网 HTTP 直接发送令牌。日志与 `--json` 不输出 bearer、认证头、原始错误体、提示词或私有配置路径；回合正文是用户明确读取的内容，不作为诊断日志。使用项目限定、短期、最小 scope 令牌。新端点复用 v1 鉴权、RBAC、限流、审计；不可见资源按现有 404 策略，不借发现接口枚举其他项目。
- P1 增补 `GET /openapi/v1/tasks/{taskId}/session-targets`（拟定名）：只读返回可见 Worker、已绑定单仓 WorkDir 的 ID／展示名，以及根据当前证据可解释的阻塞；复用现有 Worker、模型、默认 Agent、组件接口，不复制解析规则，不返回机器的任意文件路径。是否显示受限候选，以调用者本来就可见为前提；无法判断时返回 `unknown`。服务器另加**显式 bounded placement** 的 start 选项：要求已验证的 `taskId/workerId/workspaceId/agentId`，在任何可变操作前核对路径归属、作用域、默认模型和能力；不进入旧的自动准备／安装分支。无此选项的旧 REST/MCP 调用保持原行为。
- 在已有 `/me` 响应上增可选的协议能力声明，分别标记 `session_targets_v1`、`bounded_session_start_v1`、`exact_turn_status_v1`，P2 再加 `verified_operation_receipt_v1`；表示 Hub 支持契约，不表示令牌有权限。缺少声明时允许既有基础查询，不发送需要新约束的 start，不猜精确结果，不探测性 POST，也不切换传输。发现和回合状态作为只读 MCP 工具共用 DTO 与权限；P2 回执初期仅 REST，不默认扩充 MCP 写工具。

### 4.2 一轮一份结果；历史和实时同一安全边界

- **P0 先修外部事件面。** REST 在 handler 对领域事件统一做一次允许列表投影，MCP 直接传该 DTO；保留 `seq/at/turn`、允许的文本／工具摘要／终态，保留可证明的 `outcomeUnknown`。不透传 prompt、thinking、审批细节、工具入参／原始输出、原始诊断或未归类字段；`ended.reason` 只返回稳定对外原因码或通用文案，缺失或非法 outcome 不得补成 `done`。正文允许显式读取，不承诺模型正文永不含秘密。内部 Web journal 不动。
- 外部 SSE 保留原路径、帧形式和续读入口，历史／实时都从已提交 journal 发同一投影；连接中重新校验权限，吊销后不继续返回数据。若同批做不完，作为安全措施在原路由临时回明确错误和轮询替代，并告知现有调用方；不得通过回滚恢复原始外部流。按 [ADR 0015](../../adr/0015-open-api-v1.md) 保持 v1 增量兼容，真正破坏性变更走 v2（并行至少 90 天），不为兼容保留 raw 模式。首版新 CLI 走 REST 长轮询，不依赖 SSE。
- **精确结果以原始投递身份为准。** [SQLite journal append](../../../packages/storage-sqlite/src/store.ts) 会拿落盘时的 `session.turn` 给事件打标签；B 的 prompt 入队已递增它，A 的 `ended` 因而可能标成 B。[送达对账](../../../packages/domain/src/use-cases/delivery.ts)已经以 `deliveryId` 区分。P1 的只读状态资源 `GET /openapi/v1/sessions/{id}/turns/{turn}`（拟定名）必须从原 prompt 的 `(sessionId, seq, turn)` 找到它自己的 delivery，再以 `ended.deliveryId` 或等价的持久化事件关联确认结果；`send --wait` 额外验证 ACK 的原始 seq／delivery 与状态资源一致。只在该会话内查询，不接受客户端给的 ID 代替归属检查。保留 `outcomeUnknown`；缺失、旧数据无关联、相互矛盾都报 `unknown`。不能用客户端锁、最新 Session 状态、模型输出或 `ended.turn` 猜。
- 状态资源返回安全的 `deliveryState`、`outcome`、`outcomeUnknown`、相关序号和可核验的等待原因。结果未知优先于表面终态；`delivered` 只表示交给了运行时，离线不等于失败，等待用户输入只接受可关联到本轮的结构化证据。不能取得可信状态的旧 Hub 不支持自动化 `wait`。
- 进度长轮询用 `nextAfter` 推进、遇断线只重发 GET 并遵守退避、总预算和 `Retry-After`；恢复后按 `seq` 去重。`sinceTurn` 是下界而非精确筛选。正文、工具等若还不能可靠附到指定 delivery，就只显示精确状态，不把其它轮的文本冒充本轮结果；用户可以单独读会话时间线。成功与否始终来自精确状态资源，而非长轮询的到达次序。

**新 CLI 的输出契约**：人读摘要默认走 stdout，重试提示／诊断去 stderr；`--json` stdout 单一带 `schemaVersion: 1` 的对象，字段最少含 `status`、已确定的 `{ operationId, taskId, sessionId, turn, seq, deliveryId }`，错误附稳定 `code` 与 `nextAction`。自动化据字段判断，不解析中文。多结果按资源规则分页；`task show` 只展示现有任务、会话与 PR 信息，不增加新的 Artifact API。

| 退出码 | 含义 |
| --- | --- |
| `0` | 查询或请求成功；`send` 不带 wait 时指 `accepted`，`wait`／`send --wait` 时只指已确认本轮 `done` |
| `2` | 参数／配置错误或需明确选择目标 |
| `3` | 鉴权／权限／不可见，细节看稳定错误码 |
| `4` | 可确认的未送达、失败、停止或中断 |
| `5` | 等待预算耗尽，本轮仍有明确的非终态；没有取消工作 |
| `6` | 操作或回合**结果未知**；包括无法建立可信匹配、旧 Hub 无所需证据等 |
| `7` | 确认需要用户输入；不等于失败或完成 |
| `130` | 本地等待被 Ctrl-C 中止；不向 Hub 发 interrupt |

### 4.3 丢回执的恢复分两档

**P1：保守可核对，但不承诺可重放。** 为每次写操作在发请求前原子持久化本地 checkpoint：同一 Hub base URL、账户／令牌的非秘密标识（用于发现轮换／切换）、操作类型及 ID、已知目标、带版本的请求摘要、已有回执与时间。prompt 相关摘要用本地私有密钥作 HMAC，不保存可离线猜测的裸摘要或原文。持久化不了就不发写请求；不存 bearer、提示词、附件和原始请求体。写请求仍带原 `Idempotency-Key`，prompt 带同一次生成的 `clientMessageId`；发送后断线、超时、收到不具备确定性证据的 5xx／响应异常，即记 `unknown` 并停止，不自动发第二次 POST、不换 key、不删任务、不补发消息。重启加载已确认的 ACK 和游标后只续读；没有匹配回执只能给排查线索，不能按标题、时间或最新回合“认领”任务。

**P2：服务端强回执，才开放安全重放。** 新协议对 create/start/send 三类显式启用，不扩大旧幂等中间件的承诺。Hub 收据按授权主体（用户／服务身份及团队和项目）、操作类型、请求 ID 隔离；同 key 不同请求摘要返回冲突。摘要使用版本化规范编码；敏感输入用 Hub 私有 HMAC，校验密钥失效时禁止重放，不视为新操作。每次读、重放均复核令牌活性和当前范围；轮换或降权不自动放行历史回执，不跨主体读取别人的操作。提供只读、不会 reserve 的按 ID 查询；记录至少区分 `pending/accepted/succeeded/rejected/unknown`，保留可证明的资源 ID 或无副作用证据，不要求未知项伪造结果，也不靠计时接管：

1. **建任务**：新 `Task` 与回执同一持久化事务；不冒用要求真实来源 Session 的现有派工回执。
2. **启动会话**：启动意图和拟定 Session ID 在外部 Worker 调用前持久化；结构化区分会话已登记、启动已请求、运行时就绪与结果未知。只认当前启动 attempt 的证据；旧 Worker 不支持确证、回执迟到或重启无法对账时保持 `unknown`，不另开会话，不自动换目录/机器、不自动删除。此阶段仍限制为 P1 的已有目录，避免回执中夹带 checkout、安装等多重副作用。
3. **发送**：在会话串行入口内以完整索引约束去重，prompt、delivery、原始 `turn/seq/deliveryId` 与回执同一事务；重复调用返回原回执，不能再读当前 `session.turn` 填充，也不能把重放扩大成自动重送给模型。

P2 的重放和首次提交明确分开：仅对仍查得到的原收据返回原结果，或在 Hub 能证明未派发且仍持有原意图时继续同一操作；`pending` 且无法确定时只读对账。成品回执建议保留至少 7 天，未决状态不以时间自动释放；过期、已清理或未知 key 的**重放请求**一律不执行，和提交一个新操作不是同一个入口。客户端在同 base URL／范围只用**原 ID、原请求摘要**重放；需要提示词等原文时由调用者重新提供并核对摘要，`operation retry` 不从磁盘还原秘密。没有持久收据能力的 Hub 仍走 P1 保守语义。不宣称“恰好执行一次”。

## 5. 实施顺序和迁移

| 阶段 | 交付与归属 | 放行条件 |
| --- | --- | --- |
| **P0 · 对外事件与文档** | Server：事件 DTO、MCP 单投影、保留 unknown、SSE 安全处置；更新 `docs/openapi/v1.json`、MCP 说明、旧文档矛盾（scope／只读模式、事件投影、wait）。 | 安全字段负例、REST/MCP 等值、旧 REST 字段兼容、内部页面仍正常；SSE 安全已证明或已停用。先独立评审发布，不等 CLI。 |
| **P1a · 发现与只读 CLI** | Server 增发现和精确回合读口；CLI profile、auth/status、doctor、query、`wait`、稳定 JSON。现有脚本作为兼容入口，不强行改名迁移。 | 有权限／无权限／跨项目／无 Worker fixture；新 CLI 对旧 Hub 清楚报不支持，不降级到内部路由或猜回合。 |
| **P1b · 有界写入** | Server 的严格 start；CLI `task create`、`session start`、`session send`、checkpoint／status；沿用 REST 写权限，不把仅控制 MCP 的只读开关描述成 REST 禁写。要发只读凭据就不授写 scope。可交付第一版给内部用户。 | 真实隔离 Hub + 远程 Worker + 假 ACP：同一流程终点可追溯；丢响应／重启后不会第二次写；老 MCP 工具和旧脚本保持兼容。 |
| **P2 · 可恢复写** | Domain/SQLite/Server 的强回执和 Worker 同 attempt 对账；CLI 检测协议并开放 `operation retry`；完成短指南和面向接入页的接入手册。 | 故障注入证明同任务、同 Session、同 prompt 不重复；撤权／轮换、旧 Worker、过期收据均安全停住。未过不能宣传可重放。 |

先定 DTO 和契约测试，再允许 Server／CLI 两个写入范围并行，文档和兼容策略归同一负责人。Server 不为 CLI 增加新的 Worker 权限；CLI 不拥有业务规则。暂不改 Web 接入页；若后续加 CLI tab 或复制命令，再做桌面与手机的 Playwright，不把它作为首发依赖。

发布顺序是 Hub 能力 → 新 CLI → 小范围接入。不采集令牌、正文、提示词；按操作种类记录拒绝、未送达、未知、确定完成和收据查找结果。只要出现重复 Session／重复 prompt、越权读或外部出现未投影事件，立即暂停相应写能力／外部流并保留只读与收据查验。回退包不移除待对账收据或恢复原始 SSE；若新收据尚有未决项，先停止新写、按前向修复处理，不直接启用会绕过新约束的旧写路径。

## 6. 验收矩阵

| 必验情形 | 可观察证据 |
| --- | --- |
| 正常委派；多候选默认不猜；Hub 同机、离线、已移除、无运行时、目录不属于任务项目 | 权限视图准确；doctor 零副作用；严格 start 不触发 clone／安装／备选派发；任务、会话、回合 ID 可追溯。 |
| A 在跑时 B 入队，A 的 `ended.turn` 与 B 相同；同文字发两轮；上一轮来自旧 Agent；断线、分页、投影空窗 | A 可以已结束，B 必须仍待定，直到 B 自己的持久证据出现；无关联的旧事件不得返回 `0`。游标不回退、不重复；正文和工具摘要在 REST/MCP 一致；超时和 Ctrl-C 不打断。 |
| 原始 journal 包含提示词、思考、工具参数、工具输出、诊断、任意新字段；连接中撤销令牌 | REST 与 MCP 不包含哨兵字段；SSE 已停用或在历史／实时同样通过负例与撤权；内部 Web 行为不变。 |
| 请求未到 Hub、已写但响应丢失、收到 5xx、CLI/Hub/Worker 重启、并发同键／不同摘要、旧 Worker 回执晚到 | P1 只产生一次写请求并标未知；P2 只返回原资源与原 `turn/seq`，或明确冲突／未知，绝不跨 Worker 重开。实际核对 SQLite 数量与 Worker 启动计数。 |
| 多 profile、跨 origin 跳转、非 TTY、过期／轮换令牌、只读模式及项目范围、磁盘写失败 | 不转发令牌、不写裸日志；权限错误不是猜测为成功；不能保存 checkpoint 时无业务写入。用两个隔离 Hub 和合成令牌断言请求边界。 |

先跑现有门禁：`node --test apps/server/src/openapi.test.ts apps/server/src/openapi-mcp-parity.test.ts apps/server/src/openapi/projection.test.ts apps/server/src/openapi/idempotency.test.ts scripts/workbench-mcp.test.ts`；维护 `npm run openapi:snapshot` 生成并审核 diff。新覆盖计划放在 `scripts/ahub.test.ts`（CLI parser、输出、进程与配置）、`e2e/external-cli.test.ts`（独立 Hub/Worker/CLI 真链路，故障注入，合成数据；不使用生产或真令牌）；若改 Web，增加相应 Playwright。集成后的最终树按[测试与发布门禁](../../testing/README.md)跑 `npm ci`、`npm run ci`、新 node E2E 和适用 Playwright。报告要附准确命令、退出状态、样例输出和计数；未验生产登录或模型真实回复另列，不用探活代替。
