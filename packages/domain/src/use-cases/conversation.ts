import type { Session } from '../session.ts';
import type { SessionEvent } from '../event.ts';
import type { RuntimeOption } from '../option.ts';
import type { SessionId } from '../ids.ts';
import { asSessionId } from '../ids.ts';
import type { DomainError } from '../errors.ts';
import { notFound } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { Deps } from './deps.ts';
import { ensureHosted, projectOf } from './hosting.ts';
import { recordEvent, recordSessionOptions } from './sessions.ts';

/*
 * 「会话在跑」这一侧的用例：用户发话，以及 worker 回报的一切。
 * 回报全部走 deps.queue，保证同一会话的读改写不交错。
 */

export interface PromptCommand {
  readonly sessionId: string;
  readonly text: string;
}

/** 发消息：先记下「用户说了什么」，再确保有人托管，最后才叫 agent。 */
export async function promptSessionUseCase(
  deps: Deps,
  command: PromptCommand
): Promise<Result<void, DomainError>> {
  const sessionId = asSessionId(command.sessionId);
  const session = await deps.sessions.byId(sessionId);
  if (!session) return err(notFound('会话不存在'));

  // 反过来的话，agent 起不来时用户那句问话就凭空消失了——
  // 专注对话里会是一条没有提问的回答。
  const logged = await deps.queue.run(sessionId, () =>
    recordEvent(deps, { sessionId, event: { kind: 'prompt', text: command.text } })
  );
  if (!logged.ok) return logged;

  const hosted = await ensureHosted(deps, session);
  if (!hosted.ok) return hosted;
  return deps.gateway.dispatch({ kind: 'prompt', sessionId, text: command.text });
}

/** 字节数由 server 补：adapter 只知道路径，只有能摸到磁盘的一侧才 stat 得到真实大小。 */
async function withBytes(
  deps: Pick<Deps, 'fs' | 'sessions' | 'tasks' | 'projects'>,
  sessionId: SessionId,
  event: SessionEvent
): Promise<SessionEvent> {
  if (event.kind !== 'artifact') return event;
  let absolute = event.path;
  if (!absolute.startsWith('/')) {
    const session = await deps.sessions.byId(sessionId);
    const project = session ? await projectOf(deps, session) : null;
    if (!project) return event;
    absolute = `${project.rootPath.replace(/\/+$/, '')}/${event.path}`;
  }
  const bytes = await deps.fs.stat(absolute);
  return bytes === null ? event : { ...event, bytes };
}

/** worker 推上来一条事件：补字节数，然后按会话串行落盘（并发会撞 seq，见 ADR 0004）。 */
export function ingestWorkerEvent(
  deps: Deps,
  sessionId: SessionId,
  event: SessionEvent
): Promise<Result<Session, DomainError>> {
  return deps.queue.run(sessionId, async () =>
    recordEvent(deps, { sessionId, event: await withBytes(deps, sessionId, event) })
  );
}

/**
 * worker 报上来可调项的全量当前值。它不是事件：不进 journal、不占 seq。
 * 走同一条串行队列，这样「改动请求」和「agent 的回报」不会互相覆盖。
 */
export function ingestWorkerOptions(
  deps: Deps,
  sessionId: SessionId,
  options: readonly RuntimeOption[]
): Promise<Result<Session, DomainError>> {
  return deps.queue.run(sessionId, () => recordSessionOptions(deps, { sessionId, options }));
}

/** agent 自己的会话号：resume 时要原样还给它。 */
export function ingestAgentSessionRef(
  deps: Pick<Deps, 'sessions' | 'queue' | 'now'>,
  sessionId: SessionId,
  agentSessionRef: string
): Promise<Result<Session, DomainError>> {
  return deps.queue.run(sessionId, async () => {
    const session = await deps.sessions.byId(sessionId);
    if (!session) return err(notFound('会话不存在'));
    const next = { ...session, agentSessionRef, updatedAt: deps.now() };
    await deps.sessions.save(next);
    return ok(next);
  });
}

export type RuntimeStatus = 'running' | 'ended' | 'gone';

/**
 * worker 报运行状态。跑完 / 消失就不再算托管；状态也要推给界面：
 * 从「发出提问」到「agent 说出第一个字」之间可能十几秒，界面不能还挂着上一次的「完成」。
 */
export async function ingestRuntimeStatus(
  deps: Pick<Deps, 'sessions' | 'hosting' | 'stream'>,
  sessionId: SessionId,
  status: RuntimeStatus
): Promise<void> {
  if (status !== 'running') deps.hosting.drop(sessionId);
  const session = await deps.sessions.byId(sessionId);
  if (!session) return;
  // worker 只说 running / ended；除了 running，其余以库里已落盘的状态为准。
  const next = status === 'running' ? 'running' : session.status;
  deps.stream.publish({ sessionId, seq: session.lastSeq, event: null, status: next });
}

/** worker 掉线：它手上的会话都不再有人托管。 */
export function workerGone(deps: Pick<Deps, 'hosting'>): void {
  deps.hosting.clear();
}
