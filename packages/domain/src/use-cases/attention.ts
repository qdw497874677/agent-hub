import { derivePhase, needsHuman, PHASE_RANK, type Phase } from '../attention.ts';
import type { Delivery } from '../delivery.ts';
import { asSessionId } from '../ids.ts';
import type { Project } from '../project.ts';
import { isContainerSession, type Session } from '../session.ts';
import type { Task } from '../task.ts';
import type { AttentionStore } from '../ports/attention-store.ts';
import type { PullRequestRepository } from '../ports/pull-requests.ts';
import type { Deps } from './deps.ts';

export interface AttentionItem {
  readonly sessionId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  /**
   * 会话自己的名字（用户起的）；缺省 = 没起名，界面回退到短标识。
   * 同一任务下可能有多条会话等处理，靠它区分。只带已有的 `session.title`。
   */
  readonly sessionTitle?: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly agentId: string;
  readonly phase: Phase;
  readonly since: number;
  readonly reason: string;
  readonly possible: boolean;
  readonly expiresAt: number | null;
}

export interface AttentionView {
  /** 要人处理、还没看过的（已按急迫度排好）。 */
  readonly items: readonly AttentionItem[];
  /** 正在跑 / 排队的条数（安静态那一行用）。 */
  readonly working: number;
}

/** 只看最近这么久动过的会话：更老的就算卡着也不再催。 */
export const ATTENTION_WINDOW_MS = 14 * 24 * 3600_000;
/** 每条会话读多少条尾部事件来判断阶段（够覆盖最后一轮）。 */
export const ATTENTION_TAIL = 400;
/** 写「人已看过」时最多认多长的会话 id（真实 id 是 UUID；留余量给老数据，不让请求体把库撑爆）。 */
export const ATTENTION_SESSION_ID_MAX = 128;

/**
 * 「等我处理」的可见人：会话发起人，或任务负责人（ADR 0031 D1）。读和写只认这一条。
 */
export function attentionOwnedBy(
  session: Pick<Session, 'createdBy'>,
  task: Pick<Task, 'ownerId'>,
  accountId: string
): boolean {
  return session.createdBy === accountId || task.ownerId === accountId;
}

export interface AttentionTarget {
  readonly session: Session;
  readonly task: Task;
}

/**
 * 写侧的目标校验：与 GET 同一把尺子——非容器、挂着真实任务、会话发起人或任务负责人。
 * 不满足就当作「没有这条」，不区分不存在 / 无权（避免泄露会话是否存在）。
 */
export async function attentionTarget(
  deps: Pick<AttentionDeps, 'sessions' | 'tasks'>,
  input: { readonly accountId: string; readonly sessionId: string }
): Promise<AttentionTarget | null> {
  if (input.sessionId.length === 0 || input.sessionId.length > ATTENTION_SESSION_ID_MAX) return null;
  const session = await deps.sessions.byId(asSessionId(input.sessionId));
  if (!session || session.taskId === null || isContainerSession(session)) return null;
  const task = await deps.tasks.byId(session.taskId);
  if (!task) return null;
  return attentionOwnedBy(session, task, input.accountId) ? { session, task } : null;
}

export interface MarkAttentionInput {
  readonly accountId: string;
  readonly sessionId: string;
  readonly phase: Phase;
  readonly since: number;
  /** true = 记下（默认），false = 撤销。 */
  readonly acked: boolean;
  /** 撤销时带上之前 ack 返回的收据；对不上就不删（挡住迟到的撤销删掉后来的重看）。 */
  readonly receipt?: number;
  readonly at: number;
  /** 项目可见性（与 GET 的 include 同一份）；不给就只看未删除之外不加限制。 */
  readonly include?: (project: Project) => boolean;
}

/**
 * 记下 / 撤销「人已看过」。所有权、项目可见性和 GET 一致；不满足时静默不写（返回 ackedAt: null）。
 * 撤销只删自己账号下的精确元组，不做任何清扫。
 */
export async function markAttention(
  deps: AttentionDeps,
  input: MarkAttentionInput
): Promise<{ readonly ackedAt: number | null; readonly undone?: boolean }> {
  const target = await attentionTarget(deps, input);
  if (!target) return { ackedAt: null };
  const include = input.include ?? (() => true);
  const project = await deps.projects.byId(target.task.projectId);
  if (!project || !include(project)) return { ackedAt: null };
  const ack = { sessionId: target.session.id, phase: input.phase, since: input.since };
  if (!input.acked) {
    return { ackedAt: null, undone: await deps.attention.unack(input.accountId, ack, input.receipt) };
  }
  return { ackedAt: await deps.attention.ack(input.accountId, ack, input.at) };
}

export interface AttentionDeps extends Pick<Deps, 'projects' | 'tasks' | 'sessions'> {
  readonly attention: AttentionStore;
  readonly deliveries?: { pendingFor(sessionId: string): Promise<Delivery[]> };
  readonly pullRequests?: Pick<PullRequestRepository, 'byTask'>;
}

/**
 * 「等我处理」：只看我发起的、或我负责的任务下的会话（ADR 0031 D1）。不推送，只给角标和收件箱。
 */
export async function loadAttention(
  deps: AttentionDeps,
  input: { readonly accountId: string; readonly now: number; readonly include?: (p: Project) => boolean }
): Promise<AttentionView> {
  const include = input.include ?? (() => true);
  const acked = new Set((await deps.attention.acks(input.accountId)).map((a) => `${a.sessionId}|${a.phase}|${a.since}`));
  const items: AttentionItem[] = [];
  let working = 0;
  for (const project of (await deps.projects.list()).filter(include)) {
    const tasks = new Map((await deps.tasks.listByProject(project.id)).map((t) => [t.id as string, t]));
    for (const session of await deps.sessions.listByProject(project.id)) {
      if (session.updatedAt < input.now - ATTENTION_WINDOW_MS) continue;
      // 容器会话不属于任务：没有任务就没有「任务负责人」可判断，不进待办（#221 步骤 7）。
      if (isContainerSession(session)) continue;
      const task = tasks.get(session.taskId as string);
      if (!task) continue;
      if (!attentionOwnedBy(session, task, input.accountId)) continue;
      const events = await deps.sessions.eventsAfter(session.id, Math.max(0, session.lastSeq - ATTENTION_TAIL) as never);
      const pending = deps.deliveries ? await deps.deliveries.pendingFor(session.id) : [];
      const prs = deps.pullRequests ? (await deps.pullRequests.byTask(task.id)).filter((p) => !p.sessionId || p.sessionId === session.id) : [];
      const view = derivePhase({ session, events, pending, prCreatedAt: prs.map((p) => p.createdAt), now: input.now });
      if (view.phase === 'working' || view.phase === 'queued') working++;
      if (!needsHuman(view.phase) || acked.has(`${session.id}|${view.phase}|${view.since}`)) continue;
      const sessionTitle = session.title?.trim();
      items.push({
        sessionId: session.id, taskId: task.id, taskTitle: task.title,
        ...(sessionTitle === undefined || sessionTitle === '' ? {} : { sessionTitle }),
        projectId: project.id, projectName: project.name,
        agentId: session.agentId, phase: view.phase, since: view.since, reason: view.reason,
        possible: view.possible === true, expiresAt: view.expiresAt ?? null
      });
    }
  }
  items.sort((a, b) => PHASE_RANK[a.phase] - PHASE_RANK[b.phase] || b.since - a.since);
  return { items, working };
}
