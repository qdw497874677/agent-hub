import { applyEvent, deriveSession, forkSession, markInterrupted } from '../session.ts';
import type { Session } from '../session.ts';
import type { Seq, SessionId } from '../ids.ts';
import { asAgentId, asSessionId } from '../ids.ts';
import type { DomainError } from '../errors.ts';
import { conflict, notFound } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import { createArtifact } from '../artifact.ts';
import type { SessionEvent } from '../event.ts';
import type { Deps } from './deps.ts';

export interface DeriveCommand {
  readonly taskId: string;
  readonly agentId: string;
  readonly model: string;
}

/** 派生会话：唯一入口，且必须落到一个 Task 上（S5.1）。 */
export async function deriveSessionUseCase(
  deps: Deps,
  command: DeriveCommand
): Promise<Result<Session, DomainError>> {
  const task = await deps.tasks.byId(command.taskId as never);
  if (!task) return err({ code: 'not_found', message: '任务不存在' });
  const project = await deps.projects.byId(task.projectId);
  if (!project) return err({ code: 'not_found', message: '项目不存在' });

  const agentId = asAgentId(command.agentId);
  const runtime = deps.agents.runtime(agentId);
  if (!runtime) return err(conflict(`未安装的 agent：${command.agentId}`));
  if (runtime.descriptor.capabilities.prompt.state === 'denied') {
    return err(conflict(runtime.descriptor.capabilities.prompt.reason ?? '该 agent 不可发送消息'));
  }

  const created = deriveSession({
    task,
    agentId,
    model: command.model,
    now: deps.now()
  });
  if (!created.ok) return created;

  const session = created.value;
  await deps.sessions.save(session);

  const dispatched = await deps.gateway.dispatch({
    kind: 'start_session',
    sessionId: session.id,
    taskId: session.taskId,
    agentId: session.agentId,
    model: session.model,
    workspaceRoot: project.rootPath,
    origin: session.origin,
    resume: null
  });
  if (!dispatched.ok) {
    const failed: Session = { ...session, status: 'failed', updatedAt: deps.now() };
    await deps.sessions.save(failed);
    return err(dispatched.error);
  }
  return ok(session);
}

export interface ForkCommand {
  readonly sessionId: string;
  readonly atSeq: Seq;
  readonly agentId: string;
  readonly model: string;
}

export async function forkSessionUseCase(
  deps: Deps,
  command: ForkCommand
): Promise<Result<Session, DomainError>> {
  const source = await deps.sessions.byId(asSessionId(command.sessionId));
  if (!source) return err(notFound('来源会话不存在'));

  const sourceRuntime = deps.agents.runtime(source.agentId);
  const forkCap = sourceRuntime?.descriptor.capabilities.fork;
  if (!forkCap || forkCap.state === 'denied') {
    return err(conflict(forkCap?.reason ?? '该 agent 不支持会话分叉，所以不能作为血缘起点'));
  }

  const sourceTask = await deps.tasks.byId(source.taskId);
  if (!sourceTask) return err(notFound('来源会话所属的任务不存在'));
  const project = await deps.projects.byId(sourceTask.projectId);
  if (!project) return err(notFound('项目不存在'));

  const agentId = asAgentId(command.agentId);
  const runtime = deps.agents.runtime(agentId);
  if (!runtime) return err(conflict(`未安装的 agent：${command.agentId}`));

  const created = forkSession({
    source,
    atSeq: command.atSeq,
    agentId,
    model: command.model,
    now: deps.now()
  });
  if (!created.ok) return created;

  const session = created.value;
  await deps.sessions.save(session);

  const dispatched = await deps.gateway.dispatch({
    kind: 'start_session',
    sessionId: session.id,
    taskId: session.taskId,
    agentId: session.agentId,
    model: session.model,
    workspaceRoot: project.rootPath,
    origin: session.origin,
    resume: { agentSessionRef: source.agentSessionRef, cursor: command.atSeq }
  });
  if (!dispatched.ok) {
    await deps.sessions.save({ ...session, status: 'failed', updatedAt: deps.now() });
    return err(dispatched.error);
  }
  return ok(session);
}

export interface RecordEventCommand {
  readonly sessionId: SessionId;
  readonly event: SessionEvent;
}

/** 事件落盘 + 广播。seq 由平台分配，worker 不参与编号。 */
export async function recordEvent(
  deps: Deps,
  command: RecordEventCommand
): Promise<Result<Session, DomainError>> {
  const session = await deps.sessions.byId(command.sessionId);
  if (!session) return err({ code: 'not_found', message: '会话不存在' });

  const now = deps.now();
  const next = applyEvent(session, command.event, now);
  await deps.sessions.append(next, command.event, now);

  if (command.event.kind === 'artifact') {
    const artifact = createArtifact({
      sessionId: session.id,
      taskId: session.taskId,
      path: command.event.path,
      bytes: command.event.bytes,
      now
    });
    if (artifact.ok) await deps.artifacts.save(artifact.value);
  }

  deps.stream.publish({
    sessionId: session.id,
    seq: next.lastSeq,
    event: command.event,
    status: next.status
  });
  return ok(next);
}

/** 启动对账：仍在 running 的会话一律降级为 interrupted（S7.1）。 */
export async function reconcileInterrupted(deps: Deps): Promise<number> {
  const all = await deps.sessions.listAll();
  let changed = 0;
  for (const session of all) {
    if (session.status !== 'running') continue;
    const next = markInterrupted(session, deps.now());
    await deps.sessions.save(next);
    changed += 1;
  }
  return changed;
}
