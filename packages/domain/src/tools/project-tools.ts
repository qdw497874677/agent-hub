import { forbidden, invalid, notFound, type DomainError } from '../errors.ts';
import type { Project } from '../project.ts';
import type { ToolDescriptor, ToolProvider } from '../ports/tool-provider.ts';
import type { SessionRepository } from '../ports/session-repository.ts';
import { err, ok, type Result } from '../result.ts';
import type { Session } from '../session.ts';
import type { Deps } from '../use-cases/deps.ts';
import { locationOf, projectOfSession, type ProjectLookupDeps } from '../use-cases/workspaces.ts';
import type { Subject } from '../access.ts';
import { authorizeProject } from '../use-cases/authorization.ts';

/**
 * project.update / run.checks（issue #216 P1）：把项目约定写回平台、在机器上跑项目声明的检查命令。
 *
 * 为什么检查命令要由平台跑：agent 自己 shell 跑测试，退出码与输出只留在它自己的对话里；
 * 走平台后 hub 能看到结构化结果（命令 / exitCode / 是否超时 / 末尾输出），人也能在任务里复核。
 * 命令来自项目配置（`Project.checks`），工具入参里没有「随便跑一条命令」的自由参数。
 */
export const PROJECT_TOOLS: readonly ToolDescriptor[] = [
  {
    name: 'project.update',
    version: 1,
    scope: 'project',
    perMinute: 6,
    description:
      'Update this project: its markdown description and/or its check commands (max 5, one per line, each ≤300 chars). Only what you pass changes. Requires project.update permission (project owner or sharer able to edit). Returns the updated project summary.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: ['string', 'null'], maxLength: 8000, description: 'Markdown project notes; null clears it.' },
        checks: {
          type: 'array',
          maxItems: 5,
          items: { type: 'string', maxLength: 300 },
          description: 'Commands to verify this project, run in order (e.g. "npm run typecheck"). Empty array clears them.'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'run.checks',
    version: 1,
    scope: 'project',
    perMinute: 3,
    description:
      'Run this project\'s declared check commands in this session\'s working directory on its machine, in order, stopping at the first failure. Returns [{command, exit_code, timed_out, output}] where output is the tail (max 8KB) and credentials are scrubbed. If the project declares no checks, returns ran=false — do not guess commands, ask the user to add them.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

export const CHECK_TIMEOUT_MS = 10 * 60_000;

export interface ProjectToolDeps extends ProjectLookupDeps {
  readonly workspaces: Deps['workspaces'];
  readonly workspaceGroups: Deps['workspaceGroups'];
  readonly sessions: Pick<SessionRepository, 'byId'>;
  readonly access: Deps['access'];
  /** 以谁的名义改项目（工具授权里冻结的 actor → principal）。 */
  readonly subjectOf: (sessionId: import('../ids.ts').SessionId) => Promise<Subject | null>;
  readonly gateway: Deps['gateway'];
  readonly update: (input: {
    readonly projectId: string;
    readonly description?: string | null;
    readonly checks?: readonly string[];
  }) => Promise<Result<Project, DomainError>>;
}

export function createProjectToolProvider(deps: ProjectToolDeps): ToolProvider {
  const callerProject = async (session: Session): Promise<Result<Project, DomainError>> => {
    const project = await projectOfSession(deps, session);
    return project ? ok(project) : err(invalid('这条会话不属于任何项目：先把会话落到一个项目的工作目录里'));
  };

  return {
    id: 'project',
    tools: () => PROJECT_TOOLS,
    async call(name, input, ctx): Promise<Result<unknown, DomainError>> {
      const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      const session = await deps.sessions.byId(ctx.grant.sessionId);
      if (!session) return err(notFound('找不到这条会话'));

      const owned = await callerProject(session);
      if (!owned.ok) return owned;
      const project = owned.value;

      if (name === 'project.update') {
        const subject = await deps.subjectOf(ctx.grant.sessionId);
        const allowed = await authorizeProject(deps.access, subject, project, 'project.update');
        if (!allowed.ok) return err(forbidden('改不了这个项目：需要能改这个项目的权限（创建者、被共享的人或团队 owner / admin）'));

        const patch: { description?: string | null; checks?: readonly string[] } = {};
        if (args.description !== undefined) {
          if (args.description !== null && typeof args.description !== 'string') return err(invalid('description 要是字符串或 null'));
          patch.description = args.description as string | null;
        }
        if (args.checks !== undefined) {
          if (!Array.isArray(args.checks)) return err(invalid('checks 要是字符串数组'));
          patch.checks = args.checks as string[];
        }
        if (patch.description === undefined && patch.checks === undefined) return err(invalid('没有要改的东西：给 description 或 checks'));

        const updated = await deps.update({ projectId: project.id, ...patch });
        if (!updated.ok) return updated;
        return ok({
          id: updated.value.id,
          name: updated.value.name,
          description: updated.value.description,
          checks: updated.value.checks
        });
      }

      if (name === 'run.checks') {
        const subject = await deps.subjectOf(ctx.grant.sessionId);
        const allowed = await authorizeProject(deps.access, subject, project, 'project.update');
        if (!allowed.ok) return err(forbidden('跑不了这个项目的检查命令：需要能改这个项目的权限（创建者、被共享的人或团队 owner / admin）'));
        const checks = project.checks;
        if (checks.length === 0) {
          return ok({ ran: false, project_id: project.id, checks: [], reason: '这个项目还没有声明检查命令：请项目所有者先在项目设置里加上（最多 5 条）' });
        }
        const location = await locationOf(deps, project, session);
        if (location.root === '' || location.workerId === null) {
          return err(invalid('这条会话没有可用的工作目录：先关联或创建一个工作目录'));
        }
        const git = deps.gateway.git(location.workerId);
        const results: Array<{ command: string; exit_code: number; timed_out: boolean; output: string }> = [];
        for (const command of checks) {
          const ran = await git.runSetup({ path: location.root, command, timeoutMs: CHECK_TIMEOUT_MS });
          if (!ran.ok) return ran;
          results.push({ command, exit_code: ran.value.exitCode, timed_out: ran.value.timedOut, output: ran.value.output });
          if (ran.value.exitCode !== 0) break;
        }
        return ok({ ran: true, project_id: project.id, checks: results, passed: results.every((r) => r.exit_code === 0) });
      }

      return err(notFound(`没有这个工具：${name}`));
    }
  };
}
