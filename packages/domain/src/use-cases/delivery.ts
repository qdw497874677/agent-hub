import { afterFailure, type Delivery } from '../delivery.ts';
import { isUnknownOutcomeEnded } from '../attention.ts';
import type { JournalEntry } from '../event.ts';
import { notFound, type DomainError } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { SessionId, Seq } from '../ids.ts';
import type { PromptPart } from '../attachment.ts';
import type { PromptMessageOrigin } from '../message-provenance.ts';
import type { Deps } from './deps.ts';
import type { DeliveryQueue } from '../ports/delivery-queue.ts';
import { ensureHosted } from './hosting.ts';
import { recordEvent } from './sessions.ts';
import { withActiveTask } from './task-admission.ts';
import { readInFlightTurn, readJournalTail, readRecentTurnDeliveries, turnVerdictInTail } from './turn-evidence.ts';
import { admitBranchSession } from './branch-admission.ts';
import { handoffFirstEnded, handoffRecord } from './handoff-admission.ts';

/**
 * 送达（ADR 0031 D2）。只有「依赖不在线」（unavailable）才重试：
 * 别的错误（权限、参数）重试也没用，照旧当场收尾。
 */
export type DeliveryDeps = Pick<
  Deps,
  'agents' | 'artifacts' | 'fs' | 'gateway' | 'hosting' | 'now' | 'projects' | 'queue' | 'sessions' | 'stream' | 'tasks' | 'taskGate' | 'workspaces' | 'workspaceGroups' | 'bots'
> & Pick<Deps, 'branchAttempts' | 'agentHandoffs'> & { readonly deliveries: DeliveryQueue; readonly random?: () => number };

export interface PromptPayload {
  readonly text: string;
  readonly parts: readonly PromptPart[];
  readonly messageOrigin?: PromptMessageOrigin;
}

/** 上一轮还在跑时，排队的消息隔多久再看一眼（回合结束时也会被立刻叫醒）。 */
export const TURN_WAIT_MS = 5_000;
/**
 * @deprecated 超时不是「已经停了」的证据，`turnInProgress` 不再用它放行下一句。
 * 保留常量只为兼容旧引用；新代码不要再用它做安全判断。
 */
export const TURN_STALE_MS = 30 * 60_000;

/**
 * 会话里是不是还有一轮没结束。判断以**持久化**的会话状态和送达记录为准：
 *
 * - 有 `sending` 的送达：已经交给运行时，但还没收到**带同一个 deliveryId** 的持久 `ended`，
 *   不管会话状态、超时、掉线还是重启都算在跑（通道要等精确结束证据才放）；
 * - 有 `delivered`：只有它之后出现可归属的 `ended` 才算结束；`status` 单独说了不算
 *   （新记录靠精确 id，升级前的记录走有界兜底）；
 * - 没有送达记录、且 status 不是 `running`：视为已有真实结果 / 已确认停止，空闲。
 *
 * 以前在「最后一条事件超过 30 分钟」时放行下一句，那等于用超时冒充结束：Worker 丢了任务、
 * 进程被冻住、或者老协议不认会话时，下一句会被塞进一个仍然在跑的 session，运行时会拒收，
 * 队列也从此错位。超时不是停止证据，这里删掉这条兜底，宁可 fail closed。
 *
 * 没有送达记录的老回合（定时触发 / 早期数据）退回 journal 尾部扫描，跳过还没送出去的 prompt。
 * 该扫描只读最近 2,000 条，尾部被截断时无法证明这一轮已经结束，按仍在跑处理；这是已知的有界读限制，
 * 新回合都有送达记录可核对，不依赖这个兜底。
 *
 * 有界读与尾部扫描骨架在 `turn-evidence.ts`（和切换门共用）；**优先级归本函数**：
 * 先 delivered 的归属证据，再看 status，最后才是 journal 兜底。共享件里不放通用 isBusy。
 */
