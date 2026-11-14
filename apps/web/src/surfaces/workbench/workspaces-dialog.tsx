import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectDto, WorkspaceDto, WorkspaceViewDto } from '../../shell/api.ts';
import { api } from '../../shell/api.ts';
import { DialogShell, SECONDARY_BUTTON } from '../../shell/dialog-shell.tsx';
import { useWorkers } from '../../shell/workers.tsx';
import { useAccount } from '../../shell/auth.tsx';
import { ProjectAssets } from './project-assets.tsx';
import { ProjectContext } from './project-context.tsx';
import { ProjectDistill } from './project-distill.tsx';
import { LinkWorkspaces } from './link-workspaces.tsx';
import { WorkspaceCleanup } from './workspace-cleanup.tsx';
import { WorktreeSettings } from './worktree-settings.tsx';
import { ProjectRepos } from './project-repos.tsx';
import { workspaceKeys } from '../../shell/query-keys.ts';

type Pending = { workspace: WorkspaceDto; mode: 'unlink' | 'unregister' | 'delete' | 'force' };

const SOURCE: Record<WorkspaceDto['source'], string> = { linked: '已有目录', created: '新建目录', cloned: '克隆', worktree: 'worktree' };

type ProjectTab = 'project' | 'context' | 'assets' | 'workspaces';

/**
 * 项目设置（workspaces.md §7）：四块话题各占一栏——说明与清理、上下文、资产（仅管理员）、工作空间。
 * 面板都挂着只切显示：在「项目」里改了一半的说明，去看别的 tab 再回来还在。
 */
