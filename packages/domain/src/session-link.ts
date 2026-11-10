import type { ProjectId, SessionId } from './ids.ts';

/**
 * 会话之间显式连接（画布拖线 / 对话页选择）。
 *
 * 无向：只存规范化后的 (a, b)（字符串序小在前），所以同一条关系只有一行。
 * 连接本身不带方向，也不改变消息协议——消息仍是 ADR 0018 的 agent.send / agent.ask，
 * 只是“能找谁”从“同项目所有会话”收紧成“连过的会话”。
 */
export interface SessionLink {
  readonly projectId: ProjectId;
  readonly aSessionId: SessionId;
  readonly bSessionId: SessionId;
  readonly createdBy: string | null;
  readonly createdAt: number;
}

/** 无向边的规范顺序：调用方不用关心谁先谁后。 */
export function canonicalLink(
  projectId: ProjectId,
  one: SessionId,
  other: SessionId,
  createdBy: string | null,
  createdAt: number
): SessionLink {
  const [aSessionId, bSessionId] = one < other ? [one, other] : [other, one];
  return { projectId, aSessionId, bSessionId, createdBy, createdAt };
}

/** 这条边是否连着某个会话。 */
export function linkTouches(link: SessionLink, sessionId: SessionId): boolean {
  return link.aSessionId === sessionId || link.bSessionId === sessionId;
}

/** 从一条边看另一端；不是这条边上的会话返回 null。 */
export function otherEnd(link: SessionLink, sessionId: SessionId): SessionId | null {
  if (link.aSessionId === sessionId) return link.bSessionId;
  if (link.bSessionId === sessionId) return link.aSessionId;
  return null;
}
