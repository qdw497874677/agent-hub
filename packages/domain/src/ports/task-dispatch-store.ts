/** 调度队列（ADR 0032 R3）：一条 = 一个等着 / 正在由任务智能体推进的任务。落库，重启后据此重建并发计数。 */
export type DispatchState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface TaskDispatch {
  readonly id: string;
  readonly taskId: string;
  readonly accountId: string;
  readonly projectId: string;
  readonly title: string;
  readonly goal: string;
  /** 人在对话里让 bot 建的（不计配额那种）：只受全局 + 人工槽约束，排在自动任务前面。 */
  readonly human: boolean;
  /** 建它的 bot 会话：完成后经送达队列通知它。 */
  readonly notifySessionId: string | null;
  /** 任务智能体用哪个运行时（继承建它的 bot）。 */
  readonly agentId: string | null;
  readonly model: string | null;
  readonly originConnector: string | null;
  readonly originExternalId: string | null;
  readonly state: DispatchState;
  readonly workerId: string | null;
  readonly sessionId: string | null;
  readonly waitReason: string | null;
  readonly result: string | null;
  readonly notified: boolean;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly updatedAt: number;
}

export interface TaskDispatchStore {
  /** 同一个 taskId 只入队一次；已有就返回已有的。 */
  insert(d: TaskDispatch): Promise<TaskDispatch>;
  save(d: TaskDispatch): Promise<void>;
  byId(id: string): Promise<TaskDispatch | null>;
  bySession(sessionId: string): Promise<TaskDispatch | null>;
  /** queued + running（含 running 的 worker / 项目，用来重建计数）。 */
  active(): Promise<TaskDispatch[]>;
  /** 结束了但还没通知 bot 的。 */
  unnotified(): Promise<TaskDispatch[]>;
  /** 某账号最近的（UI）。 */
  recent(accountId: string, limit: number): Promise<TaskDispatch[]>;
  byTaskIds(taskIds: readonly string[]): Promise<TaskDispatch[]>;
}
