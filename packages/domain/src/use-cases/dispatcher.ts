import { dispatchOrder, planDispatch, DISPATCH_CAPS } from '../dispatch.ts';
import { invalid, notFound, type DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { AgentTaskRequest } from '../ports/agent-task-store.ts';
import type { OutputSink } from '../ports/output-sink.ts';
import type { TaskDispatch, TaskDispatchStore } from '../ports/task-dispatch-store.ts';
import { err, ok, type Result } from '../result.ts';

/**
 * 调度器（ADR 0032 R3）：task.create（含批准的超额）建出来的任务排队，按上限开任务智能体会话；
 * 会话一轮结束 = 任务结束，结果经送达队列通知建它的 bot 会话，并交给来源连接器的 Sink。
 * 只依赖端口；开会话 / 发消息 / 读状态都由组合根用现有流程实现。不认识任何具体连接器。
 */
export interface DispatcherDeps {
  readonly now: () => number;
  readonly store: TaskDispatchStore;
  /** 任务会落在哪台机器（项目默认工作空间所在）、那台机器在不在线。 */
  readonly placement: (projectId: string) => Promise<{ workerId: string | null; online: boolean }>;
  /** 开任务智能体会话并发第一句（复用现有派生 + 送达流程）。 */
  readonly start: (d: TaskDispatch) => Promise<Result<{ sessionId: string; workerId: string | null }, DomainError>>;
  /** 会话现状：还在跑 / 已结束（结果 + 最后一段回复）/ 不存在。 */
  readonly sessionState: (sessionId: string) => Promise<{ running: boolean; outcome: 'done' | 'failed' | null; reply: string } | null>;
  /** bot 会话能不能接新一轮（没在跑、没排队）。 */
  readonly busy: (sessionId: string) => Promise<boolean>;
  /** 经 ADR 0031 送达队列给 bot 发一句。 */
  readonly notify: (sessionId: string, text: string) => Promise<Result<unknown, DomainError>>;
  /** 取消排队时把任务置为放弃（system 身份）。 */
  readonly abandonTask: (taskId: string, reason: string) => Promise<void>;
  readonly sinks?: readonly OutputSink[];
  readonly caps?: typeof DISPATCH_CAPS;
  readonly log?: (line: string) => void;
}

export interface DispatchView extends TaskDispatch { readonly position: number | null }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function createDispatcher(deps: DispatcherDeps) {
  let ticking: Promise<void> | null = null;

  const enqueue = async (r: AgentTaskRequest, runtime: { agentId: string | null; model: string | null }): Promise<TaskDispatch | null> => {
    if (!r.taskId) return null;
    const now = deps.now();
    return deps.store.insert({
      id: newId(), taskId: r.taskId, accountId: r.accountId, projectId: r.projectId, title: r.title, goal: r.goal,
      human: r.wakeKey === null || r.wakeKey.startsWith('session:'), notifySessionId: r.sessionId, agentId: runtime.agentId, model: runtime.model,
      originConnector: r.originConnector, originExternalId: r.originExternalId,
      state: 'queued', workerId: null, sessionId: null, waitReason: null, result: null, notified: false,
      createdAt: now, startedAt: null, updatedAt: now
    });
  };

  const sink = async (d: TaskDispatch) => {
    if (!d.originConnector || !d.originExternalId) return;
    for (const s of deps.sinks ?? []) {
      if (s.id !== d.originConnector) continue;
      await s.deliver({ kind: d.state === 'done' ? 'task.finished' : 'task.failed', bindingId: '', externalId: d.originExternalId, detail: d.result ?? '', taskId: d.taskId, projectId: d.projectId }).catch(() => undefined);
    }
  };

  const finish = async (d: TaskDispatch, state: 'done' | 'failed', result: string) => {
    const next: TaskDispatch = { ...d, state, result: clip(result, 4000), waitReason: null, updatedAt: deps.now() };
    await deps.store.save(next);
    await sink(next);
    deps.log?.(`调度：任务 ${d.taskId} ${state}`);
  };

  /** 会话结束（回合 ended，或重启后对账发现已停）→ 记结果。 */
  const settle = async (d: TaskDispatch) => {
    if (!d.sessionId) return;
    const st = await deps.sessionState(d.sessionId);
    if (!st) return finish(d, 'failed', '任务会话不见了');
    if (st.running || st.outcome === null) return;
    return finish(d, st.outcome, st.reply || (st.outcome === 'done' ? '（没有文字回复）' : '（会话失败）'));
  };

  const notifyAll = async () => {
    for (const d of await deps.store.unnotified()) {
      if (!d.notifySessionId) { await deps.store.save({ ...d, notified: true, updatedAt: deps.now() }); continue; }
      if (await deps.busy(d.notifySessionId)) continue;
      const head = d.state === 'done' ? '✅ 任务完成' : d.state === 'failed' ? '❌ 任务失败' : '任务已取消';
      const text = [`[调度通知] ${head}：「${d.title}」（任务 ${d.taskId}${d.sessionId ? `，会话 ${d.sessionId}` : ''}）`,
        d.result ? `任务智能体的最后回复：\n> ${d.result.split('\n').join('\n> ')}` : '',
        '请把结果简要告诉用户。'].filter(Boolean).join('\n\n');
      // 先记已通知再投：投递本身走送达队列，失败也由队列重试，不会重复通知
      await deps.store.save({ ...d, notified: true, updatedAt: deps.now() });
      const sent = await deps.notify(d.notifySessionId, text);
      if (!sent.ok) deps.log?.(`调度：通知 bot 失败 ${sent.error.message}`);
    }
  };

  const run = async () => {
    const active = await deps.store.active();
    // 重启恢复 / 漏掉的 ended：running 的先对账
    for (const d of active.filter((x) => x.state === 'running')) await settle(d);
    const now = await deps.store.active();
    const running = now.filter((x) => x.state === 'running').map((x) => ({ projectId: x.projectId, workerId: x.workerId, human: x.human }));
    const queued = now.filter((x) => x.state === 'queued');
    const placed = new Map<string, { workerId: string | null; online: boolean }>();
    for (const q of queued) if (!placed.has(q.projectId)) placed.set(q.projectId, await deps.placement(q.projectId));
    const plan = planDispatch(queued.map((q) => ({ id: q.id, projectId: q.projectId, human: q.human, createdAt: q.createdAt, workerId: placed.get(q.projectId)!.workerId, workerOnline: placed.get(q.projectId)!.online })), running, deps.caps ?? DISPATCH_CAPS);
    for (const q of queued) {
      const reason = plan.waiting.get(q.id) ?? null;
      if (!plan.start.includes(q.id) && reason !== q.waitReason) await deps.store.save({ ...q, waitReason: reason, updatedAt: deps.now() });
    }
    for (const id of plan.start) {
      const q = queued.find((x) => x.id === id)!;
      // 先占位（running）再开会话：同一条不会被两次 tick 重复派发
      const claimed: TaskDispatch = { ...q, state: 'running', workerId: placed.get(q.projectId)!.workerId, waitReason: null, startedAt: deps.now(), updatedAt: deps.now() };
      await deps.store.save(claimed);
      const started = await deps.start(claimed).catch((e: unknown) => err(invalid(String(e))));
      if (!started.ok) { await finish(claimed, 'failed', `开任务会话失败：${started.error.message}`); continue; }
      await deps.store.save({ ...claimed, sessionId: started.value.sessionId, workerId: started.value.workerId, updatedAt: deps.now() });
      deps.log?.(`调度：任务 ${q.taskId} → 会话 ${started.value.sessionId}`);
    }
    await notifyAll();
  };

  /** 串行：同一时刻只有一个 tick 在跑。 */
  const tick = async (): Promise<void> => {
    while (ticking) await ticking;
    ticking = run().finally(() => { ticking = null; });
    return ticking;
  };

  return {
    enqueue,
    tick,
    /** 会话一轮结束（hub.stream 的 ended）。 */
    async sessionEnded(sessionId: string): Promise<void> {
      const d = await deps.store.bySession(sessionId);
      if (d && d.state === 'running') { await settle(d); await tick(); }
    },
    async cancel(accountId: string, id: string): Promise<Result<TaskDispatch, DomainError>> {
      const d = await deps.store.byId(id);
      if (!d || d.accountId !== accountId) return err(notFound('队列里没有这个任务'));
      if (d.state !== 'queued') return err(invalid('任务已经开始或结束了，不能从队列取消'));
      const next: TaskDispatch = { ...d, state: 'cancelled', result: '用户从队列取消', updatedAt: deps.now() };
      await deps.store.save(next);
      await deps.abandonTask(d.taskId, '从调度队列取消');
      return ok(next);
    },
    async list(accountId: string): Promise<{ queued: DispatchView[]; running: DispatchView[]; recent: DispatchView[]; caps: typeof DISPATCH_CAPS }> {
      const all = await deps.store.recent(accountId, 60);
      const queued = dispatchOrder(all.filter((d) => d.state === 'queued')).map((d, i) => ({ ...d, position: i + 1 }));
      return {
        queued,
        running: all.filter((d) => d.state === 'running').map((d) => ({ ...d, position: null })),
        recent: all.filter((d) => d.state === 'done' || d.state === 'failed' || d.state === 'cancelled').slice(0, 20).map((d) => ({ ...d, position: null })),
        caps: deps.caps ?? DISPATCH_CAPS
      };
    }
  };
}
export type Dispatcher = ReturnType<typeof createDispatcher>;
