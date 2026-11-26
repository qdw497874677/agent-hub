# 会话通信：一仓一会话的协作（感知 · 只读看对方 · 互发消息）

- 状态：accepted（2026-11-18 David 确认 §13 三项按推荐默认）。P1a–P1f 已实现并合入 master（#245 #246 #247 #248 #249 #250，2026-11-18，master `5b77631`）；实现与设计的差异见 §17
- 日期：2026-11-18
- 基线：origin/master `303c668`；参考 PR #241（组合工作空间，未合并）
- 相关：ADR 0018（agent 间通信，P1 已实现）、ADR 0031（送达队列）、ADR 0036（投递内核）、ADR 0015 / `external-surface.md`（对外 MCP）、`multi-repo.md`；本设计对应 **ADR 0038**

## 0. 结论

1. **不新建第二套消息系统。** ADR 0018 的 P1 已经在代码里（`MessageBus`、`agent_messages`、`agent.send / ask / reply / status / inbox / peers / directory`、连线 `SessionLink`、深度 / 并发 / 扇出上限、不可信包裹、按人取交集）。本设计是它的**第二步**：把它用到「一仓一会话 + 跨机器 + 外部 agent 编排」这个场景上。
2. **可寻址的单位只有会话。** 机器（worker）只是会话的落点，不是地址；要「另一台机器来验证」，就在那台机器上开一条验证会话，然后给它发消息。
3. **普通点对点消息可达 = 显式连线 + 消息派生父子 + 同项目同任务树**。可达与授予工具、读取文件是不同的判断。外部 agent 和 `session_start` 可以在建会话时一并连线；任务内起短名（`peer:verify`），agent 不用记长 id。
4. **补五块能力**：
   - ① 同伴感知变丰富：同伴的仓库、分支、有没有未提交改动、机器、状态、未读数。
   - ② 只读看同伴的工作空间（跨机器走现有 hub↔worker RPC）。
   - ③ 消息带结构化附件（`data` / git `ref` / 同伴文件引用 / 链接），回复带 `status`。
   - ④ 外部 agent 作为发送方：发消息，并取回复（长轮询，不需要回调地址）。
   - ⑤ 防风暴：同一对会话之间限速、重复内容拦截、来回打转就暂停，以及权限档位升级时拦下等人放行。
5. **组合工作空间与会话通信分工**：开发用一仓一会话，验证可以用一条组合会话把几个仓的分支一起拉起来。两者用消息衔接，不互相替代。

## 1. 场景与目标

**目标场景**（t438u–t440u、t443u）：
- 外部 agent 只通过 MCP，在多仓项目里开几条开发会话（每条一个仓，机器 A）。
- 再在机器 B 上开一条验证会话。
- 开发会话推完分支后，**直接问**验证会话「按这几个分支启动验证」。验证会话被唤醒，拉分支、启动、做健康检查，再把结构化结果**回给**开发会话。
- 开发会话根据结果修复或收尾。外部 agent 全程能看到进展，最后合并、收起、两台机器都清理干净。

**目标**：
- 会话之间能互相发现、发消息、请求 / 应答，并且关联得上。
- 能只读看同伴的文件和改动。
- 能跨 worker，外部 agent 也能参与。
- 消息不丢、不重复，循环能自己停下来。
- 每一步可审计；界面里一眼能看出谁问了谁。

**非目标（本期）**：
- 跨会话写文件。
- 跨仓原子提交。
- 群广播进一仓一会话（群聊仍走 ADR 0018 §5）。
- A2A 网关（ADR 0018 P3）。
- 中途插话（steer），留到 P2。

## 2. 调研

### 2.1 t3code（pingdotgg/t3code，2026-11-18 读 `docs/orchestration-v2/*`）

| 点 | t3code 的做法 | 我们借什么 |
|---|---|---|
| 单位 | AppThread → Run → ExecutionNode；一个线程一个工作目录（`workspaceStrategy`：`root` / `worktree` / `existing_worktree`）；**没有多仓项目**（社区讨论仍在问） | 一仓一会话，与 #241 组合并存 |
| 编排入口 | app 自有 MCP（`t3-code` 服务器），凭据按「环境 + 父线程 + provider 会话」签发；会话释放时吊销，空闲过期 | 与我们的会话 ToolGrant 同构，保持 |
| 委派 | `delegate_task`：建子线程，**只带任务文本、不带父历史**；`mode: async \| wait`；完成后**唤醒父线程**（结果带 `next` 提示：别轮询，没别的事就结束这一轮）；子线程的提问会转给父线程 | 回复唤醒提问方（已有）；在工具结果里加 `next` 提示 |
| 线程间消息 | `t3_thread_send`：`auto`（空闲就开新一轮，可插话就插，否则排队）/ `queue` / `steer` / `restart`；`t3_thread_wait` 等一轮结束，超时不取消；`t3_thread_read` 有界、分页（约 3 万字截断） | MVP 只做 auto（空闲唤醒、忙就排队），steer 按运行时能力放进 P2；外部 `message_get` / `events` 加 `waitSec` |
| 权限 | **权限天花板**：改别的线程要求调用方有活跃 run，目标的运行时 / 交互模式不能比调用方宽；子线程只能更窄 | §7.3 权限档位升级拦截 |
| 幂等 | `clientRequestId` 推导出稳定的命令 / 消息 id，重试回放同一个回执 | 外部写工具已有 `clientRequestId`，消息复用它 |
| 来历 | 每条消息带 `createdBy`（agent / user）和 `creationSource`（mcp / provider），**actor 与入口分开** | `from.kind` + `via` |
| 引用 | agent 用 `t3-thread://v2/<env>/<thread>` 链接指代线程，不手写 id 或标题（标题会过期） | 任务内短名 `peer:<handle>` + 结果里带链接 |
| 跨环境 | 项目和线程属于一个环境；跨环境须显式授权 | 不把同任务树关系扩展到项目外 |
| 失败 | 有类型的失败码（`thread_not_sendable`、`runtime_mode_escalation_denied`……） | 沿用 ADR 0018 的失败码并补 4 个 |

