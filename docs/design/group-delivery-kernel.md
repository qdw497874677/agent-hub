# 群组消息复用连接器机制：共用「投递内核」，不是把群变成连接器

状态：设计草案（未实现）。回答的问题：**群聊消息（以及私聊转发、连接器触发）能不能共用一套投递机制？** 外部渠道（GitHub / 飞书）接进群是另一个问题，见 §8，不作为本方案的前提。

## 1. 结论

看代码会发现，「把一段话投进一条常驻会话，等这一轮结束再收口」这件事，仓库里有**三份实现**：

| | 连接器 `TriggerRun` | 群聊 `GroupDelivery` | 私聊消息 `AgentMessage` |
| --- | --- | --- | --- |
| 入队 | `emit` → `insertRun`（`use-cases/connectors.ts:117-133`） | `schedule` → `saveDelivery` | `send` → `save(status:'queued')` |
| 泵 | `attempt`（`connectors.ts:79-99`） | `pumpSession`（`use-cases/groups.ts:399-424`） | `pump`（`use-cases/messaging.ts:174-201`） |
| 「忙就不投」判定 | `isBusy(session) \|\| deps.busy(sessionId)` | 同左 + `occupied`（别的通道有未收尾投递） | 同左 + `occupied` |
| 先写 `delivered` 再投 | 有，注释写明「反过来写会让 turnEnded 找不到」 | 有 | 有 |
| 并发闸 | 无（`openRuns` 保证一条 binding 一次一条） | `SessionLane`（`main.ts:315`） | `SessionLane`（`main.ts:282`，与群共用同一把，`:280`） |
| 回合收口 | `turnEnded`（`connectors.ts:177-186`） | `turnEnded`（`groups.ts:897-906`） | `turnEnded`（`messaging.ts:410-427`） |
| 卡死兜底 | `sweepStale`（`connectors.ts:103-114`） | `sweep`（`groups.ts:907-931`，host 2 分钟 / member 10 分钟，`groups.ts:30,32`） | `deadlineAt` |
| 去重 | `UNIQUE(binding_id, external_id)` | 无（群内 seq 天然唯一） | `idempotencyKey` |
| 失败策略 | 连续 5 次暂停 binding | host 失败 → 兜底发言；member 失败 → `closeRound` | 记 failed，链上回复 |

**所以「复用连接器机制」的正确落点是：把上表里第 1–6 行抽成一个投递内核，三处共用；第 7–9 行（去重键、失败策略、轮次）留在各来源外层。**

不推荐的做法：把群消息变成 `InboundEvent` 走 `connector hub`。原因是硬语义不匹配——

- `ConnectorBinding` 是「一个 bot + 一条目标会话」，`target` 只有 `main | new`（`packages/domain/src/connector.ts:38`，`packages/storage-sqlite/src/connectors.ts:6-15,30`）；群消息要**扇出**给 N 个成员，还要主持人分派、竞价、按轮推进（`groups.ts:344-380,443-470`）。
- `externalId` 对群消息没有意义；硬套就得给「每个群 × 每个成员」各建一条 binding，binding 概念被稀释成投递队列的别名。
- 群帖落库与 `TriggerRun` 的 `delivered → done` 是两种收口时机（群帖不等回合结束，见 §5）。

## 2. 投递内核的边界

新增 `packages/domain/src/delivery.ts`（纯逻辑 + 一个泵工厂，不碰存储实现）：

```ts
export type DeliveryState = 'queued' | 'delivered' | 'done' | 'failed' | 'timeout' | 'skipped';

export interface DeliveryRecord {
  readonly id: string;
  readonly sessionId: string | null;
  readonly state: DeliveryState;
  readonly createdAt: number;
  readonly deliveredAt: number | null;
  readonly updatedAt: number;
}

/** 各来源自己实现，字段名映射到自己的表。 */
export interface DeliveryStore<T extends DeliveryRecord> {
  pendingFor(sessionId: string): Promise<readonly T[]>;  // queued + delivered
  queuedFor(sessionId: string): Promise<readonly T[]>;   // FIFO
  save(record: T): Promise<void>;
}

export type PumpDecision<T extends DeliveryRecord> =
  | { readonly kind: 'deliver'; readonly text: string; readonly author: { id: string; name: string; via: string } }
  | { readonly kind: 'wait' }        // 会话忙 / 有未收尾投递 / 别的通道占着
  | { readonly kind: 'cancel'; readonly reason: string };

export interface DeliveryPumpDeps<T extends DeliveryRecord> {
  readonly now: () => number;
  readonly sessions: { byId(id: string): Promise<{ status: string } | null> };
  readonly store: DeliveryStore<T>;
  readonly lane?: SessionLane;
  readonly occupied?: (sessionId: string) => Promise<boolean>;
  readonly decide: (record: T) => Promise<PumpDecision<T>>;
  readonly deliver: (sessionId: string, text: string, author: { id: string; name: string; via: string }) => Promise<{ ok: boolean; message?: string }>;
  readonly onDelivered?: (record: T) => Promise<void>;   // 群：挂 👀；连接器：无需
  readonly onFailed?: (record: T, reason: string) => Promise<void>;
}

export function createDeliveryPump<T extends DeliveryRecord>(deps: DeliveryPumpDeps<T>): {
  pump(sessionId: string): Promise<void>;
};

/** 超时扫描：各来源给自己的超时值。 */
export function expiredDeliveries<T extends DeliveryRecord & { deadlineAt?: number | null }>(
  open: readonly T[], now: number, timeoutOf: (record: T) => number
): readonly T[];
```

