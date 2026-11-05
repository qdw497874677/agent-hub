/**
 * 调度规则（ADR 0032 R3 / Q7）：纯函数，不碰时钟和存储。
 * 全局 2、每台机器 1、每个项目 1，另留 1 个人工槽。
 * 人在对话里让 bot 建的任务只受「全局 + 人工槽」（即 3）约束，不受每机器 / 每项目限制，且排在自动任务前面。
 * 人直接开的会话、发的消息不经过这里，永远不被队列挡住。
 */
export const DISPATCH_CAPS = { global: 2, perWorker: 1, perProject: 1, humanReserved: 1 } as const;

export interface DispatchCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly human: boolean;
  readonly createdAt: number;
  /** 预计落在哪台机器（项目默认工作空间所在）；null = Server 本机。 */
  readonly workerId: string | null;
  /** 那台机器在不在线。 */
  readonly workerOnline: boolean;
}

export interface RunningSlot { readonly projectId: string; readonly workerId: string | null; readonly human: boolean }

export interface DispatchDecision { readonly start: readonly string[]; readonly waiting: ReadonlyMap<string, string> }

/** 排序：人发起的优先，同优先级先进先出。 */
export function dispatchOrder<T extends { human: boolean; createdAt: number; id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.human === b.human ? a.createdAt - b.createdAt || a.id.localeCompare(b.id) : a.human ? -1 : 1));
}

export function planDispatch(queued: readonly DispatchCandidate[], running: readonly RunningSlot[], caps: typeof DISPATCH_CAPS = DISPATCH_CAPS): DispatchDecision {
  const slots = [...running];
  const start: string[] = [];
  const waiting = new Map<string, string>();
  const key = (w: string | null) => w ?? '(server)';
  for (const c of dispatchOrder(queued)) {
    if (!c.workerOnline) { waiting.set(c.id, '等机器上线'); continue; }
    const total = slots.length;
    if (c.human) {
      if (total >= caps.global + caps.humanReserved) { waiting.set(c.id, '并发已满'); continue; }
    } else {
      // 先报最具体的原因（机器 / 项目），再报全局
      if (slots.filter((s) => key(s.workerId) === key(c.workerId)).length >= caps.perWorker) { waiting.set(c.id, '等机器空位'); continue; }
      if (slots.filter((s) => s.projectId === c.projectId).length >= caps.perProject) { waiting.set(c.id, '等项目空位'); continue; }
      if (total >= caps.global) { waiting.set(c.id, '并发已满'); continue; }
    }
    slots.push({ projectId: c.projectId, workerId: c.workerId, human: c.human });
    start.push(c.id);
  }
  return { start, waiting };
}
