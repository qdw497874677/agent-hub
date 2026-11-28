import type { CanvasDto, SessionDto, WorkspaceViewDto } from '@agent-hub/contract';
import { groupSessions, type SessionGroup } from '../../atoms/session-groups.ts';
import { workspaceName } from '../../atoms/workspace-format.ts';
import { eligibleWorkdir } from './workdir-model.ts';

export interface ListWorkspaceGroup {
  readonly key: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly workerId: string | null;
  readonly sessions: readonly SessionDto[];
  readonly groups: readonly SessionGroup[];
}

export interface ProjectWorkspaceGroup extends ListWorkspaceGroup {
  /** Only an explicitly owned, eligible standalone directory can be opened. */
  readonly openWorkspaceId: string | null;
}

/**
 * Union session buckets with registered project directories without inferring ownership.
 * Session bucket order is retained; registered-only buckets follow in registration order.
 * The caller supplies the appropriately filtered canvas and authorized workspace views.
 */
export function projectWorkspaceGroups(
  canvas: CanvasDto,
  registered: readonly WorkspaceViewDto[],
  coordinatorIds: ReadonlySet<string> = new Set(),
  projectId?: string
): ProjectWorkspaceGroup[] {
  const result = new Map<string, ProjectWorkspaceGroup>(
    workspaceSessionGroups(canvas, coordinatorIds).map((group) => [group.key, { ...group, openWorkspaceId: null }])
  );
  const members = new Map<string, WorkspaceViewDto[]>();
  for (const view of registered) {
    const workspace = view.workspace;
    if (workspace.state === 'removed') continue;
    const type = workspace.groupId ? 'group' : 'workspace';
    const id = workspace.groupId || workspace.id;
    const key = JSON.stringify([workspace.workerId, type, id]);
    const bucket = members.get(key) ?? [];
    // A duplicate response row must not duplicate a combination member.
    if (!bucket.some((item) => item.workspace.id === workspace.id)) bucket.push(view);
    members.set(key, bucket);
  }

  for (const [key, views] of members) {
    const first = views[0]!;
    const workspace = first.workspace;
    const existing = result.get(key);
    const isGroup = Boolean(workspace.groupId);
    const groupMembers = new Map(views.map((view) => [view.workspace.id, view.workspace]));
    if (isGroup) {
      for (const item of canvas.workspaces) {
        if (item.workerId === workspace.workerId && item.groupId === workspace.groupId && !groupMembers.has(item.id)) groupMembers.set(item.id, item);
      }
    }
    const names = [...new Set([...groupMembers.values()].map(workspaceName))];
    const registeredTitle = isGroup ? `组合工作空间 · ${names.join(' + ')}` : workspaceName(workspace);
    const registeredDetail = isGroup
      ? [...groupMembers.values()].map((item) => item.path).filter(Boolean).join(' · ') || undefined
      : workspace.path || undefined;
    const currentProjectId = projectId ?? canvas.project?.id;
    const openWorkspaceId = !isGroup && currentProjectId && eligibleWorkdir(workspace, first.ownerProjectId, currentProjectId)
      ? workspace.id : null;
    result.set(key, {
      key, title: registeredTitle, detail: registeredDetail, workerId: workspace.workerId,
      sessions: existing?.sessions ?? [], groups: existing?.groups ?? [], openWorkspaceId
    });
  }
  return [...result.values()];
}

/** 身份仅由会话的机器与真实 workspaceId / groupId 决定，任务不拥有工作空间。 */
export function workspaceSessionGroups(canvas: CanvasDto, coordinatorIds: ReadonlySet<string> = new Set()): ListWorkspaceGroup[] {
  const buckets = new Map<string, { workerId: string | null; type: 'group' | 'workspace' | 'missing'; id: string | null; sessions: SessionDto[] }>();
  for (const session of canvas.sessions) {
    const type = session.groupId ? 'group' : session.workspaceId ? 'workspace' : 'missing';
    const id = type === 'group' ? session.groupId! : type === 'workspace' ? session.workspaceId : null;
    const key = JSON.stringify([session.workerId, type, id]);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { workerId: session.workerId, type, id, sessions: [] };
      buckets.set(key, bucket);
    }
    bucket.sessions.push(session);
  }
  return [...buckets].map(([key, bucket]) => {
    const workspace = bucket.type === 'workspace' ? canvas.workspaces.find((item) => item.id === bucket.id) : undefined;
    const members = bucket.type === 'group' ? canvas.workspaces.filter((item) => item.groupId === bucket.id) : [];
    const names = [...new Set(members.map(workspaceName))];
    const title = bucket.type === 'group'
      ? names.length ? `组合工作空间 · ${names.join(' + ')}` : `组合工作空间不可用 · ${bucket.id?.slice(0, 8)}`
      : bucket.type === 'missing' ? '未指定工作空间' : workspace ? workspaceName(workspace) : `工作空间不可用 · ${bucket.id}`;
    const detail = bucket.type === 'group' ? members.map((item) => item.path).filter(Boolean).join(' · ') || undefined : workspace?.path || undefined;
    return {
      key, title, detail, workerId: bucket.workerId, sessions: bucket.sessions,
      groups: groupSessions({ ...canvas, sessions: bucket.sessions }, coordinatorIds)
    };
  });
}

/** 未解析的非空 ID 仍是另一台机器，不误写成本机。 */
export function workspaceWorkerLabel(workerId: string | null, label?: string): string {
  return label || (workerId ? `机器 ${workerId.slice(0, 8)}` : '本机');
}
