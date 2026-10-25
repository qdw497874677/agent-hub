import { applyEvent, deriveSession, forkSession, markInterrupted, withOptions } from '../session.ts';
import type { Session } from '../session.ts';
import type { RuntimeOption } from '../option.ts';
import type { Seq, SessionId } from '../ids.ts';
import { asAgentId, asSessionId, asTaskId } from '../ids.ts';
import type { DomainError } from '../errors.ts';
import { conflict, notFound } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import { createArtifact } from '../artifact.ts';
import type { SessionEvent } from '../event.ts';
import type { Deps } from './deps.ts';
import { ensureHosted, startCommand } from './hosting.ts';
import { placeSession } from '../worker.ts';
import { markStarted } from '../task.ts';
import { recordSystemLog } from './work-log.ts';

export interface DeriveCommand {
  readonly taskId: string;
  readonly agentId: string;
  readonly model: string;
  /** 人在对话框里点名的 Worker；不点名就由落点规则挑。 */
  readonly workerId?: string | null;
}

/** 派生会话：唯一入口，且必须落到一个 Task 上（S5.1）。 */
export async function deriveSessionUseCase(
  deps: Pick<Deps, 'agents' | 'gateway' | 'hosting' | 'now' | 'projects' | 'sessions' | 'tasks' | 'workLog'>,
  command: DeriveCommand
): Promise<Result<Session, DomainError>> {
  const task = await deps.tasks.byId(asTaskId(command.taskId));
  if (!task) return err(notFound('任务不存在'));
  const project = await deps.projects.byId(task.projectId);
  if (!project) return err(notFound('项目不存在'));

  const agentId = asAgentId(command.agentId);
  const descriptor = deps.agents.descriptor(agentId);
  if (!descriptor) return err(conflict(`没有在线节点提供 ${command.agentId}`));
  if (descriptor.capabilities.prompt.state === 'denied') {
    return err(conflict(descriptor.capabilities.prompt.reason ?? '该 agent 不可发送消息'));
  }

  const placed = placeSession(await deps.gateway.status(), {
    agentId,
    requested: command.workerId ?? null,
    projectWorker: project.workerId
  });
  if (!placed.ok) return placed;

  const created = deriveSession({
    task,
    agentId,
    model: command.model,
    now: deps.now(),
    workerId: placed.value
  });
  if (!created.ok) return created;

  const session = { ...created.value, workerId: placed.value };
  await deps.sessions.save(session);

  const dispatched = await deps.gateway.dispatch(startCommand(session, project, null, {}));
  if (!dispatched.ok) {
    await deps.sessions.save({ ...session, status: 'failed', updatedAt: deps.now() });
    return err(dispatched.error);
  }
  deps.hosting.add(session.id, session.workerId);
  await noteSessionStarted(deps, session, `开了 ${session.agentId} 会话${session.model ? `（${session.model}）` : ''}`);
  return ok(session);
}

/** 会话开跑：todo 推到 in_progress，并记一条系统日志。 */
async function noteSessionStarted(
  deps: Pick<Deps, 'now' | 'tasks' | 'workLog'>,
  session: Session,
  body: string
): Promise<void> {
  const task = await deps.tasks.byId(session.taskId);
  if (task) {
    const started = markStarted(task, deps.now());
    if (started !== task) await deps.tasks.save(started);
  }
  await recordSystemLog(deps, session.taskId, body, session.id);
}

export interface ForkCommand {
  readonly sessionId: string;
  readonly atSeq: Seq;
  readonly agentId: string;
  readonly model: string;
}

