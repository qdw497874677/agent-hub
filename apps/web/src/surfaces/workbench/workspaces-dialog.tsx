import { useEffect, useState } from 'react';
import { ProjectMessagingTrust } from './project-messaging-trust.tsx';
import { SaveStatus } from '../../atoms/save-status.tsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CanvasDto, ProjectDto, WorkspaceDto, WorkspaceViewDto } from '../../shell/api.ts';
import { api } from '../../shell/api.ts';
import { SECONDARY_BUTTON } from '../../shell/dialog-shell.tsx';
import { useWorkers } from '../../shell/workers.tsx';
import { useAccount } from '../../shell/auth.tsx';
import { canAdminister } from '../../shell/account-context.ts';
import type { DefaultAgentRef } from '../../shell/default-agent.ts';
import { DefaultAgentEditor } from './default-agent-editor.tsx';
import { ProjectAssets } from './project-assets.tsx';
import { BuiltinAssets } from './builtin-assets.tsx';
import { ProjectContext } from './project-context.tsx';
import { ProjectDistill } from './project-distill.tsx';
import { LinkWorkspaces } from './link-workspaces.tsx';
import { WorkspaceCleanup } from './workspace-cleanup.tsx';
import { WorktreeSettings } from './worktree-settings.tsx';
import { ProjectChecksSettings } from './project-checks-settings.tsx';
import { ProjectAssetSets } from './project-asset-sets.tsx';
import { ProjectRepos } from './project-repos.tsx';
import { projectWorktree } from './worktree-config.ts';
import { workspaceSummary, workspaceSummaryTone } from './workspace-summary.ts';
import { projectKeys, workspaceKeys } from '../../shell/query-keys.ts';
import type { ProjectSettingsSection } from '../../shell/settings-route.ts';

type Pending = { workspace: WorkspaceDto; mode: 'unlink' | 'unregister' | 'delete' | 'force' };

const SOURCE: Record<WorkspaceDto['source'], string> = { linked: '已有目录', created: '新建目录', cloned: '克隆', worktree: 'worktree' };

