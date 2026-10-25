import { workspaceFor } from '../project.ts';
import type { Session } from '../session.ts';
import type { SessionEvent } from '../event.ts';
import type { RuntimeOption } from '../option.ts';
import type { SessionId } from '../ids.ts';
import { asSessionId } from '../ids.ts';
import type { DomainError } from '../errors.ts';
import { invalid, notFound } from '../errors.ts';
import type { AttachmentInput, PromptPart, StoredAttachment } from '../attachment.ts';
import { attachmentPath, base64Bytes, validateAttachments } from '../attachment.ts';
import { err, ok, type Result } from '../result.ts';
import type { Deps } from './deps.ts';
import { ensureHosted, projectOf } from './hosting.ts';
import { recordEvent, recordSessionOptions } from './sessions.ts';
import { taskBriefing } from '../task-briefing.ts';

/*
 * 「会话在跑」这一侧的用例：用户发话，以及 worker 回报的一切。
 * 回报全部走 deps.queue，保证同一会话的读改写不交错。
 */

export interface PromptCommand {
  readonly sessionId: string;
  readonly text: string;
  readonly attachments?: readonly AttachmentInput[];
  /** false = 不垫任务背景（调用方已经自己写了交接简报，如换机继续）。 */
  readonly briefing?: boolean;
}

/**
 * 附件拆成两份：journal 里的元数据，和发给 worker 的内容块。
 * 落盘由会话所在的 Worker 做（它收到 prompt 时先写进项目目录再交给 agent）：
 * 项目目录可能在别的机器上，Server 不往那里写。
 * 能力矩阵里 attachments 为 denied 的 agent 直接拒，原因原样给用户看。
 */
async function prepareAttachments(
  deps: Pick<Deps, 'agents' | 'now' | 'projects' | 'tasks'>,
  session: Session,
  inputs: readonly AttachmentInput[]
): Promise<Result<{ stored: StoredAttachment[]; parts: PromptPart[] }, DomainError>> {
  if (inputs.length === 0) return ok({ stored: [], parts: [] });
  const valid = validateAttachments(inputs);
  if (!valid.ok) return valid;
  const descriptor = deps.agents.descriptor(session.agentId);
  const capability = descriptor?.capabilities.attachments;
  if (capability?.state === 'denied') return err(invalid(capability.reason ?? '这个 agent 不接收附件'));
  const project = await projectOf(deps, session);
  if (!project) return err(notFound('会话所属项目不存在'));
  const root = workspaceFor(project, session.workerId).root;
  const at = deps.now();
  const stored: StoredAttachment[] = [];
  const parts: PromptPart[] = [];
  for (const [index, input] of inputs.entries()) {
    if (input.kind === 'mention') {
      const name = input.path.split('/').pop() ?? input.path;
      stored.push({ kind: 'mention', name, path: input.path });
      parts.push({ kind: 'mention', name, path: `${root}/${input.path}` });
      continue;
    }
    const path = attachmentPath(session.id, index, at, input.name);
    stored.push({ kind: input.kind, name: input.name, path, mimeType: input.mimeType, bytes: base64Bytes(input.data) });
    parts.push({ ...input, path: `${root}/${path}` });
  }
  return ok({ stored, parts });
}

/** 发消息：先记下「用户说了什么」，再确保有人托管，最后才叫 agent。 */
export async function promptSessionUseCase(
  deps: Pick<
    Deps,
    'agents' | 'artifacts' | 'fs' | 'gateway' | 'hosting' | 'now' | 'projects' | 'queue' | 'sessions' | 'stream' | 'tasks'
  > & Partial<Pick<Deps, 'workLog'>>,
  command: PromptCommand
): Promise<Result<void, DomainError>> {
  const sessionId = asSessionId(command.sessionId);
  const session = await deps.sessions.byId(sessionId);
  if (!session) return err(notFound('会话不存在'));
  const attachments = command.attachments ?? [];
  if (command.text.trim() === '' && attachments.length === 0) return err(invalid('消息不能为空'));
  const prepared = await prepareAttachments(deps, session, attachments);
  if (!prepared.ok) return prepared;
  const { stored, parts } = prepared.value;
  // 新会话第一句：给 agent 垫上任务背景（目标、摘要、最近交接）。用户看到的仍是原话。
  const briefing = session.lastSeq === 0 && command.briefing !== false ? await briefingFor(deps, session) : null;

  // 反过来的话，agent 起不来时用户那句问话就凭空消失了——
  // 专注对话里会是一条没有提问的回答。
  const logged = await deps.queue.run(sessionId, () =>
    recordEvent(deps, { sessionId, event: { kind: 'prompt', text: command.text, ...(stored.length > 0 ? { attachments: stored } : {}) } })
  );
  if (!logged.ok) return logged;

  const hosted = await ensureHosted(deps, session);
  if (!hosted.ok) return hosted;
  const text = briefing ? `${briefing}\n\n${command.text}` : command.text;
  return deps.gateway.dispatch({ kind: 'prompt', sessionId, text, parts });
}

