import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, connectorApi, type AttentionItemDto, type AttentionPhase } from '../shell/api.ts';
import { formatRoute } from '../shell/route.ts';
import { relativeTime } from '../shell/workers.tsx';
import { useNarrow } from '../shell/device.ts';
import { DialogShell, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../shell/dialog-shell.tsx';
import { RowMenu } from './row-menu.tsx';

/**
 * 「等我处理」（ADR 0031 D1）：不推送，只给角标、标题前的 (N) 和首页收件箱。
 * 只算我发起的 / 我负责的会话；看过（打开会话停几秒，或点「稍后」）就收起，阶段变了再上榜。
 */
export const PHASE_LABEL: Readonly<Record<AttentionPhase, string>> = {
  needs_approval: '等审批',
  undelivered: '未送达',
  failed: '失败了',
  needs_answer: '等回答',
  needs_review: '等审查'
};

const BASE_TITLE = typeof document === 'undefined' ? '' : document.title.replace(/^\(\d+\)\s*/, '');

/** 窄屏收件箱的预览条数：3 条足够判断「要不要现在处理」，再多就该让位给搜索和会话列表。 */
const NARROW_PREVIEW = 3;

export function useAttention() {
  const query = useQuery({ queryKey: ['attention'], queryFn: api.attention, refetchInterval: 10_000 });
  const count = query.data?.items.length ?? 0;
  useEffect(() => {
    document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
  }, [count]);
  return query;
}

export function useAckAttention() {
  const client = useQueryClient();
  return useMutation({
    // acked 默认 true：老行为不变（含打开会话停几秒的自动收起）。
    mutationFn: ({ item, acked = true }: { item: AttentionItemDto; acked?: boolean }) =>
      api.ackAttention(item, acked),
    onSuccess: () => client.invalidateQueries({ queryKey: ['attention'] })
  });
}

/**
 * 撤回收起。后端只认「带收据、且这条还是当时那一条」的撤销：
 * - undone:true → 真回来了；
 * - undone:false → 这条已经变了（或不属于我），不能装作成功；
 * - 老后端没这个字段 → 自己再拉一次待办，看它是否真的回到列表里。
 */
function useUndoAck() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ item, ackedAt }: { item: AttentionItemDto; ackedAt: number }) => {
      const res = await api.ackAttention(item, false, ackedAt);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['attention'] }),
        client.invalidateQueries({ queryKey: ['home'] })
      ]);
      if (res.undone === false) return false;
      if (res.undone === true) return true;
      const fresh = await client.fetchQuery({
        queryKey: ['attention'],
        queryFn: api.attention,
        staleTime: 0
      });
      return fresh.items.some((i) => i.sessionId === item.sessionId && i.phase === item.phase && i.since === item.since);
    }
  });
}

/** 顶栏角标：有事才露脸，点了回首页收件箱。 */
export function AttentionBadge({ onClick, compact = false }: { onClick(): void; compact?: boolean }) {
  const count = useAttention().data?.items.length ?? 0;
  const announced = useDebouncedCount(count);
  if (count === 0) return <LiveCount text={announced} />;
  return (
    <>
      <button
        data-testid="attention-badge"
        aria-label={`等我处理（${count}）`}
        title="等我处理"
        onClick={onClick}
        className="flex h-[44px] min-w-[44px] shrink-0 items-center justify-center text-meta md:h-7 md:min-w-0"
      >
        {/* 手指目标是 44 的外框，红色胶囊只画 26：否则一个 44 的实心圆会压过旁边三个图标。 */}
        <span className="flex h-[26px] min-w-[26px] items-center justify-center gap-1 rounded-full bg-rust px-2 text-canvas hover:opacity-90 md:h-[22px] md:min-w-[22px] md:px-1.5">
          {compact ? null : <span className="hidden sm:inline">待办</span>}
          <span>{count}</span>
        </span>
      </button>
      <LiveCount text={announced} />
    </>
  );
}

