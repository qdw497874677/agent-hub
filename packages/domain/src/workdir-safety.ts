/** Durable terminal occupancy and removal admission. All admission operations must
 * be called inside the same single-Hub lease. */
export type WorkdirTerminalState = 'pending' | 'running' | 'closing' | 'ended';
export interface WorkdirTerminal {
  readonly id: string;
  readonly requestId: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly workerId: string;
  readonly cwd: string;
  readonly epoch: string | null;
  readonly state: WorkdirTerminalState;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface WorkdirTerminalStore {
  create(record: WorkdirTerminal): WorkdirTerminal;
  get(id: string): WorkdirTerminal | null;
  getByRequest(ownerId: string, requestId: string): WorkdirTerminal | null;
  listNonEnded(): readonly WorkdirTerminal[];
  listByOwner(ownerId: string): readonly WorkdirTerminal[];
  listByWorkspace(workspaceId: string): readonly WorkdirTerminal[];
  listByProject(projectId: string): readonly WorkdirTerminal[];
  transition(id: string, expectedState: WorkdirTerminalState, expectedEpoch: string | null, nextState: WorkdirTerminalState, nextEpoch: string | null, updatedAt: number): WorkdirTerminal | null;
}
export interface WorkdirTarget {
  readonly workspaceId: string;
  readonly workerId: string | null;
  readonly cwd: string;
}
export interface WorkdirSafety {
  /** Synchronous startup drain check; storage errors propagate and must fail closed. */
  hasOutstanding(): boolean;
  runExclusive<T>(fn: () => Promise<T> | T): Promise<T>;
  assertNoRemoval(target: WorkdirTarget): void;
  assertUnoccupied(target: WorkdirTarget): void;
  assertProjectUnoccupied(projectId: string): void;
  beginRemoval(target: WorkdirTarget): string;
  finishRemoval(id: string): void;
}