### 2.2 业界（简）

| 方案 | 要点 | 取舍 |
|---|---|---|
| Claude Code 跨会话消息（[文档](https://code.claude.com/docs/en/cross-session-messaging)） | `ListAgents` + `SendMessage`，只发**纯文本**（不传历史、不传文件，提到的路径对方自己开）。对方空闲就开新一轮，忙就在工具调用之间读。`notify_when_idle` 在对方空闲时回一条通知。入站有 accept / hold / refuse 三档；**发送方跳过审批、接收方要审批时，消息先拦下等人批**。防循环：按发送方限速、短时间内的相同内容丢弃、队列最多 50 | 借：空闲唤醒、拦下档、相同内容去重、按对限速。改：我们的附件可以带结构化数据和引用 |
| Claude Code agent teams（实验） | lead + 队友、共享任务列表、点对点；**不会自动把队友隔离到各自的 worktree**，很耗 token | 我们靠一仓一 worktree 天然隔离 |
| OpenAI Agents SDK | handoff（交出控制权）和 agent-as-tool（拿回结果）分开 | `ask` 属于 agent-as-tool，转交走 `send` 再收起 |
| Devin Managed Devins | 协调者把活派给多个隔离 VM，监控并汇总 | 与「验证会话在 B 机」同构 |
| Amp | 项目级多仓检出 + 变更面板汇总，偏组合 | #241 已采用 |
| OpenHands | 委派子 agent，结果回父 | 同 ADR 0018 |
| A2A v1.0.1（2026-05） | Agent Card、Task 状态、`contextId`；推送是至少一次投递 | 只做对外映射（ADR 0018 P3）；内部的投递状态名对齐它的 TaskState |

**读出来的几条**：
- 大家的共识是「**消息是文本 + 引用，不是共享文件系统**」。
- 「对方空闲就唤醒、忙就排队」是默认，插话需要运行时支持。
- 防循环都靠**接收侧限速 + 去重 + 有界队列**。
- 权限上**不能借别人的手绕过审批**。

### 2.3 我们已有的（只读核对 master）

| 已有 | 位置 | 本设计怎么用 |
|---|---|---|
| `MessageBus.accept / reply / turnEnded / pump`：同项目、连线或父子才可达；派生的任务会话默认隔离；深度 4、并发 8、扇出 10；ask 默认超时 30 分钟；正文 ≤32KB；空闲就投、忙就排队，每轮只投一条 ask；轮末文本兜底作为回复 | `packages/domain/src/use-cases/messaging.ts`、`messaging.ts` | 扩展，不重写 |
| 工具 `agent.directory / peers / send / ask / reply / status / inbox`、`agent.activity`、`agent.spawn`（同任务、同 worker、同工作空间） | `tools/message-tools.ts`、`tools/agent-orchestration-tools.ts` | 加参数；spawn 增加选仓 / 选机器（依赖一仓一会话） |
| `peerBriefingFor`：每次发话都列出最多 20 个连线同伴（id、agent、标题、首句、状态） | `use-cases/conversation.ts` | 加仓库 / 分支 / 机器 / 未读（P1a），脏（P1c）；只在变化时注入 |
| `SessionLink`（无向，画布拖线或会话页选择） | `session-link.ts` | 显式指定会话关系的记录；带 `createdBy / via` |
| `workspace.list / read`：只能看**自己**；人用的 `/api/sessions/:id/files` 已能看任意可见会话，跨 worker 走 RPC | `tools/files-tools.ts`、`use-cases/workspace-files.ts` | 加 `session` 参数 |
| 会话收件箱 / 占用判断（ADR 0036 `SessionInbox`） | `deps.occupied` | 投递仍走它，不另判 |
| 对外 MCP：路由元数据生成 35 个工具；写工具要 `clientRequestId`；`session_reply` 202 后用 `events` 轮询；本机 Worker 对令牌 403 | `apps/server/src/openapi/routes.ts`、`skills/agent-hub-workbench` | 新增 6 个工具 + `waitSec` |
| 群聊、主持人 | ADR 0018 §5 | 不动 |

**结论**：缺的是 ① 富同伴感知、② 只读看同伴、③ 结构化附件和回复状态、④ 外部发送方、⑤ 场景化的防风暴和权限档位、⑥ 一仓一会话的派生选仓。

## 3. 寻址

| 地址 | 含义 | 本期 |
|---|---|---|
| `session:<id>` | 具体会话 | 已有 |
| `peer:<handle>` | 调用方能到达的同伴短名（短名在任务内唯一） | **新增** |
| `bot:<name>`（旧 `role:`） | 项目里的常驻 bot / 角色 | 已有 |
| `external:<inboxId>` | 外部 agent 的收件箱，只作为回复目标（§5.4） | **新增**，内部只能 reply |
| `group:<id>` | 群 | 已有（群聊） |

- **handle**：`session_start`、`agent.spawn` 和会话页可以设置。规则 `^[a-z][a-z0-9-]{1,31}$`，在任务内唯一；不设时用 `<agentId>-<id 后 4 位>`（P1a 实现：短名存在 `agent_session_handles` 表，不改 Session 模型）。改名不影响已发的消息（消息存 `targetSessionId`）。
- **解析**：`peer:` 只在调用方可达且可见的通信同伴中解析；同一短名不能唯一确定接收方时，用发现结果中的 `session:<id>` 定向发送。文件工具的寻址范围不随之扩大。
- **不做 worker 地址和 project 广播**：机器是落点；项目广播风暴风险高，用途也不清楚。

## 4. 发现：谁能看见谁

| 关系 | 能看见（目录） | 能发消息 | 能只读看工作空间 |
|---|---|---|---|
| 显式连线（画布 / 会话页 / `session_link` / `session_start.linkWith`） | 是 | 是 | 是（还要有文件读权限，§7） |
| 派生父 ↔ 子 | 是 | 是 | 是 |
| 同项目、同一顶层任务树、没连线 | 是 | 是（须有通信权限） | 否，仅有任务树关系不够 |
| 同项目、不同任务树、没连线 | `agent.activity` 只列状态 / 标题 | 否 | 否 |
| 别的项目、别的团队 | 否 | 否 | 否 |

- 同任务、父子任务与兄弟子任务共享同一个顶层任务，默认不需要连线。任务树关系不落为连接记录，不会在画布上新增线；`connected` 只表示显式连线，`relation` 说明同伴为何出现。
- `agent.spawn` 派生出的会话（包括 P1 新增的选仓派生）**自动和父会话可达**（父子关系，不额外建线）。
- 同伴信息（`agent.peers`、briefing）：

```
同伴（2）：
- peer:verify  session:9f3a… · 机器 B · 仓库 one（组合：agentar, dtaiagtmng）· 分支 hub/9f3a · 空闲 · 未读 0
- peer:dev-dtai session:77c1… · 机器 A · 仓库 dtaiagtmng · 分支 hub/77c1 · 有未提交改动 · 工作中
用 agent.ask / agent.send 联系；workspace.read 仍需已有文件寻址关系和读取权限。
```

- briefing **只在同伴集合或状态变了时注入**（记录上次注入的指纹），不再每一轮都加，省 token。

## 5. 消息模型

### 5.1 种类（不变）

`send`（通知，不等回复）· `ask`（请求，等回复）· `reply`（只能回复 ask）。`cancel` 留到 P2。

### 5.2 信封扩展

在现有 `AgentMessage` 上增加：

```ts
from: { kind: 'session'; sessionId } | { kind: 'external'; inboxId; tokenFamilyId };   // 原 fromSessionId 迁成这个
via: 'agent' | 'connector' | 'web';           // 入口，和 actor 分开（借 t3code）
parts?: Part[];                                // 最多 8 个，序列化后 ≤ 16KB；正文仍是 body（≤32KB）
wake: boolean;                                 // 只有 send 可以设成 false：进收件箱，不唤醒对方
timeoutSec?: number;                           // 只用于 ask，默认 1800，最多 14400（验证可能要很久）
replyStatus?: 'ok' | 'failed' | 'refused';     // 只用于 reply
readAt?: number;                               // 对方读过（投递，或 inbox 读取时）
holdReason?: 'privilege' | 'pingpong';         // 拦下等人的原因

type Part =
  | { type: 'data'; schema?: string; data: unknown }                    // 结构化结果，例如 verify-result/v1
  | { type: 'ref'; repo: string; branch?: string; sha?: string }        // git 引用：repo 必须是项目登记的仓库
  | { type: 'file'; session: string; path: string; member?: string }    // 同伴文件引用：对方用 workspace.read 打开，不内联
  | { type: 'link'; url: string; label?: string };                      // PR / 预览链接：只允许 http(s)
```

- 附件和正文一起**包在不可信边界里**投递（ADR 0018 §8），`data` 以 JSON 代码块呈现。
- `ref` 校验：`repo` 必须在项目仓库清单里；分支名用 git 的 ref 规则；`sha` 是 7–40 位十六进制。这样验证会话不会被诱导去拉任意 URL。
- `file` 只是引用，不复制内容；读的时候按读方的权限重新判断（§7.2）。

### 5.3 投递语义

| 目标状态 | `wake: true`（默认） | `wake: false`（只有 send） |
|---|---|---|
| 空闲 | 立刻作为新一轮提问投递（已有） | 进收件箱；对方下一轮的 briefing 显示「未读 N」 |
| 忙 | 排队，这一轮结束后按 FIFO 投（已有）；每轮最多投一条 ask | 同上 |
| 已收起（settled）/ worktree 已清理 | **不唤醒**，失败码 `archived`（§13 Q2） | 同左 |
| 机器离线 | 留在队列；`target_offline` 自动重试一次，用同一个 id（ADR 0018 §5.6） | 同左 |
| 等审批中 | 排队 | 同左 |

- **回复**：继续以 `agent.reply` 为主（可以带 `status` 和 `data`），轮末文本兜底。回复投给提问方，**提问方空闲时会被唤醒**（已有）。工具结果里带 `next`：「答复会作为新一轮消息送到；没有别的事就结束这一轮，不要轮询」。
- **超时**：到 `timeoutSec` 还没答复，就给提问方投一条失败回复（`timeout`），被问方那一轮不受影响。
- **插话（steer）**：P2。按运行时能力位开放，没有这个能力就退回排队。

### 5.4 外部 agent 作为发送方

- 外部 agent 用 `session_message` 发 send / ask，`from = external:<inboxId>`。
- `inboxId` 绑定**令牌族**：轮换令牌后沿用同一个收件箱，吊销后收件箱关闭。
- 回复不唤醒任何会话，进外部收件箱。外部 agent 用 `message_get(waitSec)` 或 `message_inbox` 取。
- 内部会话**只能 reply** 外部的 ask，不能主动给外部发消息。主动推送（webhook）放到 P2。
- 外部发来的消息在目标会话里署名「外部 · <令牌名> 代 <令牌主人>」，同样包在不可信边界里。
- 外部用 `session_reply` 说的话是「对会话下指令」，和 `session_message` 的「agent 消息」区别在于：
  - 前者以令牌主人的身份作为普通提问，不包边界；
  - 后者走消息总线，受限额和防风暴约束，回复可以关联。
- 建议外部编排时**只用 `session_reply` 下指令**；只有需要关联回复时才用 `session_message`。

### 5.5 送达、顺序、幂等

- **持久化**：消息先写 `agent_messages` 再投递（持久 outbox）。hub 重启后 `sweep` 接着投。
- **顺序**：每个目标会话 FIFO（同一个 `pump` 串行）；不同目标之间不保证顺序；回复按到达先后。
- **幂等**：键是 `(from 的 actor, idempotencyKey)`。外部写工具的 `clientRequestId` 就是 idempotencyKey；内部的 `agent.send / ask` 已经有 `idempotencyKey`。投递是至少一次，「已投递」状态加上 journal 里的 prompt 事件按 messageId 去重，对 agent 来说就是恰好一次。
- **状态机**（对齐 A2A TaskState 的名字）：`queued → (held) → delivered → answered | done | failed | denied | canceled`。

## 6. 只读看同伴的工作空间

- 工具：`workspace.list / read` 加参数 `session`（`session:<id>` 或 `peer:<handle>`）；P1 再新增 `workspace.changes`（未提交的 diff 摘要，复用人用的 changes 用例），并给已有的 `git.state`（分支、领先 / 落后、最近 5 个提交）的 `session` 参数。组合会话再加 `member`。
- 跨机器：复用 `WorkspaceFilesService` 的 `remote(workerId)` RPC。对方机器离线时返回 `target_offline`；worktree 已清理时返回 `workspace_gone`。
- 读的上限沿用现有的：单次 64KB（最多 256KB）、一层 200 条、每会话 30 次 / 分钟。
- **敏感文件对 agent 一律不给**（`isSensitivePath`），没有确认通道。
- **不提供写**。要对方改，就给对方发消息。

## 7. 权限与身份

### 7.1 发消息（沿用 ADR 0018 的交集，补外部）

有效权限 = 发送方会话的主人 ∩ 链头那个人（`onBehalfOf`）∩ 被调会话的主人，权限点是 `agent.message.send` / `agent.ask`。

外部发送方：
- `onBehalfOf` = 令牌主人（bot 令牌就是那个 bot）。
- 需要 `sessions:write`（发）或 `sessions:read`（读收件箱 / 状态）。
- 项目限定令牌只能碰本项目的会话。
- **本机 Worker 上的会话一律拒绝**（与 `session_start` 一致）。
- 跨团队拒绝。

### 7.2 只读看同伴

同时满足以下条件才放行：
- 可达（连线或父子）；
- `onBehalfOf` 对目标会话有 `session.read`；
- 对项目有 `workspace.files.read`；
- 调用方会话的 ToolGrant 有 `files` scope。

每次读都记审计 `workspace.peer_read`：路径、字节数，**不记内容**。

### 7.3 权限档位升级拦截（借 Claude 入站默认、t3code 天花板）

- hub 按运行时报告的审批设置把会话分成两档：`guarded`（工具要审批）和 `auto`（跳过审批或自动批准）。
- **guarded → auto 的 ask / send 先拦下**（`held: privilege`），在「等我处理」里出一张放行卡（发起人或项目 owner / admin 可以批）。
- 原因：不能借一条自动批准的会话，去做自己要审批的事。
- 档位未知时不拦，但记审计。P2 收紧到运行时都报告档位之后。
- 项目可以关掉（`trustPeers: true`），关闭记审计（§13 Q3）。

### 7.4 不变量（加测试）

- agent 永远不会比派它的人权限大。
- 读同伴不等于能写。
- 外部令牌碰不到本机 Worker。
- 跨团队一律拒绝。
- 所有入口都过 `MessageBus.accept()`。

## 8. 防循环 / 防风暴 / 预算

| 规则 | 默认 | 状态 |
|---|---|---|
| 深度 / 每链并发 / 扇出 | 4 / 8 / 10（项目最多调到 2 倍） | 已有 |
| 工具速率 | 每会话 20 次 / 分钟 | 已有 |
| **同一对（A→B）速率** | 每分钟 6 条，超了拒绝 `rate_limited`，并提示「合并成一条或稍后再发」 | 新 |
| **重复内容** | 同一个 A→B，正文和附件的哈希在 10 分钟内相同 → 拒绝 `duplicate` | 新 |
| **来回打转** | 同一条链里 A↔B 往返超过 8 次、中间没有人说话 → 整条链暂停（`held: pingpong`），「等我处理」显示「需要你」，人回复或点「继续」后恢复 | 新 |
| **每会话收件队列** | 20 条（排队 + 拦下），超了拒绝 `busy` | 设计里有，落实 |
| **每链唤醒轮数** | 消息触发的轮次每链最多 30 轮，到上限后新消息直接拒绝（`rate_limited`，提示请人接手）。P1a 实现为拒绝而不是「只进收件箱」：更简单，也不会悄悄堆消息 | 新 |
| `send` 不会触发隐式回复 | 只有 ask 有轮末兜底 | 已有 |
| 不能 reply 一个 reply | | 已有 |
| token / 费用预算 | 按链累计 usage | P2 |

## 9. 界面（文案最简）

- **会话时间线**：
  - agent 消息显示成一行小卡：`← verify · 提问`、`→ verify · 等回复 / 已回复 / 超时 / 已拦下`。
  - 展开后看正文、附件（ref 显示成 `仓库@分支·sha7`，file 可以点开只读查看）和回复。
  - 外部来的标「外部」。
- **头部同伴**：`同伴 2` 小标；点开列出 handle、机器、仓库 / 分支、状态，每行一个「看文件」（打开现有文件页，只读）。
- **拦下**：「等我处理」里显示「verify → dev · 待放行」，按钮只有「放行」「拒绝」。
- **画布**：连线已有；有在途 ask 的连线加一个箭头和计数，P2 再做动画和调用链视图。
- **手机 390px**：同伴放进底部抽屉，消息卡占一行。

## 10. MCP 工具

### 10.1 会话内（agent-hub MCP，ToolGrant）

| 工具 | 变化 |
|---|---|
| `agent.peers` | 返回富同伴信息（§4）：handle、worker、仓库、分支、标题、状态（P1a）；dirty 随 P1c 的 `workspace.changes` 一起补 |
| `agent.send` / `agent.ask` | `to` 支持 `peer:`；新增 `parts`；send 加 `wake`，ask 加 `timeoutSec`；结果带 `next` |
| `agent.reply` | 新增 `status`、`data`（可带 `schema`） |
| `agent.inbox` | 新增 `unreadOnly`，读过标记已读 |
| `workspace.list` / `workspace.read` / `git.state` | 新增 `session`（只读看同伴） |
| `workspace.changes`（新） | 未提交改动摘要（文件 + 增删行数，可选单文件 diff），`session` 可选；自己和同伴都能用 |
| `agent.spawn` | 新增 `repoId`、`workerId`、`handle`（依赖一仓一会话，§12 P1b） |

### 10.2 对外（`/openapi/v1/mcp`，由路由元数据生成）

| 工具 | scope | 说明 |
|---|---|---|
| `session_link` | `sessions:write` | 连两条会话（同项目），幂等 |
| `session_unlink` | `sessions:write` | 断开（destructive 注解） |
| `session_peers` | `sessions:read` | 某条会话的同伴（同 §4） |
| `session_message` | `sessions:write` | 以外部身份给会话发 send / ask（`to`、`kind`、`body`、`parts?`、`timeoutSec?`、`clientRequestId`） |
| `message_get` | `sessions:read` | 消息状态和回复；`waitSec ≤ 50` 长轮询 |
| `message_inbox` | `sessions:read` | 外部收件箱（回复），用 `after` 游标 |

- `session_start` 新增 `handle?`、`linkWith?: string[]`、`repoId?`（一仓一会话）。
- `events` / `get_session` 新增 `waitSec ≤ 50`（等这一轮结束，借 t3code `thread_wait`，超时不取消）。
- 共 +6 个工具（35 → 41）。`tools.md` 由 `npm run skill:tools` 重新生成。
- skill（`agent-hub-workbench`）新增配方「开发 → 交给验证会话 → 取回结果」和 `verify-result/v1` 结构：

```json
{ "schema": "verify-result/v1", "ok": true, "testedRefs": [{"repo":"agentar","branch":"hub/77c1","sha":"…"}],
  "steps": [{"name":"setup","ok":true,"sec":42},{"name":"start","ok":true},{"name":"health","ok":true,"detail":"GET /health 200"}],
  "logs": [{"type":"file","session":"peer:verify","path":".hub/verify.log"}] }
```

## 11. 审计

| 动作 | 记什么 |
|---|---|
| `accepted / denied / delivered / replied / failed / spawn_requested` | 已有 |
| `held / released / rejected` | 拦下原因、放行人 |
| `link_created / link_removed` | actor、`via`（web / connector / agent） |
| `workspace.peer_read` | 读方、目标、路径、字节数 |
| 外部消息 | `actor` = 令牌主人，`via` = connector，`tokenId`（不记令牌值） |

- 全部按 `traceId` 串起来，会话页的「活动」可以按链筛选。
- 审计里只存正文前 80 字的摘要，并经过现有的密钥脱敏；服务器日志不打印消息正文。

## 12. 与多仓组合、生命周期的关系

- **开发用一仓一会话，验证用组合。** 验证会话在机器 B 上用 #241 的组合工作空间（`workspace_group_create { workerId: B, fromGroupId?, branches }`，或者一仓一会话时按 `ref` 自己 `git fetch` / `checkout`），一次拉起几个仓。开发会话通过 `ref` 告诉它测哪几个提交。
- **组合会话本身就是一个同伴**，看它的文件要带 `member`。
- **生命周期**：
  - 会话收起（settled）后不再被消息唤醒，发给它的消息失败 `archived`。
  - 它发出、还没答复的 ask 标为 `canceled`，提问方收到一条失败回复。
  - 它还没处理的入站消息标为 `failed: archived`。
- **清理**：
  - 验证会话没有 PR，靠 `taskEndedClean`（任务结束后收起）或外部显式调 `session_settle`。
  - 开发会话靠 `prMerged`。
  - 两台机器的 worktree 都由 `workspace_sweep` 按项目扫（#241 §14.4）。
  - 消息和审计**不随 worktree 删除**。
- **重开**：人或外部 agent 用 `reopen` 恢复 worktree 之后，会话才可以再被消息唤醒。

## 13. 已确认（2026-11-18，按推荐默认）

1. **同一任务里的会话要不要默认互通（不用连线）？** 2026-11-23 决定：**同项目同一顶层任务树默认可达**。跨树仍需显式连线或已有的消息派生父子关系；原有隔离与授予规则不变。
2. **已收起的会话收到消息时要不要自动唤醒（顺带恢复 worktree）？** 推荐：**不唤醒**，返回 `archived`，由人或外部 agent 显式重开。否则消息可能把清理过的 worktree 反复拉回来。
3. **权限档位升级（guarded → auto）要不要默认拦下等人放行？** 推荐：**默认拦**，项目可以关（`trustPeers`）。

## 14. 实施计划

| 期 | 内容 | 验收 |
|---|---|---|
| **P1a 消息与同伴** | 信封迁移（`from` / `via` / `parts` / `wake` / `timeoutSec` / `replyStatus` / `readAt` / `holdReason`，老数据 `from.kind = session`）；handle 与 `peer:`；富 `agent.peers` 和按变化注入的 briefing；`agent.reply` 的 status / data；`next` 提示；`archived` 规则；§8 新规则（按对限速、重复、打转、收件队列、每链唤醒）；审计补全 | 领域单测：可达矩阵、交集、拦下、限速 / 重复 / 打转、幂等、settled |
| **P1b 一仓一会话派生** | `session_start` / `agent.spawn` 支持 `repoId`、`workerId`、`handle`、`linkWith`（为那个仓新建 worktree；复用 #241 的单仓 worktree 改进） | 派生到另一个仓 + 另一台机器，自动可达 |
| **P1c 只读看同伴** | `workspace.list / read / changes`、`git.state` 加 `session`；跨 worker RPC；敏感文件拒绝；`peer_read` 审计 | 跨机器读、越权拒绝、敏感文件拒绝、路径逃逸拒绝 |
| **P1d 对外** | 6 个新工具 + `events` / `get_session` 的 `waitSec`；外部收件箱（绑令牌族）；吊销即关；skill 配方和 `verify-result/v1`；`tools.md` 重新生成 | MCP parity 快照；长轮询 ≤50s；吊销后 401 |
| **P1e 界面** | 时间线消息卡、同伴小标和抽屉、拦下放行卡、画布箭头计数 | 桌面和 390px 截图 |
| **P1f 权限档位** | guarded / auto 分档、拦下、`trustPeers` | 升级被拦、放行后投递 |
| P2 | steer（按能力）、`cancel` 传播、`wake:false` 合并投递、token 预算、调用链视图、外部 webhook 推送、`notify_when_idle` 式订阅 | |
| P3 | A2A 网关（ADR 0018 P3） | |

**顺序**：P1a → P1b → P1c → P1d → P1f → P1e，每期一个 PR，CI 全绿再进下一期。P1b 依赖 #241 合并。实际合并顺序：P1a → P1c → P1f → P1d → P1e → P1b（栈式 PR，P1b 等 #241 合并后最后合）。

## 15. 测试计划

- **领域单测**（表驱动，`packages/domain`）：
  - 可达矩阵（连线 / 消息派生 / 同任务 / 父子与兄弟任务 / 同项目跨树未连 / 跨项目 / 跨团队），分别验证发现、发消息和读文件；
  - 权限交集（主人 / onBehalfOf / 被调方），外部 actor；
  - 拦下 / 放行 / 拒绝；
  - 按对限速、重复内容、打转暂停、收件队列、每链唤醒上限；
  - `(actor, key)` 幂等；
  - settled 目标、离线重试一次、超时回复；
  - ref / link 校验，`file` 引用按读方的权限判断。
- **存储**：迁移前后数据一致；`from` 回填。
- **服务端**：
  - 对外 MCP `tools/list` 快照（+6）；
  - `waitSec` 上限，超时返回当前状态；
  - 项目限定令牌碰别的项目 404；
  - 本机 Worker 403；
  - 吊销后 401，审计保留。
- **前端**：消息卡状态、拦下卡、同伴抽屉的组件测试。

## 16. 端到端场景（只用 Hub 托管的 glm-5.3-flash，不用 Go；没配置就跳过并说明，不换模型）

环境：hub + **两个 `origin=remote` 的 worker 进程**（A：开发，B：验证）+ 一个外部 MCP 客户端脚本（只用项目限定令牌）。

| # | 场景 | 通过标准 |
|---|---|---|
| E1 | 跨机器问答：A 上的 dev `agent.ask peer:verify`（带 `ref`）→ B 上的 verify 被唤醒，拉分支、启动、健康检查，用 `agent.reply` 回复（status + `verify-result/v1`）→ dev 被唤醒并引用结果 | 回复关联到同一个 messageId；`testedRefs` 的 sha 等于 dev 推送的 sha；两边时间线都有消息卡 |
| E2 | **外部 agent 全程**：`task_create` → 两条开发会话（`repoId` 各一，机器 A，`linkWith`）+ 一条验证会话（机器 B，组合）→ `session_reply` 派活 → 开发推送、开 PR → 开发问验证 → 外部用 `message_inbox` / `events(waitSec)` 跟进展 → 标记合并 → `session_settle` / `workspace_sweep` | 不经过界面；两台机器的 worktree 目录和 `git worktree list` 都干净；审计按 trace 能串起全链 |
| E3 | 忙时排队、空闲唤醒、FIFO：连发 3 条给一条正在忙的会话 | 按序投递，每轮最多一条 ask |
| E4 | 防风暴：诱导两条会话互相 ask | 第 9 次往返时暂停，「需要你」出现；重复内容被拒；按对限速提示「合并」 |
| E5 | 拒绝路径：跨任务树且无既有关系、别的项目令牌、本机 Worker、读同伴敏感文件、`..` 路径、发给 settled 会话、guarded → auto | 各自返回正确的失败码，审计里有 `denied` / `held` |
| E6 | 令牌：外部 ask 在途时轮换（收件箱沿用）、吊销（401，收件箱关闭） | 不打印令牌；审计保留 |
| E7 | 界面：消息卡、同伴抽屉、拦下卡 | 桌面 1280 和手机 390 的截图 |

## 附录 A：三轮评审记录（作者自审，没有使用付费模型）

### A.1 第一轮：架构

| # | 发现 | 处理 |
|---|---|---|
| A1 | 初稿想新建一个 `session_messages` 表和一套投递逻辑 | 否决。复用 `agent_messages`、`MessageBus`、`SessionInbox`（ADR 0036 要的就是不再多一份占用判断） |
| A2 | 外部发送方不是会话，现有代码处处假设 `fromSessionId` 非空（`enqueueReply` 把回复投给 `ask.fromSessionId`） | 引入 `from` 判别联合；回复给外部时写进外部收件箱，不走 pump；迁移时老数据回填 `from.kind = session` |
| A3 | 初稿把 worker 当地址（「发给机器 B」） | 否决。机器是落点；要在 B 上干活就先开一条会话，否则就会出现「谁来答、用哪个模型、在哪个目录」都要另定的第二套编排 |
| A4 | 对外长轮询和无状态 MCP 冲突？ | 不冲突：一次 HTTP 请求内等待（≤50s，低于常见代理 60s），用进程内事件唤醒加存储兜底；不引入 MCP 会话 |
| A5 | 会话没有任务（容器会话 #221）时 handle 的作用域 | 只用 `session:<id>`，不支持 `peer:` |
| A6 | steer 要 RuntimeAdapter 新契约，大多数运行时没有 | 移到 P2，按能力位开放（借 t3code 的 capability） |
| A7 | 消息唤醒已清理的会话会触发 worktree 恢复，和清理策略打架 | `archived`，不唤醒（§13 Q2） |
| A8 | briefing 每一轮都注入同伴列表，长对话里浪费 | 只在同伴的指纹变了时注入 |

### A.2 第二轮：安全 / 权限

| # | 发现 | 处理 |
|---|---|---|
| S1 | 只读看同伴是一条外泄通道：文件权限更小的人可以借 agent 看到更多 | 按 `onBehalfOf` 判断 `session.read` 和 `workspace.files.read`；敏感文件对 agent 一律不给；限速；`peer_read` 审计 |
| S2 | 附件是新的注入面：`ref` 可能诱导去 fetch 任意 URL，`link` 可能是 `file:` / `javascript:` | `ref.repo` 必须是项目登记的仓库，分支和 sha 做格式校验；`link` 只允许 http(s)；所有附件都在不可信边界内 |
| S3 | 借一条自动批准的会话绕过审批 | §7.3 拦下（借 Claude 入站默认和 t3code 权限天花板） |
| S4 | 外部令牌的范围 | 项目限定令牌只到本项目；本机 Worker 拒绝；跨团队拒绝；`session_link` 要 `sessions:write`；连线变更记审计 |
| S5 | 幂等键跨 actor 撞车，可能取到别人的回执 | 键的作用域是 `(actor, key)`，外部是 `(tokenFamilyId, clientRequestId)` |
| S6 | 令牌吊销后在途的 ask 和收件箱怎么办 | 收件箱绑令牌族：轮换沿用，吊销即关闭；在途的 ask 标为 `canceled`，目标会话这一轮不受影响 |
| S7 | 消息里的密钥进审计和日志 | 审计只存摘要并做脱敏；服务器日志不打印正文；E2E 输出不打印令牌 |
| S8 | 长轮询拖垮连接 | 每个令牌最多 4 个并发等待，超出返回 429 `rate_limited` |

### A.3 第三轮：agent 体验 / 外部 MCP 可用性

| # | 发现 | 处理 |
|---|---|---|
| U1 | 初稿对外新增 8 个工具（另有 `message_wait`、`session_wait`、`session_messages`），太多，模型容易选错 | 合并成 6 个：`message_get` 带 `waitSec`；等一轮结束复用 `events` / `get_session` 加 `waitSec`；消息记录走 `session_peers` 加 `message_inbox` |
| U2 | 会话 id 太长，模型会抄错 | `peer:<handle>`；`unresolvable` 时列出可用的 handle |
| U3 | 内部 ask 之后，模型不知道该等还是该结束这一轮 | 工具结果带 `next`，briefing 里加一句「答复会作为新一轮消息送到」（借 t3code） |
| U4 | 验证结果格式各写各的，提问方不好判断 | skill 给出 `verify-result/v1`；`data.schema` 写的是已知结构时做校验，不合格就提示重答 |
| U5 | 外部 agent 不知道怎么等 | `message_get(waitSec=50)` 返回 `{status, reply?, retryAfterSec}`；skill 配方写明循环和退出条件 |
| U6 | `session_reply` 和 `session_message` 容易混用 | 工具描述写明「下指令用 session_reply；要关联回复才用 session_message」；skill 也加一段 |
| U7 | 新失败码要让外部 agent 能按码分支 | `errors.md` 补 `archived`、`duplicate`、`held`、`workspace_gone`，每个写「下一步怎么做」 |
| U8 | 命名统一 | 新工具都用 `<资源>_<动作>`；老名字不动（#241 §14.2 第 2 条） |

## 附录 B：来源

- t3code：`docs/orchestration-v2/README.md`、`orchestrator-mcp-server.md`、`thread-lineage-and-context-transfer.md`、`feature-lifecycles.md`、`docs/internals/remote.md`（github.com/pingdotgg/t3code，main，2026-11-18）
- Claude Code：[cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)、[agent teams](https://code.claude.com/docs/en/agent-teams)
- A2A：[v1.0.1 release](https://github.com/a2aproject/A2A/releases/tag/v1.0.1)、[spec](https://a2a-protocol.org/latest/specification/)
- 业界多仓 / 多 agent 调研：#241 工作区的 `INDUSTRY.md` §4、§6（2026-11-18）
- 本仓库：ADR 0018、0031、0036、`agent-messaging.md`、`external-surface.md`、`multi-repo.md`（#241）

## 17. 实现记录与差异

### P1a（#245，合并 `831b29c`）

- 失败码：已收起统一叫 `archived`（原稿 `target_settled`）；另加 `duplicate`、`busy`（收件队列满）。
- 每链唤醒 30 轮到顶后**拒绝**（`rate_limited`），不是「只进收件箱」。
- 拦下：新增消息状态 `held` + `holdReason`（`pingpong`，P1f 再加 `privilege`）；人用 `POST /api/messages/:id/decision` 放行 / 拒绝（和派生审批同一个口子，按消息状态分流）。拒绝 ask 时提问方收到 `denied` 失败回复。放行后来回计数从放行那条重新算。
- 来回打转按「同一条 trace 里这一对会话的非回复消息 ≥ 8 条」判（P1a 没有「中间有人说话」的信号，人说话会开新 trace，效果等价）。
- `wake=false` 只允许 `send`；落库状态直接是 `done`、`readAt` 为空 = 未读；简报显示未读数，`agent.inbox unreadOnly` 读后标已读。
- 短名单独存表 `agent_session_handles`（任务内唯一索引），默认 `<agentId>-<id 后 4 位>`；`PUT /api/sessions/:id/handle` 设置。
- `agent.peers` / 简报的 dirty 推迟到 P1c；`GET /api/sessions/:id/peers` 给界面（P1e）用。
- 同伴简报改由消息总线生成，按会话做内容指纹，**不变就不垫**（进程内记忆，重启后第一轮会再垫一次）。

### P1c（#246，合并 `3492bf3`）

- `workspace.list` / `workspace.read` / `git.state` 加 `session` 参数（`peer:<短名>` 或 `session:<id>`，自己也行）；只读，跨会话一律走 `resolvePeer`：同项目 + 连了线或派生关系，已收起返回 `archived`。
- 新工具 `workspace.changes`（只在 Hub 有 git 状态服务时列出）：分支、上游、ahead、dirty、改动文件（≤ 200，超出 `truncated`）。dirty **没有**塞进 `agent.peers`（每次列同伴都去问 git 太重），要看就调 `workspace.changes`。

### P1f（#247，合并 `06dbd06`）

- 档位由会话运行时选项推：`yolo` / `sandbox=danger-full-access` / `approval=never` / 免审批类 mode → auto；审批类 mode 或给了 `approval` / `sandbox` → guarded；其余 unknown。
- 只拦 guarded → auto；任一端 unknown 不拦，但 accepted 审计记 `tier=X→Y`（pi 目前就是 unknown）。
- 项目开关 `trustPeers`（默认关）存在 `agent_messaging_config.trust_peers`；`PUT /api/projects/:id/messaging` 不给就保持原值、改动入审计（`config`）。privilege 拦下只有发起人或有 `project.update` 的人能放行。

### P1d（#248，合并 `526e957`）

- 外部收件箱 = 令牌 id（现在没有令牌家族 / 轮换的概念）；外部发送者记作 `external:<令牌 id>`，署名「外部 · 令牌名」，吊销后收件箱 401。
- 断开连线是 `POST /sessions/{id}/unlink`（DELETE 会落到 `session.delete` 权限）。
- `session_message` 要 `session.prompt`，并且和 `session_reply` 一样过 Worker 检查：本机 Worker 的会话永远不对令牌开放。
- 外部 ask 的回复（含超时、archived）进外部收件箱，不唤醒任何会话；`message_get` / `get_session` / `events` 支持 `waitSec ≤ 50` 长轮询；收件箱游标 = createdAt。

### P1e（#249，合并 `0b9ddbf`）

- 检查器：「同伴」区（短名、状态、仓库@分支、机器、未读数、连线 / 派生；可改自己的短名）；协作消息行显示附件、「不唤醒·未读 / 已读」、回复状态；被拦下的消息有放行 / 拒绝卡。
- 时间线：hub 投进来的 agent 消息画成卡片（类型、来源、代谁、回复状态、正文），不再显示原始标签；侧栏 / 画布的「开头一句」也去掉标签（`promptOpening`）。
- 项目设置 · 项目页：「信任同伴」开关；`PUT /messaging` 不给 `roles` 时保持角色表不变。
- 画布连线上的消息计数没做（留待后续）。

### 消息来源（第一阶段）

- **来源、发起者和授权代表是三件事。** 来源是路由上的会话、外部入口或系统；发起者由 Hub 在入口记录为账号、会话工具、自动回复、外部令牌或系统；`onBehalfOf` 仍只用于权限。旧记录缺少证据时保留未知，不从正文或授权代表补写。
- 唤醒消息的会话日志保存正文及不含来源会话 ID 的 `messageSource`；现有投递保存带确切消息 ID 的 `messageOrigin` 并把它传到 Worker 和适配器。同一个发送动作不增加投递、不改变审批或收件箱语义；不唤醒消息仍只在协作消息里。
- 专注页、画布和检查器用同一套来源语义。来源详情按当前权限检查接收会话、来源会话和显式文件引用；能读收到的消息不等于能读来源会话。旧包装只作历史展示，不作已验证的身份。
- 适配器仍沿用现有转义文本以兼容旧 Worker、旧运行时。本阶段不声称模型已通过独立原生字段收到消息身份，也不把该字段当作模型指令或授权依据。

### P1b（#250，合并 `5b77631`；#241 合并后基于 master 798b718）

- `session_start` / `/api/sessions/derive` 加 `repoId`（项目仓库 id 或仓库名）：只为这个仓开**单仓**隔离 worktree（`prepareRepoWorktreeUseCase`，复用组合组的仓库基座查找 / clone），分支 `agent-hub/<仓>-<会话后缀>`，不建组合组；和 `workspaceId` / `groupId` 互斥。准备命令只在主仓库（或单仓项目）跑。
- `handle` / `linkWith`：建会话**之前**检查（短名格式与任务内唯一 → 409；linkWith 同项目、能对它 `session.prompt`、没收起），建好后起短名、连线；个别失败只记日志、不回滚会话。
- `agent.spawn` 加 `repo_id` / `worker_id` / `handle`：派出来的会话**自动和发起方连线**；机器、模型检查都按会话主人算。没给模型且同运行时：沿用发起方模型（否则落到运行时默认，可能没配，E2E 里就是这样暴露的）；hub 托管模型先过提供商检查，和 derive 一致。
- 设计里 `agent.spawn` 的 `linkWith` 没做：派生只自动连发起方，要连更多用 `session_link`。
