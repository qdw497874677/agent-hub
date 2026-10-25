import type { Session } from '../session.ts';
import { forkSession } from '../session.ts';
import type { SessionEvent } from '../event.ts';
import type { DomainError } from '../errors.ts';
import { conflict, invalid, notFound, unavailable } from '../errors.ts';
import { asSessionId } from '../ids.ts';
import { err, ok, type Result } from '../result.ts';
import { workspaceFor } from '../project.ts';
import { placeSession } from '../worker.ts';
import type { Deps } from './deps.ts';
import { startCommand } from './hosting.ts';
import { promptSessionUseCase } from './conversation.ts';

/**
 * 「换台机器继续」：agent 自己的会话文件（模型看到的上下文）只在原来那台机器上，搬不走。
 * 能搬的是平台 journal：把它压成一段交接摘要，在目标 Worker 上开一条**新**会话、
 * 作为原会话的分叉挂进血缘，再把摘要当第一条消息发过去。
 * 人在界面上看到的说法必须和这件事一致：这是「带着摘要重开」，不是「迁移」。
 */
export interface ContinueElsewhereCommand {
  readonly sessionId: string;
  readonly workerId: string;
  /** 项目在那台 Worker 上的目录。那台还没登记过目录时必填；填了就登记到项目上。 */
  readonly directory?: string | null;
}

/** 摘要的字数上限：够交代来龙去脉，又不至于一开口就吃掉半个上下文窗口。 */
export const HANDOFF_LIMIT = 12_000;

export const NEEDS_DIRECTORY = '需要选这个项目在那台 Worker 上的目录';

export async function continueElsewhereUseCase(
  deps: Pick<
    Deps,
    'agents' | 'artifacts' | 'fs' | 'gateway' | 'hosting' | 'now' | 'projects' | 'queue' | 'sessions' | 'stream' | 'tasks'
  >,
  command: ContinueElsewhereCommand
): Promise<Result<Session, DomainError>> {
  const source = await deps.sessions.byId(asSessionId(command.sessionId));
  if (!source) return err(notFound('来源会话不存在'));
  if (source.lastSeq === 0) return err(conflict('这条会话还没有任何内容，直接在目标机器上新开就好'));
  const task = await deps.tasks.byId(source.taskId);
  if (!task) return err(notFound('来源会话所属的任务不存在'));
  let project = await deps.projects.byId(task.projectId);
  if (!project) return err(notFound('项目不存在'));
  if (command.workerId === source.workerId) return err(conflict('会话已经在这台 Worker 上了'));

  const workers = await deps.gateway.status();
  const placed = placeSession(workers, {
    agentId: source.agentId,
    requested: command.workerId,
    projectWorker: command.workerId
  });
  if (!placed.ok) return placed;

  // 目标机器上的目录：项目的家就用项目目录；登记过就用登记的；都没有就得人来选。
  // 没绑定 Worker 的老项目，目录在 Server 本机，它的「家」就是本机 Worker
  const home = project.workerId ?? workers.find((w) => w.origin === 'local')?.workerId ?? null;
  const isHome = home === command.workerId;
  const known = isHome ? project.rootPath : project.directories[command.workerId];
  const directory = command.directory?.trim() || known;
  if (!directory) return err(invalid(NEEDS_DIRECTORY));
  if (!directory.startsWith('/')) return err(invalid('目录必须是绝对路径'));
  if (!isHome && directory !== known) {
    const listed = await deps.gateway.listDirectories(command.workerId, directory);
    if (!listed.ok) return listed;
    if (!listed.value.exists) return err(notFound(`那台 Worker 上没有这个目录：${directory}`));
    project = { ...project, directories: { ...project.directories, [command.workerId]: listed.value.path } };
    await deps.projects.save(project);
  }

  const created = forkSession({
    source,
    atSeq: source.lastSeq,
    agentId: source.agentId,
    model: source.model,
    now: deps.now(),
    workerId: placed.value
  });
  if (!created.ok) return created;
  const session = { ...created.value, workerId: placed.value };
  await deps.sessions.save(session);

  // resume = null：目标机器上没有原来的 agent 会话文件，只能新开
  const started = await deps.gateway.dispatch(startCommand(session, project, null, source.options));
  if (!started.ok) {
    await deps.sessions.save({ ...session, status: 'failed', updatedAt: deps.now() });
    return err(started.error);
  }
  deps.hosting.add(session.id, session.workerId);

  const label = (id: string | null) => workers.find((w) => w.workerId === id)?.label ?? id ?? '原来的机器';
  const journal = await deps.sessions.eventsAfter(source.id, 0 as never);
  const brief = handoffBrief(
    journal.map((entry) => entry.event),
    { from: label(source.workerId), to: label(placed.value), root: workspaceFor(project, placed.value).root }
  );
  const seeded = await promptSessionUseCase(deps, { sessionId: session.id, text: brief });
  if (!seeded.ok) return err(seeded.error.code === 'unavailable' ? unavailable(seeded.error.message) : seeded.error);
  return ok((await deps.sessions.byId(session.id)) ?? session);
}

/**
 * 把 journal 压成交接摘要：保留人说了什么、agent 答了什么、动过哪些工具和文件。
 * 太长时保留开头的目标和最近的进展，中间截掉并明说截掉了。
 */
export function handoffBrief(
  events: readonly SessionEvent[],
  where: { readonly from: string; readonly to: string; readonly root: string }
): string {
  const turns: string[] = [];
  let reply = '';
  const flush = () => {
    if (reply.trim()) turns.push(`助手：${reply.trim()}`);
    reply = '';
  };
  for (const event of events) {
    if (event.kind === 'text') reply += event.delta;
    else if (event.kind === 'prompt') {
      flush();
      const files = (event.attachments ?? []).map((a) => a.path).join('、');
      turns.push(`用户：${event.text.trim()}${files ? `（附带：${files}）` : ''}`);
    } else if (event.kind === 'tool_call') {
      flush();
      turns.push(`[工具] ${event.name}`);
    } else if (event.kind === 'artifact') {
      flush();
      turns.push(`[产出] ${event.path}`);
    }
  }
  flush();
  let body = turns.join('\n');
  if (body.length > HANDOFF_LIMIT) {
    const head = body.slice(0, Math.floor(HANDOFF_LIMIT * 0.3));
    const tail = body.slice(body.length - Math.floor(HANDOFF_LIMIT * 0.7));
    body = `${head}\n……（中间省略 ${body.length - head.length - tail.length} 字）……\n${tail}`;
  }
  return [
    `这是一段从「${where.from}」接过来的对话。原来那台机器上的 agent 会话状态无法带过来，下面是平台记录的对话摘要。`,
    `现在你在「${where.to}」上，工作目录是 ${where.root}。文件以这台机器上的为准，原机器上没提交的改动这里可能没有。`,
    '',
    '--- 之前的对话 ---',
    body,
    '--- 摘要结束 ---',
    '',
    '请先用一两句话确认你理解到的目标和进展，然后等我下一条指令。'
  ].join('\n');
}
