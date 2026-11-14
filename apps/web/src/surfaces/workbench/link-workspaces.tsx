import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shell/api.ts';
import { SECONDARY_BUTTON } from '../../shell/dialog-shell.tsx';
import { useWorkers } from '../../shell/workers.tsx';
import { errorText } from '../../shell/admin/shared.tsx';
import { CreateWorkspace, TEAM_WORKSPACES_KEY, useTeamWorkspaces } from './team-workspaces.tsx';
import { shortPath, workspaceName } from '../../atoms/workspace-format.ts';

/**
 * 关联工作空间（ADR 0026 Q4）：列团队里你看得见、本项目还没关联的持久工作空间，点一下关联；
 * 或者新建一个顺手关联。`workerId` 给了就只列那台机器上的（开始任务时用）。
 */
export function LinkWorkspaces({
  projectId,
  linked,
  workerId,
  onLinked,
  startOpen = false,
  expandSignal = 0
}: {
  projectId: string;
  linked: readonly string[];
  workerId?: string | null;
  onLinked?: (workspaceId: string) => void;
  startOpen?: boolean;
  /** 每次加一就地展开（「这台机器没有 git 基座」时外面的动作按钮用）。 */
  expandSignal?: number;
}) {
  const client = useQueryClient();
  const workers = useWorkers();
  const [open, setOpen] = useState(startOpen);
  const box = useRef<HTMLDivElement | null>(null);
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
  // 外面要求展开：先把面板打开，再在下一轮把它滚进视野、焦点落到第一个能关联的项
  useEffect(() => {
    if (expandSignal > 0) setOpen(true);
  }, [expandSignal]);
  useEffect(() => {
    if (expandSignal === 0 || !open) return;
    const element = box.current;
    if (!element) return;
    element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    element.querySelector<HTMLElement>('button[data-testid="ws-link-one"]')?.focus({ preventScroll: true });
  }, [expandSignal, open]);
  return (
    <div ref={box} className={open ? 'mt-2 rounded-sm border border-hair p-2' : 'mt-2'}>
      {open ? (
        <div data-testid="ws-link">
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
      ) : (
        // 一行次要文字按钮：它是单选组之外的补充入口，别做得跟「新建工作空间」一样重
        <button type="button" data-testid="ws-link-open" className="text-meta text-secondary hover:text-accent hover:underline" onClick={() => setOpen(true)}>
          🔗 关联工作空间…
        </button>
      )}
    </div>
  );
}
