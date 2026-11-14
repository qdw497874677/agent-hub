# 群聊接入外部渠道：复用连接器的入站 / 回程端口

状态：设计草案 v2（未实现；v1 经 oracle 审查后修正）。目标是回答「群聊能不能一定程度复用连接器机制」，并给出真要做时的最小改动。

## 0. 结论

- **能复用的是两端**：入站的规范化与幂等（`InboundSource` / `InboundEvent` / `TriggerRun`），出站的回写（`OutputSink` 的形状）。
- **不能复用的是中间**：`ConnectorBinding` 的「一个 bot + 一条目标会话」与群聊的「多角色 × 轮 × 分派 / 竞价 / @ 直达 / 静默 / 停止」不是同一种调度。把群塞进 `Binding.params` 会让 connector hub 认识「群」，等于把 ADR 0018 的调度器降级成一个开关。
- **落地顺序**：先做 G1（外部事件投进一个指定群，含身份、幂等、失败语义），并且**先用现有 GitHub PR 评论做验证**；`GroupSink` 与新映射表都推到第二个渠道出现时再说。

## 1. 现状（代码事实，v2 已核对）

| | 连接器（ADR 0032） | 群聊（ADR 0018） |
| --- | --- | --- |
| 端口 | `packages/domain/src/ports/inbound-source.ts`、`ports/output-sink.ts` | 无（直接调 `groupChat`） |
| 入口 | `InboundEvent` → `TriggerRun` → `attempt` → 派生 / 复用会话 | 用户发帖 → `GroupThread` → `schedule` → `GroupDelivery` |
| 目标 | `ConnectorBinding.target: 'main' \| 'new'`（`packages/domain/src/connector.ts:38`，存储 `connector_binding.target TEXT`，读回时 `r.target === 'new' ? 'new' : 'main'`，`packages/storage-sqlite/src/connectors.ts:6-15,30`） | 群 × 角色一条常驻会话（`apps/server/src/main.ts:306` 的 `groups`、`:311` 的 `spawn`） |
| 投递 | `attempt`：`deliver` 前先写 `delivered`，`turnEnded` 靠 `deliveredRunFor(sessionId)` 收口（`use-cases/connectors.ts:79-99,177-185`） | `pumpSession`（`use-cases/groups.ts:399`）→ `deps.deliver`（`main.ts:310`） |
| 幂等 | `emit` 先看 `openRuns`；去重靠 `trigger_run` 的 `UNIQUE(binding_id, external_id)` + `INSERT OR IGNORE`；`hasRun` 只给 `InboundContext.seen` 用（`connectors.ts:117-133,147`） | 无外部幂等概念 |
| 失败处理 | 连续 5 次失败自动暂停（`connector.ts:72`） | host 投递失败 → `end(...,'fallback')`；成员失败 → `closeRound`（`groups.ts:426-432`） |
| 不可信文本 | `formatInbound` 在 **emit 时**就把正文包成引用块写进 `TriggerRun.text`（`connector.ts:79-83`，`connectors.ts:123`） | 无（成员都是自己人） |
| 观测 | `apps/server/src/observe-connector.ts`：`connectorGap` 只看失败 / 超时 / 注入 / 轮询失败 / 待批准，条目 `connector:${run.id}` | 群视图轮询 + SSE 帧 |

群聊还有一个**必须处理的前提**：`actorOf` 只在根帖 `author.kind === 'user'` 时才取到 principal，否则 `schedule` 直接 `return 0`（`use-cases/groups.ts:334-351`）。外部作者发的根帖会建 thread，但不会 `ensureSession`。

## 2. 语义差异（哪些不能借）

1. **一对多 vs 一对一**：一条外部消息在群里可能被主持人分派给 N 个成员、开 M 轮；连接器一条事件只对应一条运行记录。
2. **目标会话的归属**：连接器按 bot 的 `main / new` 建会话；群成员会话按「群 × 角色」常驻，跨消息复用，还可能被私聊和群聊共用。
3. **回合结束的含义**：连接器的 `delivered → done/failed` 由回合结束决定；群聊的回合结束只是 `settle` 一个投递，还要 `closeRound` 决定是否开下一轮。**所以群目标的 run 必须在帖子落库时就收口，不能等 `turnEnded`**，否则 `openRuns` 会永久挡住下一条无 `plannedAt` 的事件。
4. **身份**：连接器投递用 `binding.createdBy` 的名义；群帖子的作者要能表达「外部某人」，但**开会话的身份仍然只能借 `binding.createdBy`**。

## 3. 设计

### 3.1 入站目标：Binding 可以投到群

