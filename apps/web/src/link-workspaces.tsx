import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api.ts';
import { SECONDARY_BUTTON } from './dialog-shell.tsx';
import { useWorkers } from './workers.tsx';
import { errorText } from './admin/shared.tsx';
import { CreateWorkspace, TEAM_WORKSPACES_KEY, useTeamWorkspaces } from './team-workspaces.tsx';
import { shortPath, workspaceName } from './workspace-format.ts';

/**
 * 关联工作空间（ADR 0026 Q4）：列团队里你看得见、本项目还没关联的持久工作空间，点一下关联；
 * 或者新建一个顺手关联。`workerId` 给了就只列那台机器上的（开始任务时用）。
 */
export function LinkWorkspaces({
  projectId,
  linked,
  workerId,
  onLinked,
  startOpen = false
}: {
  projectId: string;
  linked: readonly string[];
  workerId?: string | null;
  onLinked?: (workspaceId: string) => void;
  startOpen?: boolean;
}) {
  const client = useQueryClient();
  const workers = useWorkers();
  const [open, setOpen] = useState(startOpen);
  const [creating, setCreating] = useState(false);
  const team = useTeamWorkspaces();
  const local = workers.list.find((worker) => worker.origin === 'local')?.workerId ?? null;
  const candidates = (team.data ?? []).filter(
    ({ workspace }) =>
      workspace.state !== 'removed' &&
      workspace.kind === 'long_lived' &&
      !linked.includes(workspace.id) &&
      (workerId === undefined || (workspace.workerId ?? local) === workerId)
  );
  const link = useMutation({
    mutationFn: (workspaceId: string) => api.linkWorkspace(projectId, workspaceId),
    onSuccess: async (workspace) => {
      await client.invalidateQueries({ queryKey: ['workspaces', projectId] });
      await client.invalidateQueries({ queryKey: TEAM_WORKSPACES_KEY });
      onLinked?.(workspace.id);
    }
  });
  if (!open) {
    return (
      <button type="button" data-testid="ws-link-open" className="mt-1 text-meta text-accent hover:underline" onClick={() => setOpen(true)}>
        🔗 关联工作空间…
      </button>
    );
  }
  return (
    <div data-testid="ws-link" className="mt-2 rounded-sm border border-hair p-2">
      <p className="mb-1 text-meta text-secondary">关联团队里已有的工作空间</p>
      {team.isLoading ? <p className="text-meta text-tertiary">加载中…</p> : null}
      {team.data && candidates.length === 0 ? <p className="text-meta text-tertiary">没有可以关联的了。</p> : null}
      <ul className="space-y-1">
        {candidates.map(({ workspace, projects, hiddenProjects }) => (
          <li key={workspace.id} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sub text-primary">{workspaceName(workspace)}</div>
              <div className="truncate font-mono text-meta text-tertiary" title={workspace.path}>{shortPath(workspace.path)}</div>
              {projects.length + hiddenProjects > 0 ? (
                <div className="text-meta text-tertiary">已被 {[...projects.map((p) => p.name), ...(hiddenProjects ? [`另 ${hiddenProjects} 个项目`] : [])].join('、')} 使用</div>
              ) : null}
            </div>
            <button type="button" data-testid="ws-link-one" className={SECONDARY_BUTTON} disabled={link.isPending} onClick={() => link.mutate(workspace.id)}>关联</button>
          </li>
        ))}
      </ul>
      {link.error ? <p className="mt-1 text-meta text-rust">{errorText(link.error)}</p> : null}
      <div className="mt-2 flex flex-wrap gap-3">
        <button type="button" className="text-meta text-accent hover:underline" onClick={() => setCreating((v) => !v)}>＋ 新建并关联</button>
        <button type="button" className="text-meta text-tertiary hover:underline" onClick={() => setOpen(false)}>收起</button>
      </div>
      {creating ? (
        <div className="mt-2">
          <CreateWorkspace projectId={projectId} onDone={(id) => { setCreating(false); if (id) onLinked?.(id); }} />
        </div>
      ) : null}
    </div>
  );
}
