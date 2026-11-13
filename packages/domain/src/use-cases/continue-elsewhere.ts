import { usableByProject } from './workspaces.ts';
import { principalOfSubject, type Subject } from '../access.ts';
import type { Session } from '../session.ts';
import { forkSession } from '../session.ts';
import { buildHandoff } from '../handoff.ts';
import type { DomainError } from '../errors.ts';
import { conflict, notFound, unavailable } from '../errors.ts';
import { asSessionId } from '../ids.ts';
import { err, ok, type Result } from '../result.ts';
import { isUsable, type Workspace } from '../workspace.ts';
import type { SaveWipOutcome } from '../ports/workspace-git.ts';
import { gitFor, resolveMachine } from './machine-dirs.ts';
import { authorizeWorker } from './authorization.ts';
import { prepareTemporaryWorkspaceUseCase } from './temporary-workspaces.ts';
import { carryModelTo, placeSession } from '../worker.ts';
import type { Deps } from './deps.ts';
import { startSessionUseCase } from './start-session.ts';
import { interruptSessionUseCase } from './sessions.ts';
import { promptSessionUseCase } from './conversation.ts';

/**
 * 「换个地方继续」（docs/design/workspaces.md §7）：agent 自己的会话文件只在原来那台机器上，搬不走。
 * 能搬的是平台 journal 和任务工作日志：在目标工作空间开一条**新**会话、作为原会话的分叉挂进血缘，
 * 第一条消息带上交接摘要（任务背景 + 工作日志 + 项目说明照常注入）。项目本身不改。
 * 代码怎么过去：可选「先提交 WIP 并推送分支」，目标用同一个分支开临时工作空间；不推就明说改动留在原处。
 */
export type ContinueTarget =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'temporary'; readonly workerId: string | null };

export interface ContinueElsewhereCommand {
  readonly sessionId: string;
  readonly target: ContinueTarget;
  /** 先把原工作空间的改动提交成 WIP 并推送分支（只对 git 工作空间有效）。 */
  readonly saveWip?: boolean;
  /** 本机的 home 目录：新建临时目录时用。 */
  readonly home: string;
  readonly actor?: Subject | null;
}

/** 摘要的字数上限：够交代来龙去脉，又不至于一开口就吃掉半个上下文窗口。 */

