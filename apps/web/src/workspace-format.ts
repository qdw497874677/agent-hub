import type { WorkspaceDto } from './api.ts';

/** 工作空间的人话名字：有标签用标签，否则用文件夹名。 */
export function workspaceName(workspace: Pick<WorkspaceDto, 'label' | 'path'>): string {
  return workspace.label ?? (workspace.path.split('/').filter(Boolean).at(-1) || workspace.path);
}

/** 路径中间省略：~/agent-hub/…/foo（§9.7）。 */
export function shortPath(path: string): string {
  const tilde = path.replace(/^\/home\/[^/]+/, '~').replace(/^\/root(?=\/|$)/, '~');
  const parts = tilde.split('/');
  return parts.length <= 4 ? tilde : `${parts.slice(0, 2).join('/')}/…/${parts.at(-1)}`;
}

