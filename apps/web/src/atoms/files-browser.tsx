import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { filesApi, RequestFailed, type FileEntryDto } from '../shell/api.ts';
import { crumbs, FILES_QUERY, filesErrorText, filesRefetch, shown, decodeText, GIT_LABEL, humanSize, languageOf, shortPath, touches, watchPaths } from './files-core.ts';
import { filesInvalidationKeys, filesKeys, type FilesKeys } from '../shell/query-keys.ts';
import 'diff2html/bundles/css/diff2html.min.css';

/**
 * 工作空间文件浏览（ADR 0025 · P1，只读）。嵌在会话的「文件 / 改动」标签页里（页签由会话头部管）：
 * - 手机：目录列表 → 点文件进全屏查看，左上「返回」；桌面：左树右看。
 * - 「文件 | 改动(n)」两页；改动的基准可切（会话开始 / 当前 HEAD）。
 * - 敏感文件默认藏起；打开要确认（服务端记审计）。被忽略的灰显但能展开；.git 不列。
 * - 不缓存（决定 8）：机器不在线就如实显示「机器离线」。
 */
type Base = string; // 'session' | 'head' | 'turn' | 'turn:<n>'
type Opened = { path: string; confirmed: boolean; diff: boolean; line?: number | null };
/** 从对话里的工具路径跳过来：打开这个文件，知道行号就滚到那一行。nonce 变了就再跳一次。 */
export type Reveal = { path: string; line: number | null; nonce: number };

const fresh = FILES_QUERY;

