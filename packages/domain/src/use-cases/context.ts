import type { AuditLog } from '../ports/audit-log.ts';
import type { ContextSettingsStore, ContextSetting } from '../ports/context-settings.ts';
import type { Deps } from './deps.ts';
import type { NodeGateway } from '../ports/node-gateway.ts';
import { isSideChannel } from '../event.ts';
import { conflict } from '../errors.ts';

import type { Result } from '../result.ts';
import { err, ok } from '../result.ts';
import { invalid, type DomainError } from '../errors.ts';
import { asProjectId, asSessionId, newId } from '../ids.ts';
import { authorizeProject, authorizeSession } from './authorization.ts';
import { principalOfSubject, type Subject } from '../access.ts';
import {
  BUILTIN_STRATEGIES,
  CANDIDATE_STRATEGIES,
  DEFAULT_STRATEGY_ID,
  contextCapabilityOf,
  estimateContextUsage,
  resolveContextStrategy,
  hubManagedBudget,
  type ContextCapability,
  type ContextMessage,
  type ContextMode,
  type StrategyEvent
} from '../context-strategy.ts';

/** hub-managed 一次改写的结果：运行时照着 keep / clear 改自己的消息；apply=false 就原样发。 */
export interface HubTransformResult {
  readonly apply: boolean;
  readonly strategy: string;
  readonly mode: ContextMode;
  readonly keep: readonly string[];
  readonly clear: readonly string[];
  readonly guidance: readonly string[];
  readonly events: readonly StrategyEvent[];
}

export interface ContextDeps extends Pick<Deps, 'projects' | 'tasks' | 'sessions' | 'access' | 'now'> {
  readonly contextSettings: ContextSettingsStore;
  readonly audit: AuditLog;
  /** 会话属于哪个角色（ADR 0018 角色表）；没有就跳过角色层。 */
  readonly roleOf?: (sessionId: string) => Promise<string | null>;
  /** 手动压缩要把命令发到 worker；没有就不支持。 */
  readonly gateway?: Pick<NodeGateway, 'dispatch'>;
}

export interface StrategyInfo { readonly id: string; readonly version: string; readonly title: string; readonly modes: readonly ContextMode[] }
export interface ProjectContextView {
  readonly strategy: string;
  readonly enabled: readonly string[];
  readonly inherited: boolean;
  readonly installed: readonly StrategyInfo[];
  readonly candidates: typeof CANDIDATE_STRATEGIES;
  /** 角色层（ADR 0020 §8：会话 > 角色 > 项目 > hub）。 */
  readonly roles: readonly { readonly role: string; readonly strategy: string }[];
}
export interface SessionContextView {
  readonly strategy: StrategyInfo;
  readonly mode: ContextMode;
  readonly source: 'session' | 'role' | 'project' | 'hub' | 'default';
  readonly fallback: { readonly wanted: string; readonly reason: string } | null;
  readonly sessionChoice: string | null;
  readonly role: string | null;
  readonly enabled: readonly string[];
  readonly capability: ContextCapability;
  readonly usage: ReturnType<typeof estimateContextUsage>;
}

const info = (s: (typeof BUILTIN_STRATEGIES)[number]): StrategyInfo => ({ id: s.id, version: s.version, title: s.title, modes: s.modes });
const enabledOf = (project: ContextSetting | null) => project?.enabled ?? [DEFAULT_STRATEGY_ID];

