import type { ProjectId, SessionId } from '../ids.ts';
import type { Group, GroupDelivery, GroupPost, GroupThread } from '../groups.ts';

/** 群聊存储（ADR 0018 · 群组）。 */
export interface GroupStore {
  saveGroup(group: Group): Promise<void>;
  group(id: string): Promise<Group | null>;
  groupsOf(projectId: ProjectId): Promise<Group[]>;
  /** 追加一条群消息，seq 由存储分配（群内递增）。 */
  appendPost(post: Omit<GroupPost, 'seq'>): Promise<GroupPost>;
  /** seq 大于 afterSeq 的消息，按 seq 升序，最多 limit 条；afterSeq 为 null 时取最新的 limit 条。 */
  posts(groupId: string, afterSeq: number | null, limit: number): Promise<GroupPost[]>;
  saveThread(thread: GroupThread): Promise<void>;
  thread(id: string): Promise<GroupThread | null>;
  threads(groupId: string, limit: number): Promise<GroupThread[]>;
  runningThreads(groupId: string): Promise<GroupThread[]>;
  saveDelivery(delivery: GroupDelivery): Promise<void>;
  deliveries(threadId: string): Promise<GroupDelivery[]>;
  queuedFor(sessionId: SessionId): Promise<GroupDelivery[]>;
  deliveredTo(sessionId: SessionId): Promise<GroupDelivery[]>;
  /** 还开着（queued / delivered）且创建早于 before 的投递。 */
  openBefore(before: number): Promise<GroupDelivery[]>;
  sessionFor(groupId: string, role: string): Promise<SessionId | null>;
  setSession(groupId: string, role: string, sessionId: SessionId): Promise<void>;
  sessionsOf(groupId: string): Promise<{ role: string; sessionId: SessionId }[]>;
  /** 这条会话是哪个群的哪个角色。 */
  memberOfSession(sessionId: SessionId): Promise<{ groupId: string; role: string } | null>;
  /** 已读到哪条（每人每群一个 seq）：记成 max(原值, seq)，不会倒退。 */
  markRead(groupId: string, userId: string, seq: number): Promise<void>;
  /** 这个人在这个群的未读条数：seq 大于已读位置、且不是他自己发的。 */
  unreadCount(groupId: string, userId: string): Promise<number>;
  /** 群里最新一条的 seq（没有消息为 0）。 */
  latestSeq(groupId: string): Promise<number>;
}
