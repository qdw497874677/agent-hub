import { DeliveryContext, useDeliveries } from '../../atoms/delivery-note.tsx';
import { ProvenanceRow } from '../../atoms/provenance-row.tsx';
import { AttentionAutoAck } from '../../atoms/attention.tsx';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ArtifactDto, AttachmentInputDto, CanvasDto, SessionDto } from '../../shell/api.ts';
import { api } from '../../shell/api.ts';
import { ChatBlock, DisplayMenu, Dropdown, MenuItem, useDisplaySettings } from '../../atoms/chat-blocks.tsx';
import { DisplaySettingsDialog } from '../../atoms/display-settings-dialog.tsx';
import { Composer } from '../../atoms/composer.tsx';
import { CONTINUE_DISABLED_HINT, ContinueDialog, canContinueElsewhere } from './continue-elsewhere.tsx';
import { SessionDetails } from './inspector.tsx';
import { localTime } from '../../shell/local-time.ts';
import { StatusPill } from '../../atoms/status.tsx';
import { attachmentsCapability } from '../../atoms/attachments.ts';
import { useStickToBottom } from '../../atoms/use-stick-to-bottom.ts';
import { sessionCommands } from '../../atoms/commands.ts';
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import { FILES_QUERY, shown } from '../../atoms/files-core.ts';
import { filesInvalidationKeys, filesKeys, gitKeys, sessionKeys, taskKeys } from '../../shell/query-keys.ts';
import { filesApi } from '../../shell/api.ts';
import { FilesBrowser, type Reveal } from '../../atoms/files-browser.tsx';
import { GitDialog, PullRequestChips } from './git-dialog.tsx';
import { gitApi } from '../../shell/api.ts';
import { FileLinksContext, type FileLinks } from '../../atoms/file-links.tsx';
import { SESSION_TABS, readStoredTab, sessionTabLabel, stepTab, storeTab, type SessionTab } from '../../atoms/session-tabs.ts';
import { TerminalPanel } from '../../atoms/terminal-panel.tsx';
import {
  subscribeTerminalSupport,
  terminalSupportKeys,
  terminalUnsupported as terminalBlocked
} from '../../atoms/terminal-core.ts';
import { resolveWorker, useWorkers } from '../../shell/workers.tsx';
import { RewindDialog } from '../../atoms/rewind-dialog.tsx';
import { forkBlockedHint, inheritedBlocks, multipleAuthors, waitingForReply, type Block, type LiveSession } from '../../atoms/live.ts';
import { ContextMeter } from '../../atoms/context-meter.tsx';
import { SessionLinksDialog } from '../../atoms/session-links-dialog.tsx';
import { SessionLinkChip } from '../../atoms/session-link-popover.tsx';
import { sessionLinkInfo } from '../../atoms/session-link-info.ts';
import { SaveAgentProfileDialog } from '../../shell/agent-profile-dialog.tsx';
import { AgentProfilesDialog } from '../../shell/agent-profiles-dialog.tsx';
import { DeleteSessionDialog } from '../../atoms/delete-session-dialog.tsx';
import { deleteSessionBlockedHint, edgeSurvivesSession } from '../../atoms/delete-session.ts';
import { environmentNotice } from '../../atoms/environment-notice.ts';
import {
  ACK_TIMEOUT_MS,
  expirePending,
  newClientMessageId,
  pendingLabel,
  reconcilePending,
  type PendingPrompt
} from '../../atoms/pending-prompt.ts';

