import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { currentTheme } from '../shell/theme.ts';
import { Notice } from './notice.tsx';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { filesApi, RequestFailed, type FileEntryDto, type FilesContextMemberDto } from '../shell/api.ts';
import { clampListWidth, compareScope, crumbs, FILES_LIST_WIDTH_KEY, FILES_QUERY, filesErrorText, filesRefetch, readListWidth, shown, decodeText, GIT_LABEL, humanSize, languageOf, shortPath, touches, watchPaths, type CompareScope } from './files-core.ts';
import { filesInvalidationKeys, filesKeys, type FilesKeys } from '../shell/query-keys.ts';
import { inSelection, isWholeFileAddition, diffWindowRange, parsePatchLines, selectionRange, selectionRef, toggleLine, type DiffRow, type DiffSide, type LineSelection } from './diff-selection.ts';
import { ReviewEditor, ReviewPanel, useReview } from './review-panel.tsx';
import type { ReviewDraftDto, ReviewNoteDto } from '../shell/api/files.ts';
import { useAccount } from '../shell/auth.tsx';
import { readChangesPosition, storeChangesPosition } from './session-tabs.ts';
import { Dropdown, MenuItem } from './chat-blocks.tsx';
import type { PullRequestDto } from '../shell/api/git.ts';

/**
 * 工作目录文件浏览（ADR 0025 · P1，只读）。嵌在会话的「文件 / 改动」标签页里（页签由会话头部管）：
 * - 手机：目录列表 ↔ 全屏查看是可逆的两页，返回后列表的展开、滚动位置和刚看过的文件都还在；
 *   桌面：左树右看，右边没选东西时先说清在比什么。
 * - 「文件 | 改动(n)」两页；改动的范围可切（会话开始 / 当前 HEAD / 分支起点 / 已记录的回合）。
 *   这些范围都不是任意 Git 版本：前三者比当前工作树，回合比两个快照，正文顶栏一直写着在比什么。
 * - 敏感文件默认藏起；打开要确认（服务端记审计）。被忽略的灰显但能展开；.git 不列。
 * - 只取真正看过的那一个文件 / 那一段 diff，不预取兄弟文件，也不预取没选中的范围。
 * - 不缓存（决定 8）：机器不在线就如实显示「机器离线」。
 */
type Base = string; // 'session' | 'head' | 'branch' | 'turn' | 'turn:<n>'
type Opened = { path: string; confirmed: boolean; diff: boolean; line?: number | null; member?: string | null; review?: ReviewNoteDto; nonce?: number };
/** 刚看过的文件：从全屏回到列表时高亮它、把焦点还给它（TAB 的顺序不被打乱）。 */
type LastRead = { path: string; member: string | null };
/** 从对话里的工具路径跳过来：打开这个文件，知道行号就滚到那一行。nonce 变了就再跳一次。 */
export type Reveal = { path: string; line: number | null; nonce: number };
/** A new object represents a user navigation, even when clicking the same link again. */
export type ChangesJump = { base: string };

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
  /** 组合会话当前选中的成员工作空间；单仓不传。 */
  member?: string | null;
  status: string;
  tab: FilesTab;
  reveal?: Reveal | null;
  jump?: ChangesJump | null;
  /** diff 里选了行之后「引用到对话」：给回一句 `@path:start-end`。没接这个回调就不显示那个按钮。 */
  onQuote?: (ref: string) => void;
  /** 组合会话的仓库切换条，画在文件 / 改动页顶部。 */
  switcher?: ReactNode;
  /** 组合会话全部成员：改动页按仓库汇总。 */
  members?: readonly FilesContextMemberDto[];
  /** 并排工作区中，列表与正文顺序展示，给差异留足宽度。 */
  compact?: boolean;
  sourceControl?: {
    branch: string;
    taskId: string | null;
    prs: readonly PullRequestDto[];
    prsLoading: boolean;
    prsError: boolean;
    canOpenGit: boolean;
    onOpenGit: () => void;
    onRefresh: () => void;
  };
};

