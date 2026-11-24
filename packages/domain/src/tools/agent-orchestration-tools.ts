import { forbidden, invalid, notFound, notImplemented, type DomainError } from '../errors.ts';
import { asAgentId, asSessionId, asTaskId } from '../ids.ts';
import type { TaskId } from '../ids.ts';
import type { AgentProfileRepository } from '../ports/agent-profile-repository.ts';
import type { ToolContext, ToolDescriptor, ToolProvider } from '../ports/tool-provider.ts';
import { err, ok, type Result } from '../result.ts';
import { isContainerSession, type Session } from '../session.ts';
import type { AgentDescriptor } from '../agent.ts';
import type { Deps } from '../use-cases/deps.ts';
import { agentProfileForUse } from '../use-cases/agent-profiles.ts';

/** 编排 agent 动作的服务端实现；留空时工具返回 notImplemented，方便单测和裁剪部署。 */
export interface SpawnAgentAction {
  readonly taskId: string;
  readonly agentId: string;
  readonly model: string;
  readonly options: Readonly<Record<string, string | boolean>>;
  /** 现建临时空间的档位：`isolated` = 新开 worktree（按项目配置跑准备命令），`shared` = 每次现建一个落在长期目录旁的临时空间。不传 = 用项目默认工作空间。 */
  readonly workspaceMode?: 'shared' | 'isolated';
  /** 会话通信 P1b：一仓一会话（项目里某个仓库的隔离 worktree）、落到哪台机器、任务内短名。 */
  readonly repoId?: string;
  readonly workerId?: string;
  readonly handle?: string;
  readonly prompt?: string;
  /** 父会话的主人：新会话继承它，profile 和权限都按它算。 */
  readonly createdBy: string | null;
  readonly callerSessionId: string;
}

export interface SpawnedAgent {
  readonly sessionId: string;
  /** 派生出的会话挂在哪个任务上；容器会话（#221 步骤 7）没有任务，为 null。 */
  readonly taskId: string | null;
  readonly agentId: string;
  readonly model: string;
  readonly status: string;
  readonly handle?: string;
  readonly workspaceId?: string | null;
}

export interface OrchestrationActions {
  readonly spawn?: (input: SpawnAgentAction) => Promise<Result<SpawnedAgent, DomainError>>;
  readonly setOption?: (sessionId: string, optionId: string, value: string | boolean) => Promise<Result<Session, DomainError>>;
}

export interface OrchestrationDeps extends OrchestrationActions {
  readonly agentProfiles?: AgentProfileRepository;
  readonly now: () => number;
  readonly sessions: Pick<Deps['sessions'], 'byId' | 'listByProject'>;
  readonly tasks: Pick<Deps['tasks'], 'byId'>;
  readonly projects: Pick<Deps['projects'], 'byId'>;
  readonly agents: Pick<Deps['agents'], 'list' | 'descriptor'>;
}

const record = (input: unknown): Record<string, unknown> =>
  input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};

const str = (value: unknown, max = 2000): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : undefined;

const values = (raw: unknown): Result<Record<string, string | boolean>, DomainError> => {
  if (raw === undefined) return ok({});
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return err(invalid('options 必须是对象'));
  const out: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || key.length > 200) return err(invalid('option 名不能为空且不超过 200 字'));
    if (typeof value === 'string') out[key] = value.slice(0, 2000);
    else if (typeof value === 'boolean') out[key] = value;
    else return err(invalid(`option ${key} 只能是字符串或布尔值`));
  }
  return ok(out);
};

const summary = (session: Session): Record<string, unknown> => ({
  session_id: session.id,
  task_id: session.taskId,
  agent_id: session.agentId,
  model: session.model,
  status: session.status,
  title: session.title ?? null,
  last_seq: session.lastSeq,
  created_by: session.createdBy ?? null,
  updated_at: session.updatedAt
});

const runtimeSummary = (agent: AgentDescriptor): Record<string, unknown> => ({
  id: agent.id,
  label: agent.label,
  default_model: agent.defaultModel,
  models: agent.models.length,
  options: agent.options.map((option) => ({ id: option.id, label: option.label, category: option.category, current: option.current })),
  capabilities: agent.capabilities
});

const runtimeDetail = (agent: AgentDescriptor): Record<string, unknown> => ({
  ...runtimeSummary(agent),
  model_ids: agent.models,
  option_spec: agent.options
});

