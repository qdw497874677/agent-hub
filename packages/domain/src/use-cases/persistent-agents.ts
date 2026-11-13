import type { Principal } from '../account.ts';
import { invalid, notFound, type DomainError } from '../errors.ts';
import type { ProjectId } from '../ids.ts';
import {
  configProblem,
  isPersistentAgentName,
  type MessageLimits,
  type MessagingConfig,
  type PersistentAgent,
  type RoleReuse
} from '../messaging.ts';
import { validateAgentRef } from '../agent-ref.ts';
import type { RuntimeOption } from '../option.ts';
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
  readonly options?: Readonly<Record<string, string | boolean>>;
}
export type PersistentAgentPatch = Partial<Omit<PersistentAgentInput, 'name'>>;

export interface PersistentAgentView extends PersistentAgent {
  /** 引用它的群（id + 名字）。 */
  readonly groups: readonly { id: string; name: string; host: boolean }[];
}

export interface PersistentAgentsDeps extends Pick<Deps, 'projects' | 'sessions'> {
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

/**
 * 这个项目里该 agent 上报过的可调项（按 id 去重，取自各会话的 `optionSpec`）。
 * agent 的静态 descriptor 只带 models，选项清单要等会话握手后才有，所以只能从已有会话里学。
 */
async function observedOptions(deps: PersistentAgentsDeps, projectId: ProjectId, agentId: string): Promise<readonly RuntimeOption[]> {
  const seen = new Map<string, RuntimeOption>();
  for (const session of await deps.sessions.listByProject(projectId)) {
    if (session.agentId !== agentId) continue;
    for (const option of session.optionSpec) if (!seen.has(option.id)) seen.set(option.id, option);
  }
  return [...seen.values()];
}

/** 输入的扁平形状（HTTP body 保持 agentId/model/options）；落库前统一成 ref。 */
interface CleanInput {
  readonly name: string;
  readonly displayName?: string;
  readonly color?: string;
  readonly description: string;
  readonly agentId: string;
  readonly model: string;
  readonly reuse: RoleReuse;
  readonly options?: Readonly<Record<string, string | boolean>>;
}

const clean = (a: CleanInput): PersistentAgent => {
  const displayName = a.displayName?.trim();
  return {
    name: a.name.trim(),
    ...(displayName ? { displayName } : {}),
    ...(a.color ? { color: a.color } : {}),
    description: a.description,
    ref: {
      runtime: (a.agentId ?? '').trim(),
      model: (a.model ?? '').trim(),
      options: { ...(a.options ?? {}) }
    },
    reuse: a.reuse
  };
};

/**
 * 拿这个 agent 上报过的可调项再校一遍 ref。runtime 为空时跳过后端选项校验，
 * 让 configProblem 报「角色 x 要指定 agent」这种更好懂的错。
 */
async function refProblem(deps: PersistentAgentsDeps, projectId: ProjectId, agent: PersistentAgent): Promise<string | null> {
  if (agent.ref.runtime === '') return null;
  const checked = validateAgentRef(agent.ref, await observedOptions(deps, projectId, agent.ref.runtime));
  return checked.ok ? null : checked.error.message;
}

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
      const agent = clean({
        name,
        displayName: input.displayName,
        color: input.color,
        description: input.description ?? '',
        agentId: input.agentId,
        model: input.model ?? '',
        reuse: input.reuse ?? 'sticky',
        ...(input.options !== undefined ? { options: input.options } : {})
      });
      const specProblem = await refProblem(deps, projectId, agent);
      if (specProblem) return err(invalid(`bot ${name} 的${specProblem}`));
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
        displayName: patch.displayName !== undefined ? patch.displayName : current.displayName,
        color: patch.color !== undefined ? patch.color : current.color,
        description: patch.description !== undefined ? patch.description : current.description,
        agentId: patch.agentId ?? current.ref.runtime,
        model: patch.model ?? current.ref.model,
        reuse: patch.reuse ?? current.reuse,
        options: patch.options ?? current.ref.options,
        name
      });
      const specProblem = await refProblem(deps, projectId, next);
      if (specProblem) return err(invalid(`bot ${name} 的${specProblem}`));
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