export async function continueElsewhereUseCase(
  deps: Pick<
    Deps,
    'agents' | 'artifacts' | 'fs' | 'gateway' | 'git' | 'hosting' | 'now' | 'projects' | 'queue' | 'sessions' | 'stream' | 'tasks' | 'workspaces' | 'workLog' | 'access'
  >,
  command: ContinueElsewhereCommand
): Promise<Result<Session, DomainError>> {
  const source = await deps.sessions.byId(asSessionId(command.sessionId));
  if (!source) return err(notFound('来源会话不存在'));
  if (source.lastSeq === 0) return err(conflict('这条会话还没有任何内容，直接在目标工作空间新开就好'));
  const task = await deps.tasks.byId(source.taskId);
  if (!task) return err(notFound('来源会话所属的任务不存在'));
  const project = await deps.projects.byId(task.projectId);
  if (!project) return err(notFound('项目不存在'));
  const from = source.workspaceId ? await deps.workspaces.byId(source.workspaceId) : null;

  // 先确认目标说得通，再动原会话
  let chosen: Workspace | null = null;
  if (command.target.kind === 'workspace') {
    chosen = await deps.workspaces.byId(command.target.workspaceId as never);
    if (!chosen || !(await usableByProject(deps, chosen, project.id)) || !isUsable(chosen)) return err(notFound('目标工作空间不存在或已不可用'));
    if (chosen.id === source.workspaceId) return err(conflict('会话已经在这个工作空间里了'));
  }
  const targetWorker = chosen ? chosen.workerId : command.target.kind === 'temporary' ? command.target.workerId : null;
  const machine = await resolveMachine(deps, targetWorker);
  if (!machine.ok) return machine;
  const workers = await deps.gateway.status();
  const placed = placeSession(workers, { agentId: source.agentId, requested: machine.value.workerId, projectWorker: machine.value.workerId, model: source.model });
  if (!placed.ok) return placed;
  const allowed = await authorizeWorker(deps.access, command.actor ?? null, placed.value);
  if (!allowed.ok) return allowed;

  // 原会话还在跑就先停下，免得两边同时改
  if (source.status === 'running') await interruptSessionUseCase(deps, source.id);

  let wip: SaveWipOutcome | null = null;
  if (command.saveWip && from?.isGit) {
    const saved = await (await gitFor(deps, from.workerId)).saveWip(from.path, `WIP: ${task.title}（换个地方继续）`);
    if (!saved.ok) return saved;
    wip = saved.value;
  }

  if (!chosen) {
    // 同一台机器上原分支还被原工作空间检出着（git 不许检出两次）：新开分支，从 WIP 分支长出来
    const branch = wip?.pushed ? wip.branch : null;
    const sameMachine = from !== null && from.workerId === machine.value.workerId;
    const made = await prepareTemporaryWorkspaceUseCase(deps, {
      actor: command.actor,
      projectId: project.id,
      taskId: task.id,
      workerId: targetWorker,
      home: command.home,
      // 要「从 WIP 分支长个新分支」只能靠 worktree；shared 是直接复用长期目录，没有分支这一步
      ...(branch ? (sameMachine ? { base: branch, mode: 'isolated' as const } : { branch }) : {})
    });
    if (!made.ok) return made;
    chosen = made.value;
  }
  const target = chosen;

  const created = forkSession({
    source,
    atSeq: source.lastSeq,
    options: source.options,
    agentId: source.agentId,
    model: carryModelTo(workers, placed.value, source.agentId, source.model),
    now: deps.now(),
    workerId: placed.value,
    workspaceId: target.id,
    createdBy: principalOfSubject(command.actor)?.user.id ?? null
  });
  if (!created.ok) return created;
  const session = { ...created.value, workerId: placed.value };
  await deps.sessions.save(session);

  // resume = null：目标机器上没有原来的 agent 会话文件，只能新开
  const started = await startSessionUseCase(deps, {
    session,
    workspaceRoot: target.path,
    resume: null,
    inheritedOptions: source.options
  });
  if (!started.ok) return started;

  const label = (id: string | null) => workers.find((w) => w.workerId === (id ?? placedLocal(workers)))?.label ?? id ?? '原来的机器';
  const journal = await deps.sessions.eventsAfter(source.id, 0 as never);
  const brief = buildHandoff(
    journal,
    { from: `${label(source.workerId)}${from ? ` 的 ${from.path}` : ''}`, to: label(placed.value), root: target.path, code: codeNote(from, target, wip) },
    { sourceSessionId: source.id, ...((deps as { handoffTokenCap?: number }).handoffTokenCap ? { cap: (deps as { handoffTokenCap?: number }).handoffTokenCap! } : {}) }
  );
  const seeded = await promptSessionUseCase(deps, { sessionId: session.id, text: brief.text, briefing: true, handoff: brief.stats });
  if (!seeded.ok) return err(seeded.error.code === 'unavailable' ? unavailable(seeded.error.message) : seeded.error);
  return ok((await deps.sessions.byId(session.id)) ?? session);
}

const placedLocal = (workers: readonly { workerId: string; origin: string }[]) => workers.find((w) => w.origin === 'local')?.workerId;

/** 交接里关于「代码在哪」的一句实话。 */
export function codeNote(from: Workspace | null, target: Workspace, wip: SaveWipOutcome | null): string {
  if (wip?.pushed) {
    const same = target.branch === wip.branch;
    const here = same
      ? '，这里检出的就是这个分支'
      : target.branch
        ? `，这里的新分支 ${target.branch} 就是从它长出来的`
        : '，需要的话自己 fetch 并切过去';
    return `原工作空间的改动已${wip.committed ? '提交成 WIP 并' : ''}推送到分支 ${wip.branch}${here}。`;
  }
  if (wip) return `尝试提交 WIP 但没推上去（${wip.reason ?? '原因不明'}）：代码改动留在原机器上${from ? `的 ${from.path}` : ''}。`;
  if (!from) return '代码改动留在原机器上。';
  return `代码改动留在原机器上的 ${from.path}${from.branch ? `（分支 ${from.branch}）` : ''}，没有搬过来；这里的文件以本工作空间为准。`;
}
