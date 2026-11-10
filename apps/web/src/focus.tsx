import { DeliveryContext, useDeliveries } from './delivery-note.tsx';
import { ProvenanceRow } from './provenance-row.tsx';
import { AttentionAutoAck } from './attention.tsx';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ArtifactDto, CanvasDto, SessionDto } from './api.ts';
import { api } from './api.ts';
import { ChatBlock, DisplayMenu, Dropdown, MenuItem, useDisplaySettings } from './chat-blocks.tsx';
import { Composer } from './composer.tsx';
import { CONTINUE_DISABLED_HINT, ContinueDialog, canContinueElsewhere } from './continue-elsewhere.tsx';
import { SessionDetails } from './inspector.tsx';
import { localTime } from './local-time.ts';
import { StatusPill } from './status.tsx';
import { attachmentsCapability } from './attachments.ts';
import { useStickToBottom } from './use-stick-to-bottom.ts';
import { sessionCommands } from './commands.ts';
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import { FILES_QUERY, shown } from './files-core.ts';
import { filesApi } from './api.ts';
import { FilesBrowser, type Reveal } from './files-browser.tsx';
import { GitDialog, PullRequestChips } from './git-dialog.tsx';
import { gitApi } from './api.ts';
import { FileLinksContext, type FileLinks } from './file-links.tsx';
import { SESSION_TABS, sessionTabLabel, stepTab, type SessionTab } from './session-tabs.ts';
import { RewindDialog } from './rewind-dialog.tsx';
import { forkBlockedHint, inheritedBlocks, multipleAuthors, waitingForReply, type Block, type LiveSession } from './live.ts';
import { ContextMeter } from './context-meter.tsx';
import { SessionLinksDialog } from './session-links-dialog.tsx';

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
  const [continuing, setContinuing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [linksOpen, setLinksOpen] = useState(false);
  const [linkBusy, setLinkBusy] = useState<string | null>(null);
  const [linkOverrides, setLinkOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [linkError, setLinkError] = useState<string | null>(null);
  // 同一 tick 内连点两下时 state 还没刷新，用 ref 抢先挡住第二次请求。
  const linkBusyRef = useRef(false);
  useEffect(() => setRenaming(false), [session.id]);
  const queries = useQueryClient();
  const [tab, setTab] = useState<SessionTab>('chat');
  // 访问过的文件 / 改动页保持挂载（隐藏），切回时状态和内容都还在；换会话才重置
  const [visited, setVisited] = useState<ReadonlySet<SessionTab>>(() => new Set(['chat']));
  const [reveal, setReveal] = useState<Reveal | null>(null);
  useEffect(() => {
    setTab('chat');
    setVisited(new Set(['chat']));
    setReveal(null);
  }, [session.id]);
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
  // 切到文件 / 改动：先显示缓存（挂载着的面板原样在），同时后台重读一遍
  useEffect(() => {
    if (tab !== 'chat') void queries.invalidateQueries({ queryKey: ['files', session.id] });
  }, [tab, session.id, queries]);
  const refreshing = useIsFetching({ queryKey: ['files', session.id] }) > 0;
  const [settings, changeSettings] = useDisplaySettings();
  const scroller = useStickToBottom<HTMLDivElement>(session.id);
  const agent = canvas.agents.find((candidate) => candidate.id === session.agentId);
  const task = canvas.tasks.find((candidate) => candidate.id === session.taskId);
  const blocks = live?.blocks ?? [];
  const status = live?.status ?? session.status;
  const reason = live?.reason ?? null;
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
  const linkName = (candidate: SessionDto): string =>
    candidate.title?.trim() || canvas.openings[candidate.id]?.trim() || '未命名会话';

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
  useEffect(() => void queries.invalidateQueries({ queryKey: ['files', session.id, 'changes'] }, { cancelRefetch: false }), [status, session.id, queries]);
  // 和 FilesBrowser 共用同一个查询 key（基准 = 会话开始），标签上的数字与改动页一致
  const changeCount = shown(useQuery({
    ...FILES_QUERY,
    queryKey: ['files', session.id, 'changes', 'session'],
    queryFn: () => filesApi.changes(session.id, 'session')
  }))?.files.length;
  const forkable = !busy && forkHint === null;
  const [gitOpen, setGitOpen] = useState(false);
  const [rewindAt, setRewindAt] = useState<number | null>(null);
  useEffect(() => setRewindAt(null), [session.id]);
  // 每轮「改了 N 个文件」（ADR 0027 阶段 1 的检查点）：挂在这一轮最后、下一句问话之前
  const turns = shown(useQuery({ ...FILES_QUERY, queryKey: ['files', session.id, 'turns'], queryFn: () => filesApi.turns(session.id) })) ?? [];
  const doneTurns = turns.filter((t) => t.after !== null && (t.files ?? 0) > 0);
  const promptSeqs = blocks.filter((b) => b.kind === 'prompt').map((b) => b.seq);
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
  const taskPrs = useQuery({ queryKey: ['task-prs', session.taskId], queryFn: () => gitApi.taskPullRequests(session.taskId), staleTime: 60_000, retry: false }).data ?? [];
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

  return (
    <div className="flex h-full flex-col bg-canvas">
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
            className="flex h-11 items-center rounded-sm px-2 text-meta text-tertiary hover:text-primary md:h-9"
            onClick={() => setLinksOpen(true)}
            title="连接同项目的其他会话"
          >
            连接 {linkedSessions.length}
          </button>
          <button
            className="flex h-11 items-center rounded-sm px-2 text-meta text-tertiary hover:text-primary md:h-9"
            onClick={() => setDetails(true)}
          >
            详情
          </button>
          <DisplayMenu settings={settings} onChange={changeSettings} />
          <Dropdown label="更多" icon="⋯">
            {(close) => (
              <>
                <MenuItem
                  title="提交与推送…"
                  hint="提交改动、推送分支、开 PR；说明由模型起草，可改"
                  onClick={() => {
                    close();
                    setGitOpen(true);
                  }}
                />
                <MenuItem
                  title="重命名"
                  hint="给这条会话起个名字；清空 = 回到默认显示"
                  onClick={() => {
                    close();
                    startRename();
                  }}
                />
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
                  hint={canContinueElsewhere(session) ? '换台机器或工作空间，带着对话摘要接着做' : CONTINUE_DISABLED_HINT}
                  disabled={!canContinueElsewhere(session)}
                  onClick={() => {
                    close();
                    setContinuing(true);
                  }}
                />
              </>
            )}
          </Dropdown>
          {windowChrome?.actions}
        </span>
      </header>
      <ProvenanceRow sessionId={session.id} />
      <AttentionAutoAck sessionId={session.id} />
      {taskPrs.length > 0 ? <div className="shrink-0 border-b border-hair px-2 py-1 md:px-3"><PullRequestChips prs={taskPrs} /></div> : null}
      {gitOpen ? <GitDialog sessionId={session.id} onClose={() => setGitOpen(false)} /> : null}
      {rewindAt !== null ? (
        <RewindDialog sessionId={session.id} promptSeq={rewindAt} onClose={() => setRewindAt(null)}
          onDone={(id, prompt) => { setRewindAt(null); onSeedDraft?.(id, prompt); onChanged(); onOpenSession(id); }} />
      ) : null}
      <div role="tablist" aria-label="会话视图" className="flex shrink-0 gap-1 border-b border-hair px-2 py-1.5 md:px-3" data-testid="session-tabs">
        {SESSION_TABS.map((t) => (
          <button
            key={t}
            role="tab"
            id={`session-tab-${t}`}
            aria-selected={tab === t}
            tabIndex={tab === t ? 0 : -1}
            onClick={() => setTab(t)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              const next = stepTab(tab, e.key === 'ArrowRight' ? 1 : -1);
              setTab(next);
              (e.currentTarget.parentElement?.querySelector(`#session-tab-${next}`) as HTMLElement | null)?.focus();
            }}
            className={`flex h-9 flex-1 items-center justify-center rounded-sm px-3 text-sub md:h-8 md:flex-none ${tab === t ? 'bg-card-raised text-primary' : 'text-tertiary hover:text-secondary'}`}
            data-testid={`session-tab-${t}`}
          >
            {sessionTabLabel(t, t === 'changes' ? changeCount : undefined)}
          </button>
        ))}
        {tab !== 'chat' && refreshing ? (
          <span className="ml-auto self-center px-2 text-meta text-tertiary" aria-live="polite" data-testid="files-refreshing">刷新中…</span>
        ) : null}
      </div>
      {(['files', 'changes'] as const).map((t) =>
        visited.has(t) ? (
          <div key={`${session.id}-${t}`} className={tab === t ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
            <FilesBrowser tab={t} sessionId={session.id} status={status} reveal={t === 'files' ? reveal : null} base={t === 'changes' ? turnBase : null} />
          </div>
        ) : null
      )}
      {linksOpen ? (
        <SessionLinksDialog
          sessions={canvas.sessions}
          currentId={session.id}
          linked={linkedIds}
          openings={canvas.openings}
          agents={canvas.agents}
          busyId={linkBusy}
          error={linkError}
          onToggle={(otherId, next) => void toggleLink(otherId, next)}
          onClose={() => {
            setLinksOpen(false);
            setLinkError(null);
          }}
        />
      ) : null}
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

      <div ref={scroller} className={`min-h-0 flex-1 overflow-y-auto ${tab === 'chat' ? '' : 'hidden'}`}>
        <div
          role="log"
          aria-label="对话记录"
          data-compact={settings.compact ? 'true' : undefined}
          className={`mx-auto flex max-w-[760px] flex-col ${settings.compact ? 'gap-2 px-3 py-3 text-[0.95em]' : 'gap-4 px-4 py-6'}`}
        >
          {origin.kind === 'fork' && inherited.length > 0 ? (
            <section aria-label="分叉前的对话" className="flex flex-col gap-4 opacity-60" data-testid="fork-inherited">
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
            {blocks.map((block, index) => (
              <TurnFrag key={index} badge={block.kind === 'prompt' ? badgeBefore(block.seq) : null} onOpen={openTurn}
                onRewind={block.kind === 'prompt' && block.seq > 0 ? () => setRewindAt(block.seq) : null}>
              <ChatBlock
                block={block}
                agentLabel={agentLabel}
                sessionId={session.id}
                settings={settings}
                last={index === blocks.length - 1}
                running={turnRunning}
                showAuthor={showAuthor}
              />
              </TurnFrag>
            ))}
            {lastBadge ? <TurnBadge turn={lastBadge} onOpen={openTurn} /> : null}
            </DeliveryContext.Provider>
            </FileLinksContext.Provider>
          )}
          {reason && blocks[blocks.length - 1]?.kind !== 'error' ? (
            <p role="alert" className="rounded-sm border-l-2 border-rust bg-rust/10 px-3 py-2 text-meta text-rust">{reason}</p>
          ) : null}
          {turnRunning ? (
            <p className="text-meta text-tertiary" aria-live="polite">
              {agentLabel} 正在回复…
            </p>
          ) : null}
        </div>
      </div>

      <div className={`shrink-0 border-t border-hair px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-4 ${tab === 'chat' ? '' : 'hidden'}`}>
        <div className="mx-auto max-w-[760px]">
          {linkedSessions.length > 0 ? (
            <div className="mb-1 flex flex-wrap items-center gap-1.5" data-testid="session-link-chips">
              {linkedSessions.map((candidate) => (
                <span key={candidate.id} className="inline-flex max-w-full items-center rounded-full border border-hair bg-card-raised text-meta">
                  <button className="max-w-[14rem] truncate px-2 py-0.5 text-secondary hover:text-primary" onClick={() => onOpenSession(candidate.id)}>
                    {linkName(candidate)}
                  </button>
                  <button
                    className="px-1.5 py-0.5 text-tertiary hover:text-rust disabled:opacity-40"
                    aria-label={`断开 ${linkName(candidate)}`}
                    disabled={linkBusy !== null}
                    onClick={() => void toggleLink(candidate.id, false)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {live?.contextUsage ? (
            <div className="mb-1 flex justify-end pr-1">
              <ContextMeter usage={live.contextUsage} />
            </div>
          ) : null}
          <Composer
            large
            session={{ ...session, status }}
            agentLabel={agentLabel}
            draft={draft}
            onDraftChange={onDraftChange}
            onSend={(text, attachments) =>
              run(async () => {
                await api.prompt(session.id, text, attachments);
                onDraftChange('');
              })
            }
            onInterrupt={() => void run(() => api.interrupt(session.id))}
            busy={busy}
            error={error}
            awaiting={turnRunning}
            onChangeOption={(optionId, value) => void run(() => onChangeOption(optionId, value))}
            capability={attachmentsCapability(agent?.capabilities)}
            commands={sessionCommands(session, [], forkHint)}
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
        className="rounded-sm px-1.5 text-meta leading-5 text-tertiary hover:bg-hair/40 hover:text-primary"
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
