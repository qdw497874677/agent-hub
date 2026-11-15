# ADR 0036：渠道 / 目标 / 投递内核，Actor 与容器会话

- 状态：accepted（2026-11-15，随 #221 分步落地）
- 相关：ADR 0018（群聊常驻会话）、ADR 0031（送达队列与来历）、ADR 0032（连接器与总管）
- 来源：#219 设计评审、#221 重构路线

## 问题

同一件事——「把一段文本投给某个会话，等它这一轮结束，再决定下一步」——在仓库里有五份实现：

| 投递方 | 占用判断 | 回合收尾 |
|---|---|---|
| 私聊送达（ADR 0031） | `message_delivery.pendingFor` | `turnEnded` |
| 群聊（ADR 0018） | `agent_group_deliveries.deliveredTo` | `turnEnded` + 主持人/成员超时清扫 |
| 连接器（ADR 0032） | `trigger_run` 的 `openRuns(bindingId)` | `turnEnded` + `sweepStale` |
| 调度器 | `task_dispatch` | `sessionEnded` |
| 通知/编排 | 各自判断 | 各自收尾 |

五份实现各自长出了「忙就跳过 / 忙就排队 / 超时怎么办 / 失败算谁的」的不同答案。连接器那套还额外把「占用」判在 binding 上，一个 bot 绑多个频道时会互相饿死；推送型来源（webhook）遇到占用直接丢弃，永久丢消息。

同时，身份推导也有六处各写一遍：群成员按名字反查 bot、连接器用 `binding.createdBy`、git 工具按 `session.createdBy`、调度用 `task.ownerId`……任一处的偏差都会变成权限放大。

## 决策

### 1. 三层：渠道 / 目标 / 投递内核

- **渠道（Channel）**：一个外部系统怎么连进来、怎么发出去（Slack、飞书、GitHub、邮件）。渠道只懂协议与平台语义，不懂「谁有权」。
- **目标（Target）**：一条绑定指向哪儿，`{ kind: 'session', mode: 'main' | 'new' } | { kind: 'group', groupId }`。目标决定「投到哪里」，不决定「怎么投」。
- **投递内核（Delivery Kernel）**：`SessionInbox`（占用判断 + 回合收尾，一个会话同一时刻只有一轮）与 `Outbox`（出站队列：租约、重试、回声去重）。

三张表**不合并**（`message_delivery`、`agent_group_deliveries`、`trigger_run` 各有自己的状态与语义），合并的是**判断逻辑**：一个会话是否被占用、这一轮结束时谁该收尾，只由 `SessionInbox` 回答。

### 2. 入站语义按来源区分，不能一律「跳过」

`InboundSource.delivery: 'poll' | 'push'`：

- `poll`（缺省）：来源自己按周期取，忙时这一拍不取即可，不会丢东西。
- `push`：外部主动推来，丢掉就永久丢。忙时必须排队成 `waiting`，由回合结束的收尾接着投；同一 `externalId` 仍需去重。

基础设施中断（网络、5xx、限流）照实记进 run，但**不计入** `consecutiveFailures`，否则一次平台故障会把所有触发自动暂停。

### 3. 出站只走出站队列

回复原会话不提供 `slack.reply` 之类工具。会话的回复（任务生命周期、群帖回程）写 `channel_outbox`，由 pump 按租约投递：失败退避重试、永久失败落 `failed`、回声按「平台身份 → 外部消息 id → 正文指纹」三层去重。

### 4. Actor：授权身份冻结在授权里

`ToolGrant.actor = { userId, via }` 在发授权时写入（`via: 'web' | 'group' | 'bot' | 'connector' | 'dispatch' | 'tool'`）。工具调用按冻结的 actor 实时求权限；读不到（旧授权）才回落到按会话推导。不允许每处各写一套「这条会话算谁」。

外部消息以**绑定授权人**的身份执行（用户决定），先加白名单与限流，账号映射以后再说。

### 5. 容器会话：会话可以不属于任务

`Session.taskId` 允许为空。群角色与 bot 会话是**容器**（长期存在、随配置生灭），不是工作项：不再合成假任务。任务页、配额、调度与 `task.*` 工具只认真实任务；`isContainerSession()` 是唯一判据。

理由：任务是有终态、可结算、带分支与 PR 记录的工作；容器没有「完成」，唯一性也不同（`(groupId, role)` 一对一）。给任务加 `kind='container'` 会把两种生命周期塞进一张表，所有统计与删除语义都要分叉。

## 后果

- 新增 `packages/domain/src/session-inbox.ts`、`channel-outbox.ts`、`docs/design/channel-convergence.md`。
- 迁移：`sessions.task_id` 置为可空、`sessions.bot_id`、`tool_grants.actor`、`trigger_run` 外部会话列、`channel_conversation`、`channel_outbox`。均为幂等加列/建表。
- 旧的假任务需要一次迁移：按「群/bot 容器的合成任务」识别并删除（或标记后删除），关联会话的 `task_id` 置空。
- 接线阶段：`apps/server/src/main.ts` 用 `SessionInbox` 统一 `occupied` 与 `turnFinished`；出站 pump 在 hub 启动时拉起。
- 遗留：`Workspace`（目录义）→ `WorkDir`、ADR 0031 `Delivery` → `PromptDelivery`、`AgentDescriptor` → `RuntimeDescriptor` 先加别名，不改行为。