export async function turnInProgress(deps: Pick<Deps, 'sessions' | 'now'> & { readonly deliveries?: DeliveryQueue }, sessionId: SessionId): Promise<boolean> {
  const session = await deps.sessions.byId(sessionId);
  if (!session) return false;

  // sending 用精确 inFlight 查，不能只看 recent(200)：积压超过窗口时，最早那条
  // 在途记录会被挤出去，漏掉它就会把下一句塞进仍在跑的回合。
  if (await readInFlightTurn(deps.deliveries, sessionId)) return true;
  const recent = await readRecentTurnDeliveries(deps.deliveries, sessionId);
  const delivered = latestDelivered(recent);
  if (delivered) {
    // 先核对送达记录自己的结束证据，再看状态字段：status 可能是状态帧 / 维护改的，
    // 不能单独当作「这一轮真的跑完了」。新 delivered 一定有精确 ended；老数据走有界兜底。
    const after = await deps.sessions.eventsAfter(sessionId, delivered.seq as Seq);
    if (!endedCovers(delivered, after, recent)) return true;
    return false;
  }
  // 没有送达记录可核对时，不是 running 才视为已有真实结果 / 已确认停止。
  if (session.status !== 'running') return false;

  const unsent = new Set(recent.filter((d) => d.state !== 'delivered' && d.state !== 'sending').map((d) => d.seq));
  const tail = await readJournalTail(deps, sessionId);
  // 送达门自己的跳过集合：任何没送出去的送达记录（queued / undelivered / cancelled / …）
  // 对应的 prompt 都还没开局。截断且没有证据时 `unknown` 照样按在跑处理（fail closed）。
  return turnVerdictInTail(tail, (entry) => unsent.has(entry.seq)) !== 'idle';
}

/** 最近一条已经交给运行时的送达（`recent` 是时间正序）。 */
function latestDelivered(recent: readonly Delivery[]): Delivery | undefined {
  for (let i = recent.length - 1; i >= 0; i--) {
    const delivery = recent[i]!;
    if (delivery.state === 'delivered') return delivery;
  }
  return undefined;
}

/**
 * 这条送达记录是否已经有**可归属的**结束证据。
 *
 * 新语义下 `delivered` 只由 `finishSending` 在精确匹配后写入，所以带同一个
 * `deliveryId` 的 ended 才是证明。老数据的 `delivered` 是在派发成功时就写的，
 * 没有 id 可对：这里保留一条有界兜底，只把「这条 prompt 之后、且中间没有另一条
 * 真正派发（sending / delivered）的 prompt」的那条裸 ended 归给它。再晚、再模糊
 * 的 ended 都不认，宁可继续 fail closed。
 */
function endedCovers(delivery: Delivery, after: readonly JournalEntry[], recent: readonly Delivery[]): boolean {
  let bare: JournalEntry | undefined;
  for (const entry of after) {
    if (entry.event.kind !== 'ended' || isUnknownOutcomeEnded(entry.event)) continue;
    if (entry.event.deliveryId === delivery.id) return true;
    if (entry.event.deliveryId === undefined && !bare) bare = entry;
  }
  if (!bare) return false;
  const owners = new Map(recent.map((d) => [d.seq, d]));
  for (const entry of after) {
    if (entry.seq >= bare.seq) break;
    if (entry.event.kind !== 'prompt') continue;
    const owner = owners.get(entry.seq);
    if (owner && owner.id !== delivery.id && (owner.state === 'sending' || owner.state === 'delivered')) return false;
  }
  return true;
}

/**
 * 送一次。上一轮还没结束就原样排着（不算失败、不扣次数），等回合结束再送；
 * 派发成功**不**把记录改成 delivered：`sending` 继续占着通道，直到 journal 里出现
 * 带同一个 `deliveryId` 的 ended（缓冲成功 ≠ 这一轮结束）。可重试的失败排下一次；
 * 用尽或不可重试就收掉这一轮。
 *
 * 认领 + 派发整体在会话队列里：定时泵、回合结束放行、立即重试、撤回可能同时看见
 * 这条记录，`claimSend` 的 CAS 只挡重复派发，挡不住「撤回刚读完 queued、这边已经
 * 认领成 sending」这类读改写交错；写 journal 的 seq 也排在同一条锁上。
 * 队列不可重入，队列内的收尾只能直接调 `recordEvent`（见下）。
 */
export async function attemptDelivery(deps: DeliveryDeps, delivery: Delivery): Promise<Result<void, DomainError>> {
  return deps.queue.run(delivery.sessionId as SessionId, () => attemptClaimed(deps, delivery));
}