interface Props {
  readonly canvas: CanvasDto;
  readonly session: SessionDto;
  readonly live: LiveSession | null;
  readonly draft: string;
  readonly onDraftChange: (text: string) => void;
  /** 整页时的「← 返回」；画布窗口里没有（窗口自己有关闭）。 */
  readonly onBack?: () => void;
  /** 画布窗口：顶栏变成拖动把手，右边挂窗口按钮（最小化/最大化/打开/关闭）。 */
  readonly windowChrome?: { readonly actions: ReactNode };
  readonly onChanged: () => void;
  /** 换个地方继续之后跳到新会话。 */
  readonly onOpenSession: (sessionId: string) => void;
  /** 从这里重来：把原消息放进新会话的输入框。 */
  readonly onSeedDraft?: (sessionId: string, text: string) => void;
  readonly artifacts: readonly ArtifactDto[];
  readonly onChangeOption: (optionId: string, value: string | boolean) => Promise<void>;
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
  draft,
  onDraftChange,
  onBack,
  onChanged,
  onOpenSession,
  onSeedDraft,
  artifacts,
  onChangeOption,
  windowChrome
}: Props) {
  const [busy, setBusy] = useState(false);
  // 发出去到 journal 回显之间，先给用户一条自己的气泡；对账只认 clientMessageId，同文也不会认错。
  const [pendingPrompts, setPendingPrompts] = useState<readonly PendingPrompt[]>([]);
  const [continuing, setContinuing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  // 只有手机上会用到这个对话框：桌面的「Aa」是内嵌的 DisplayMenu。
  const [displayOpen, setDisplayOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [linksOpen, setLinksOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  // 删除确认框；关掉后焦点要回到「⋯」。
  const [deleting, setDeleting] = useState(false);
  const moreRef = useRef<HTMLButtonElement | null>(null);
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
  }, [session.id]);
  const queries = useQueryClient();
  const [tab, setTab] = useState<SessionTab>(() => readStoredTab(session.id) ?? 'chat');
  // 访问过的文件 / 改动页保持挂载（隐藏），切回时状态和内容都还在；换会话才重置
  const [visited, setVisited] = useState<ReadonlySet<SessionTab>>(() => new Set(['chat']));
  const [reveal, setReveal] = useState<Reveal | null>(null);
  useEffect(() => {
    const restored = readStoredTab(session.id) ?? 'chat';
    setTab(restored);
    setVisited(new Set(restored === 'chat' ? ['chat'] : ['chat', restored]));
    setReveal(null);
  }, [session.id]);
  // 刷新 / 重进时回到上次那一页；记不住的存储（隐私模式）就按默认走。
  useEffect(() => {
    storeTab(session.id, tab);
  }, [session.id, tab]);
  // 工具参数里的路径可点：只认这条会话工作空间里的（老会话没有工作空间就只认相对路径）
  const workspaceRoot = canvas.workspaces.find((w) => w.id === session.workspaceId)?.path ?? null;
  const fileLinks = useMemo<FileLinks>(() => ({
    root: workspaceRoot,
    open: (target) => {
      setReveal((prev) => ({ ...target, nonce: (prev?.nonce ?? 0) + 1 }));
      setTab('files');
    }
  }), [workspaceRoot]);
  useEffect(() => setVisited((v) => (v.has(tab) ? v : new Set([...v, tab]))), [tab]);
  // 目录派生的文件 / git 状态按工作空间归一：同目录的多条会话共享缓存（见 query-keys.ts）。
  const fileKeys = filesKeys(session.workspaceId, session.id);
  // 切到文件 / 改动：先显示缓存（挂载着的面板原样在），同时后台重读一遍
  useEffect(() => {
    if (tab === 'chat') return;
    const keys = filesKeys(session.workspaceId, session.id);
    for (const prefix of filesInvalidationKeys(keys)) {
      void queries.invalidateQueries({ queryKey: prefix });
    }
  }, [tab, session.id, session.workspaceId, queries]);
  const refreshing = useIsFetching({
    predicate: (q) => q.queryKey[0] === 'files' && (q.queryKey[1] === fileKeys.dir[1] || q.queryKey[1] === session.id)
  }) > 0;
  const [settings, changeSettings] = useDisplaySettings();
  const scroller = useStickToBottom<HTMLDivElement>(session.id);
  const agent = canvas.agents.find((candidate) => candidate.id === session.agentId);
  const task = canvas.tasks.find((candidate) => candidate.id === session.taskId);
  const blocks = live?.blocks ?? [];
  // journal 里出现同 id 的 prompt 后，乐观气泡让位给真实事件；同文的另一条不受影响。
  useEffect(() => {
    setPendingPrompts((previous) => reconcilePending(previous, blocks));
  }, [blocks]);
  // 回执迟迟不来就是「未送达」：宁可让人点一次重试，也别让气泡一直装作在发。
  useEffect(() => {
    const waiting = pendingPrompts.filter((item) => item.state === 'sending');
    if (waiting.length === 0) return;
    const delay = Math.max(0, Math.min(...waiting.map((item) => item.sentAt + ACK_TIMEOUT_MS - Date.now())));
    const timer = setTimeout(() => {
      setPendingPrompts((previous) => expirePending(previous, Date.now()));
    }, delay + 50);
    return () => clearTimeout(timer);
  }, [pendingPrompts]);
  const status = live?.status ?? session.status;
  const reason = live?.reason ?? null;
  // 删除会话：跑着的时候服务端会拒（409），菜单里先把原因写出来，别点下去才知道。
  const deleteHint = deleteSessionBlockedHint({ status });
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
  const terminalAvailable = workerOnline && !terminalUnavailable;
  const tabs = useMemo(
    () => SESSION_TABS.filter((candidate) => candidate !== 'terminal' || terminalAvailable),
    [terminalAvailable]
  );
  // 终端变得不可用（会话结束 / 机器掉线 / 探测到不支持）时退回对话，别停在空页上。
  useEffect(() => {
    if (tab === 'terminal' && !terminalAvailable) setTab('chat');
  }, [tab, terminalAvailable]);
  const agentLabel = agent?.label ?? session.agentId;
  const lastSeq = live?.lastSeq ?? session.lastSeq;
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
  const forkHint = forkBlockedHint({ lastSeq, turnRunning, denied: agent?.capabilities.fork.state === 'denied' });
  // 回合结束（状态变了）刷新改动数：agent 可能刚改过文件
  useEffect(() => {
    const keys = filesKeys(session.workspaceId, session.id);
    for (const prefix of filesInvalidationKeys(keys)) {
      void queries.invalidateQueries({ queryKey: [...prefix, 'changes'] }, { cancelRefetch: false });
    }
    void queries.invalidateQueries({ queryKey: gitKeys.state(session.workspaceId, session.id) }, { cancelRefetch: false });
    // 下一轮开始后才生效，所以回合结束时重问一次环境版本：提示该消失时就消失。
    void queries.invalidateQueries({ queryKey: sessionKeys.environment(session.id) }, { cancelRefetch: false });
  }, [status, session.id, session.workspaceId, queries]);
  // 和 FilesBrowser 共用同一个查询 key（基准 = 会话开始），标签上的数字与改动页一致
  const changeCount = shown(useQuery({
    ...FILES_QUERY,
    queryKey: fileKeys.changes('session'),
    queryFn: () => filesApi.changes(session.id, 'session')
  }))?.files.length;
  const workspace = canvas.workspaces.find((candidate) => candidate.id === session.workspaceId);
  // 和 OpenCode 一样把当前分支放在输入框旁边；分支可能被 agent 切换，所以回合结束后刷新。
  const gitState = shown(useQuery({
    queryKey: gitKeys.state(session.workspaceId, session.id),
    queryFn: () => gitApi.state(session.id),
    enabled: workspace !== undefined && workspace.isGit !== false,
    staleTime: 15_000,
    retry: false
  }));
  const forkable = !busy && forkHint === null;
  const [gitOpen, setGitOpen] = useState(false);
  const [rewindAt, setRewindAt] = useState<number | null>(null);
  useEffect(() => setRewindAt(null), [session.id]);
  // 每轮「改了 N 个文件」（ADR 0027 阶段 1 的检查点）：挂在这一轮最后、下一句问话之前
  const turns = shown(useQuery({ ...FILES_QUERY, queryKey: fileKeys.turns(), queryFn: () => filesApi.turns(session.id) })) ?? [];
  const doneTurns = turns.filter((t) => t.after !== null && (t.files ?? 0) > 0);
  // 排队中的用户消息不留在时间线里：它们要一直贴在对话底部，不能因为 agent 继续输出而被顶到上面。
  const heldPromptSeqs = new Set(
    [...deliveriesBySeq]
      .filter(([, delivery]) => delivery.state === 'queued' || delivery.state === 'sending' || delivery.state === 'undelivered')
      .map(([seq]) => seq)
  );
  const timelineBlocks = blocks.filter((block) => !(block.kind === 'prompt' && heldPromptSeqs.has(block.seq)));
  const queuedBlocks = blocks.filter((block): block is Extract<Block, { kind: 'prompt' }> => block.kind === 'prompt' && heldPromptSeqs.has(block.seq));
  const promptSeqs = timelineBlocks.filter((b) => b.kind === 'prompt').map((b) => b.seq);
  /** 问话 seq 之前那一轮（上一句问话开头的那轮）。 */
  const badgeBefore = (seq: number) => {
    const i = promptSeqs.indexOf(seq);
    return i > 0 ? (doneTurns.find((t) => t.promptSeq === promptSeqs[i - 1]) ?? null) : null;
  };
  const lastPrompt = promptSeqs[promptSeqs.length - 1];
  const lastBadge = lastPrompt === undefined ? null : (doneTurns.find((t) => t.promptSeq === lastPrompt) ?? null);
  const [turnBase, setTurnBase] = useState<{ base: string; nonce: number } | null>(null);
  const openTurn = (turn: number) => {
    setTurnBase({ base: `turn:${turn}`, nonce: Date.now() });
    setTab('changes');
  };
  // 任务上的 PR（打开任务时服务端顺手同步状态）
  const taskPrs = useQuery({ queryKey: taskKeys.pullRequests(session.taskId), queryFn: () => gitApi.taskPullRequests(session.taskId), staleTime: 60_000, retry: false }).data ?? [];
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
    const next = titleDraft.replace(/\s+/g, ' ').trim();
    setRenaming(false);
    if (next === (session.title ?? '')) return;
    void run(() => api.renameSession(session.id, next));
  }

  function fork() {
    void run(async () => {
      const created = await api.fork({ sessionId: session.id, agentId: session.agentId, model: session.model });
      onOpenSession(created.id);
    });
  }

  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await action();
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
   * 先把用户的气泡放上去，再等服务端把 prompt 写进 journal。慢的是 ensureHosted，不该让输入框空着等。
   * 回执只说明「已接收」；真正让气泡消失的是 journal 里出现同一个 clientMessageId。
   */
  async function sendMessage(text: string, attachments: readonly AttachmentInputDto[]): Promise<boolean> {
    const id = newClientMessageId();
    const sentAt = Date.now();
    setPendingPrompts((previous) => [...previous, { id, text, attachments: [...attachments], state: 'sending', sentAt }]);
    setBusy(true);
    setError(null);
    try {
      const ack = await api.prompt(session.id, text, attachments, id);
      setPendingPrompts((previous) =>
        previous.map((pending) => (pending.id === id ? { ...pending, state: ack.state, seq: ack.seq } : pending))
      );
      onDraftChange('');
      onChanged();
      return true;
    } catch (failure) {
      setPendingPrompts((previous) => previous.filter((pending) => pending.id !== id));
      setError((failure as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** 未送达：用同一个 clientMessageId 重发，服务端幂等，重发不会变成两条。 */
  async function retryPending(pending: PendingPrompt): Promise<void> {
    setPendingPrompts((previous) =>
      previous.map((item) => (item.id === pending.id ? { ...item, state: 'sending', sentAt: Date.now() } : item))
    );
    setError(null);
    try {
      const ack = await api.prompt(session.id, pending.text, pending.attachments, pending.id);
      setPendingPrompts((previous) =>
        previous.map((item) => (item.id === pending.id ? { ...item, state: ack.state, seq: ack.seq } : item))
      );
      onChanged();
    } catch (failure) {
      setPendingPrompts((previous) => previous.filter((item) => item.id !== pending.id));
      setError((failure as Error).message);
    }
  }

  /** 放弃只撤掉本地气泡：服务端如果其实收到了，它已经在对话里了。 */
  function discardPending(id: string): void {
    setPendingPrompts((previous) => previous.filter((item) => item.id !== id));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <header
        className={`flex h-12 shrink-0 items-center gap-2 border-b border-hair px-2 md:px-3 ${windowChrome ? 'window-drag cursor-move select-none' : ''}`}
        data-testid={windowChrome ? 'window-titlebar' : undefined}
      >
        {onBack ? (
          <button className="flex h-11 shrink-0 items-center px-1 text-meta text-tertiary hover:text-primary md:h-9" onClick={onBack} aria-label="返回">
            ←<span className="hidden sm:inline">&nbsp;返回</span>
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          {renaming ? (
            <input
              autoFocus
              value={titleDraft}
              maxLength={80}
              placeholder={task?.title ?? '会话名'}
              aria-label="会话名"
              data-testid="session-title-input"
              className="h-7 w-full rounded-sm border border-hair bg-card px-1.5 text-body text-primary outline-none focus:border-accent"
              onChange={(e) => setTitleDraft(e.target.value)}
              onPointerDown={(e) => e.stopPropagation()}
              onBlur={saveRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') setRenaming(false);
              }}
            />
          ) : (
            <button
              type="button"
              className="block max-w-full truncate text-left text-body text-primary hover:underline decoration-dotted"
              title="点击重命名"
              data-testid="session-title"
              onClick={startRename}
            >
              {session.title || task?.title || session.taskId}
            </button>
          )}
          <p className="truncate font-mono text-meta text-tertiary">
            {session.title ? `${task?.title ?? session.taskId} · ` : ''}{agentLabel} · {session.model === '' ? '默认模型' : session.model}
            {origin.kind === 'fork' ? ` · 分叉自「${sourceName}」` : ''}
          </p>
        </div>
        <StatusPill status={status} reason={reason} lastSeq={live?.lastSeq ?? session.lastSeq} />
        <span className="flex shrink-0 items-center">
          <button
            className="hidden h-11 shrink-0 items-center rounded-sm px-1.5 text-meta text-tertiary hover:text-primary sm:flex sm:px-2 md:h-9"
            aria-label={`连接 ${linkedSessions.length}`}
            onClick={() => setLinksOpen(true)}
            title="连接同项目的其他会话"
          >
            连接 {linkedSessions.length}
          </button>
          <button
            className="hidden h-11 items-center rounded-sm px-2 text-meta text-tertiary hover:text-primary sm:flex md:h-9"
            onClick={() => setDetails(true)}
          >
            详情
          </button>
          <span className="hidden sm:flex">
            <DisplayMenu settings={settings} onChange={changeSettings} />
          </span>
          <Dropdown label="更多" icon="⋯" triggerRef={moreRef}>
            {(close) => (
              <>
                {/* 手机上 header 只留标题、状态和「⋯」（连接 / 详情 / Aa 都在 sm 以上才显示），
                    这三个入口在这里补一份；桌面上不渲染，避免和 header 重复。 */}
                <MenuGroup label="详情与显示" className="sm:hidden">
                  <MenuItem
                    title="详情"
                    hint="查看会话、工作空间和用量"
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
                </MenuGroup>
                <MenuGroup label="这次会话" className="border-t border-hair sm:border-t-0">
                  <MenuItem
                    title="分叉"
                    hint={forkHint ?? '从最新处开一条新会话，带着到此刻的上下文；原会话不动'}
                    disabled={!forkable}
                    onClick={() => {
                      close();
                      fork();
                    }}
                  />
                  <MenuItem
                    title="换个地方继续…"
                    hint={canContinueElsewhere(session) ? '换台机器或工作空间，带着会话摘要接着做' : CONTINUE_DISABLED_HINT}
                    disabled={!canContinueElsewhere(session)}
                    onClick={() => {
                      close();
                      setContinuing(true);
                    }}
                  />
                  <MenuItem
                    title="删除会话…"
                    hint={deleteHint ?? '永久删除这条会话的会话记录、产物引用和连线；工作空间里的文件保留'}
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
                <MenuGroup label="Agent 配置" className="border-t border-hair">
                  <MenuItem
                    title="保存为 Agent 配置…"
                    hint="把这条会话的 agent、模型和选项存成下次可直接套用的组合"
                    onClick={() => {
                      close();
                      setProfileOpen(true);
                    }}
                  />
                  <MenuItem
                    title="管理 Agent 配置…"
                    hint="改名、改模型、复制或删除已保存的启动组合"
                    onClick={() => {
                      close();
                      setProfilesOpen(true);
                    }}
                  />
                </MenuGroup>
              </>
            )}
          </Dropdown>
          {windowChrome?.actions}
        </span>
      </header>
      <ProvenanceRow sessionId={session.id} />
      <AttentionAutoAck sessionId={session.id} />
      {taskPrs.length > 0 ? <div className="shrink-0 border-b border-hair px-2 py-1 md:px-3"><PullRequestChips prs={taskPrs} /></div> : null}
      {gitOpen ? <GitDialog sessionId={session.id} workspaceId={session.workspaceId} taskId={session.taskId} onClose={() => setGitOpen(false)} /> : null}
      {rewindAt !== null ? (
        <RewindDialog sessionId={session.id} workspaceId={session.workspaceId} promptSeq={rewindAt} onClose={() => setRewindAt(null)}
          onDone={(id, prompt) => { setRewindAt(null); onSeedDraft?.(id, prompt); onChanged(); onOpenSession(id); }} />
      ) : null}
      {/* 右侧 pr 是给绝对定位的刷新指示器留的固定位置：它永远占这么宽，指示器出现或消失都不会让页签重排 */}
      <div role="tablist" aria-label="会话视图" className="relative flex shrink-0 gap-1 border-b border-hair py-1.5 pl-2 pr-5 md:pl-3 md:pr-6" data-testid="session-tabs">
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
        {tab !== 'chat' && tab !== 'terminal' && refreshing ? (
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
      {(['files', 'changes'] as const).map((t) =>
        visited.has(t) ? (
          <div key={`${session.id}-${t}`} className={tab === t ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
            <FilesBrowser tab={t} sessionId={session.id} workspaceId={session.workspaceId} status={status} reveal={t === 'files' ? reveal : null} base={t === 'changes' ? turnBase : null} />
          </div>
        ) : null
      )}
      {/* 终端和文件页一样：首访后保持挂载（hidden 不卸载），切回来还是同一个 shell 画面 */}
      {terminalAvailable && visited.has('terminal') ? (
        <div key={`${session.id}-terminal`} className={tab === 'terminal' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
          <TerminalPanel
            sessionId={session.id}
            workerId={session.workerId}
            active={tab === 'terminal'}
            notice={status === 'running' ? null : '这条会话已经结束：终端只开一个 shell，不会重新启动 agent。'}
          />
        </div>
      ) : null}
      {profileOpen ? (
        <SaveAgentProfileDialog
          session={session}
          agentLabel={agentLabel}
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
      {details ? <SessionDetails canvas={canvas} session={session} artifacts={artifacts} live={live} onClose={() => setDetails(false)} onBrowseFiles={() => { setDetails(false); setTab('files'); }} /> : null}
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
            queries.setQueryData<CanvasDto>(['canvas', canvas.project.id], (current) =>
              current
                ? {
                    ...current,
                    sessions: current.sessions.filter((item) => item.id !== session.id),
                    edges: current.edges.filter((edge) => edgeSurvivesSession(edge, session.id))
                  }
                : current
            );
            setDeleting(false);
            onChanged();
          }}
        />
      ) : null}

      <div ref={scroller} className={`min-h-0 flex-1 overflow-y-auto ${tab === 'chat' ? '' : 'hidden'}`}>
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
          {blocks.length === 0 ? (
            <p className="text-meta text-tertiary">这条会话还没有说话。在下面写一句，交给 {agentLabel}。</p>
          ) : (
            <FileLinksContext.Provider value={fileLinks}>
            <DeliveryContext.Provider value={{ sessionId: session.id, bySeq: deliveriesBySeq }}>
            {timelineBlocks.map((block, index) => (
              <TurnFrag key={index} badge={block.kind === 'prompt' ? badgeBefore(block.seq) : null} onOpen={openTurn}
                onRewind={block.kind === 'prompt' && block.seq > 0 ? () => setRewindAt(block.seq) : null}>
              <ChatBlock
                block={block}
                agentLabel={agentLabel}
                sessionId={session.id}
                settings={settings}
                last={index === timelineBlocks.length - 1}
                running={turnRunning}
                showAuthor={showAuthor}
              />
              </TurnFrag>
            ))}
            {lastBadge ? <TurnBadge turn={lastBadge} onOpen={openTurn} /> : null}
            {reason && timelineBlocks[timelineBlocks.length - 1]?.kind !== 'error' ? (
              <p role="alert" className="rounded-sm border-l-2 border-rust bg-rust/10 px-3 py-2 text-meta text-rust">{reason}</p>
            ) : null}
            {turnRunning ? (
              <p className="text-meta text-tertiary" aria-live="polite">
                {agentLabel} 正在回复…
              </p>
            ) : null}
            </DeliveryContext.Provider>
            </FileLinksContext.Provider>
          )}
        </div>
      </div>

      <div className={`shrink-0 border-t border-hair px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-4 ${tab === 'chat' ? '' : 'hidden'}`}>
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
          {gitState?.isGit || live?.contextUsage ? (
            <div className="mb-1 flex items-center justify-between gap-2 pr-1">
              {gitState?.isGit ? (
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-1 text-meta text-tertiary hover:text-primary"
                  title={`${gitState.branch ?? '分离 HEAD'}${gitState.ahead > 0 ? ` · 领先 ${gitState.ahead}` : ''}${gitState.files.length > 0 ? ` · ${gitState.files.length} 个未提交改动` : ''}`}
                  data-testid="git-branch"
                  onClick={() => setGitOpen(true)}
                >
                  <span aria-hidden>⎇</span>
                  <span className="truncate font-mono">{gitState.branch ?? 'HEAD'}</span>
                  {gitState.files.length > 0 ? <span className="shrink-0 text-rust">{gitState.files.length} 改动</span> : null}
                  {gitState.ahead > 0 ? <span className="shrink-0 text-tertiary">↑{gitState.ahead}</span> : null}
                </button>
              ) : <span />}
              {live?.contextUsage ? <ContextMeter usage={live.contextUsage} /> : null}
            </div>
          ) : null}
          {pendingPrompts.length > 0 ? (
            <section
              aria-label="还没写进对话的消息"
              aria-live="polite"
              data-testid="pending-prompts"
              className="mb-2 border-t border-dashed border-hair pt-2"
            >
              <div className="flex flex-col gap-2">
                {pendingPrompts.map((pending, index) => (
                  <div key={pending.id} className="flex flex-col gap-1">
                    <ChatBlock
                      block={{ kind: 'prompt', text: pending.text, attachments: [], seq: -1 - index }}
                      agentLabel={agentLabel}
                      sessionId={session.id}
                      settings={settings}
                      last={false}
                      running={false}
                      showAuthor={showAuthor}
                    />
                    {pending.state === 'unknown' ? (
                      <div
                        className="flex flex-wrap items-center gap-1 text-meta text-tertiary"
                        data-testid="pending-unknown"
                      >
                        <span className="mr-1 text-rust">未送达</span>
                        <button
                          type="button"
                          data-testid="pending-retry"
                          onClick={() => void retryPending(pending)}
                          className="inline-flex min-h-8 items-center rounded-sm border border-hair px-2.5 text-meta text-secondary hover:border-strong hover:text-primary active:bg-card"
                        >
                          重试
                        </button>
                        <button
                          type="button"
                          data-testid="pending-discard"
                          onClick={() => discardPending(pending.id)}
                          className="inline-flex min-h-8 items-center rounded-sm px-2.5 text-meta text-tertiary hover:text-primary active:bg-card"
                        >
                          放弃
                        </button>
                      </div>
                    ) : (
                      <p className="text-meta text-tertiary">{pendingLabel(pending.state)}</p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          {queuedBlocks.length > 0 ? (
            <DeliveryContext.Provider value={{ sessionId: session.id, bySeq: deliveriesBySeq }}>
              <section aria-label="排队中的消息" aria-live="polite" data-testid="queued-prompts" className="mb-2 max-h-[40vh] overflow-y-auto border-t border-dashed border-hair pt-2">
                <p className="mb-1 text-meta text-tertiary">待发送 · 当前回复结束后自动发出</p>
                <div className="flex flex-col gap-2">
                  {queuedBlocks.map((block) => (
                    <ChatBlock
                      key={`queued-${block.seq}`}
                      block={block}
                      agentLabel={agentLabel}
                      sessionId={session.id}
                      settings={settings}
                      last={false}
                      running={turnRunning}
                      showAuthor={showAuthor}
                    />
                  ))}
                </div>
              </section>
            </DeliveryContext.Provider>
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
          <Composer
            large
            session={{ ...session, status }}
            agentLabel={agentLabel}
            draft={draft}
            onDraftChange={onDraftChange}
            onSend={sendMessage}
            onInterrupt={() => void run(() => api.interrupt(session.id))}
            busy={busy}
            error={error}
            awaiting={turnRunning}
            onChangeOption={(optionId, value) => void run(() => onChangeOption(optionId, value))}
            capability={attachmentsCapability(agent?.capabilities)}
            commands={sessionCommands(session, runtimeCommands, forkHint)}
            projectId={canvas.project.id}
          />
        </div>
      </div>
    </div>
  );
}

/** 会话在界面上的名字：任务标题 · agent。 */
function sessionName(canvas: CanvasDto, session: SessionDto): string {
  const task = canvas.tasks.find((candidate) => candidate.id === session.taskId);
  const agent = canvas.agents.find((candidate) => candidate.id === session.agentId);
  if (session.title) return session.title;
  return `${task?.title ?? session.taskId} · ${agent?.label ?? session.agentId}`;
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
        <div role="menu" className="absolute right-0 top-6 z-20 min-w-[132px] rounded-sm border border-strong bg-panel py-1 shadow-lg" onMouseLeave={() => setOpen(false)}>
          <button type="button" role="menuitem" data-testid="msg-rewind" className="block w-full px-3 py-1.5 text-left text-sub text-primary hover:bg-hair/40"
            onClick={() => { setOpen(false); onRewind(); }}>
            从这里重来
          </button>
        </div>
      ) : null}
    </div>
  );
}
