/**
 * 项目主会话（workspace delegation A 阶段，docs/design/workspace-delegation.md §A）。
 *
 * 「哪个项目 + 哪条长期工作空间有一条主会话」是**生产身份**，必须和 hub 数据一起落库、
 * 随快照备份，并且占位必须是原子的。所以这里只定义结构端口：
 * 存储由 `packages/storage-sqlite` 实现，用法（开 / 取 / 复核）在 `apps/server`。
 *
 * 记录刻意不含「状态」：主会话是否还成立，每次读取都用会话本身复核
 * （无任务、`originProjectId` 对得上、在这条工作空间、不是 bot / 群 / 侧聊），
 * 记录过期也不会被自动接管——宁可报冲突，也不重复开一条会话。
 */
export interface CoordinatorRecord {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly createdAt: number;
}

export type CoordinatorReservation =
  | { readonly status: 'reserved'; readonly record: CoordinatorRecord }
  | { readonly status: 'exists'; readonly record: CoordinatorRecord };

/**
 * 主会话登记簿。`reserve` 必须是原子的「没有就占位、有就原样返回」：
 * 双击 / 并发请求 / 进程重启后重试，都只会有一次真正去建会话。
 */
export interface WorkspaceCoordinatorRegistry {
  get(projectId: string, workspaceId: string): Promise<CoordinatorRecord | null>;
  list(projectId: string): Promise<readonly CoordinatorRecord[]>;
  reserve(record: CoordinatorRecord): Promise<CoordinatorReservation>;
  release(record: Pick<CoordinatorRecord, 'projectId' | 'workspaceId' | 'sessionId'>): Promise<void>;
}