/**
 * 数量变化要播报给读屏，但不能每次轮询都念一遍（10 秒一次谁都受不了）。
 * 稳住 600ms 之后才报一次：连着来三条就只说「3 条待办」。
 */
function useDebouncedCount(count: number): string {
  const [text, setText] = useState('');
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = window.setTimeout(() => setText(count === 0 ? '待办已清空' : `${count} 条待办`), 600);
    return () => window.clearTimeout(timer);
  }, [count]);
  return text;
}

/** 视觉上不存在，但读屏会念：role=status + aria-live=polite 已经够，别再叠 assertive 抢话。 */
function LiveCount({ text }: { text: string }) {
  return (
    <span role="status" aria-live="polite" data-testid="attention-live" className="sr-only">
      {text}
    </span>
  );
}

/** 打开某条会话停几秒 = 看过了。 */
export function useAutoAck(sessionId: string | null, delayMs = 3000) {
  const attention = useAttention();
  const ack = useAckAttention();
  const item = sessionId ? attention.data?.items.find((i) => i.sessionId === sessionId) : undefined;
  const key = item ? `${item.sessionId}|${item.phase}|${item.since}` : null;
  useEffect(() => {
    if (!item) return;
    const timer = setTimeout(() => ack.mutate({ item }), delayMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** 首页顶部收件箱；没事时收成一行灰字。 */
export function AttentionInbox({ onOpen }: { onOpen(item: AttentionItemDto): void }) {
  const attention = useAttention();
  const ack = useAckAttention();
  const narrow = useNarrow();
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState<{ item: AttentionItemDto; x: number; y: number } | null>(null);
  // 关菜单 / 关详情都要把焦点还回那一行的「⋯」，不然键盘用户会掉到 body。
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const [detail, setDetail] = useState<AttentionItemDto | null>(null);
  // 收起是「暂时不看」：收错了就地能喊回来，不用去会话里重新触发一遍。
  // 只有拿到收据（ackedAt）才提供撤销——没有收据的收起是没法精确还元的。
  const [hiddenNow, setHiddenNow] = useState<{ item: AttentionItemDto; ackedAt: number } | null>(null);
  const [undoNote, setUndoNote] = useState<string | null>(null);
  const undo = useUndoAck();
  const error = ack.error instanceof Error ? ack.error.message : null;

  const undoStrip = hiddenNow ? (
    <div
      data-testid="attention-undo"
      className="mb-5 flex items-center gap-1 rounded-sm border border-hair bg-card pl-3"
    >
      <span className="min-w-0 flex-1 truncate text-meta text-tertiary" role="status" aria-live="polite">
        {error
          ? '没撤销成功：' + error
          : undoNote
            ? undoNote
            : undo.isPending
              ? '正在撤销…'
              : `已收起「${hiddenNow.item.taskTitle}」`}
      </span>
      <button
        data-testid="attention-undo-btn"
        className="flex min-h-[44px] shrink-0 items-center px-2 text-meta text-link disabled:opacity-50"
        disabled={undo.isPending || ack.isPending}
        onClick={() =>
          undo.mutate(
            { item: hiddenNow.item, ackedAt: hiddenNow.ackedAt },
            {
              onSuccess: (back) => {
                if (back) setHiddenNow(null);
                // 没回来就直说，别让用户以为已经恢复了。
                else setUndoNote('没撤销成功：这条已经变了，刷新后也没回来');
              }
            }
          )
        }
      >
        撤销
      </button>
      <button
        aria-label="关掉这条提示"
        className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-meta text-tertiary hover:text-secondary"
        onClick={() => {
          setHiddenNow(null);
          setUndoNote(null);
        }}
      >
        ×
      </button>
    </div>
  ) : null;

  if (!attention.data) return <><ConnectorNotices />{undoStrip}</>;
  const { items, working } = attention.data;
  if (items.length === 0) {
    return (
      <>
        <ConnectorNotices />
        <p data-testid="attention-quiet" className="mb-4 text-meta text-tertiary">
          没有待办{working > 0 ? ` · ${working} 条在跑` : ''}
        </p>
        {undoStrip}
      </>
    );
  }
  // 窄屏先只铺 3 条：待办一多会把搜索和会话整个推到第二屏。剩下的点「还有 N 条」就地展开。
  const preview = narrow && !expanded ? items.slice(0, NARROW_PREVIEW) : items;
  const hidden = items.length - preview.length;
  return (
    <><ConnectorNotices />
    <section data-testid="attention-inbox" className="mb-5 rounded-md border border-rust/40 bg-card">
      {/* 角标跳过来时焦点落在这行标题上：读屏会先念「等我处理 · N」，再往下 Tab 才是各条。 */}
      <h2
        id="attention-title"
        data-testid="attention-title"
        tabIndex={-1}
        className="border-b border-hair px-3 py-2 text-meta font-normal text-primary outline-none focus-visible:outline-2"
      >
        等我处理 · {items.length}
        {working > 0 ? <span className="text-tertiary"> （另有 {working} 条在跑）</span> : null}
      </h2>
      <ul>
        {preview.map((item) => (
          <li key={`${item.sessionId}|${item.phase}`} data-testid="attention-item" data-phase={item.phase}
            className="flex items-center gap-1 border-b border-hair pl-3 pr-1 last:border-b-0">
            <span className="shrink-0 rounded px-1.5 text-[11px] leading-[18px]">
              <span className={item.possible ? 'text-secondary' : 'text-rust'}>{item.possible ? '可能在等你' : PHASE_LABEL[item.phase]}</span>
            </span>
            {/* 手机上行内目标和 ⋯ 都要 ≥44：这条通道最容易误触（点偏就进会话、点「稍后」就收起）。 */}
            <button
              className="flex min-w-0 flex-1 flex-col justify-center text-left max-md:min-h-[44px]"
              title={`${item.taskTitle} · ${item.reason}`}
              onClick={() => onOpen(item)}
            >
              {/* 时间跟标题同一行靠右（和会话行一个读法），第二行整行留给原因：
                  以前时间是原因后面的尾巴，390 上第一个被截掉，用户看不出这条等了多久。 */}
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-body text-primary">{item.taskTitle}</span>
                <span className="shrink-0 text-meta text-tertiary">{relativeTime(item.since)}</span>
              </span>
              <span className="block truncate text-meta text-tertiary">
                {item.projectName} · {item.agentId} · {item.reason}
              </span>
            </button>
            <button
              data-testid="attention-menu"
              aria-label={`「${item.taskTitle}」的更多操作`}
              title="更多操作"
              className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-sm text-meta text-tertiary hover:bg-card hover:text-secondary"
              onClick={(event) => {
                menuTrigger.current = event.currentTarget;
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({ item, x: Math.max(8, rect.right - 168), y: rect.bottom + 4 });
              }}
            >
              ⋯
            </button>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <button
          data-testid="attention-more"
          className="flex min-h-[44px] w-full items-center justify-center border-t border-hair px-3 text-meta text-link hover:bg-card"
          onClick={() => setExpanded(true)}
        >
          还有 {hidden} 条
        </button>
      ) : null}
    </section>
    {undoStrip}
    {menu ? (
      <RowMenu
        testId="attention-row-menu"
        label="这条待办的操作"
        anchor={menu}
        onClose={(refocus) => {
          setMenu(null);
          if (refocus) menuTrigger.current?.focus({ preventScroll: true });
        }}
        items={[
          { id: 'open', label: '打开会话' },
          { id: 'detail', label: '查看完整内容…' },
          { id: 'later', label: '稍后处理' }
        ]}
        onPick={(id) => {
          const item = menu.item;
          // 先还原焦点（同步），再开详情：DialogShell 记的「从哪来」才是这一行的 ⋯。
          menuTrigger.current?.focus({ preventScroll: true });
          setMenu(null);
          if (id === 'open') onOpen(item);
          if (id === 'detail') setDetail(item);
          if (id === 'later')
            ack.mutate(
              { item },
              {
                onSuccess: (res) => {
                  setUndoNote(null);
                  if (typeof res.ackedAt === 'number') setHiddenNow({ item, ackedAt: res.ackedAt });
                }
              }
            );
        }}
      />
    ) : null}
    {detail ? (
      <DialogShell
        title="待办详情"
        testId="attention-detail"
        onClose={() => setDetail(null)}
        footer={
          <div className="flex justify-end gap-2">
            <button className={SECONDARY_BUTTON} onClick={() => setDetail(null)}>
              关闭
            </button>
            <button
              className={PRIMARY_BUTTON}
              onClick={() => {
                const item = detail;
                setDetail(null);
                onOpen(item);
              }}
            >
              打开会话
            </button>
          </div>
        }
      >
        <h3 className="text-title text-primary">{detail.taskTitle}</h3>
        <p className="mt-1 text-meta text-tertiary">
          {detail.projectName} · {detail.agentId} · {PHASE_LABEL[detail.phase]} · 等了{' '}
          {relativeTime(detail.since)}
        </p>
        {/* 列表里只有一行，原因被截在「模型拒绝了这次请求（st…」；完整的话放在这里，换行保留。 */}
        <p
          data-testid="attention-detail-reason"
          className="mt-3 whitespace-pre-wrap break-words text-body text-secondary"
        >
          {detail.reason}
        </p>
      </DialogShell>
    ) : null}
    </>
  );
}

/** 连接器的事（ADR 0032）：自动暂停的触发、超额等批准的 bot 任务。 */
function ConnectorNotices() {
  const client = useQueryClient();
  const notices = useQuery({ queryKey: ['connector-notices'], queryFn: connectorApi.notices, refetchInterval: 15_000 });
  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) => connectorApi.decide(id, approve),
    onSuccess: () => client.invalidateQueries({ queryKey: ['connector-notices'] })
  });
  const list = notices.data?.notices ?? [];
  if (!list.length) return null;
  return (
    <section data-testid="connector-notices" className="mb-3 rounded-md border border-rust/40 bg-card">
      <ul>
        {list.map((n) => (
          <li key={`${n.kind}|${n.id}`} data-testid="connector-notice" data-kind={n.kind} className="flex flex-wrap items-center gap-2 border-b border-hair px-3 py-2 last:border-b-0">
            <span className="shrink-0 rounded bg-rust/15 px-1.5 text-[11px] leading-[18px] text-rust">{n.kind === 'binding_paused' ? '触发已暂停' : n.kind === 'inbound_quarantined' ? '疑似注入已隔离' : 'bot 建任务待批'}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body text-primary">{n.title}</span>
              <span className="block truncate text-meta text-tertiary">{n.reason} · {relativeTime(n.since)}</span>
            </span>
            {n.kind === 'task_pending' ? (
              <span className="flex gap-1">
                <button data-testid="agent-task-approve" className="text-meta text-link" disabled={decide.isPending} onClick={() => decide.mutate({ id: n.id, approve: true })}>批准</button>
                <button data-testid="agent-task-reject" className="text-meta text-secondary" disabled={decide.isPending} onClick={() => decide.mutate({ id: n.id, approve: false })}>拒绝</button>
              </span>
            ) : (
              <a className="text-meta text-link" href={formatRoute({ page: 'bots', projectId: n.projectId })}>去 Bot 页</a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 放在会话页里：停留几秒自动标「看过」。 */
export function AttentionAutoAck({ sessionId }: { sessionId: string }) {
  useAutoAck(sessionId);
  return null;
}
