/**
 * 组合工作空间（docs/design/multi-repo.md §3 §7 §12）的读法：把接口返回的 JSON 读成界面能用的形状，
 * 以及那一行文案。纯函数，不碰 DOM、不 import shell/api.ts —— 根 tsconfig 会编同目录的 *.test.ts。
 *
 * 类型目前在这里本地声明：`@agent-hub/contract` 还只有 derive 请求上的 `groupId`，
 * 还没有 workspaceGroup 的实体 schema 和 session.groupId。等契约补上后改成从契约取即可，
 * 字段名与 `packages/domain/src/workspace-group.ts` 保持一致。
 */
export type WorkspaceGroupState = 'preparing' | 'ready' | 'failed';

export type WorkspaceGroupMemberState = 'preparing' | 'ready' | 'failed';

export interface WorkspaceGroupMemberView {
  readonly workspaceId: string;
  /** 对应的项目仓库；老数据可能没有。 */
  readonly repoId: string;
  /** 子目录名（= 仓库名）。 */
  readonly name: string;
  readonly state: WorkspaceGroupMemberState;
  readonly error: string | null;
}

export interface WorkspaceGroupView {
  readonly id: string;
  readonly projectId: string;
  readonly workerId: string;
  readonly root: string;
  readonly members: readonly WorkspaceGroupMemberView[];
  readonly state: WorkspaceGroupState;
  readonly error: string | null;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const memberState = (value: unknown): WorkspaceGroupMemberState =>
  value === 'ready' || value === 'failed' ? value : 'preparing';

/**
 * 任意 JSON → 组合工作空间；形状不对返回 null（界面上就是「查不到」，不崩）。
 * 成员名后端叫 `name`，设计文档早期草稿叫 `repoName`：两个都认，省一次联调。
 */
export function workspaceGroupFrom(input: unknown): WorkspaceGroupView | null {
  const raw = record(input);
  if (raw === null) return null;
  const id = text(raw.id);
  if (id === '') return null;
  const membersRaw = Array.isArray(raw.members) ? raw.members : [];
  const members: WorkspaceGroupMemberView[] = [];
  for (const item of membersRaw) {
    const member = record(item);
    if (member === null) continue;
    const workspaceId = text(member.workspaceId);
    if (workspaceId === '') continue;
    members.push({
      workspaceId,
      repoId: text(member.repoId),
      name: text(member.name) || text(member.repoName),
      state: memberState(member.state),
      error: typeof member.error === 'string' ? member.error : null
    });
  }
  return {
    id,
    projectId: text(raw.projectId),
    workerId: text(raw.workerId),
    root: text(raw.root),
    members,
    state: raw.state === 'ready' || raw.state === 'failed' ? raw.state : 'preparing',
    error: typeof raw.error === 'string' ? raw.error : null
  };
}

/** 会话页那一行 / 派生对话框里的标题：「组合工作空间 · 3 个仓库」。 */
export function groupHeadline(memberCount: number): string {
  return `组合工作空间 · ${memberCount} 个仓库`;
}

/**
 * 建组失败时后端只回错误、不回组 id（成员的工作空间已经登记好，也带着 groupId）。
 * 从画布的工作空间里把这一组的 id 找回来，才能显示原因并原地重试。
 *
 * 只认同一任务、刚登记过（`updatedAt >= since`）的成员，免得拿到这个任务上一次失败的那一组。
 * 契约的 WorkspaceDto 还没有 groupId，所以按 unknown 读。
 */
export function failedGroupIdFromWorkspaces(workspaces: readonly unknown[], taskId: string, since = 0): string | null {
  let best: { id: string; at: number } | null = null;
  for (const item of workspaces) {
    const raw = record(item);
    if (raw === null) continue;
    const groupId = text(raw.groupId);
    if (groupId === '' || text(raw.ownerTaskId) !== taskId) continue;
    const at = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
    if (at < since) continue;
    if (best === null || at >= best.at) best = { id: groupId, at };
  }
  return best?.id ?? null;
}

/** 成员状态给用户看的话：准备中 / 已就绪 / 准备失败。 */
export function memberStateLabel(member: WorkspaceGroupMemberView): string {
  if (member.state === 'ready') return '已就绪';
  if (member.state === 'failed') return '准备失败';
  return '准备中';
}

/** 整组的状态一句话；ready 返回 null（没什么可提示的）。 */
export function groupStateNote(group: WorkspaceGroupView): string | null {
  if (group.state === 'failed') {
    const detail = group.error?.trim() ?? '';
    return detail === '' ? '组合工作空间准备失败' : `组合工作空间准备失败：${detail}`;
  }
  if (group.state === 'preparing') return '正在准备组合工作空间…';
  return null;
}
