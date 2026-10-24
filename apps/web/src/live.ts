import { useEffect, useRef, useState } from 'react';
import type { SessionDto, SessionEventDto } from './api.ts';

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
function applyBlocks(blocks: readonly Block[], event: SessionEventDto): readonly Block[] {
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
