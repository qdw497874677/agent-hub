/** JSON data only. Callers must not put credentials, tokens or other secrets in either payload. */
export type PlannedWorktreeJson = null | boolean | number | string | readonly PlannedWorktreeJson[] | { readonly [key: string]: PlannedWorktreeJson };

export type PlannedWorktreeState = 'draft' | 'pending' | 'unknown' | 'ready-unused' | 'closed' | 'failed';

/** Plan and ownership never change after creation. Caller supplies an unguessable, actor-bound id.
 * Protected IDs include outputs AND bases; they are retained as associations after closure or failure. */
export interface PlannedWorktree<Plan = PlannedWorktreeJson, Progress = PlannedWorktreeJson> {
  readonly id: string;
  readonly actorId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly createdAt: number;
  readonly plan: Plan;
  readonly revision: number;
  readonly state: PlannedWorktreeState;
  readonly progress: Progress;
  readonly protectedWorkspaceIds: readonly string[];
  readonly protectedGroupIds: readonly string[];
}

export type NewPlannedWorktree<Plan = PlannedWorktreeJson, Progress = PlannedWorktreeJson> = Omit<PlannedWorktree<Plan, Progress>, 'revision' | 'state'> & { readonly state: 'draft' | 'pending' };
export type PlannedWorktreeUpdate<Progress = PlannedWorktreeJson> = Pick<PlannedWorktree<unknown, Progress>, 'state' | 'progress' | 'protectedWorkspaceIds' | 'protectedGroupIds'>;

/** Caller must authorize reads, only persist secret-free JSON, and serialize cleanup against protection decisions. */
export interface PlannedWorktreeStore<Plan = PlannedWorktreeJson, Progress = PlannedWorktreeJson> {
  /** Returns false on duplicate id; never overwrites an existing plan. */
  create(record: NewPlannedWorktree<Plan, Progress>): boolean;
  get(id: string): PlannedWorktree<Plan, Progress> | null;
  listByTask(taskId: string): readonly PlannedWorktree<Plan, Progress>[];
  /** Includes terminal and draft records; caller interprets plan-specific predicates. */
  listByProjectWorker(projectId: string, workerId: string): readonly PlannedWorktree<Plan, Progress>[];
  /** Includes terminal and draft records; IDs are associations even when not protected. */
  byWorkspaceId(workspaceId: string): readonly PlannedWorktree<Plan, Progress>[];
  /** Closed and failed are terminal. Failed is only allowed from pending or unknown, when the caller has proven no side effects or outputs. Returns null on conflict or invalid transition. */
  compareAndSet(id: string, expectedRevision: number, update: PlannedWorktreeUpdate<Progress>): PlannedWorktree<Plan, Progress> | null;
  isWorkspaceProtected(workspaceId: string): boolean;
  isGroupProtected(groupId: string): boolean;
}
