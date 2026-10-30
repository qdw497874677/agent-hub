import { STALL_NOTICE_MARKER } from '@agent-hub/contract/stall';
import type { JournalEntryDto, SessionDto, SessionEventDto, StoredAttachmentDto } from '@agent-hub/contract';

/**
 * 会话流的纯逻辑：块折叠、历史/实时合并、帧去重。
 * 不碰 DOM、不碰 EventSource——所以能在 node:test 里直接测（live-core.test.ts）。
 */
/** 每个块都带着它的 seq：历史和实时会在同一条事件上碰头，去重要靠它。 */
interface Sequenced {
  readonly seq: number;
}

export type Block = Sequenced &
  (
    /** 用户自己说的话。它来自平台（server 收到 prompt 时先记一条），不是 agent 推来的。 */
    | { readonly kind: 'prompt'; readonly text: string; readonly attachments: readonly StoredAttachmentDto[] }
    | { readonly kind: 'text'; readonly text: string }
    /** 模型的思考过程；专注对话按显示设置折叠或隐藏，卡片不显示。 */
    | { readonly kind: 'thinking'; readonly text: string }
    | { readonly kind: 'tool'; readonly name: string; readonly input: string; readonly result: ToolResult | null }
    | { readonly kind: 'artifact'; readonly path: string; readonly bytes: number }
    /** server 卡顿巡检记的提醒；一有新输出就撤掉（见 applyBlocks）。 */
    | { readonly kind: 'stall'; readonly text: string }
    /** 这一轮失败了（ended · failed）：原因写进对话里，不只是状态点变红——否则看着就是「发了没回」。 */
    | { readonly kind: 'error'; readonly text: string }
  );

interface ToolResult {
  readonly ok: boolean;
  readonly durationMs: number;
  /** 工具输出；老事件、不报输出的 agent 没有。 */
  readonly output?: string;
}

export interface LiveSession {
  readonly blocks: readonly Block[];
  readonly status: SessionDto['status'];
  readonly lastSeq: number;
  /** ended 事件里带的原因。失败必须能说出为什么（visual-direction §7：失败=方块+原因）。 */
  readonly reason: string | null;
  /**
   * 「这一轮还在跑吗」。
   *
   * 它和 `status === 'running'` 不是一件事：会话派生出来就进入 running，
   * 但只要用户还没开口，agent 只是干等着。用它来换按钮的样子，
   * 才不会出现「刚开一条会话，发送按钮就变成停止按钮」。
   */
  readonly awaiting: boolean;
}

export type LiveMap = Readonly<Record<string, LiveSession>>;

/**
 * 会话卡只渲染对话流；diagnostic 与 ended 不进卡片（见 visual-direction §5）。
 * 例外是卡顿提醒：它挂在末尾提示「可以中断」，之后来了任何事件就撤掉——卡顿已经过去了。
 */
export function applyBlocks(blocks: readonly Block[], event: SessionEventDto, seq: number): readonly Block[] {
  if (event.kind === 'diagnostic') {
    return event.text.startsWith(STALL_NOTICE_MARKER)
      ? [...withoutStall(blocks), { kind: 'stall', text: event.text, seq }]
      : blocks;
  }
  return foldBlocks(withoutStall(blocks), event, seq);
}

function withoutStall(blocks: readonly Block[]): readonly Block[] {
  return blocks[blocks.length - 1]?.kind === 'stall' ? blocks.slice(0, -1) : blocks;
}

function foldBlocks(blocks: readonly Block[], event: SessionEventDto, seq: number): readonly Block[] {
  switch (event.kind) {
    case 'prompt':
      return [...blocks, { kind: 'prompt', text: event.text, attachments: event.attachments ?? [], seq }];
    case 'text': {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'text') {
        return [...blocks.slice(0, -1), { kind: 'text', text: last.text + event.delta, seq }];
      }
      return [...blocks, { kind: 'text', text: event.delta, seq }];
    }
    case 'thinking': {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'thinking') {
        return [...blocks.slice(0, -1), { kind: 'thinking', text: last.text + event.delta, seq }];
      }
      return [...blocks, { kind: 'thinking', text: event.delta, seq }];
    }
    case 'tool_call':
      return [...blocks, { kind: 'tool', name: event.name, input: event.input, result: null, seq }];
    case 'tool_result': {
      for (let index = blocks.length - 1; index >= 0; index -= 1) {
        const block = blocks[index];
        if (block?.kind === 'tool' && block.name === event.name && block.result === null) {
          const patched: Block = { ...block, result: { ok: event.ok, durationMs: event.durationMs, ...(event.output === undefined ? {} : { output: event.output }) } };
          return [...blocks.slice(0, index), patched, ...blocks.slice(index + 1)];
        }
      }
      return blocks;
    }
    case 'artifact':
      return [...blocks, { kind: 'artifact', path: event.path, bytes: event.bytes, seq }];
    case 'ended':
      return event.outcome === 'failed' ? [...blocks, { kind: 'error', text: event.reason ?? '这一轮失败了，agent 没有说原因', seq }] : blocks;
    default:
      return blocks;
  }
}