/** `attemptDelivery` 的队列内部分；调用方必须已经持有该会话的队列。 */
async function attemptClaimed(deps: DeliveryDeps, delivery: Delivery): Promise<Result<void, DomainError>> {
  const sessionId = delivery.sessionId as SessionId;
  // Do not claim, fail, reschedule, or dispatch while branch evidence is unresolved.
  const admitted = await admitBranchSession(deps, sessionId);
  if (!admitted.ok) return admitted;
  const handoff = await handoffRecord(deps, sessionId);
  if (!handoff.ok) return handoff;
  const pendingHandoff = handoff.value && !(await handoffFirstEnded(deps, handoff.value)) ? handoff.value : null;
  const matchesStart = (): boolean => {
    if (!pendingHandoff?.first || pendingHandoff.first.delivery.id !== delivery.id || pendingHandoff.startup.state !== 'ready') return false;
    const { workerId, attemptId, connectionId } = pendingHandoff.startup;
    if (!workerId || !attemptId || !connectionId || !deps.hosting.has(sessionId)) return false;
    const ready = deps.gateway.sessionStartReadiness?.(sessionId, workerId);
    return ready?.state === 'ready' && ready.startAttemptId === attemptId && deps.gateway.sessionStartConnection?.(workerId) === connectionId;
  };
  // A blocked handoff must yield its slot in the bounded global due scan.
  // Re-read the head under the session queue and use the store's conditional
  // update: never revive a delivery which moved while the reads were pending.
  const deferHandoffHead = async (): Promise<Result<void, DomainError>> => {
    const head = (await deps.deliveries.pendingFor(sessionId))[0];
    if (head?.id === delivery.id && head.state === 'queued') {
      const now = deps.now();
      await deps.deliveries.reschedule(head.id, now, now + TURN_WAIT_MS);
    }
    return ok(undefined);
  };
  if (pendingHandoff && !matchesStart()) return deferHandoffHead();
  if (delivery.kind === 'prompt' && (await turnInProgress(deps, sessionId))) {
    const now = deps.now();
    await deps.deliveries.reschedule(delivery.id, now, now + TURN_WAIT_MS);
    return ok(undefined);
  }
  const session = await deps.sessions.byId(sessionId);
  return withActiveTask(deps, session?.taskId ?? null, async () => {
    // With readiness-aware gateways, starting a runtime precedes claiming the durable head.
    // A missing readiness method keeps the legacy dispatch behavior for older ports.
    let failure: DomainError | null = null;
    let startAttemptId: string | undefined;
    const readiness = deps.gateway.sessionStartReadiness?.bind(deps.gateway);
    if (pendingHandoff) {
      if (!session?.agentSessionRef || session.workerId !== pendingHandoff.startup.workerId || !matchesStart()) return deferHandoffHead();
      const head = (await deps.deliveries.pendingFor(sessionId))[0];
      if (!head || head.id !== delivery.id || (head.state !== 'queued' && head.state !== 'undelivered')) return ok(undefined);
      startAttemptId = pendingHandoff.startup.attemptId!;
      if (!matchesStart()) return deferHandoffHead();
    } else if (readiness && session) {
      const head = (await deps.deliveries.pendingFor(sessionId))[0];
      if (!head || head.id !== delivery.id || (head.state !== 'queued' && head.state !== 'undelivered')) return ok(undefined);
      const before = readiness(sessionId, session.workerId);
      if (before.state === 'offline' || before.state === 'upgrade_required' || before.state === 'starting' || before.state === 'failed') {
        const now = deps.now();
        await deps.deliveries.reschedule(delivery.id, now, now + TURN_WAIT_MS);
        return ok(undefined);
      }
      const hosted = await ensureHosted(deps, session, { requireFresh: before.state === 'untracked' && deps.hosting.has(sessionId) });
      if (!hosted.ok) {
        // No prompt has been claimed or sent. Start failures are not delivery failures.
        const now = deps.now();
        await deps.deliveries.reschedule(delivery.id, now, now + TURN_WAIT_MS);
        return ok(undefined);
      } else {
        // ensureHosted may have changed placement or initiated a new start.
        const placed = await deps.sessions.byId(sessionId);
        const after = readiness(sessionId, placed?.workerId ?? session.workerId);
        if (after.state !== 'ready') {
          const now = deps.now();
          await deps.deliveries.reschedule(delivery.id, now, now + TURN_WAIT_MS);
          return ok(undefined);
        }
        startAttemptId = after.startAttemptId;
      }
    }
    // 条件认领：定时泵、回合结束放行、立即重试可能同时看见这条，
    // 只有把状态原子翻成 sending 的那一个才派发，避免同一句话投递两次。
    if (!(await deps.deliveries.claimSend(delivery.id, deps.now()))) return ok(undefined);
    // Once claimed, loss of the exact connection is uncertain; never send or retry on another socket.
    if (pendingHandoff && !matchesStart()) return ok(undefined);
    if (!session) failure = notFound('会话不存在');
    else if (!failure && !readiness) {
      const hosted = await ensureHosted(deps, session);
      if (!hosted.ok) failure = hosted.error;
    }
    if (!failure && session) {
      const payload = delivery.payload as PromptPayload;
      const sent = await deps.gateway.dispatch({ kind: 'prompt', sessionId, text: payload.text, parts: payload.parts, deliveryId: delivery.id, ...(payload.messageOrigin === undefined ? {} : { messageOrigin: payload.messageOrigin }), ...(startAttemptId === undefined ? {} : { startAttemptId }) });
      if (!sent.ok) failure = sent.error;
    }
    const now = deps.now();
    if (!failure) {
      // claimSend 已经把状态写成 sending、updatedAt 记成派发时间；这里不再写 delivered。
      // 只有持久化的、带同一个 deliveryId 的 ended 才能通过 finishSending 收掉它。
      return ok(undefined);
    }
    if (failure.deliveryDeferred && !pendingHandoff) {
      await requeueRefusedPromptClaimed(deps, sessionId, delivery.id);
      return ok(undefined);
    }
    // Readiness-aware dispatch without an explicit unsent proof is uncertain: it may
    // already have reached the worker. Keep sending until exact ended/refusal evidence.
    if (readiness && startAttemptId !== undefined) return ok(undefined);
    const next = failure.code === 'unavailable'
      ? afterFailure(delivery, failure.message, now, deps.random)
      : { ...delivery, attempt: delivery.attempt + 1, state: 'undelivered' as const, nextAt: null, lastError: failure.message, updatedAt: now };
    await deps.deliveries.save(next);
    if (next.state === 'undelivered') {
      // 已经在 attemptDelivery 的会话队列里：再调 queue.run 会等自己（队列不可重入）。
      await recordEvent(deps, { sessionId, event: { kind: 'ended', outcome: 'failed', reason: `未送达：${failure.message}` } });
      return err(failure);
    }
    return ok(undefined);
  });
}

