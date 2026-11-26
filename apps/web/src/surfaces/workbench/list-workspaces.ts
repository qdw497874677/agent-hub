import type { CanvasDto, SessionDto } from '@agent-hub/contract';
import { groupSessions, type SessionGroup } from '../../atoms/session-groups.ts';
import { workspaceName } from '../../atoms/workspace-format.ts';

export interface ListWorkspaceGroup {
  readonly key: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly workerId: string | null;
  readonly sessions: readonly SessionDto[];
  readonly groups: readonly SessionGroup[];
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
