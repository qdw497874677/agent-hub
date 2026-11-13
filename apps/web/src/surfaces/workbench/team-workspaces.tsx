import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, teamApi, type TeamWorkspaceViewDto } from '../../shell/api.ts';
import { AccountMenu } from '../../shell/auth.tsx';
import { formatRoute } from '../../shell/route.ts';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../shell/dialog-shell.tsx';
import { DirectoryPicker } from './directory-picker.tsx';
import { useWorkers } from '../../shell/workers.tsx';
import { errorText } from '../../shell/admin/shared.tsx';
import { shortPath, workspaceName } from '../../atoms/workspace-format.ts';

/**
 * 团队工作空间页（#/workspaces，ADR 0026 Q1）：机器上的目录，一个可以给多个项目用。
 * 有 workspace.manage 的人看全部、能新建/删除；其他人只看自己能读的项目关联的那些。
 * 390px 下单列，每行操作收进行内按钮。
 */
export const TEAM_WORKSPACES_KEY = ['team-workspaces'] as const;

export function useTeamWorkspaces() {
  return useQuery({ queryKey: TEAM_WORKSPACES_KEY, queryFn: api.teamWorkspaces });
}

export function TeamWorkspacesPage() {
  const list = useTeamWorkspaces();
  const team = useQuery({ queryKey: ['team'], queryFn: teamApi.team });
  const workers = useWorkers();
  const canManage = team.data?.canManage === true;
  const [creating, setCreating] = useState(false);
  const rows = (list.data ?? []).filter((row) => row.workspace.state !== 'removed');
  const groups = new Map<string, TeamWorkspaceViewDto[]>();
  for (const row of rows) groups.set(row.workspace.workerId ?? '', [...(groups.get(row.workspace.workerId ?? '') ?? []), row]);
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-hair px-3 py-2">
        <div className="min-w-0">
          <a className="text-meta text-tertiary hover:text-accent" href={formatRoute({ page: 'home' })}>← 项目</a>
          <h1 className="text-head text-primary">团队工作空间</h1>
        </div>
        <AccountMenu />
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-6">
        <div className="mx-auto flex max-w-[960px] flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="text-meta text-tertiary">机器上的目录。一个工作空间可以给多个项目用；项目设置里关联了才能在里面开任务。</p>
            {canManage ? (
              <button data-testid="team-ws-new" className={PRIMARY_BUTTON} onClick={() => setCreating((open) => !open)}>＋ 新建工作空间</button>
            ) : null}
          </div>
          {creating ? <CreateWorkspace onDone={() => setCreating(false)} /> : null}
          {list.isLoading ? <p className="text-meta text-tertiary">加载中…</p> : null}
          {list.error ? <p className="text-meta text-rust">{errorText(list.error)}</p> : null}
          {list.data && rows.length === 0 ? (
            <p className="text-meta text-tertiary">{canManage ? '还没有工作空间。' : '你能看到的项目还没有关联工作空间。'}</p>
          ) : null}
          {[...groups].map(([workerId, views]) => (
            <section key={workerId}>
              <h2 className="mb-1 text-meta text-secondary">{workers.byId(workerId || null)?.label ?? (workerId ? '未知机器' : '本机')}</h2>
              <ul className="space-y-1.5">
                {views.map((row) => <TeamWorkspaceRow key={row.workspace.id} row={row} canManage={canManage} />)}
              </ul>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}

function TeamWorkspaceRow({ row, canManage }: { row: TeamWorkspaceViewDto; canManage: boolean }) {
  const client = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const { workspace } = row;
  const remove = useMutation({
    mutationFn: () => api.removeWorkspace(workspace.id, { deleteDirectory: false, force: false }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: TEAM_WORKSPACES_KEY });
      await client.invalidateQueries({ queryKey: ['workspaces'] });
    }
  });
  const linked = row.projects.length + row.hiddenProjects;
  return (
    <li data-testid="team-ws-row" className="rounded-sm border border-hair px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sub text-primary">{workspaceName(workspace)}</div>
          <div className="break-all font-mono text-meta text-tertiary" title={workspace.path}>{shortPath(workspace.path)}</div>
          {workspace.repoUrl ? <div className="truncate font-mono text-meta text-tertiary">{workspace.repoUrl}</div> : null}
          <div className="mt-1 flex flex-wrap gap-1 text-meta">
            {row.projects.map((project) => (
              <a key={project.id} className="rounded-sm bg-card px-1.5 text-secondary hover:text-accent" href={formatRoute({ page: 'project', projectId: project.id, view: 'canvas', sessionId: null })}>
                {project.name}
              </a>
            ))}
            {row.hiddenProjects > 0 ? <span className="text-tertiary">另有 {row.hiddenProjects} 个项目</span> : null}
            {linked === 0 ? <span className="text-tertiary">未关联项目</span> : null}
            {row.runningSessions > 0 ? <span data-testid="team-ws-running" className="text-rust">· {row.runningSessions} 个会话在跑</span> : null}
          </div>
        </div>
        {canManage && row.runningSessions === 0 ? (
          <button className="shrink-0 rounded-sm px-2 py-1 text-meta text-tertiary hover:text-rust" onClick={() => setConfirm(true)}>移除登记</button>
        ) : null}
      </div>
      {confirm ? (
        <div className="mt-2 rounded-sm border border-rust/60 p-2">
          <p className="mb-2 text-meta text-secondary">
            从团队里移除这个工作空间{linked > 0 ? `，${linked} 个项目都不能再用它` : ''}。目录和文件原样保留。
          </p>
          {remove.error ? <p className="mb-2 text-meta text-rust">{errorText(remove.error)}</p> : null}
          <div className="flex justify-end gap-2">
            <button className={SECONDARY_BUTTON} onClick={() => setConfirm(false)}>取消</button>
            <button className="rounded-sm bg-rust px-3 py-1.5 text-sub text-primary disabled:opacity-40" disabled={remove.isPending} onClick={() => remove.mutate()}>确认移除</button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** 新建：选机器 → 选目录（已有目录登记 / 空目录 / 克隆仓库），可选同时关联一个项目。 */
export function CreateWorkspace({ projectId, onDone }: { projectId?: string; onDone: (workspaceId?: string) => void }) {
  const client = useQueryClient();
  const workers = useWorkers();
  const [workerId, setWorkerId] = useState<string | null>(workers.online[0]?.workerId ?? null);
  const [mode, setMode] = useState<'link' | 'create'>('link');
  const [path, setPath] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState('');
  const [picking, setPicking] = useState(true);
  const machine = workerId ?? workers.online[0]?.workerId ?? null;
  const create = useMutation({
    mutationFn: () =>
      projectId
        ? api.createWorkspace(projectId, { kind: 'long_lived', workerId: machine, mode, ...(path ? { path } : {}) })
        : api.createTeamWorkspace({
        workerId: machine,
        mode,
        ...(path ? { path } : {}),
        ...(mode === 'create' && repoUrl.trim() ? { repoUrl: repoUrl.trim() } : {}),
      }),
    onSuccess: async (workspace) => {
      await client.invalidateQueries({ queryKey: TEAM_WORKSPACES_KEY });
      await client.invalidateQueries({ queryKey: ['workspaces'] });
      onDone(workspace.id);
    }
  });
  return (
    <div data-testid="team-ws-create" className="rounded-sm border border-hair p-3">
      {workers.online.length > 1 ? (
        <label className="mb-2 block text-meta text-secondary">
          机器
          <select className={`${INPUT} mt-1`} value={machine ?? ''} onChange={(e) => { setWorkerId(e.target.value || null); setPath(null); }}>
            {workers.online.map((worker) => <option key={worker.workerId} value={worker.workerId}>{worker.label}</option>)}
          </select>
        </label>
      ) : null}
      <div className="mb-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label="怎么新建">
        {([['link', '登记已有目录'], ['create', projectId ? '新建目录（项目绑了仓库会下载）' : '新建空目录 / 克隆仓库']] as const).map(([value, text]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            className={`min-h-[32px] rounded-sm border px-2 text-meta ${mode === value ? 'border-accent text-primary' : 'border-hair text-secondary hover:border-strong'}`}
            onClick={() => { setMode(value); setPath(null); setPicking(true); }}
          >
            {text}
          </button>
        ))}
      </div>
      {mode === 'create' && !projectId ? (
        <label className="mb-2 block text-meta text-secondary">
          git 仓库（可选，填了就克隆进去）
          <input className={`${INPUT} mt-1 font-mono`} value={repoUrl} placeholder="git@github.com:me/repo.git" onChange={(e) => setRepoUrl(e.target.value)} />
        </label>
      ) : null}
      <p className="mb-1 text-meta text-tertiary">
        {path ? <>目录：<span className="font-mono">{shortPath(path)}</span></> : mode === 'link' ? '选一个机器上已有的目录' : '不选就放在托管目录下；也可以选一个空文件夹'}
        <button type="button" className="ml-2 text-accent hover:underline" onClick={() => setPicking((open) => !open)}>{picking ? '收起' : path ? '换一个' : '浏览…'}</button>
      </p>
      {picking && machine ? <DirectoryPicker workerId={machine} onCancel={() => setPicking(false)} onPick={(picked) => { setPath(picked); setPicking(false); }} /> : null}
      {create.error ? <p className="mt-2 text-meta text-rust">{errorText(create.error)}</p> : null}
      <div className="mt-2 flex justify-end gap-2">
        <button className={SECONDARY_BUTTON} onClick={() => onDone()}>取消</button>
        <button data-testid="team-ws-create-submit" className={PRIMARY_BUTTON} disabled={create.isPending || machine === null || (mode === 'link' && path === null)} onClick={() => create.mutate()}>
          {create.isPending ? '处理中…' : projectId ? '新建并关联' : '新建'}
        </button>
      </div>
    </div>
  );
}
