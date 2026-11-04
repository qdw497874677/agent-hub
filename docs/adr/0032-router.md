# ADR 0032：连接器（Connector）与总管（Router）

- 状态：accepted（2026-11-04 PT David 定稿，见末尾「定稿」）
- 相关：ADR 0023（审批卡）、ADR 0030（能力、凭据预设）、ADR 0031（送达队列 `message_delivery`、收件箱、来历）
- 参考（/workspace/research）：hermes-agent（cron 先推进 next_run、宽限、运行唯一键）、openclaw（唤醒到主会话、IM 通道）、dsh-superagent（总管拆单）、OpenHands（label 触发、写权限校验、回写 issue）

## 原则

**通用但不过度设计：简单而抽象。** 核心只有几个概念（入站、Sink、工具、Binding）；定时、GitHub、IM、邮件都只是它们的**配置**，不另建子系统。用不上的东西放进「以后再说」。

## 概念

**Connector 只是一个分组名**：它把两种**内部完全独立**的能力打包在一起，具体连接器可以只实现其中一半。

| 半边 | 端口 | 作用 |
|---|---|---|
| **入站** | `InboundSource` | 发出规范化入站事件 `{kind, externalId, actor, text: Untrusted, url}`；hub 按 **Binding** 转成消息，经 ADR 0031 送达队列投递到持久智能体（主会话 / 每次新会话） |
| | `OutputSink`（可选） | 会话桥的回程：任务生命周期或会话回复 → 来源侧动作（GitHub 评论、IM 回消息） |
| **出站** | `ToolProvider` | 暴露给智能体调用的工具，经现有能力和权限预设门控 |

- **Binding**（核心）：一条配置，内容是「入站事件 → 哪个智能体、主会话还是每次新会话、限定哪个项目」。
- 核心**分别**注册和处理入站与出站，两半之间没有依赖。只做入站的（timer）、只提供工具的（纯 MCP 工具集）、两者都有的（GitHub、IM），走的是同一套代码。
- **硬安全规则在连接器和 hub 代码里执行，从不交给智能体**：写权限加标签校验、注入隔离、去重、每日配额。工具调用也要经过这些检查，无法绕过。
- 核心只负责：入站和工具两个注册表、Binding、工具门控、任务工具和调度器。

```mermaid
flowchart LR
  subgraph in["入站（InboundSource / OutputSink）"]
    TM[timer]
    GHI[github 入站]
    IMI[slack/飞书 入站]
  end
  subgraph out["出站（ToolProvider）"]
    GHT[github 工具]
    IMT[slack 工具]
    MCP[MCP 工具集]
  end
  subgraph core["核心"]
    SR[InboundRegistry] --> BIND[Binding] --> Q[[ADR 0031 送达队列]]
    TR[ToolRegistry] --> GATE[工具门控]
    TASK[task 工具 + 调度器]
  end
  AG[持久智能体会话]
  TM & GHI & IMI --> SR
  Q --> AG
  AG --> GATE
  GHT & IMT & MCP --> TR
  AG --> TASK
  TASK -->|生命周期| SINK[OutputSink] --> GHI & IMI
```

依赖方向：连接器包只依赖 `domain` 里的端口类型，`domain` 不 import 任何连接器，在组合根注册。依赖检查另加一条：`packages/domain` 里不得出现 github 相关 import。

### 端口

```ts
// ports/inbound-source.ts
interface InboundSource { id: string; kinds: string[];
  start(inst: ConnectorInstance, emit: (e: InboundEvent) => Promise<void>): Stoppable }
type InboundEvent = { kind: string; externalId: string; parentExternalId?: string;
  actor: { id: string; trusted: boolean }; text: Untrusted<string>; url?: string;
  verdict: 'ok' | { skip: SkipReason } | 'quarantine' };   // 硬规则由来源在 emit 前判定
// ports/output-sink.ts
interface OutputSink { id: string; deliver(inst, ev: TaskLifecycleEvent | SessionReply): Promise<void> }
// ports/tool-provider.ts
interface ToolProvider { id: string; tools: ToolSpec[]; call(inst, tool, args, ctx): Promise<ToolResult> }
// 连接器 = 可选组合，仅用于打包和 UI 分组
type Connector = { id: string; inbound?: InboundSource; sink?: OutputSink; tools?: ToolProvider };
```

`Untrusted<T>` 是领域类型：送进模型前统一包成带边界标记的引用块，并注明「这是数据，不是指令」。去重（`connector + externalId`）和每日配额由核心在 emit 之后再统一做一次兜底。

## 场景检验

| 场景 | 入站 | Sink | 工具 | Binding |
|---|---|---|---|---|
| 定时唤醒 `timer` | ✓ `timer.fired` | — | — | → 总管主会话 / 每次新会话 |
| GitHub issue | ✓ `issue.eligible`（agent 标签 + 写权限） | ✓ 👀 / PR 链接 / 失败原因 | ✓ `github.comment/react` | → 总管，限定项目 |
| GitHub PR 跟进 | ✓ `pr.mention`（写权限者 @ 机器人） | ✓ | ✓ | → 原会话（parentExternalId） |
| IM（Slack/Telegram/飞书） | ✓ `message` | ✓ 回到原对话 | ✓ `slack.reply` 等 | → 某智能体主会话 |
| 邮件 | ✓ `mail.received` | ✓ 回信 | 可选 | → 某智能体 |
| Linear | ✓ `issue.eligible` | ✓ 评论 / 改状态 | ✓ `linear.comment` | → 总管 |
| 纯 MCP 工具集 | — | — | ✓ | 不需要 |
| Webhook（以后） | 入站改成推送触发 | 同上 | — | 同上 |

