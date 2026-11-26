import type { CanvasDto } from '@agent-hub/contract';
import type { SessionGroup } from '../../atoms/session-groups.ts';
import { workspaceName } from '../../atoms/workspace-format.ts';

export interface ListWorkspaceGroup {
  readonly key: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly workerId: string | null;
  readonly sessions: SessionGroup['sessions'];
}

/** 身份用 ID 而不是显示名称；组合空间始终以 groupId 而不是 primary 工作空间归组。 */
export function listWorkspaceGroups(group: SessionGroup, canvas: Pick<CanvasDto, 'workspaces'>): ListWorkspaceGroup[] {
  const buckets = new Map<string, { workerId: string | null; type: 'group' | 'workspace' | 'missing'; id: string | null; sessions: SessionGroup['sessions'][number][] }>();
  for (const item of group.sessions) {
    const { session } = item;
    const type = session.groupId ? 'group' : session.workspaceId ? 'workspace' : 'missing';
    const id = type === 'group' ? session.groupId! : type === 'workspace' ? session.workspaceId : null;
    const key = JSON.stringify([group.kind, group.taskId, session.workerId, type, id]);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { workerId: session.workerId, type, id, sessions: [] };
      buckets.set(key, bucket);
    }
    bucket.sessions.push(item);
  }
  return [...buckets].map(([key, bucket]) => {
    const workspace = canvas.workspaces.find((item) => item.id === bucket.id);
    const members = bucket.type === 'group' ? canvas.workspaces.filter((item) => item.groupId === bucket.id) : [];
    const primary = bucket.sessions.map(({ session }) => canvas.workspaces.find((item) => item.id === session.workspaceId)).find(Boolean);
    const names = [...new Set(members.map(workspaceName))];
    const comboNames = names.length ? names.join(' + ') : primary ? workspaceName(primary) : '';
    const title = bucket.type === 'group'
      ? `组合工作空间${comboNames ? ` · ${comboNames}` : ''}`
      : bucket.type === 'missing' ? '未指定工作空间' : workspace ? workspaceName(workspace) : `工作空间不可用 · ${bucket.id}`;
    const detail = bucket.type === 'group'
      ? members.map((item) => item.path).join(' · ') || primary?.path
      : workspace?.path;
    return { key, title, detail, workerId: bucket.workerId, sessions: bucket.sessions };
  });
}