存储上**不改** `target` 列的语义（老客户端与老行都还读得懂），加两列：

```sql
ALTER TABLE connector_binding ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'session';  -- 'session' | 'group'
ALTER TABLE connector_binding ADD COLUMN group_id TEXT;                                 -- target_kind='group' 时必填
```

`toB` 把 `target_kind === 'group'` 读成 `{kind:'group', groupId}`，其余仍走原来的 `main/new`。领域类型用 union：

```ts
export type BindingTarget =
  | { readonly kind: 'session'; readonly mode: 'main' | 'new' }
  | { readonly kind: 'group'; readonly groupId: string };
```

contract 侧**不换掉** `BindingDto.target`（`packages/contract/src/messaging.ts:94,121`），而是加可选字段 `targetKind?: 'session'|'group'`、`groupId?: string|null`；`apps/web/src/surfaces/im/bot-connectors.tsx:122` 写死的 `target:'main'` 与 `:159` 的 `=== 'main'` 比较要一起改。这样旧前端读新后端最多看不到「投到群」，不会把它显示成「新会话」。

群目标在 `attempt()` 里不走 `sessionFor`，直接：

```ts
const posted = await deps.postExternal({
  binding, groupId,
  externalId: event.externalId,
  author: externalAuthorOf(binding, event),
  rawText: typeof event.text === 'string' ? event.text : event.text.value,
  mentions: event.mentions ?? null          // null = 由群侧按 3.4 解析
});
if (posted.kind === 'failed') return fail(binding, run, posted.reason);
await deps.store.saveRun({ ...run, state: 'done', postId: posted.postId, updatedAt: now });
```

`postExternal` 内部首先要拿到「开会话的人」：`principalOf(binding.createdBy)`；这个 principal 只用于 `ensureSession`，**不写成帖子作者**。

### 3.2 外部作者

`PostAuthor`（`packages/domain/src/groups.ts:66-69`）加一支：

```ts
| { readonly kind: 'external'; readonly connector: string; readonly id: string; readonly name: string }
```

影响面（都要一起改）：

- contract `GroupAuthorDto`（`packages/contract/src/messaging.ts:16`）加同形状；
- 前端 `authorLabel`（`apps/web/src/surfaces/im/messages.tsx:28-31`）现在把未知都显示成「系统」，要显式分支；
- `mine` 判定只认 user（同文件 380 行），外部作者不算「我」；
- 头像色：现在 bot 用 `BotColorDto`（`apps/web/src/surfaces/im/bots.tsx:36-37`），没有 `authorHue` 以外的通用 hue，给 external 一个中性色 + 来源徽标即可；
- 反应 actor 仍是 `user|agent`（`groups.ts:88`）：外部帖**可以被反应**，但外部作者**不能**作为反应人，v1 不扩；
- `needsUser` 判定不变（外部作者不是 User，不会把人叫进群）。

### 3.3 幂等与回声：复用 `trigger_run`，不建新表

`trigger_run` 已有 `UNIQUE(binding_id, external_id)`（`packages/storage-sqlite/src/connectors.ts:14-18`）。加一列 `post_id TEXT` 即可承载双向：

- **入站**：`emit` 仍然靠 `insertRun` 抢键（`INSERT OR IGNORE`），但**抢到键 ≠ 已经发过帖**。顺序必须是「抢键 → 发帖 → 回填 `post_id` + `state='done'`」；发帖失败把 run 标 `failed`（可重试要另开一条 `externalId` 变体或在 `attempt` 里允许 `failed` 重入，v1 直接暴露成失败，别假装成功）。
- **回声**：出站成功后，用平台返回的消息 id 写一条 `external_id = <平台 id>`、`state='done'`、`post_id` 的 run。平台回推时同 id 命中唯一约束 → 丢弃，不落帖。**已知边界**：编辑后的消息 id、webhook 与轮询拿到的 id 不保证一致，v1 不做编辑/撤回，意味着「改过的外部消息会再投一次」——写在这里，不粉饰。
- 并发：同一 `externalId` 两个请求，只有 `INSERT OR IGNORE` 成功的那个继续发帖。

### 3.4 不可信文本与 @

- 包裹时机与现有连接器一致：**写入时**包成引用块（`formatInbound` 同款），存进 `GroupPost.body`；同时 `GroupPost` 加 `external?: {connector: string; externalId: string; untrusted: true}` 给渲染与审计用。
- `@` 规则：`parseMentions`（`groups.ts:223-241`）先 `stripQuoted` 再认 `@all`，没有 untrusted 开关。所以**在解析之前拒绝**：外部文本里的 `@all` / `@everyone` 默认替换成普通文本（记录一次 `external.broadcast_blocked`），要开放就靠 Binding 参数 `allowBroadcast: boolean`（默认 false）。
- 外部文本里的 `@成员` 仍可触发分派（这是接入的意义），但作者身份是 external，审计里能追到来源。

