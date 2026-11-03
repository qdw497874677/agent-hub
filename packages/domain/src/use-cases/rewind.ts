import { principalOfSubject, type Subject } from '../access.ts';
import { forkSession, type Session } from '../session.ts';
import type { TurnCheckpoint, RestoreOutcome, TurnRefStore } from '../ports/workspace-browser.ts';
import type { BranchSpec } from '../ports/agent-runtime.ts';
import { allowsFor, unavailableReason } from '../capability.ts';
import type { Workspace } from '../workspace.ts';
import { asSessionId } from '../ids.ts';
import { conflict, invalid, notFound, type DomainError } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import { placeSession } from '../worker.ts';
import { authorizeProject, authorizeSession, authorizeWorker } from './authorization.ts';
import type { Deps } from './deps.ts';
import { startCommand } from './hosting.ts';
import { interruptSessionUseCase, recordEvent } from './sessions.ts';
import { promptSessionUseCase } from './conversation.ts';
import { buildHandoff, type HandoffResult } from '../handoff.ts';
import { locationOf } from './workspaces.ts';

/**
 * 回滚到某条消息（ADR 0027 阶段 4）：「⋯ → 从这里重来」。
 * - 只回滚对话：现在接入的 runtime 都没有原生 rewind（ACP 只有 list / resume / close），一律按 D8 从这条消息之前
 *   fork 一条新会话（ADR 0012 血缘，原会话一个字不删），之前的对话压成交接摘要发给新 agent，原消息回填到输入框。
 * - 连文件一起回滚（D9）：只限临时工作空间，且没被别的项目 / 任务共用、同目录（含父 / 子目录）没有别的会话在跑；
 *   权限 = 项目 session.create 且是会话发起人或能改项目的人。恢复前先拍一张安全检查点（可撤销）。
 */
export interface RewindFiles {
  turnFor(sessionId: string, promptSeq: number): Promise<TurnCheckpoint | null>;
  /** 会话所有回合（不鉴权，调用方已鉴权）。 */
  turnsOf(sessionId: string): Promise<readonly TurnCheckpoint[]>;
  restoreTurn(sessionId: string, promptSeq: number): Promise<Result<RestoreOutcome & { readonly turn: number }, DomainError>>;
}

export type RewindDeps = Pick<
  Deps,
  'agents' | 'artifacts' | 'fs' | 'gateway' | 'hosting' | 'now' | 'projects' | 'queue' | 'sessions' | 'stream' | 'tasks' | 'workspaces' | 'workLog' | 'access'
> & { readonly files: RewindFiles; readonly turnRefs: TurnRefStore };

/** 对话怎么接上（ADR 0028）：native = 原生从这条消息分叉；summary = 新开会话 + 摘要交接；none = 第一条消息，不用交接。 */
export type RewindMode = 'native' | 'summary' | 'none';

export interface RewindPreview {
  readonly promptSeq: number;
  readonly prompt: string;
  /** 能不能连文件一起回滚；不能时 filesBlocked 说明原因。 */
  readonly filesAllowed: boolean;
  readonly filesBlocked: string | null;
  /** 回滚文件会撤掉的：从这一轮开始到现在的轮数。 */
  readonly turnsAfter: number;
  readonly mode: RewindMode;
  /** mode = summary 时为什么不能原生分叉。 */
  readonly modeReason: string | null;
  readonly agentLabel: string;
}

export interface RewindOutcome {
  readonly session: Session;
  /** 回填到新会话输入框的原消息。 */
  readonly prompt: string;
  readonly files: (RestoreOutcome & { readonly turn: number }) | null;
  readonly mode: RewindMode;
}

interface Found {
  readonly session: Session;
  readonly promptSeq: number;
  readonly prompt: string;
  readonly projectId: string;
  readonly workspace: Workspace | null;
  readonly root: string;
}

interface Plan {
  readonly mode: RewindMode;
  readonly reason: string | null;
  readonly branch: BranchSpec | null;
}

