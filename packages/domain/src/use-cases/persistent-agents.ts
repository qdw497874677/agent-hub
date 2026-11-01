import type { Principal } from '../account.ts';
import { invalid, notFound, type DomainError } from '../errors.ts';
import type { ProjectId } from '../ids.ts';
import { configProblem, isPersistentAgentName, type MessageLimits, type MessagingConfig, type PersistentAgent, type RoleReuse } from '../messaging.ts';
import type { Group } from '../groups.ts';
import { err, ok, type Result } from '../result.ts';
import { authorizeProject, type AccessPolicy } from './authorization.ts';
import type { Deps } from './deps.ts';

/**
 * 持久智能体（界面上叫「bot」）的增删改查。
 *
 * bot 仍存在项目的 agent 消息配置里（老数据原样可读，不需要迁移）；这里只是按条读写，
 * 避免前端整表覆盖。删除时同时从项目里所有群移出（由群聊用例负责串行和系统消息）。
 * 读要 project.read，改要 project.update（与整表配置接口一致）。
 */
export interface PersistentAgentInput {
  readonly name: string;
  readonly displayName?: string;
  readonly color?: string;
  readonly description?: string;
  readonly agentId: string;
  readonly model?: string;
  readonly reuse?: RoleReuse;
}
export type PersistentAgentPatch = Partial<Omit<PersistentAgentInput, 'name'>>;

export interface PersistentAgentView extends PersistentAgent {
  /** 引用它的群（id + 名字）。 */
  readonly groups: readonly { id: string; name: string; host: boolean }[];
}

export interface PersistentAgentsDeps extends Pick<Deps, 'projects'> {
  readonly policy?: AccessPolicy;
  readonly config: (projectId: ProjectId) => Promise<MessagingConfig>;
  readonly saveConfig: (projectId: ProjectId, input: { roles: readonly PersistentAgent[]; limits: Partial<MessageLimits> }) => Promise<Result<MessagingConfig, DomainError>>;
  readonly groupsOf: (projectId: ProjectId) => Promise<readonly Group[]>;
  readonly detach: (actor: Principal, projectId: ProjectId, name: string) => Promise<readonly Group[]>;
}

export interface PersistentAgents {
  list(actor: Principal, projectId: ProjectId): Promise<Result<readonly PersistentAgentView[], DomainError>>;
  create(actor: Principal, projectId: ProjectId, input: PersistentAgentInput): Promise<Result<PersistentAgent, DomainError>>;
  update(actor: Principal, projectId: ProjectId, name: string, patch: PersistentAgentPatch): Promise<Result<PersistentAgent, DomainError>>;
  remove(actor: Principal, projectId: ProjectId, name: string): Promise<Result<{ removedFrom: readonly { id: string; name: string }[] }, DomainError>>;
}

const clean = (a: PersistentAgent): PersistentAgent => {
  const displayName = a.displayName?.trim();
  return {
    name: a.name.trim(),
    ...(displayName ? { displayName } : {}),
    ...(a.color ? { color: a.color } : {}),
    description: a.description,
    agentId: a.agentId.trim(),
    model: a.model.trim(),
    reuse: a.reuse
  };
};

export function createPersistentAgents(deps: PersistentAgentsDeps): PersistentAgents {
  const allowed = async (actor: Principal, projectId: ProjectId, permission: 'project.read' | 'project.update') =>
    authorizeProject(deps.policy, actor, await deps.projects.byId(projectId), permission);

  const save = async (projectId: ProjectId, config: MessagingConfig, roles: readonly PersistentAgent[]) => {
    const problem = configProblem({ roles, limits: config.limits });
    if (problem) return err(invalid(problem));
    return deps.saveConfig(projectId, { roles, limits: config.limits });
  };

  return {
    async list(actor, projectId) {
      const project = await allowed(actor, projectId, 'project.read');
      if (!project.ok) return project;
      const [config, groups] = await Promise.all([deps.config(projectId), deps.groupsOf(projectId)]);
      return ok(
        config.roles.map((r) => ({
          ...r,
          groups: groups.filter((g) => g.members.includes(r.name) || g.hostRole === r.name).map((g) => ({ id: g.id, name: g.name, host: g.hostRole === r.name }))
        }))
      );
    },

    async create(actor, projectId, input) {
      const project = await allowed(actor, projectId, 'project.update');
      if (!project.ok) return project;
      const name = String(input.name ?? '').trim();
      if (!isPersistentAgentName(name)) return err(invalid('@id 只能用小写字母、数字、- 和 _，字母或数字开头（最多 40 个字符）'));
      const config = await deps.config(projectId);
      if (config.roles.some((r) => r.name === name)) return err(invalid(`@${name} 已经有了，换一个 @id`));
      const agent = clean({ name, displayName: input.displayName, color: input.color, description: input.description ?? '', agentId: input.agentId, model: input.model ?? '', reuse: input.reuse ?? 'sticky' });
      const saved = await save(projectId, config, [...config.roles, agent]);
      return saved.ok ? ok(agent) : saved;
    },

    async update(actor, projectId, name, patch) {
      const project = await allowed(actor, projectId, 'project.update');
      if (!project.ok) return project;
      const config = await deps.config(projectId);
      const current = config.roles.find((r) => r.name === name);
      if (!current) return err(notFound(`没有 bot @${name}`));
      const next = clean({
        ...current,
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.agentId !== undefined ? { agentId: patch.agentId } : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.reuse !== undefined ? { reuse: patch.reuse } : {}),
        name
      });
      const saved = await save(projectId, config, config.roles.map((r) => (r.name === name ? next : r)));
      return saved.ok ? ok(next) : saved;
    },

    async remove(actor, projectId, name) {
      const project = await allowed(actor, projectId, 'project.update');
      if (!project.ok) return project;
      const config = await deps.config(projectId);
      if (!config.roles.some((r) => r.name === name)) return err(notFound(`没有 bot @${name}`));
      const saved = await save(projectId, config, config.roles.filter((r) => r.name !== name));
      if (!saved.ok) return saved;
      const affected = await deps.detach(actor, projectId, name);
      return ok({ removedFrom: affected.map((g) => ({ id: g.id, name: g.name })) });
    }
  };
}