function problem(error: unknown): string {
  if (error instanceof RequestFailed) return filesErrorText(error.status, error.detail.message);
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

type Props = {
  sessionId: string;
  workspaceId: string | null;
  status: string;
  tab: FilesTab;
  reveal?: Reveal | null;
  base?: { base: string; nonce: number } | null;
};

/** 会话「文件 / 改动」标签页的内容（详情 → 浏览文件 也是切到这里，旧的全屏浮层已去掉）。 */
export function FilesBrowser({ sessionId, workspaceId, status, tab, reveal = null, base: wanted = null }: Props) {
  const client = useQueryClient();
  const keys = filesKeys(workspaceId, sessionId);
  const wide = useWide();
  const [base, setBase] = useState<Base>(wanted?.base ?? 'session');
  // 从聊天里「改了 N 个文件」点进来：切到那一轮
  useEffect(() => {
    if (wanted) setBase(wanted.base);
  }, [wanted?.nonce]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [opened, setOpened] = useState<Opened | null>(null);
  const [showSensitive, setShowSensitive] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!reveal) return;
    const sensitive = /(^|\/)(\.env|id_rsa|id_ed25519)|\.(pem|key|p12)$/.test(reveal.path);
    if (sensitive && !window.confirm(`「${reveal.path}」可能含密钥或凭据。确定要打开吗？（会记入审计）`)) return;
    setQuery('');
    setExpanded((current) => new Set([...current, ...crumbs(reveal.path).slice(0, -1).map((c) => c.path)]));
    setOpened({ path: reveal.path, confirmed: sensitive, diff: false, line: reveal.line });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce]);

  const changes = useQuery({ ...fresh, queryKey: keys.changes(base), queryFn: () => filesApi.changes(sessionId, base) });
  const turns = useQuery({ ...fresh, queryKey: keys.turns(), queryFn: () => filesApi.turns(sessionId) });
  const context = useQuery({ queryKey: keys.context(), queryFn: () => filesApi.context(sessionId), staleTime: 15_000 });
  const others = context.data?.otherProjectSessions ?? 0;
  const found = useQuery({ ...fresh, enabled: query.trim() !== '', queryKey: keys.find(query.trim()), queryFn: () => filesApi.find(sessionId, query.trim()) });

  // 回合结束（状态变了）就刷新一遍：agent 刚改过文件
  const lastStatus = useRef(status);
  useEffect(() => {
    if (lastStatus.current === status) return;
    const keysNow = filesKeys(workspaceId, sessionId);
    for (const prefix of filesInvalidationKeys(keysNow)) {
      void client.invalidateQueries({ queryKey: prefix }, { cancelRefetch: false });
    }
    lastStatus.current = status;
  }, [status, sessionId, workspaceId, client]);

  // 盯展开的目录和打开的文件（SSE）；断线重连后整体刷新一次（重订由 EventSource 重连完成）
  const paths = useMemo(() => watchPaths(expanded, opened?.path ?? null), [expanded, opened?.path]);
  const pathsKey = paths.join('\n');
  const subscribed = useRef(false);
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    // 事件源仍按会话订阅（服务端只知道会话的 cwd），但失效前缀必须跟查询 key 的归属一致：
    // 目录维度的缓存按工作空间存，只失效 sessionId 前缀会让实时更新悄悄失效。
    const keys = filesKeys(workspaceId, sessionId);
    const dir = keys.dir[1];
    const inScope = (key: readonly unknown[]) => key[0] === 'files' && (key[1] === dir || key[1] === sessionId);
    const invalidateAll = (options?: { cancelRefetch: boolean }) => {
      for (const prefix of filesInvalidationKeys(keys)) {
        void client.invalidateQueries({ queryKey: prefix }, options);
      }
    };
    let first = true;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const connect = () => {
      if (disposed) return;
      source = new EventSource(filesApi.eventsUrl(sessionId, paths));
      source.addEventListener('ready', () => {
        if (!first) invalidateAll({ cancelRefetch: false });
        // 换订阅（展开/返回）时旧连接已断、新连接未就绪，中间的改动会漏：补拉一次被盯的目录。
        // 返回时列表往往已经在读旧目录，不取消的话这次补拉会被丢掉。
        else if (subscribed.current) void client.invalidateQueries({ predicate: (q) => { const k = q.queryKey as unknown[]; return inScope(k) && k[2] === 'list' && paths.includes(String(k[3])); } }, filesRefetch('list'));
        first = false;
        subscribed.current = true;
      });
      source.addEventListener('changed', (message) => {
        const notice = JSON.parse((message as MessageEvent<string>).data) as { paths: string[]; reset?: boolean };
        if (notice.reset) {
          invalidateAll({ cancelRefetch: false });
          return;
        }
        const touched = (q: { queryKey: readonly unknown[] }, kinds: readonly string[]) => {
          const key = q.queryKey;
          if (!inScope(key) || !kinds.includes(String(key[2]))) return false;
          if (key[2] === 'list') return touches(String(key[3]), notice.paths);
          if (key[2] === 'read' || key[2] === 'diff') return notice.paths.includes(String(key[3]));
          return key[2] === 'changes';
        };
        void client.invalidateQueries({ predicate: (q) => touched(q, ['list']) }, filesRefetch('list'));
        void client.invalidateQueries({ predicate: (q) => touched(q, ['read', 'diff', 'changes']) }, filesRefetch('diff'));
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
  }, [sessionId, workspaceId, pathsKey, client]);

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

  const changed = shown(changes);
  const showList = wide || opened === null;
  const root = context.data?.root;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas" role="tabpanel" aria-label="工作空间文件" data-testid={`files-panel-${tab}`}>
      {others > 0 ? (
        <p data-testid="files-other-projects" className="shrink-0 border-b border-hair px-3 py-1 text-meta text-rust">
          ⚠ 其他项目有 {others} 个会话也在这个工作空间里干活，这里的改动可能不全是本会话的
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1">
        {showList ? (
          <aside className={`flex min-h-0 flex-col ${wide ? 'w-80 shrink-0 border-r border-hair' : 'flex-1'}`}>
            {tab === 'files' ? (
              <>
                <div className="flex items-center gap-2 px-3 py-2">
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="找文件…" className="min-w-0 flex-1 rounded bg-card px-2 py-1 text-sub outline-none" data-testid="files-find" />
                  <label className="flex shrink-0 items-center gap-1 text-meta text-tertiary">
                    <input type="checkbox" checked={showSensitive} onChange={(e) => setShowSensitive(e.target.checked)} data-testid="files-show-sensitive" />
                    敏感
                  </label>
                </div>
                <RootPath root={root} wide={wide} />
                <div className="min-h-0 flex-1 overflow-y-auto py-1" data-testid="files-tree">
                  {query.trim() !== '' ? (
                    found.error ? <p className="px-3 text-meta text-rust">{problem(found.error)}</p> :
                    (shown(found) ?? []).map((p) => (
                      <button key={p} className="block w-full truncate px-3 py-1.5 text-left font-mono text-sub text-secondary hover:bg-card" onClick={() => open({ path: p, sensitive: /(^|\/)(\.env|id_rsa|id_ed25519)|\.(pem|key|p12)$/.test(p) })}>{p}</button>
                    ))
                  ) : (
                    <Directory sessionId={sessionId} keys={keys} path="" depth={0} expanded={expanded} toggle={toggle} open={open} showSensitive={showSensitive} selected={opened?.path ?? null} />
                  )}
                </div>
              </>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto" data-testid="changes-list">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-meta text-tertiary">
                  对比
                  <select value={base} onChange={(e) => setBase(e.target.value as Base)} className="rounded bg-card px-1 py-0.5 text-sub text-secondary" data-testid="changes-base">
                    <option value="session">整个会话</option>
                    <option value="head">对比 HEAD</option>
                    {(turns.data?.length ?? 0) > 0 ? <option value="turn">本轮（第 {turns.data!.at(-1)!.turn} 轮）</option> : null}
                    {[...(turns.data ?? [])].reverse().slice(1).map((t) => (
                      <option key={t.turn} value={`turn:${t.turn}`}>第 {t.turn} 轮{t.files !== null ? ` · ${t.files} 个文件` : ''}</option>
                    ))}
                  </select>
                  {base.startsWith('turn') && changed?.target === null ? <span className="text-accent" data-testid="turn-live">进行中</span> : null}
                  {changed?.commit ? <span className="font-mono">{changed.commit.slice(0, 8)}</span> : null}
                </div>
                <RootPath root={root} wide={wide} />
                {changes.error ? <p className="px-3 py-2 text-meta text-rust" data-testid="files-error">{problem(changes.error)}</p> : null}
                {changed?.files.length === 0 ? <p className="px-3 py-2 text-meta text-tertiary">没有改动</p> : null}
                {changed?.files.map((f) => (
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
              opened.diff ? <DiffView sessionId={sessionId} keys={keys} path={opened.path} base={base} wide={wide} root={root} onBack={() => setOpened(null)} /> :
              <FileView sessionId={sessionId} keys={keys} opened={opened} wide={wide} root={root} onBack={() => setOpened(null)} onCrumb={(p) => { setExpanded((s) => new Set([...s, ...crumbs(p).map((c) => c.path)])); setOpened(null); }} />
            ) : (
              <p className="p-6 text-sub text-tertiary">选一个文件查看</p>
            )}
          </main>
        ) : null}
      </div>
    </div>
  );
}

function Directory(props: { sessionId: string; keys: FilesKeys; path: string; depth: number; expanded: Set<string>; toggle: (p: string) => void; open: (e: FileEntryDto) => void; showSensitive: boolean; selected: string | null }) {
  const { sessionId, keys, path, depth } = props;
  const page = useQuery({ ...fresh, queryKey: keys.list(path), queryFn: () => filesApi.list(sessionId, path) });
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

/** 工作空间根路径：文件路径都相对它，太长时只留末尾几段（全文在 title 里，手机也撑不破布局）。 */
function RootPath({ root, wide }: { root: string | undefined; wide: boolean }) {
  if (!root) return null;
  return (
    <p data-testid="files-root" title={root} className="min-w-0 truncate border-b border-hair px-3 py-1 font-mono text-meta text-tertiary">
      {shortPath(root, wide ? 120 : 30)}
    </p>
  );
}

/**
 * 预览顶栏：完整相对路径是这一栏最显眼的信息。
 * 桌面每一段仍可点回目录；手机放不下面包屑，直接给整条路径，并在下面一行说明根在哪。
 */
function PathBar({ path, root, wide, download, size, onCrumb, onBack }: {
  path: string;
  root: string | undefined;
  wide: boolean;
  download?: string;
  size?: number;
  onCrumb?: (p: string) => void;
  onBack?: () => void;
}) {
  const trail = crumbs(path).slice(1);
  return (
    <div className="flex shrink-0 flex-col gap-0.5 border-b border-hair px-3 py-2" data-testid="file-header">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {!wide && onBack ? (
          <button className="shrink-0 text-sub text-secondary hover:text-primary" onClick={onBack} data-testid="files-back">‹ 返回</button>
        ) : null}
        {wide && onCrumb ? (
          <span className="flex min-w-0 flex-1 select-text flex-wrap items-baseline font-mono text-sub leading-tight" title={path} data-testid="file-path">
            <button className="shrink-0 text-tertiary hover:text-primary" onClick={() => onCrumb('')} title="工作空间根目录" data-testid="file-crumb">根目录</button>
            {trail.map((c, i) => (
              <span key={c.path} className="flex min-w-0 items-baseline">
                <span aria-hidden className="px-0.5 text-tertiary">/</span>
                {i < trail.length - 1 ? (
                  <button className="min-w-0 truncate max-w-[18rem] text-secondary hover:text-primary" onClick={() => onCrumb(c.path)} data-testid="file-crumb">{c.name}</button>
                ) : (
                  <span className="min-w-0 truncate text-primary" title={path}>{c.name}</span>
                )}
              </span>
            ))}
          </span>
        ) : (
          <span className="min-w-0 flex-1 select-text truncate font-mono text-sub leading-tight text-primary" title={path} data-testid="file-path">{path}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-3 text-meta text-tertiary">
          {size !== undefined ? <span className="font-mono">{humanSize(size)}</span> : null}
          {download ? <a href={download} download className="text-accent" data-testid="file-download">下载</a> : null}
        </span>
      </div>
      {root ? (
        <p className="min-w-0 truncate font-mono text-meta text-tertiary" title={root} data-testid="file-root">位于 {shortPath(root, wide ? 96 : 26)}</p>
      ) : null}
    </div>
  );
}

function FileView({ sessionId, keys, opened, wide, root, onBack, onCrumb }: { sessionId: string; keys: FilesKeys; opened: Opened; wide: boolean; root: string | undefined; onBack: () => void; onCrumb: (p: string) => void }) {
  const file = useQuery({ ...fresh, queryKey: keys.read(opened.path, opened.confirmed), queryFn: () => filesApi.read(sessionId, opened.path, opened.confirmed) });
  const data = shown(file);
  const text = useMemo(() => (data && !data.binary ? decodeText(data.data) : null), [data]);
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
  const content = useRef<HTMLDivElement>(null);
  const line = opened.line ?? null;
  useEffect(() => {
    const root = content.current;
    if (!root || line === null || text === null) return;
    root.querySelectorAll('[data-target-line]').forEach((el) => el.removeAttribute('data-target-line'));
    const target = root.querySelectorAll('.line')[line - 1];
    if (!target) return;
    target.setAttribute('data-target-line', String(line));
    target.scrollIntoView({ block: 'center' });
  }, [line, text, html]);
  return (
    <div className="flex min-h-full flex-col">
      <PathBar path={opened.path} root={root} wide={wide} size={data?.size} download={filesApi.downloadUrl(sessionId, opened.path, opened.confirmed)} onCrumb={onCrumb} onBack={onBack} />
      {file.isPending ? <p className="p-4 text-meta text-tertiary">读取中…</p> : null}
      {file.error ? <p className="p-4 text-sub text-rust" data-testid="files-error">{problem(file.error)}</p> : null}
      {data?.binary ? <p className="p-4 text-sub text-tertiary">二进制文件，不预览——可以下载</p> : null}
      {data?.truncated ? <p className="px-3 pt-2 text-meta text-accent">文件超过 1 MB，只显示前 1 MB</p> : null}
      {text !== null ? (
        <div ref={content} className="[&_[data-target-line]]:bg-accent/20" data-line={line ?? undefined}>
          {html ? <div className="files-code overflow-x-auto p-3 text-sub [&_pre]:!bg-transparent" data-testid="file-content" dangerouslySetInnerHTML={{ __html: html }} /> :
          <pre className="overflow-x-auto whitespace-pre p-3 font-mono text-sub text-secondary" data-testid="file-content">{line === null ? text : text.split('\n').map((l, i) => <span key={i} className="line">{l}{'\n'}</span>)}</pre>}
        </div>
      ) : null}
    </div>
  );
}

function DiffView({ sessionId, keys, path, base, wide, root, onBack }: { sessionId: string; keys: FilesKeys; path: string; base: Base; wide: boolean; root: string | undefined; onBack: () => void }) {
  const diff = useQuery({ ...fresh, queryKey: keys.diff(path, base), queryFn: () => filesApi.diff(sessionId, path, base) });
  const data = shown(diff);
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    setHtml(null);
    if (!data || data.patch === '') return;
    let live = true;
    const patch = data.patch;
    void import('diff2html').then((d2h) => live && setHtml(d2h.html(patch, { outputFormat: wide ? 'side-by-side' : 'line-by-line', drawFileList: false, matching: 'lines', colorScheme: 'dark' as never })));
    return () => { live = false; };
  }, [data, wide]);
  return (
    <div data-testid="diff-view">
      <PathBar path={path} root={root} wide={wide} onBack={onBack} />
      {diff.isPending ? <p className="p-4 text-meta text-tertiary">读取中…</p> : null}
      {diff.error ? <p className="p-4 text-sub text-rust" data-testid="files-error">{problem(diff.error)}</p> : null}
      {data?.binary ? <p className="p-4 text-sub text-tertiary">二进制文件有改动</p> : null}
      {data?.truncated ? <p className="px-3 pt-2 text-meta text-accent">diff 超过 512 KB，只显示前一部分</p> : null}
      {data && data.patch === '' && !data.binary ? <p className="p-4 text-sub text-tertiary">没有差异</p> : null}
      {html && data ? <div className="files-diff text-meta" dangerouslySetInnerHTML={{ __html: html }} /> : null}
    </div>
  );
}

