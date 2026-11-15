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
}
```

存储沿用 `connector_binding` 表：`target` 列保留旧语义（`main|new`），新增 `target_kind`、`group_id`。默认目标只放在 binding 上，**外部会话到目标的映射只放 `channel_conversation`**——两处都写会在更新时分叉。

读路径（`packages/storage-sqlite/src/connectors.ts:6-15`）必须**先看 `target_kind`，为空才回落 `target`**。现状是 `target === 'new' ? 'new' : 'main'`（`:30`），任何非 `new` 的值（包括 `group`）都会被压成 `main`，照文档「读不到就回落」实现会让群 binding 被 `sessionFor`（`:66-74`）当私聊去开会话。

写路径同样危险：`saveBinding` 是整行 `INSERT OR REPLACE`（`:38-39,50`），列清单不含新列；`fail`（`:58`）、`sessionFor`（`:73`）、`update`（`:229`）每次成功/失败都会整行替换。C1 必须同时把这些写入改成带新列的 upsert，或改成 `UPDATE` 只动变更列，否则 `target_kind`/`group_id` 会在第一次 tick 后变 NULL。

DTO 兼容（`packages/contract/src/messaging.ts:93-96,120-124`）：`target` 字段保留 `'main' | 'new'`，群 binding 填 `'main'`（只为旧前端不崩），新增可选 `targetKind?: 'session' | 'group'` 与 `groupId?: string`。`bot-routes.ts:90` 原样透传，旧前端 `bot-connectors.tsx:159` 会把群显示成「主会话」——可接受但不理想，前端在同一版里读新字段。

### 3.2 会话映射：`channel_conversation`

```sql
CREATE TABLE channel_conversation (
  binding_id TEXT NOT NULL,
  external_conversation_id TEXT NOT NULL,   -- slack channel / feishu chat / github repo#issue
  external_thread_id TEXT,                  -- thread / reply chain，可空
  thread_key TEXT NOT NULL DEFAULT '',      -- 归一化后的 external_thread_id（空串）
  target_kind TEXT NOT NULL,                -- 'session' | 'group'
  session_id TEXT,                          -- target_kind='session'
  group_id TEXT,                            -- target_kind='group'
  last_inbound_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- SQLite 不允许表达式出现在主键里（COALESCE(...) 会直接建表失败），所以单列存储 thread_key
  PRIMARY KEY (binding_id, external_conversation_id, thread_key)
);
```

- **键语义**：一个外部会话在一个 binding 下**只能映射到一种目标**。同一 Slack 频道既私聊又进群时，第二次写入冲突（返回 409 提示「这个会话已经绑到群 X」），v1 不支持一分为二。
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

IM 的 `externalId` = 平台消息 id；`author` 只用于展示与审计，**开会话的身份仍用 `binding.createdBy`**（群侧 `actorOf` 只认 user 根帖，`use-cases/groups.ts:334-336`）。

**群目标不经过 `attempt`/`turnEnded`。** 现在 `openRuns` 把 `waiting|delivered` 当占用（`use-cases/connectors.ts:125-131`、`storage-sqlite/src/connectors.ts:80`），`turnEnded` 只按 `session_id` 收口（`:177-186`）。若群消息先走 `attempt` 标 `delivered`，群会话的回合结束不一定对应这条 run，binding 会一直留 open run，后续无 `plannedAt` 的入站会被 `emit` 静默丢掉（`:117-133`），同一 binding 上的 timer/github 也会被堵。正确路径：插入 run 时直接写 `done`，落帖后回填 `post_id`，`openRuns` 不把群目标算占用。`serial(groupId)`（`use-cases/groups.ts:152-167`）管的是群内顺序，与 `openRuns` 不是同一把锁，不能互相替代。

**外部帖走 `postExternal`，不走 `post(actor)`。** `actorOf`（`:334-336`）非 user 根帖返回 null，`schedule` 直接 `return 0`（`:350-351`）；`post`（`:728-729`）还会在人发言时清 `held`/`needsUser`。`postExternal` 使用作者 kind `'external'`（`PostAuthor` 在 `packages/domain/src/groups.ts:66-69`，目前只有 user/agent/system），principal 取 `binding.createdBy`，并在每次投递前重新校验「binding 仍 enabled 且 createdBy 对该群仍有 `group.post`」——失败就暂停 binding，而不是用过期 principal 继续发。外部作者不能伪装成 `user`，否则未读（`storage-sqlite/src/groups.ts:97-98`，只认 `author.kind === 'user'` 且 id 相等）会吞掉创建者的未读、`@all` 的语义也会被外部消息污染。

**`@all` 在入站规范化阶段就拒绝/删除**（`@everyone` 同理），不能指望引用块：`formatInbound`（`packages/domain/src/connector.ts:79-83`）把外部文本包成引用块，`parseMentions` 的 `stripQuoted`（`packages/domain/src/groups.ts:202-209`）碰巧挡住；但 `postExternal` 若把原文当正文，`parseMentions` 会把 `members` 设成全体（`:232`）。

### 3.4 出站：`channel_outbox`（新增）

现在的 `OutputSink` 是 best-effort：失败只打日志（`packages/connector-github/src/sink.ts:35`）。IM 不能这样——发不出去要重试、要能看见。

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

- 群帖落库 / 私聊回合结束 **与 outbox 行在同一事务里写**（`INSERT` 帖 + `INSERT ... status='queued'`）：先落帖后写 outbox 会在崩溃窗口丢出站，先写 outbox 后落帖会发出不存在的帖。群帖表目前只是 `INSERT`（`storage-sqlite/src/groups.ts:79`），没有出站标记，必须靠事务把两者绑在一起；
- worker 每 10–30 秒扫 `queued` 且到点的一批，调 channel 的 `send`，成功写 `external_message_id`（回声去重用），失败按指数退避，超过 N 次标 `failed` 并进「等我处理」；重放只扫 `queued`，已 `sent` 的不重发；
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

**C1 拆渠道与目标（建议先做，范围只到存储与类型）**：`BindingTarget` union + `channel_conversation` + `InboundEvent` 扩字段 + `toB`/`saveBinding` 读改成「先 `target_kind` 再回落」并让整行替换带上新列。此时**不接任何群行为**，只保证数据模型能无损表达群目标——C2/C3/C4 都依赖这一步的键和读写正确，三处里任一处按旧写法落地，后面每步都会在错误数据上继续写。验收：旧 binding 全量回归；手工插入群 binding 后读写往返不丢字段；DTO 的 `target` 仍只出 `main|new`。

**C2 出站 outbox**：先把 github sink 迁到 outbox（同样的 PR 评论，失败可重试），再加一个假渠道包用于测试。验收：断网重试、回声 id 不重复回帖。

**C3 群目标**：`target: {kind:'group'}` + 外部作者 `PostAuthor.external` + 外部帖落库即 `run.done`。验收：外部消息 → 群帖 → 主持人分派 → 成员回复；同一消息重投 3 次只有 1 帖；`@all` 默认拒绝。

**C4 DM 渠道**：一个真实渠道（Slack 或飞书，二选一）的 `InboundSource` + `ChannelSink`；外部 DM → 常驻会话 → 回复回 outbox。验收：端到端一问一答，线程内连续对话不串。

**C5 观测与运营**：observe 增加 `channel` reader（会话维度：最后入站、卡住的 outbox、失败原因）；群设置页显示「外部渠道」；bot 触发器页的目标选择器支持「群 / 私聊 / 新会话」。

## 6. 不做什么

- 不把群消息变成 `InboundEvent` 再走 `connector hub`（扇出与轮次不匹配，binding 会被稀释成队列）；
- 不给「群 × 成员」建 binding；
- 不让群调度器认识渠道 / webhook / 平台 id；
- 不在 v1 合并 `trigger_run`、`agent_group_deliveries`、`agent_messages` 三张表（先共用代码，不共用存储）；
- 不做附件、编辑/撤回、跨频道广播。**编辑后的消息按「同 id 丢弃」处理**：`UNIQUE(binding_id, external_id)` 会把同 id 的再次投递挡掉，不要为了「修改可见」把 `externalId` 拼上编辑版本号——那会把去重打穿。

## 7. 风险

- **身份与权限**：外部作者不是 User，不能触发 `needsUser`；不能用 `post(actor)` 的路径；`@all`/`@everyone` 在入站规范化阶段拒绝（不能依赖引用块碰巧挡住）。
- **回声与编辑**：平台回推自己消息的 id 未必稳定；outbox 存 `external_message_id`，入站时先查它，再加「binding + conversation + 正文指纹」短 TTL 去重；同 id 的编辑按丢弃处理。
- **限流**：入站配额（webhook 风暴）与出站配额（成员回复扇出）分开算——`HOST_PER_MINUTE`（`packages/domain/src/groups.ts:28`，限流在 `use-cases/groups.ts:768-771`）只约束「不带 @ 的入站交给主持人」，不是出站配额。
- **生命周期**：群删除 / bot 被移出群 / 渠道凭据失效 / `createdBy` 失去 `group.post` → binding 立即暂停（不等连续失败 5 次）；恢复后手动启用。