export function createContextService(deps: ContextDeps) {
  const store = deps.contextSettings;
  const audit = (subject: Subject | null, action: 'context.strategy.set' | 'session.context.set' | 'session.context.compact' | 'role.context.set', target: string, detail: string, teamId: string | null) => {
    const me = principalOfSubject(subject);
    return deps.audit.append({ id: newId(), actorId: (me?.user.id ?? 'system') as never, actorEmail: me?.user.email ?? '', action, target, detail: detail.slice(0, 500), at: deps.now(), teamId });
  };
  const installedIds = BUILTIN_STRATEGIES.map((s) => s.id);

  return {
    transformFor,
    async project(subject: Subject | null, projectId: string): Promise<Result<ProjectContextView, DomainError>> {
      const allowed = await authorizeProject(deps.access, subject, await deps.projects.byId(asProjectId(projectId)), 'project.read');
      if (!allowed.ok) return allowed;
      const prefix = `role:${allowed.value.id}:`;
      const [mine, hub, roles] = await Promise.all([store.get(`project:${allowed.value.id}`), store.get('hub'), store.list(prefix)]);
      return ok({
        strategy: mine?.strategy ?? hub?.strategy ?? DEFAULT_STRATEGY_ID,
        enabled: enabledOf(mine),
        inherited: !mine,
        installed: BUILTIN_STRATEGIES.map(info),
        candidates: CANDIDATE_STRATEGIES,
        roles: roles.map((r) => ({ role: r.key.slice(prefix.length), strategy: r.setting.strategy }))
      });
    },

    /** 角色层选择（项目 owner / admin，同 project.update）；只能从项目启用的里选；null = 跟随项目。 */
    async setRole(subject: Subject | null, projectId: string, role: string, strategy: string | null): Promise<Result<ProjectContextView, DomainError>> {
      const allowed = await authorizeProject(deps.access, subject, await deps.projects.byId(asProjectId(projectId)), 'project.update');
      if (!allowed.ok) return allowed;
      if (!/^[\p{L}\p{N}_-]{1,40}$/u.test(role)) return err(invalid('角色名只能是字母、数字、_ 和 -（最多 40 个）'));
      if (strategy !== null && !enabledOf(await store.get(`project:${allowed.value.id}`)).includes(strategy)) return err(invalid('只能从项目已启用的策略里选'));
      const me = principalOfSubject(subject);
      await store.set(`role:${allowed.value.id}:${role}`, strategy === null ? null : { strategy, updatedAt: deps.now(), updatedBy: me?.user.id ?? 'system' });
      await audit(subject, 'role.context.set', `${allowed.value.id}:${role}`, strategy === null ? `角色 ${role} 跟随项目` : `角色 ${role} 策略 ${strategy}（下一代生效）`, allowed.value.teamId ?? null);
      return this.project(subject, projectId);
    },

    /** 项目选策略 + 启用列表：owner / admin（context.strategy.set ≈ project.update）。 */
    async setProject(subject: Subject | null, projectId: string, input: { strategy: string; enabled: readonly string[] }): Promise<Result<ProjectContextView, DomainError>> {
      const allowed = await authorizeProject(deps.access, subject, await deps.projects.byId(asProjectId(projectId)), 'project.update');
      if (!allowed.ok) return allowed;
      const enabled = [...new Set(input.enabled)];
      const unknown = [input.strategy, ...enabled].find((id) => !installedIds.includes(id));
      if (unknown) return err(invalid(`策略 ${unknown} 没安装`));
      if (!enabled.includes(input.strategy)) return err(invalid('项目默认策略要在启用列表里'));
      const me = principalOfSubject(subject);
      await store.set(`project:${allowed.value.id}`, { strategy: input.strategy, enabled, updatedAt: deps.now(), updatedBy: me?.user.id ?? 'system' });
      await audit(subject, 'context.strategy.set', allowed.value.id, `项目策略 ${input.strategy}，启用 ${enabled.join(',')}`, allowed.value.teamId ?? null);
      return this.project(subject, projectId);
    },

    async session(subject: Subject | null, sessionId: string): Promise<Result<SessionContextView, DomainError>> {
      const found = await locate(sessionId);
      const allowed = await authorizeSession(deps.access, subject, found.project, found.session, 'session.read');
      if (!allowed.ok) return allowed;
      const session = allowed.value;
      const projectId = found.project!.id;
      const role = deps.roleOf ? await deps.roleOf(session.id) : null;
      const [own, roleSetting, project, hub] = await Promise.all([
        store.get(`session:${session.id}`),
        role ? store.get(`role:${projectId}:${role}`) : Promise.resolve(null),
        store.get(`project:${projectId}`),
        store.get('hub')
      ]);
      const capability = contextCapabilityOf(String(session.agentId));
      const enabled = enabledOf(project);
      const resolved = resolveContextStrategy({ layers: { session: own, role: roleSetting, project, hub }, capability, enabled });
      const events = await deps.sessions.eventsAfter(session.id, 0 as never);
      return ok({ strategy: info(resolved.strategy), mode: resolved.mode, source: resolved.source, fallback: resolved.fallback, sessionChoice: own?.strategy ?? null, role, enabled, capability, usage: estimateContextUsage(events) });
    },

    /** 单个会话选策略（session.context.set = 会话创建者），只能从项目启用的里选；null = 跟随项目。 */
    async setSession(subject: Subject | null, sessionId: string, strategy: string | null): Promise<Result<SessionContextView, DomainError>> {
      const found = await locate(sessionId);
      const allowed = await authorizeSession(deps.access, subject, found.project, found.session, 'session.prompt');
      if (!allowed.ok) return allowed;
      const projectId = found.project!.id;
      if (strategy !== null && !enabledOf(await store.get(`project:${projectId}`)).includes(strategy)) return err(invalid('只能从项目已启用的策略里选'));
      const me = principalOfSubject(subject);
      await store.set(`session:${allowed.value.id}`, strategy === null ? null : { strategy, updatedAt: deps.now(), updatedBy: me?.user.id ?? 'system' });
      await audit(subject, 'session.context.set', allowed.value.id, strategy === null ? '跟随项目' : `会话策略 ${strategy}（下一代生效）`, found.project!.teamId ?? null);
      return this.session(subject, sessionId);
    },

    /**
     * 手动压缩（ADR 0020 L1 compact，要 session.prompt）：只有运行时原生支持时才发；
     * 不支持的运行时返回 invalid，界面让用户改用「重启会话」——不替用户自动重启。
     * 正在回复时不压缩：和这一轮抢上下文，结果不可预期。
     */
    async compact(subject: Subject | null, sessionId: string, instructions?: string): Promise<Result<{ requested: true }, DomainError>> {
      const found = await locate(sessionId);
      const allowed = await authorizeSession(deps.access, subject, found.project, found.session, 'session.prompt');
      if (!allowed.ok) return allowed;
      const session = allowed.value;
      if (contextCapabilityOf(String(session.agentId)).l1.compact !== 'runtime' || !deps.gateway) return err(invalid('这个运行时不支持手动压缩，可以重启会话'));
      const events = await deps.sessions.eventsAfter(session.id, 0 as never);
      const last = [...events].reverse().find((e) => !isSideChannel(e.event));
      if (session.status === 'running' && last && last.event.kind !== 'ended') return err(conflict('正在回复，等这一轮结束再压缩'));
      const sent = await deps.gateway.dispatch({ kind: 'compact', sessionId: session.id, ...(instructions ? { instructions } : {}) });
      if (!sent.ok) return sent;
      await audit(subject, 'session.context.compact', session.id, instructions ? `手动压缩：${instructions}` : '手动压缩', found.project!.teamId ?? null);
      return ok({ requested: true });
    }
  };

  /**
   * hub-managed 改写（P3）：调用方是会话自己的工具授权（扩展转来的 `context` 事件），不是用户。
   * 只收元数据（id / 角色 / token 估算 / 调用 id），不收消息正文；hub 的原始记录不动。
   * 策略出错、会话不在 hub-managed 模式 → apply=false，运行时原样发（宁可不改，也不改坏）。
   */
  async function transformFor(sessionId: string, messages: readonly ContextMessage[]): Promise<Result<HubTransformResult, DomainError>> {
    const found = await locate(sessionId);
    if (!found.session || !found.project) return err(invalid('会话不存在'));
    const session = found.session;
    const projectId = found.project.id;
    const role = deps.roleOf ? await deps.roleOf(session.id) : null;
    const [own, roleSetting, project, hub] = await Promise.all([
      store.get(`session:${session.id}`),
      role ? store.get(`role:${projectId}:${role}`) : Promise.resolve(null),
      store.get(`project:${projectId}`),
      store.get('hub')
    ]);
    const resolved = resolveContextStrategy({ layers: { session: own, role: roleSetting, project, hub }, capability: contextCapabilityOf(String(session.agentId)), enabled: enabledOf(project) });
    const noop: HubTransformResult = { apply: false, strategy: resolved.strategy.id, mode: resolved.mode, keep: [], clear: [], guidance: [], events: [] };
    if (resolved.mode !== 'hub-managed' || !resolved.strategy.transform) return ok(noop);
    const events = await deps.sessions.eventsAfter(session.id, 0 as never);
    const used = messages.reduce((n, m) => n + m.tokens, 0);
    const budget = hubManagedBudget(estimateContextUsage(events).windowTokens, used);
    try {
      const out = await resolved.strategy.transform({ transcript: { messages, guidance: [] }, state: resolved.strategy.initialState(), budget });
      const ids = new Set(messages.map((m) => m.id));
      const keep = out.view.messages.map((m) => m.id).filter((id) => ids.has(id));
      const clear = out.view.messages.filter((m) => m.cleared && ids.has(m.id)).map((m) => m.id);
      const changed = keep.length !== messages.length || clear.length > 0 || out.view.guidance.length > 0;
      return ok({ ...noop, apply: changed, keep, clear, guidance: out.view.guidance, events: out.events });
    } catch {
      return ok(noop);
    }
  }

  async function locate(sessionId: string) {
    const session = await deps.sessions.byId(asSessionId(sessionId));
    const task = session ? await deps.tasks.byId(session.taskId) : null;
    const project = task ? await deps.projects.byId(task.projectId) : null;
    return { session, project };
  }
}
export type ContextService = ReturnType<typeof createContextService>;