export function ProjectSettings({ project, section, teamDefaultsHref, onTeamDefaults }: { project: ProjectDto; section: ProjectSettingsSection; teamDefaultsHref?: string; onTeamDefaults?: () => void }) {
  const workers = useWorkers();
  const account = useAccount();
  const isAdmin = account?.clusterAdmin === true;
  const list = useQuery({ queryKey: ['workspaces', project.id], queryFn: () => api.workspaces(project.id) });
  const [pending, setPending] = useState<Pending | null>(null);
  // 隐藏用 class 而不是 hidden 属性：面板里自己的 flex/grid 类不会把它顶回可见。
  const panel = (id: ProjectSettingsSection) => (section === id ? '' : 'hidden');
  const groups = new Map<string, WorkspaceViewDto[]>();
  let spaces = 0;
  for (const view of list.data ?? []) {
    if (view.workspace.state === 'removed') continue;
    spaces += 1;
    const key = view.workspace.workerId ?? '';
    groups.set(key, [...(groups.get(key) ?? []), view]);
  }
  // 页顶那句总结：仓库数 / 默认档位 / 已有工作目录。接口还没回就不说目录那句。
  const summary = workspaceSummary({
    repos: (project.repos ?? []).length,
    mode: projectWorktree(project)?.mode ?? 'shared',
    spaces: list.data === undefined ? undefined : spaces,
    machines: groups.size
  });
  const summaryTone = workspaceSummaryTone({ repos: (project.repos ?? []).length });
  return (
    <>
      <h2 className="mb-3 text-body text-primary">项目设置 · {project.name}</h2>
      <div className="min-h-[280px]">
        <div className={panel('general')}>
          <DescriptionEditor project={project} />
          <ProjectMessagingTrust projectId={project.id} />
        </div>
        <div className={panel('defaults')}>
          <ProjectDefaultAgentSettings project={project} teamDefaultsHref={teamDefaultsHref} onTeamDefaults={onTeamDefaults} />
          <ProjectAssetSets project={project} />
        </div>
        <div className={panel('context')}>
          <ProjectContext projectId={project.id} canEdit />
          <ProjectDistill projectId={project.id} />
        </div>
        {isAdmin ? (
          <div className={panel('assets')}>
            <ProjectAssets projectId={project.id} />
            <BuiltinAssets projectId={project.id} />
          </div>
        ) : null}
        <div className={panel('cleanup')}>
          <h3 className="mb-1 text-sub text-primary">清理工作目录</h3>
          <WorkspaceCleanup projectId={project.id} />
        </div>
        <div className={panel('code')} data-testid="project-code-spaces">
          {/* 这页回答三件事：代码从哪来、目录怎么开、现在有哪些工作目录。答案先说在顶上。 */}
          <p
            data-testid="workspace-summary"
            className={`mb-4 rounded-sm border-l-2 bg-card px-2.5 py-2 text-sub leading-relaxed text-secondary ${
              summaryTone === 'warn' ? 'border-rust' : 'border-sage'
            }`}
          >
            {summary}
          </p>
          <ProjectRepos project={project} />
          <WorktreeSettings project={project} />
          <ProjectChecksSettings project={project} />
          <section data-testid="project-spaces" className="mt-5 border-t border-hair pt-4">
            <h3 className="mb-1 flex flex-wrap items-baseline gap-x-2 text-sub text-primary">
              已有工作目录
              <span className="text-meta text-tertiary">现在有哪些</span>
            </h3>
            <p className="mb-2 text-meta text-tertiary">
              工作目录 = 机器上的一个目录；worktree = 从仓库开出的隔离目录。一个目录同一时间只属于一个项目，
              取消关联后它就空出来，别的项目可以再分配；目录和文件都不会被删。
            </p>
            {list.isLoading ? <p className="text-meta text-tertiary">加载中…</p> : null}
            {list.data && groups.size === 0 ? (
              <p className="text-meta text-tertiary" data-testid="workspaces-empty">这个项目还没有登记工作目录。</p>
            ) : null}
            {[...groups].map(([workerId, views]) => (
              <section key={workerId} className="mb-3">
                <h4 className="mb-1 text-meta text-secondary">{workers.byId(workerId || null)?.label ?? (workerId ? '未知机器' : '本机')}</h4>
                <ul className="space-y-1">
                  {views.map((view) => (
                    <WorkspaceRow key={view.workspace.id} view={view} onAct={(mode) => setPending({ workspace: view.workspace, mode })} />
                  ))}
                </ul>
              </section>
            ))}
            <LinkWorkspaces projectId={project.id} linked={(list.data ?? []).map((view) => view.workspace.id)} />
            {pending ? <ConfirmRemove pending={pending} projectId={project.id} onDone={() => setPending(null)} /> : null}
          </section>
        </div>
      </div>
    </>
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
          // 独占归属下恒为 0（一个目录只属于一个项目）；只有老数据 / 后端没升级时才会亮。
          <div data-testid="ws-other-projects" className="text-meta text-tertiary">这个目录已归本项目独占</div>
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
              <div className="absolute right-0 z-10 mt-1 w-32 rounded-lg border border-strong bg-overlay py-1 shadow-overlay">
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
          ? '本项目不再在这里开任务，目录会变成未分配，别的项目可以再分配；目录、文件原样保留。'
          : mode === 'unregister'
          ? '从团队里移除这个工作目录，所有关联它的项目都不能再用它；目录和里面的文件原样保留。'
          : <>会删掉 <span className="break-all font-mono">{workspace.path}</span>，删了找不回来。</>}
      </p>
      {(changes.data?.reason ?? (mode === 'force' ? workspace.keptReason : null)) ? <p className="mb-2 text-meta text-rust">会丢掉：{changes.data?.reason ?? workspace.keptReason}</p> : null}
      {remove.error ? <p className="mb-2 text-meta text-rust">{remove.error.message}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button className={SECONDARY_BUTTON} onClick={onDone}>取消</button>
        <button className="rounded-sm bg-rust px-3 py-1.5 text-sub text-canvas disabled:opacity-40" disabled={remove.isPending} onClick={() => remove.mutate()}>
          {remove.isPending ? '处理中…' : `确认${title}`}
        </button>
      </div>
    </div>
  );
}

