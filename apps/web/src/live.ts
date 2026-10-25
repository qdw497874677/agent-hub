import { useCallback, useEffect, useRef, useState } from 'react';
import { streamUrl, type JournalEntryDto, type SessionDto, type SessionEventDto } from './api.ts';

/** 每个块都带着它的 seq：历史和实时会在同一条事件上碰头，去重要靠它。 */
interface Sequenced {
  readonly seq: number;
}

export type Block = Sequenced &
  (
    /** 用户自己说的话。它来自平台（server 收到 prompt 时先记一条），不是 agent 推来的。 */
    | { readonly kind: 'prompt'; readonly text: string }
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'tool'; readonly name: string; readonly input: string; readonly result: ToolResult | null }
    | { readonly kind: 'artifact'; readonly path: string; readonly bytes: number }
  );

interface ToolResult {
  readonly ok: boolean;
  readonly durationMs: number;
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

/** 会话卡只渲染对话流；diagnostic 与 ended 不进卡片（见 visual-direction §5）。 */
export function applyBlocks(blocks: readonly Block[], event: SessionEventDto, seq: number): readonly Block[] {
  switch (event.kind) {
    case 'prompt':
      return [...blocks, { kind: 'prompt', text: event.text, seq }];
    case 'text': {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'text') {
        return [...blocks.slice(0, -1), { kind: 'text', text: last.text + event.delta, seq }];
      }
      return [...blocks, { kind: 'text', text: event.delta, seq }];
    }
    case 'tool_call':
      return [...blocks, { kind: 'tool', name: event.name, input: event.input, result: null, seq }];
    case 'tool_result': {
      for (let index = blocks.length - 1; index >= 0; index -= 1) {
        const block = blocks[index];
        if (block?.kind === 'tool' && block.name === event.name && block.result === null) {
          const patched: Block = { ...block, result: { ok: event.ok, durationMs: event.durationMs } };
          return [...blocks.slice(0, index), patched, ...blocks.slice(index + 1)];
        }
      }
      return blocks;
    }
    case 'artifact':
      return [...blocks, { kind: 'artifact', path: event.path, bytes: event.bytes, seq }];
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
export function resolveLive(
  session: SessionDto,
  preview: readonly JournalEntryDto[],
  current: LiveSession | undefined
): LiveSession | null {
  // 播种过就以内存里的为准：它从历史第一帧开始，一直是 seq 单调累加的。
  if (current) return current;
  const history = blocksFromEntries(preview);
  if (history.length === 0 && preview.length === 0) return null;
  const last = preview[preview.length - 1];
  return {
    blocks: history,
    status: session.status,
    lastSeq: preview.reduce((highest, entry) => Math.max(highest, entry.seq), session.lastSeq),
    reason: reasonFromEntries(preview),
    awaiting: last !== undefined && last.event.kind !== 'ended'
  };
}

export interface LiveStream {
  readonly live: LiveMap;
  /** 用画布投影里的历史给内存播种：一条会话只播一次，之后只吃比它新的帧。 */
  readonly seed: (sessions: readonly SessionDto[], previews: Readonly<Record<string, readonly JournalEntryDto[]>>) => void;
}

/** SSE 一条连接推所有会话；前端按 sessionId 分流。 */
export function useLiveStream(): LiveStream {
  const [live, setLive] = useState<LiveMap>({});
  const source = useRef<EventSource | null>(null);

  const seed = useCallback(
    (sessions: readonly SessionDto[], previews: Readonly<Record<string, readonly JournalEntryDto[]>>) => {
      setLive((current) => {
        let changed = false;
        const next: Record<string, LiveSession> = { ...current };
        for (const session of sessions) {
          if (next[session.id]) continue;
          const preview = previews[session.id] ?? [];
          if (preview.length === 0) continue;
          const last = preview[preview.length - 1];
          next[session.id] = {
            blocks: blocksFromEntries(preview),
            status: session.status,
            lastSeq: preview.reduce((highest, entry) => Math.max(highest, entry.seq), session.lastSeq),
            reason: reasonFromEntries(preview),
            awaiting: last !== undefined && last.event.kind !== 'ended'
          };
          changed = true;
        }
        return changed ? next : current;
      });
    },
    []
  );

  useEffect(() => {
    const events = new EventSource(streamUrl());
    source.current = events;
    events.addEventListener('frame', (message) => {
      const frame = JSON.parse((message as MessageEvent<string>).data) as {
        sessionId: string;
        seq: number;
        event: SessionEventDto | null;
        status: SessionDto['status'];
      };
      setLive((current) => {
        const previous = current[frame.sessionId];
        // 播种过的会话，旧帧说明它已经在历史里了——重复上屏比丢一帧难看得多。
        // 状态帧（event 为 null）共用同一条事件的 seq，不能按这个规则丢。
        if (previous && frame.event !== null && frame.seq <= previous.lastSeq) return current;
        const blocks = previous?.blocks ?? [];
        const reason =
          frame.event?.kind === 'ended' && frame.event.reason !== undefined
            ? frame.event.reason
            : (previous?.reason ?? null);
        const awaiting =
          frame.event === null
            ? (previous?.awaiting ?? false)
            : frame.event.kind === 'ended'
              ? false
              : true;
        const next: LiveSession = {
          blocks: frame.event ? applyBlocks(blocks, frame.event, frame.seq) : blocks,
          status: frame.status,
          awaiting,
          // 只有带事件的帧才推进游标：状态帧和它旁边那条事件共用同一个 seq，
          // 推进了就会把那条事件当成「旧帧」丢掉——提问气泡曾整条消失过。
          lastSeq: frame.event ? frame.seq : previous?.lastSeq ?? 0,
          reason
        };
        return { ...current, [frame.sessionId]: next };
      });
    });
    return () => {
      events.close();
      source.current = null;
    };
  }, []);

  return { live, seed };
}