async function briefingFor(deps: Pick<Deps, 'tasks'> & Partial<Pick<Deps, 'workLog'>>, session: Session): Promise<string | null> {
  if (!session.taskId || !deps.workLog) return null;
  const task = await deps.tasks.byId(session.taskId);
  if (!task) return null;
  return taskBriefing(task, await deps.workLog.list(task.id, { limit: 6 }));
}

/**
 * 字节数要能摸到磁盘的一侧来量。远程项目由 Worker 量好了再报上来；
 * 只有目录在 Server 本机的项目才由 Server 自己 stat。
 */
async function withBytes(
  deps: Pick<Deps, 'fs' | 'sessions' | 'tasks' | 'projects'>,
  sessionId: SessionId,
  event: SessionEvent
): Promise<SessionEvent> {
  if (event.kind !== 'artifact') return event;
  const session = await deps.sessions.byId(sessionId);
  const project = session ? await projectOf(deps, session) : null;
  if (!project || !session) return event;
  const workspace = workspaceFor(project, session.workerId);
  if (workspace.workerId !== null) return event;
  const absolute = event.path.startsWith('/') ? event.path : `${workspace.root}/${event.path}`;
  const bytes = await deps.fs.stat(absolute);
  return bytes === null ? event : { ...event, bytes };
}

/** worker 推上来一条事件：补字节数，然后按会话串行落盘（并发会撞 seq，见 ADR 0004）。 */
export function ingestWorkerEvent(
  deps: Pick<Deps, 'artifacts' | 'fs' | 'now' | 'projects' | 'queue' | 'sessions' | 'stream' | 'tasks'>,
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
  deps: Pick<Deps, 'now' | 'queue' | 'sessions'>,
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

/**
 * 一台 Worker 发来的会话帧算不算数：会话必须落在它身上。
 * 落点为 null 的老会话（多机之前建的）照旧收——它们只可能在原来那台唯一的机器上。
 * 不核对的话，任何连上来的 Worker 都能往别人的会话里写输出、改状态、换 agent 会话引用。
 */
export async function frameAccepted(
  deps: Pick<Deps, 'sessions'>,
  workerId: string,
  sessionId: SessionId
): Promise<boolean> {
  const session = await deps.sessions.byId(sessionId);
  return session !== null && (session.workerId === null || session.workerId === workerId);
}

/**
 * 某台 Worker 掉线：只有**它**手上的会话不再有人托管。
 * 其它机器上的会话照跑——多机之前这里是 `clear()`，一台掉线全体失联。
 * 落点为 null 的老会话按「在唯一那台上」处理，一并划掉。
 *
 * 必须同步划：以前先 await 一次 listAll 再逐条 drop，Worker 秒重连时
 * `workerAttached` 刚接回的会话会被这次迟到的掉线清掉，下一句话又 resume 出第二个 agent 进程。
 */
export function workerGone(deps: Pick<Deps, 'hosting'>, workerId: string): number {
  return deps.hosting.dropWorker(workerId);
}

/**
 * Worker 断线重连后报上「我手上还活着的会话」：重新登记托管，免得下一句话又去 resume 一遍
 * （resume 会再拉起一个 agent 进程，和还活着的那个抢同一份会话文件）。
 * 只认落点就是它的会话：别的机器的会话不该被一台重连的 Worker 认领。
 * 返回核对过的那些，组合根据此让网关恢复路由（网关自己不信 hello 里报的清单）。
 */
export async function workerAttached(
  deps: Pick<Deps, 'hosting' | 'sessions'>,
  workerId: string,
  sessionIds: readonly string[]
): Promise<string[]> {
  const attached: string[] = [];
  for (const id of sessionIds) {
    const session = await deps.sessions.byId(id as SessionId);
    if (!session || (session.workerId !== null && session.workerId !== workerId)) continue;
    deps.hosting.add(session.id, workerId);
    attached.push(session.id);
  }
  return attached;
}