### 3.5 回程：G2 先用一个具体渠道，不建通用端口

`OutputSinkEvent` 只有任务三种（`ports/output-sink.ts:2-9`），扩它会污染 github 的任务回写——这个判断保留。但 **G1 不需要回程**；G2 先让群帖直接调 `postComment(repo, number, body)`（`packages/connector-github/src` 已有 `client.comment`），把返回的 comment id 写进上面那条 `trigger_run` 的 `external_id`。等第二个渠道出现，再抽 `GroupSink { deliver(GroupPostEvent) }`，那时接口形状已经由两个实现验证过。

### 3.6 权限、审计、生命周期

- 建 / 改「投到群」的 Binding：bot 所属项目的 `project.update`（`connectors.ts:192-194` 现在的判定）**加上**目标群的 `group.manage`；两者缺一不可，否则跨项目的人能给别人的 bot 挂群。
- 审计枚举现在没有这些动作（`packages/domain/src/account.ts:163-279`），需要新增：`connector.binding.create/update`、`group.external.in/out`、`group.external.broadcast_blocked`。只记 id、长度、来源，不记正文。
- 限流：外部入站按 binding 记每窗口条数（群侧主持人已有 `HOST_PER_MINUTE`，`groups.ts:768-771`）；超限记 `skipped` + 原因，不要让 webhook 风暴把群的分派配额打满。
- 生命周期：群被删、bot 被 `removeMember`（`groups.ts:844-856`）、或入站时发现 bot 不是成员 → 把 Binding 标 `pausedReason` 并停用（不要等连续失败 5 次）。多绑定投同一群是允许的，去重按 `(binding, externalId)`，不按群名。

### 3.7 观测

G3 才做。`connectorGap`（`apps/server/src/observe-connector.ts:71-76`）只在 run `failed`/`timeout` 时给 gap，所以「外部已投但群里没帖」必须体现为 run `failed`，而不是另拼一套 reader；群帖一侧再补一个同形状的 `group` reader（id `group:${postId}`），不改前端列表协议。

## 4. 分期

| 期 | 内容 | 退出条件（可验证） |
| --- | --- | --- |
| G1 | 3.1 群目标 + 3.2 外部作者 + 3.3 入站幂等 + 3.4 不可信与 @ + 3.6 权限/生命周期 | ① 外部 GitHub 评论投进指定群，产生 1 条外部帖、主持人分派照常（`binding.createdBy` 的 principal 能开会话）；② 同一 `externalId` 并发重投 3 次只 1 条帖；③ 外部文本里的 `@all` 默认不生效；④ 帖子落库后 run 立刻 `done`，下一条无 `plannedAt` 事件不被 `openRuns` 卡住 |
| G2 | 3.5 群帖回写 GitHub PR 评论 + 回声去重 | 群成员回复出现在 PR；自己发的评论被平台回推时不产生第二条帖 |
| G3 | 3.7 observe + 前端来源徽标 | 「等我处理」能显示「外部投进来了但群里没帖」的原因 |

## 5. 明确不做

- 不让群调度进入 connector hub；不把群帖改成 `TaskDispatch`（会强迫每条群消息都开任务）。
- v1 不做：附件/图片、编辑与撤回（因此会有「改过的消息再投一次」）、跨群广播、外部反应、飞书/Slack 接入（先用 GitHub 验证）。

## 6. 测试清单

- 外部根帖：`actorOf` 拿不到 principal 时用 `binding.createdBy` 开会话；帖子作者仍是 external。
- 幂等：并发同 `externalId` 只落一帖；「抢到键但发帖失败」不会把消息永久吃掉（run `failed` 可见）。
- 竞态：帖子已落库但回填 run 前进程崩溃 → 重启后 `openRuns` 里那条 `delivered` 仍未收口，sweep 应超时并暴露，不自动重复发帖。
- 回声：平台回推自己发的 id → 唯一约束命中，不落帖。
- `@`：untrusted 里 `@all` 被替换；`allowBroadcast` 打开后生效并写审计。
- 兼容：旧 `target` 行、旧 DTO 字段、旧前端（`=== 'main'`）都不变行为。
- 生命周期：群删除、bot 移出、bot 非成员 → binding 被暂停；恢复成员后手动启用。
