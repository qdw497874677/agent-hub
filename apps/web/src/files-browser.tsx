import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { filesApi, RequestFailed, type FileEntryDto } from './api.ts';
import { crumbs, decodeText, GIT_LABEL, humanSize, languageOf, touches, watchPaths } from './files-core.ts';
import 'diff2html/bundles/css/diff2html.min.css';

/**
 * 工作空间文件浏览（ADR 0025 · P1，只读）。全屏浮层：
 * - 手机：目录列表 → 点文件进全屏查看，左上「返回」；桌面：左树右看。
 * - 「文件 | 改动(n)」两页；改动的基准可切（会话开始 / 当前 HEAD）。
 * - 敏感文件默认藏起；打开要确认（服务端记审计）。被忽略的灰显但能展开；.git 不列。
 * - 不缓存（决定 8）：Worker 不在线就如实显示「Worker 离线」。
 */
type Base = 'session' | 'head';
type Opened = { path: string; confirmed: boolean; diff: boolean };

const fresh = { retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false } as const;
const sk = (sessionId: string) => ['files', sessionId] as const;

function problem(error: unknown): string {
  if (error instanceof RequestFailed && error.status === 503) return 'Worker 离线';
  return error instanceof Error ? error.message : String(error);
}

function useWide(): boolean {
  const query = '(min-width: 768px)';
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return wide;
}

export type FilesTab = 'files' | 'changes';

type Props = { sessionId: string; status: string } & (
  | { embedded?: false; onClose: () => void; tab?: undefined; onTab?: undefined }
  | { embedded: true; tab: FilesTab; onTab?: undefined; onClose?: undefined }
);

