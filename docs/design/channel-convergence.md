# 外部 IM 与连接器的收敛：渠道、目标、投递内核

状态：设计草案（未实现）。回答的问题：**外部 IM 聊天和连接器怎么把逻辑收敛起来，群聊能复用多少。**

相关：`docs/design/group-delivery-kernel.md`（投递内核，本文的 C0）。

## 1. 现在的错位

连接器（ADR 0032）把三件事焊在一个 `ConnectorBinding` 上：

1. **渠道**：用哪个外部系统、什么凭据、怎么轮询 / 收 webhook（`connector` + `params` + `timeZone`）；
2. **目标**：投给谁（`target: 'main' | 'new'`，`packages/domain/src/connector.ts:38`）；
3. **智能体**：以哪个 bot 的名义（`agentProjectId` + `agentName`）。

这三件事在 timer / github issue 上是重合的（一个 bot 盯一个仓库），但在 IM 上不重合：

- 一个 Slack workspace 有几十个频道，一个 bot 要在多个会话里说话；
- 同一个频道里，消息可能是「找某个 bot 私聊」，也可能是「扔进一个多 agent 的群」；
- 同一段对话有 thread / reply 结构，不是「一条事件开一个任务」。

所以 IM 接不进来的根因不是缺能力，而是 **binding 把「渠道」和「目标」绑死了**。收敛的第一步是把这两层拆开。

## 2. 目标形态：三层

```
外部世界                     hub 内部
─────────                   ────────────────────────────────
channel (slack/feishu/      Channel 端口：normalize / send
  github/timer)                  │
                                 ▼
conversation + thread  ──►  channel_conversation 映射
  + message(author,text)         │
                                 ├── target=session  → 私聊：pump 投进常驻会话
                                 └── target=group    → 群聊：postExternal 进群，
                                                        群调度器接管（轮次/分派/竞价）
```

**关键判断：IM 消息和连接器事件是同一种东西——「外部来的、不可信的、带 id 的一段话」；不同的只有目标。** 群聊不是被连接器驱动，而是连接器可以把「群」当成一种投递目标。群的轮次与分派留在群里，不进入连接器。

## 3. 数据模型

### 3.1 `ConnectorBinding` → `ChannelBinding`

```ts
export type BindingTarget =
  | { readonly kind: 'session'; readonly mode: 'main' | 'new' }   // 私聊 / 新会话
  | { readonly kind: 'group'; readonly groupId: string };          // 群

export interface ChannelBinding {
  // 不变：id, connector, kind, agentProjectId, agentName, projectId, name, enabled,
  //       pausedReason, consecutiveFailures, params, timeZone, createdBy, mainSessionId
  readonly target: BindingTarget;
  /** 外部会话 id（channel 侧）→ 目标。为空时按 target 的默认值（main 会话 / 指定群）。 */
  readonly conversation?: string | null;
}
```

存储沿用 `connector_binding` 表：`target` 列保留旧语义（`main|new`），新增 `target_kind`、`group_id`、`conversation`。`toB` 先读新列，读不到回落旧值（`packages/storage-sqlite/src/connectors.ts:6-15,30`）。DTO 只加可选字段，旧前端不受影响（`packages/contract/src/messaging.ts:94,121`）。

### 3.2 会话映射：`channel_conversation`

```sql
CREATE TABLE channel_conversation (
  binding_id TEXT NOT NULL,
  external_conversation_id TEXT NOT NULL,   -- slack channel / feishu chat / github repo#issue
  external_thread_id TEXT,                  -- thread / reply chain，可空
  target_kind TEXT NOT NULL,                -- 'session' | 'group'
  session_id TEXT,                          -- target_kind='session'
  group_id TEXT,                            -- target_kind='group'
  last_inbound_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (binding_id, external_conversation_id, COALESCE(external_thread_id, ''))
);
```

- **DM**：一条外部会话 → 一条常驻会话（懒创建，等价于今天的 `main`）；`session_id` 写回。
- **群**：一条外部会话 → 一个群（binding 创建时指定；或按频道 id 自动建群，v1 只支持指定）。
- **thread**：IM 的 thread 映射成群里的 `GroupThread`（群侧已有 `threadId`），私聊侧映射成 `AgentMessage.traceId`／`replyTo`，不新造概念。

### 3.3 入站记录：`trigger_run` 扩展

`trigger_run` 已有 `UNIQUE(binding_id, external_id)`（`packages/storage-sqlite/src/connectors.ts:14-18`），补三列即可承载 IM：

```sql
ALTER TABLE trigger_run ADD COLUMN external_conversation_id TEXT;
ALTER TABLE trigger_run ADD COLUMN external_thread_id TEXT;
ALTER TABLE trigger_run ADD COLUMN post_id TEXT;      -- 群帖 id / 会话消息 id
```

`InboundEvent` 扩字段（`packages/domain/src/connector.ts`）：

```ts
export interface InboundEvent {
  // 已有：kind, externalId, title, text(untrusted), url, note, targetSessionId...
  readonly conversationId?: string;
  readonly threadId?: string;
  readonly author?: { readonly id: string; readonly name: string };
  readonly replyToId?: string;
}
```

