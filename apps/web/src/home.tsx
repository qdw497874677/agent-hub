import { MessagesEntry } from './messages-entry.tsx';
import { AccountMenu } from './auth.tsx';
import { NotificationBell } from './market/notifications.tsx';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectDto, RecentSessionDto } from './api.ts';
import { api } from './api.ts';
import { DirectoryPicker } from './directory-picker.tsx';
import { WorkerPicker, WorkersBadge, resolveWorker, useWorkers } from './workers.tsx';
import { coarsePointer } from './device.ts';
import { DeleteProjectDialog, TrashList } from './delete-project.tsx';

/**
 * 首页。
 *
 * 结构照 OpenCode 的 web 端：左窄栏放「在哪儿干」（项目 + 节点），右宽栏放
 * 「接着干哪条」（最近的会话 + 搜索）。之前的版本把项目当主角，用户回来还得
 * 先进项目、再看画布、才找得到昨天那条——多跳了两层。
 *
 * 仍然不做看板：这里是清单，不是按状态分列的卡片墙。
 */
export function HomePage({
  onOpen
}: {
  onOpen: (project: ProjectDto, sessionId?: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');
  const [deleting, setDeleting] = useState<ProjectDto | null>(null);
  const home = useQuery({ queryKey: ['home'], queryFn: api.home, refetchInterval: 10_000 });

  const projects = home.data?.projects ?? [];
  const recent = home.data?.recentSessions ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = useMemo(
    () =>
      needle === ''
        ? recent
        : recent.filter((session) =>
            `${session.taskTitle} ${session.projectName}`.toLowerCase().includes(needle)
          ),
    [recent, needle]
  );
  const groups = useMemo(() => groupByDay(shown), [shown]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  function open(session: RecentSessionDto): void {
    const project = projectById.get(session.projectId);
    if (project) onOpen(project, session.sessionId);
  }

  return (
    <div className="flex h-full flex-col md:flex-row">
      <nav className="flex max-h-[40dvh] w-full shrink-0 flex-col overflow-y-auto border-b border-hair px-3 py-4 md:max-h-none md:w-[220px] md:border-b-0 md:border-r">
        <div className="mb-4 flex items-start justify-between gap-2">
          <div>
            <p className="text-head text-primary">agent-hub</p>
            <p className="mt-1 text-meta text-tertiary">自带机器与 agent 的工作台</p>
          </div>
          <div className="flex items-center gap-2">
            <MessagesEntry />
        <NotificationBell />
            <AccountMenu />
          </div>
        </div>

        <div className="mb-1 flex items-baseline justify-between">
          <p className="text-meta text-tertiary">项目</p>
          <button
            className="text-meta text-secondary hover:text-accent"
            onClick={() => setCreating((open) => !open)}
            title="新建项目"
          >
            ＋
          </button>
        </div>

        <ul className="mb-4 space-y-0.5">
          {projects.map((project) => (
            <li key={project.id} className="group flex items-start">
              <button
                className="min-w-0 flex-1 rounded-sm px-2 py-1 text-left hover:bg-card"
                onClick={() => onOpen(project)}
              >
                <span className="block truncate text-body text-secondary">{project.name}</span>
                <span className="block text-meta text-tertiary">
                  {project.taskCount} 任务 · {ago(project.lastActivityAt)}
                </span>
              </button>
              <button
                className="shrink-0 rounded-sm px-2 py-1 text-meta text-tertiary hover:text-rust sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                onClick={() => setDeleting(project)}
                title="删除项目"
                aria-label={`删除项目 ${project.name}`}
              >
                删除
              </button>
            </li>
          ))}
          {/* 数据还没到就说「还没有项目」是在撒谎，所以等它到 */}
          {home.data !== undefined && projects.length === 0 ? (
            <li className="px-2 text-meta text-tertiary">还没有项目</li>
          ) : null}
        </ul>

        <TrashList />
        {deleting ? <DeleteProjectDialog project={deleting} onClose={() => setDeleting(null)} /> : null}
        <div className="mt-auto border-t border-hair pt-3">
          <WorkersBadge placement="up" />
        </div>
      </nav>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-4 py-6 md:px-8">
          {creating ? (
            <CreateProjectPanel
              onCancel={() => setCreating(false)}
              onCreated={(created) => {
                setCreating(false);
                onOpen(created);
              }}
            />
          ) : (
            <div className="mb-5 flex items-center gap-2 rounded-md border border-hair bg-card px-3 py-2">
              <span className="text-tertiary">⌕</span>
              <input
                className="w-full bg-transparent text-body text-primary outline-none placeholder:text-tertiary"
                placeholder="搜会话、任务或项目"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              {filter === '' ? null : (
                <button className="text-meta text-tertiary hover:text-secondary" onClick={() => setFilter('')}>
                  清除
                </button>
              )}
            </div>
          )}

          {home.isPending ? (
            <div aria-label="读取中" className="mb-5 space-y-2">
              {[0, 1, 2].map((row) => (
                <div key={row} className="h-7 animate-pulse rounded-sm bg-card" />
              ))}
            </div>
          ) : null}
          {home.error ? (
            <p className="mb-4 border-l border-rust pl-2 text-meta text-secondary">
              读不到会话：{(home.error as Error).message}
              <button className="ml-2 text-accent hover:underline" onClick={() => void home.refetch()}>
                重试
              </button>
            </p>
          ) : null}

          {groups.map(([label, sessions]) => (
            <section key={label} className="mb-5">
              <h2 className="mb-1 px-1 text-meta text-tertiary">{label}</h2>
              <ul>
                {sessions.map((session) => (
                  <li key={session.sessionId}>
                    <button
                      className="flex w-full items-center gap-2.5 rounded-sm px-1 py-1.5 text-left hover:bg-card"
                      onClick={() => open(session)}
                    >
                      <span className={`size-1.5 shrink-0 rounded-full ${dotClass(session.status)}`} />
                      <span className="min-w-0 flex-1 truncate text-body text-primary">
                        {session.taskTitle}
                      </span>
                      <span className="shrink-0 text-meta text-secondary">{session.agentId}</span>
                      <span className="shrink-0 text-meta text-tertiary">{session.projectName}</span>
                      <span className="w-16 shrink-0 text-right text-meta text-tertiary">
                        {ago(session.updatedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {!home.isPending && !home.error && shown.length === 0 ? (
            <p className="rounded-md border border-hair bg-panel px-4 py-6 text-body text-secondary">
              {needle === ''
                ? '还没有会话。选一个项目，建一条任务，点任务卡上的「＋ 会话」派生第一条会话。'
                : `没有匹配「${filter}」的会话。`}
            </p>
          ) : null}

          <p className="mt-8 text-meta text-tertiary">
            {coarsePointer()
              ? '点任务卡上的「＋ 会话」派生会话 · 关掉浏览器，会话历史还在'
              : '任务卡上点「＋ 会话」派生会话 · ⌘K 搜会话里说过的话 · 关掉浏览器，会话历史还在'}
          </p>
        </div>
      </main>
    </div>
  );
}

function CreateProjectPanel({
  onCancel,
  onCreated
}: {
  onCancel: () => void;
  onCreated: (project: ProjectDto) => void;
}) {
  const [name, setName] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('');
  const [description, setDescription] = useState('');
  const workers = useWorkers();
  // 默认不替人选机器：只填名字就能建（不带工作空间）；要放到某台机器上再展开选
  const [workerId, setWorkerId] = useState<string | null>(null);
  const fallback = resolveWorker(workers.list, null)?.workerId ?? null;
  const target = workerId ?? fallback;
  const [placing, setPlacing] = useState(false);
  // 目录选择器只在点「浏览…」后打开
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () =>
      api.createProject({
        name: name.trim(),
        ...(rootPath.trim() === '' ? {} : { rootPath: rootPath.trim(), workerId: target }),
        ...(repoUrl.trim() === '' ? {} : { repoUrl: repoUrl.trim(), defaultBranch: defaultBranch.trim() || null }),
        ...(description.trim() === '' ? {} : { description })
      }),
    onSuccess: async (created) => {
      // 路由靠 ['projects'] 认项目；只刷 ['home'] 会让新项目在跳过去时「查无此项」。
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['home'] }),
        queryClient.invalidateQueries({ queryKey: ['projects'] })
      ]);
      onCreated(created);
    },
    onError: (failure) => setError((failure as Error).message)
  });

  return (
    <section aria-label="新建项目" className="mb-6 rounded-md border border-hair bg-panel p-4">
      <p className="mb-1 text-head text-primary">新建项目</p>
      <p className="mb-3 text-meta text-secondary">
        项目是你在做的东西。起个名字就能建；放到哪台机器、哪个目录可以以后再定。
      </p>

      <form
        className="mb-2 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() === '' || create.isPending) return;
          setError(null);
          create.mutate();
        }}
      >
        <input
          aria-label="项目名"
          autoFocus
          className="min-w-0 flex-1 rounded-sm border border-hair bg-card px-3 py-2 text-head text-primary outline-none focus:border-accent"
          value={name}
          placeholder="项目名"
          onChange={(event) => setName(event.target.value)}
        />
        <button
          type="submit"
          className="min-h-[40px] shrink-0 rounded-sm bg-accent px-4 py-2 text-body text-canvas disabled:opacity-40"
          disabled={name.trim() === '' || create.isPending}
        >
          创建
        </button>
      </form>

      <textarea
        aria-label="项目说明"
        className="mb-3 block min-h-[72px] w-full resize-y rounded-sm border border-hair bg-card px-2 py-1.5 text-sub text-primary outline-none focus:border-accent"
        value={description}
        placeholder="项目说明（可选，支持 markdown）：这是什么、仓库在哪、有什么约定。agent 开工时会读到。"
        onChange={(event) => setDescription(event.target.value)}
      />

      <button
        type="button"
        aria-expanded={placing}
        aria-controls="new-project-placement"
        className="mb-2 flex min-h-[36px] items-center gap-1.5 text-meta text-secondary hover:text-primary"
        onClick={() => setPlacing((open) => !open)}
      >
        <span aria-hidden className={`inline-block transition-transform ${placing ? 'rotate-90' : ''}`}>▸</span>
        放到某台机器上（可选）
        {!placing && rootPath.trim() !== '' ? <span className="truncate font-mono text-tertiary">· {rootPath.trim()}</span> : null}
      </button>

      {placing ? (
        <div id="new-project-placement" className="mb-3 rounded-sm border border-hair p-3">
          <p className="mb-2 text-meta text-tertiary">
            选了目录，它就是这个项目的第一个持久工作空间；不选也行，开始任务时再选在哪台机器、哪个工作空间干活。
            填了 git 仓库，新建工作空间时会把它下载到那台机器。
          </p>
          <WorkerPicker
            label="目录在哪台机器上"
            workers={workers.list}
            value={workerId}
            onChange={(id) => {
              setWorkerId(id);
              setRootPath('');
            }}
          />

          {/* 行与选择器同时在：想打字就打，想点就点，不必先关掉一个再打开另一个。 */}
          <div className="mb-3 flex gap-2">
            <input
              aria-label="目录"
              className="min-w-0 flex-1 rounded-sm border border-hair bg-card px-2 py-1.5 font-mono text-meta text-primary outline-none focus:border-accent"
              value={rootPath}
              placeholder="目录（/绝对路径）"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => setRootPath(event.target.value)}
            />
            <button
              type="button"
              className="min-h-[32px] shrink-0 rounded-sm border border-hair px-3 py-1.5 text-meta text-secondary hover:border-strong"
              onClick={() => setBrowsing((open) => !open)}
            >
              {browsing ? '收起' : '浏览…'}
            </button>
          </div>

          {browsing ? (
            <div className="mb-3">
              <DirectoryPicker
                workerId={target}
                project={name}
                onCancel={() => setBrowsing(false)}
                onPick={(picked) => {
                  setRootPath(picked);
                  setBrowsing(false);
                  if (workerId === null) setWorkerId(target);
                  if (name.trim() === '') setName(picked.split('/').filter(Boolean).at(-1) ?? '');
                }}
              />
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <input
              aria-label="git 仓库"
              className="min-w-0 flex-[3_1_220px] rounded-sm border border-hair bg-card px-2 py-1.5 font-mono text-meta text-primary outline-none focus:border-accent"
              value={repoUrl}
              placeholder="git 仓库（可选，https://… 或 git@…）"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => setRepoUrl(event.target.value)}
            />
            <input
              aria-label="默认分支"
              className="min-w-0 flex-[1_1_120px] rounded-sm border border-hair bg-card px-2 py-1.5 font-mono text-meta text-primary outline-none focus:border-accent disabled:opacity-40"
              value={defaultBranch}
              placeholder="默认分支（可选）"
              spellCheck={false}
              autoCapitalize="off"
              disabled={repoUrl.trim() === ''}
              onChange={(event) => setDefaultBranch(event.target.value)}
            />
          </div>
        </div>
      ) : null}

      {error ? <p className="mb-2 text-meta text-rust">{error}</p> : null}

      <button className="text-meta text-tertiary hover:text-secondary" onClick={onCancel}>
        取消
      </button>
    </section>
  );
}

const DAY = 24 * 60 * 60 * 1000;

/** 「今天 / 昨天 / 更早」比一串日期好看，也正好对上「昨天那条跑完没有」这个问法。 */
function groupByDay(sessions: readonly RecentSessionDto[]): Array<[string, RecentSessionDto[]]> {
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const buckets: Array<[string, RecentSessionDto[]]> = [
    ['今天', []],
    ['昨天', []],
    ['更早', []]
  ];
  for (const session of sessions) {
    if (session.updatedAt >= startOfToday) buckets[0]?.[1].push(session);
    else if (session.updatedAt >= startOfToday - DAY) buckets[1]?.[1].push(session);
    else buckets[2]?.[1].push(session);
  }
  return buckets.filter(([, items]) => items.length > 0);
}

/** 与画布卡片同一套颜色：运行中琥珀、完成 sage、已停止灰、中断/失败 rust。 */
function dotClass(status: RecentSessionDto['status']): string {
  if (status === 'running') return 'bg-accent';
  if (status === 'done') return 'bg-sage';
  if (status === 'stopped') return 'bg-tertiary';
  return 'bg-rust';
}

function ago(at: number | null): string {
  if (at === null) return '还没有活动';
  const delta = Date.now() - at;
  const minute = 60_000;
  const hour = 60 * minute;
  if (delta < minute) return '刚刚';
  if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`;
  if (delta < DAY) return `${Math.floor(delta / hour)} 小时前`;
  if (delta < 2 * DAY) return '昨天';
  if (delta < 30 * DAY) return `${Math.floor(delta / DAY)} 天前`;
  return new Date(at).toLocaleDateString('zh-CN');
}