/** 浮层（详情 → 浏览文件）或嵌在会话「文件 / 改动」标签页里（embedded：页签由会话头部管）。 */
export function FilesBrowser({ sessionId, status, onClose, embedded, tab: fixedTab }: Props) {
  const client = useQueryClient();
  const wide = useWide();
  const [ownTab, setTab] = useState<FilesTab>('files');
  const tab = fixedTab ?? ownTab;
  const [base, setBase] = useState<Base>('session');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [opened, setOpened] = useState<Opened | null>(null);
  const [showSensitive, setShowSensitive] = useState(false);
  const [query, setQuery] = useState('');

  const changes = useQuery({ ...fresh, queryKey: [...sk(sessionId), 'changes', base], queryFn: () => filesApi.changes(sessionId, base) });
  const found = useQuery({ ...fresh, enabled: query.trim() !== '', queryKey: [...sk(sessionId), 'find', query], queryFn: () => filesApi.find(sessionId, query.trim()) });

  // 回合结束（状态变了）就刷新一遍：agent 刚改过文件
  const lastStatus = useRef(status);
  useEffect(() => {
    if (lastStatus.current !== status) void client.invalidateQueries({ queryKey: sk(sessionId) });
    lastStatus.current = status;
  }, [status, sessionId, client]);

  // 盯展开的目录和打开的文件（SSE）；断线重连后整体刷新一次（重订由 EventSource 重连完成）
  const paths = useMemo(() => watchPaths(expanded, opened?.path ?? null), [expanded, opened?.path]);
  const pathsKey = paths.join('\n');
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let first = true;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const connect = () => {
      if (disposed) return;
      source = new EventSource(filesApi.eventsUrl(sessionId, paths));
      source.addEventListener('ready', () => {
        if (!first) void client.invalidateQueries({ queryKey: sk(sessionId) });
        first = false;
      });
      source.addEventListener('changed', (message) => {
        const notice = JSON.parse((message as MessageEvent<string>).data) as { paths: string[]; reset?: boolean };
        if (notice.reset) {
          void client.invalidateQueries({ queryKey: sk(sessionId) });
          return;
        }
        void client.invalidateQueries({
          predicate: (q) => {
            const key = q.queryKey as unknown[];
            if (key[0] !== 'files' || key[1] !== sessionId) return false;
            if (key[2] === 'list') return touches(String(key[3]), notice.paths);
            if (key[2] === 'read' || key[2] === 'diff') return notice.paths.includes(String(key[3]));
            return key[2] === 'changes';
          }
        });
      });
      source.addEventListener('error', () => {
        if (source?.readyState !== EventSource.CLOSED) return;
        source.close();
        timer = setTimeout(connect, 3000);
      });
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      source?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, pathsKey, client]);

  const open = (entry: { path: string; sensitive?: boolean }, diff = false) => {
    if (entry.sensitive && !window.confirm(`「${entry.path}」可能含密钥或凭据。确定要打开吗？（会记入审计）`)) return;
    setOpened({ path: entry.path, confirmed: Boolean(entry.sensitive), diff });
  };
  const toggle = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) for (const p of [...next]) (p === path || p.startsWith(`${path}/`)) && next.delete(p);
      else next.add(path);
      return next;
    });

  const count = changes.data?.files.length;
  const showList = wide || opened === null;
  useEffect(() => setOpened(null), [tab]);
  const showHeader = !embedded || (!wide && opened !== null);
  return (
    <div className={embedded ? 'flex min-h-0 flex-1 flex-col bg-canvas' : 'fixed inset-0 z-50 flex flex-col bg-canvas'} role={embedded ? 'tabpanel' : 'dialog'} aria-label="工作空间文件" data-testid={embedded ? `files-panel-${tab}` : 'files-browser'}>
      {showHeader ? <header className="flex shrink-0 items-center gap-2 border-b border-hair px-3 py-2">
        {!wide && opened ? (
          <button className="text-sub text-secondary" onClick={() => setOpened(null)} data-testid="files-back">‹ 返回</button>
        ) : (
          <div className="flex gap-1" role="tablist">
            {(['files', 'changes'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                className={`rounded px-2 py-1 text-sub ${tab === t ? 'bg-card-raised text-primary' : 'text-tertiary'}`} data-testid={`files-tab-${t}`}>
                {t === 'files' ? '文件' : `改动${count === undefined ? '' : `(${count})`}`}
              </button>
            ))}
          </div>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-meta text-tertiary">{opened && !wide ? opened.path : ''}</span>
        {onClose ? <button className="px-2 text-head text-secondary" onClick={onClose} aria-label="关闭" data-testid="files-close">×</button> : null}
      </header> : null}
      <div className="flex min-h-0 flex-1">
        {showList ? (
          <aside className={`flex min-h-0 flex-col ${wide ? 'w-80 shrink-0 border-r border-hair' : 'flex-1'}`}>
            {tab === 'files' ? (
              <>
                <div className="flex items-center gap-2 border-b border-hair px-3 py-2">
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="找文件…" className="min-w-0 flex-1 rounded bg-card px-2 py-1 text-sub outline-none" data-testid="files-find" />
                  <label className="flex shrink-0 items-center gap-1 text-meta text-tertiary">
                    <input type="checkbox" checked={showSensitive} onChange={(e) => setShowSensitive(e.target.checked)} data-testid="files-show-sensitive" />
                    敏感
                  </label>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto py-1" data-testid="files-tree">
                  {query.trim() !== '' ? (
                    found.error ? <p className="px-3 text-meta text-rust">{problem(found.error)}</p> :
                    (found.data ?? []).map((p) => (
                      <button key={p} className="block w-full truncate px-3 py-1.5 text-left font-mono text-sub text-secondary hover:bg-card" onClick={() => open({ path: p, sensitive: /(^|\/)(\.env|id_rsa|id_ed25519)|\.(pem|key|p12)$/.test(p) })}>{p}</button>
                    ))
                  ) : (
                    <Directory sessionId={sessionId} path="" depth={0} expanded={expanded} toggle={toggle} open={open} showSensitive={showSensitive} selected={opened?.path ?? null} />
                  )}
                </div>
              </>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto" data-testid="changes-list">
                <div className="flex items-center gap-2 border-b border-hair px-3 py-2 text-meta text-tertiary">
                  对比
                  <select value={base} onChange={(e) => setBase(e.target.value as Base)} className="rounded bg-card px-1 py-0.5 text-sub text-secondary" data-testid="changes-base">
                    <option value="session">会话开始时</option>
                    <option value="head">当前 HEAD</option>
                  </select>
                  {changes.data?.commit ? <span className="font-mono">{changes.data.commit.slice(0, 8)}</span> : null}
                </div>
                {changes.error ? <p className="px-3 py-2 text-meta text-rust" data-testid="files-error">{problem(changes.error)}</p> : null}
                {changes.data?.files.length === 0 ? <p className="px-3 py-2 text-meta text-tertiary">没有改动</p> : null}
                {changes.data?.files.map((f) => (
                  <button key={f.path} onClick={() => open({ path: f.path }, true)} data-testid="change-row"
                    className={`flex w-full items-baseline gap-2 px-3 py-2 text-left hover:bg-card ${opened?.path === f.path ? 'bg-card' : ''}`}>
                    <span className="w-3 shrink-0 font-mono text-meta text-accent">{GIT_LABEL[f.status] ?? '?'}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-sub text-secondary">{f.path}</span>
                    <span className="shrink-0 font-mono text-meta text-sage">+{f.additions}</span>
                    <span className="shrink-0 font-mono text-meta text-rust">−{f.deletions}</span>
                  </button>
                ))}
              </div>
            )}
          </aside>
        ) : null}
        {wide || opened ? (
          <main className="min-w-0 flex-1 overflow-auto">
            {opened ? (
              opened.diff ? <DiffView sessionId={sessionId} path={opened.path} base={base} wide={wide} /> :
              <FileView sessionId={sessionId} opened={opened} wide={wide} onCrumb={(p) => { setExpanded((s) => new Set([...s, ...crumbs(p).map((c) => c.path)])); setOpened(null); }} />
            ) : (
              <p className="p-6 text-sub text-tertiary">选一个文件查看</p>
            )}
          </main>
        ) : null}
      </div>
    </div>
  );
}

function Directory(props: { sessionId: string; path: string; depth: number; expanded: Set<string>; toggle: (p: string) => void; open: (e: FileEntryDto) => void; showSensitive: boolean; selected: string | null }) {
  const { sessionId, path, depth } = props;
  const page = useQuery({ ...fresh, queryKey: [...sk(sessionId), 'list', path], queryFn: () => filesApi.list(sessionId, path) });
  if (page.isPending) return <p className="py-1 text-meta text-tertiary" style={{ paddingLeft: 12 + depth * 14 }}>…</p>;
  if (page.error) return <p className="py-1 text-meta text-rust" style={{ paddingLeft: 12 + depth * 14 }} data-testid="files-error">{problem(page.error)}</p>;
  const entries = page.data.entries.filter((e) => props.showSensitive || !e.sensitive);
  return (
    <>
      {entries.map((e) => {
        const isDir = e.type === 'dir';
        const isOpen = isDir && props.expanded.has(e.path);
        return (
          <div key={e.path}>
            <button onClick={() => (isDir ? props.toggle(e.path) : props.open(e))} data-testid="file-row" data-path={e.path}
              className={`flex w-full items-baseline gap-1.5 py-1.5 pr-3 text-left hover:bg-card ${props.selected === e.path ? 'bg-card' : ''} ${e.ignored ? 'opacity-50' : ''}`}
              style={{ paddingLeft: 12 + depth * 14 }}>
              <span className="w-3 shrink-0 text-meta text-tertiary">{isDir ? (isOpen ? '▾' : '▸') : ''}</span>
              <span className={`min-w-0 flex-1 truncate text-sub ${isDir ? 'text-primary' : 'text-secondary'}`}>{e.name}{e.type === 'symlink' ? ' ↗' : ''}</span>
              {e.sensitive ? <span className="shrink-0 text-meta text-accent" title="敏感文件">🔒</span> : null}
              {e.git ? <span className="shrink-0 font-mono text-meta text-accent">{GIT_LABEL[e.git] ?? ''}</span> : null}
            </button>
            {isOpen ? <Directory {...props} path={e.path} depth={depth + 1} /> : null}
          </div>
        );
      })}
      {page.data.truncated ? <p className="py-1 text-meta text-tertiary" style={{ paddingLeft: 12 + depth * 14 }}>只列出前 1000 项，用上面的搜索找其余文件</p> : null}
      {entries.length === 0 && depth === 0 ? <p className="px-3 py-1 text-meta text-tertiary">空目录</p> : null}
    </>
  );
}

function FileView({ sessionId, opened, wide, onCrumb }: { sessionId: string; opened: Opened; wide: boolean; onCrumb: (p: string) => void }) {
  const file = useQuery({ ...fresh, queryKey: [...sk(sessionId), 'read', opened.path, opened.confirmed], queryFn: () => filesApi.read(sessionId, opened.path, opened.confirmed) });
  const text = useMemo(() => (file.data && !file.data.binary ? decodeText(file.data.data) : null), [file.data]);
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    setHtml(null);
    const lang = languageOf(opened.path);
    if (text === null || !lang || text.length > 300_000) return;
    let live = true;
    // Shiki 按需加载语言 / 主题：首次打开某种语言才下载它的语法
    void import('shiki').then(({ codeToHtml }) => codeToHtml(text, { lang, theme: 'github-dark-dimmed' })).then((h) => live && setHtml(h), () => undefined);
    return () => { live = false; };
  }, [text, opened.path]);
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 border-b border-hair px-3 py-2 text-meta text-tertiary">
        {wide ? crumbs(opened.path).map((c, i, all) => (
          <span key={c.path} className="flex items-center gap-1">
            {i < all.length - 1 ? <button className="hover:text-primary" onClick={() => onCrumb(c.path)}>{c.name}</button> : <span className="font-mono text-secondary">{c.name}</span>}
            {i < all.length - 1 ? <span>/</span> : null}
          </span>
        )) : null}
        <span className="ml-auto flex items-center gap-3">
          {file.data ? <span>{humanSize(file.data.size)}</span> : null}
          <a href={filesApi.downloadUrl(sessionId, opened.path, opened.confirmed)} download className="text-accent" data-testid="file-download">下载</a>
        </span>
      </div>
      {file.isPending ? <p className="p-4 text-meta text-tertiary">读取中…</p> : null}
      {file.error ? <p className="p-4 text-sub text-rust" data-testid="files-error">{problem(file.error)}</p> : null}
      {file.data?.binary ? <p className="p-4 text-sub text-tertiary">二进制文件，不预览——可以下载</p> : null}
      {file.data?.truncated ? <p className="px-3 pt-2 text-meta text-accent">文件超过 1 MB，只显示前 1 MB</p> : null}
      {text !== null ? (
        html ? <div className="files-code overflow-x-auto p-3 text-sub [&_pre]:!bg-transparent" data-testid="file-content" dangerouslySetInnerHTML={{ __html: html }} /> :
        <pre className="overflow-x-auto whitespace-pre p-3 font-mono text-sub text-secondary" data-testid="file-content">{text}</pre>
      ) : null}
    </div>
  );
}