/** Only call after the gateway/worker has proved this exact prompt was never accepted. */
export async function requeueRefusedPrompt(deps: DeliveryDeps, sessionId: SessionId, deliveryId: string): Promise<boolean> {
  return deps.queue.run(sessionId, () => requeueRefusedPromptClaimed(deps, sessionId, deliveryId));
}

async function requeueRefusedPromptClaimed(deps: DeliveryDeps, sessionId: SessionId, deliveryId: string): Promise<boolean> {
  const handoff = await handoffRecord(deps, sessionId);
  if (!handoff.ok || (handoff.value?.first?.delivery.id === deliveryId && !(await handoffFirstEnded(deps, handoff.value)))) return false;
  const current = await deps.deliveries.inFlight(sessionId);
  if (!current || current.sessionId !== sessionId || current.id !== deliveryId || await findDeliveryEnded(deps, current)) return false;
  const fresh = await deps.deliveries.byId(deliveryId);
  if (!fresh || fresh.sessionId !== sessionId || fresh.state !== 'sending' || (await deps.deliveries.inFlight(sessionId))?.id !== deliveryId) return false;
  const now = deps.now();
  await deps.deliveries.save({ ...fresh, state: 'queued', nextAt: now + TURN_WAIT_MS, updatedAt: now });
  return true;
}

/**
 * 在 journal 里找这条送达自己的 ended。
 *
 * `eventsAfter(delivery.seq)` 只用于把搜索范围缩到这条 prompt 之后；真正判定必须
 * `deliveryId === delivery.id`。这样即使 A 的 ended 在 B 的 prompt 之后才落盘，
 * 也只能收掉 A，绝不会把 B 的 `sending` 放掉。
 */
export async function findDeliveryEnded(deps: Pick<Deps, 'sessions'>, delivery: Delivery): Promise<JournalEntry | null> {
  const sessionId = delivery.sessionId as SessionId;
  const after = await deps.sessions.eventsAfter(sessionId, delivery.seq as Seq);
  for (const entry of after) {
    if (entry.event.kind === 'ended' && entry.event.deliveryId === delivery.id && !isUnknownOutcomeEnded(entry.event)) return entry;
  }
  return null;
}

/**
 * 精确对账：这个会话的在途 `sending` 如果已经有带同一 `deliveryId` 的持久 ended，
 * 才调用 `finishSending` 收尾。返回是否真的收掉了一条。
 *
 * 只认持久化证据：状态变更、超时、断线、重启都不能代替 ended；没有 ended 时保持
 * `sending`（fail closed），后续消息继续排队。
 */
export async function reconcileInFlightDelivery(deps: DeliveryDeps, sessionId: SessionId): Promise<boolean> {
  const inFlight = await deps.deliveries.inFlight(sessionId);
  if (!inFlight) return false;
  if (!(await findDeliveryEnded(deps, inFlight))) return false;
  return deps.deliveries.finishSending(sessionId, inFlight.id, deps.now());
}