/**
 * 项目设置 · 代码与工作目录 · 「默认 Agent」。
 *
 * 只影响新会话：会话里显式选的 > 任务 > 项目 > 团队默认模型 > 运行时自己的默认。
 * 运行时的可调项（思考强度）只有画布的 agent 目录里有，和画布共用缓存；
 * 保存后把画布里的 project 就地换掉，别让别处还看着旧值。
 */
function ProjectDefaultAgentSettings({ project, teamDefaultsHref, onTeamDefaults }: { project: ProjectDto; teamDefaultsHref?: string; onTeamDefaults?: () => void }) {
  const account = useAccount();
  const editable = canAdminister(account);
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState<DefaultAgentRef | null>(project.defaultAgent ?? null);
  const stored = JSON.stringify(project.defaultAgent ?? null);
  useEffect(() => {
    setCurrent(project.defaultAgent ?? null);
  }, [stored]);
  const canvas = useQuery({
    queryKey: projectKeys.canvas(project.id),
    queryFn: () => api.canvas(project.id),
    staleTime: 30_000
  });
  const save = useMutation({
    mutationFn: (agent: DefaultAgentRef | null) => api.saveProjectDefaultAgent(project.id, agent),
    onSuccess: (next) => {
      setCurrent(next.defaultAgent ?? null);
      queryClient.setQueryData<CanvasDto>(projectKeys.canvas(next.id), (old) =>
        old === undefined ? old : { ...old, project: next }
      );
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    }
  });
  return (
    <section data-testid="project-default-agent" className="mt-5 border-t border-hair pt-4">
      <h3 className="mb-1 flex flex-wrap items-baseline gap-x-2 text-sub text-primary">
        默认 Agent
        <span className="text-meta text-tertiary">新会话没选就用它</span>
      </h3>
      <p className="mb-2 text-meta text-tertiary">
        新会话没选 Agent 时用它。任务有自己的默认 Agent 时，优先用任务的设置。
      </p>
      {teamDefaultsHref ? <a href={teamDefaultsHref} className="text-meta text-link underline-offset-2 hover:underline" onClick={(event) => {
        if (onTeamDefaults && !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
          event.preventDefault();
          onTeamDefaults();
        }
      }}>查看团队默认模型</a> : null}
      <DefaultAgentEditor
        prefix="pda"
        projectId={project.id}
        modelFallback="留空时，先用该运行时的团队默认模型；没设则用运行时默认。"
        value={current}
        agents={canvas.data?.agents ?? []}
        editable={editable}
        saving={save.isPending}
        saved={save.isSuccess && !save.isPending}
        error={save.error}
        onSave={(agent) => save.mutate(agent)}
      />
    </section>
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
      <label className="mb-1 block text-sub text-primary" htmlFor="project-description" title="支持 markdown，agent 开工时会读到">项目说明</label>
      <textarea
        id="project-description"
        className="block min-h-[120px] w-full resize-y rounded-sm border border-hair bg-card px-2 py-1.5 text-sub text-primary outline-none focus:border-ring"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {save.error ? <p className="mt-1 text-meta text-rust">{save.error.message}</p> : null}
      <div className="mt-2 flex items-center justify-end gap-2">
        <SaveStatus dirty={changed} saved={save.isSuccess} />
        <button className="rounded-control bg-action px-3 py-1.5 text-sub text-action-fg disabled:opacity-40" disabled={!changed || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? '保存中…' : '保存'}
        </button>
      </div>
    </section>
  );
}
