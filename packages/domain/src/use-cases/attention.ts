import { derivePhase, needsHuman, PHASE_RANK, type Phase } from '../attention.ts';
import type { Delivery } from '../delivery.ts';
import type { Project } from '../project.ts';
import type { AttentionStore } from '../ports/attention-store.ts';
import type { PullRequestRepository } from '../ports/pull-requests.ts';
import type { Deps } from './deps.ts';

export interface AttentionItem {
  readonly sessionId: string;
  readonly taskId: string;
  readonly taskTitle: string;
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
      const task = tasks.get(session.taskId);
      if (!task) continue;
      if (session.createdBy !== input.accountId && task.ownerId !== input.accountId) continue;
      const events = await deps.sessions.eventsAfter(session.id, Math.max(0, session.lastSeq - ATTENTION_TAIL) as never);
      const pending = deps.deliveries ? await deps.deliveries.pendingFor(session.id) : [];
      const prs = deps.pullRequests ? (await deps.pullRequests.byTask(task.id)).filter((p) => !p.sessionId || p.sessionId === session.id) : [];
      const view = derivePhase({ session, events, pending, prCreatedAt: prs.map((p) => p.createdAt), now: input.now });
      if (view.phase === 'working' || view.phase === 'queued') working++;
      if (!needsHuman(view.phase) || acked.has(`${session.id}|${view.phase}|${view.since}`)) continue;
      items.push({
        sessionId: session.id, taskId: task.id, taskTitle: task.title, projectId: project.id, projectName: project.name,
        agentId: session.agentId, phase: view.phase, since: view.since, reason: view.reason,
        possible: view.possible === true, expiresAt: view.expiresAt ?? null
      });
    }
  }
  items.sort((a, b) => PHASE_RANK[a.phase] - PHASE_RANK[b.phase] || b.since - a.since);
  return { items, working };
}