/**
 * 把一段历史事件折成卡片块。
 *
 * 为什么需要它：卡片不能只活在没有刷新的那一瞬间。关掉浏览器再打开时 SSE 没推
 * 过任何一条，只有 journal 知道昨天说过什么——「认出昨天哪条思路走到哪」靠的是它。
 */
export function blocksFromEntries(entries: readonly JournalEntryDto[]): readonly Block[] {
  return entries.reduce<readonly Block[]>((blocks, entry) => applyBlocks(blocks, entry.event, entry.seq), []);
}

/**
 * 历史块 + 实时块接起来。
 *
 * 只在「内存里还没这条会话」时才需要接：正常路径是先用历史**播种**（`seed`），
 * 之后每条帧按 seq 单调追加，历史与实时就不会各说一遍。
 */
export function mergeBlocks(history: readonly Block[], live: readonly Block[]): readonly Block[] {
  if (live.length === 0) return history;
  if (history.length === 0) return live;
  return live;
}

/** 历史里最后一条 ended 决定「上次是怎么结束的」——failed 的原因也要能重开后读到。 */
export function reasonFromEntries(entries: readonly JournalEntryDto[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const event = entries[index]?.event;
    if (event?.kind === 'ended') return event.reason ?? null;
  }
  return null;
}

/**
 * 一条会话此刻该显示什么：历史打底，实时覆盖。
 * 返回 undefined 表示「这个会话还什么都没有」，卡片据此显示空状态。
 */
/**
 * 实时帧之后还在不在「等回复」（决定输入框是「中断」还是「发送」）。
 *
 * 只看「这一帧是不是 ended」不够：ended(failed) 之后 worker 常会再补一条「进程已退出」的诊断，
 * 派生失败、worker 拒绝这类失败也可能只留下诊断和一个状态帧——输入框就一直挂着「中断」。
 * 所以：诊断不开启也不结束一轮；只有状态的帧报了终态（失败、停止、完成、中断）就收掉这一轮。
 * 事件帧不看状态：失败过的会话再问一句，库里状态还是 failed，但 agent 确实在回。
 */
export function awaitingAfter(previous: boolean, event: SessionEventDto | null, status: SessionDto['status']): boolean {
  if (event === null) return status === 'running' && previous;
  if (event.kind === 'ended') return false;
  if (event.kind === 'diagnostic') return previous;
  return true;
}

/**
 * 从历史播种（刷新页面、首次打开）：同样跳过诊断，并以会话状态兜底——
 * 已经失败 / 中断的会话没有实时帧再来纠正，不能凭最后一条事件挂着「中断」。
 */
export function awaitingFromHistory(entries: readonly JournalEntryDto[], status: SessionDto['status']): boolean {
  if (status !== 'running') return false;
  const last = [...entries].sort((a, b) => b.seq - a.seq).find((entry) => entry.event.kind !== 'diagnostic');
  return last !== undefined && last.event.kind !== 'ended';
}

export function resolveLive(
  session: SessionDto,
  preview: readonly JournalEntryDto[],
  current: LiveSession | undefined
): LiveSession | null {
  // 播种过就以内存里的为准：它从历史第一帧开始，一直是 seq 单调累加的。
  if (current) return current;
  const history = blocksFromEntries(preview);
  if (history.length === 0 && preview.length === 0) return null;
  return {
    blocks: history,
    status: session.status,
    lastSeq: preview.reduce((highest, entry) => Math.max(highest, entry.seq), session.lastSeq),
    reason: reasonFromEntries(preview),
    awaiting: awaitingFromHistory(preview, session.status)
  };
}


/** 一条 SSE 帧（server 的 /api/stream 推的就是这个形状）。 */
export interface Frame {
  readonly sessionId: string;
  readonly seq: number;
  readonly event: SessionEventDto | null;
  readonly status: SessionDto['status'];
}