/**
 * 启动 / 恢复时的对账入口。逐个会话用 `inFlight` 精确查询，有匹配 ended 才收尾。
 * 这是唯一授权把**遗留** `sending` 收掉的兜底路径：live hooks 只认自己那条 ended 的
 * deliveryId，不能靠「当前 inFlight」猜身份。
 *
 * 正常回合结束由 ended 落盘后的 `releaseAfterTurn` 收尾；这个函数用于 hub 重启、
 * 或 journal 里已有 ended 但收尾入口没跑到的兜底。返回本次收掉的条数。
 */
export async function reconcileSendingDeliveries(deps: DeliveryDeps): Promise<number> {
  let cleared = 0;
  for (const session of await deps.sessions.listAll()) {
    if (await reconcileInFlightDelivery(deps, session.id)) cleared += 1;
  }
  return cleared;
}

/** 定时泵：每个会话只送最靠前那条到期的，严格按序。`due()` 已排除被 sending 挡住的队首。 */
export async function pumpDeliveries(deps: DeliveryDeps): Promise<number> {
  const due = await deps.deliveries.due(deps.now());
  for (const d of due) await attemptDelivery(deps, d).catch(() => undefined);
  return due.length;
}

/**
 * 回合结束：带 key 时先精确对账这条 `sending`（ended 已落盘才收掉），
 * 再把排在队首、等上一轮的那条马上送（不等下一次泵）。
 *
 * `wire-connectors` 的 delivery inbox 在 `ended` 之后调用它，所以正常路径不需要
 * 额外的定时扫描也能放行下一句。
 *
 * `expectedDeliveryId`：调用方知道是哪条 ended 触发的收尾（`event.deliveryId`）时传进来，
 * 就只收这一条；id 不匹配、没有对应 ended、或 `finishSending` 的 CAS 失败都完全不动作。
 *
 * 不带 key（旧协议 / 平台补写的 ended）时**不做任何对账**：拿「当前 inFlight」当身份，
 * 在 A 的 ended 迟到、或者旧收尾重放时会把已经换成 B 的在途误收掉。这里只负责放行
 * 队首那条 `queued`；持久 `sending` 还占着队首时 `pendingFor` 的头不是 queued，自然不放行。
 * 崩溃 / 升级前的遗留 `sending` 由启动时的 `reconcileSendingDeliveries` 显式对账。
 */
export async function releaseAfterTurn(deps: DeliveryDeps, sessionId: string, expectedDeliveryId?: string): Promise<boolean> {
  if (expectedDeliveryId !== undefined) {
    const inFlight = await deps.deliveries.inFlight(sessionId as SessionId);
    if (!inFlight || inFlight.id !== expectedDeliveryId) return false;
    if (!(await findDeliveryEnded(deps, inFlight))) return false;
    // 精确对账后仍由 finishSending 的 state='sending' CAS 兜底；收不掉就不放行下一句。
    if (!(await deps.deliveries.finishSending(sessionId as SessionId, inFlight.id, deps.now()))) return false;
  }
  const head = (await deps.deliveries.pendingFor(sessionId))[0];
  if (!head || head.state !== 'queued') return false;
  await attemptDelivery(deps, head);
  return true;
}

/** 送出去多久还没进展，就认为这一轮可疑。独立于卡顿巡检，可用 `HUB_ORPHAN_TURN_MS` 覆盖。 */
export const ORPHAN_TURN_MS = 2 * 60_000;

/** 孤儿巡检自己写的诊断前缀；也用它认出「这个回合已经处理过」，避免每个周期重复动作。 */
export const ORPHAN_TURN_MARKER = '送达后没有进展';

/**
 * 解析 `HUB_ORPHAN_TURN_MS`：只接受正的安全整数毫秒。
 * 空值 / 非法值 / 0 / 负数 / 小数 / 超出安全整数都回落到默认 2 分钟——
 * 配置笔误不该把巡检变成死循环或直接关掉。以前用 `Math.floor`，`'0.1'` 会被压成 0，
 * 反而绕过了正数校验，这里一并修掉。
 */
export function resolveOrphanTurnMs(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === '') return ORPHAN_TURN_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return ORPHAN_TURN_MS;
  return value;
}

interface TurnSignals {
  /** 投递之后有没有这一轮的真正输出（text / thinking / tool_call / tool_result / …）。 */
  readonly progress: boolean;
  /** 这条送达记录是不是已经触发过孤儿处理。 */
  readonly notice: boolean;
}

/**
 * 投递之后这一轮有没有真进展。只有 hub 自己写的事件不算：
 * - `prompt`：后面排队的消息一进来就会落一条，不代表上一轮跑了；
 * - `diagnostic`：巡检 / 回收写的提醒，正是「没进展」的证据。
 */
