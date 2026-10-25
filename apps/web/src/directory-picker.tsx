import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { DirectoryListingDto } from './api.ts';
import { api } from './api.ts';
import { breadcrumbs } from './directory-path.ts';

/**
 * 目录选择器：从真实目录里点，而不是手打一个可能会错的路径。
 *
 * - 顶部面包屑，最上只到这台机器的 roots（不能再往上）
 * - 单击进入文件夹；底部固定「使用」选当前目录（不靠双击，手机上也一样）
 * - 可以就地新建文件夹（只建一层，服务端/Worker 再用 realpath 把关）
 * - git 仓库标 ⎇，最近改过的排前面
 * - 给了项目名就从项目托管目录 `<roots[0]>/agent-hub/<slug>` 起步
 * - 手机上全屏，桌面嵌在页面里
 */
export function DirectoryPicker({
  onPick,
  onCancel,
  workerId = null,
  project = ''
}: {
  onPick: (path: string) => void;
  /** 有它才显示「关闭」（手机全屏时需要一个出口）。 */
  onCancel?: () => void;
  /** 浏览哪台 Worker 的文件系统；null = hub 所在这台。 */
  workerId?: string | null;
  /** 项目名：用来算托管目录、决定起点。 */
  project?: string;
}) {
  const [path, setPath] = useState('');
  // 起点只在打开/换机器时按项目名算一次；之后用户敲项目名不该把人从当前目录拽走
  const [startProject, setStartProject] = useState(project);
  const listing = useQuery({
    queryKey: ['directories', workerId, path, startProject],
    queryFn: () => api.listDirectories(path, workerId, startProject)
  });
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [folderName, setFolderName] = useState('');
  const crumbsRef = useRef<HTMLElement>(null);

  // 换了机器：回到那台机器的起点，而不是拿上一台的路径去问它。
  useEffect(() => {
    setPath('');
    setStartProject(project);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerId]);

  useEffect(() => {
    if (listing.data && path === '') setPath(listing.data.path);
  }, [listing.data, path]);

  // 面包屑长了就滚到最右：人关心的是当前在哪一层
  useEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [listing.data?.path]);

  const current: DirectoryListingDto | undefined = listing.data?.path === path ? listing.data : undefined;

  const make = useMutation({
    mutationFn: async (input: { parent: string; name: string }) => api.makeDirectory({ workerId, ...input }),
    onSuccess: (made) => {
      setCreating(false);
      setFolderName('');
      setPath(made.path);
    }
  });

  // 托管目录还不存在：给一键创建（先补 agent-hub 这一层）
  const managed = current?.managed ?? null;
  const managedParent = managed ? managed.slice(0, managed.lastIndexOf('/')) : null;
  const offerManaged =
    managed !== null && managedParent !== null && current !== undefined && current.path !== managed &&
    (current.path === managedParent || current.path === current.roots[0]);
  const createManaged = useMutation({
    mutationFn: async () => {
      if (!managed || !managedParent || !current) throw new Error('没有托管目录');
      const root = current.roots[0] ?? '';
      await api.makeDirectory({ workerId, parent: root, name: 'agent-hub' });
      return api.makeDirectory({ workerId, parent: managedParent, name: managed.slice(managedParent.length + 1) });
    },
    onSuccess: (made) => setPath(made.path)
  });

  const crumbs = current ? breadcrumbs(current.path, current.roots) : [];
  const mutationError = (make.error ?? createManaged.error) as Error | null;

  return (
    <section
      aria-label="目录选择器"
      className="fixed inset-0 z-50 flex flex-col bg-panel pb-[env(safe-area-inset-bottom)] md:static md:z-auto md:h-[22rem] md:rounded-md md:border md:border-hair md:pb-0"
    >
      <header className="flex items-center gap-1 border-b border-hair px-2 py-1.5">
        {onCancel ? (
          <button
            className="shrink-0 rounded-sm px-2 py-1 text-meta text-secondary hover:bg-card-raised md:hidden"
            onClick={onCancel}
            aria-label="关闭"
          >
            ✕
          </button>
        ) : null}
        <nav ref={crumbsRef} aria-label="路径" className="flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap">
          {crumbs.map((crumb, index) => (
            <span key={crumb.path} className="flex items-center">
              {index > 0 ? <span className="px-0.5 text-tertiary">/</span> : null}
              <button
                className={`rounded-sm px-1.5 py-1 text-meta ${
                  index === crumbs.length - 1 ? 'text-primary' : 'text-secondary hover:bg-card-raised'
                }`}
                onClick={() => setPath(crumb.path)}
                title={crumb.path}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
        <button
          className="shrink-0 rounded-sm px-2 py-1 text-meta text-secondary hover:bg-card-raised"
          aria-label="输入路径"
          title="输入路径"
          onClick={() => {
            setDraft(current?.path ?? path);
            setTyping((open) => !open);
          }}
        >
          ⋯
        </button>
      </header>

      {typing ? (
        <form
          className="flex gap-2 border-b border-hair px-2 py-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim() !== '') setPath(draft.trim());
            setTyping(false);
          }}
        >
          <input
            aria-label="当前目录"
            autoFocus
            className="min-w-0 flex-1 rounded-sm border border-hair bg-card px-2 py-1 font-mono text-meta text-primary outline-none focus:border-accent"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
          />
          <button className="rounded-sm border border-hair px-2 text-meta text-secondary hover:border-strong">前往</button>
        </form>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {listing.isPending || (listing.isFetching && !current) ? (
          <p className="px-3 py-2 text-meta text-tertiary">读取中…</p>
        ) : null}
        {listing.error ? <p className="px-3 py-2 text-meta text-rust">{(listing.error as Error).message}</p> : null}

        {offerManaged ? (
          <button
            className="flex w-full items-center gap-2 border-b border-hair px-3 py-2 text-left text-meta text-accent hover:bg-card-raised"
            disabled={createManaged.isPending}
            onClick={() => createManaged.mutate()}
          >
            <span>＋</span>
            <span className="truncate">创建项目目录 agent-hub/{managed?.slice((managedParent?.length ?? 0) + 1)}</span>
          </button>
        ) : null}

        {creating ? (
          <form
            className="flex items-center gap-2 border-b border-hair px-3 py-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (current && folderName.trim() !== '') make.mutate({ parent: current.path, name: folderName.trim() });
            }}
          >
            <span className="text-tertiary">▸</span>
            <input
              aria-label="新文件夹名"
              autoFocus
              className="min-w-0 flex-1 rounded-sm border border-hair bg-card px-2 py-1 text-body text-primary outline-none focus:border-accent"
              value={folderName}
              placeholder="文件夹名"
              onChange={(event) => setFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setCreating(false);
              }}
              spellCheck={false}
            />
            <button
              className="rounded-sm bg-accent px-2 py-1 text-meta text-canvas disabled:opacity-40"
              disabled={folderName.trim() === '' || make.isPending}
            >
              创建
            </button>
            <button type="button" className="px-1 text-meta text-tertiary" onClick={() => setCreating(false)}>
              取消
            </button>
          </form>
        ) : null}
        {mutationError ? <p className="px-3 py-1.5 text-meta text-rust">{mutationError.message}</p> : null}

        {current && current.entries.length === 0 && !creating ? (
          <p className="px-3 py-3 text-meta text-tertiary">这里没有子文件夹。</p>
        ) : null}
        {current?.entries.map((entry) => (
          <button
            key={entry.path}
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-card-raised md:py-1.5"
            onClick={() => setPath(entry.path)}
          >
            <span className="text-tertiary">▸</span>
            <span className="min-w-0 flex-1 truncate text-body text-secondary">{entry.name}</span>
            {entry.isGit ? (
              <span className="shrink-0 font-mono text-meta text-tertiary" title="git 仓库">
                ⎇
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <footer className="flex items-center gap-2 border-t border-hair px-3 py-2">
        <button
          className="shrink-0 rounded-sm px-1 py-1 text-meta text-secondary hover:text-primary disabled:opacity-40"
          disabled={current === undefined}
          onClick={() => {
            make.reset();
            setCreating(true);
          }}
        >
          ＋ 新建文件夹
        </button>
        <span className="min-w-0 flex-1 truncate text-right font-mono text-meta text-tertiary" title={current?.path}>
          {current?.path ?? ''}
        </span>
        <button
          className="shrink-0 rounded-sm bg-accent px-4 py-1.5 text-meta text-canvas disabled:opacity-40"
          disabled={current === undefined}
          onClick={() => current && onPick(current.path)}
        >
          使用
        </button>
      </footer>
    </section>
  );
}
