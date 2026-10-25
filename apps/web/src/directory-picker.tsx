import { useEffect, useRef, useState } from 'react';
import { Command } from 'cmdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.ts';
import { filterEntries, splitInput, withSlash } from './directory-path.ts';

const USE = '__use__';
const UP = '__up__';
const MANAGED = '__managed__';
const CREATE = '__create__';

/**
 * 目录选择器，照 VS Code「简单文件对话框」/ Zed `workspace::Open` / OpenCode 的「打开项目」做：
 * 一个路径输入框 + 当前这一层的子文件夹列表（cmdk 负责键盘/选中/无障碍）。
 *
 * - 输入框就是路径：`/home/u/` 后面接着打字 = 在这一层里模糊筛
 * - ↑↓ 选，Enter/Tab 进入文件夹，空片段时 Backspace 回上一级，⌘/Ctrl+Enter 直接用当前目录
 * - 打的名字不存在 → 列表里出现「新建文件夹 "x"」
 * - 最近改过的排前面，git 仓库标 ⎇；给了项目名就从托管目录起步，没有就一键创建
 * - 手机上全屏、行高够手指点；桌面嵌在表单里
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
  const [text, setText] = useState('');
  const [startProject, setStartProject] = useState(project);
  const [selected, setSelected] = useState(USE);
  const inputRef = useRef<HTMLInputElement>(null);
  const { dir, filter } = splitInput(text);

  const listing = useQuery({
    queryKey: ['directories', workerId, dir, startProject],
    queryFn: () => api.listDirectories(dir, workerId, startProject),
    placeholderData: (previous) => previous
  });

  // 换了机器：回到那台机器的起点
  useEffect(() => {
    setText('');
    setStartProject(project);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerId]);

  // 第一次拿到起点（或输入了不带 / 的东西）：把输入框对齐成「目录/」
  useEffect(() => {
    if (listing.data && dir === '') setText(withSlash(listing.data.path));
  }, [listing.data, dir]);

  const current =
    listing.data && listing.data.path === (dir === '' ? listing.data.path : dir) ? listing.data : undefined;
  const entries = current ? filterEntries(current.entries, filter) : [];
  const exact = current?.entries.some((entry) => entry.name === filter) ?? false;
  const offerCreate = current !== undefined && filter.trim() !== '' && !exact;

  const managed = current?.managed ?? null;
  const managedParent = managed ? managed.slice(0, managed.lastIndexOf('/')) : null;
  const offerManaged =
    filter === '' &&
    managed !== null &&
    managedParent !== null &&
    current !== undefined &&
    current.path !== managed &&
    ((current.path === managedParent && !current.entries.some((entry) => entry.path === managed)) ||
      (current.path === current.roots[0] && !current.entries.some((entry) => entry.path === managedParent)));

  // 换目录/换筛选：选中回到第一项（有筛选时是第一个匹配，否则是「使用」）
  const first = filter !== '' ? (entries[0]?.path ?? (offerCreate ? CREATE : USE)) : USE;
  useEffect(() => setSelected(first), [first, current?.path]);

  const queryClient = useQueryClient();
  // 建完文件夹：这台机器的目录缓存都作废，回上一级才看得到新建的那个
  const made = (path: string) => {
    void queryClient.invalidateQueries({ queryKey: ['directories', workerId] });
    go(path);
  };
  const go = (path: string) => {
    setText(withSlash(path));
    inputRef.current?.focus();
  };

  const make = useMutation({
    mutationFn: async (input: { parent: string; name: string }) => api.makeDirectory({ workerId, ...input }),
    onSuccess: (dir) => made(dir.path)
  });
  const createManaged = useMutation({
    mutationFn: async () => {
      if (!managed || !managedParent || !current) throw new Error('没有托管目录');
      await api.makeDirectory({
        workerId,
        parent: current.roots[0] ?? '',
        name: 'agent-hub'
      });
      return api.makeDirectory({
        workerId,
        parent: managedParent,
        name: managed.slice(managedParent.length + 1)
      });
    },
    onSuccess: (dir) => made(dir.path)
  });
  const mutationError = (make.error ?? createManaged.error) as Error | null;

  const choose = (value: string) => {
    if (!current) return;
    if (value === USE) onPick(current.path);
    else if (value === UP) {
      if (current.parent) go(current.parent);
    } else if (value === MANAGED) createManaged.mutate();
    else if (value === CREATE) make.mutate({ parent: current.path, name: filter.trim() });
    else go(value);
  };

  const row =
    'flex min-h-[48px] cursor-pointer items-center gap-3 rounded-sm px-3 py-3 md:min-h-0 text-body text-secondary data-[selected=true]:bg-card-raised data-[selected=true]:text-primary md:py-1.5';

  return (
    <section
      aria-label="目录选择器"
      className="fixed inset-0 z-50 flex flex-col bg-panel pb-[env(safe-area-inset-bottom)] md:static md:z-auto md:h-[22rem] md:rounded-md md:border md:border-hair md:pb-0 md:shadow-sm"
    >
      <Command
        label="路径"
        shouldFilter={false}
        value={selected}
        onValueChange={setSelected}
        loop
        className="flex min-h-0 flex-1 flex-col"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            choose(USE);
          } else if (event.key === 'Tab' && !event.shiftKey && current) {
            const target = entries.find((entry) => entry.path === selected) ?? entries[0];
            if (target) {
              event.preventDefault();
              go(target.path);
            }
          } else if (
            event.key === 'Backspace' &&
            filter === '' &&
            current &&
            event.currentTarget.ownerDocument.getSelection()?.toString() === ''
          ) {
            // 空片段：回上一级；已经在 root 就停住（不让人删出 roots 之外去）
            event.preventDefault();
            if (current.parent) go(current.parent);
          } else if (event.key === 'Escape' && onCancel) {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        <div className="flex items-center gap-2 border-b border-hair px-3">
          {onCancel ? (
            <button
              type="button"
              className="-ml-1 shrink-0 rounded-sm px-2 py-2 text-secondary hover:bg-card-raised md:hidden"
              onClick={onCancel}
              aria-label="关闭"
            >
              ✕
            </button>
          ) : (
            <span aria-hidden className="text-tertiary">
              ⌕
            </span>
          )}
          <Command.Input
            ref={inputRef}
            aria-label="路径"
            autoFocus
            value={text}
            onValueChange={setText}
            placeholder="输入路径，或筛选文件夹"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="min-w-0 flex-1 bg-transparent py-3 font-mono text-body text-primary outline-none placeholder:text-tertiary md:py-2.5"
          />
          {listing.isFetching ? <span className="shrink-0 text-meta text-tertiary">…</span> : null}
        </div>

        <Command.List className="min-h-0 flex-1 overflow-y-auto p-1.5 [scroll-padding-block:6px]">
          {listing.error && !current ? (
            <p className="px-3 py-2 text-meta text-rust">{(listing.error as Error).message}</p>
          ) : null}
          {mutationError ? <p className="px-3 py-1.5 text-meta text-rust">{mutationError.message}</p> : null}

          {current ? (
            <>
              {filter === '' ? (
                <Command.Item value={USE} onSelect={choose} className={row}>
                  <span className="w-4 text-center text-accent">✓</span>
                  <span className="min-w-0 flex-1 truncate">
                    使用 <span className="font-mono text-meta text-tertiary">{current.path}</span>
                  </span>
                  <kbd className="hidden shrink-0 text-meta text-tertiary md:inline">⌘↵</kbd>
                </Command.Item>
              ) : null}
              {current.parent && filter === '' ? (
                <Command.Item value={UP} onSelect={choose} className={row}>
                  <span className="w-4 text-center text-tertiary">↑</span>
                  <span className="flex-1">上一级</span>
                  <kbd className="hidden shrink-0 text-meta text-tertiary md:inline">⌫</kbd>
                </Command.Item>
              ) : null}
              {offerManaged ? (
                <Command.Item value={MANAGED} onSelect={choose} className={`${row} text-accent`}>
                  <span className="w-4 text-center">＋</span>
                  <span className="min-w-0 flex-1 truncate">
                    创建项目目录 agent-hub/
                    {managed?.slice((managedParent?.length ?? 0) + 1)}
                  </span>
                </Command.Item>
              ) : null}

              {entries.length > 0 ? (
                <Command.Group
                  heading={filter === '' ? '文件夹 · 最近修改' : '匹配的文件夹'}
                  className="mt-1 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-meta [&_[cmdk-group-heading]]:text-tertiary"
                >
                  {entries.map((entry) => (
                    <Command.Item key={entry.path} value={entry.path} onSelect={choose} className={row}>
                      <span className="w-4 text-center text-tertiary">▸</span>
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      {entry.isGit ? (
                        <span className="shrink-0 font-mono text-meta text-tertiary" title="git 仓库">
                          ⎇
                        </span>
                      ) : null}
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}

              {offerCreate ? (
                <Command.Item value={CREATE} onSelect={choose} className={`${row} text-accent`}>
                  <span className="w-4 text-center">＋</span>
                  <span className="min-w-0 flex-1 truncate">新建文件夹 “{filter.trim()}”</span>
                </Command.Item>
              ) : null}
              {current.entries.length === 0 && filter === '' ? (
                <p className="px-3 py-3 text-meta text-tertiary">这里没有子文件夹。打个名字就能新建。</p>
              ) : null}
            </>
          ) : listing.isPending ? (
            <p className="px-3 py-2 text-meta text-tertiary">读取中…</p>
          ) : null}
        </Command.List>

        <footer className="flex items-center gap-3 border-t border-hair px-3 py-2">
          <span className="hidden min-w-0 flex-1 truncate text-meta text-tertiary md:block">
            ↑↓ 选择 · ↵/Tab 进入 · ⌫ 上一级 · ⌘↵ 使用
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-meta text-tertiary md:hidden">
            {current?.path ?? ''}
          </span>
          <button
            type="button"
            className="shrink-0 rounded-sm bg-accent px-5 py-2 text-meta text-canvas disabled:opacity-40 md:py-1.5"
            disabled={current === undefined}
            onClick={() => current && onPick(current.path)}
          >
            使用
          </button>
        </footer>
      </Command>
    </section>
  );
}
