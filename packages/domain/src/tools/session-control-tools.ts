import { forbidden, invalid, notFound, type DomainError } from '../errors.ts';
import { asSessionId } from '../ids.ts';
import type { ToolDescriptor, ToolProvider } from '../ports/tool-provider.ts';
import { err, ok, type Result } from '../result.ts';
import type { Session } from '../session.ts';
import type { SessionRepository } from '../ports/session-repository.ts';
import { projectOfSession, type ProjectLookupDeps } from '../use-cases/workspaces.ts';
import type { DeriveCommand } from '../use-cases/sessions.ts';

/**
 * session.derive / session.stop（issue #216 P1）：agent 自己分叉出一条会话、或收掉一条跑偏的会话。
 *
 * 权限：调用方必须是「同一条会话」或「同一个项目」，否则拒绝——不泄露别的项目里有哪些会话。
 * 血缘：派生出的会话沿用调用方的任务（容器会话给项目）、运行时/模型/工作空间与 bot 归属，
 * 由领域用例写成一次普通派生（同任务下的另一条会话），不复制对话内容。
 */
export const SESSION_CONTROL_TOOLS: readonly ToolDescriptor[] = [
  {
    name: 'session.derive',
    version: 1,
    scope: 'session:control',
    perMinute: 6,
    description:
      'Start a new session next to this one (same task, project, workspace and runtime/model) and get its id. Use it to split off a side exploration without losing this conversation. The new session starts empty: tell it what to do by messaging it (agent.send) or by telling the user. Returns {session_id, task_id, project_id}.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 80, description: 'Optional display title for the new session.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'session.stop',
    version: 1,
    scope: 'session:control',
    perMinute: 6,
    description:
      'Stop one running session in this project (the current turn is interrupted; the session stays readable). Omit session_id to stop this session. Use it when another session is clearly off track. Refuses sessions in other projects.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', minLength: 1, description: 'Target session id; default = this session.' }
      },
      additionalProperties: false
    }
  }
];

export interface SessionControlToolDeps extends ProjectLookupDeps {
  readonly sessions: Pick<SessionRepository, 'byId'>;
  /** 派生一条会话（server 装配时注入 deriveSessionUseCase，避免工具层直接抓整个 Deps）。 */
  readonly derive: (command: DeriveCommand) => Promise<Result<Session, DomainError>>;
  /** 中断一条会话（server 装配时注入 interruptSessionUseCase）。 */
  readonly interrupt: (sessionId: string) => Promise<Result<void, DomainError>>;
  /** 会话改了标题之后同步（可选）：renameSessionUseCase。 */
  readonly rename?: (command: { readonly sessionId: string; readonly title: string }) => Promise<Result<Session, DomainError>>;
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export function createSessionControlToolProvider(deps: SessionControlToolDeps): ToolProvider {
  const projectOf = async (session: Session) => projectOfSession(deps, session);

  return {
    id: 'session-control',
    tools: () => SESSION_CONTROL_TOOLS,
    async call(name, input, ctx): Promise<Result<unknown, DomainError>> {
      const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      const caller = await deps.sessions.byId(ctx.grant.sessionId);
      if (!caller) return err(notFound('找不到这条会话'));

      if (name === 'session.derive') {
        const title = str(args.title).replace(/\s+/g, ' ').slice(0, 80);
        const callerProject = await projectOf(caller);
        const derived = await deps.derive({
          ...(caller.taskId === null ? {} : { taskId: caller.taskId }),
          ...(callerProject === null ? {} : { projectId: callerProject.id }),
          agentId: caller.agentId,
          model: caller.model,
          ref: { runtime: caller.agentId, model: caller.model, options: caller.options },
          workspaceId: caller.workspaceId,
          workerId: caller.workerId,
          botId: caller.botId ?? null,
          createdBy: caller.createdBy,
          actor: null
        });
        if (!derived.ok) return derived;
        if (title !== '' && deps.rename) await deps.rename({ sessionId: derived.value.id, title });
        const project = await projectOf(derived.value);
        return ok({ session_id: derived.value.id, task_id: derived.value.taskId, project_id: project?.id ?? null, title: title === '' ? null : title });
      }

      if (name === 'session.stop') {
        const raw = str(args.session_id);
        const target = raw === '' ? caller : await deps.sessions.byId(asSessionId(raw));
        if (!target) return err(notFound('找不到这条会话'));
        if (target.id !== caller.id) {
          const [mine, theirs] = [await projectOf(caller), await projectOf(target)];
          if (mine === null || theirs === null || mine.id !== theirs.id) {
            return err(forbidden('只能停止同一个项目里的会话'));
          }
        }
        if (target.status !== 'running') return ok({ session_id: target.id, stopped: false, reason: '这条会话不在运行' });
        const stopped = await deps.interrupt(target.id);
        if (!stopped.ok) return stopped;
        return ok({ session_id: target.id, stopped: true });
      }

      return err(invalid(`没有这个工具：${name}`));
    }
  };
}