async function turnSignalsAfter(
  deps: Pick<Deps, 'sessions'>,
  sessionId: SessionId,
  seq: number
): Promise<TurnSignals> {
  const after = await deps.sessions.eventsAfter(sessionId, seq as Seq);
  let progress = false;
  let notice = false;
  for (const entry of after) {
    if (entry.event.kind === 'prompt') continue;
    if (entry.event.kind === 'diagnostic') {
      if (entry.event.text.startsWith(ORPHAN_TURN_MARKER)) notice = true;
      continue;
    }
    progress = true;
  }
  return { progress, notice };
}

/**
 * 处理「派出去了、但迟迟没有任何进展」的回合（#269 第 2 项：有界安全策略）。
 *
 * 真实事故：Worker 升级后还留着旧协议，收到 `taskId: null` 的 start_session 直接丢帧，
 * prompt 记成 delivered 之后永远没有事件。会话一直是 running，这一轮的记录永远占着
 * 队首，后面每句话都只能排队——界面上就是「一直没反应」。
 *
 * 新语义下这条「占着队首」的记录通常是 `sending`（派发成功但还没等到带同一个
 * deliveryId 的 ended）；升级前落库的才是 `delivered`。两种都按下面的策略处理：
 * - 派出后出现过任何真实输出（text / thinking / tool / …）：正常长回合，绝不插手；
 * - 托管表里没有它：`hosting` 缺失 / Worker 掉线都不能证明进程已经停了，可能只是暂时
 *   状态。fail closed，只记一条诊断，等人点「中断」或处理连接；
 * - 托管表里还有它、但毫无进展：先落一条持久标记，再向运行时请求一次 `interrupt`，
 *   让 Worker 自己按真实结果结束这一轮。每个回合最多请求一次（跨重启也认这条标记），不重复轰炸；
 *   如果 Worker 一直不回 ended，队首会一直等着，**绝不**由这里清掉 sending 或伪造结束。
 *
 * 已落盘、带同一个 `deliveryId` 的 ended **不在这里收尾**：收尾钩子挂在 ended 的 stream
 * 上，必须等 `inbox` 走 `releaseAfterTurn`。巡检看到这种行只跳过，避免在钩子完成前
 * 抢先把 `sending` 清掉、提前送出下一句。崩溃后的补收由启动时的显式对账负责。
 *
 * 「每个回合」的绑定是有界的：`interrupt` 只有 sessionId、没有 turn id，所以候选回合在
 * 观察之后可能已经结束、甚至已经开始了新回合。真正动作前会在同一个会话队列锁里重新核对
 * 一次：会话仍 running、候选 id 仍是当前在途 / 最新 delivered、没有另一条 sending、
 * 没有新进展/诊断/ended。任何一项变了就跳过；宁可少动一次，也不把中断打到新回合上。
 * 锁内不等待会重新触发生命周期的回调，因此不会和 `recordEvent` / turn-finisher 形成
 * 重入死锁。
 *
 * 会话枚举逐个会话先精确查 `inFlight`，再退回最近送达，而不是全局「最旧的 50 条」。
 * 后者会让一个永远卡住的会话占满窗口，把后面所有会话饿死；前者最坏是
 * `会话数 × (inFlight + ORPHAN_RECENT_LIMIT)` 次有界查询。新语义的 sending 由 `inFlight`
 * 精确命中，不受 `recent(200)` 窗口影响；只有升级前的 delivered 兜底仍受窗口限制，
 * 被超过 `ORPHAN_RECENT_LIMIT` 条更新的排队消息挤出时会漏检——这是当前端口
 * `recent(sessionId, limit)` 的有界读限制，不声称是强一致的全局扫描。
 *
 * 返回本次实际动作（请求中断 / 记诊断）的条数；重复巡检返回 0。
 */
const ORPHAN_RECENT_LIMIT = 200;

interface OrphanCandidate {
  readonly delivery: Delivery;
  /** sending = 新语义的在途；delivered = 升级前派发成功就写下的旧记录。 */
  readonly state: 'sending' | 'delivered';
}

