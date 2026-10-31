import type { AuditLog } from '../ports/audit-log.ts';
import type { ContextSettingsStore, ContextSetting } from '../ports/context-settings.ts';
import type { Deps } from './deps.ts';

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
  type ContextCapability,
  type ContextMode
} from '../context-strategy.ts';

export interface ContextDeps extends Pick<Deps, 'projects' | 'tasks' | 'sessions' | 'access' | 'now'> {
  readonly contextSettings: ContextSettingsStore;
  readonly audit: AuditLog;
  /** 会话属于哪个角色（ADR 0018 角色表）；没有就跳过角色层。 */
  readonly roleOf?: (sessionId: string) => Promise<string | null>;
}

export interface StrategyInfo { readonly id: string; readonly version: string; readonly title: string; readonly modes: readonly ContextMode[] }
export interface ProjectContextView {
  readonly strategy: string;
  readonly enabled: readonly string[];
  readonly inherited: boolean;
  readonly installed: readonly StrategyInfo[];
  readonly candidates: typeof CANDIDATE_STRATEGIES;
}
export interface SessionContextView {
  readonly strategy: StrategyInfo;
  readonly mode: ContextMode;
  readonly source: 'session' | 'role' | 'project' | 'hub' | 'default';
  readonly fallback: { readonly wanted: string; readonly reason: string } | null;
  readonly sessionChoice: string | null;
  readonly enabled: readonly string[];
  readonly capability: ContextCapability;
  readonly usage: ReturnType<typeof estimateContextUsage>;
}

const info = (s: (typeof BUILTIN_STRATEGIES)[number]): StrategyInfo => ({ id: s.id, version: s.version, title: s.title, modes: s.modes });
const enabledOf = (project: ContextSetting | null) => project?.enabled ?? [DEFAULT_STRATEGY_ID];

export function createContextService(deps: ContextDeps) {
  const store = deps.contextSettings;
  const audit = (subject: Subject | null, action: 'context.strategy.set' | 'session.context.set', target: string, detail: string, teamId: string | null) => {
    const me = principalOfSubject(subject);
    return deps.audit.append({ id: newId(), actorId: (me?.user.id ?? 'system') as never, actorEmail: me?.user.email ?? '', action, target, detail: detail.slice(0, 500), at: deps.now(), teamId });
  };
  const installedIds = BUILTIN_STRATEGIES.map((s) => s.id);

  return {
    async project(subject: Subject | null, projectId: string): Promise<Result<ProjectContextView, DomainError>> {
      const allowed = await authorizeProject(deps.access, subject, await deps.projects.byId(asProjectId(projectId)), 'project.read');
      if (!allowed.ok) return allowed;
      const [mine, hub] = await Promise.all([store.get(`project:${allowed.value.id}`), store.get('hub')]);
      return ok({ strategy: mine?.strategy ?? hub?.strategy ?? DEFAULT_STRATEGY_ID, enabled: enabledOf(mine), inherited: !mine, installed: BUILTIN_STRATEGIES.map(info), candidates: CANDIDATE_STRATEGIES });
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
      return ok({ strategy: info(resolved.strategy), mode: resolved.mode, source: resolved.source, fallback: resolved.fallback, sessionChoice: own?.strategy ?? null, enabled, capability, usage: estimateContextUsage(events) });
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
    }
  };

  async function locate(sessionId: string) {
    const session = await deps.sessions.byId(asSessionId(sessionId));
    const task = session ? await deps.tasks.byId(session.taskId) : null;
    const project = task ? await deps.projects.byId(task.projectId) : null;
    return { session, project };
  }
}
export type ContextService = ReturnType<typeof createContextService>;