export async function forkSessionUseCase(
  deps: Pick<Deps, 'agents' | 'gateway' | 'hosting' | 'now' | 'projects' | 'sessions' | 'tasks' | 'workLog'>,
  command: ForkCommand
): Promise<Result<Session, DomainError>> {
  const source = await deps.sessions.byId(asSessionId(command.sessionId));
  if (!source) return err(notFound('来源会话不存在'));

  const sourceDescriptor = deps.agents.descriptor(source.agentId);
  const forkCap = sourceDescriptor?.capabilities.fork;
  if (!forkCap || forkCap.state === 'denied') {
    return err(conflict(forkCap?.reason ?? '该 agent 不支持会话分叉，所以不能作为血缘起点'));
  }

  const sourceTask = await deps.tasks.byId(source.taskId);
  if (!sourceTask) return err(notFound('来源会话所属的任务不存在'));
  const project = await deps.projects.byId(sourceTask.projectId);
  if (!project) return err(notFound('项目不存在'));

  const agentId = asAgentId(command.agentId);
  if (!deps.agents.descriptor(agentId)) {
    return err(conflict(`没有在线节点提供 ${command.agentId}`));
  }

  // 分叉要读来源会话的 agent 会话文件，那份文件只在来源的那台机器上：钉死在它上面。
  const placed = placeSession(await deps.gateway.status(), {
    agentId,
    requested: source.workerId,
    projectWorker: project.workerId
  });
  if (!placed.ok) return placed;

  const created = forkSession({
    source,
    atSeq: command.atSeq,
    agentId,
    model: command.model,
    now: deps.now(),
    workerId: placed.value
  });
  if (!created.ok) return created;

  const session = { ...created.value, workerId: placed.value };
  await deps.sessions.save(session);

  const dispatched = await deps.gateway.dispatch(
    startCommand(session, project, { agentSessionRef: source.agentSessionRef, cursor: command.atSeq }, source.options)
  );
  if (!dispatched.ok) {
    await deps.sessions.save({ ...session, status: 'failed', updatedAt: deps.now() });
    return err(dispatched.error);
  }
  deps.hosting.add(session.id, session.workerId);
  await noteSessionStarted(deps, session, `从会话 ${source.id.slice(0, 8)} 的第 ${command.atSeq} 步分叉出 ${session.agentId} 会话`);
  return ok(session);
}

export interface RecordEventCommand {
  readonly sessionId: SessionId;
  readonly event: SessionEvent;
}

/** 事件落盘 + 广播。seq 由平台分配，worker 不参与编号。 */
export async function recordEvent(
  deps: Pick<Deps, 'artifacts' | 'now' | 'sessions' | 'stream'>,
  command: RecordEventCommand
): Promise<Result<Session, DomainError>> {
  const session = await deps.sessions.byId(command.sessionId);
  if (!session) return err(notFound('会话不存在'));

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
export async function reconcileInterrupted(deps: Pick<Deps, 'now' | 'sessions'>): Promise<number> {
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

export interface SessionOptionsCommand {
  readonly sessionId: string;
  /** agent 报上来的全量清单（含候选值）。 */
  readonly options: readonly RuntimeOption[];
}

/** agent 报上来的可调项当前值落库。它不是事件，所以不进 journal——不进就不占 seq。 */
export async function recordSessionOptions(
  deps: Pick<Deps, 'now' | 'sessions'>,
  command: SessionOptionsCommand
): Promise<Result<Session, DomainError>> {
  const session = await deps.sessions.byId(asSessionId(command.sessionId));
  if (!session) return err(notFound('会话不存在'));
  const values: Record<string, string | boolean> = {};
  for (const option of command.options) values[option.id] = option.current;
  // 模型多存一列：重开会话时要拿它传 --model。它同样只能由 agent 的回报来定，
  // 平台自己改的「当前模型」和 agent 真在用的模型会悄悄分叉。
  const reported = values['model'];
  const model = typeof reported === 'string' && reported !== '' ? reported : session.model;
  const next = {
    ...withOptions({ ...session, model }, values, deps.now()),
    optionSpec: command.options
  };
  await deps.sessions.save(next);
  return ok(next);
}

export interface ChangeOptionCommand {
  readonly sessionId: string;
  readonly id: string;
  readonly value: string | boolean;
}

/**
 * 改一项可调项。
 *
 * 顺序不能反：先让 agent 改，再拿它回的全量状态落库。反过来的话，
 * agent 拒绝了这个值（比如那个模型不在它的清单里），库里就会留下一个
 * 「平台以为在跑 A、其实跑的是 B」的谎话。
 */
export async function changeSessionOption(
  deps: Pick<Deps, 'gateway' | 'hosting' | 'projects' | 'sessions' | 'tasks'>,
  command: ChangeOptionCommand
): Promise<Result<Session, DomainError>> {
  const session = await deps.sessions.byId(asSessionId(command.sessionId));
  if (!session) return err(notFound('会话不存在'));

  // 改模型也是在改一条会话的运行状态；它没在跑就先拉起来，否则指令会打空。
  const hosted = await ensureHosted(deps, session);
  if (!hosted.ok) return hosted;

  const changed = await deps.gateway.dispatch({
    kind: 'set_option',
    sessionId: session.id,
    optionId: command.id,
    value: command.value
  });
  if (!changed.ok) return err(changed.error);

  // 这里**不**自己往库里写一个乐观值：换模型会连带改变思考档位的可选值，
  // 只有 agent 知道换完之后整体长什么样。落库交给它的回报（recordSessionOptions），
  // 那一步走 per-session 串行队列，所以不会和我们抢。
  return ok((await deps.sessions.byId(session.id)) ?? session);
}
