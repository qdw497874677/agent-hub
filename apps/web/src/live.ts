import { useEffect, useRef, useState } from 'react';
import type { JournalEntryDto, SessionDto, SessionEventDto } from './api.ts';

export type Block =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool'; readonly name: string; readonly input: string; readonly result: ToolResult | null }
  | { readonly kind: 'artifact'; readonly path: string; readonly bytes: number };

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
}

export type LiveMap = Readonly<Record<string, LiveSession>>;

/** 会话卡只渲染对话流；diagnostic 与 ended 不进卡片（见 visual-direction §5）。 */
export function applyBlocks(blocks: readonly Block[], event: SessionEventDto): readonly Block[] {
  switch (event.kind) {
    case 'text': {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'text') return [...blocks.slice(0, -1), { kind: 'text', text: last.text + event.delta }];
      return [...blocks, { kind: 'text', text: event.delta }];
    }
    case 'tool_call':
      return [...blocks, { kind: 'tool', name: event.name, input: event.input, result: null }];
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
      return [...blocks, { kind: 'artifact', path: event.path, bytes: event.bytes }];
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
  return entries.reduce<readonly Block[]>((blocks, entry) => applyBlocks(blocks, entry.event), []);
}

/** 历史块 + 实时块接起来；两块都是 text 时合并，否则卡片会出现两个断开的段落。 */
export function mergeBlocks(history: readonly Block[], live: readonly Block[]): readonly Block[] {
  if (live.length === 0) return history;
  const last = history[history.length - 1];
  const first = live[0];
  if (last?.kind === 'text' && first?.kind === 'text') {
    return [...history.slice(0, -1), { kind: 'text', text: last.text + first.text }, ...live.slice(1)];
  }
  return [...history, ...live];
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
  const history = blocksFromEntries(preview);
  if (!current && history.length === 0 && preview.length === 0) return null;
  return {
    blocks: mergeBlocks(history, current?.blocks ?? []),
    status: current?.status ?? session.status,
    lastSeq: current?.lastSeq ?? session.lastSeq,
    reason: current?.reason ?? reasonFromEntries(preview)
  };
}

/** SSE 一条连接推所有会话；前端按 sessionId 分流。 */
export function useLiveStream(): LiveMap {
  const [live, setLive] = useState<LiveMap>({});
  const source = useRef<EventSource | null>(null);

  useEffect(() => {
    const events = new EventSource('/api/stream');
    source.current = events;
    events.addEventListener('frame', (message) => {
      const frame = JSON.parse((message as MessageEvent<string>).data) as {
        sessionId: string;
        seq: number;
        event: SessionEventDto;
        status: SessionDto['status'];
      };
      setLive((current) => {
        const previous = current[frame.sessionId];
        const blocks = previous?.blocks ?? [];
        const reason =
          frame.event.kind === 'ended' && frame.event.reason !== undefined
            ? frame.event.reason
            : (previous?.reason ?? null);
        const next: LiveSession = {
          blocks: applyBlocks(blocks, frame.event),
          status: frame.status,
          lastSeq: frame.seq,
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

  return live;
}