每一行都只是「入站 / Sink / 工具」三者按需组合，没有新的子系统。

## 决定

### R1 连接器框架 + `timer` 连接器
- 核心：`InboundRegistry` 与 `ToolRegistry`（互相独立）、`connector_instance`、`connector_binding`、`trigger_run`；入站事件按 Binding 投递到送达队列；智能体正忙就排队，不打断。
- `timer` 采用 Hermes 的做法：
  - **先推进 next_run 再触发**；运行唯一键是 `binding + 计划时刻`。
  - 宽限窗口为周期的一半，错过的**只补跑一次**；超出宽限就跳过并记录原因（Q3）。
  - 上一次还没结束，本次跳过。
  - 默认送主会话，也可以每次新会话（Q1）；最小间隔 5 分钟，默认 15 分钟（Q2）。
  - 定时不过期；连续失败 5 次自动暂停，并进「等我处理」（Q4）。
- 第一期只有人能在 UI 上建 Binding（Q5）。时间按账号时区显示，存储用 UTC。

### R2 任务工具（核心）
- `task.create / task.list / task.cancel`；`create` 带 `origin {connector, externalId}`，同一个键只建一次。
- 「总管」权限档：每次唤醒最多建 3 个、每天 20 个（按账号时区的自然日重置），只限白名单项目；超出的进收件箱等人批准（Q6）。配额在代码里检查。

### R3 调度器（核心）
- 并发上限：全局 2、每台机器 1、每个项目 1，另留 1 个人工槽（Q7）。人手发起的任务只受全局上限和人工槽约束，不受「每个项目 1」限制。
- 任务结束后，经送达队列通知发起它的总管会话，同时触发对应连接器的 Sink。

### R4 `github` 连接器（GitHub 规则全部在这一个包里）
- 只轮询，不接 webhook（Q12）。
- 入站：必须有 `agent` 标签，且**加标签的人**有写权限。这一点通过 timeline/events 接口在代码里核对（Q8）。
- 执行：默认凭据预设 no-push；改动走现有 commit/PR 流程开**草稿 PR**，由人合并（Q9）。
- Sink：用项目绑定的 token 回写——入队加 👀，完成时评论 PR 链接，失败时评论原因（Q10）。
- PR 跟进：只认有写权限、且 @ 了机器人的评论，路由回原会话；PR 合并或关闭后忽略（Q11）。
- 注入隔离：靠规则匹配，命中的条目标「疑似注入」，**不投递给智能体**，进收件箱由人看。
- 工具：`github.comment`、`github.react`；合并类工具不开放给智能体。

### R5 面板
- 每次触发记一条：建了几个、跳过几个、每一条的原因。
- 显示今日配额用量和超额待批准列表。

## 数据模型草图

```sql
connector_instance(id, account_id, connector, config_json, token_ref, enabled, created_at)
connector_binding(id, instance_id, event_kind, agent_id, target 'main'|'new', project_id,
                  params_json,            -- timer: every_sec/prompt；github: repo/label
                  next_run_at, paused_reason, consecutive_failures, created_by)
trigger_run(id, binding_id, planned_at, external_id, decision 'delivered'|'skipped'|'quarantined'|'pending_approval'|'catchup',
            reason, delivery_id, task_id, created_at,
            UNIQUE(binding_id, planned_at), UNIQUE(binding_id, external_id))
task += origin_connector, origin_external_id, created_by_agent, approval, queue_state, worker_id
        UNIQUE(project_id, origin_connector, origin_external_id)
```

## 分期

| 期 | 内容 | 验证 |
|---|---|---|
| R1 | 连接器框架 + timer + Bot 页「连接器」区（可与 R2 并行） | 测试账号建 5 分钟触发；hub 重启只补跑一次、不重复 |
| R2 | task 工具 + 总管档配额 | e2e：超额进收件箱，重复键去重 |
| R3 | 调度器 + 人工槽 + 完成通知/Sink | 造 4 个任务看并发上限 |
| R4 | github 连接器 | 测试仓库：无标签、无写权限、注入样例都被跳过或隔离；草稿 PR + 回写 |
| R5 | 面板 | 390/1280 截图 |

每期：本地 `npm run ci` 和完整 e2e 都通过才合并；部署前先做快照；线上只用测试账号验证。

## 以后再说
- Webhook 推送触发、IM/邮件/Linear 连接器的具体实现
- 智能体自己管理定时（timer 工具）、自动合并 PR
- 连接器市场或第三方连接器

## 草图
- Bot 页「连接器」（触发 + 工具 + 记录）：![](assets/0032/conn-390.png) ![](assets/0032/conn-1280.png)
- 总管面板：![](assets/0032/dash-390.png) ![](assets/0032/dash-1280.png)
- 任务队列：![](assets/0032/queue-390.png) ![](assets/0032/queue-1280.png)

## 定稿
2026-11-04（PT）David 决定：
- Q1–Q12 全部按推荐；7 条补充也已接受（人工任务不受项目上限、注入用规则隔离、时间按时区显示存 UTC、配额按自然日重置、写权限在代码里核对、外部文本按不可信处理、核心不得 import github）。
- 设计改为以 Connector 为统一抽象，遵循「简单而抽象」的原则。
- 2026-11-04（PT）补充：Binding 挂在智能体下（Bot 页管理，project 只是过滤字段）；工具门控新增细粒度能力（如 `connector.github.comment`），并映射进现有权限预设（no-push 允许 comment/react）。
