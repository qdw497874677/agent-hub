import type { SessionEvent } from './event.ts';

/**
 * 运行时批准（ADR 0023）：运行时要人批准一个动作时，hub 推一张「允许 / 拒绝」卡，人点了再回给运行时。
 * 这里是运行时侧通用的那一半：发卡、计时、收答案、超时当拒绝、会话关了全部拒绝。
 * 每个适配器只要把「回运行时」（send）接上，Hermes 之外的运行时也照这个用。
 */
export type ApprovalDecision = 'allow' | 'deny';

/** 默认等多久（毫秒）。比 Hermes 自己的 approvals.timeout（300s）短，hub 先收尾，结论一定是 hub 定的。 */
export const APPROVAL_TIMEOUT_MS = 180_000;

export interface ApprovalRequest {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
}

export interface ApprovalGateOptions {
  /** 推一条事件到会话事件流（request / resolved）。 */
  readonly push: (event: SessionEvent) => void;
  /** 把结论回给运行时。失败了 gate 也认为已经收尾（不会再发第二次）。 */
  readonly send: (id: string, decision: ApprovalDecision) => Promise<void>;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface ApprovalGate {
  request(request: ApprovalRequest): void;
  /** 人回答了。不认识 / 已经收尾的 id 返回 false（重复点、超时之后才点）。 */
  respond(id: string, decision: ApprovalDecision, author?: { readonly id: string; readonly name: string }): Promise<boolean>;
  /** 运行时自己撤了请求（比如这一轮被停了）：收掉卡片，不回运行时。 */
  withdraw(id: string): void;
  pending(): readonly string[];
  /** 会话关了：所有没回答的都当拒绝（回给运行时），卡片收掉。 */
  close(): Promise<void>;
}

export function createApprovalGate(options: ApprovalGateOptions): ApprovalGate {
  const timeoutMs = options.timeoutMs ?? APPROVAL_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const open = new Map<string, unknown>();

  async function settle(id: string, decision: ApprovalDecision, by: 'user' | 'timeout', author?: { readonly id: string; readonly name: string }): Promise<boolean> {
    if (!open.has(id)) return false;
    clearTimer(open.get(id));
    open.delete(id);
    options.push({ kind: 'approval', phase: 'resolved', id, decision, by, ...(author ? { author } : {}) });
    await options.send(id, decision).catch(() => undefined);
    return true;
  }

  return {
    request(request) {
      if (open.has(request.id)) return;
      const expiresAt = now() + timeoutMs;
      open.set(
        request.id,
        setTimer(() => void settle(request.id, 'deny', 'timeout'), timeoutMs)
      );
      options.push({
        kind: 'approval',
        phase: 'request',
        id: request.id,
        title: request.title.slice(0, 4000),
        ...(request.detail ? { detail: request.detail.slice(0, 20000) } : {}),
        expiresAt
      });
    },
    respond: (id, decision, author) => settle(id, decision, 'user', author),
    withdraw(id) {
      if (!open.has(id)) return;
      clearTimer(open.get(id));
      open.delete(id);
      options.push({ kind: 'approval', phase: 'resolved', id, decision: 'deny', by: 'runtime' });
    },
    pending: () => [...open.keys()],
    async close() {
      for (const id of [...open.keys()]) await settle(id, 'deny', 'timeout');
    }
  };
}

/**
 * 从事件流里算出还开着的批准请求（服务端校验回答、网页播种用）。
 * 收掉了的、过期了的都不算——过期的那张卡运行时侧会补一条 resolved(timeout)。
 */
export function openApprovals(events: readonly SessionEvent[], at: number): ReadonlyMap<string, Extract<SessionEvent, { kind: 'approval' }>> {
  const out = new Map<string, Extract<SessionEvent, { kind: 'approval' }>>();
  for (const event of events) {
    if (event.kind !== 'approval') continue;
    if (event.phase === 'request') out.set(event.id, event);
    else out.delete(event.id);
  }
  for (const [id, event] of out) if (typeof event.expiresAt === 'number' && event.expiresAt <= at) out.delete(id);
  return out;
}