export async function recoverOrphanedTurns(
  deps: DeliveryDeps & Pick<Deps, 'hosting'>,
  now = deps.now(),
  orphanMs = ORPHAN_TURN_MS
): Promise<number> {
  const windowMs = Number.isSafeInteger(orphanMs) && orphanMs > 0 ? orphanMs : ORPHAN_TURN_MS;
  const cutoff = now - windowMs;
  let actions = 0;
  const sessions = await deps.sessions.listAll();
  for (const session of sessions) {
    const sessionId = session.id;
    const handoff = await handoffRecord(deps, sessionId);
    if (!handoff.ok || (handoff.value && !(await handoffFirstEnded(deps, handoff.value)))) continue;
    const inFlight = await deps.deliveries.inFlight(sessionId);
    // ended 已落盘、只等 hooks 后 release：既不当孤儿打断，也不在这里抢先收尾。
    if (inFlight && (await findDeliveryEnded(deps, inFlight))) continue;
    // 状态不是 running 也可能是「上一轮的 ended 覆盖了已排队的下一轮」：
    // 只要还有持久 sending，就必须继续按在途回合检查，不能因为状态字段把它漏掉。
    if (session.status !== 'running' && !inFlight) continue;

    const recent = await deps.deliveries.recent(sessionId, ORPHAN_RECENT_LIMIT);
    // 端口之间出现短暂不一致时不动手：有 sending 但不在 inFlight 里，说明正在变化。
    if (!inFlight && recent.some((d) => d.state === 'sending')) continue;
    const delivery = inFlight ?? latestDelivered(recent);
    if (!delivery || delivery.updatedAt > cutoff) continue;
    const state: OrphanCandidate['state'] = inFlight ? 'sending' : 'delivered';
    const signals = await turnSignalsAfter(deps, sessionId, delivery.seq);
    // 有真实进展，或这个回合已经处理过：什么都不做。
    if (signals.progress || signals.notice) continue;

    const acted = await deps.queue.run(sessionId, async () => {
      // 观察和动作之间可能已经结束 / 开始新回合：在会话锁里重新取一次真相。
      const freshSession = await deps.sessions.byId(sessionId);
      if (!freshSession) return false;
      const freshInFlight = await deps.deliveries.inFlight(sessionId);
      // ended 已在锁内落盘：收尾属于 hooks 后的 release，巡检不抢先清 sending / 放行。
      if (freshInFlight && (await findDeliveryEnded(deps, freshInFlight))) return false;
      // 旧的 delivered 回退仍要求会话 running；持久 sending 本身就是回合还活着的证据。
      if (freshSession.status !== 'running' && !freshInFlight) return false;
      const fresh = await deps.deliveries.recent(sessionId, ORPHAN_RECENT_LIMIT);
      if (state === 'sending') {
        // 候选本身永远由精确 inFlight 命中，不靠这个窗口；这里只是防御端口短暂
        // 出现「不止一条 sending」的不一致（存储的 claimSend 保证正常不会发生）。
        if (freshInFlight?.id !== delivery.id) return false;
        if (fresh.some((d) => d.state === 'sending' && d.id !== delivery.id)) return false;
      } else if (freshInFlight) {
        return false;
      }
      const current = state === 'sending' ? freshInFlight : latestDelivered(fresh);
      if (!current || current.id !== delivery.id || current.updatedAt > cutoff) return false;
      const freshSignals = await turnSignalsAfter(deps, sessionId, current.seq);
      if (freshSignals.progress || freshSignals.notice) return false;

      const minutes = Math.max(1, Math.round((now - current.updatedAt) / 60_000));
      const stage = state === 'sending' ? '交给运行时' : '送达';
      const hosted = deps.hosting.has(sessionId);
      // 先落「准备请求中断」的持久标记，再发 interrupt：如果进程在两步之间崩掉，
      // 下一轮巡检会因为标记而不再重复请求——宁可少中断一次，也不跨重启重复轰炸。
      const pending = hosted
        ? `${ORPHAN_TURN_MARKER}：这一轮${stage} ${minutes} 分钟仍没有输出，正在请求中断；平台不会代写结束，等运行时报结束后再放行后面的消息。`
        : `${ORPHAN_TURN_MARKER}：这一轮${stage} ${minutes} 分钟仍没有输出，但无法确认它是否还在机器上运行（托管记录里没有它）。平台不会自动收尾或放行后面的消息，可以点「中断」或检查机器连接。`;
      await recordEvent(deps, { sessionId, event: { kind: 'diagnostic', level: 'warn', text: pending } });
      if (!hosted) return true;

      // 托管表里还有它：请运行时中断这一轮，结束与否由 Worker 说了算。
      let failure: string | null = null;
      try {
        const stopped = await deps.gateway.dispatch({ kind: 'interrupt', sessionId });
        if (!stopped.ok) failure = stopped.error.message;
      } catch (error: unknown) {
        failure = error instanceof Error ? error.message : String(error);
      }
      if (failure !== null) {
        // 不重复带孤儿前缀：上面那条已经是本回合的持久标记，这里只补失败原因。
        await recordEvent(deps, {
          sessionId,
          event: {
            kind: 'diagnostic',
            level: 'warn',
            text: `中断请求失败：这一轮${stage} ${minutes} 分钟仍没有输出，尝试请求中断失败（${failure}）；平台不会自动收尾或放行后面的消息。`
          }
        });
      }
      return true;
    });
    if (acted) actions += 1;
  }
  return actions;
}

