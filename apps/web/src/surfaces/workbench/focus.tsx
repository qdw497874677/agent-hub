import { modelLabel } from '../../atoms/model-label.ts';
import { DeliveryContext, useDeliveries } from '../../atoms/delivery-note.tsx';
import { ProvenanceRow } from '../../atoms/provenance-row.tsx';
import { COORDINATOR_TITLE, UNASSIGNED_TITLE } from '../../atoms/session-groups.ts';
import { useCoordinators } from '../../shell/coordinators.ts';
import { useDelegations } from '../../shell/delegations.ts';
import { DelegationOriginBanner, DelegationPanel } from './delegation-panel.tsx';
import { DelegateDialog } from './delegate-dialog.tsx';
import { AttentionAutoAck } from '../../atoms/attention.tsx';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import type { ArtifactDto, AttachmentInputDto, CanvasDto, SessionDto } from '../../shell/api.ts';
import { api, sessionGroupId, sessionStartupApi } from '../../shell/api.ts';
import { ChatBlock, DisplayMenu, Dropdown, MenuItem, WorkGroup, questionOf } from '../../atoms/chat-blocks.tsx';
import { useDisplaySettings } from '../../atoms/display-preferences.tsx';
import { groupTimeline } from '../../atoms/timeline-groups.ts';
import { DisplaySettingsDialog } from '../../atoms/display-settings-dialog.tsx';
import { Composer } from '../../atoms/composer.tsx';
import { HandoffGate } from '../../atoms/agent-handoff.tsx';
import { CONTINUE_DISABLED_HINT, ContinueDialog, canContinueElsewhere } from './continue-elsewhere.tsx';
import { SessionDetails } from './inspector.tsx';
import { useNarrow, useWide } from '../../shell/device.ts';
import { localTime } from '../../shell/local-time.ts';
import { StatusPill } from '../../atoms/status.tsx';
import { attachmentsCapability } from '../../atoms/attachments.ts';
import { useStickToBottom } from '../../atoms/use-stick-to-bottom.ts';
import { ScrollToEnd } from '../../atoms/scroll-to-end.tsx';
import { backgroundActivityText } from '../../atoms/background-activity.ts';
import { useBackgroundActivity } from '../../atoms/use-background-activity.ts';
import { useTurnProgress } from '../../atoms/use-turn-progress.ts';
import { turnHint } from '../../atoms/turn-hint.ts';
import { sessionCommands } from '../../atoms/commands.ts';
import { useIsFetching, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { FILES_QUERY, shown } from '../../atoms/files-core.ts';
import { filesInvalidationKeys, filesKeys, gitKeys, sessionKeys, taskKeys } from '../../shell/query-keys.ts';
import { filesApi } from '../../shell/api.ts';
import { FilesBrowser, type ChangesJump, type Reveal } from '../../atoms/files-browser.tsx';
import { appendRef } from '../../atoms/diff-selection.ts';
import { GitDialog, PullRequestChips } from './git-dialog.tsx';
import { RepoSwitcher, useSessionRepo } from './repo-switcher.tsx';
import { useAddRepository } from './use-add-repository.ts';
import { WorkspaceSheet } from './workspace-sheet.tsx';
import { gitApi } from '../../shell/api.ts';
import { FileLinksContext, type FileLinks } from '../../atoms/file-links.tsx';
import { SESSION_TABS, readChangesSplit, readStoredTab, sessionTabLabel, stepTab, storeChangesSplit, storeTab, type SessionTab } from '../../atoms/session-tabs.ts';
import { TerminalPanel } from '../../atoms/terminal-panel.tsx';
import { PreviewPanel } from '../../atoms/preview-panel.tsx';
import {
  subscribeTerminalSupport,
  terminalSupportKeys,
  terminalUnsupported as terminalBlocked
} from '../../atoms/terminal-core.ts';
import { resolveWorker, useWorkers } from '../../shell/workers.tsx';
import { RewindDialog } from '../../atoms/rewind-dialog.tsx';
import { forkBlockedHint, inheritedBlocks, multipleAuthors, waitingForReply, type Block, type LiveSession } from '../../atoms/live.ts';
import { ContextMeter } from '../../atoms/context-meter.tsx';
import { PinnedMark } from '../../atoms/pinned-mark.tsx';
import { SessionLinksDialog } from '../../atoms/session-links-dialog.tsx';
import { SessionLinkChip } from '../../atoms/session-link-popover.tsx';
import { SubagentTrack } from '../../atoms/subagent-track.tsx';
import { SubagentPanel } from '../../atoms/subagent-panel.tsx';
import { resolveSubagentPath } from '../../atoms/subagent-track.ts';
import { sessionLinkInfo } from '../../atoms/session-link-info.ts';
import { SaveAgentProfileDialog } from '../../shell/agent-profile-dialog.tsx';
import { AgentProfilesDialog } from '../../shell/agent-profiles-dialog.tsx';
import { DeleteSessionDialog } from '../../atoms/delete-session-dialog.tsx';
import { deleteSessionBlockedHint } from '../../atoms/delete-session.ts';
import { DELETE_HINT, FORK_HINT, normalizeSessionTitle, pinHint, settleGate } from '../../atoms/session-actions.ts';
import { useSessionActions } from '../../atoms/use-session-actions.ts';
import { environmentNotice } from '../../atoms/environment-notice.ts';
import type { PendingPrompt } from '../../atoms/pending-prompt.ts';
import { heldPromptSeqs, markQueued } from '../../atoms/prompt-delivery.ts';
import { PendingPrompts, usePromptDelivery } from '../../atoms/prompt-delivery.tsx';
import { WorktreeStatusLine } from './worktree-status.tsx';
import { SessionGroupLine } from './session-group.tsx';
import { FindInSession } from '../../atoms/find-in-session.tsx';
import { isTypingTarget } from '../../atoms/find-in-text.ts';
import { Sheet } from '../../shell/dialog-shell.tsx';
import { useHandoffCandidates } from '../../atoms/agent-handoff.tsx';
import { ModelPicker } from '../../atoms/model-picker.tsx';
import { SessionSwitcher } from './session-switcher.tsx';

interface Props {
  readonly canvas: CanvasDto;
  readonly session: SessionDto;
  readonly live: LiveSession | null;
  readonly historyState: import('../../atoms/live.ts').HistoryState;
  readonly onRetryHistory: () => void;
  /** 补齐实时记录时保留已显示的内容；同步失败由宿主提供重试。 */
  readonly syncState?: 'syncing' | 'stale';
  readonly onRetrySync?: () => void;
  readonly draft: string;
  readonly onDraftChange: (text: string) => void;
  /** 整页时的「← 返回」；画布窗口里没有（窗口自己有关闭）。 */
  readonly onBack?: () => void;
  readonly onProjectNavigation?: () => void;
  readonly onSearch?: () => void;
  /** 画布窗口：顶栏变成拖动把手，右边挂窗口按钮（最小化/最大化/打开/关闭）。 */
  readonly windowChrome?: { readonly actions: ReactNode; readonly onSwipe?: (step: number) => void };
  readonly onChanged: () => void;
  /** 换个地方继续之后跳到新会话。 */
  readonly onOpenSession: (sessionId: string) => void;
  /** 从这里重来：把原消息放进新会话的输入框。 */
  readonly onSeedDraft?: (sessionId: string, text: string) => void;
  readonly artifacts: readonly ArtifactDto[];
  readonly onChangeOption: (optionId: string, value: string | boolean) => Promise<void>;
  readonly independentWorkdir?: boolean;
  /** The host owns the open-view tabs; this does not change external session links. */
  readonly documentTabs?: ReactNode;
}

/**
 * 「更多」里的分组：一组相关操作，上面一条细线和一个说明这组在管什么的短标题。
 * role=group + aria-label 让读屏按组报；可见标题对读屏是重复的，所以留给眼睛。
 *
 * 分隔线由各组的 className 自己出：手机专属的那组在 DOM 里排最前但在桌面上不显示，
 * 用 first: 会算错谁在最上面。
 */
function MenuGroup({ label, className = '', children }: { readonly label: string; readonly className?: string; readonly children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className={className}>
      <p aria-hidden="true" className="px-3 pb-0.5 pt-1.5 text-meta text-tertiary">{label}</p>
      {children}
    </div>
  );
}

/**
 * 专注对话：一条会话，整屏看。
 *
 * 画布回答「这些思路之间是什么关系」，这里回答「它到底说了什么」。
 * 两者不能合并——把对话塞进 320px 的右栏，人只能在里面翻跟头。
 */
export function FocusView({
  canvas,
  session,
  live,
  historyState,
  onRetryHistory,
  syncState,
  onRetrySync,
  draft,
  onDraftChange,
  onBack,
  onProjectNavigation,
  onSearch,
  onChanged,
  onOpenSession,
  onSeedDraft,
  artifacts,
  onChangeOption,
  windowChrome,
  independentWorkdir = false,
  documentTabs
}: Props) {
  const [busy, setBusy] = useState(false);
  // 组合工作目录（多仓库项目）：只有这种会话才有 groupId
  const groupId = sessionGroupId(session);
  const [continuing, setContinuing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const wide = useWide();
  // 只有手机上会用到这个对话框：桌面的「Aa」是内嵌的 DisplayMenu。
  const [displayOpen, setDisplayOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [linksOpen, setLinksOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  // 删除确认框；关掉后焦点要回到「⋯」。
  const [deleting, setDeleting] = useState(false);
  // 子代理面板的返回栈（最后一个是正在看的子代理）；空数组就是关着。轨道和面板共用。
  const [subagentPath, setSubagentPath] = useState<readonly string[]>([]);
  const subagentTrackRef = useRef<HTMLButtonElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [mobileHandoffSession, setMobileHandoffSession] = useState<string | null>(null);
  // 这棵会话视图的根：⌘F 只归焦点所在的那一个（画布上可能同时开着几条会话窗口）。
  const viewRef = useRef<HTMLDivElement | null>(null);
  // 会话内搜索条开着没有；查询本身和命中由 FindInSession 自己管。
  const [findOpen, setFindOpen] = useState(false);
  const [linkBusy, setLinkBusy] = useState<string | null>(null);
  const [linkOverrides, setLinkOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [linkError, setLinkError] = useState<string | null>(null);
  // 哪条连接芯片的小窗开着；同一时间只开一个。
  const [linkInfoId, setLinkInfoId] = useState<string | null>(null);
  const chipsRef = useRef<HTMLDivElement | null>(null);
  // 同一 tick 内连点两下时 state 还没刷新，用 ref 抢先挡住第二次请求。
  const linkBusyRef = useRef(false);
  useEffect(() => {
    setRenaming(false);
    setLinkInfoId(null);
    setDeleting(false);
    setSubagentPath([]);
    setFindOpen(false);
  }, [session.id]);
  const queries = useQueryClient();
  const [tab, setTab] = useState<SessionTab>(() => readStoredTab(session.id) ?? 'chat');
  const [preferSplit, setPreferSplit] = useState(() => !windowChrome && readChangesSplit(session.id));
  const [viewWidth, setViewWidth] = useState(0);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const splitHeadingRef = useRef<HTMLDivElement | null>(null);
  const wasSplit = useRef(false);
  useEffect(() => {
    const node = viewRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setViewWidth(entry?.contentRect.width ?? 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const splitAvailable = wide && !windowChrome && viewWidth >= 1000;
  const splitChanges = preferSplit && splitAvailable && tab === 'chat' && !details;
  useEffect(() => {
    if (wasSplit.current && !splitAvailable && tab === 'chat') setTab('changes');
    wasSplit.current = splitChanges;
  }, [splitAvailable, splitChanges, tab]);
  // 访问过的页签保持挂载；单独记住并排偏好，窄屏暂时无法并排时也不清除它。
  const [visited, setVisited] = useState<ReadonlySet<SessionTab>>(() => new Set(['chat', tab]));
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [changesJump, setChangesJump] = useState<ChangesJump | null>(null);
  const showChanges = useCallback((jump: ChangesJump | null) => {
    setChangesJump(jump);
    if (preferSplit && splitAvailable) setDetails(false);
    else setTab('changes');
  }, [preferSplit, splitAvailable]);
  // 刷新 / 重进时回到上次那一页；记不住的存储（隐私模式）就按默认走。
  useEffect(() => {
    storeTab(session.id, tab);
  }, [session.id, tab]);
  /**
   * 会话内搜索的入口：只接管这条会话视图里的 ⌘F / Ctrl+F。
   * - 输入框里不拦：用户可能正在 composer 里改字，那里的 ⌘F 该留给浏览器。
   * - 别的页签 / 别的页面不管，画布上开着多条会话时也只有焦点所在的那一个响应。
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return;
      if (isTypingTarget(event.target) || tab !== 'chat') return;
      const host = viewRef.current;
      if (host === null || host.closest('[inert]')) return;
      const owner = event.target instanceof Node ? event.target : document.activeElement;
      const inside = owner !== null && host.contains(owner);
      // 焦点还挂在 body 上（刚进页面、刚点过空白处）也算：这时没有「别人的输入框」要保护，
      // 但画布上可能同时开着几条会话，所以只让唯一的那一个会话视图接。
      const idle = document.activeElement === null || document.activeElement === document.body;
      const alone = idle && document.querySelectorAll('[data-focus-view]').length === 1;
      if (!inside && !alone) return;
      event.preventDefault();
      setFindOpen(true);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [tab]);
  /**
   * diff 里选了段代码要引用到对话：草稿在宿主这层拼（输入框不受控，只能拼好再推回去），
   * nonce 让 Composer 知道「这是新引用，去同步一次」。切回对话页，人接着写问题。
   */
  const [quote, setQuote] = useState<{ text: string; nonce: number; focus?: boolean } | null>(null);
  const quoteSeq = useRef(0);
  const quoteToChat = (ref: string) => {
    const text = appendRef(draft, ref);
    onDraftChange(text);
    quoteSeq.current += 1;
    setQuote({ text, nonce: quoteSeq.current });
    setTab('chat');
  };
  // 消息引用不经过文件引用的 @ 格式，也不在触屏上唤起键盘或滚动时间线。
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const quoteMessageToChat = (message: string) => {
    const quoted = message.split('\n').map((line) => `> ${line}`).join('\n');
    const base = draftRef.current;
    const text = base + (base === '' ? '' : base.endsWith('\n\n') ? '' : base.endsWith('\n') ? '\n' : '\n\n') + quoted + '\n';
    draftRef.current = text;
    onDraftChange(text);
    setTab('chat');
    quoteSeq.current += 1;
    setQuote({ text, nonce: quoteSeq.current, focus: !window.matchMedia('(any-pointer: coarse)').matches });
  };
  // 换会话：上一条会话的引用不该再往新草稿里写
  useEffect(() => {
    setQuote(null);
  }, [session.id]);
  // 工具参数里的路径可点：只认这条会话工作目录里的（老会话没有工作目录就只认相对路径）
  const workspaceRoot = canvas.workspaces.find((w) => w.id === session.workspaceId)?.path ?? null;
  const fileLinks = useMemo<FileLinks>(() => ({
    root: workspaceRoot,
    open: (target) => {
      setReveal((prev) => ({ ...target, nonce: (prev?.nonce ?? 0) + 1 }));
      setTab('files');
    },
    openChanges: () => showChanges(null)
  }), [workspaceRoot, showChanges]);
  useEffect(() => {
    const opened = splitChanges ? 'changes' : tab;
    setVisited((current) => current.has(opened) ? current : new Set([...current, opened]));
  }, [tab, splitChanges]);
  // 组合会话按当前选中的成员仓库取 git / 文件；单仓 member 为 null，行为与原来一样。
  const repo = useSessionRepo(session.id, session.workspaceId);
  const repoWorkspaceId = repo.selected ?? session.workspaceId;
  const {
    addingRepo,
    addable,
    notices,
    addRepo,
    recheckAdd,
    repoHint: sheetRepoHint
  } = useAddRepository({
    sessionId: session.id,
    groupId,
    projectId: canvas.project.id,
    repos: canvas.project.repos ?? [],
    members: repo.members
  });
  const renderSwitcher = (inline: boolean) => repo.isCombo ? (
    <RepoSwitcher
      members={repo.members}
      selected={repo.selected}
      onSelect={repo.setSelected}
      statuses={repo.statuses}
      addable={addable}
      onAdd={(id) => void addRepo(id)}
      onRetry={(id) => void addRepo(id, true)}
      onRecheck={(id) => void recheckAdd(id)}
      adding={addingRepo}
      inline={inline}
      notices={notices}
    />
  ) : null;
  const switcher = renderSwitcher(false);
  // 抽屉里用流式候选列表：抽屉内容区自己会滚，浮层下拉会被裁掉。
  const sheetSwitcher = renderSwitcher(true);
  // 目录派生的文件 / git 状态按工作目录归一：同目录的多条会话共享缓存（见 query-keys.ts）。
  const fileKeys = filesKeys(repoWorkspaceId, session.id);
  // 打开文件 / 改动：先显示缓存（挂载着的面板原样在），同时后台重读一遍
  const fileView = tab === 'files' ? 'files' : tab === 'changes' || splitChanges ? 'changes' : null;
  useEffect(() => {
    if (!fileView) return;
    const keys = filesKeys(repoWorkspaceId, session.id);
    for (const prefix of filesInvalidationKeys(keys)) {
      void queries.invalidateQueries({ queryKey: prefix });
    }
  }, [fileView, session.id, repoWorkspaceId, queries]);
  const refreshing = useIsFetching({
    predicate: (q) => q.queryKey[0] === 'files' && (q.queryKey[1] === fileKeys.dir[1] || q.queryKey[1] === session.id)
  }) > 0;
  const [settings, changeSettings] = useDisplaySettings();
  const { nearEnd, ref: scroller, scrollToEnd } = useStickToBottom<HTMLDivElement>(session.id);
  const agent = canvas.agents.find((candidate) => candidate.id === session.agentId);
  const task = canvas.tasks.find((candidate) => candidate.id === session.taskId);
  // 主会话要在标题上认得出自己；没有登记的无任务会话（bot / 群）不留空标题。
  const { ids: coordinatorIds } = useCoordinators(canvas.project.id);
  const isCoordinatorSession = coordinatorIds.has(session.id);
  const [delegating, setDelegating] = useState(false);
  // 执行会话的来路：只有它的目录确实是从某条登记过的主任目录拉出来的 worktree，
  // 才去问那条主会话的派工记录；能对上 executionSessionId 才算「派工的执行会话」。
  const originBaseWorkspaceId = (() => {
    const own = canvas.workspaces.find((candidate) => candidate.id === session.workspaceId);
    return own?.kind === 'temporary' && own.source === 'worktree' ? own.baseWorkspaceId : null;
  })();
  const originCoordinator =
    originBaseWorkspaceId === null
      ? undefined
      : canvas.sessions.find((candidate) => candidate.workspaceId === originBaseWorkspaceId && coordinatorIds.has(candidate.id));
  const originDelegations = useDelegations(isCoordinatorSession ? null : originCoordinator?.id ?? null);
  const originRecord = originDelegations.rows.find((row) => row.executionSessionId === session.id) ?? null;
  const blocks = live?.blocks ?? [];
  // 乐观气泡、8 秒超时、重试/放弃、和 journal 对账：和画布卡片是同一份实现。
  const delivery = usePromptDelivery({
    sessionId: session.id,
    blocks,
    send: (text, attachments, clientMessageId) => api.prompt(session.id, text, attachments, clientMessageId)
  });
  const status = live?.status ?? session.status;
  const reason = live?.reason ?? null;
  // 每次只展示最近一次请求的观察值；刷新失败时不能继续展示过期的就绪/失败。
  const startupQuery = useQuery({
    queryKey: ['session-startup', session.id],
    queryFn: () => sessionStartupApi.get(session.id),
    retry: false,
    refetchInterval: 2_000,
    refetchIntervalInBackground: false
  });
  const startup = startupQuery.isError || !startupQuery.isFetchedAfterMount ? undefined : startupQuery.data;
  const startupState = startup?.state ?? 'unknown';
  const startupReason = startup?.state === 'failed' ? startup.reason : undefined;
  const startupText = startupState === 'starting' ? '正在启动运行时…'
    : startupState === 'ready' ? '运行时已就绪'
    : startupState === 'offline' ? '机器离线'
    : startupState === 'upgrade_required' ? '需要更新 Worker'
    : startupState === 'failed' ? startupReason === 'timed_out' ? '运行时启动超时' : '运行时启动失败'
    : '运行状态暂未确认';
  // 首页待办里的「等回答」是回合结束后的线索，不等于 runtime 正在阻塞。
  // 这里只读同一条 attention 缓存，用「当前这条会话是否还挂着 needs_answer」决定要不要提示回一句。
  const attention = useQuery({ queryKey: ['attention'], queryFn: api.attention, refetchInterval: 10_000 });
  // 删除会话：跑着的时候服务端会拒（409），菜单里先把原因写出来，别点下去才知道。
  const deleteHint = deleteSessionBlockedHint({ status });
  // 收起（interaction-borrowing §1）：做完的会话移出活跃列表；跑着的先别沉，停下来再说。
  const settled = session.settledAt != null;
  // 常驻：Worker 不按空闲回收这条会话，也不占保活上限。
  const pinned = session.pinned === true;
  const settle = settleGate({ settled, status });
  // 改名、分叉、收起、常驻、删除后的缓存改写：和侧栏行菜单是同一份（atoms/use-session-actions.ts）。
  const actions = useSessionActions(canvas.project.id);
  // 终端页签：会话跑着、机器在线、且没被探测成「不支持」才出现（docs/design/terminal.md §7）。
  const workers = useWorkers();
  const worker = resolveWorker(workers.list, session.workerId);
  const supportKeys = useMemo(
    () => terminalSupportKeys(session.workerId),
    [session.workerId]
  );
  // 机器列表还没拿到时先当在线：页签不该在首屏闪一下才出现。
  const workerOnline = workers.list.length === 0 || worker?.state === 'online';
  const terminalUnavailable = useSyncExternalStore(subscribeTerminalSupport, () => terminalBlocked(supportKeys));
  // 跑完的会话也能开：shell 直接开在会话工作目录里（hub 侧算好 cwd），不重启 agent。
  const terminalAvailable = !independentWorkdir && workerOnline && !terminalUnavailable;
  // 终端要看机器在线与探测结果；预览只要有会话就能看（机器离线时列表里那几行自己说清楚）。
  const tabs = useMemo(
    () => SESSION_TABS.filter((candidate) => candidate !== 'terminal' || terminalAvailable),
    [terminalAvailable]
  );  // 终端变得不可用（会话结束 / 机器掉线 / 探测到不支持）时退回对话，别停在空页上。
  useEffect(() => {
    if (tab === 'terminal' && !terminalAvailable) setTab('chat');
  }, [tab, terminalAvailable]);
  const agentLabel = agent?.label ?? session.agentId;
  const lastSeq = live?.lastSeq ?? session.lastSeq;
  // 这一轮结束了、后台还在跑（会话保活）：块序列里还在陆续有东西来，就低调说一句。
  const background = useBackgroundActivity(session.id, blocks, status, lastSeq);
  const backgroundNotice = backgroundActivityText(background, Date.now());
  /** 「查看」：滚到对话末尾，再把焦点交给记录区——键盘用户从这里接着往下读。 */
  function jumpToConversationEnd(): void {
    scrollToEnd();
    scroller.current?.focus({ preventScroll: true });
  }
  /** 子代理面板：push 进栈、pop 出栈；出栈到空就是关掉，焦点还给轨道。 */
  function navigateSubagent(next: readonly string[]): void {
    setSubagentPath(next);
    if (next.length === 0) requestAnimationFrame(() => subagentTrackRef.current?.focus());
  }
  // 块没了（换会话、重连后历史对不上）：面板别停在空页上。
  useEffect(() => {
    if (subagentPath.length === 0) return;
    if (resolveSubagentPath(blocks, subagentPath).length === subagentPath.length) return;
    setSubagentPath([]);
  }, [blocks, subagentPath]);
  const deliveriesBySeq = useDeliveries(session.id, lastSeq);
  const canvasLinkedIds = useMemo(
    () =>
      new Set(
        canvas.edges.flatMap((edge) => {
          if (edge.kind !== 'link') return [];
          if (edge.aSessionId === session.id) return [edge.bSessionId];
          if (edge.bSessionId === session.id) return [edge.aSessionId];
          return [];
        })
      ),
    [canvas.edges, session.id]
  );
  // 先按用户点击立刻显示，请求成功后把 canvas 缓存里的边补上；缓存到了再清掉覆盖值。
  const linkedSessions = useMemo(() => {
    const ids = new Set(canvasLinkedIds);
    for (const [id, linked] of linkOverrides) {
      if (linked) ids.add(id);
      else ids.delete(id);
    }
    return canvas.sessions.filter((candidate) => ids.has(candidate.id) && candidate.status !== 'failed');
  }, [canvasLinkedIds, canvas.sessions, linkOverrides]);
  const linkedIds = useMemo(() => new Set(linkedSessions.map((candidate) => candidate.id)), [linkedSessions]);
  // 连接从别处断掉（小窗里的按钮、芯片上的 ×、选择器）之后，小窗不能还挂在这。
  useEffect(() => {
    if (linkInfoId !== null && !linkedIds.has(linkInfoId)) setLinkInfoId(null);
  }, [linkInfoId, linkedIds]);

  /** 断开后芯片马上消失：焦点先落到芯片那一行，键盘用户不会掉回页面开头。 */
  function unlinkLinkedSession(otherId: string): void {
    void toggleLink(otherId, false);
    requestAnimationFrame(() => chipsRef.current?.focus());
  }
  // 运行时通过 ACP available_commands_update 报上来的命令。带参数提示的只补全命令名，让人接着写参数；
  // 不带参数的选中即发送（和运行时自己的 /init、/review 行为一致）。
  const runtimeCommands = useMemo(
    () =>
      (live?.commands ?? []).map((command) => {
        const insert = command.hint ? `/${command.name} ` : undefined;
        return {
          name: command.name,
          hint: command.description ?? command.hint ?? '运行时命令',
          ...(insert ? { insert } : {}),
          run: () => api.prompt(session.id, `/${command.name}`, [])
        };
      }),
    [live?.commands, session.id]
  );

  useEffect(() => {
    if (linkBusy === null) return;
    const desired = linkOverrides.get(linkBusy);
    if (desired === undefined || canvasLinkedIds.has(linkBusy) === desired) {
      setLinkBusy(null);
      linkBusyRef.current = false;
      setLinkOverrides((current) => {
        if (!current.has(linkBusy)) return current;
        const next = new Map(current);
        next.delete(linkBusy);
        return next;
      });
    }
  }, [canvasLinkedIds, linkBusy, linkOverrides]);

  async function toggleLink(otherId: string, next: boolean): Promise<void> {
    if (linkBusyRef.current) return;
    linkBusyRef.current = true;
    setLinkError(null);
    setLinkBusy(otherId);
    setLinkOverrides((current) => new Map(current).set(otherId, next));
    try {
      if (next) {
        const link = await api.createSessionLink(canvas.project.id, session.id, otherId);
        queries.setQueryData<CanvasDto>(['canvas', canvas.project.id], (current) => {
          if (!current || current.edges.some((edge) => edge.kind === 'link' && edge.aSessionId === link.aSessionId && edge.bSessionId === link.bSessionId)) return current;
          return { ...current, edges: [...current.edges, { kind: 'link' as const, aSessionId: link.aSessionId, bSessionId: link.bSessionId }] };
        });
      } else {
        await api.deleteSessionLink(canvas.project.id, session.id, otherId);
        queries.setQueryData<CanvasDto>(['canvas', canvas.project.id], (current) =>
          current
            ? {
                ...current,
                edges: current.edges.filter(
                  (edge) =>
                    !(
                      edge.kind === 'link' &&
                      ((edge.aSessionId === session.id && edge.bSessionId === otherId) || (edge.aSessionId === otherId && edge.bSessionId === session.id))
                    )
                )
              }
            : current
        );
      }
    } catch (failure) {
      setLinkOverrides((current) => {
        const next = new Map(current);
        next.delete(otherId);
        return next;
      });
      setLinkError(failure instanceof Error ? failure.message : '连接失败');
      setLinkBusy(null);
      linkBusyRef.current = false;
    }
  }
  const turnRunning = waitingForReply(live, status);
  // 窄屏：进度收成对话末尾一条、工作区收成一个入口。桌面布局一点不动。
  const deviceNarrow = useNarrow();
  const narrow = deviceNarrow || Boolean(windowChrome && viewWidth > 0 && viewWidth < 640);
  // 只有这一轮已经结束、会话也不在跑时，才把待答项当成「现在可以回」；
  // 正在跑的时候列表里可能还留着上一轮的线索，不能顺手说成当前阻塞。
  const answerItem =
    turnRunning || status === 'running'
      ? null
      : attention.data?.items.find((item) => item.sessionId === session.id && item.phase === 'needs_answer') ?? null;
  // 发了消息之后的那段空窗：说出「在启动 / 在等 / 在写 / 在用哪个工具」，秒数自己往前走。
  const progress = useTurnProgress(session.id, blocks, turnRunning, agentLabel);
  const forkHint = forkBlockedHint({ lastSeq, turnRunning, denied: agent?.capabilities.fork.state === 'denied' });
  // 回合结束（状态变了）刷新改动数：agent 可能刚改过文件
  useEffect(() => {
    const keys = filesKeys(repoWorkspaceId, session.id);
    for (const prefix of filesInvalidationKeys(keys)) {
      void queries.invalidateQueries({ queryKey: [...prefix, 'changes'] }, { cancelRefetch: false });
    }
    void queries.invalidateQueries({ queryKey: gitKeys.state(repoWorkspaceId, session.id) }, { cancelRefetch: false });
    // 下一轮开始后才生效，所以回合结束时重问一次环境版本：提示该消失时就消失。
    void queries.invalidateQueries({ queryKey: sessionKeys.environment(session.id) }, { cancelRefetch: false });
  }, [status, session.id, repoWorkspaceId, queries]);
  // 和 FilesBrowser 共用同一个查询 key（基准 = 会话开始），标签上的数字与改动页一致
  const changeQueries = useQueries({
    queries: (repo.isCombo && repo.members.length > 0 ? repo.members : [{ workspaceId: repo.selected ?? repoWorkspaceId, state: 'ready' as const }]).map((item) => ({
      ...FILES_QUERY,
      queryKey: [...fileKeys.changes('session'), item.workspaceId],
      queryFn: () => filesApi.changes(session.id, 'session', repo.isCombo ? item.workspaceId : repo.selected),
      enabled: !('state' in item) || item.state === 'ready'
    }))
  });
  // 没有 git 基准（非 git 目录）时算不出改动：标签上不写「改动 0」，免得读成「agent 什么都没改」
  const changeCount = (() => {
    const rows = changeQueries.map((item) => shown(item));
    if (rows.some((row) => row === undefined)) return undefined;
    if (rows.every((row) => row?.commit === null)) return undefined;
    return rows.reduce((sum, row) => sum + (row?.files.length ?? 0), 0);
  })();
  const workspace = canvas.workspaces.find((candidate) => candidate.id === repoWorkspaceId)
    ?? canvas.workspaces.find((candidate) => candidate.id === session.workspaceId);
  /** 工作区抽屉里显示哪个目录：优先当前看的那个仓库。 */
  const workspacePath = workspace?.path ?? workspaceRoot ?? null;
  // 和 OpenCode 一样把当前分支放在输入框旁边；分支可能被 agent 切换，所以回合结束后刷新。
  const gitStateQuery = useQuery({
    queryKey: gitKeys.state(repoWorkspaceId, session.id),
    queryFn: () => gitApi.state(session.id, repo.selected),
    // 组合工作空间的 git 接口必须带 ?member=：成员还没定下来时先别发，
    // 否则这一条会被服务端拒成 400，而 retry:false 会让抽屉里一直停在「暂未确认」。
    // 判据用会话自带的 groupId（一进页面就知道），不能等 context 把 isCombo 解析出来——
    // 那之前 isCombo 是 false，会先发一条不带 member 的请求。
    enabled: groupId === null ? workspace !== undefined && workspace.isGit !== false : repo.selected !== null,
    staleTime: 15_000,
    retry: false
  });
  const gitState = shown(gitStateQuery);
  const forkable = !busy && forkHint === null;
  const [gitOpen, setGitOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [provenanceOpen, setProvenanceOpen] = useState(false);
  const [rewindAt, setRewindAt] = useState<number | null>(null);
  useEffect(() => setRewindAt(null), [session.id]);
  // 每轮「改了 N 个文件」（ADR 0027 阶段 1 的检查点）：挂在这一轮最后、下一句问话之前
  const turns = shown(useQuery({ ...FILES_QUERY, queryKey: fileKeys.turns(), queryFn: () => filesApi.turns(session.id, repo.selected) })) ?? [];
  const doneTurns = turns.filter((t) => t.after !== null && (t.files ?? 0) > 0);
  // 排队 / 发送中 / 未送达的用户消息：只在原地淡一点、多一行小字，不搬家。
  // 以前它们会被抽到输入框上方的独立区块，一条消息在「列表末尾 → 底部区块 → 列表中间」
  // 跳三次，观感很碎，所以现在只打标不改变顺序。
  const held = heldPromptSeqs(deliveriesBySeq);
  const timelineBlocks = markQueued(blocks, held);
  // 显式要求显示的内容、需要回答的问题与失败工具都留在摘要外。
  const timelineItems = useMemo(
    () => groupTimeline(timelineBlocks, {
      running: turnRunning,
      groupable: (block) => block.kind === 'tool'
        ? settings.tools === 'collapsed' && questionOf(block) === null && block.result?.ok !== false
        : block.kind === 'thinking' && settings.thinking === 'collapsed'
    }),
    [timelineBlocks, settings.tools, settings.thinking, turnRunning]
  );
  const promptSeqs = timelineBlocks.filter((b) => b.kind === 'prompt').map((b) => b.seq);
  /** 问话 seq 之前那一轮（上一句问话开头的那轮）。 */
  const badgeBefore = (seq: number) => {
    const i = promptSeqs.indexOf(seq);
    return i > 0 ? (doneTurns.find((t) => t.promptSeq === promptSeqs[i - 1]) ?? null) : null;
  };
  const lastPrompt = promptSeqs[promptSeqs.length - 1];
  const lastBadge = lastPrompt === undefined ? null : (doneTurns.find((t) => t.promptSeq === lastPrompt) ?? null);
  // 两端共用同一条有证据的进度；其他消息的独立状态和操作仍留在原位。
  const newestPending = delivery.pending[delivery.pending.length - 1];
  const hint = turnHint({
        pending: delivery.pending,
        delivery: newestPending?.seq !== undefined && deliveriesBySeq.has(newestPending.seq)
          ? deliveriesBySeq.get(newestPending.seq)
          : lastPrompt === undefined ? undefined : deliveriesBySeq.get(lastPrompt),
        deliveries: deliveriesBySeq.values(),
        progress,
        uncertainDeliveryIds: live?.uncertainDeliveryIds,
        withdrawQueued: true
      });
  // 断线后的旧输出不能证明此刻仍在运行；送达层的独立反馈则仍然显示。
  const visibleHint = syncState && hint?.stage === 'runtime' ? null : hint;
  // 记录不完整时，隐藏运行时提示不应让气泡重新冒出被动的「发送中」。
  // 不确定送达仍须可见；失败和需要操作的排队状态由 DeliveryNote 自己保留。
  const lastDelivery = lastPrompt === undefined ? undefined : deliveriesBySeq.get(lastPrompt);
  const quietLastPrompt = delivery.pending.length === 0 && (visibleHint !== null || (
    Boolean(syncState) && !(lastDelivery && live?.uncertainDeliveryIds?.includes(lastDelivery.id))
  ));
  // 批准卡仍然保留原有回合和停止行为；只让动画为尚未处理的批准让位。
  const currentTurn = lastPrompt === undefined ? blocks : blocks.filter((block) => block.seq > lastPrompt);
  const hasPendingApproval = currentTurn.some((block) => block.kind === 'approval' && block.resolved === null);
  /**
   * 输入框上方那条：桌面是「正在做什么 / 分支」，窄屏不重复进度（已移到对话末尾），
   * 只留一个「工作区」入口——分支、路径、加仓库都在里面。
   */
  const showStatusRow = Boolean(live?.contextUsage || (!narrow && (gitState?.isGit || repo.isCombo)));
  const openTurn = (turn: number) => showChanges({ base: `turn:${turn}` });
  // 任务上的 PR（打开任务时服务端顺手同步状态）；主会话没有任务，就不问
  const sessionTaskId = session.taskId;
  const taskPrsQuery = useQuery({
    queryKey: taskKeys.pullRequests(sessionTaskId ?? 'no-task'),
    queryFn: () => gitApi.taskPullRequests(sessionTaskId ?? ''),
    enabled: sessionTaskId !== null,
    staleTime: 60_000,
    retry: false
  });
  const taskPrs = taskPrsQuery.data ?? [];
  /**
   * 环境（资产 / MCP / 启动配置）改过但没有重新托管：只用来说一句「下一轮生效」。
   * 30s 内不重复问；切回窗口时问一次（在别处改完设置回来就能看到）。
   * 不做轮询：这是慢变量，变了也不会自己变回去，多问只是噪声。
   */
  const environment = useQuery({
    queryKey: sessionKeys.environment(session.id),
    queryFn: () => api.sessionEnvironment(session.id),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: false
  });
  const envNotice = environmentNotice(environment.data);
  const origin = session.origin;
  const forkSource = origin.kind === 'fork' ? canvas.sessions.find((candidate) => candidate.id === origin.fromSessionId) ?? null : null;
  const sourceName = forkSource ? sessionName(canvas, forkSource) : '来源会话';
  const [inherited, setInherited] = useState<readonly Block[]>([]);
  const showAuthor = multipleAuthors([...inherited, ...blocks]);
  useEffect(() => {
    setInherited([]);
    if (origin.kind !== 'fork') return;
    let cancelled = false;
    void api
      .events(origin.fromSessionId)
      .then((entries) => {
        if (!cancelled) setInherited(inheritedBlocks(entries, origin.atSeq));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session.id, origin.kind, origin.kind === 'fork' ? origin.fromSessionId : '', origin.kind === 'fork' ? origin.atSeq : 0]);

  function startRename() {
    setTitleDraft(session.title ?? '');
    setRenaming(true);
  }

  function saveRename() {
    setRenaming(false);
    if (normalizeSessionTitle(titleDraft) === (session.title ?? '')) return;
    void run(() => actions.rename(session, titleDraft));
  }

  function fork() {
    void run(async () => {
      const created = await actions.fork(session);
      onOpenSession(created.id);
    });
  }

  /**
   * 收起 / 移回活跃列表：先就地改画布的缓存，侧栏和卡片立刻反应；
   * 再让画布与首页去问服务端要真数据。失败落在 Composer 上方的就地错误里（和改名、分叉一样）。
   */
  async function setSettled(next: boolean): Promise<void> {
    await run(() => actions.setSettled(session, next));
  }

  /**
   * 常驻开关：先把画布缓存和单条会话缓存里的 `pinned` 改成目标值，卡片上的小图钉和头部标记
   * 立刻反应；失败翻回原值，错误落在 Composer 上方的就地提示里。
   */
  async function setPinned(next: boolean): Promise<void> {
    await run(() => actions.setPinned(session, next));
  }

  async function run(action: () => Promise<unknown>, refreshAfter = true): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await action();
      // 改可调项的回执已经带了配置投影，调用方会让这里跳过整张画布刷新。
      if (refreshAfter) onChanged();
      return true;
    } catch (failure) {
      setError((failure as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  /**
   * 先把用户的气泡放上去，再等服务端把 prompt 写进 journal。慢的是 ensureHosted，不该让输入框空着等。
   * 回执只说明「已接收」；真正让气泡消失的是 journal 里出现同一个 clientMessageId。
   */
  async function sendMessage(text: string, attachments: readonly AttachmentInputDto[]): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const pending = delivery.deliver(text, attachments);
      // 立即恢复跟随，乐观气泡提交后由观察器贴底；之后的读者手势仍可打断。
      scrollToEnd(false);
      await pending;
      // 新回合已经交出去：让待办/角标尽快按新事件重算，别还挂着刚才那条「等回答」。
      void queries.invalidateQueries({ queryKey: ['attention'] });
      void queries.invalidateQueries({ queryKey: ['deliveries', session.id] });
      void queries.invalidateQueries({ queryKey: ['session-startup', session.id] });
      onChanged();
      return true;
    } catch (failure) {
      setError((failure as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  /**
   * 发送并新建：这一句已经由 Composer 走 sendMessage 发出去了，这里只负责用同一条会话的参数
   * 派生下一条、跳过去。派生失败就留在原地——草稿不会因为跳走而消失。
   * 主会话没有归属任务，派生要落在任务上，所以这条动作对它不出现（见 Composer 的 onSendAndNew）。
   */
  async function sendAndNew(): Promise<void> {
    const taskId = session.taskId;
    if (taskId === null) return;
    await run(async () => {
      const created = await api.derive({
        taskId,
        agentId: session.agentId,
        model: session.model,
        ...(groupId !== null ? { groupId } : { workspaceId: session.workspaceId }),
        ...(session.workerId === null ? {} : { workerId: session.workerId })
      });
      // 先把画布缓存换成含新会话的那一份再跳：专注页按 id 在画布里找会话，找不到会退回画布。
      await queries.invalidateQueries({ queryKey: ['canvas', canvas.project.id] });
      onOpenSession(created.id);
    });
  }

  /** 未送达：用同一个 clientMessageId 重发，服务端幂等，重发不会变成两条。 */
  async function retryPending(pending: PendingPrompt): Promise<void> {
    setError(null);
    try {
      await delivery.retry(pending);
      onChanged();
    } catch (failure) {
      setError((failure as Error).message);
    }
  }

  // 宽屏的详情停靠在对话右边，不压住对话；画布里的浮窗太窄，照旧用抽屉
  const docked = wide && !windowChrome;
  const detailsPanel = details ? (
    <SessionDetails
      canvas={canvas}
      session={session}
      artifacts={artifacts}
      live={live}
      docked={docked}
      onClose={() => setDetails(false)}
      onBrowseFiles={() => { setDetails(false); setTab('files'); }}
    />
  ) : null;
  return (
    <div ref={viewRef} data-focus-view className="flex min-h-0 flex-1 bg-canvas">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header
        className={`flex h-[48px] shrink-0 items-center gap-2 border-b border-hair px-2 md:h-12 md:px-3 ${windowChrome ? 'window-drag cursor-move select-none' : ''}`}
        style={windowChrome?.onSwipe ? { touchAction: 'pan-y' } : undefined}
        data-testid={windowChrome?.onSwipe ? 'window-swipe-strip' : windowChrome ? 'window-titlebar' : 'focus-header'}
        onPointerDown={windowChrome?.onSwipe ? (event) => { swipeStart.current = { x: event.clientX, y: event.clientY }; } : undefined}
        onPointerUp={windowChrome?.onSwipe ? (event) => { const from = swipeStart.current; swipeStart.current = null; if (!from) return; const dx = event.clientX - from.x; if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(event.clientY - from.y)) windowChrome.onSwipe?.(dx < 0 ? 1 : -1); } : undefined}
      >
        {onBack ? (
          <button className="flex h-[44px] min-w-[44px] shrink-0 items-center justify-center px-1 text-meta text-tertiary hover:text-primary md:h-9 md:min-w-0" onClick={onBack} aria-label="返回">
            ←<span className="hidden sm:inline">&nbsp;返回</span>
          </button>
        ) : null}
        {onProjectNavigation ? <button type="button" className="flex size-[44px] shrink-0 items-center justify-center text-tertiary hover:text-primary md:hidden" aria-label="项目与全部会话" title="项目与全部会话" onClick={onProjectNavigation}>☰</button> : null}
        <div className="min-w-0 flex-1">
          {renaming ? (
            <input
              autoFocus
              value={titleDraft}
              maxLength={80}
              placeholder={task?.title ?? '会话名'}
              aria-label="会话名"
              data-testid="session-title-input"
              className="h-7 w-full rounded-sm border border-hair bg-card px-1.5 text-body text-primary outline-none focus:border-ring"
              onChange={(e) => setTitleDraft(e.target.value)}
              onPointerDown={(e) => e.stopPropagation()}
              onBlur={saveRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') setRenaming(false);
              }}
            />
          ) : (
            <div className="flex min-w-0 items-center gap-1"><button
              type="button"
              className="block max-w-full truncate text-left text-body text-primary hover:underline decoration-dotted"
              title="点击重命名"
              data-testid="session-title"
              onClick={startRename}
            >
              {session.title || task?.title || (coordinatorIds.has(session.id) ? COORDINATOR_TITLE : UNASSIGNED_TITLE)}
            </button>{pinned ? <PinnedMark testId="session-pinned-mobile" className="size-3 text-secondary md:hidden" /> : null}</div>
          )}
          <p className={`${narrow ? 'hidden' : 'hidden md:flex'} min-w-0 items-center gap-1 font-mono text-meta text-tertiary`}>
            <span className="truncate">
              {session.title && task ? `${task.title} · ` : ''}{agentLabel} · 配置模型：{modelLabel(session.model)}
              {origin.kind === 'fork' ? ` · 分叉自「${sourceName}」` : ''}
            </span>
            {/* 常驻标记放在状态行里：窄屏标题被截断时这一枚也不会换行 */}
            {pinned ? <PinnedMark testId="session-pinned" className="size-3 text-secondary" /> : null}
          </p>
        </div>
        <StatusPill
          status={status}
          reason={reason}
          lastSeq={live?.lastSeq ?? session.lastSeq}
          attention={status === 'done' && answerItem ? { possible: answerItem.possible } : null}
        />
        {documentTabs ?? (narrow && !independentWorkdir ? <SessionSwitcher canvas={canvas} session={session} compact status={status} lastSeq={live?.lastSeq ?? session.lastSeq} onOpen={onOpenSession} /> : null)}
        <span className="flex shrink-0 items-center">
          <button
            className={`${narrow ? 'hidden' : 'hidden md:flex'} h-11 shrink-0 items-center rounded-sm px-1.5 text-meta text-tertiary hover:text-primary md:px-2 md:h-9`}
            aria-label={`连接 ${linkedSessions.length}`}
            onClick={() => setLinksOpen(true)}
            title="连接同项目的其他会话"
          >
            连接 {linkedSessions.length}
          </button>
          <button
            className={`${narrow ? 'hidden' : 'hidden md:flex'} h-11 items-center rounded-sm px-2 text-meta text-tertiary hover:text-primary md:h-9`}
            aria-pressed={details}
            onClick={() => setDetails((open) => !open)}
          >
            详情
          </button>
          <span className={narrow ? 'hidden' : 'hidden md:flex'}>
            <DisplayMenu settings={settings} onChange={changeSettings} />
          </span>
          <Dropdown key={session.id} label="更多" icon="⋯" triggerRef={moreRef} testId="session-more-trigger" menuClassName="max-h-[min(75dvh,640px)] overflow-y-auto overscroll-contain">
            {(close) => (
              <SessionMenuPages narrow={narrow}>{(page, navigate) => <>
                {narrow && page === 'home' ? <MenuGroup label="工具">
                  {tabs.filter((t) => t !== 'chat').map((t) => <MenuItem key={t} className="min-h-[44px]" title={sessionTabLabel(t, t === 'changes' ? changeCount : undefined)} testId={`session-more-${t}`} onClick={() => { close(); setTab(t); }} />)}
                  <MenuItem className="min-h-[44px]" title="工作区" testId="session-more-workspace" onClick={() => { close(); setWorkspaceOpen(true); }} />
                  {onSearch ? <MenuItem className="min-h-[44px]" title="搜索任务与会话" onClick={() => { close(); onSearch(); }} /> : null}
                  <MenuItem className="min-h-[44px] border-t border-hair" title="会话与显示 ›" testId="session-more-details" onClick={() => navigate('details')} />
                  <MenuItem className="min-h-[44px]" title="会话操作与预设 ›" testId="session-more-actions" onClick={() => navigate('actions')} />
                </MenuGroup> : null}
                {narrow && page === 'details' ? <MenuGroup label="会话与显示">
                  <MenuItem title="会话来历" testId="session-more-provenance" onClick={() => { close(); setProvenanceOpen(true); }} />
                  <MenuItem
                    title="详情"
                    hint="查看会话、工作目录和用量"
                    onClick={() => {
                      close();
                      setDetails(true);
                    }}
                  />
                  <MenuItem
                    title="连接会话…"
                    hint="把这条会话和同项目的其他会话连起来"
                    onClick={() => {
                      close();
                      setLinksOpen(true);
                    }}
                  />
                  <MenuItem
                    title="显示设置…"
                    hint="工具调用、思考过程、紧凑模式"
                    onClick={() => {
                      close();
                      setDisplayOpen(true);
                    }}
                  />
                </MenuGroup> : null}
                {!narrow || page === 'actions' ? <>
                {narrow ? <MenuGroup label="继续会话"><MenuItem title="交给其他 Agent 继续" hint="新建会话，带上下文继续" testId="agent-handoff-trigger" onClick={() => { close(); moreRef.current?.focus(); setMobileHandoffSession(session.id); }} /></MenuGroup> : null}
                <MenuGroup label="这次会话" className="border-t border-hair md:border-t-0">
                  <MenuItem
                    title="分叉"
                    hint={forkHint ?? FORK_HINT}
                    disabled={!forkable}
                    onClick={() => {
                      close();
                      fork();
                    }}
                  />
                  <MenuItem
                    title="开一条侧聊…"
                    hint={session.taskId === null
                      ? '这条会话还没归到任务：先派工到任务才能开侧聊'
                      : session.kind === 'side' ? '侧聊不能再生侧聊' : '用同一个工作目录和模型，单独问一轮，不打断这条会话'}
                    testId="session-side-open"
                    disabled={session.taskId === null || session.kind === 'side' || !('workspaceId' in session && session.workspaceId !== null)}
                    onClick={() => {
                      close();
                      void run(async () => {
                        const taskId = session.taskId;
                        if (taskId === null) return;
                        const created = await api.derive({
                          taskId,
                          agentId: session.agentId,
                          model: session.model,
                          kind: 'side',
                          parentSessionId: session.id
                        });
                        onOpenSession(created.id);
                      });
                    }}
                  />
                  {isCoordinatorSession ? (
                    <MenuItem
                      title="派工到任务…"
                      hint="选一个同项目的任务，让它在这个仓库的独立目录里干活，主目录不动"
                      testId="session-delegate"
                      onClick={() => {
                        close();
                        setDelegating(true);
                      }}
                    />
                  ) : null}
                  <MenuItem
                    title="换个地方继续…"
                    hint={session.taskId === null                      ? '这条会话还没归到任务：换个地方继续要给任务建目录'
                      : canContinueElsewhere(session) ? '换台机器或工作目录，带着会话摘要接着做' : CONTINUE_DISABLED_HINT}
                    disabled={session.taskId === null || !canContinueElsewhere(session)}
                    onClick={() => {
                      close();
                      setContinuing(true);
                    }}
                  />
                  <MenuItem
                    title={settled ? '移回活跃列表' : '收起：移出活跃列表'}
                    hint={settle.hint}
                    disabled={settle.disabled}
                    testId="session-settle"
                    onClick={() => {
                      close();
                      void setSettled(!settled);
                    }}
                  />
                  <MenuItem
                    title={pinned ? '取消常驻' : '设为常驻'}
                    hint={pinHint(pinned)}
                    testId="session-pin"
                    onClick={() => {
                      close();
                      void setPinned(!pinned);
                    }}
                  />
                  <MenuItem
                    title="删除会话…"
                    hint={deleteHint ?? DELETE_HINT}
                    disabled={deleteHint !== null}
                    danger
                    testId="session-delete"
                    onClick={() => {
                      close();
                      setDeleting(true);
                    }}
                  />
                </MenuGroup>
                <MenuGroup label="代码" className="border-t border-hair">
                  <MenuItem
                    title="提交与推送…"
                    hint="提交改动、推送分支、开 PR；说明由模型起草，可改"
                    onClick={() => {
                      close();
                      setGitOpen(true);
                    }}
                  />
                </MenuGroup>
                <MenuGroup label="启动预设" className="border-t border-hair">
                  <MenuItem
                    title="保存为启动预设…"
                    hint="把这条会话的 agent、模型和选项存成下次可直接套用的组合"
                    onClick={() => {
                      close();
                      setProfileOpen(true);
                    }}
                  />
                  <MenuItem
                    title="管理启动预设…"
                    hint="改名、改模型、复制或删除已保存的启动组合"
                    onClick={() => {
                      close();
                      setProfilesOpen(true);
                    }}
                  />
                </MenuGroup>
                </> : null}
              </>}</SessionMenuPages>
            )}
          </Dropdown>
          {windowChrome?.actions}
        </span>
      </header>
      {!narrow && !independentWorkdir && !documentTabs ? <SessionSwitcher canvas={canvas} session={session} compact={false} status={status} lastSeq={live?.lastSeq ?? session.lastSeq} onOpen={onOpenSession} /> : null}
      {narrow ? <MobileHandoff key={session.id} session={session} projectId={canvas.project.id} open={mobileHandoffSession === session.id} onClose={() => setMobileHandoffSession(null)} restoreFocusRef={moreRef} /> : null}
      {session.kind === 'side' ? (
        <button
          type="button"
          onClick={() => session.parentSessionId && onOpenSession(session.parentSessionId)}
          className="flex shrink-0 items-center gap-2 border-b border-hair px-3 py-2 text-left text-sub text-secondary hover:bg-card"
          data-testid="side-session-banner"
        >
          <span className="rounded bg-card px-1.5 py-0.5 text-meta text-tertiary">侧聊</span>
          <span className="min-w-0 flex-1 truncate">这条会话是侧聊：用主会话的工作目录单独问了一轮</span>
          <span className="shrink-0 text-link">返回主会话</span>
        </button>
      ) : null}
      <div className={narrow ? 'hidden' : 'hidden md:contents'}><ProvenanceRow sessionId={session.id} />
      <WorktreeStatusLine workspace={workspace} projectId={canvas.project.id} />
      {groupId !== null ? <SessionGroupLine groupId={groupId} /> : null}</div>
      {narrow && provenanceOpen ? <Sheet title="会话来历" testId="session-provenance-sheet" onClose={() => setProvenanceOpen(false)}><ProvenanceRow sessionId={session.id} /><WorktreeStatusLine workspace={workspace} projectId={canvas.project.id} />{groupId !== null ? <SessionGroupLine groupId={groupId} /> : null}</Sheet> : null}
      <AttentionAutoAck sessionId={session.id} />
      {isCoordinatorSession ? (
        <DelegationPanel
          coordinatorSessionId={session.id}
          tasks={canvas.tasks}
          onOpenSession={onOpenSession}
          onStart={() => setDelegating(true)}
        />
      ) : originRecord === null ? null : (
        <DelegationOriginBanner
          record={originRecord}
          taskTitle={task?.title ?? null}
          onBack={() => onOpenSession(originRecord.coordinatorSessionId)}
        />
      )}
      {taskPrs.length > 0 ? <div className="shrink-0 border-b border-hair px-2 py-1 md:px-3"><PullRequestChips prs={taskPrs} /></div> : null}
      {gitOpen ? <GitDialog sessionId={session.id} workspaceId={repoWorkspaceId} member={repo.selected} taskId={session.taskId} onClose={() => setGitOpen(false)} switcher={switcher} /> : null}
      {/* 工作区抽屉：git 状态三态——拿到结论就用结论；查询没跑起来（离线 / 出错）时，
          只有工作区登记里明确写了「不是 git」才敢说不是，否则是「暂未确认」。 */}
      {narrow && workspaceOpen ? (
        <WorkspaceSheet
          path={workspacePath}
          branch={gitState?.branch ?? null}
          isGit={gitState === undefined ? (workspace?.isGit === false ? false : null) : gitState.isGit}
          ahead={gitState === undefined ? null : gitState.ahead}
          changes={gitState === undefined ? null : gitState.files.length}
          switcher={sheetSwitcher}
          repoHint={sheetRepoHint}
          onOpenGit={() => {
            setWorkspaceOpen(false);
            setGitOpen(true);
          }}
          onClose={() => setWorkspaceOpen(false)}
        />
      ) : null}
      {delegating ? (
        <DelegateDialog
          canvas={canvas}
          session={session}
          onClose={() => setDelegating(false)}
          onStarted={() => setDelegating(false)}
        />
      ) : null}
      {subagentPath.length > 0 ? (
        <SubagentPanel
          blocks={blocks}
          path={subagentPath}
          sessionId={session.id}
          agentLabel={agentLabel}
          settings={settings}
          onNavigate={navigateSubagent}
        />
      ) : null}
      {rewindAt !== null ? (
        <RewindDialog sessionId={session.id} workspaceId={session.workspaceId} promptSeq={rewindAt} onClose={() => setRewindAt(null)}
          onDone={(id, prompt) => { setRewindAt(null); onSeedDraft?.(id, prompt); onChanged(); onOpenSession(id); }} />
      ) : null}
      {/* 右侧 pr 是给绝对定位的刷新指示器留的固定位置：它永远占这么宽，指示器出现或消失都不会让页签重排 */}
      <div className={`relative shrink-0 items-center border-b border-hair pr-6 ${narrow ? 'hidden' : 'hidden md:flex'}`}>
      <div role="tablist" aria-label="会话视图" className="flex gap-1 py-1.5 pl-3" data-testid="session-tabs">
        {tabs.map((t) => (
          <button
            key={t}
            role="tab"
            id={`session-tab-${t}`}
            aria-selected={tab === t}
            tabIndex={tab === t ? 0 : -1}
            onClick={() => setTab(t)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              const delta = e.key === 'ArrowRight' ? 1 : -1;
              let next = stepTab(tab, delta);
              // 终端页签可能被藏起来：跳过它，别把焦点送到不存在的 tab 上。
              if (next === 'terminal' && !terminalAvailable) next = stepTab(next, delta);
              setTab(next);
              (e.currentTarget.parentElement?.querySelector(`#session-tab-${next}`) as HTMLElement | null)?.focus();
            }}
            className={`flex h-11 flex-1 items-center justify-center rounded-sm px-3 text-sub md:h-8 md:flex-none ${tab === t ? 'bg-card-raised text-primary' : 'text-tertiary hover:text-secondary'}`}
            data-testid={`session-tab-${t}`}
          >
            {sessionTabLabel(t, t === 'changes' ? changeCount : undefined)}
          </button>
        ))}
      </div>
        {splitAvailable ? <button type="button" data-testid="changes-split-toggle" className={`ml-2 rounded-sm px-2 py-1.5 text-meta ${splitChanges ? 'bg-card-raised text-primary' : 'text-secondary hover:bg-card-raised hover:text-primary'}`} onClick={() => {
          const enabled = !splitChanges;
          storeChangesSplit(session.id, enabled);
          setPreferSplit(enabled);
          setTab('chat');
          if (enabled) {
            setDetails(false);
            requestAnimationFrame(() => splitHeadingRef.current?.focus());
          }
        }}>{splitChanges ? '关闭并排改动' : preferSplit && tab === 'changes' ? '返回并排' : '并排查看改动'}</button> : null}
        {tab !== 'chat' && tab !== 'terminal' && tab !== 'preview' && refreshing ? (
          <span
            role="status"
            aria-live="polite"
            aria-label="正在刷新文件列表"
            title="正在刷新文件列表"
            data-testid="files-refreshing"
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-tertiary md:right-3"
          >
            {/* 6px 圆环转圈；系统开了「减少动态效果」就停转、变成实心小点，别让指示彻底消失 */}
            <span
              aria-hidden
              className="block size-1.5 animate-spin rounded-full border-[1.5px] border-tertiary/35 border-t-tertiary motion-reduce:animate-none motion-reduce:border-transparent motion-reduce:bg-tertiary"
            />
          </span>
        ) : null}
      </div>
      {tab !== 'chat' && narrow ? <div className="flex min-h-[44px] shrink-0 items-center gap-3 border-b border-hair px-3"><button type="button" data-testid="session-back-to-chat" className="min-h-[44px] text-sub text-link" onClick={() => setTab('chat')}>← 返回对话</button><span className="text-sub text-secondary">{sessionTabLabel(tab, tab === 'changes' ? changeCount : undefined)}</span></div> : null}
      {visited.has('files') ? (
        <div key={`${session.id}-files`} className={tab === 'files' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
          <FilesBrowser tab="files" sessionId={session.id} workspaceId={repoWorkspaceId} member={repo.selected} status={status} reveal={reveal} onQuote={quoteToChat} switcher={switcher} members={repo.members} />
        </div>
      ) : null}
      {/* 终端和文件页一样：首访后保持挂载（hidden 不卸载），切回来还是同一个 shell 画面 */}
      {terminalAvailable && visited.has('terminal') ? (
        <div key={`${session.id}-terminal`} className={tab === 'terminal' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
          <TerminalPanel
            sessionId={session.id}
            workerId={session.workerId}
            active={tab === 'terminal'}
            notice={status === 'running' ? null : 'agent 现在没在跑：终端只开一个 shell，不会启动 agent。在对话里接着说一句，agent 会重新接上。'}
          />
        </div>
      ) : null}
      {/* 预览和终端一样：首访后保持挂载（hidden 不卸载），切回来表单里没提交的内容还在 */}
      {visited.has('preview') ? (
        <div key={`${session.id}-preview`} className={tab === 'preview' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
          <PreviewPanel sessionId={session.id} active={tab === 'preview'} defaultPort={canvas.project.previewPort ?? null} />
        </div>
      ) : null}
      {profileOpen ? (
        <SaveAgentProfileDialog
          session={session}
          agentLabel={agentLabel}
          expectsOptions={(agent?.options.length ?? 0) > 0}
          onClose={() => setProfileOpen(false)}
          onSaved={() => setProfileOpen(false)}
        />
      ) : null}
      {profilesOpen ? <AgentProfilesDialog agents={canvas.agents} onClose={() => setProfilesOpen(false)} /> : null}
      {linksOpen ? (
        <SessionLinksDialog
          sessions={canvas.sessions}
          currentId={session.id}
          linked={linkedIds}
          openings={canvas.openings}
          agents={canvas.agents}
          tasks={canvas.tasks}
          workspaces={canvas.workspaces}
          busyId={linkBusy}
          error={linkError}
          onToggle={(otherId, next) => void toggleLink(otherId, next)}
          onClose={() => {
            setLinksOpen(false);
            setLinkError(null);
          }}
        />
      ) : null}
      {displayOpen ? <DisplaySettingsDialog settings={settings} onChange={changeSettings} onClose={() => setDisplayOpen(false)} /> : null}
      {docked ? null : detailsPanel}
      {continuing ? (
        <ContinueDialog
          canvas={canvas}
          session={session}
          onClose={() => setContinuing(false)}
          onDone={(created) => {
            setContinuing(false);
            onChanged();
            onOpenSession(created.id);
          }}
        />
      ) : null}

      {deleting ? (
        <DeleteSessionDialog
          session={session}
          opening={canvas.openings[session.id]}
          onClose={() => {
            setDeleting(false);
            // 焦点还给「⋯」：不然焦点落回 body，键盘用户得从头 Tab。
            moreRef.current?.focus();
          }}
          onDeleted={() => {
            // 先就地摘掉，画布窗口、打开的会话都立刻跟着消失；再让外层重拉服务端的真数据。
            actions.forget(session.id);
            setDeleting(false);
            onChanged();
          }}
        />
      ) : null}

      {/* 会话内搜索：夹在页签和对话区之间，只有对话页签用得上；命中数由它直接写在下面这个滚动容器上 */}
      <div className={`flex min-h-0 min-w-0 flex-1 ${tab === 'chat' || tab === 'changes' ? '' : 'hidden'}`}>
      <div className={`flex min-h-0 min-w-0 flex-1 flex-col ${tab === 'chat' ? '' : 'hidden'}`}>
      <FindInSession open={findOpen && tab === 'chat'} onOpenChange={setFindOpen} scrollerRef={scroller} resetKey={session.id} />

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scroller}
          // 程序化聚焦的落点（「查看」跳转过来）：不是 Tab 停靠站，但焦点环要看得见。
          tabIndex={-1}
          // overflow-anchor:none：位置由 useStickToBottom 自己钉（贴底 / 停住），
          // 浏览器的二次锚定会在内容补长时偷偷改 scrollTop，和状态机打架。
          className="min-h-0 flex-1 overflow-y-auto outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [overflow-anchor:none]"
        >
          <div
            role="log"
            aria-label="会话记录"
            data-compact={settings.compact ? 'true' : undefined}
            className={`mx-auto flex max-w-[760px] flex-col ${settings.compact ? 'gap-2 px-3 py-3 text-[0.95em]' : 'gap-4 px-4 py-6'}`}
          >
            {origin.kind === 'fork' && inherited.length > 0 ? (
              <section aria-label="分叉前的会话" className="flex flex-col gap-4 opacity-60" data-testid="fork-inherited">
                {inherited.map((block, index) => (
                  <ChatBlock key={index} block={block} agentLabel={agentLabel} sessionId={origin.fromSessionId} settings={settings} last={false} running={false} showAuthor={showAuthor} />
                ))}
              </section>
            ) : null}
            {origin.kind === 'fork' ? (
              <div role="separator" aria-label="分叉点" className="flex items-center gap-3 text-meta text-tertiary" data-testid="fork-divider">
                <span className="h-px flex-1 border-t border-dashed border-sage" />
                <span className="shrink-0">
                  从「
                  <button className="text-sage underline-offset-2 hover:underline" onClick={() => onOpenSession(origin.fromSessionId)}>
                    {sourceName}
                  </button>
                  」分叉 · {localTime(session.createdAt)}
                </span>
                <span className="h-px flex-1 border-t border-dashed border-sage" />
              </div>
            ) : null}
            {/* 有记录时保留状态行；空会话加载完成后不留空栏。 */}
            {blocks.length > 0 || delivery.pending.length > 0 || historyState !== 'loaded' || syncState ? <div className="min-h-11">
              {historyState !== 'loaded' ? (
                <div data-testid="session-history-state" role={historyState === 'error' ? 'alert' : 'status'} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-tertiary">
                  <span>{historyState === 'error' ? '会话记录读取失败' : '正在读取会话记录…'}</span>
                  {historyState === 'error' ? <button type="button" onClick={onRetryHistory} className="min-h-11 text-sage underline underline-offset-2">重试</button> : null}
                </div>
              ) : syncState ? (
                <div data-testid="session-sync-state" data-state={syncState} role={syncState === 'stale' ? 'alert' : 'status'} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-tertiary">
                  <span>{syncState === 'syncing' ? '正在补齐会话记录…' : '会话记录未同步'}</span>
                  {syncState === 'stale' && onRetrySync ? <button type="button" onClick={onRetrySync} className="min-h-11 text-sage underline underline-offset-2">重试</button> : null}
                </div>
              ) : null}
            </div> : null}
            <div
              data-testid="session-startup-status"
              data-state={startupState}
              data-reason={startupReason}
              role="status"
              className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-meta ${startupState === 'failed' || startupState === 'upgrade_required' || startupState === 'offline' ? 'text-rust' : 'text-secondary'}`}
            >
              <span>{startupText}</span>
              {startupState === 'offline' ? <span>· 消息可先排队，机器恢复后等待投递</span> : null}
              {startupState === 'failed' ? <span>· 有排队消息时，可在队首重试或撤回</span> : null}
              {startupState === 'upgrade_required' ? <a className="min-h-11 content-center underline underline-offset-2" href={session.workerId ? `#/machines/${encodeURIComponent(session.workerId)}` : '#/machines'}>查看机器并更新</a> : null}
            </div>
            {blocks.length === 0 && delivery.pending.length === 0 ? historyState === 'loaded' && !syncState ? (
              <p className="text-meta text-tertiary">这条会话还没有说话。在下面写一句，交给 {agentLabel}。</p>
            ) : null : (
              <FileLinksContext.Provider value={fileLinks}>
                <DeliveryContext.Provider value={{ sessionId: session.id, bySeq: deliveriesBySeq, quietSeq: quietLastPrompt ? lastPrompt : undefined, withdrawQueued: true, startupFailed: startupState === 'failed', uncertainDeliveryIds: live?.uncertainDeliveryIds }}>
                  {timelineItems.map((item) => {
                    const renderBlock = ({ block, index, recovered }: { block: (typeof timelineBlocks)[number]; index: number; recovered: boolean }, inWork = false) => (
                      <ChatBlock
                        key={index}
                        block={block}
                        agentLabel={agentLabel}
                        sessionId={session.id}
                        settings={inWork && block.kind === 'thinking' ? { ...settings, thinking: 'shown' } : settings}
                        last={index === timelineBlocks.length - 1}
                        running={turnRunning}
                        stale={Boolean(syncState)}
                        showAuthor={showAuthor}
                        queued={block.queued === true}
                        recovered={recovered}
                        searchOpen={findOpen}
                        onQuoteMessage={quoteMessageToChat}
                      />
                    );
                    if (item.type === 'work') {
                      return (
                        <WorkGroup key={`${session.id}:${item.key}`} summary={item.summary} defaultOpen={item.open} live={item.live} stale={Boolean(syncState)} forceOpen={findOpen}>
                          {(open, mounted) => item.items.map((entry) => entry.block.kind === 'text' ? renderBlock(entry) : (
                            <div key={entry.index} data-testid="work-group-entry" hidden={!open}>{mounted ? renderBlock(entry, true) : null}</div>
                          ))}
                        </WorkGroup>
                      );
                    }
                    const { block, index } = item;
                    return (
                      <TurnFrag key={index} badge={block.kind === 'prompt' ? badgeBefore(block.seq) : null} onOpen={openTurn}
                        onRewind={block.kind === 'prompt' && block.seq > 0 ? () => setRewindAt(block.seq) : null}>
                        {renderBlock(item)}
                      </TurnFrag>
                    );
                  })}
                  {lastBadge ? <TurnBadge turn={lastBadge} onOpen={openTurn} /> : null}
                  {/* 还没写进对话的消息：就是列表末尾的普通气泡，和 journal 用的是同一套外壳 */}
                  <PendingPrompts
                    pending={delivery.pending}
                    onRetry={(pending) => void retryPending(pending)}
                    onDiscard={delivery.discard}
                    quiet={visibleHint !== null || Boolean(syncState)}
                    hasDelivery={(pending) => pending.seq !== undefined && deliveriesBySeq.has(pending.seq)}
                    className={settings.compact ? 'gap-2' : 'gap-4'}
                    renderPrompt={(pending, _index, seq) => (
                      <ChatBlock
                        block={{ kind: 'prompt', text: pending.text, attachments: [], seq: pending.seq ?? seq }}
                        agentLabel={agentLabel}
                        sessionId={session.id}
                        settings={settings}
                        last={false}
                        running={false}
                        showAuthor={showAuthor}
                        queued={pending.state === 'queued'}
                      />
                    )}
                  />
                  {reason && !['error', 'stopped'].includes(timelineBlocks[timelineBlocks.length - 1]?.kind ?? '') ? (
                    <p role="alert" className="rounded-sm border-l-2 border-rust bg-rust/10 px-3 py-2 text-meta text-rust">{reason}</p>
                  ) : null}
                  {/* 两端唯一的当前进度：贴在对话末尾，不再在输入框上方重复。 */}
                  <div className="min-h-8">
                    {visibleHint ? (
                    <p
                      className="flex min-h-8 min-w-0 items-center gap-2 self-start text-meta text-tertiary"
                      data-testid="turn-hint"
                      data-stage={visibleHint.stage}
                      data-phase={visibleHint.phase}
                      title={visibleHint.detail}
                      aria-label={visibleHint.detail}
                      role="status"
                    >
                      {visibleHint.text === '暂未确认这一轮的结果' || hasPendingApproval || syncState ? null : (
                        <span data-testid="turn-active-spinner" aria-hidden="true" className="relative size-[15px] shrink-0">
                          <span className="absolute inset-0 animate-spin rounded-full border-[1.5px] border-current/25 border-t-current motion-reduce:hidden" />
                          <svg viewBox="0 0 16 16" fill="none" className="hidden size-full motion-reduce:block" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 2h8M4 14h8M5 2c0 3 1 4 3 6-2 2-3 3-3 6m6-12c0 3-1 4-3 6 2 2 3 3 3 6" />
                          </svg>
                        </span>
                      )}
                      <span className="min-w-0 break-words">{visibleHint.text}</span>
                    </p>
                    ) : null}
                  </div>
                </DeliveryContext.Provider>
              </FileLinksContext.Provider>
            )}
          </div>
          <div data-follow-spacer aria-hidden="true" />
        </div>
        <ScrollToEnd visible={!nearEnd} onClick={() => scrollToEnd()} />
      </div>

      <div className="shrink-0 border-t border-hair px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-4">
        <div className="mx-auto max-w-[760px]">
          {linkedSessions.length > 0 ? (
            <div
              ref={chipsRef}
              tabIndex={-1}
              role="group"
              aria-label="已连接的会话"
              className="mb-1 flex flex-wrap items-center gap-1.5 outline-none"
              data-testid="session-link-chips"
            >
              {linkedSessions.map((candidate) => {
                const origin = candidate.origin;
                const forkSource =
                  origin.kind === 'fork' ? (canvas.sessions.find((other) => other.id === origin.fromSessionId) ?? null) : null;
                return (
                  <SessionLinkChip
                    key={candidate.id}
                    info={sessionLinkInfo({
                      session: candidate,
                      opening: canvas.openings[candidate.id],
                      agentLabel: canvas.agents.find((agent) => agent.id === candidate.agentId)?.label,
                      forkedFromName: forkSource ? sessionName(canvas, forkSource) : null
                    })}
                    open={linkInfoId === candidate.id}
                    onOpenChange={(next) => setLinkInfoId(next ? candidate.id : null)}
                    unlinkBusy={linkBusy !== null}
                    onOpenSession={(id) => {
                      setLinkInfoId(null);
                      onOpenSession(id);
                    }}
                    onUnlink={unlinkLinkedSession}
                  />
                );
              })}
            </div>
          ) : null}
          {/* 输入框上方保留工作区、分支和上下文用量，不重复回合进度。 */}
          {showStatusRow ? (
            <div className="mb-1.5 flex min-h-5 items-center justify-between gap-3 px-1" data-testid="composer-status">
              <span />
              <div className="flex min-w-0 shrink-0 items-center gap-3">
                {!narrow ? (
                  <>
                    {switcher}
                    {gitState?.isGit ? (
                      <button
                        type="button"
                        className="flex min-w-0 items-center gap-1 text-meta text-tertiary hover:text-primary"
                        title={`${gitState.branch ?? '分离 HEAD'}${gitState.ahead > 0 ? ` · 领先 ${gitState.ahead}` : ''}${gitState.files.length > 0 ? ` · ${gitState.files.length} 个未提交改动` : ''}`}
                        data-testid="git-branch"
                        onClick={() => setGitOpen(true)}
                      >
                        <span aria-hidden>⎇</span>
                        <span className="max-w-[160px] truncate font-mono">{gitState.branch ?? 'HEAD'}</span>
                        {gitState.files.length > 0 ? <span className="shrink-0 text-secondary">{gitState.files.length} 改动</span> : null}
                        {gitState.ahead > 0 ? <span className="shrink-0 text-tertiary">↑{gitState.ahead}</span> : null}
                      </button>
                    ) : null}
                  </>
                ) : null}
                {live?.contextUsage ? <ContextMeter usage={live.contextUsage} /> : null}
              </div>
            </div>
          ) : null}
          <SubagentTrack blocks={blocks} onSelect={(id) => setSubagentPath([id])} triggerRef={subagentTrackRef} />
          {backgroundNotice ? (
            <div
              data-testid="background-activity"
              className="mb-1.5 flex items-center gap-1.5 text-meta text-tertiary"
            >
              <p role="status" title={backgroundNotice.detail} className="flex min-w-0 items-center gap-1.5">
                {/* 中性小点：读起来是「还在动」，不是告警 */}
                <span aria-hidden className="size-1 shrink-0 rounded-full bg-tertiary/70" />
                <span className="min-w-0 truncate">{backgroundNotice.text}</span>
              </p>
              <button
                type="button"
                data-testid="background-activity-jump"
                onClick={jumpToConversationEnd}
                className="ml-auto shrink-0 rounded-sm px-1 text-meta text-tertiary hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
              >
                查看
              </button>
            </div>
          ) : null}
          {envNotice ? (
            <p
              role="status"
              data-testid="environment-pending"
              title={envNotice.detail}
              className="mb-1.5 flex items-center gap-1.5 text-meta text-tertiary"
            >
              {/* 中性小点：读起来是「知道一下」，不是告警色块 */}
              <span aria-hidden className="size-1 shrink-0 rounded-full bg-tertiary/70" />
              <span className="min-w-0">{envNotice.text}</span>
            </p>
          ) : null}
          <HandoffGate key={session.id} session={session} projectId={canvas.project.id} draft={draft} onDraftChange={onDraftChange}><Composer
            large
            allowOfflineSend
            session={{ ...session, status }}
            agentLabel={agentLabel}
            draft={draft}
            onDraftChange={onDraftChange}
            onSend={sendMessage}
            onSendAndNew={session.taskId === null ? undefined : sendAndNew}
            onInterrupt={() => void run(() => api.interrupt(session.id))}
            busy={busy}
            error={error}
            awaiting={turnRunning}
            onChangeOption={(optionId, value) => session.optionSpec.find((option) => option.id === optionId)?.category === 'model'
              ? run(() => onChangeOption(optionId, value), false)
              : onChangeOption(optionId, value)}
            capability={attachmentsCapability(agent?.capabilities)}
            commands={sessionCommands(session, runtimeCommands, forkHint)}
            projectId={canvas.project.id}
            quote={quote}
          /></HandoffGate>
        </div>
      </div>
      </div>
      {splitChanges || tab === 'changes' || visited.has('changes') ? (
        <section aria-label="改动" data-testid="changes-workspace" className={`${tab === 'changes' || splitChanges ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-col ${splitChanges ? 'w-1/2 shrink-0 border-l border-hair' : 'flex-1'}`}>
          {splitChanges ? <div ref={splitHeadingRef} tabIndex={-1} className="flex min-h-9 shrink-0 items-center justify-between gap-2 border-b border-hair px-3 text-sub font-medium text-secondary outline-none focus-visible:outline-2 focus-visible:outline-ring">
            <span>改动</span>
            <button type="button" className="shrink-0 rounded-sm px-2 py-1 text-meta text-link hover:bg-card-raised" onClick={() => {
              setTab('changes');
              viewRef.current?.querySelector<HTMLButtonElement>('#session-tab-changes')?.focus();
            }}>展开改动</button>
          </div> : null}
          <FilesBrowser tab="changes" sessionId={session.id} workspaceId={repoWorkspaceId} member={repo.selected} status={status} jump={changesJump} onQuote={quoteToChat} switcher={switcher} members={repo.members} compact={splitChanges} sourceControl={{
            branch: groupId !== null && repo.selected === null ? '全部仓库' :
              gitStateQuery.error ? '分支未知' : gitState ? (gitState.isGit ? gitState.branch ?? '分离 HEAD' : '非 Git 目录') :
              groupId === null && workspace?.isGit === false ? '非 Git 目录' : gitStateQuery.isFetching ? '正在读取分支…' : '分支未知',
            taskId: sessionTaskId,
            prs: taskPrs,
            prsLoading: taskPrsQuery.isLoading,
            prsError: Boolean(taskPrsQuery.error),
            canOpenGit: groupId === null || repo.selected !== null,
            onOpenGit: () => setGitOpen(true),
            onRefresh: () => {
              for (const id of new Set([repoWorkspaceId, ...repo.members.map((item) => item.workspaceId)])) {
                for (const prefix of filesInvalidationKeys(filesKeys(id, session.id))) void queries.invalidateQueries({ queryKey: prefix });
              }
              void queries.invalidateQueries({ queryKey: gitKeys.state(repoWorkspaceId, session.id) });
              if (sessionTaskId !== null) void queries.invalidateQueries({ queryKey: taskKeys.pullRequests(sessionTaskId) });
            }
          }} />
        </section>
      ) : null}
      </div>
    </div>
    {docked ? detailsPanel : null}
    </div>
  );
}

type SessionMenuPage = 'home' | 'details' | 'actions';

/** 菜单卸载时丢弃层级，回到上一层时把焦点交还对应入口。 */
function SessionMenuPages({ narrow, children }: { narrow: boolean; children: (page: SessionMenuPage, navigate: (page: SessionMenuPage) => void) => ReactNode }) {
  const [page, setPage] = useState<SessionMenuPage>('home');
  const root = useRef<HTMLDivElement>(null);
  const focusAfterNavigation = useRef<{ next: SessionMenuPage; previous: SessionMenuPage } | null>(null);
  useLayoutEffect(() => {
    const pending = focusAfterNavigation.current;
    if (!pending || pending.next !== page) return;
    focusAfterNavigation.current = null;
    const selector = page === 'home' ? `[data-testid="session-more-${pending.previous}"]` : '[data-testid="session-more-back"]';
    root.current?.querySelector<HTMLButtonElement>(selector)?.focus();
  }, [page]);
  const navigate = (next: SessionMenuPage) => {
    if (next === page) return;
    focusAfterNavigation.current = { next, previous: page };
    setPage(next);
  };
  return <div ref={root} onKeyDown={(event) => {
    if (narrow && page !== 'home' && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); navigate('home'); }
  }}>
    {narrow && page !== 'home' ? <button type="button" role="menuitem" data-testid="session-more-back" className="sticky top-0 z-10 flex min-h-[44px] w-full items-center gap-2 border-b border-hair bg-overlay px-3 text-left text-sub text-secondary hover:text-primary" onClick={() => navigate('home')}>← 返回</button> : null}
    {children(page, navigate)}
  </div>;
}

/** 手机交接的确认状态跟随来源会话销毁，不覆盖新会话。 */
function MobileHandoff({ session, projectId, open, onClose, restoreFocusRef }: { session: SessionDto; projectId: string; open: boolean; onClose: () => void; restoreFocusRef: RefObject<HTMLButtonElement | null> }) {
  const handoff = useHandoffCandidates(session, projectId);
  return <><ModelPicker label="换 Agent" dialogTitle="选择要换的 Agent" controlledOpen={open} onOpenChange={(next) => { if (!next) onClose(); }} restoreFocusRef={restoreFocusRef} deferPick sessionPicker scope={`handoff:${session.id}`} items={handoff.items} value="" note={handoff.note} onChange={handoff.choose} />{handoff.dialog}</>;
}

/** 会话在界面上的名字：任务标题 · agent；没有任务的会话只用 agent（不拼出 null）。 */
function sessionName(canvas: CanvasDto, session: SessionDto): string {
  const task = canvas.tasks.find((candidate) => candidate.id === session.taskId);
  const agent = canvas.agents.find((candidate) => candidate.id === session.agentId);
  if (session.title) return session.title;
  const who = agent?.label ?? session.agentId;
  return task ? `${task.title} · ${who}` : who;
}

type TurnRow = { turn: number; files: number | null; additions: number | null; deletions: number | null };
function TurnBadge({ turn, onOpen }: { turn: TurnRow; onOpen: (turn: number) => void }) {
  return (
    <button type="button" data-testid="turn-badge" onClick={() => onOpen(turn.turn)}
      className="self-start rounded-full border border-hair px-2 py-0.5 font-mono text-[11px] text-tertiary hover:border-strong hover:text-primary">
      改了 {turn.files} 个文件{turn.additions !== null ? ` · +${turn.additions} −${turn.deletions ?? 0}` : ''}
    </button>
  );
}
function TurnFrag({ badge, onOpen, onRewind, children }: { badge: TurnRow | null; onOpen: (turn: number) => void; onRewind: (() => void) | null; children: ReactNode }) {
  return (
    <>
      {badge ? <TurnBadge turn={badge} onOpen={onOpen} /> : null}
      {onRewind ? (
        <div className="group/msg relative flex flex-col">
          {children}
          <MessageMenu onRewind={onRewind} />
        </div>
      ) : children}
    </>
  );
}

/** 用户消息下面的「⋯」：目前只有「从这里重来」。 */
function MessageMenu({ onRewind }: { onRewind: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative -mt-0.5 flex justify-end">
      <button type="button" aria-label="消息操作" aria-expanded={open} data-testid="msg-menu"
        className="flex min-h-9 min-w-9 items-center justify-center rounded-sm px-1.5 text-meta leading-5 text-tertiary hover:bg-hair/40 hover:text-primary"
        onClick={() => setOpen((v) => !v)}>
        ⋯
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 top-6 z-20 min-w-[132px] rounded-lg border border-strong bg-overlay py-1 shadow-overlay" onMouseLeave={() => setOpen(false)}>
          <button type="button" role="menuitem" data-testid="msg-rewind" className="block w-full px-3 py-1.5 text-left text-sub text-primary hover:bg-hair/40"
            onClick={() => { setOpen(false); onRewind(); }}>
            从这里重来
          </button>
        </div>
      ) : null}
    </div>
  );
}