export const AGENT_ORCHESTRATION_TOOLS: readonly ToolDescriptor[] = [
  {
    name: 'agent.list_profiles',
    version: 1,
    scope: 'agent:message',
    perMinute: 30,
    description:
      'List the reusable Agent Profiles owned by the human who started this session. A profile bundles an agent runtime, model and options; pass its id to agent.spawn to start a sibling session with the same setup.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'agent.inspect_runtime',
    version: 1,
    scope: 'agent:message',
    perMinute: 30,
    description:
      'Inspect the agent runtimes (Claude Code, Codex, OpenCode, Pi, ...) available in this hub. Without agent_id it returns a compact summary; with agent_id it returns models and full option specs. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { agent_id: { type: 'string', minLength: 1, maxLength: 120 } },
      additionalProperties: false
    }
  },
  {
    name: 'agent.activity',
    version: 1,
    scope: 'agent:message',
    perMinute: 30,
    description:
      'List sessions in the same project as this one with their status, model, agent, title and last sequence. Use it to find another session to message or inspect. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'agent.spawn',
    version: 1,
    scope: 'agent:message',
    perMinute: 6,
    description:
      'Start a sibling session in the same task (optionally from an Agent Profile) and optionally send it an initial prompt. This is a thin wrapper around the normal session/derive + prompt flow: the same worker, workspace and permission rules apply. Pass workspace_mode=isolated to run it in a fresh git worktree (the project setup command runs first) instead of the shared workspace. Pass repo_id to give it its own worktree of just that project repo (one repo per session), worker_id to place it on a specific machine, and handle to name it (peers reach it as "peer:<handle>"). The new session is linked to you automatically, so you can agent.ask it right away. Returns the new session id and handle.',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', minLength: 1, maxLength: 120 },
        agent_id: { type: 'string', minLength: 1, maxLength: 120 },
        model: { type: 'string', maxLength: 2000 },
        options: { type: 'object', additionalProperties: { type: ['string', 'boolean'] } },
        workspace_mode: {
          type: 'string',
          enum: ['shared', 'isolated'],
          description: 'Workspace preparation mode. Preparation defaults to the caller session\'s recorded worker; if none is recorded, pass worker_id explicitly.'
        },
        repo_id: { type: 'string', minLength: 1, maxLength: 80, description: 'Project repo id or name: open a dedicated worktree of just this repo.' },
        worker_id: {
          type: 'string',
          minLength: 1,
          maxLength: 120,
          description: 'Machine to run on (must be usable by the session owner). For workspace_mode/repo_id preparation it defaults to the caller session\'s recorded worker (or its validated workspace binding); when that is unset/unknown it is required — the Hub machine is never assumed.'
        },
        handle: { type: 'string', minLength: 2, maxLength: 32, description: 'Short name in this task; others address it as peer:<handle>.' },
        prompt: { type: 'string', minLength: 1, maxLength: 32768 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'agent.set_option',
    version: 1,
    scope: 'agent:message',
    perMinute: 10,
    description:
      'Change one runtime option (for example model, agent/mode or thought level) on a session in the same project that belongs to the same owner. Only options the runtime reported are valid; the runtime remains the authority and reports the new full state back.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', minLength: 1 },
        option_id: { type: 'string', minLength: 1, maxLength: 200 },
        value: { type: ['string', 'boolean'] }
      },
      required: ['session_id', 'option_id', 'value'],
      additionalProperties: false
    }
  }
];