IM 的 `externalId` = 平台消息 id；`author` 只用于展示与审计，**开会话的身份仍用 `binding.createdBy`**（群侧 `actorOf` 只认 user 根帖，`groups.ts:334-341`）。

### 3.4 出站：`channel_outbox`（新增）

现在的 `OutputSink` 是 best-effort：失败只打日志（`packages/connector-github/src/sink.ts:33`）。IM 不能这样——发不出去要重试、要能看见。

```sql
CREATE TABLE channel_outbox (
  id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL,
  external_conversation_id TEXT NOT NULL,
  external_thread_id TEXT,
  source_kind TEXT NOT NULL,        -- 'group_post' | 'session_turn' | 'task'
  source_id TEXT NOT NULL,          -- postId / sessionId / taskId
  body TEXT NOT NULL,
  status TEXT NOT NULL,             -- queued | sent | failed | dropped
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error TEXT,
  external_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- 群帖落库、私聊回合结束 → 写一行 outbox（同一事务外，失败可重放）；
- worker 每 10–30 秒扫 `queued` 且到点的一批，调 channel 的 `send`，成功写 `external_message_id`（回声去重用），失败按指数退避，超过 N 次标 `failed` 并进「等我处理」；
- 现有 `OutputSink` 保留为「任务生命周期 → outbox 行」的适配器，github 的 PR 评论改成 outbox 的一个 writer，行为不变但获得重试。

## 4. 复用关系（谁复用谁）

| 能力 | 提供者 | 群聊 | 私聊 | 外部 IM |
| --- | --- | --- | --- | --- |
| 投递状态机（队列/忙等/先标后投/超时） | 投递内核（C0） | ✓ | ✓ | ✓（DM 目标） |
| 会话级串行 | `SessionLane`（`main.ts:280`） | ✓ | ✓ | ✓（与私聊共用） |
| 群级串行 | `serial(groupId)`（`groups.ts:152`） | ✓ | — | 通过群调度器 |
| 入站规范化 / 去重 / 重试 / 暂停 | 连接器（扩展） | 外部消息入口 | 外部消息入口 | ✓ |
| 轮次 / 分派 / 竞价 / `[SILENT]` | 群聊 | ✓ | — | 只作为目标被动接收 |
| thread / reply 关联 | `AgentMessage`（`traceId/replyTo/depth`） | `GroupThread` | ✓ | 映射到两者 |
| 出站重试 / 回声去重 | 新 outbox | 复用 | 复用 | ✓ |

一句话：**群聊复用「投递 + 串行 + 出站」，不碰连接器的 binding 模型；连接器复用「会话投递」与「群」作为目标；外部 IM 只是连接器的一种渠道实现。**

## 5. 分步落地（每步独立可发布）

**C0 投递内核**（见 `group-delivery-kernel.md`）：纯函数 + 泵，群聊 / 私聊 / 连接器三处接线。先做，因为后面每一步都靠它。

**C1 拆渠道与目标**：`BindingTarget` union + `channel_conversation` + `InboundEvent` 扩字段；timer/github 行为不变（`target` 仍是 session）。验收：旧 binding 全量回归，`connectors.test.ts` 不改断言。

**C2 出站 outbox**：先把 github sink 迁到 outbox（同样的 PR 评论，失败可重试），再加一个假渠道包用于测试。验收：断网重试、回声 id 不重复回帖。

**C3 群目标**：`target: {kind:'group'}` + 外部作者 `PostAuthor.external` + 外部帖落库即 `run.done`。验收：外部消息 → 群帖 → 主持人分派 → 成员回复；同一消息重投 3 次只有 1 帖；`@all` 默认拒绝。

**C4 DM 渠道**：一个真实渠道（Slack 或飞书，二选一）的 `InboundSource` + `ChannelSink`；外部 DM → 常驻会话 → 回复回 outbox。验收：端到端一问一答，线程内连续对话不串。

**C5 观测与运营**：observe 增加 `channel` reader（会话维度：最后入站、卡住的 outbox、失败原因）；群设置页显示「外部渠道」；bot 触发器页的目标选择器支持「群 / 私聊 / 新会话」。

## 6. 不做什么

- 不把群消息变成 `InboundEvent` 再走 `connector hub`（扇出与轮次不匹配，binding 会被稀释成队列）；
- 不给「群 × 成员」建 binding；
- 不让群调度器认识渠道 / webhook / 平台 id；
- 不在 v1 合并 `trigger_run`、`agent_group_deliveries`、`agent_messages` 三张表（先共用代码，不共用存储）；
- 不做附件、编辑/撤回、跨频道广播；外部消息「改过会再投一次」写在文档里。

## 7. 风险

- **身份与权限**：外部作者不是 User，不能触发 `needsUser`；外部文本里的 `@all` 必须在解析前拒绝（`parseMentions` 先剥引用块，`groups.ts:223-241`）。
- **回声**：平台回推自己的消息 id 未必稳定；outbox 存 `external_message_id` 做尽力去重，改过的消息不保证。
- **限流**：每个 binding 的入站与出站都要有配额（群侧 `HOST_PER_MINUTE` 已有，`groups.ts:768-771`），否则 webhook 风暴会把群的分派配额打满。
- **生命周期**：群删除 / bot 被移出群 / 渠道凭据失效 → binding 立即暂停（不等连续失败 5 次）；恢复后手动启用。