export function WorkspacesDialog({ project, onClose }: { project: ProjectDto; onClose: () => void }) {
  const workers = useWorkers();
  const account = useAccount();
  const isAdmin = account?.clusterAdmin === true;
  const list = useQuery({ queryKey: ['workspaces', project.id], queryFn: () => api.workspaces(project.id) });
  const [tab, setTab] = useState<ProjectTab>('project');
  const [pending, setPending] = useState<Pending | null>(null);
  const tabs: readonly { readonly id: ProjectTab; readonly label: string }[] = [
    { id: 'project', label: '项目' },
    { id: 'context', label: '上下文' },
    ...(isAdmin ? [{ id: 'assets' as const, label: '资产' }] : []),
    { id: 'workspaces', label: '工作空间' }
  ];
  // 隐藏用 class 而不是 hidden 属性：面板里自己的 flex/grid 类不会把它顶回可见。
  const panel = (id: ProjectTab) => (tab === id ? '' : 'hidden');
  const groups = new Map<string, WorkspaceViewDto[]>();
  for (const view of list.data ?? []) {
    if (view.workspace.state === 'removed') continue;
    const key = view.workspace.workerId ?? '';
    groups.set(key, [...(groups.get(key) ?? []), view]);
  }
  return (
    <DialogShell title="项目设置" onClose={onClose}>
      <h2 className="mb-3 text-body text-primary">项目设置 · {project.name}</h2>
      <div role="tablist" aria-label="项目设置" className="mb-3 flex gap-1 overflow-x-auto border-b border-hair">
        {tabs.map((item, index) => (
          <button
            key={item.id}
            id={`project-tab-${item.id}`}
            role="tab"
            aria-selected={tab === item.id}
            tabIndex={tab === item.id ? 0 : -1}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sub ${
              tab === item.id ? 'border-accent text-primary' : 'border-transparent text-tertiary hover:text-secondary'
            }`}
            onClick={() => setTab(item.id)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              const step = event.key === 'ArrowRight' ? 1 : -1;
              const next = tabs[(index + step + tabs.length) % tabs.length];
              if (!next) return;
              setTab(next.id);
              (event.currentTarget.parentElement?.querySelector(`#project-tab-${next.id}`) as HTMLElement | null)?.focus();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="min-h-[280px]">
        <div className={panel('project')}>
          <DescriptionEditor project={project} />
          <WorkspaceCleanup projectId={project.id} />
        </div>
        <div className={panel('context')}>
          <ProjectContext projectId={project.id} canEdit />
          <ProjectDistill projectId={project.id} />
        </div>
        {isAdmin ? (
          <div className={panel('assets')}>
            <ProjectAssets projectId={project.id} />
          </div>
        ) : null}
        <div className={panel('workspaces')}>
          <h3 className="mb-1 text-sub text-primary">工作空间</h3>
          <p className="mb-2 text-meta text-tertiary">本项目能在这些目录里开任务。取消关联不会删目录，也不影响其他项目。</p>
          <ProjectRepos project={project} />
          <WorktreeSettings project={project} />
          {list.isLoading ? <p className="text-meta text-tertiary">加载中…</p> : null}
          {list.data && groups.size === 0 ? <p className="text-meta text-tertiary">还没有工作空间。</p> : null}
          {[...groups].map(([workerId, views]) => (
            <section key={workerId} className="mb-3">
              <h3 className="mb-1 text-meta text-secondary">{workers.byId(workerId || null)?.label ?? (workerId ? '未知机器' : '本机')}</h3>
              <ul className="space-y-1">
                {views.map((view) => (
                  <WorkspaceRow key={view.workspace.id} view={view} onAct={(mode) => setPending({ workspace: view.workspace, mode })} />
                ))}
              </ul>
            </section>
          ))}
          <LinkWorkspaces projectId={project.id} linked={(list.data ?? []).map((view) => view.workspace.id)} />
          {pending ? <ConfirmRemove pending={pending} projectId={project.id} onDone={() => setPending(null)} /> : null}
        </div>
      </div>
    </DialogShell>
  );
}

function WorkspaceRow({ view, onAct }: { view: WorkspaceViewDto; onAct: (mode: Pending['mode']) => void }) {
  const { workspace } = view;
  const [menu, setMenu] = useState(false);
  const busy = view.runningTaskIds.length > 0;
  const deletable = workspace.kind === 'long_lived' && (workspace.source === 'created' || workspace.source === 'cloned');
  const actions: { mode: Pending['mode']; label: string }[] = [
    ...(workspace.kind === 'long_lived' ? [{ mode: 'unlink' as const, label: '取消关联' }, { mode: 'unregister' as const, label: '移除登记' }] : []),
    ...(deletable ? [{ mode: 'delete' as const, label: '同时删除目录' }] : []),
    ...(workspace.kind === 'temporary' ? [{ mode: workspace.state === 'kept' ? ('force' as const) : ('delete' as const), label: workspace.state === 'kept' ? '强制删除' : '删除' }] : [])
  ];
  const state = workspace.state === 'kept' ? `已保留：${workspace.keptReason ?? '有没保存的改动'}` : workspace.state === 'ready' ? '就绪' : workspace.state === 'failed' ? '准备失败' : '准备中';
  return (
    <li className="flex items-start gap-2 rounded-sm border border-hair px-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sub text-primary">
          {workspace.label ?? workspace.path.split('/').pop()}
          <span className="ml-2 text-meta text-tertiary">{workspace.kind === 'temporary' ? '临时' : '长期'} · {SOURCE[workspace.source]}{workspace.branch ? ` · ${workspace.branch}` : ''}</span>
        </div>
        <div className="break-all font-mono text-meta text-tertiary">{workspace.path}</div>
        <div className={`text-meta ${workspace.state === 'kept' ? 'text-rust' : 'text-secondary'}`}>{busy ? '有会话正在运行' : state}</div>
        {(view.otherProjectSessions ?? 0) > 0 ? (
          <div data-testid="ws-other-projects" className="text-meta text-rust">⚠ 其他项目有 {view.otherProjectSessions} 个会话也在这里干活</div>
        ) : null}
      </div>
      {actions.length > 0 && !busy ? (
        <>
          <div className="hidden shrink-0 gap-1 md:flex">
            {actions.map((action) => (
              <button key={action.mode} className="rounded-sm px-1.5 py-0.5 text-meta text-tertiary hover:text-rust" onClick={() => onAct(action.mode)}>
                {action.label}
              </button>
            ))}
          </div>
          <div className="relative shrink-0 md:hidden">
            <button className="rounded-sm px-2 py-1 text-meta text-tertiary" aria-label="更多操作" onClick={() => setMenu(!menu)}>⋯</button>
            {menu ? (
              <div className="absolute right-0 z-10 mt-1 w-32 rounded-sm border border-hair bg-panel py-1 shadow">
                {actions.map((action) => (
                  <button key={action.mode} className="block w-full px-3 py-2 text-left text-sub text-secondary" onClick={() => { setMenu(false); onAct(action.mode); }}>
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </li>
  );
}

function ConfirmRemove({ pending, projectId, onDone }: { pending: Pending; projectId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const { workspace, mode } = pending;
  const changes = useQuery({ queryKey: workspaceKeys.changes(workspace.id), queryFn: () => api.workspaceChanges(workspace.id), enabled: mode !== 'unregister' && mode !== 'unlink' && workspace.isGit === true });
  const remove = useMutation({
    mutationFn: () => mode === 'unlink' ? api.unlinkWorkspace(projectId, workspace.id) : api.removeWorkspace(workspace.id, { deleteDirectory: mode !== 'unregister', force: mode === 'force' || (mode === 'delete' && workspace.kind === 'long_lived') }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['workspaces', projectId] });
      await queryClient.invalidateQueries({ queryKey: ['team-workspaces'] });
      onDone();
    }
  });
  const title = mode === 'unlink' ? '取消关联' : mode === 'unregister' ? '移除登记' : mode === 'force' ? '强制删除' : '删除目录';
  return (
    <div className="mt-3 rounded-sm border border-rust/60 p-3">
      <h3 className="mb-1 text-sub text-primary">{title}？</h3>
      <p className="mb-2 text-meta text-secondary">
        {mode === 'unlink'
          ? '本项目不再在这里开任务。目录、文件和其他项目的关联都不受影响。'
          : mode === 'unregister'
          ? '从团队里移除这个工作空间，所有关联它的项目都不能再用它；目录和里面的文件原样保留。'
          : <>会删掉 <span className="break-all font-mono">{workspace.path}</span>，删了找不回来。</>}
      </p>
      {(changes.data?.reason ?? (mode === 'force' ? workspace.keptReason : null)) ? <p className="mb-2 text-meta text-rust">会丢掉：{changes.data?.reason ?? workspace.keptReason}</p> : null}
      {remove.error ? <p className="mb-2 text-meta text-rust">{remove.error.message}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button className={SECONDARY_BUTTON} onClick={onDone}>取消</button>
        <button className="rounded-sm bg-rust px-3 py-1.5 text-sub text-primary disabled:opacity-40" disabled={remove.isPending} onClick={() => remove.mutate()}>
          {remove.isPending ? '处理中…' : `确认${title}`}
        </button>
      </div>
    </div>
  );
}

/** 项目说明（markdown，自由格式）：agent 开工时在任务背景和 task_get 里读到。 */
function DescriptionEditor({ project }: { project: ProjectDto }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(project.description ?? '');
  const save = useMutation({
    mutationFn: () => api.setProjectDescription(project.id, text),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        queryClient.invalidateQueries({ queryKey: ['home'] })
      ]);
    }
  });
  const changed = text.trim() !== (project.description ?? '');
  return (
    <section className="mb-4">
      <label className="mb-1 block text-sub text-primary" htmlFor="project-description">项目说明</label>
      <p className="mb-1 text-meta text-tertiary">支持 markdown。写这是什么、仓库在哪、有什么约定；agent 开工时会读到。</p>
      <textarea
        id="project-description"
        className="block min-h-[120px] w-full resize-y rounded-sm border border-hair bg-card px-2 py-1.5 text-sub text-primary outline-none focus:border-accent"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {save.error ? <p className="mt-1 text-meta text-rust">{save.error.message}</p> : null}
      <div className="mt-2 flex items-center justify-end gap-2">
        {save.isSuccess && !changed ? <span className="text-meta text-tertiary">已保存</span> : null}
        <button className="rounded-sm bg-accent px-3 py-1.5 text-sub text-canvas disabled:opacity-40" disabled={!changed || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? '保存中…' : '保存'}
        </button>
      </div>
    </section>
  );
}
