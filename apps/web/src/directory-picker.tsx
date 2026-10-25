import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DirectoryListingDto } from './api.ts';
import { api } from './api.ts';

/**
 * 目录选择器：从真实目录里点，而不是手打一个可能会错的路径。
 *
 * 它不是一个「弹框」而是一块嵌在页面里的面板：创建项目本身是页面上的
 * 一段流程（指目录 → 命名 → 开始），不是打断式的对话框。
 */
export function DirectoryPicker({ onPick }: { onPick: (path: string) => void }) {
  const [path, setPath] = useState('');
  const listing = useQuery({
    queryKey: ['directories', path],
    queryFn: () => api.listDirectories(path)
  });

  // 第一次打开落在用户家目录：`?path=` 留空由服务端解释成 home。
  useEffect(() => {
    if (listing.data && path === '') setPath(listing.data.path);
  }, [listing.data, path]);

  const current: DirectoryListingDto | undefined = listing.data;

  return (
    <section aria-label="目录选择器" className="rounded-md border border-hair bg-card p-3">
      <div className="mb-2 flex items-center gap-2">
        <button
          className="rounded-sm border border-hair px-2 py-0.5 text-meta text-secondary hover:border-strong disabled:opacity-40"
          disabled={current?.parent === null || current === undefined}
          onClick={() => current?.parent && setPath(current.parent)}
          title="上一级"
        >
          ↑
        </button>
        <input
          aria-label="当前目录"
          className="min-w-0 flex-1 rounded-sm border border-hair bg-panel px-2 py-1 font-mono text-meta text-primary outline-none focus:border-accent"
          value={path === '' ? (current?.path ?? '') : path}
          onChange={(event) => setPath(event.target.value)}
          spellCheck={false}
        />
      </div>

      <div className="mb-2 max-h-56 overflow-y-auto rounded-sm border border-hair bg-panel">
        {listing.isPending ? <p className="px-2 py-2 text-meta text-tertiary">读取中…</p> : null}
        {listing.error ? (
          <p className="px-2 py-2 text-meta text-rust">{(listing.error as Error).message}</p>
        ) : null}
        {current && current.entries.length === 0 ? (
          <p className="px-2 py-2 text-meta text-tertiary">这下面没有子目录。</p>
        ) : null}
        {current?.entries.map((entry) => (
          <button
            key={entry.path}
            className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-card-raised"
            onClick={() => setPath(entry.path)}
            onDoubleClick={() => onPick(entry.path)}
          >
            <span className="text-tertiary">▸</span>
            <span className="truncate text-body text-secondary">{entry.name}</span>
          </button>
        ))}
      </div>

      <p className="mb-2 text-meta text-tertiary">
        点进目录看，双击直接选。以点开头的目录不列出——真要选，把路径打进上面的框。
      </p>

      <div className="flex justify-end">
        <button
          className="rounded-sm bg-accent px-3 py-1 text-meta text-canvas disabled:opacity-40"
          disabled={current === undefined || current.path !== path}
          onClick={() => current && onPick(current.path)}
        >
          用这个目录
        </button>
      </div>
    </section>
  );
}