export function createAgentOrchestrationToolProvider(deps: OrchestrationDeps): ToolProvider {
  const callerOf = async (ctx: ToolContext): Promise<Result<Session, DomainError>> => {
    const session = await deps.sessions.byId(asSessionId(ctx.grant.sessionId));
    return session ? ok(session) : err(notFound('当前会话不存在'));
  };

  return {
    id: 'agent-orchestration',
    tools: () => AGENT_ORCHESTRATION_TOOLS,
    async call(name, input, ctx): Promise<Result<unknown, DomainError>> {
      const caller = await callerOf(ctx);
      if (!caller.ok) return caller;
      const me = caller.value;
      const args = record(input);

      if (name === 'agent.list_profiles') {
        if (!deps.agentProfiles) return err(notImplemented('Agent 配置'));
        const rows = await deps.agentProfiles.listByOwner(me.createdBy ?? null);
        return ok({ profiles: rows.map((profile) => ({ ...profile })) });
      }

      if (name === 'agent.inspect_runtime') {
        const agentId = str(args['agent_id'], 120);
        if (agentId) {
          const descriptor = deps.agents.descriptor(asAgentId(agentId));
          if (!descriptor) return err(notFound(`没有在线节点提供 ${agentId}`));
          return ok({ runtime: runtimeDetail(descriptor) });
        }
        return ok({ runtimes: deps.agents.list().map(runtimeSummary) });
      }

      if (name === 'agent.activity') {
        if (isContainerSession(me)) return err(forbidden('这条会话不属于任何任务，看不到任务级活动'));
        const task = await deps.tasks.byId(me.taskId as TaskId);
        if (!task) return err(notFound('当前任务不存在'));
        const sessions = await deps.sessions.listByProject(task.projectId);
        const limit = typeof args['limit'] === 'number' && Number.isInteger(args['limit'])
          ? Math.max(1, Math.min(100, args['limit']))
          : 50;
        return ok({ sessions: sessions.slice(0, limit).map(summary) });
      }

      if (name === 'agent.spawn') {
        if (!deps.spawn) return err(notImplemented('派生会话'));
        const taskId = me.taskId as TaskId;
        const task = await deps.tasks.byId(asTaskId(taskId));
        if (!task) return err(notFound('当前任务不存在'));
        const project = await deps.projects.byId(task.projectId);
        if (!project) return err(notFound('当前项目不存在'));

        let agentId = str(args['agent_id'], 120) ?? me.agentId;
        let model = str(args['model']) ?? '';
        let options = values(args['options']);
        if (!options.ok) return options;

        const profileId = str(args['profile_id'], 120);
        if (profileId) {
          const profile = await agentProfileForUse(deps, me.createdBy ?? null, profileId);
          if (!profile.ok) return profile;
          agentId = profile.value.ref.runtime;
          model = profile.value.ref.model;
          options = ok({ ...profile.value.ref.options, ...options.value });
        }
        // 没指定模型、也没用 profile、还是同一个运行时：沿用发起方的模型（不然落到运行时默认，可能根本没配）
        if (!model && !profileId && agentId === me.agentId && me.model) model = me.model;
        if (!deps.agents.descriptor(asAgentId(agentId))) return err(notFound(`没有在线节点提供 ${agentId}`));

        const rawMode = args['workspace_mode'];
        if (rawMode !== undefined && rawMode !== 'shared' && rawMode !== 'isolated') {
          return err(invalid('workspace_mode 只能是 shared 或 isolated'));
        }
        const prompt = str(args['prompt'], 32768);
        const repoId = str(args['repo_id'], 80);
        const workerId = str(args['worker_id'], 120);
        const handle = str(args['handle'], 32);
        if (repoId && rawMode === 'shared') return err(invalid('repo_id 会新开 worktree，不能和 workspace_mode=shared 一起用'));
        const started = await deps.spawn({
          ...(repoId ? { repoId } : {}),
          ...(workerId ? { workerId } : {}),
          ...(handle ? { handle } : {}),
          taskId,
          agentId,
          model,
          options: options.value,
          ...(rawMode === undefined ? {} : { workspaceMode: rawMode }),
          ...(prompt ? { prompt } : {}),
          createdBy: me.createdBy ?? null,
          callerSessionId: me.id
        });
        return started;
      }

      if (name === 'agent.set_option') {
        if (!deps.setOption) return err(notImplemented('修改运行选项'));
        const sessionId = str(args['session_id'], 120);
        const optionId = str(args['option_id'], 200);
        const value = args['value'];
        if (!sessionId || !optionId) return err(invalid('session_id 和 option_id 必填'));
        if (typeof value !== 'string' && typeof value !== 'boolean') return err(invalid('value 只能是字符串或布尔值'));
        const target = await deps.sessions.byId(asSessionId(sessionId));
        if (!target) return err(notFound('会话不存在'));
        const mine = isContainerSession(me) ? null : await deps.tasks.byId(me.taskId as TaskId);
        const theirs = isContainerSession(target) ? null : await deps.tasks.byId(target.taskId as TaskId);
        if (!mine || !theirs || mine.projectId !== theirs.projectId) return err(forbidden('只能改同项目会话的选项'));
        if (target.createdBy !== me.createdBy) return err(forbidden('只能改自己开的会话的选项'));
        return deps.setOption(target.id, optionId, value);
      }

      return err(notFound(`没有这个工具：${name}`));
    }
  };
}