export function createRewindService(deps: RewindDeps) {
  /** 原生分叉已派发、等 worker 回 branch_result 的会话 → 万一失败要补发的交接摘要（只在内存里；hub 重启就丢，新会话照样能用，只是少了前情）。 */
  const pendingBriefs = new Map<string, HandoffResult>();
  const handoffCap = (deps as { handoffTokenCap?: number }).handoffTokenCap;

  async function plan(found: Found, workerId: string | null): Promise<Plan> {
    const { session, promptSeq } = found;
    const earlier = (await deps.sessions.eventsAfter(session.id, 0 as never)).filter((e) => e.seq < promptSeq && e.event.kind === 'prompt');
    if (earlier.length === 0) return { mode: 'none', reason: null, branch: null };
    const summary = (reason: string): Plan => ({ mode: 'summary', reason, branch: null });
    // 能力看原会话所在那台机器（别的机器上同名 agent 可能是老版本）
    const descriptor = (session.workerId ? deps.agents.descriptorOn?.(session.workerId, session.agentId) : null) ?? deps.agents.descriptor(session.agentId);
    if (!descriptor) return summary('找不到这个 agent');
    if (!allowsFor(descriptor.capabilities, 'branch_at_turn')) return summary(unavailableReason(descriptor.capabilities, 'branch_at_turn') ?? '这个 agent 不能原生分叉');
    if (!session.agentSessionRef) return summary('原会话没有记下 agent 自己的会话 id');
    if (workerId !== null && workerId !== session.workerId) return summary('原会话所在的机器现在不可用，换机器只能摘要交接');
    const refs = await deps.turnRefs.list(session.id);
    const turnRef = refs.get(promptSeq) ?? null;
    const previousTurnRef = refs.get(earlier[earlier.length - 1]!.seq) ?? null;
    if (!turnRef || !previousTurnRef) return summary('这条消息没有记下原生标识（功能上线之前的消息）');
    return { mode: 'native', reason: null, branch: { fromAgentSessionRef: session.agentSessionRef, turnRef, previousTurnRef } };
  }

  async function find(actor: Subject | null, sessionId: string, promptSeq: number): Promise<Result<Found, DomainError>> {
    if (!Number.isInteger(promptSeq) || promptSeq < 1) return err(invalid('消息序号不对'));
    const session = await deps.sessions.byId(asSessionId(sessionId));
    const task = session ? await deps.tasks.byId(session.taskId) : null;
    const project = task ? await deps.projects.byId(task.projectId) : null;
    const seen = await authorizeSession(deps.access, actor, project, session, 'session.prompt');
    if (!seen.ok) return seen;
    const entry = (await deps.sessions.eventsAfter(seen.value.id, (promptSeq - 1) as never)).find((e) => e.seq === promptSeq);
    if (!entry || entry.event.kind !== 'prompt') return err(notFound('找不到这条消息'));
    const workspace = seen.value.workspaceId ? await deps.workspaces.byId(seen.value.workspaceId) : null;
    const location = project ? await locationOf(deps, project, seen.value) : { root: '' };
    return ok({ session: seen.value, promptSeq, prompt: entry.event.text, projectId: project!.id, workspace, root: location.root });
  }

  /** 连文件回滚为什么不行；null = 可以。 */
  async function filesBlocked(actor: Subject | null, found: Found): Promise<string | null> {
    const { session, workspace } = found;
    if (!workspace) return '这条会话没有工作空间';
    if (workspace.kind !== 'temporary') return '只有临时工作空间能连文件一起回滚；长期工作空间请只回滚对话';
    if (!workspace.isGit) return '工作空间不是 git 仓库，没有检查点';
    const project = await deps.projects.byId(found.projectId as never);
    const canRun = await authorizeProject(deps.access, actor, project, 'session.create');
    if (!canRun.ok) return '你没有在这个项目里跑任务的权限';
    const mine = principalOfSubject(actor)?.user.id;
    const isStarter = session.createdBy !== null && session.createdBy === mine;
    if (!isStarter && !(await authorizeProject(deps.access, actor, project, 'project.update')).ok) return '只有会话发起人或项目 owner 能回滚文件';
    if (workspace.ownerTaskId !== session.taskId) return '工作空间被别的任务共用';
    if ((await deps.workspaces.linksOf(workspace.id)).some((link) => link.projectId !== found.projectId)) return '工作空间还关联着别的项目';
    const near = (await deps.workspaces.onMachine(workspace.workerId)).filter((w) => overlaps(w.path, workspace.path));
    for (const other of near) {
      const running = (await deps.sessions.listByWorkspace(other.id)).some((s) => s.id !== session.id && s.status === 'running');
      if (running) return '同一目录（或父 / 子目录）里有别的会话正在运行';
    }
    return (await deps.files.turnFor(session.id, found.promptSeq)) ? null : '这条消息没有检查点（检查点上线之前的消息），只能回滚对话';
  }

  return {
    async preview(actor: Subject | null, sessionId: string, promptSeq: number): Promise<Result<RewindPreview, DomainError>> {
      const found = await find(actor, sessionId, promptSeq);
      if (!found.ok) return found;
      const blocked = await filesBlocked(actor, found.value);
      const turnsAfter = (await deps.files.turnsOf(found.value.session.id)).filter((t) => t.promptSeq >= promptSeq).length;
      const planned = await plan(found.value, null);
      return ok({ promptSeq, prompt: found.value.prompt, filesAllowed: blocked === null, filesBlocked: blocked, turnsAfter, mode: planned.mode, modeReason: planned.reason, agentLabel: deps.agents.descriptor(found.value.session.agentId)?.label ?? found.value.session.agentId });
    },

    async rewind(actor: Subject | null, sessionId: string, promptSeq: number, withFiles: boolean): Promise<Result<RewindOutcome, DomainError>> {
      const found = await find(actor, sessionId, promptSeq);
      if (!found.ok) return found;
      const { session: source, workspace } = found.value;
      if (withFiles) {
        const blocked = await filesBlocked(actor, found.value);
        if (blocked) return err(conflict(blocked));
      }
      const workers = await deps.gateway.status();
      const placed = placeSession(workers, { agentId: source.agentId, requested: source.workerId, projectWorker: source.workerId });
      if (!placed.ok) return placed;
      const allowed = await authorizeWorker(deps.access, actor, placed.value);
      if (!allowed.ok) return allowed;

      // 原会话还在跑就先停下：不然它会接着改文件 / 接着说
      if (source.status === 'running') await interruptSessionUseCase(deps, source.id);

      let files: RewindOutcome['files'] = null;
      if (withFiles) {
        const restored = await deps.files.restoreTurn(source.id, promptSeq);
        if (!restored.ok) return restored;
        files = restored.value;
      }

      const created = forkSession({
        source,
        atSeq: (promptSeq - 1) as never,
        allowEmpty: true,
        agentId: source.agentId,
        model: source.model,
        now: deps.now(),
        workerId: placed.value,
        workspaceId: source.workspaceId,
        createdBy: principalOfSubject(actor)?.user.id ?? null
      });
      if (!created.ok) return created;
      const session = { ...created.value, workerId: placed.value };
      await deps.sessions.save(session);
      const planned = await plan(found.value, placed.value);
      // 原生分叉（ADR 0028）：worker 从原 agent 会话的这条消息之前分出去；不行就新开（resume = null），之前的对话用摘要交接
      const started = await deps.gateway.dispatch(
        startCommand(session, found.value.root || workspace?.path || '', null, source.options, planned.branch ?? undefined)
      );
      if (!started.ok) {
        await deps.sessions.save({ ...session, status: 'failed', updatedAt: deps.now() });
        return err(started.error);
      }
      deps.hosting.add(session.id, session.workerId);

      if (planned.mode !== 'none') {
        const earlier = (await deps.sessions.eventsAfter(source.id, 0 as never)).filter((e) => e.seq < promptSeq);
        const brief = buildHandoff(earlier, {
          from: '同一会话（从一条消息处重来）',
          to: '同一个工作空间',
          root: found.value.root,
          code: files
            ? `文件已回滚到这条消息之前（第 ${files.turn} 轮开始前）的样子。`
            : '注意：文件没有回滚，工作区里可能还留着之后那几轮的改动。'
        }, { sourceSessionId: source.id, ...(handoffCap ? { cap: handoffCap } : {}) });
        if (planned.mode === 'native') {
          pendingBriefs.set(session.id, brief);
        } else {
          await recordEvent(deps, {
            sessionId: session.id,
            event: { kind: 'diagnostic', level: 'warn', text: `没法原生分叉（${planned.reason}），改用摘要交接：agent 只看到之前对话的摘要` }
          });
          const seeded = await promptSessionUseCase(deps, { sessionId: session.id, text: brief.text, briefing: true, handoff: brief.stats });
          if (!seeded.ok) return err(seeded.error);
        }
      }
      // 原会话留个记号（不删任何内容，ADR 0006）
      await recordEvent(deps, {
        sessionId: source.id,
        event: {
          kind: 'diagnostic',
          level: 'info',
          text: `已从第 ${promptSeq} 步那条消息重来${files ? `，文件已回滚（改回 ${files.restored} 个、删掉 ${files.removed} 个）` : '（文件未回滚）'} → 新会话 ${session.id.slice(0, 8)}`
        }
      });
      return ok({ session: (await deps.sessions.byId(session.id)) ?? session, prompt: found.value.prompt, files, mode: planned.mode });
    },

    /** worker 报来这一轮的原生标识：挂到最近一次 ended 之后的第一条消息上（标识在 ended 之前报，消息是立刻记的，不排队）。 */
    async recordTurnRef(sessionId: string, turnRef: string): Promise<void> {
      const events = await deps.sessions.eventsAfter(asSessionId(sessionId), 0 as never);
      let lastEnded = 0;
      for (const e of events) if (e.event.kind === 'ended') lastEnded = e.seq;
      const prompts = events.filter((e) => e.event.kind === 'prompt');
      const target = prompts.find((e) => e.seq > lastEnded) ?? prompts[prompts.length - 1];
      if (target) await deps.turnRefs.record(sessionId, target.seq, turnRef);
    },

    /** worker 回报带 branch 的启动结果：失败就补发交接摘要（worker 已经退成新开会话）。 */
    async branchResult(sessionId: string, outcome: 'native' | 'failed', reason?: string): Promise<void> {
      const brief = pendingBriefs.get(sessionId);
      pendingBriefs.delete(sessionId);
      if (outcome === 'native') {
        await recordEvent(deps, {
          sessionId: asSessionId(sessionId),
          event: { kind: 'diagnostic', level: 'info', text: '已原生分叉：agent 保留了这条消息之前的完整上下文' }
        });
        return;
      }
      await recordEvent(deps, {
        sessionId: asSessionId(sessionId),
        event: { kind: 'diagnostic', level: 'warn', text: `原生分叉失败（${reason ?? '原因不明'}），改用摘要交接：agent 只看到之前对话的摘要` }
      });
      if (brief) await promptSessionUseCase(deps, { sessionId: asSessionId(sessionId), text: brief.text, briefing: true, handoff: brief.stats });
    }
  };
}

export type RewindService = ReturnType<typeof createRewindService>;

/** 同一目录或互为父子目录。 */
export function overlaps(a: string, b: string): boolean {
  const norm = (p: string) => (p.endsWith('/') ? p : `${p}/`);
  return norm(a).startsWith(norm(b)) || norm(b).startsWith(norm(a));
}
