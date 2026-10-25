import type { Session } from '../session.ts';
import { workspaceFor, type Project } from '../project.ts';
import { asSessionId } from '../ids.ts';
import type { DomainError } from '../errors.ts';
import { notFound } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { WorkerCommand } from '../ports/node-gateway.ts';
import { placeSession } from '../worker.ts';
import type { Deps } from './deps.ts';

type StartCommand = Extract<WorkerCommand, { kind: 'start_session' }>;

/**
 * 拼一条 start_session 指令。派生、分叉、重新托管三处都走这里，
 * 所以「模型既是一列、也是一个可调项」这件事只在一个地方处理：
 * 会话的 model 总会并进 options.model，worker 只认 options。
 */
export function startCommand(
  session: Session & { readonly workerId: string },
  project: Project,
  resume: StartCommand['resume'],
  inherited: Readonly<Record<string, string | boolean>> = session.options
): StartCommand {
  const options = session.model === '' ? { ...inherited } : { ...inherited, model: session.model };
  return {
    kind: 'start_session',
    sessionId: session.id,
    workerId: session.workerId,
    taskId: session.taskId,
    agentId: session.agentId,
    workspaceRoot: workspaceFor(project, session.workerId).root,
    origin: session.origin,
    resume,
    options
  };
}

export async function projectOf(
  deps: Pick<Deps, 'tasks' | 'projects'>,
  session: Session
): Promise<Project | null> {
  const task = await deps.tasks.byId(session.taskId);
  return task ? deps.projects.byId(task.projectId) : null;
}

/**
 * 会话跑完就没人托管它了（worker 那边已经 dispose）。
 * 想再对它做任何事（说话、改模型），都得先把 agent 按上次的位置重新拉起来——
 * 这就是 S7.1「重开浏览器还能接着干活」。
 */
export async function ensureHosted(
  deps: Pick<Deps, 'hosting' | 'tasks' | 'projects' | 'gateway' | 'sessions'>,
  session: Session
): Promise<Result<void, DomainError>> {
  if (deps.hosting.has(session.id)) return ok(undefined);
  const project = await projectOf(deps, session);
  if (!project) return err(notFound('会话所属任务或项目不存在'));
  // resume 必须回到原来那台：agent 的会话文件只在那台机器上。
  // 老会话（多机之前建的）没有落点，这里补落一次并记下来，以后就钉在那台上了。
  let placed: Session & { readonly workerId: string };
  if (session.workerId !== null) {
    placed = { ...session, workerId: session.workerId };
  } else {
    const chosen = placeSession(await deps.gateway.status(), {
      agentId: session.agentId,
      requested: null,
      projectWorker: project.workerId
    });
    if (!chosen.ok) return chosen;
    placed = { ...session, workerId: chosen.value };
    await deps.sessions.save(placed);
  }
  const resumed = await deps.gateway.dispatch(
    startCommand(placed, project, { agentSessionRef: session.agentSessionRef, cursor: session.lastSeq })
  );
  if (!resumed.ok) return resumed;
  deps.hosting.add(session.id, placed.workerId);
  return ok(undefined);
}

export async function interruptSessionUseCase(
  deps: Pick<Deps, 'gateway'>,
  sessionId: string
): Promise<Result<void, DomainError>> {
  return deps.gateway.dispatch({ kind: 'interrupt', sessionId: asSessionId(sessionId) });
}

