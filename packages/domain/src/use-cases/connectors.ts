import { BINDING_MAX_FAILURES, staleAfterMs, formatInbound, type ConnectorBinding, type InboundEvent, type TriggerRun } from '../connector.ts';
import type { Principal } from '../account.ts';
import { forbidden, invalid, notFound, type DomainError } from '../errors.ts';
import { newId, type ProjectId, type SessionId } from '../ids.ts';
import type { ConnectorStore } from '../ports/connector-store.ts';
import type { InboundContext, InboundSource } from '../ports/inbound-source.ts';
import { err, ok, type Result } from '../result.ts';
import { isBusy, type Session } from '../session.ts';
import { authorizeProject, type AccessPolicy } from './authorization.ts';
import type { Deps } from './deps.ts';

/**
 * 连接器入站核心（ADR 0032 R1）：Binding 增删改（只有人能建）、入站事件 → 去重 → 上一次没完就跳过 →
 * 解析会话（主会话 / 每次新会话）→ 智能体忙就等 → 经送达队列投递 → 回合结束记成败；连续失败 5 次自动暂停。
 * 不认识任何具体连接器：来源经 InboundSource 端口注册进来。
 */
export interface ConnectorHubDeps extends Pick<Deps, 'now' | 'projects' | 'sessions'> {
  readonly store: ConnectorStore;
  readonly sources: readonly InboundSource[];
  readonly policy?: AccessPolicy;
  /** bot 是否存在（定义它的项目 + @id）。 */
  readonly agentExists: (projectId: ProjectId, name: string) => Promise<boolean>;
  /** 给 bot 开一条新会话（组合根：建任务 + 派生 + 记派生和来历），归 ownerId。 */
  readonly spawn: (input: { projectId: ProjectId; agentName: string; ownerId: string; title: string }) => Promise<Result<Session, DomainError>>;
  /** 这条会话现在能不能接新的一轮（没在跑、没有排队的消息）。 */
  readonly busy: (sessionId: SessionId) => Promise<boolean>;
  /** 经 ADR 0031 送达队列投一轮。 */
  readonly deliver: (sessionId: SessionId, text: string, author: { id: string; name: string; via: string }) => Promise<Result<unknown, DomainError>>;
}

export interface BindingInput {
  readonly connector: string;
  readonly kind: string;
  readonly name: string;
  readonly target?: 'main' | 'new';
  readonly projectId?: string | null;
  readonly params: Record<string, unknown>;
  readonly timeZone?: string;
}

export interface BindingView extends ConnectorBinding { readonly summary: string; readonly lastRun: TriggerRun | null }

export interface ConnectorNotice { readonly kind: 'binding_paused'; readonly id: string; readonly title: string; readonly reason: string; readonly since: number; readonly projectId: string; readonly agentName: string }

