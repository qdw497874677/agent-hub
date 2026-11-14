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
 * - 成员最多 8 个，名字项目内唯一，position 0 是 primary。
 */
export interface WorkspaceGroupMember {
  readonly workspaceId: WorkspaceId;
  /** 对应 Project.repos[].id。 */
  readonly repoId: string;
  /** 子目录名（= 仓库名），容器 root 下的一级目录。 */
  readonly name: string;
  /** 准备状态：preparing 还在建，ready 能派发，failed 要看 error。 */
  readonly state: 'preparing' | 'ready' | 'failed';
  readonly error: string | null;
}

export interface WorkspaceGroup {
  readonly id: WorkspaceGroupId;
  readonly projectId: ProjectId;
  readonly workerId: string | null;
  /** 容器目录（不是 git 仓库），agent 的 cwd。 */
  readonly root: string;
  readonly members: readonly WorkspaceGroupMember[];
  readonly state: 'preparing' | 'ready' | 'failed';
  /** 临时组合归任务；长期组合为 null（v1 没有创建入口）。 */
  readonly ownerTaskId: TaskId | null;
  readonly createdAt: number;
  /** 整组级别的失败原因（某成员建不出来时也写一份，方便一眼看到）。 */
  readonly error: string | null;
}

export const WORKSPACE_GROUP_MEMBERS_MAX = 8;
export const WORKSPACE_GROUP_NAME = /^[a-z][a-z0-9-]{0,40}$/;

/** 容器 root 下某个成员的工作目录。找不到成员返回 null（调用方必须拒绝，不能退化成容器根）。 */
export function groupMemberRoot(group: Pick<WorkspaceGroup, 'root' | 'members'>, workspaceId: WorkspaceId): string | null {
  const member = group.members.find((item) => item.workspaceId === workspaceId);
  return member ? `${group.root}/${member.name}` : null;
}

export function primaryMember(group: Pick<WorkspaceGroup, 'members'>): WorkspaceGroupMember | null {
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