要点：

- **泵只做「查忙 → 取队头 → 标 delivered → 投 → 失败回写」**，不关心内容怎么拼、投给谁。`decide` 由来源提供：群聊在里面做 `purpose === 'member'` 的 `reactTo` 准备与 `occupied` 判断，连接器在里面解析 `main/new` 会话与 `externalId` 去重。
- **`onDelivered` 是关键扩展点**：群聊的「自动反应 👀」现在写在 `pumpSession` 里（`groups.ts:408-411`），抽出去之后由回调承担，避免内核认识表情。
- **超时扫描保留各自调度**：群聊保留 `HOST_TIMEOUT_MS/MEMBER_TIMEOUT_MS`，连接器保留 `staleAfterMs(periodMs)`（`connector.ts:69-70`），只是「遍历 open → 判过期」用同一个纯函数。
- **`SessionLane` 仍是可选的**：连接器现在不经过 lane（靠 `openRuns` 串行），不要把 lane 硬塞给它，改行为会动到投递顺序。

## 3. 各来源保留什么

| 关注点 | 连接器 | 群聊 | 私聊 |
| --- | --- | --- | --- |
| 内容拼装 | `formatInbound`（不可信包裹） | 群上下文 + 主持人 note（`groups.ts:344-380`） | `wrapUntrusted`（`messaging.ts:184-191`） |
| 目标解析 | `main/new` + 派生（`connectors.ts:56-78`） | 群 × 角色常驻会话（`groups.ts:300-333`） | `session:` / `bot:` 地址 |
| 去重 | `(binding, externalId)` | 无 | `idempotencyKey` |
| 失败策略 | 连续失败暂停 binding | host 兜底 / member 关轮 | 记 failed，回链 |
| 观测 | `observe-connector.ts` | 群视图 + SSE | 消息链 |

也就是说：**群聊复用连接器的「机制」= 队列 + 忙等 + 先标后投 + 回合收口 + 超时扫描；不复用连接器的「模型」= binding / TriggerRun / target。**

## 4. 迁移步骤（每步可独立回退）

1. **抽纯函数**：`delivery.ts` + 单测（忙/忙等/先标后投/失败回写/超时边界）。不改任何调用方。
2. **群聊先接**：`pumpSession` 改成 `pump.pump(sessionId)`，`onDelivered` 里做自动反应，`decide` 里做 `occupied` 与 thread 状态检查。群聊现有测试（`groups.test.ts` 24 条）是回归网。
3. **私聊接**：`messaging.ts` 的 `pump` 换成同一个泵；`wrapUntrusted` 与 author 拼装放进 `decide`。
4. **连接器接**：`attempt` 换成泵 + `openRuns` 去重（保留它不经过 lane 的现状）。
5. **最后**才考虑表结构统一（`trigger_run` / `agent_group_deliveries` / `agent_messages` 三张表合并或加视图）——这一步收益最低、风险最高，可以永远不做。

## 5. 收益 / 成本 / 风险

**收益**

- 「先写 delivered 再投」这条踩过的坑（`connectors.ts:88-92` 的注释）只留一份实现，避免三处再次写反。
- 群聊目前**没有**「投递卡在 delivered 但回合永远不结束」以外的兜底差异（它有 `sweep`，但没有连接器那种「连续失败自动暂停」）；统一后可以按来源选择策略，而不是各写一遍。
- 观测与排障统一：三处都能回答「这条会话现在挂着几笔投递、最早一笔多久了」。

**成本**

- 约 1–2 天：纯函数 + 泵 + 三次接线 + 现有三套测试回归（`groups.test.ts` 24、`messaging.test.ts`、`connectors.test.ts`）。
- 群聊的 `reactTo`/`round` 必须在 `decide`/`onDelivered` 里表达，不能漏（否则自动反应会静默消失）。

**风险**

- 群聊的「按群串行」（`serial(groupId)`）不能换成按会话串行，否则同一群两轮会交错。泵只负责单条会话，群级串行留在 `run()`。
- 连接器不经过 lane，接泵时不要顺手加 lane，会改变投递顺序与超时语义。

## 6. 明确不做

- 不把群消息变成 `InboundEvent`；不给群建 `ConnectorBinding`。
- 不合并三张表（v1），不做跨来源统一去重键。
- 不动群的分派 / 竞价 / `[SILENT]` / 停止命令语义。

## 7. 验收

- 单测：泵的四种决策（deliver / wait / cancel / failed）、先标后投、超时边界、`onDelivered` 只在成功后调用。
- 回归：`groups.test.ts`、`messaging.test.ts`、`connectors.test.ts` 全绿；`e2e/groups.spec.ts`、`e2e/agent-messaging.spec.ts` 全绿。
- 事故演练：会话在回合中被杀 → 投递超时收口、群轮次能关闭、私聊回 failed、连接器 run 标 timeout。

## 8. 附录：外部渠道接进群（另一个问题）

如果以后要接飞书 / Slack / GitHub 评论，那属于「外部事件 → 群帖」，需要另外的入站目标与外部作者类型；它的设计不依赖本方案，也不应该拿 GitHub 连接器当需求来源。相关约束（外部根帖借 `binding.createdBy` 开会话、`@all` 在解析前拒绝、回声去重复用 `trigger_run`）记录在上一版讨论里，等真要做时再单独成文。