/** 人点「立即重试」：只对未送达、或排队中的会话队首有效；重新给满 10 次。 */
export async function retryDeliveryNow(deps: DeliveryDeps, id: string): Promise<Result<void, DomainError>> {
  const d = await deps.deliveries.byId(id);
  if (!d) return err(notFound('没有这条待送达的消息'));
  const sessionId = d.sessionId as SessionId;
  return deps.queue.run(sessionId, async () => {
    const current = await deps.deliveries.byId(id);
    if (!current || (current.state !== 'undelivered' && current.state !== 'queued')) return err(notFound('没有这条待送达的消息'));
    const head = (await deps.deliveries.pendingFor(sessionId))[0];
    if (head?.id !== id) return err({ code: 'conflict', message: '前面还有消息没送达，先处理前面的' });
    const handoff = await handoffRecord(deps, sessionId);
    if (!handoff.ok) return handoff;
    if (handoff.value && !(await handoffFirstEnded(deps, handoff.value))) return err({ code: 'conflict', message: '交接首条消息尚未完成，不能手动重试' });
    // Do not clear/start anything while an older turn is still uncertain.
    if (!(await turnInProgress(deps, sessionId))) {
      const session = await deps.sessions.byId(sessionId);
      if (deps.gateway.sessionStartReadiness?.(sessionId, session?.workerId).state === 'failed') {
        deps.gateway.retrySessionStart?.(sessionId, session?.workerId);
      }
    }
    return attemptClaimed(deps, { ...current, attempt: 0 });
  });
}

/** 人点「撤回」：不再送；journal 里那句话保留，另记一条说明。 */
export async function cancelDelivery(deps: DeliveryDeps, id: string): Promise<Result<void, DomainError>> {
  const first = await deps.deliveries.byId(id);
  if (!first) return err(notFound('没有这条待送达的消息'));
  const sessionId = first.sessionId as SessionId;
  // 读 → 判断 → 写 与派发认领共用同一条会话队列：否则这里刚读到 queued，那边已经
  // claimSend 成 sending，这次 save 会把 durable sending 覆盖成 cancelled——
  // 运行时还在跑，通道记录却没了。队列内重读一次，认领先到就直接拒绝撤回。
  return deps.queue.run(sessionId, async (): Promise<Result<void, DomainError>> => {
    const d = await deps.deliveries.byId(id);
    if (!d || (d.state !== 'undelivered' && d.state !== 'queued')) return err(notFound('没有这条待送达的消息'));
    const handoff = await handoffRecord(deps, sessionId);
    if (!handoff.ok) return handoff;
    if (handoff.value?.first?.delivery.id === id && !(await handoffFirstEnded(deps, handoff.value))) return err({ code: 'conflict', message: '交接首条消息尚未完成，不能撤回' });
    await deps.deliveries.save({ ...d, state: 'cancelled', nextAt: null, updatedAt: deps.now() });
    await recordEvent(deps, { sessionId, event: { kind: 'diagnostic', level: 'info', text: `已撤回第 ${d.seq} 步那条未送达的消息` } });
    // 提问会把会话置成 running（见 applyEvent）；撤回最后一条待送达的消息后，
    // 这一轮已经没有下文了，不能让它一直显示「正在回复」、也挡住删除与收起。
    // 但只有「真的没有任何在途回合」才降级：journal 里还有一轮已送出却没 ended 的 prompt
    // （定时触发或人上一句还在跑）就继续 running。不能用 `hosting.has`——派生的会话一建好
    // 就登记了托管，那样永远降不了级。
    // `pendingFor` 含 sending；sending 是「已经交给运行时、还没进 journal」的在途回合，
    // 不能只因为队列里没有 queued 就降级（`turnInProgress` 会跳过 sending 的 prompt）。
    const queued = (await deps.deliveries.pendingFor(sessionId)).filter((row) => row.state !== 'sending');
    if (queued.length === 0 && !(await turnInProgress(deps, sessionId))) {
      const session = await deps.sessions.byId(sessionId);
      if (session && (await deps.sessions.markInterrupted(sessionId, deps.now()))) {
        deps.stream.publish({ sessionId, seq: session.lastSeq, event: null, status: 'interrupted' });
      }
    }
    return ok(undefined);
  });
}