/** 会话「文件 / 改动」标签页的内容（详情 → 浏览文件 也是切到这里，旧的全屏浮层已去掉）。 */
export function FilesBrowser({ sessionId, workspaceId, member = null, status, tab, reveal = null, jump = null, onQuote, switcher = null, members = [], compact = false, sourceControl }: Props) {
  const client = useQueryClient();
  const keys = filesKeys(workspaceId, sessionId);
  const viewportWide = useWide();
  const wide = viewportWide && !compact;
  const accountId = useAccount()?.id ?? null;
  const review = useReview(sessionId, accountId, tab === 'changes');
  const [restored] = useState(() => tab === 'changes' ? readChangesPosition(sessionId) : null);
  const [base, setBase] = useState<Base>(restored?.base ?? 'session');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [opened, setOpened] = useState<Opened | null>(() => restored?.file ? { ...restored.file, confirmed: false, diff: true } : null);
  const [lastRead, setLastRead] = useState<LastRead | null>(restored?.file ?? null);
  const [showSensitive, setShowSensitive] = useState(false);
  const [query, setQuery] = useState('');
  const [sourceTab, setSourceTab] = useState<'changes' | 'pr'>('changes');
  const sourceMenuRef = useRef<HTMLButtonElement>(null);
  useEffect(() => setSourceTab('changes'), [sessionId]);
  const previousMember = useRef(member);

  useEffect(() => {
    const previous = previousMember.current;
    previousMember.current = member;
    // The first member can arrive asynchronously after the saved position has been restored.
    if (previous === member || (tab === 'changes' && previous === null)) return;
    setOpened(null);
    setLastRead(null);
    setExpanded(new Set(['']));
    setQuery('');
  }, [member, tab]);

  const appliedJump = useRef<ChangesJump | null>(null);
  useEffect(() => {
    if (!jump || appliedJump.current === jump) return;
    appliedJump.current = jump;
    setSourceTab('changes');
    if (jump.base !== base) {
      // A turn badge links to that turn's list, not the previous range's file.
      setOpened(null);
      setLastRead(null);
    }
    setBase(jump.base);
  }, [jump, base]);

  const openedPath = opened?.path;
  const openedMember = opened?.member ?? null;
  useEffect(() => {
    if (tab === 'changes') storeChangesPosition(sessionId, { base, file: openedPath ? { path: openedPath, member: openedMember } : null });
  }, [tab, sessionId, base, openedPath, openedMember]);

  useEffect(() => {
    if (!reveal) return;
    const sensitive = /(^|\/)(\.env|id_rsa|id_ed25519)|\.(pem|key|p12)$/.test(reveal.path);
    if (sensitive && !window.confirm(`「${reveal.path}」可能含密钥或凭据。确定要打开吗？（会记入审计）`)) return;
    setQuery('');
    setExpanded((current) => new Set([...current, ...crumbs(reveal.path).slice(0, -1).map((c) => c.path)]));
    setLastRead({ path: reveal.path, member });
    setOpened({ path: reveal.path, confirmed: sensitive, diff: false, line: reveal.line });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce]);

  // 文件页不看改动，只读当前文件；改动页才取改动列表和回合清单。离开就停，不预取别的范围。
  const changes = useQuery({ ...fresh, enabled: tab === 'changes', queryKey: keys.changes(base), queryFn: () => filesApi.changes(sessionId, base, member) });
  const aggregate = members.length > 1 && tab === 'changes';
  const groupedChanges = useQueries({
    queries: members.map((item) => ({
      ...fresh,
      enabled: aggregate,
      queryKey: keys.memberChanges(base, item.workspaceId),
      queryFn: () => filesApi.changes(sessionId, base, item.workspaceId)
    }))
  });
  const turns = useQuery({ ...fresh, enabled: tab === 'changes', queryKey: keys.turns(), queryFn: () => filesApi.turns(sessionId, member) });
  const context = useQuery({ queryKey: keys.context(), queryFn: () => filesApi.context(sessionId, member), staleTime: 15_000 });
  const others = context.data?.otherProjectSessions ?? 0;
  const found = useQuery({ ...fresh, enabled: query.trim() !== '', queryKey: keys.find(query.trim()), queryFn: () => filesApi.find(sessionId, query.trim(), member) });

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
    // 目录维度的缓存按工作目录存，只失效 sessionId 前缀会让实时更新悄悄失效。
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
      source = new EventSource(filesApi.eventsUrl(sessionId, paths, member));
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
  }, [sessionId, workspaceId, member, pathsKey, client]);

  const open = (entry: { path: string; sensitive?: boolean; member?: string | null }, diff = false) => {
    if (entry.sensitive && !window.confirm(`「${entry.path}」可能含密钥或凭据。确定要打开吗？（会记入审计）`)) return;
    setLastRead({ path: entry.path, member: entry.member ?? null });
    setOpened({ path: entry.path, confirmed: Boolean(entry.sensitive), diff, member: entry.member ?? null });
  };
  const activeMember = opened?.review ? opened.member ?? null : opened?.member ?? member;
  const activeKeys = filesKeys(activeMember ?? workspaceId, sessionId);
  const toggle = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) for (const p of [...next]) (p === path || p.startsWith(`${path}/`)) && next.delete(p);
      else next.add(path);
      return next;
    });

  const changed = shown(changes);
  // 列表标题和正文顶栏共用同一句说明：范围、基准的 sha、以及这个范围的边界。
  const info = {
    commit: changed?.commit,
    target: changed?.target,
    branch: changed?.branch,
    turn: changed?.turn,
    turnNumber: turns.data?.at(-1)?.turn ?? null,
    sessionBase: context.data?.sessionBase
  };
  const scope = useMemo(
    () => compareScope(base, info),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, info.commit, info.target, info.branch, info.turn, info.turnNumber, info.sessionBase]
  );
  /** 正在看 / 刚看过的文件：返回列表后它仍然高亮，读屏也知道「当前项」。 */
  const picked = opened ?? lastRead;
  const mark = (path: string, ws: string | null = member) => ({
    on: picked !== null && picked.path === path && (picked.member ?? member) === (ws ?? member),
    last: lastRead !== null && lastRead.path === path && (lastRead.member ?? member) === (ws ?? member)
  });
  const listRef = useRef<HTMLElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const backToRow = useRef(false);
  /** 手机从正文回列表：回的是同一页列表（展开、滚动都没丢），焦点落回刚看的那一行。 */
  const back = () => {
    if (opened === null) return;
    backToRow.current = true;
    setOpened(null);
  };
  const reading = opened !== null;
  useEffect(() => {
    if (opened !== null || !backToRow.current) return;
    backToRow.current = false;
    let tries = 0;
    const focusRow = () => {
      const row = listRef.current?.querySelector<HTMLElement>('[data-last-read="true"]');
      if (row) {
        // 只把焦点还给它，别再让浏览器为了「看见它」把整页带动一下：列表本来就停在那一页。
        row.focus({ preventScroll: true });
        return;
      }
      // 列表刚显示出来、行还没排好时再等几帧；确实找不到（例如目录被收起）就不抢焦点。
      if (tries++ < 6) window.requestAnimationFrame(focusRow);
    };
    window.requestAnimationFrame(focusRow);
  }, [opened]);
  // 手机上列表进正文时列表整个藏起来：焦点不能留在被藏起来的按钮上，交给正文的「返回」。
  useEffect(() => {
    if (!reading || wide) return;
    mainRef.current?.querySelector<HTMLElement>('[data-testid="files-back"]')?.focus({ preventScroll: true });
  }, [reading, wide, opened?.path, opened?.diff]);
  const root = context.data?.root;
  const [listWidth, setListWidth] = useState(() =>
    readListWidth(typeof window === 'undefined' ? null : window.localStorage.getItem(FILES_LIST_WIDTH_KEY))
  );
  const rememberWidth = (width: number) => {
    const next = clampListWidth(width);
    setListWidth(next);
    if (typeof window !== 'undefined') window.localStorage.setItem(FILES_LIST_WIDTH_KEY, String(next));
  };
  /** 拖左边框改列表宽度；松手才落盘（拖动中不写 localStorage，避免每次移动都同步写）。 */
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = listRef.current?.getBoundingClientRect().width ?? listWidth;
    const move = (moveEvent: PointerEvent) => setListWidth(clampListWidth(startWidth + moveEvent.clientX - startX));
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      if (listRef.current !== null) rememberWidth(listRef.current.getBoundingClientRect().width);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };
  const compactReader = !wide && reading && sourceTab === 'changes';
  const sourceMenu = sourceControl ? <div className="[&>div>button]:!h-[44px] [&>div>button]:!min-w-[44px]">
    <Dropdown label="源代码控制更多操作" icon="⋯" width="w-48" testId="source-control-menu" triggerRef={sourceMenuRef}>
      {(close) => <>
        <MenuItem title="刷新源代码控制" testId="source-control-refresh" className="min-h-[44px]" onClick={() => { close(); sourceControl.onRefresh(); requestAnimationFrame(() => sourceMenuRef.current?.focus()); }} />
        <MenuItem title="提交与推送…" className="min-h-[44px]" disabled={!sourceControl.canOpenGit} onClick={() => { close(); sourceControl.onOpenGit(); }} />
      </>}
    </Dropdown>
  </div> : null;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-canvas"
      role="tabpanel"
      aria-label="工作目录文件"
      data-testid={`files-panel-${tab}`}
      onKeyDown={(event) => {
        // 手机上「返回」也是 Esc：只在读正文时生效，桌面左右并排不需要。
        if (event.defaultPrevented || event.key !== 'Escape' || wide || opened === null || sourceTab !== 'changes') return;
        event.preventDefault();
        back();
      }}
    >
      {tab === 'changes' && sourceControl ? (
        <div data-testid="source-control-panel" className="shrink-0 border-b border-hair bg-canvas">
          {!compactReader ? <div className="flex min-w-0 items-center gap-2 px-3">
            <div className="min-w-0 flex-1 py-2">
              <p className="text-sub font-medium text-primary">源代码控制</p>
              <p data-testid="source-control-branch" className="truncate font-mono text-meta text-tertiary" title={sourceControl.branch}>{sourceControl.branch}</p>
            </div>
            {sourceMenu}
          </div> : null}
          <div className="flex items-center gap-1 px-3 pb-2 pt-1"><div role="tablist" aria-label="源代码控制" className="flex min-w-0 flex-1 gap-1" onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 'changes' : event.key === 'End' ? 'pr' : sourceTab === 'changes' ? 'pr' : 'changes';
            setSourceTab(next);
            event.currentTarget.querySelector<HTMLButtonElement>(`[data-testid="source-control-tab-${next}"]`)?.focus();
          }}>
            {([['changes', '改动'], ['pr', 'PR']] as const).map(([value, label]) => <button key={value} type="button" role="tab" tabIndex={sourceTab === value ? 0 : -1} aria-selected={sourceTab === value} data-testid={`source-control-tab-${value}`} onClick={() => setSourceTab(value)} className={`min-h-[44px] min-w-0 flex-1 rounded-md px-3 text-sub font-medium focus-visible:outline-2 focus-visible:outline-ring ${sourceTab === value ? 'bg-card-raised text-primary' : 'text-tertiary hover:bg-card hover:text-primary'}`}>{label}</button>)}
          </div>{compactReader ? sourceMenu : null}</div>
        </div>
      ) : null}
      {tab === 'changes' && sourceControl && sourceTab === 'pr' ? (
        <div role="tabpanel" aria-label="PR" data-testid="source-control-pr-content" className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <p className="text-sub font-medium text-primary">此任务已记录的 PR</p>
          {sourceControl.taskId === null ? <p className="mt-3 text-sub text-tertiary">此会话没有关联任务，无法查看任务 PR。</p> :
            sourceControl.prsError ? <p role="alert" className="mt-3 text-sub text-rust">无法读取任务 PR，请刷新重试。</p> :
            sourceControl.prsLoading ? <p role="status" className="mt-3 text-sub text-tertiary">正在读取任务 PR…</p> :
            sourceControl.prs.length === 0 ? <p className="mt-3 text-sub text-tertiary">此任务尚未记录 PR。</p> :
            <div className="mt-3 divide-y divide-hair">{sourceControl.prs.map((pr) => <a key={pr.id} href={pr.url} target="_blank" rel="noreferrer" data-testid="source-control-pr-item" data-state={pr.state} className="flex min-h-[44px] items-center gap-3 py-2 text-sub hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"><span className="min-w-0 flex-1 truncate text-link">{pr.repo} #{pr.number} ↗</span><span className={`shrink-0 text-meta ${pr.state === 'merged' ? 'text-info' : pr.state === 'closed' ? 'text-tertiary' : 'text-sage'}`}>{pr.state === 'merged' ? '已合并' : pr.state === 'closed' ? '已关闭' : '进行中'}</span></a>)}</div>}
        </div>
      ) : null}
      <div className={`${tab === 'changes' && sourceControl && sourceTab === 'pr' ? 'hidden' : 'flex'} min-h-0 flex-1 flex-col`}>
      {switcher ? <div className="shrink-0 border-b border-hair px-3 py-1.5">{switcher}</div> : null}
      {others > 0 ? (
        <p data-testid="files-other-projects" className="shrink-0 border-b border-hair px-3 py-1 text-meta text-rust">
          ⚠ 其他项目有 {others} 个会话也在这个工作目录里干活，这里的改动可能不全是本会话的
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1">
        {/* 手机进正文时列表只是藏起来，不卸载：展开的目录、滚动位置、以及返回后要回去的那一行都还在 */}
        <aside
          ref={listRef}
          style={wide ? { width: listWidth } : undefined}
          className={`min-h-0 flex-col ${wide ? 'flex shrink-0' : reading ? 'hidden' : 'flex flex-1'}`}
          data-testid="files-list"
          data-reading={!wide && reading ? 'true' : undefined}
        >
          {tab === 'files' ? (
            <>
              <div className="flex shrink-0 items-center gap-2 px-3 py-2">
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="找文件…" className="min-w-0 flex-1 rounded bg-card px-2 py-1 text-sub outline-none" data-testid="files-find" />
                <label className="flex shrink-0 items-center gap-1 text-meta text-tertiary">
                  <input type="checkbox" checked={showSensitive} onChange={(e) => setShowSensitive(e.target.checked)} data-testid="files-show-sensitive" />
                  显示敏感文件
                </label>
              </div>
              <RootPath root={root} wide={wide} />
              <div className="min-h-0 flex-1 overflow-y-auto py-1" data-testid="files-tree">
                {query.trim() !== '' ? (
                  found.error ? <p className="px-3 text-meta text-rust">{problem(found.error)}</p> :
                  (shown(found) ?? []).map((p) => {
                    const m = mark(p);
                    return (
                      <button key={p} aria-current={m.on ? 'true' : undefined} data-last-read={m.last ? 'true' : undefined}
                        className={`flex h-7 w-full items-center rounded-md px-3 text-left font-mono text-sub text-secondary transition-colors [scroll-margin-block:8px] hover:bg-hair/40 ${m.on ? 'bg-hair/60' : ''}`}
                        onClick={() => open({ path: p, sensitive: /(^|\/)(\.env|id_rsa|id_ed25519)|\.(pem|key|p12)$/.test(p) })}>
                        <span className="min-w-0 truncate">{p}</span>
                      </button>
                    );
                  })
                ) : (
                  <Directory sessionId={sessionId} member={member} keys={keys} path="" depth={0} expanded={expanded} toggle={toggle} open={open} showSensitive={showSensitive} selected={picked?.path ?? null} />
                )}
              </div>
            </>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto" data-testid="changes-list">
              {/* 改动页的标题：先选范围，再用一行字说清这个范围比的是什么、边界在哪 */}
              <div className="sticky top-0 z-10 shrink-0 border-b border-hair/60 bg-canvas px-3 py-2" data-testid="changes-heading">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta">
                  <span className="text-secondary">对比</span>
                  <select value={base} onChange={(e) => setBase(e.target.value as Base)} className="rounded bg-card px-1 py-0.5 text-sub text-secondary" data-testid="changes-base">
                    <option value="session">会话开始以来</option>
                    <option value="head">相对当前 HEAD</option>
                    <option value="branch">相对分支起点</option>
                    {(turns.data?.length ?? 0) > 0 ? <option value="turn">本轮（第 {turns.data!.at(-1)!.turn} 轮）</option> : null}
                    {[...(turns.data ?? [])].reverse().map((t) => (
                      <option key={t.turn} value={`turn:${t.turn}`}>第 {t.turn} 轮{t.files !== null ? ` · ${t.files} 个文件` : ''}</option>
                    ))}
                  </select>
                </div>
                <p className="mt-0.5 min-w-0 font-mono text-meta leading-snug" data-testid="changes-scope" data-unknown={scope.unknown ? 'true' : undefined}>
                  <span className={scope.unknown ? 'text-rust' : 'text-secondary'}>{scope.detail}</span>
                  {scope.note ? <span className="text-tertiary"> · {scope.note}</span> : null}
                </p>
              </div>
              <RootPath root={root} wide={wide} />
              <ReviewPanel key={`${accountId}:${sessionId}`} accountId={accountId} sessionId={sessionId} state={review} onOpen={(note) => {
                setBase(note.base);
                setLastRead({ path: note.path, member: note.member });
                setOpened({ path: note.path, confirmed: false, diff: true, member: note.member, review: note, nonce: Date.now() });
              }} />
              {aggregate ? (
                groupedChanges.some((item) => item.error) ? (
                  <p className="px-3 py-2 text-meta text-rust" data-testid="files-error">{problem(groupedChanges.find((item) => item.error)?.error)}</p>
                ) : null
              ) : changes.error ? <p className="px-3 py-2 text-meta text-rust" data-testid="files-error">{problem(changes.error)}</p> : null}
              {(aggregate ? groupedChanges.some((item) => item.isPending) : changes.isPending) ? (
                <p role="status" className="px-3 py-2 text-meta text-tertiary">正在读取改动…</p>
              ) : null}
              {aggregate ? (
                groupedChanges.every((item) => shown(item)?.files.length === 0) ? (
                  <p className="px-3 py-2 text-meta text-tertiary">没有改动</p>
                ) : (
                  members.map((item, index) => {
                    const group = shown(groupedChanges[index]!);
                    const files = group?.files ?? [];
                    if (files.length === 0) return null;
                    return (
                      <div key={item.workspaceId} className="mb-1" data-testid={`changes-group-${item.name}`}>
                        <p className="px-3 py-1 font-mono text-meta text-secondary">{item.name}（{files.length}）</p>
                        {files.map((f) => {
                          const m = mark(f.path, item.workspaceId);
                          return (
                            <button key={`${item.workspaceId}:${f.path}`} onClick={() => open({ path: f.path, member: item.workspaceId }, true)} data-testid="change-row"
                              aria-current={m.on ? 'true' : undefined} data-last-read={m.last ? 'true' : undefined}
                              className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left transition-colors [scroll-margin-block:8px] hover:bg-hair/40 ${m.on ? 'bg-hair/60' : ''}`}>
                              <span className="w-3 shrink-0 font-mono text-meta text-warning">{GIT_LABEL[f.status] ?? '?'}</span>
                              <span className="min-w-0 flex-1 truncate font-mono text-sub text-secondary">{f.path}</span>
                              <span className="shrink-0 font-mono text-meta text-sage">+{f.additions}</span>
                              <span className="shrink-0 font-mono text-meta text-rust">−{f.deletions}</span>
                            </button>
                          );
                        })}
                      </div>
                    );
                  })
                )
              ) : (
                <>
                  {changed?.files.length === 0 ? (
                    // 「会话开始以来」要有会话开始时的 git 基准；没有基准时空列表不等于「没改」，照实说原因
                    changed.base === 'session' && changed.commit === null ? (
                      <p className="px-3 py-2 text-meta text-tertiary" data-testid="changes-no-git">
                        {context.data?.sessionBase === null ? '无法确认改动：会话起点没有记录，或当前目录不是仓库' : '没有 git 改动（当前目录不是仓库）'}
                      </p>
                    ) : (
                      <p className="px-3 py-2 text-meta text-tertiary">没有改动</p>
                    )
                  ) : null}
                  {changed?.files.map((f) => {
                    const m = mark(f.path);
                    return (
                      <button key={f.path} onClick={() => open({ path: f.path }, true)} data-testid="change-row"
                        aria-current={m.on ? 'true' : undefined} data-last-read={m.last ? 'true' : undefined}
                        className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left transition-colors [scroll-margin-block:8px] hover:bg-hair/40 ${m.on ? 'bg-hair/60' : ''}`}>
                        <span className="w-3 shrink-0 font-mono text-meta text-warning">{GIT_LABEL[f.status] ?? '?'}</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-sub text-secondary">{f.path}</span>
                        <span className="shrink-0 font-mono text-meta text-sage">+{f.additions}</span>
                        <span className="shrink-0 font-mono text-meta text-rust">−{f.deletions}</span>
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          )}
        </aside>
        {wide ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整文件列表宽度"
            aria-live="off"
            tabIndex={0}
            data-testid="files-resizer"
            onPointerDown={startResize}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') rememberWidth(listWidth - 16);
              else if (event.key === 'ArrowRight') rememberWidth(listWidth + 16);
              else return;
              event.preventDefault();
            }}
            className="group relative w-1 shrink-0 cursor-col-resize bg-hair/60 transition-colors hover:bg-accent/60 focus:bg-accent/60 focus:outline-none"
          >
            <span aria-hidden className="absolute inset-y-0 -left-1 -right-1" />
          </div>
        ) : null}
        {/* 手机没进正文时右边不占位；桌面一直是「左列表 + 右正文」，没选文件时右边先说清在比什么 */}
        <main ref={mainRef} className={`min-w-0 flex-1 overflow-auto ${wide || reading ? '' : 'hidden'}`}>
          {opened ? (
            opened.diff ? <DiffView sessionId={sessionId} member={activeMember} needsMember={members.length > 1 && activeMember === null} keys={activeKeys} path={opened.path} base={base} scope={scope} wide={wide} root={root} onQuote={onQuote} onBack={back} reviewNote={opened.review} revealNonce={opened.nonce} onReviewSaved={() => { void review.refresh(); }} /> :
            <FileView sessionId={sessionId} member={activeMember} keys={activeKeys} opened={opened} wide={wide} root={root} onBack={back} onCrumb={(p) => { setExpanded((s) => new Set([...s, ...crumbs(p).map((c) => c.path)])); setOpened(null); }} />
          ) : (
            <div className="flex flex-col gap-1 p-6" data-testid="reader-empty">
              <p className="text-sub text-secondary">{tab === 'changes' ? '选一个改动看' : '选一个文件看'}</p>
              {tab === 'changes' ? (
                <p className="font-mono text-meta leading-snug text-tertiary" data-testid="reader-scope" data-unknown={scope.unknown ? 'true' : undefined}>
                  <span className={scope.unknown ? 'text-rust' : undefined}>{scope.detail}</span>
                  {scope.note ? ` · ${scope.note}` : ''}
                </p>
              ) : null}
            </div>
          )}
        </main>
      </div>
      </div>
    </div>
  );
}

function Directory(props: { sessionId: string; member: string | null; keys: FilesKeys; path: string; depth: number; expanded: Set<string>; toggle: (p: string) => void; open: (e: FileEntryDto) => void; showSensitive: boolean; selected: string | null }) {
  const { sessionId, member, keys, path, depth } = props;
  const page = useQuery({ ...fresh, queryKey: keys.list(path), queryFn: () => filesApi.list(sessionId, path, member) });
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
              aria-current={props.selected === e.path ? 'true' : undefined}
              data-last-read={props.selected === e.path && !isDir ? 'true' : undefined}
              className={`flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left transition-colors [scroll-margin-block:8px] hover:bg-hair/40 ${props.selected === e.path ? 'bg-hair/60' : ''} ${e.ignored ? 'opacity-50' : ''}`}
              style={{ paddingLeft: 12 + depth * 14 }}>
              <span className="w-3 shrink-0 text-meta text-tertiary">{isDir ? (isOpen ? '▾' : '▸') : ''}</span>
              <span className={`min-w-0 flex-1 truncate text-sub ${isDir ? 'text-primary' : 'text-secondary'}`}>{e.name}{e.type === 'symlink' ? ' ↗' : ''}</span>
              {e.sensitive ? <span className="shrink-0 text-meta text-warning" title="敏感文件">🔒</span> : null}
              {e.git ? <span className="shrink-0 font-mono text-meta text-warning">{GIT_LABEL[e.git] ?? ''}</span> : null}
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

/** 工作目录根路径：文件路径都相对它，太长时只留末尾几段（全文在 title 里，手机也撑不破布局）。 */
function RootPath({ root, wide }: { root: string | undefined; wide: boolean }) {
  if (!root) return null;
  return (
    <p data-testid="files-root" title={root} className="min-w-0 shrink-0 border-b border-hair px-3 py-1 font-mono text-meta leading-snug text-tertiary">
      <span className="select-text [overflow-wrap:anywhere]">{wide ? root : shortPath(root, 30)}</span>
    </p>
  );
}

/**
 * 预览顶栏：完整相对路径是这一栏最显眼的信息。
 * 桌面每一段仍可点回目录；手机放不下面包屑，直接给整条路径，并在下面一行说明根在哪。
 * 看 diff 时再补一行「范围」：正文自己说清在比哪两个东西，不靠列表标题的记忆。
 */
function PathBar({ path, root, wide, download, size, range, onCrumb, onBack }: {
  path: string;
  root: string | undefined;
  wide: boolean;
  download?: string;
  size?: number;
  range?: CompareScope | null;
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
            <button className="shrink-0 text-tertiary hover:text-primary" onClick={() => onCrumb('')} title="工作目录根目录" data-testid="file-crumb">根目录</button>
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
          {download ? <a href={download} download className="text-link" data-testid="file-download">下载</a> : null}
        </span>
      </div>
      {range ? (
        <p className="min-w-0 select-text font-mono text-meta leading-snug" data-testid="diff-range" data-unknown={range.unknown ? 'true' : undefined}>
          <span className="text-tertiary">范围 </span>
          <span className={range.unknown ? 'text-rust' : 'text-secondary'}>{range.detail}</span>
          {range.note ? <span className="text-tertiary"> · {range.note}</span> : null}
        </p>
      ) : null}
      {root ? (
        <p className="min-w-0 truncate font-mono text-meta text-tertiary" title={root} data-testid="file-root">位于 {shortPath(root, wide ? 96 : 26)}</p>
      ) : null}
    </div>
  );
}

function FileView({ sessionId, member, keys, opened, wide, root, onBack, onCrumb }: { sessionId: string; member: string | null; keys: FilesKeys; opened: Opened; wide: boolean; root: string | undefined; onBack: () => void; onCrumb: (p: string) => void }) {
  const file = useQuery({ ...fresh, queryKey: keys.read(opened.path, opened.confirmed), queryFn: () => filesApi.read(sessionId, opened.path, opened.confirmed, member) });
  const data = shown(file);
  const text = useMemo(() => (data && !data.binary ? decodeText(data.data) : null), [data]);
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    setHtml(null);
    const lang = languageOf(opened.path);
    if (text === null || !lang || text.length > 300_000) return;
    let live = true;
    // Shiki 按需加载语言 / 主题：首次打开某种语言才下载它的语法
    void import('shiki').then(({ codeToHtml }) => codeToHtml(text, { lang, theme: currentTheme() === 'light' ? 'github-light' : 'github-dark-dimmed' })).then((h) => live && setHtml(h), () => undefined);
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
      <PathBar path={opened.path} root={root} wide={wide} size={data?.size} download={filesApi.downloadUrl(sessionId, opened.path, opened.confirmed, member)} onCrumb={onCrumb} onBack={onBack} />
      {file.isPending ? <p className="p-4 text-meta text-tertiary">读取中…</p> : null}
      {file.error ? <p className="p-4 text-sub text-rust" data-testid="files-error">{problem(file.error)}</p> : null}
      {data?.binary ? <p className="p-4 text-sub text-tertiary">二进制文件，不预览——可以下载</p> : null}
      {data?.truncated ? <Notice tone="warning" className="px-3 pt-2">文件超过 1 MB，只显示前 1 MB</Notice> : null}
      {text !== null ? (
        <div ref={content} className="[&_[data-target-line]]:bg-warning/20" data-line={line ?? undefined}>
          {html ? <div className="files-code overflow-x-auto p-3 text-sub [&_pre]:!bg-transparent" data-testid="file-content" dangerouslySetInnerHTML={{ __html: html }} /> :
          <pre className="overflow-x-auto whitespace-pre p-3 font-mono text-sub text-secondary" data-testid="file-content">{line === null ? text : text.split('\n').map((l, i) => <span key={i} className="line">{l}{'\n'}</span>)}</pre>}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 所有 diff 行统一 24px 高（`min-h-6` / `leading-6` 都是 1.5rem）：窗口化的 spacer 按 `DIFF_ROW_HEIGHT` 算高度，
 * 行高只改这两处，别在行里散落 `py-*`。hunk 行也是 24px，靠上下边框和底色分隔。
 * 用 `min-h-6` 而不是 `h-6`：触屏上行号按钮是 32px，行要跟着长。
 */
const DIFF_ROW_HEIGHT = 24;
const DIFF_ROW = 'min-h-6 leading-6';
/**
 * 超过这么多行才窗口化：200 行以内全量渲染更快，也省掉滚动时的状态更新
 * （参照 opencode pierre 的 `virtualizeLineThreshold`，约 200 行是收益打平点）。
 */
const DIFF_VIRTUALIZE_THRESHOLD = 200;
/** 视口上下各多渲染 20 行：滚动时边缘不会先露出空白。 */
const DIFF_WINDOW_OVERSCAN = 20;

/**
 * 单文件补丁：自带一条可点的行号 gutter（ADR 0025 的 diff 视图）。
 *
 * 以前这里交给 diff2html 出 HTML。行号要能点、选中的段要高亮、手机上点按区不能太小，
 * 而外来 HTML 只能靠命令式打补丁，所以改成自己画行——代价是不再区分并排 / 单列两种版式，
 * 一律单列，宽度交给横向滚动。
 */
function DiffView({ sessionId, member, needsMember, keys, path, base, scope, wide, root, onBack, onQuote, reviewNote, revealNonce, onReviewSaved }: {
  sessionId: string;
  member: string | null;
  needsMember: boolean;
  keys: FilesKeys;
  path: string;
  base: Base;
  /** 这一段 diff 比的是什么（列表标题、正文顶栏、桌面空正文共用同一个说明）。 */
  scope: CompareScope;
  wide: boolean;
  root: string | undefined;
  onBack: () => void;
  onQuote?: (ref: string) => void;
  reviewNote?: ReviewNoteDto;
  revealNonce?: number;
  onReviewSaved: () => void;
}) {
  // The review version is session- and member-specific even for a shared HEAD diff.
  const diff = useQuery({ ...fresh, queryKey: [...keys.diff(path, base), sessionId, member, reviewNote ? revealNonce : null], queryFn: () => filesApi.diff(sessionId, path, base, member) });
  const data = shown(diff);
  const rows = useMemo(() => (data && !data.binary ? parsePatchLines(data.patch) : []), [data]);
  const contentRows = useMemo(() => rows.some((row) => row.kind === 'hunk')
    ? rows.filter((row) => row.kind !== 'meta' || !/^(diff --git |index |--- |\+\+\+ )/.test(row.text))
    : rows, [rows]);
  const [showHeaders, setShowHeaders] = useState(false);
  // 整文件新增：不铺绿底，读起来像普通代码
  const plain = useMemo(() => isWholeFileAddition(rows), [rows]);

  const [picked, setPicked] = useState<LineSelection | null>(null);
  const [pickedVersion, setPickedVersion] = useState<string | null>(null);
  const [editing, setEditing] = useState<Omit<ReviewDraftDto, 'text'> | null>(null);
  // 换文件 / 换对比基准之后，旧的行号就不指同一段代码了
  useEffect(() => { setPicked(null); setPickedVersion(null); setEditing(null); }, [path, base, member, data?.reviewVersion]);
  const range = selectionRange(picked);
  const ref = selectionRef(path, picked);
  const pick = (side: DiffSide, line: number) => { setEditing(null); setPickedVersion(data?.reviewVersion ?? null); setPicked((current) => toggleLine(current, side, line)); };
  let visibleRange = false;
  if (picked && range) {
    let hunkLines = new Set<number>();
    const matches = () => hunkLines.size === range.end - range.start + 1;
    for (const row of rows) {
      if (row.kind === 'hunk') { if (matches()) visibleRange = true; hunkLines = new Set(); continue; }
      const line = picked.side === 'old' ? row.oldLine : row.newLine;
      if (line !== undefined && line >= range.start && line <= range.end) hunkLines.add(line);
    }
    visibleRange ||= matches();
  }
  const canReview = Boolean(!needsMember && data?.reviewVersion && pickedVersion === data.reviewVersion && visibleRange && !data.binary && !data.truncated && !diff.error && !diff.isFetching && base !== 'turn');
  const canonicalMember = data?.reviewMember !== undefined ? data.reviewMember : member;
  const reopen = !diff.isFetching && !diff.error && reviewNote && reviewNote.path === path && reviewNote.base === base && reviewNote.member === canonicalMember && data?.reviewVersion === reviewNote.version ? reviewNote : undefined;
  const quote = () => {
    if (!ref) return;
    onQuote?.(ref);
    setPicked(null);
  };
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="diff-view">
      <PathBar path={path} root={root} wide={wide} range={scope} onBack={onBack} />
      {diff.isPending ? <p className="p-4 text-meta text-tertiary">读取中…</p> : null}
      {diff.error ? <p className="p-4 text-sub text-rust" data-testid="files-error">{problem(diff.error)}</p> : null}
      {data?.binary ? <p className="p-4 text-sub text-tertiary">二进制文件有改动</p> : null}
      {data?.truncated ? <Notice tone="warning" className="px-3 pt-2">diff 超过 512 KB，只显示前一部分</Notice> : null}
      {data && data.patch === '' && !data.binary ? <p className="p-4 text-sub text-tertiary">没有差异</p> : null}
      {rows.length > 0 ? (
        <>
          {/* 工具条在滚动区外面：不悬停、不浮在代码上，手机上换行也压不到内容 */}
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-hair px-3 py-1.5" data-testid="diff-toolbar">
            {picked && range ? (
              <>
                <span className="font-mono text-meta text-secondary">
                  {range.start === range.end ? `第 ${range.start} 行` : `第 ${range.start}–${range.end} 行`}
                  <span className="text-tertiary"> · {picked.side === 'old' ? '改前' : '改后'}</span>
                </span>
                {onQuote && ref ? (
                  <button type="button" onClick={quote} data-testid="diff-quote"
                    className="min-h-6 cursor-pointer rounded bg-action px-2 text-meta font-medium text-action-fg transition-colors hover:bg-action/90 [@media(pointer:coarse)]:min-h-8 [@media(pointer:coarse)]:px-3">
                    引用到对话
                  </button>
                ) : null}
                {canReview ? <button type="button" data-testid="review-add" onClick={() => setEditing({ path, member: data!.reviewMember !== undefined ? data!.reviewMember : member, base, side: picked.side, start: range.start, end: range.end, version: data!.reviewVersion! })} className="min-h-8 rounded bg-card-raised px-2 text-meta text-primary hover:bg-hair">添加备注</button> : null}
                <button type="button" onClick={() => setPicked(null)} data-testid="diff-quote-clear"
                  className="min-h-6 cursor-pointer rounded px-2 text-meta text-tertiary transition-colors hover:bg-card-raised hover:text-primary [@media(pointer:coarse)]:min-h-8 [@media(pointer:coarse)]:px-3">
                  清除
                </button>
              </>
            ) : (
              <span className="text-meta text-tertiary">点行号选起止行{onQuote ? '，可引用到对话' : ''}</span>
            )}
            {contentRows.length < rows.length ? <button type="button" aria-expanded={showHeaders} onClick={() => setShowHeaders(!showHeaders)}
              className="ml-auto min-h-6 shrink-0 rounded px-2 text-meta text-link hover:bg-card-raised [@media(pointer:coarse)]:min-h-8">Git 头信息</button> : null}
          </div>
          {needsMember ? <p className="px-3 py-1 text-meta text-tertiary">添加备注前，请在仓库切换栏或改动列表中明确选择仓库（包括主仓库）。</p> : base === 'turn' ? <p className="px-3 py-1 text-meta text-tertiary">添加备注前，请在对比范围中选择具体回合。</p> : picked && !canReview ? <p className="px-3 py-1 text-meta text-tertiary">当前差异无法保存备注，仍可引用到对话。</p> : null}
          {reviewNote && reviewNote.path === path && reviewNote.base === base && !reopen ? <p className="px-3 py-1 text-meta text-rust">原备注位置已变化或无法确认，未自动定位到当前行。</p> : null}
          {editing && editing.path === path && editing.base === base && editing.member === (data?.reviewMember !== undefined ? data.reviewMember : member) ? <ReviewEditor key={`${editing.path}:${editing.base}:${editing.side}:${editing.start}:${editing.end}:${editing.version}`} draft={editing} sessionId={sessionId} disabled={!canReview || editing.version !== data?.reviewVersion} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); setPicked(null); onReviewSaved(); }} /> : null}
          <DiffLines key={`${path}\u0000${base}\u0000${member ?? ''}`} rows={showHeaders ? rows : contentRows} picked={picked} pick={pick} plain={plain} reveal={reopen} revealNonce={revealNonce} />
        </>
      ) : null}
    </div>
  );
}

/**
 * 触屏（粗指针）上行号按钮要更高才好点（见 Gutter 的 `min-h-8`），行高就不再是固定值。
 */
function useCoarsePointer(): boolean {
  const query = '(pointer: coarse)';
  const [coarse, setCoarse] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setCoarse(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return coarse;
}

/**
 * diff 的行区。超过 `DIFF_VIRTUALIZE_THRESHOLD` 行只渲染可视窗口 ±`DIFF_WINDOW_OVERSCAN` 行，
 * 上下用等高 spacer 占位：大的补丁不再一次挂几千个行号按钮。
 *
 * 只对固定行高成立——触屏行号是 32px，高度不再一致，所以那边全量渲染（手机上 diff 也小）。
 */
function DiffLines({ rows, picked, pick, plain, reveal, revealNonce }: {
  rows: readonly DiffRow[];
  picked: LineSelection | null;
  pick: (side: DiffSide, line: number) => void;
  plain: boolean;
  reveal?: ReviewNoteDto;
  revealNonce?: number;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const coarse = useCoarsePointer();
  const virtual = rows.length > DIFF_VIRTUALIZE_THRESHOLD && !coarse;
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);

  useEffect(() => {
    if (!reveal || !scroller.current) return;
    const index = rows.findIndex((row) => (reveal.side === 'old' ? row.oldLine : row.newLine) === reveal.start);
    if (index < 0) return;
    if (virtual) scroller.current.scrollTop = index * DIFF_ROW_HEIGHT;
    else scroller.current.querySelector<HTMLElement>(`[data-side="${reveal.side}"][data-line="${reveal.start}"]`)?.scrollIntoView({ block: 'center' });
  }, [rows, reveal, revealNonce, virtual]);

  useEffect(() => {
    if (!virtual) {
      setRange(null);
      return;
    }
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      const next = diffWindowRange(rows.length, el.scrollTop, el.clientHeight, DIFF_ROW_HEIGHT, DIFF_WINDOW_OVERSCAN);
      setRange((current) => (current && current.start === next.start && current.end === next.end ? current : next));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [virtual, rows.length]);

  const from = Math.min(range ? range.start : 0, rows.length);
  const to = Math.min(range ? range.end : rows.length, rows.length);
  const head = from * DIFF_ROW_HEIGHT;
  const tail = (rows.length - to) * DIFF_ROW_HEIGHT;
  return (
    <div ref={scroller} className="files-diff min-h-0 flex-1 overflow-auto pb-4 font-mono text-meta" data-testid="diff-lines">
      {head > 0 ? <div aria-hidden style={{ height: head }} /> : null}
      {rows.slice(from, to).map((row, i) => (
        <PatchLine key={from + i} row={row} picked={picked ?? (reveal ? { side: reveal.side, anchor: reveal.start, end: reveal.end } : null)} pick={pick} plain={plain} />
      ))}
      {tail > 0 ? <div aria-hidden style={{ height: tail }} /> : null}
    </div>
  );
}

/** 一行补丁：两个行号槽（改前 / 改后）+ 正文。没号的那一侧留空位，对齐不乱。 */
function PatchLine({ row, picked, pick, plain }: { row: DiffRow; picked: LineSelection | null; pick: (side: DiffSide, line: number) => void; plain: boolean }) {
  if (row.kind === 'meta') {
    return <div className={`${DIFF_ROW} whitespace-pre px-3 text-meta text-tertiary/80`}>{row.text}</div>;
  }
  if (row.kind === 'hunk') {
    return (
      <div className={`${DIFF_ROW} whitespace-pre border-y border-hair/60 bg-card/70 px-3 text-meta text-secondary`}>
        {row.text}
      </div>
    );
  }
  // 整文件新增时不给新增行铺底色：满屏绿反而看不清代码
  const tone = plain ? '' : row.kind === 'added' ? 'bg-sage/10' : row.kind === 'removed' ? 'bg-rust/10' : '';
  const mark = row.kind === 'added' ? 'text-sage' : row.kind === 'removed' ? 'text-rust' : 'text-tertiary';
  const sign = row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' ';
  const oldOn = row.oldLine !== undefined && inSelection(picked, 'old', row.oldLine);
  const newOn = row.newLine !== undefined && inSelection(picked, 'new', row.newLine);
  const highlighted = oldOn || newOn;
  return (
    <div className={`flex min-w-full w-max ${DIFF_ROW} ${highlighted ? 'bg-warning/15' : tone}`}>
      <Gutter side="old" line={row.oldLine} selected={oldOn} pick={pick} />
      <Gutter side="new" line={row.newLine} selected={newOn} pick={pick} />
      <span aria-hidden className={`w-4 shrink-0 select-none whitespace-pre text-center ${mark}`}>{sign}</span>
      <span className="whitespace-pre pr-6 text-secondary">{row.text === '' ? ' ' : row.text}</span>
    </div>
  );
}

/**
 * 行号按钮：就是选段的把手，所以自己占满 24px 高——手机上不用悬停也知道能点。
 * 同一侧点两下成段：改前的行号只跟改前的配，两边行号本来就不是一套数。
 */
function Gutter({ side, line, selected, pick }: { side: DiffSide; line: number | undefined; selected: boolean; pick: (side: DiffSide, line: number) => void }) {
  if (line === undefined) return <span aria-hidden className="w-10 shrink-0 border-r border-hair/40" />;
  return (
    <button type="button" data-testid="diff-line" data-side={side} data-line={line}
      aria-pressed={selected} aria-label={`选择第 ${line} 行`} title={`从第 ${line} 行开始选`}
      onClick={() => pick(side, line)}
      className={`flex min-h-6 w-10 shrink-0 cursor-pointer items-center justify-end border-r border-hair/40 px-1 text-right text-[11px] tabular-nums transition-colors ${selected ? 'bg-selected text-primary' : 'text-tertiary hover:bg-card-raised hover:text-primary'} [@media(pointer:coarse)]:min-h-8`}>
      {line}
    </button>
  );
}
