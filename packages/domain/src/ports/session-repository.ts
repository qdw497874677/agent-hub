import type { ProjectId, Seq, SessionId, TaskId } from '../ids.ts';
import type { JournalEntry, SessionEvent } from '../event.ts';
import type { Session } from '../session.ts';

export interface SessionRepository {
  save(session: Session): Promise<void>;
  byId(id: SessionId): Promise<Session | null>;
  listByTask(taskId: TaskId): Promise<Session[]>;
  listByProject(projectId: ProjectId): Promise<Session[]>;
  /** 启动对账用：把残留的 running 降级为 interrupted。 */
  listAll(): Promise<Session[]>;
  /** 原子追加：journal 行与 session 的 lastSeq / status 在同一事务里落盘。 */
  append(session: Session, event: SessionEvent, at: number): Promise<void>;
  eventsAfter(sessionId: SessionId, afterSeq: Seq): Promise<JournalEntry[]>;
  /** 最近 N 条事件（时间正序）。画布重开时要靠它把卡片填回来，不能只有实时帧。 */
  tail(sessionId: SessionId, limit: number): Promise<JournalEntry[]>;
  /** 双权威对齐：把平台的 seq 映射到 agent 自己的会话条目 id。 */
  linkEntry(sessionId: SessionId, seq: Seq, agentEntryId: string): Promise<void>;
  entryIdAt(sessionId: SessionId, seq: Seq): Promise<string | null>;
  /** 只改会话名（null = 清掉）；和 save 分开，免得跑着的会话拿旧对象 save 时把名字冲掉。 */
  setTitle(sessionId: SessionId, title: string | null, at: number): Promise<void>;
}
