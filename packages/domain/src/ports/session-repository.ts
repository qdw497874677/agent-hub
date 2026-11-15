import type { ProjectId, Seq, SessionId, TaskId, WorkspaceId } from '../ids.ts';
import type { JournalEntry, SessionEvent } from '../event.ts';
import type { Session } from '../session.ts';

export interface SessionRepository {
  save(session: Session): Promise<void>;
  byId(id: SessionId): Promise<Session | null>;
  listByTask(taskId: TaskId): Promise<Session[]>;
  listByProject(projectId: ProjectId): Promise<Session[]>;
  /** 在这个工作空间里的会话（所有项目；跨项目并发警告 / 改动页计数用）。 */
  listByWorkspace(workspaceId: WorkspaceId): Promise<Session[]>;
  /** 启动对账用：把残留的 running 降级为 interrupted。 */
  listAll(): Promise<Session[]>;
  /** 原子追加：journal 行与 session 的 lastSeq / status 在同一事务里落盘。 */
  append(session: Session, event: SessionEvent, at: number): Promise<void>;
  eventsAfter(sessionId: SessionId, afterSeq: Seq): Promise<JournalEntry[]>;
  /** 最近 N 条事件（时间正序）。画布重开时要靠它把卡片填回来，不能只有实时帧。 */
  tail(sessionId: SessionId, limit: number): Promise<JournalEntry[]>;
  /** 这条会话的第一句提问。列表要靠它认人，不能只看 tail：一轮工具调用就能把开头挤出最近 24 条。 */
  firstPrompt(sessionId: SessionId): Promise<JournalEntry | null>;
  /** 双权威对齐：把平台的 seq 映射到 agent 自己的会话条目 id。 */
  linkEntry(sessionId: SessionId, seq: Seq, agentEntryId: string): Promise<void>;
  entryIdAt(sessionId: SessionId, seq: Seq): Promise<string | null>;
  /** 只改会话名（null = 清掉）；和 save 分开，免得跑着的会话拿旧对象 save 时把名字冲掉。 */
  setTitle(sessionId: SessionId, title: string | null, at: number): Promise<void>;
  /** 只改环境版本；和 save 分开，避免启动时拿旧会话对象覆盖 lastSeq/status。 */
  setEnvironmentRevision(sessionId: SessionId, revision: string | null, at: number): Promise<void>;
  /**
   * 条件写：仅当库里还是 running 时降级为 interrupted（`UPDATE ... WHERE id=? AND status='running'`）。
   * Worker 掉线用它逐条收尾——先 listAll 再整行 save 会把重连时刚接回的状态写回旧值。
   * 返回 true = 确实改了这一行（之前不是 running 就不动，也不推帧）。
   */
  markInterrupted(sessionId: SessionId, at: number): Promise<boolean>;
  /**
   * 条件写：仅当库里还是 interrupted 时拉回 running（Worker 重连、进程其实还活着）。
   * 返回 true = 确实改了这一行；已经 done / 被删的会话不会被旧快照盖回 running。
   */
  markRunning(sessionId: SessionId, at: number): Promise<boolean>;
  /**
   * 彻底删除一条会话：会话行和所有按 session_id 关联的数据（journal、搜索投影、entry_map、artifacts、
   * 连线等）在同一事务里级联清掉。不删工作空间目录，不动 Task。调用方负责先停会话、检查权限。
   */
  remove(id: SessionId): Promise<void>;
}
