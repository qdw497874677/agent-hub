import type { ProjectId, TaskId, WorkspaceGroupId, WorkspaceId } from './ids.ts';
import { invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/**
 * 组合工作空间（docs/design/multi-repo.md）：一条会话落在一个容器目录里，容器下面每个子目录是一个
 * 单仓库 checkout。成员本身仍是普通的 Workspace 行，组合只是「它们属于同一台机器、同一组分支」的
 * 归属关系 + 一个不是 git 仓库的容器根。
 *
 * 不变量：
 * - 成员的 workspace 一律 kind=temporary / source=worktree，由本组新建，不复用已有空间。
 * - 组只在一台机器上（workerId 相同），容器 root 由 domain 算，必须在 Worker 的 groups 目录下。
 * - 成员最多 8 个，名字项目内唯一。
 * - 新组 layout=amp：cwd 是主仓库目录，附加仓在 <root>/repos/<name>/；老组 layout=flat 仍以容器根为 cwd。
 */
export interface WorkspaceGroupMember {
  readonly workspaceId: WorkspaceId;
  /** 对应 Project.repos[].id。 */
  readonly repoId: string | null;
  /** 新计划的显式来源；本地来源不伪造项目仓库 ID。 */
  readonly projectRepoId?: string | null;
  readonly sourceWorkspaceId?: WorkspaceId | null;
  /** 子目录名（= 仓库名）。amp 布局下主仓库在容器根下，附加仓在 repos/ 下。 */
  readonly name: string;
  /** 准备状态：preparing 还在建，ready 能派发，failed 要看 error。 */
  readonly state: 'preparing' | 'ready' | 'failed';
  readonly error: string | null;
}

export interface WorkspaceGroup {
  readonly id: WorkspaceGroupId;
  readonly projectId: ProjectId;
  readonly workerId: string | null;
  /** 容器目录（不是 git 仓库）。amp 布局下 cwd 是主仓库子目录，不是这里。 */
  readonly root: string;
  readonly members: readonly WorkspaceGroupMember[];
  readonly state: 'preparing' | 'ready' | 'failed';
  /**
   * amp = 主仓库在 <root>/<name>，附加仓在 <root>/repos/<name>，cwd = 主仓库。
   * flat / 省略 = 老布局，成员都在 <root>/<name>，cwd = 容器根。
   */
  readonly layout?: 'amp' | 'flat';
  /** 主仓库（Project.repos[].id）；amp 布局必有。 */
  readonly primaryRepoId?: string | null;
  /** 新计划以输出工作目录 ID 标识主成员，同时标识此组不可使用旧重试。 */
  readonly primaryWorkspaceId?: WorkspaceId | null;
  /** 成员清单刚变过，下一轮提问要再注入一次成员说明。 */
  readonly pendingBriefing?: boolean;
  /** 临时组合归任务；长期组合为 null（v1 没有创建入口）。 */
  readonly ownerTaskId: TaskId | null;
  /** 建组时预分配的会话 id（写入成员分支名）；老组没有。 */
  readonly sessionId?: string | null;
  readonly createdAt: number;
  /** 整组级别的失败原因（某成员建不出来时也写一份，方便一眼看到）。 */
  readonly error: string | null;
}

export type WorkspaceGroupLayout = 'amp' | 'flat';

export function groupLayout(group: Pick<WorkspaceGroup, 'layout'>): WorkspaceGroupLayout {
  return group.layout === 'amp' ? 'amp' : 'flat';
}

export function isPrimaryMember(
  group: Pick<WorkspaceGroup, 'members' | 'layout' | 'primaryRepoId' | 'primaryWorkspaceId'>,
  member: Pick<WorkspaceGroupMember, 'workspaceId' | 'repoId'>
): boolean {
  if (groupLayout(group) === 'amp' && group.primaryWorkspaceId) return member.workspaceId === group.primaryWorkspaceId;
  if (groupLayout(group) === 'amp' && group.primaryRepoId) return member.repoId === group.primaryRepoId;
  return group.members[0]?.workspaceId === member.workspaceId;
}

export const WORKSPACE_GROUP_MEMBERS_MAX = 8;
export const WORKSPACE_GROUP_NAME = /^[a-z][a-z0-9-]{0,40}$/;

type GroupPaths = Pick<WorkspaceGroup, 'root' | 'members' | 'layout' | 'primaryRepoId' | 'primaryWorkspaceId'>;

/** 某个成员的工作目录。找不到成员返回 null（调用方必须拒绝，不能退化成容器根或 cwd）。 */
export function groupMemberRoot(group: GroupPaths, workspaceId: WorkspaceId): string | null {
  const member = group.members.find((item) => item.workspaceId === workspaceId);
  if (!member) return null;
  if (groupLayout(group) === 'amp' && (group.primaryWorkspaceId || group.primaryRepoId) && !isPrimaryMember(group, member)) {
    return `${group.root}/repos/${member.name}`;
  }
  return `${group.root}/${member.name}`;
}

/** 会话 cwd：amp 布局是主仓库目录，老组仍是容器根。 */
export function groupSessionRoot(group: GroupPaths): string {
  if (groupLayout(group) !== 'amp') return group.root;
  const primary = primaryMember(group);
  if (!primary) return group.root;
  return groupMemberRoot(group, primary.workspaceId) ?? group.root;
}

/** 相对会话 cwd 的成员路径：主仓库是 `.`，附加仓是 `../repos/<name>`。老组是目录名。 */
export function memberBriefingPath(group: GroupPaths, member: WorkspaceGroupMember): string {
  if (groupLayout(group) !== 'amp') return member.name;
  return isPrimaryMember(group, member) ? '.' : `../repos/${member.name}`;
}

export function primaryMember(group: Pick<WorkspaceGroup, 'members' | 'layout' | 'primaryRepoId' | 'primaryWorkspaceId'>): WorkspaceGroupMember | null {
  if (groupLayout(group) === 'amp' && group.primaryWorkspaceId) {
    return group.members.find((member) => member.workspaceId === group.primaryWorkspaceId) ?? null;
  }
  if (groupLayout(group) === 'amp' && group.primaryRepoId) {
    return group.members.find((member) => member.repoId === group.primaryRepoId) ?? group.members[0] ?? null;
  }
  return group.members[0] ?? null;
}

export function groupState(members: readonly WorkspaceGroupMember[]): WorkspaceGroup['state'] {
  if (members.some((member) => member.state === 'failed')) return 'failed';
  if (members.every((member) => member.state === 'ready')) return 'ready';
  return 'preparing';
}

/** 组能不能派发：所有成员 ready。 */
export function groupReady(group: Pick<WorkspaceGroup, 'state' | 'members'>): boolean {
  return group.state === 'ready' && group.members.length > 0 && group.members.every((member) => member.state === 'ready');
}

/** 组里失败的成员（给「重试」与错误文案用）。 */
export function failedMembers(group: Pick<WorkspaceGroup, 'members'>): readonly WorkspaceGroupMember[] {
  return group.members.filter((member) => member.state === 'failed');
}

/** 成员目录名：仓库名本身就是目录名，所以只做形状校验，不做去重（去重在项目仓库清单里做）。 */
export function normalizeGroupMembers(input: readonly { repoId: string; name: string }[]): Result<readonly { repoId: string; name: string }[], DomainError> {
  if (input.length === 0) return err(invalid('至少要选一个仓库'));
  if (input.length > WORKSPACE_GROUP_MEMBERS_MAX) return err(invalid(`一次最多 ${WORKSPACE_GROUP_MEMBERS_MAX} 个仓库`));
  const names = new Set<string>();
  for (const item of input) {
    if (!WORKSPACE_GROUP_NAME.test(item.name)) return err(invalid(`仓库名只能是小写字母、数字和短横线：${item.name}`));
    if (names.has(item.name)) return err(invalid(`仓库名重复：${item.name}`));
    names.add(item.name);
  }
  return ok(input);
}
