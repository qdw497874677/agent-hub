import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shell/api.ts';
import { breadcrumbs, filterEntries, visibleEntries } from '../../shell/directory-path.ts';
import { Icon } from '../../atoms/icons.tsx';
import { Notice } from '../../atoms/notice.tsx';
import { resolveWorker, useWorkers } from '../../shell/workers.tsx';

const ROW =
  'flex min-h-[44px] w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left text-body text-primary hover:bg-card-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:min-h-[32px] md:py-1.5';
const QUIET =
  'min-h-[44px] shrink-0 rounded-sm px-2.5 text-meta text-secondary hover:bg-card-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-[32px] md:py-1.5';
/** 一层最多画这么多行；共享机器的 /tmp 能有上万个子目录。 */
const ENTRY_LIMIT = 200;
/** 模态里可用 Tab 到达的控件；`-1` 的窗口容器本身不算。 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 窄屏：对话框本身是底部抽屉（祖先带 transform），`fixed inset-0` 只会铺满抽屉。
 * 选择文件夹要的是整屏，所以窄屏挂到 body 上；宽屏照旧放在对话框里当静态面板。
 */
function useNarrowScreen() {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
  );
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const sync = () => setNarrow(media.matches);
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  return narrow;
}

/**
 * 目录选择器：像系统「文件」那样先看位置再一层层走，桌面再给一个「输入路径」的出口。
 *
 * - 顶上是上下文（在哪台机器上）+ 面包屑：面包屑从这台机器允许的根开始，点哪一级回哪一级，
 *   到根就停住；「上一级」独立成一个按钮，手指好点。
 * - 中间只列出当前这一层的文件夹，点一行就是进去——不选中、不写入。
 * - 「筛选」只过滤当前这一层，不会改路径，也不会替用户跳转。
 * - 「输入路径」是显式打开的（桌面 / 手机都可以）：输入完整路径，按「前往」才走。
 * - 底栏常驻「选此文件夹」，按下去才算选定；新建文件夹是另一个明确动作，建好（服务端确认）才进去。
 * - 手机全屏、只有一个纵向滚动区；不自动聚焦、不抢 Tab、不吞 Escape。
 */
export interface DirectoryPickerProps {
  onPick: (path: string) => void;
  /** 有它才显示「关闭」（手机全屏时需要一个出口）。 */
  onCancel?: () => void;
  /** 浏览哪台机器的文件系统；null = hub 所在这台。 */
  workerId?: string | null;
  /** 项目名：用来算托管目录、决定起点。 */
  project?: string;
}

/**
 * 换机器 / 换项目 = 换一份浏览上下文：用 key 重挂，同步清掉旧机器的位置、筛选和未完成的输入，
 * 不会先拿旧路径去新机器上查一次再被 effect 重置。
 */
export function DirectoryPicker(props: DirectoryPickerProps) {
  return <DirectoryPickerBody key={`${props.workerId ?? 'local'}\u0000${props.project ?? ''}`} {...props} />;
}

