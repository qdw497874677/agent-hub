import { principalOfSubject, type Subject } from '../access.ts';
import { forkSession, type Session } from '../session.ts';
import type { TurnCheckpoint, RestoreOutcome, TurnRefStore } from '../ports/workspace-browser.ts';
import type { BranchSpec } from '../ports/agent-runtime.ts';
import { allowsFor, unavailableReason } from '../capability.ts';
import type { Workspace } from '../workspace.ts';
import { asSessionId, newId } from '../ids.ts';
import { conflict, invalid, notFound, type DomainError } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import { placeSession } from '../worker.ts';
import { authorizeSession, authorizeWorker } from './authorization.ts';
import type { Deps } from './deps.ts';
import { startSessionUseCase } from './start-session.ts';
import { interruptSessionUseCase, recordEvent } from './sessions.ts';
import { promptSessionUseCase } from './conversation.ts';
import { buildHandoff } from '../handoff.ts';
import type { BranchAttemptStore, BranchReceipt } from '../ports/branch-attempt.ts';
export type { BranchAttempt, BranchAttemptStore, BranchOutcome, BranchReceipt, BranchSettlement } from '../ports/branch-attempt.ts';
import { locationsOf, projectOfSession } from './workspaces.ts';
import { withActiveTask } from './task-admission.ts';
import { findDeliveryEnded } from './delivery.ts';

/**
 * 回滚到某条消息（ADR 0027 阶段 4）：「⋯ → 从这里重来」。
 * - 只回滚对话：现在接入的 runtime 都没有原生 rewind（ACP 只有 list / resume / close），一律按 D8 从这条消息之前
 *   fork 一条新会话（ADR 0012 血缘，原会话一个字不删），之前的对话压成交接摘要发给新 agent，原消息回填到输入框。
 * - 连文件一起回滚：暂不可用；中断会话或检查目录并不能证明工作区不会被写入。
 */
export interface RewindFiles {
  turnFor(sessionId: string, promptSeq: number): Promise<TurnCheckpoint | null>;
  /** 会话所有回合（不鉴权，调用方已鉴权）。 */
  turnsOf(sessionId: string): Promise<readonly TurnCheckpoint[]>;
  restoreTurn(sessionId: string, promptSeq: number): Promise<Result<RestoreOutcome & { readonly turn: number }, DomainError>>;
}

export type RewindDeps = Pick<
  Deps,
  'agents' | 'artifacts' | 'fs' | 'gateway' | 'hosting' | 'now' | 'projects' | 'queue' | 'sessions' | 'stream' | 'tasks' | 'taskGate' | 'workspaces' | 'workLog' | 'access' | 'deliveries' | 'workspaceGroups' | 'bots'
> & { readonly files: RewindFiles; readonly turnRefs: TurnRefStore; readonly branchAttemptWriter?: BranchAttemptStore; readonly supportsNativeBranch?: (workerId: string, agentId: string) => boolean; readonly onBranchBriefReady?: () => void | Promise<void> };

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

type Plan =
  | { readonly mode: 'native'; readonly reason: null; readonly branch: BranchSpec }
  | { readonly mode: 'summary'; readonly reason: string; readonly branch: null }
  | { readonly mode: 'none'; readonly reason: null; readonly branch: null };

/** Native identifiers are untrusted and must match the receipt's bounded-ref rules. */
function validNativeRef(ref: unknown): ref is string {
  return typeof ref === 'string' && !!ref.trim() && ref.trim().toLowerCase() !== 'pending' && new TextEncoder().encode(ref).length <= 512;
}

