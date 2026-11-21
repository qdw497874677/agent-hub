import type { ProjectId, TaskId, WorkspaceId } from '../ids.ts';
import type { ProjectWorkspaceLink, Workspace } from '../workspace.ts';

/** 认领一个长期工作空间：同一时间只允许一个项目持有。 */
export interface WorkspaceClaim {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly linkedBy: string | null;
  readonly linkedAt: number;
}

/**
 * claim 的结果（#233）：
 * - `claimed`：新建认领；
 * - `owned`：已经是这个项目（幂等，保留原 linkedBy / linkedAt）；
 * - `conflict`：已被别的项目认领，未做任何修改。
 */
export type WorkspaceClaimOutcome =
  | { readonly status: 'claimed' | 'owned'; readonly link: ProjectWorkspaceLink }
  | { readonly status: 'conflict'; readonly owner: ProjectWorkspaceLink }
  /** 同一团队 / 机器 / 目录有多条历史长期登记：先别把其中任一条认领成新归属。 */
  | { readonly status: 'ambiguous'; readonly candidates: readonly Workspace[] };

/** 原子换认领者：expectedProjectIds 是调用方读到的「当前其他认领者」集合。 */
export interface WorkspaceTransfer extends WorkspaceClaim {
  /**
   * 调用方观察到的、除目标项目以外的当前认领者。必须与库里一致才替换——
   * 不一致说明期间有人认领 / 转移，返回 stale 且不动现任（#233）。
   */
  readonly expectedProjectIds: readonly ProjectId[];
}

/**
 * transfer 的结果：
 * - `transferred`：完成替换；
 * - `owned`：目标项目已经持有（幂等，不覆盖元数据）；
 * - `stale`：当前归属与调用方观察的不一致，未做任何修改；owner 是现在的认领者。
 */
export type WorkspaceTransferOutcome =
  | { readonly status: 'transferred' | 'owned'; readonly link: ProjectWorkspaceLink }
  | { readonly status: 'stale'; readonly owner: ProjectWorkspaceLink | null }
  | { readonly status: 'ambiguous'; readonly candidates: readonly Workspace[] };

/**
 * 保存登记的结果（ADR 0026 §6）：
 * - `saved`：写入了这次登记；
 * - `existing`：同团队 / 机器 / 目录已经有唯一一条活跃长期登记，复用那条（不写、不改现任）；
 * - `ambiguous`：这个位置有多条历史长期登记，无法安全判断该复用哪条，未写入；
 * - `place-taken`：已有登记改到别的目录时撞上了那里已有的登记，未写入。
 */
export type WorkspaceSaveOutcome =
  | { readonly status: 'saved' | 'existing'; readonly workspace: Workspace }
  | { readonly status: 'ambiguous'; readonly candidates: readonly Workspace[] }
  | { readonly status: 'place-taken'; readonly existing: Workspace };

export interface WorkspaceRepository {
  /**
   * 保存登记，并在同一个事务里做目录唯一性检查（#233）：
   * - 新建长期工作空间撞到唯一一条同位置登记 → 返回 existing，绝不插入第二条；
   * - 同位置有多条历史登记 → 返回 ambiguous，保留所有旧行；
   * - 已有登记改目录撞到别的登记 → 返回 place-taken，不静默改写；
   * - 第一次保存带 projectId 的长期工作空间时顺带认领，但已经属于别的项目时保留现任、只记警告。
   */
  save(workspace: Workspace): Promise<WorkspaceSaveOutcome>;
  byId(id: WorkspaceId): Promise<Workspace | null>;
  /**
   * 项目能用的全部登记（含 removed，调用方自己筛）：关联到它的长期工作空间 + 它自己的临时工作空间（ADR 0026）。
   */
  byProject(projectId: ProjectId): Promise<Workspace[]>;
  byTask(taskId: TaskId): Promise<Workspace[]>;
  /** 所有还没 removed 的临时工作空间——清理扫描用。 */
  temporaries(): Promise<Workspace[]>;
  /** 某台机器（null = 和 Server 同机）上还没 removed 的登记——唯一性检查用。 */
  onMachine(workerId: string | null): Promise<Workspace[]>;
  /** 所有还没 removed 的长期工作空间（团队页，调用方按团队 / 权限筛）。 */
  longLived(): Promise<Workspace[]>;
  /**
   * 认领（#233）：同项目重复认领幂等且保留元数据；别的项目已持有 → conflict 且不改动。
   * 检查与写入必须在同一个事务里；这次不需要迁移，唯一索引是最后兜底。
   */
  claim(claim: WorkspaceClaim): Promise<WorkspaceClaimOutcome>;
  /**
   * 原子转移（#233）：在同一个事务里比较 expectedProjectIds 与当前归属，
   * 只有完全一致才移除其他认领并写入目标；否则 stale，现任不受影响。
   */
  transfer(transfer: WorkspaceTransfer): Promise<WorkspaceTransferOutcome>;
  unlink(projectId: ProjectId, workspaceId: WorkspaceId): Promise<void>;
  /** 这个工作空间关联了哪些项目。 */
  linksOf(workspaceId: WorkspaceId): Promise<ProjectWorkspaceLink[]>;
}