function DirectoryPickerBody({
  onPick,
  onCancel,
  workerId = null,
  project = ''
}: DirectoryPickerProps) {
  // 当前浏览的位置；'' = 让服务端给起点（项目托管目录 → 它的上一层 → 这台机器的根）
  const [path, setPath] = useState('');
  const [filter, setFilter] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [editingPath, setEditingPath] = useState(false);
  const [pathText, setPathText] = useState('');
  const [pathError, setPathError] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  const sectionRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const focusAfterNav = useRef(false);

  // 只认当前这个 key 的数据：换机器、换路径、换项目都不沿用上一份（旧机器 / 旧目录的列表会骗人）。
  // 同 key 重新取数失败时 React Query 会留着上一次的成功结果——失败就当作没有当前目录，
  // 不能让人对着旧列表按「选此文件夹」或继续往里走。
  const listing = useQuery({
    queryKey: ['directories', workerId, path, project],
    queryFn: () => api.listDirectories(path, workerId, project)
  });
  const current = listing.isError ? undefined : listing.data;
  // 当前这一份列表对应的服务端路径（用于「创建完成后人还在原地才跟着跳」）
  const atRef = useRef<string | null>(null);
  atRef.current = current?.path ?? null;

  const queryClient = useQueryClient();
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['directories', workerId] });

  const go = (next: string) => {
    focusAfterNav.current = true;
    setPath(next);
    setFilter('');
    setEditingPath(false);
    setPathError(null);
    // 新建表单属于上一层：换位置就同步收起，别让 Enter 落到新位置上
    setNaming(null);
    setNameError(null);
  };

  // 变化了位置：筛选和新建都只属于上一层
  useEffect(() => {
    setFilter('');
    setNaming(null);
    setNameError(null);
  }, [current?.path]);

  // 用键盘进来（点行 / 面包屑 / 前往）后，把焦点交给列表：接着用 ↑↓ 走，不在页面上丢焦点
  useEffect(() => {
    if (!focusAfterNav.current || current === undefined) return;
    focusAfterNav.current = false;
    listRef.current?.focus({ preventScroll: true });
  }, [current?.path, current]);

  // 打开前焦点在哪，关掉就还回哪（还挂在页面上时），不把焦点丢到 body
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  // 打开时把焦点放进选择器本身（不碰输入框，不会弹键盘）：桌面对着列表用 ↑↓，
  // 手机放在窗口上，读屏和 Esc 都从这一层开始
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 768px)').matches;
    if (wide) listRef.current?.focus({ preventScroll: true });
    else sectionRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (editingPath) pathRef.current?.select();
  }, [editingPath]);

  const { list: workers } = useWorkers();
  const machine = resolveWorker(workers, workerId);
  const machineLabel = machine?.label ?? '这台机器';
  const localMachine = workerId === null || machineLabel === '本机';

  const crumbs = current ? breadcrumbs(current.path, current.roots) : [];
  const hiddenCount = current?.entries.filter((entry) => entry.hidden).length ?? 0;
  const visible = current ? visibleEntries(current.entries, showHidden || filter.startsWith('.')) : [];
  const entries = filterEntries(visible, filter);
  const exact = current?.entries.some((entry) => entry.name === filter) ?? false;
  const offerCreate = current !== undefined && filter.trim() !== '' && !exact;
  // 共享机器上的 /tmp 可能有上万个目录：整层一次画出来会卡死，只画前 200 个，剩下的靠筛选。
  const shown = entries.slice(0, ENTRY_LIMIT);
  const truncated = entries.length > ENTRY_LIMIT;

  const managed = current?.managed ?? null;
  const managedParent = managed ? managed.slice(0, managed.lastIndexOf('/')) : null;
  const offerManaged =
    filter === '' &&
    current !== undefined &&
    managed !== null &&
    managedParent !== null &&
    current.path !== managed &&
    (current.path === managedParent || current.path === current.roots[0]) &&
    !current.entries.some((entry) => entry.path === managed);

  const made = (created: string, parent: string) => {
    invalidate();
    setNaming(null);
    setNameError(null);
    // 响应回来时人可能已经换了位置：不把旧位置创建出来的路径当成新位置的入口
    if (atRef.current === parent) go(created);
  };

  const makeNamed = useMutation({
    mutationFn: async (input: { parent: string; name: string }) => api.makeDirectory({ workerId, ...input }),
    onSuccess: (created, input) => made(created.path, input.parent),
    onError: (error) => setNameError((error as Error).message)
  });

  const createManaged = useMutation({
    mutationFn: async () => {
      if (!managed || !managedParent || !current) throw new Error('没有托管目录');
      const from = current.path;
      const container = managedParent.slice(managedParent.lastIndexOf('/') + 1);
      if (current.roots[0] !== managedParent) {
        await api.makeDirectory({ workerId, parent: current.roots[0] ?? '', name: container });
      }
      const created = await api.makeDirectory({
        workerId,
        parent: managedParent,
        name: managed.slice(managedParent.length + 1)
      });
      return { created: created.path, from };
    },
    onSuccess: ({ created, from }) => made(created, from)
  });

  const nameProblem = (name: string): string | null => {
    const trimmed = name.trim();
    if (trimmed === '') return '名字不能为空';
    if (trimmed.includes('/') || trimmed.includes('\\')) return '名字里不能有斜杠';
    if (trimmed === '.' || trimmed === '..') return '不能用 . 或 ..';
    if (current?.entries.some((entry) => entry.name === trimmed)) return '这里已经有同名文件夹';
    return null;
  };
  const closeNaming = () => {
    setNaming(null);
    setNameError(null);
  };
  const openNaming = (name = '') => {
    if (!current) return;
    setFilter('');
    setNaming(name);
    setNameError(null);
  };
  const submitName = () => {
    if (!current || naming === null) return;
    const problem = nameProblem(naming);
    if (problem) return setNameError(problem);
    makeNamed.mutate({ parent: current.path, name: naming.trim() });
  };

  const openPath = () => {
    setPathText(current?.path ?? '');
    setPathError(null);
    setEditingPath(true);
  };
  const submitPath = () => {
    const value = pathText.trim();
    if (value === '') return setPathError('请输入完整路径');
    if (!value.startsWith('/')) return setPathError('要输入完整路径（以 / 开头）');
    setPathError(null);
    go(value.length > 1 ? value.replace(/\/+$/, '') : value);
  };

  const choose = () => {
    if (current) onPick(current.path);
  };

  const narrow = useNarrowScreen();

  // Esc 只关最上面这一层：先收输入，再关窗口。捕获阶段就拦住，底下「开始会话」的 Esc 不会跟着把表单也关掉。
  const escapeRef = useRef<() => void>(() => {});
  escapeRef.current = () => {
    if (editingPath) {
      setEditingPath(false);
      setPathError(null);
      return;
    }
    if (naming !== null) {
      closeNaming();
      return;
    }
    if (filter !== '') {
      setFilter('');
      return;
    }
    onCancel?.();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        escapeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      // 模态：Tab 只在本窗口里走，到头了绕回另一头，不落到背后的表单
      const section = sectionRef.current;
      if (!section) return;
      const focusables = [...section.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.getClientRects().length > 0
      );
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !section.contains(active) || active === section) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-picker-row]')];
    if (rows.length === 0) return;
    event.preventDefault();
    const index = rows.findIndex((row) => row === document.activeElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = index < 0 ? 0 : (index + step + rows.length) % rows.length;
    rows[Math.min(next, rows.length - 1)]?.focus();
  };

  const panel = (
    <>
      <div
        aria-hidden
        className="fixed inset-0 z-[65] bg-black/45 backdrop-blur-[1px]"
        onClick={() => {
          if (onCancel) onCancel();
        }}
      />
      <section
      ref={sectionRef}
      role="dialog"
      aria-modal="true"
      aria-label="目录选择器"
      tabIndex={-1}
      className="fixed inset-0 z-[70] flex flex-col overflow-hidden bg-panel outline-none md:inset-auto md:left-1/2 md:top-1/2 md:h-[min(42rem,calc(100dvh-3rem))] md:w-[min(46rem,calc(100vw-3rem))] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-md md:border md:border-strong md:shadow-overlay"
    >
      <header className="shrink-0 border-b border-hair">
        <div className="flex items-center gap-2 px-2.5 pt-2">
          {onCancel ? (
            <button
              type="button"
              aria-label="关闭"
              className="-ml-1 flex size-[44px] shrink-0 items-center justify-center rounded-sm text-secondary hover:bg-card-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:size-9"
              onClick={onCancel}
            >
              <Icon name="x" size={16} />
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-body text-primary">选择文件夹</h2>
            <p className="truncate text-meta text-tertiary" data-testid="picker-machine">
              {localMachine ? (
                '这台机器上'
              ) : (
                <>
                  在 <span className="text-secondary">{machineLabel}</span> 上
                </>
              )}
              {machine && machine.state !== 'online' ? ' · 离线' : ''}
            </p>
          </div>
          <button
            type="button"
            aria-expanded={editingPath}
            className={`${QUIET} flex items-center gap-1`}
            onClick={() => (editingPath ? setEditingPath(false) : openPath())}
          >
            <Icon name="pencil" size={13} className="text-tertiary" />
            输入路径
          </button>
        </div>

        <div className="flex items-center gap-1 px-1.5 pb-1.5 pt-1">
          <button
            type="button"
            aria-label="上一级"
            title={current && current.parent === null ? '已经到这台机器允许浏览的最上层' : '上一级'}
            disabled={!current?.parent}
            className="flex size-[44px] shrink-0 items-center justify-center rounded-sm text-secondary hover:bg-card-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:text-tertiary/40 disabled:hover:bg-transparent md:size-8"
            onClick={() => {
              if (current?.parent) go(current.parent);
            }}
          >
            <Icon name="chevron-left" size={17} />
          </button>
          {crumbs.length > 0 ? (
            <nav aria-label="当前位置" className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none]">
              {crumbs.map((crumb, index) => {
                const last = index === crumbs.length - 1;
                return (
                  <span key={crumb.path} className="flex shrink-0 items-center">
                    {index > 0 ? (
                      <span aria-hidden className="px-0.5 text-tertiary/60">
                        /
                      </span>
                    ) : null}
                    <button
                      type="button"
                      aria-current={last ? 'page' : undefined}
                      title={crumb.path}
                      className={`max-w-[9rem] truncate rounded-sm px-1.5 py-1.5 text-meta hover:bg-card-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring ${
                        last ? 'text-primary' : 'text-link'
                      }`}
                      onClick={() => {
                        if (!last) go(crumb.path);
                      }}
                    >
                      {crumb.label}
                    </button>
                  </span>
                );
              })}
            </nav>
          ) : (
            <span className="min-w-0 flex-1 truncate px-1 font-mono text-meta text-tertiary" title={path}>
              {path || '起点'}
            </span>
          )}
          {listing.isFetching ? (
            <span role="status" className="shrink-0 pr-1 text-meta text-tertiary">
              读取中…
            </span>
          ) : null}
        </div>
      </header>

      {editingPath ? (
        <div className="shrink-0 border-b border-hair bg-canvas/50 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <input
              ref={pathRef}
              aria-label="路径"
              aria-invalid={pathError !== null}
              aria-describedby={pathError ? 'picker-path-error' : undefined}
              value={pathText}
              onChange={(event) => {
                setPathText(event.target.value);
                setPathError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitPath();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setEditingPath(false);
                  setPathError(null);
                }
              }}
              placeholder="/home/你/项目"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="min-h-[44px] min-w-0 flex-1 rounded-sm border border-hair bg-canvas px-2 font-mono text-body text-primary outline-none placeholder:text-tertiary focus:border-ring md:min-h-[34px]"
            />
            <button
              type="button"
              className="min-h-[44px] shrink-0 rounded-sm bg-action px-4 text-meta text-action-fg hover:bg-action/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-[34px]"
              onClick={submitPath}
            >
              前往
            </button>
            <button
              type="button"
              className={`${QUIET} min-h-[44px] md:min-h-[34px]`}
              onClick={() => {
                setEditingPath(false);
                setPathError(null);
              }}
            >
              取消
            </button>
          </div>
          {pathError ? (
            <p id="picker-path-error" role="alert" className="mt-1 text-meta text-rust">
              {pathError}
            </p>
          ) : (
            <p className="mt-1 hidden text-meta text-tertiary md:block">输入完整路径后按「前往」；不确定就点上面的面包屑</p>
          )}
        </div>
      ) : null}

      {naming !== null ? (
        <div className="shrink-0 border-b border-hair bg-canvas/50 px-2.5 py-2">
          <p className="mb-1 truncate text-meta text-tertiary">
            在 <span className="font-mono">{current?.path}</span> 下新建
          </p>
          <div className="flex items-center gap-2">
            <input
              aria-label="新文件夹名"
              autoFocus
              value={naming}
              onChange={(event) => {
                setNaming(event.target.value);
                setNameError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.stopPropagation();
                  submitName();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  closeNaming();
                }
              }}
              placeholder="文件夹名"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-invalid={nameError !== null}
              aria-describedby={nameError ? 'new-folder-error' : undefined}
              className="min-h-[44px] min-w-0 flex-1 rounded-sm border border-hair bg-canvas px-2 font-mono text-body text-primary outline-none focus:border-ring md:min-h-[34px]"
            />
            <button
              type="button"
              className="min-h-[44px] shrink-0 rounded-sm bg-action px-4 text-meta text-action-fg hover:bg-action/90 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-[34px]"
              disabled={makeNamed.isPending}
              onClick={submitName}
            >
              {makeNamed.isPending ? '创建中…' : '创建'}
            </button>
            <button type="button" className={`${QUIET} min-h-[44px] md:min-h-[34px]`} onClick={closeNaming}>
              取消
            </button>
          </div>
          {nameError ? (
            <p id="new-folder-error" role="alert" className="mt-1 text-meta text-rust">
              {nameError}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex shrink-0 items-center gap-2 border-b border-hair px-2.5 py-1">
        <Icon name="search" size={14} className="shrink-0 text-tertiary" />
        <input
          aria-label="筛选当前文件夹"
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && filter !== '') {
              event.preventDefault();
              event.stopPropagation();
              setFilter('');
            }
          }}
          placeholder="筛选这一层的文件夹"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="min-h-[40px] min-w-0 flex-1 bg-transparent text-body text-primary outline-none placeholder:text-tertiary md:min-h-[30px] [&::-webkit-search-cancel-button]:hidden"
        />
      </div>

      <div
        ref={listRef}
        tabIndex={-1}
        aria-label="文件夹"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5 outline-none"
        onKeyDown={onListKeyDown}
      >
        {listing.isError ? (
          <div className="p-1.5">
            <Notice tone="danger" variant="box">
              打不开这个文件夹：{(listing.error as Error).message}
            </Notice>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className="min-h-[36px] rounded-sm border border-hair px-2.5 text-meta text-secondary hover:border-strong hover:text-primary"
                onClick={() => void listing.refetch()}
              >
                重试
              </button>
              <button
                type="button"
                data-testid="picker-reset"
                className="min-h-[36px] rounded-sm px-2.5 text-meta text-link hover:underline"
                onClick={() => go('')}
              >
                回到起点
              </button>
            </div>
          </div>
        ) : null}

        {!current && listing.isPending ? (
          <div aria-hidden className="space-y-1 px-0.5 pt-0.5">
            {[0, 1, 2].map((key) => (
              <div key={key} className="h-9 animate-pulse rounded-sm bg-card-raised/60" />
            ))}
          </div>
        ) : null}
        {!current && listing.isPending ? (
          <p className="sr-only" role="status">
            正在读取文件夹
          </p>
        ) : null}

        {current ? (
          <>
            {shown.map((entry) => (
              <button
                key={entry.path}
                type="button"
                data-picker-row
                data-picker-name={entry.name}
                className={ROW}
                onClick={() => go(entry.path)}
              >
                <Icon name="folder" size={16} className="shrink-0 text-tertiary" />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.isGit ? (
                  <span className="shrink-0 font-mono text-meta text-tertiary" title="git 仓库" aria-label="git 仓库">
                    ⎇
                  </span>
                ) : null}
                <Icon name="chevron-right" size={14} className="shrink-0 text-tertiary/50" />
              </button>
            ))}

            {truncated ? (
              <p className="px-3 py-2 text-meta text-tertiary" data-testid="picker-truncated">
                还有 {entries.length - ENTRY_LIMIT} 个文件夹没显示，用上面的筛选找。
              </p>
            ) : null}

            {entries.length === 0 ? (
              <div className="px-3 py-4 text-meta text-tertiary">
                {filter.trim() !== '' ? (
                  <p>没有匹配的文件夹。</p>
                ) : hiddenCount > 0 ? (
                  <p>这一层只有点开头的文件夹。</p>
                ) : (
                  <p>这个文件夹里没有子文件夹。</p>
                )}
                {filter.trim() === '' ? (
                  <button
                    type="button"
                    className="mt-2 flex min-h-[36px] items-center gap-1 rounded-sm text-link hover:underline"
                    onClick={() => openNaming()}
                  >
                    <Icon name="plus" size={12} />
                    在这里新建文件夹
                  </button>
                ) : null}
              </div>
            ) : null}

            {offerCreate ? (
              <button
                type="button"
                className={`${ROW} mt-1 text-link`}
                onClick={() => openNaming(filter.trim())}
              >
                <Icon name="plus" size={14} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">新建文件夹 “{filter.trim()}”</span>
              </button>
            ) : null}

            {hiddenCount > 0 && filter === '' ? (
              <div className="mt-1 flex items-center justify-between gap-2 border-t border-hair px-2 py-1 text-meta text-tertiary">
                <span className="min-w-0 truncate">隐藏了 {hiddenCount} 个点开头的文件夹</span>
                <button
                  type="button"
                  aria-pressed={showHidden}
                  className="min-h-[36px] shrink-0 rounded-sm px-1.5 text-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                  onClick={() => setShowHidden((value) => !value)}
                >
                  {showHidden ? '收起' : '显示'}
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {current && offerManaged ? (
        <div data-testid="picker-managed" className="shrink-0 border-t border-hair bg-canvas/40 px-2.5 py-1">
          <button
            type="button"
            className="flex min-h-[36px] w-full items-center gap-1.5 rounded-sm text-meta text-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-40"
            disabled={createManaged.isPending}
            onClick={() => createManaged.mutate()}
          >
            <Icon name="plus" size={12} className="shrink-0" />
            <span className="min-w-0 truncate">
              {createManaged.isPending
                ? '正在创建项目文件夹…'
                : `创建项目文件夹 agent-hub-workspaces/${managed?.slice((managedParent?.length ?? 0) + 1)}`}
            </span>
          </button>
        </div>
      ) : null}

      {createManaged.error ? (
        <div className="shrink-0 px-2.5 py-1">
          <Notice tone="danger" variant="box">
            创建托管文件夹失败：{(createManaged.error as Error).message}
          </Notice>
        </div>
      ) : null}

      <footer className="shrink-0 border-t border-hair bg-panel px-2.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5 md:pb-2">
        <p
          data-testid="picker-path"
          title={current?.path}
          className="mb-1 line-clamp-3 break-all font-mono text-[11px] leading-4 text-secondary md:line-clamp-2"
        >
          {current?.path ?? ''}
        </p>
        <p className="mb-1.5 text-[11px] leading-4 text-tertiary">点文件夹进入；选好后按「选此文件夹」</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={`${QUIET} flex items-center gap-1 border border-hair disabled:opacity-40`}
            disabled={!current || naming !== null}
            onClick={() => openNaming()}
          >
            <Icon name="plus" size={13} />
            新建文件夹
          </button>
          <button
            type="button"
            className="min-h-[44px] flex-1 shrink-0 rounded-sm bg-action px-4 text-meta text-action-fg hover:bg-action/90 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-[34px]"
            disabled={!current}
            onClick={choose}
          >
            选此文件夹
          </button>
        </div>
      </footer>
      </section>
    </>
  );
  return narrow ? createPortal(panel, document.body) : panel;
}