function DiffView({ sessionId, path, base, wide }: { sessionId: string; path: string; base: Base; wide: boolean }) {
  const diff = useQuery({ ...fresh, queryKey: [...sk(sessionId), 'diff', path, base], queryFn: () => filesApi.diff(sessionId, path, base) });
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    setHtml(null);
    if (!diff.data || diff.data.patch === '') return;
    let live = true;
    const patch = diff.data.patch;
    void import('diff2html').then((d2h) => live && setHtml(d2h.html(patch, { outputFormat: wide ? 'side-by-side' : 'line-by-line', drawFileList: false, matching: 'lines', colorScheme: 'dark' as never })));
    return () => { live = false; };
  }, [diff.data, wide]);
  return (
    <div data-testid="diff-view">
      {diff.isPending ? <p className="p-4 text-meta text-tertiary">读取中…</p> : null}
      {diff.error ? <p className="p-4 text-sub text-rust" data-testid="files-error">{problem(diff.error)}</p> : null}
      {diff.data?.binary ? <p className="p-4 text-sub text-tertiary">二进制文件有改动</p> : null}
      {diff.data?.truncated ? <p className="px-3 pt-2 text-meta text-accent">diff 超过 512 KB，只显示前一部分</p> : null}
      {diff.data && diff.data.patch === '' && !diff.data.binary ? <p className="p-4 text-sub text-tertiary">没有差异</p> : null}
      {html ? <div className="files-diff text-meta" dangerouslySetInnerHTML={{ __html: html }} /> : null}
    </div>
  );
}