/** 把一条帧并进内存里的会话流；返回同一个对象表示「没变」，React 就不重渲。 */
export function applyFrame(current: LiveMap, frame: Frame): LiveMap {
  const previous = current[frame.sessionId];
  // 播种过的会话，旧帧说明它已经在历史里了——重复上屏比丢一帧难看得多。
  // 状态帧（event 为 null）共用同一条事件的 seq，不能按这个规则丢。
  if (previous && frame.event !== null && frame.seq <= previous.lastSeq) return current;
  const blocks = previous?.blocks ?? [];
  const reason =
    frame.event?.kind === 'ended' && frame.event.reason !== undefined ? frame.event.reason : (previous?.reason ?? null);
  const awaiting = awaitingAfter(previous?.awaiting ?? false, frame.event, frame.status);
  const next: LiveSession = {
    blocks: frame.event ? applyBlocks(blocks, frame.event, frame.seq) : blocks,
    status: frame.status,
    awaiting,
    // 只有带事件的帧才推进游标：状态帧和它旁边那条事件共用同一个 seq，
    // 推进了就会把那条事件当成「旧帧」丢掉——提问气泡曾整条消失过。
    lastSeq: frame.event ? frame.seq : (previous?.lastSeq ?? 0),
    reason
  };
  return { ...current, [frame.sessionId]: next };
}

/**
 * 断线重连后的补帧：把 `events?after=lastSeq` 拿回来的历史当成帧重放。
 * 走 applyFrame 的同一条去重规则，所以和重连后新推来的帧交错到达也不会重复。
 */
export function catchUp(current: LiveMap, sessionId: string, entries: readonly JournalEntryDto[]): LiveMap {
  const previous = current[sessionId];
  if (!previous) return current;
  return entries.reduce<LiveMap>((map, entry) => {
    const status = entry.event.kind === 'ended' ? entry.event.outcome : (map[sessionId]?.status ?? previous.status);
    return applyFrame(map, { sessionId, seq: entry.seq, event: entry.event, status });
  }, current);
}

/** 用画布投影里的历史播种：一条会话只播一次。 */
export function seedLive(
  current: LiveMap,
  sessions: readonly SessionDto[],
  previews: Readonly<Record<string, readonly JournalEntryDto[]>>
): LiveMap {
  let changed = false;
  const next: Record<string, LiveSession> = { ...current };
  for (const session of sessions) {
    if (next[session.id]) continue;
    const resolved = resolveLive(session, previews[session.id] ?? [], undefined);
    if (!resolved) continue;
    next[session.id] = resolved;
    changed = true;
  }
  return changed ? next : current;
}

/**
 * 打开专注对话时换上整段历史。
 *
 * 画布投影只带最后 24 条事件（够卡片用），可一段思考就是上百个 delta——对话页只靠它会是空的。
 * 拉取期间又来了更新的帧（内存比拿回来的历史还新），就保留内存里的，不倒退。
 */
export function withFullHistory(current: LiveMap, session: SessionDto, entries: readonly JournalEntryDto[]): LiveMap {
  const previous = current[session.id];
  const top = entries.reduce((highest, entry) => Math.max(highest, entry.seq), 0);
  if (previous && previous.lastSeq > top) return current;
  return {
    ...current,
    [session.id]: {
      blocks: blocksFromEntries(entries),
      status: previous?.status ?? session.status,
      lastSeq: Math.max(top, previous?.lastSeq ?? 0),
      reason: reasonFromEntries(entries),
      awaiting: previous?.awaiting ?? awaitingFromHistory(entries, session.status)
    }
  };
}

/**
 * 分叉出来的会话要先看到来源会话「分叉之前说了什么」：来源的历史截到分叉点再折成块。
 * 分叉点之后来源又说的话不属于这条分叉，不能混进来。
 */
export function inheritedBlocks(entries: readonly JournalEntryDto[], atSeq: number): readonly Block[] {
  return blocksFromEntries(entries.filter((entry) => entry.seq <= atSeq));
}

/** 「分叉」为什么点不了；null = 能点。 */
export function forkBlockedHint({ lastSeq, turnRunning, denied }: { lastSeq: number; turnRunning: boolean; denied: boolean }): string | null {
  if (denied) return '这个 agent 不支持分叉';
  if (lastSeq < 1) return '这条会话还没有内容';
  if (turnRunning) return '这一轮还在进行，等它结束再分叉';
  return null;
}