export function createRewindService(deps: RewindDeps) {
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
    if (!validNativeRef(session.agentSessionRef)) return summary('原会话没有记下 agent 自己的会话 id');
    if (workerId !== null && workerId !== session.workerId) return summary('原会话所在的机器现在不可用，换机器只能摘要交接');
    if (!session.workerId || !deps.branchAttemptWriter || !deps.deliveries || !deps.supportsNativeBranch?.(session.workerId, session.agentId)) return summary('这台机器上的 Agent 不支持可靠原生分叉，改用摘要交接');
    const refs = await deps.turnRefs.listVerified?.(session.id);
    const validated = async (seq: number): Promise<string | null> => {
      const ref = refs?.get(seq);
      if (!ref || !validNativeRef(ref.turnRef) || !ref.deliveryId) return null;
      const delivery = await deps.deliveries!.byId(ref.deliveryId);
      if (!delivery || delivery.id !== ref.deliveryId || delivery.sessionId !== session.id || delivery.kind !== 'prompt' || delivery.seq !== seq || !Number.isSafeInteger(seq) || seq < 1) return null;
      if (delivery.state !== 'sending' && (delivery.state !== 'delivered' || !(await findDeliveryEnded(deps, delivery)))) return null;
      return ref.turnRef;
    };
    const turnRef = await validated(promptSeq);
    const previousTurnRef = await validated(earlier[earlier.length - 1]!.seq);
    if (!turnRef || !previousTurnRef) return summary('这条消息没有记下原生标识（功能上线之前的消息）');
    return { mode: 'native', reason: null, branch: { fromAgentSessionRef: session.agentSessionRef, turnRef, previousTurnRef } };
  }

  async function find(actor: Subject | null, sessionId: string, promptSeq: number): Promise<Result<Found, DomainError>> {
    if (!Number.isInteger(promptSeq) || promptSeq < 1) return err(invalid('消息序号不对'));
    const session = await deps.sessions.byId(asSessionId(sessionId));
    // 容器会话（#221 步骤 7）没有任务：按组合工作空间 / bot 找回项目。
    const project = session ? await projectOfSession(deps, session) : null;
    const seen = await authorizeSession(deps.access, actor, project, session, 'session.prompt');
    if (!seen.ok) return seen;
    const entry = (await deps.sessions.eventsAfter(seen.value.id, (promptSeq - 1) as never)).find((e) => e.seq === promptSeq);
    if (!entry || entry.event.kind !== 'prompt') return err(notFound('找不到这条消息'));
    const workspace = seen.value.workspaceId ? await deps.workspaces.byId(seen.value.workspaceId) : null;
    const location = project ? await locationsOf(deps, project, seen.value) : { root: '' };
    return ok({ session: seen.value, promptSeq, prompt: entry.event.text, projectId: project!.id, workspace, root: location.root });
  }

  /** 未有受保护的工作区操作，任何文件回滚都必须拒绝。 */
  function filesBlocked(found: Found): string {
    const { session, workspace } = found;
    // 组合工作空间（§12.3 v1）：容器不是 git 仓库，不做跨仓回滚。
    if (session.groupId) return '组合工作目录暂不支持回滚，请在成员仓库里各自提交';
    if (!workspace) return '这条会话没有工作目录';
    if (workspace.kind !== 'temporary') return '只有临时工作目录能连文件一起回滚；持久工作目录请只回滚会话';
    if (!workspace.isGit) return '当前目录不是 git 仓库，不能恢复文件';
    return '暂不能安全回滚文件：无法保证工作目录不会被其他进程修改；请只回滚对话，或手动检查并恢复文件';
  }

  return {
    async preview(actor: Subject | null, sessionId: string, promptSeq: number): Promise<Result<RewindPreview, DomainError>> {
      const found = await find(actor, sessionId, promptSeq);
      if (!found.ok) return found;
      const blocked = filesBlocked(found.value);
      const turnsAfter = (await deps.files.turnsOf(found.value.session.id)).filter((t) => t.promptSeq >= promptSeq).length;
      const planned = await plan(found.value, null);
      return ok({ promptSeq, prompt: found.value.prompt, filesAllowed: blocked === null, filesBlocked: blocked, turnsAfter, mode: planned.mode, modeReason: planned.reason, agentLabel: deps.agents.descriptor(found.value.session.agentId)?.label ?? found.value.session.agentId });
    },

    async rewind(actor: Subject | null, sessionId: string, promptSeq: number, withFiles: boolean): Promise<Result<RewindOutcome, DomainError>> {
      const found = await find(actor, sessionId, promptSeq);
      if (!found.ok) return found;
      if (withFiles) return err(conflict(filesBlocked(found.value)));
      return withActiveTask(deps, found.value.session.taskId, async () => {
        const { session: source, workspace } = found.value;
        const workers = await deps.gateway.status();
        const placed = placeSession(workers, { agentId: source.agentId, requested: source.workerId, projectWorker: source.workerId, model: source.model });
        if (!placed.ok) return placed;
        const allowed = await authorizeWorker(deps.access, actor, placed.value);
        if (!allowed.ok) return allowed;

        // 原会话还在跑就先停下：不然它会接着改文件 / 接着说
        if (source.status === 'running') await interruptSessionUseCase(deps, source.id);

        const created = forkSession({
          source,
          atSeq: (promptSeq - 1) as never,
          allowEmpty: true,
          options: source.options,
          agentId: source.agentId,
          model: source.model,
          now: deps.now(),
          workerId: placed.value,
          workspaceId: source.workspaceId,
          createdBy: principalOfSubject(actor)?.user.id ?? null
        });
        if (!created.ok) return created;
        const session = { ...created.value, workerId: placed.value };
        const planned = await plan(found.value, placed.value);
        const earlier = planned.mode === 'none' ? [] : (await deps.sessions.eventsAfter(source.id, 0 as never)).filter((e) => e.seq < promptSeq);
        const brief = planned.mode === 'none' ? null : buildHandoff(earlier, {
          from: '同一会话（从一条消息处重来）', to: '同一个工作目录', root: found.value.root,
          code: '注意：文件没有回滚，工作目录里可能还留着之后那几轮的改动。'
        }, { sourceSessionId: source.id, ...(handoffCap ? { cap: handoffCap } : {}) });
        let branchAttemptId: string | undefined;
        if (planned.mode === 'native' && brief && deps.branchAttemptWriter) {
          const now = deps.now();
          branchAttemptId = newId();
          const attempt = { id: branchAttemptId, sessionId: session.id, workerId: placed.value, brief, state: 'pending' as const, createdAt: now, updatedAt: now, sourceAgentSessionRef: planned.branch.fromAgentSessionRef };
          await deps.branchAttemptWriter.stage(session, attempt);
        } else {
          await deps.sessions.save(session);
        }
        // 原生分叉（ADR 0028）：worker 从原 agent 会话的这条消息之前分出去；不行就新开（resume = null），之前的对话用摘要交接
        // plan 留在保存之后、派发之前：plan 抛错时会话已在，但还不是 failed，也不托管。
        const started = await startSessionUseCase(deps, {
          session,
          workspaceRoot: found.value.root || workspace?.path || '',
          resume: null,
          ...(planned.branch ? { branch: planned.branch } : {}),
          ...(branchAttemptId ? { branchAttemptId, markFailed: false } : {}),
          inheritedOptions: source.options
        });
        if (!started.ok) return started;

        if (planned.mode === 'summary' && brief) {
            await deps.queue.run(session.id, () => recordEvent(deps, {
              sessionId: session.id,
              event: { kind: 'diagnostic', level: 'warn', text: `没法原生分叉（${planned.reason}），改用摘要交接：agent 只看到之前对话的摘要` }
            }));
            const seeded = await promptSessionUseCase(deps, { sessionId: session.id, text: brief.text, briefing: true, handoff: brief.stats });
            if (!seeded.ok) return err(seeded.error);
        }
        // 原会话留个记号（不删任何内容，ADR 0006）
        await deps.queue.run(source.id, () => recordEvent(deps, {
          sessionId: source.id,
          event: {
            kind: 'diagnostic',
            level: 'info',
            text: `已从第 ${promptSeq} 步那条消息重来（文件未回滚） → 新会话 ${session.id.slice(0, 8)}`
          }
        }));
        return ok({ session: (await deps.sessions.byId(session.id)) ?? session, prompt: found.value.prompt, files: null, mode: planned.mode });
      });
    },

    /** A native ref is usable only with its exact worker and prompt delivery evidence. */
    async recordTurnRef(sessionId: string, turnRef: string, workerId?: string, deliveryId?: string): Promise<void> {
      if (!workerId || !deliveryId || !validNativeRef(turnRef) || !deps.deliveries) return;
      await deps.queue.run(asSessionId(sessionId), async () => {
        const session = await deps.sessions.byId(asSessionId(sessionId));
        if (!session || session.workerId !== workerId) return;
        const delivery = await deps.deliveries!.byId(deliveryId);
        if (!delivery || delivery.id !== deliveryId || delivery.sessionId !== sessionId || delivery.kind !== 'prompt' || !Number.isSafeInteger(delivery.seq) || delivery.seq < 1) return;
        const events = await deps.sessions.eventsAfter(asSessionId(sessionId), (delivery.seq - 1) as never);
        if (!events.some((entry) => entry.seq === delivery.seq && entry.event.kind === 'prompt')) return;
        if (delivery.state !== 'sending' && (delivery.state !== 'delivered' || !events.some((entry) => entry.seq > delivery.seq && entry.event.kind === 'ended' && entry.event.deliveryId === deliveryId))) return;
        await deps.turnRefs.record(sessionId, delivery.seq, turnRef, deliveryId);
      });
    },

    /** Legacy result calls lack identity and deliberately cannot settle an attempt. */
    async branchResult(sessionId: string, attemptId: string, workerId?: string, receipt?: BranchReceipt): Promise<void> {
      const writer = deps.branchAttemptWriter;
      if (!writer || !workerId || !receipt) return;
      const settled = await deps.queue.run(asSessionId(sessionId), async () => {
        const result = await writer.settle(sessionId, attemptId, workerId, receipt, deps.now());
        if (result.kind === 'settled' && (result.event || receipt.outcome === 'both_failed')) deps.stream.publish({ sessionId: result.session.id, seq: result.session.lastSeq, event: result.event, status: result.session.status });
        return result;
      });
      if (settled.kind !== 'settled') return;
      if (settled.delivery) await deps.onBranchBriefReady?.();
    }
  };
}

export type RewindService = ReturnType<typeof createRewindService>;

/** 同一目录或互为父子目录。 */
export function overlaps(a: string, b: string): boolean {
  const norm = (p: string) => (p.endsWith('/') ? p : `${p}/`);
  return norm(a).startsWith(norm(b)) || norm(b).startsWith(norm(a));
}
