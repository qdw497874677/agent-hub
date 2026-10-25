import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectDto, ProjectSummaryDto } from './api.ts';
import { api } from './api.ts';
import { DirectoryPicker } from './directory-picker.tsx';
import { WorkersBadge } from './workers.tsx';

/**
 * 首页。
 *
 * 它不是「登录后弹一个表单」，而是这个产品的门厅：有哪些项目、里面有多少活、
 * 节点在不在线，然后才谈「从哪开始」。指目录这件事是页面里的一段流程，
 * 不是打断式对话框——第一屏就丢给用户一个输入框，等于让他先猜你的规矩。
 */
export function HomePage({ onOpen }: { onOpen: (project: ProjectDto) => void }) {
  const [creating, setCreating] = useState(false);
  const home = useQuery({ queryKey: ['home'], queryFn: api.home, refetchInterval: 10_000 });

  const projects = home.data?.projects ?? [];

  return (
    <main className="mx-auto flex h-full w-full max-w-[880px] flex-col px-6 py-10">
      <header className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-title text-primary">agent-hub</h1>
          <p className="mt-1 max-w-[520px] text-body text-secondary">
            你自带机器和 agent。它把任务拆成多个可并行的会话，并把派生与血缘变成可见、可恢复的东西。
          </p>
        </div>
        <WorkersBadge />
      </header>

      {creating ? (
        <CreateProjectPanel
          onCancel={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            onOpen(created);
          }}
        />
      ) : (
        <button
          className="mb-6 self-start rounded-sm bg-accent px-3 py-1.5 text-meta text-canvas"
          onClick={() => setCreating(true)}
        >
          新建项目
        </button>
      )}

      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-head text-primary">项目</h2>
        <span className="text-meta text-tertiary">
          {projects.length === 0 ? '' : `${projects.length} 个`}
        </span>
      </div>

      {home.isPending ? <p className="text-meta text-tertiary">读取中…</p> : null}
      {home.error ? <p className="text-meta text-rust">{(home.error as Error).message}</p> : null}

      {projects.length === 0 && !home.isPending ? (
        <p className="rounded-md border border-hair bg-panel px-4 py-6 text-body text-secondary">
          还没有项目。指一个本地目录，任务就活在它里面——目录不会被复制，也不会被搬走。
        </p>
      ) : null}

      <ul className="space-y-2">
        {projects.map((project) => (
          <li key={project.id}>
            <button
              className="flex w-full items-baseline justify-between gap-4 rounded-md border border-hair bg-panel px-4 py-3 text-left hover:border-strong hover:bg-card"
              onClick={() => onOpen(project)}
            >
              <span className="min-w-0">
                <span className="block text-head text-primary">{project.name}</span>
                <span className="mt-0.5 block truncate font-mono text-meta text-tertiary">
                  {project.rootPath}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-meta text-secondary">
                  {project.taskCount} 个任务 · {project.sessionCount} 个会话
                </span>
                <span className="block text-meta text-tertiary">{ago(project.lastActivityAt)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      <footer className="mt-auto pt-8 text-meta text-tertiary">
        画布上双击任务即派生会话 · ⌘K 搜会话里说过的话 · 关掉浏览器，会话历史还在
      </footer>
    </main>
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
  const [browsing, setBrowsing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () => api.createProject({ name: name.trim(), rootPath: rootPath.trim() }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['home'] });
      onCreated(created);
    },
    onError: (failure) => setError((failure as Error).message)
  });

  return (
    <section className="mb-6 rounded-md border border-strong bg-panel p-4">
      <p className="mb-1 text-head text-primary">新建项目</p>
      <p className="mb-4 text-meta text-secondary">
        项目 = 一个本地目录。它不会被复制：agent 就在这个目录里干活，产出物落在
        <span className="font-mono text-tertiary"> .agent-hub/ </span>下。
      </p>

      <div className="mb-3 flex gap-2">
        <div className="flex-1">
          <label className="mb-1 block text-meta text-tertiary">目录</label>
          <input
            className="w-full rounded-sm border border-hair bg-card px-2 py-1.5 font-mono text-meta text-primary outline-none focus:border-accent"
            value={rootPath}
            placeholder="选一个目录，或者直接打绝对路径"
            spellCheck={false}
            onChange={(event) => {
              setRootPath(event.target.value);
              setBrowsing(false);
            }}
          />
        </div>
        <div className="flex items-end">
          <button
            className="rounded-sm border border-hair px-3 py-1.5 text-meta text-secondary hover:border-strong"
            onClick={() => setBrowsing((open) => !open)}
          >
            {browsing ? '收起' : '浏览…'}
          </button>
        </div>
      </div>

      {browsing ? (
        <div className="mb-3">
          <DirectoryPicker
            onPick={(picked) => {
              setRootPath(picked);
              setBrowsing(false);
              if (name.trim() === '') setName(picked.split('/').filter(Boolean).at(-1) ?? '');
            }}
          />
        </div>
      ) : null}

      <div className="mb-3">
        <label className="mb-1 block text-meta text-tertiary">项目名</label>
        <input
          className="w-full rounded-sm border border-hair bg-card px-2 py-1.5 text-body text-primary outline-none focus:border-accent"
          value={name}
          placeholder="选目录后自动取最后一段，可改"
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      {error ? <p className="mb-2 text-meta text-rust">{error}</p> : null}

      <div className="flex justify-end gap-2">
        <button
          className="rounded-sm border border-hair px-3 py-1 text-meta text-secondary hover:border-strong"
          onClick={onCancel}
        >
          取消
        </button>
        <button
          className="rounded-sm bg-accent px-3 py-1 text-meta text-canvas disabled:opacity-40"
          disabled={name.trim() === '' || rootPath.trim() === '' || create.isPending}
          onClick={() => {
            setError(null);
            create.mutate();
          }}
        >
          开始
        </button>
      </div>
    </section>
  );
}

/** 「3 分钟前」比「2026-10-25 07:52」更有用：用户记的是刚刚干了什么。 */
function ago(at: number | null): string {
  if (at === null) return '还没有活动';
  const delta = Date.now() - at;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return '刚刚';
  if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`;
  if (delta < day) return `${Math.floor(delta / hour)} 小时前`;
  if (delta < 2 * day) return '昨天';
  if (delta < 30 * day) return `${Math.floor(delta / day)} 天前`;
  return new Date(at).toLocaleDateString('zh-CN');
}

/** 首页用不到，但把类型放在这里省得别处再写一遍。 */
export type { ProjectSummaryDto };