export function createConnectorHub(deps: ConnectorHubDeps) {
  const sources = new Map(deps.sources.map((s) => [s.id, s]));
  const can = async (actor: Principal, projectId: string, permission: 'project.read' | 'project.update') =>
    authorizeProject(deps.policy, actor, await deps.projects.byId(projectId as ProjectId), permission);

  const fail = async (binding: ConnectorBinding, run: TriggerRun, reason: string, state: 'failed' | 'timeout' = 'failed') => {
    const now = deps.now();
    await deps.store.saveRun({ ...run, state, reason, updatedAt: now });
    const fresh = (await deps.store.binding(binding.id)) ?? binding;
    const failures = fresh.consecutiveFailures + 1;
    const pause = failures >= BINDING_MAX_FAILURES;
    await deps.store.saveBinding({ ...fresh, consecutiveFailures: failures, ...(pause ? { enabled: false, pausedReason: `连续失败 ${failures} 次，已自动暂停：${reason}` } : {}), updatedAt: now });
  };

  const sessionFor = async (binding: ConnectorBinding, run: TriggerRun): Promise<Result<Session, DomainError>> => {
    if (run.sessionId) {
      const s = await deps.sessions.byId(run.sessionId as SessionId);
      if (s) return ok(s);
    }
    if (binding.target === 'main' && binding.mainSessionId) {
      const s = await deps.sessions.byId(binding.mainSessionId as SessionId);
      if (s && s.status !== 'failed') return ok(s);
    }
    const spawned = await deps.spawn({ projectId: binding.agentProjectId as ProjectId, agentName: binding.agentName, ownerId: binding.createdBy, title: `${binding.name}${binding.target === 'new' ? ` · ${new Date(run.plannedAt ?? deps.now()).toISOString().slice(0, 16)}` : ''}` });
    if (spawned.ok && binding.target === 'main') {
      const fresh = (await deps.store.binding(binding.id)) ?? binding;
      await deps.store.saveBinding({ ...fresh, mainSessionId: spawned.value.id, updatedAt: deps.now() });
    }
    return spawned;
  };

  /** 试着投一次：会话忙就停在 waiting，下次 tick 再试。 */
  const attempt = async (run: TriggerRun): Promise<void> => {
    const binding = await deps.store.binding(run.bindingId);
    if (!binding) return;
    const session = await sessionFor(binding, run);
    if (!session.ok) return fail(binding, run, session.error.message);
    const sessionId = session.value.id;
    const now = deps.now();
    // 只有真在跑一轮才算忙；刚派生、从没发过话的会话（lastSeq = 0）也是 running，但要直接投
    if (isBusy(session.value) || (await deps.busy(sessionId))) {
      await deps.store.saveRun({ ...run, state: 'waiting', sessionId, reason: '智能体正忙，等它这一轮结束', updatedAt: now });
      return;
    }
    // 先记 delivered 再投：回合可能在 deliver 返回前就结束（快回合 / deliver 等到回合收尾才返回），
    // 反过来写会让 turnEnded 找不到这次运行，它就永远停在 delivered，后面每次触发都被跳过。
    const delivered: TriggerRun = { ...run, state: 'delivered', sessionId, reason: null, updatedAt: now };
    await deps.store.saveRun(delivered);
    const sent = await deps.deliver(sessionId, run.text, { id: binding.createdBy, name: `${binding.connector} · ${binding.name}`, via: 'connector' });
    if (!sent.ok) {
      const current = (await deps.store.runs(run.bindingId, 5)).find((r) => r.id === run.id);
      if (!current || current.state === 'delivered') return fail(binding, delivered, sent.error.message);
    }
  };

  /** 兜底：投进去后迟迟没收到回合结束（漏了 ended、重启丢了事件），超时记 timeout 失败，放行下一次。 */
  const sweepStale = async (): Promise<number> => {
    const now = deps.now();
    let n = 0;
    for (const run of await deps.store.deliveredRuns()) {
      const binding = await deps.store.binding(run.bindingId);
      if (!binding) continue;
      const limit = staleAfterMs(sources.get(binding.connector)?.periodMs?.(binding) ?? null);
      if (now - run.updatedAt < limit) continue;
      await fail(binding, run, `超过 ${Math.round(limit / 60_000)} 分钟没等到这一轮结束，按超时处理`, 'timeout');
      n++;
    }
    return n;
  };

  const emit = async (bindingId: string, event: InboundEvent): Promise<void> => {
    const binding = await deps.store.binding(bindingId);
    if (!binding || !binding.enabled) return;
    const now = deps.now();
    const run: TriggerRun = {
      id: newId(), bindingId, externalId: event.externalId, plannedAt: event.plannedAt ?? null, catchup: event.catchup === true,
      state: 'waiting', reason: null, sessionId: null, text: formatInbound(binding, event), createdAt: now, updatedAt: now
    };
    const open = await deps.store.openRuns(bindingId);
    if (open.length > 0) {
      await deps.store.insertRun({ ...run, state: 'skipped', reason: '上一次还没结束，本次跳过' });
      return;
    }
    if (!(await deps.store.insertRun(run))) return; // 去重
    await attempt(run);
  };

  const skip = async (bindingId: string, event: Pick<InboundEvent, 'externalId' | 'plannedAt'>, reason: string) => {
    const now = deps.now();
    await deps.store.insertRun({ id: newId(), bindingId, externalId: event.externalId, plannedAt: event.plannedAt ?? null, catchup: false, state: 'skipped', reason, sessionId: null, text: '', createdAt: now, updatedAt: now });
  };

  const contextFor = (source: InboundSource): InboundContext => ({
    now: deps.now,
    bindings: async () => (await deps.store.bindingsFor(source.id)).filter((b) => b.enabled),
    advance: (id, expected, next) => deps.store.advance(id, expected, next, deps.now()),
    emit,
    skip
  });

  const view = async (b: ConnectorBinding): Promise<BindingView> => ({
    ...b, summary: sources.get(b.connector)?.describe(b) ?? b.connector, lastRun: (await deps.store.runs(b.id, 1))[0] ?? null
  });

  const owned = async (actor: Principal, id: string): Promise<Result<ConnectorBinding, DomainError>> => {
    const b = await deps.store.binding(id);
    if (!b) return err(notFound('没有这个触发'));
    const allowed = await can(actor, b.agentProjectId, 'project.update');
    return allowed.ok ? ok(b) : allowed;
  };

  return {
    sources: () => [...sources.values()].map((s) => ({ id: s.id, kinds: s.kinds })),
    start(): { stop(): void } {
      const handles = [...sources.values()].map((s) => s.start(contextFor(s)));
      return { stop: () => handles.forEach((h) => h.stop()) };
    },
    emit,
    sweepStale,
    /** 等着的再试一次（组合根定时调）。 */
    async tick(): Promise<number> {
      await sweepStale().catch(() => undefined);
      const waiting = await deps.store.waitingRuns();
      for (const run of waiting) await attempt(run).catch(() => undefined);
      return waiting.length;
    },
    /** 回合结束：这条会话上投进去的那次运行记成败。 */
    async turnEnded(sessionId: string, outcome: 'done' | 'stopped' | 'interrupted' | 'failed'): Promise<void> {
      const run = await deps.store.deliveredRunFor(sessionId);
      if (!run) return;
      const binding = await deps.store.binding(run.bindingId);
      if (!binding) return;
      if (outcome === 'done') {
        await deps.store.saveRun({ ...run, state: 'done', updatedAt: deps.now() });
        if (binding.consecutiveFailures > 0) await deps.store.saveBinding({ ...binding, consecutiveFailures: 0, updatedAt: deps.now() });
      } else await fail(binding, run, outcome === 'failed' ? '这一轮失败了' : '这一轮被打断了');
    },
    async list(actor: Principal, projectId: string, agentName: string): Promise<Result<BindingView[], DomainError>> {
      const allowed = await can(actor, projectId, 'project.read');
      if (!allowed.ok) return allowed;
      return ok(await Promise.all((await deps.store.bindingsOf(projectId, agentName)).map(view)));
    },
    async create(actor: Principal, projectId: string, agentName: string, input: BindingInput): Promise<Result<BindingView, DomainError>> {
      const allowed = await can(actor, projectId, 'project.update');
      if (!allowed.ok) return allowed;
      if (!(await deps.agentExists(projectId as ProjectId, agentName))) return err(notFound(`没有 bot @${agentName}`));
      const source = sources.get(input.connector);
      if (!source || !source.kinds.includes(input.kind)) return err(invalid(`没有这个连接器事件：${input.connector}/${input.kind}`));
      const problem = source.validate(input.kind, input.params ?? {});
      if (problem) return err(invalid(problem));
      const name = String(input.name ?? '').trim();
      if (!name || name.length > 60) return err(invalid('名称 1–60 个字'));
      const scope = input.projectId ?? null;
      if (scope && scope !== projectId && !(await deps.store.agentProjects(projectId, agentName)).includes(scope)) return err(invalid('限定的项目必须是这个 bot 关联的项目'));
      const now = deps.now();
      const b: ConnectorBinding = {
        id: newId(), connector: source.id, kind: input.kind, agentProjectId: projectId, agentName, projectId: scope, name,
        target: input.target === 'new' ? 'new' : 'main', params: input.params ?? {}, enabled: true, pausedReason: null,
        consecutiveFailures: 0, nextRunAt: null, mainSessionId: null, createdBy: actor.user.id, timeZone: input.timeZone || 'UTC', createdAt: now, updatedAt: now
      };
      await deps.store.saveBinding(b);
      return ok(await view(b));
    },
    async update(actor: Principal, id: string, patch: { enabled?: boolean; name?: string; target?: 'main' | 'new'; params?: Record<string, unknown> }): Promise<Result<BindingView, DomainError>> {
      const b = await owned(actor, id);
      if (!b.ok) return b;
      const params = patch.params ?? b.value.params;
      if (patch.params) {
        const problem = sources.get(b.value.connector)?.validate(b.value.kind, params) ?? null;
        if (problem) return err(invalid(problem));
      }
      const resume = patch.enabled === true && !b.value.enabled;
      const next: ConnectorBinding = {
        ...b.value, params, ...(patch.name ? { name: patch.name.trim().slice(0, 60) } : {}), ...(patch.target ? { target: patch.target } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(resume ? { pausedReason: null, consecutiveFailures: 0, nextRunAt: null } : {}),
        ...(patch.params ? { nextRunAt: null } : {}),
        updatedAt: deps.now()
      };
      await deps.store.saveBinding(next);
      return ok(await view(next));
    },
    async remove(actor: Principal, id: string): Promise<Result<void, DomainError>> {
      const b = await owned(actor, id);
      if (!b.ok) return b;
      await deps.store.deleteBinding(id);
      return ok(undefined);
    },
    async runs(actor: Principal, id: string, limit = 30): Promise<Result<TriggerRun[], DomainError>> {
      const b = await deps.store.binding(id);
      if (!b) return err(notFound('没有这个触发'));
      const allowed = await can(actor, b.agentProjectId, 'project.read');
      if (!allowed.ok) return allowed;
      return ok(await deps.store.runs(id, limit));
    },
    /** 「等我处理」：我建的、被自动暂停的触发。 */
    async notices(accountId: string): Promise<ConnectorNotice[]> {
      return (await deps.store.allBindings())
        .filter((b) => b.createdBy === accountId && !b.enabled && b.pausedReason)
        .map((b) => ({ kind: 'binding_paused' as const, id: b.id, title: `@${b.agentName} · ${b.name}`, reason: b.pausedReason!, since: b.updatedAt, projectId: b.agentProjectId, agentName: b.agentName }));
    },
    async agentProjects(actor: Principal, projectId: string, agentName: string): Promise<Result<{ defaultProjectId: string; projectIds: string[] }, DomainError>> {
      const allowed = await can(actor, projectId, 'project.read');
      if (!allowed.ok) return allowed;
      return ok({ defaultProjectId: projectId, projectIds: await deps.store.agentProjects(projectId, agentName) });
    },
    async setAgentProjects(actor: Principal, projectId: string, agentName: string, projectIds: readonly string[]): Promise<Result<{ defaultProjectId: string; projectIds: string[] }, DomainError>> {
      const allowed = await can(actor, projectId, 'project.update');
      if (!allowed.ok) return allowed;
      const ids = [...new Set(projectIds)].filter((p) => p !== projectId).slice(0, 50);
      for (const p of ids) {
        // 关联别的项目：人在那个项目上也得有改的权限
        const there = await can(actor, p, 'project.update');
        if (!there.ok) return err(forbidden(`你在项目 ${p} 上没有修改权限，不能把 bot 关联过去`));
      }
      await deps.store.setAgentProjects(projectId, agentName, ids);
      return ok({ defaultProjectId: projectId, projectIds: ids });
    }
  };
}
export type ConnectorHub = ReturnType<typeof createConnectorHub>;
