import type { SessionEvent } from '@agent-hub/domain';
import type { AcpCodecContext, AcpCodecResult, AcpRuntimeCodec, AcpSessionCodec, AcpUpdate } from '../codec.ts';
import { mapAcpUpdate } from '../map-acp.ts';

/** OpenCode 的子会话更新在 `session/update` 的 `_meta` 里标出父子关系。 */
export interface AcpSubagentMeta {
  readonly id: string;
  readonly parentId: string;
  readonly depth: number;
  readonly title?: string;
}

export function readSubagentMeta(meta: unknown): AcpSubagentMeta | null {
  if (typeof meta !== 'object' || meta === null) return null;
  const raw = (meta as Record<string, unknown>)['opencode/child-session'];
  if (typeof raw !== 'object' || raw === null) return null;
  const child = raw as Record<string, unknown>;
  if (typeof child['id'] !== 'string' || !child['id']) return null;
  if (typeof child['parentID'] !== 'string' || !child['parentID']) return null;
  return {
    id: child['id'],
    parentId: child['parentID'],
    depth: typeof child['depth'] === 'number' ? child['depth'] : 1,
    ...(typeof child['title'] === 'string' && child['title'] ? { title: child['title'] } : {})
  };
}

/** 父工具的完成内容里会带 `<subagent sessionID="…" state="completed">`；这是子代理结束的权威信号。 */
export function subagentIdFromToolContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    const block = item as Record<string, unknown> | null;
    if (block?.['type'] !== 'text' || typeof block['text'] !== 'string') continue;
    const match = /<subagent\b[^>]*\bsessionID="([^"]+)"/.exec(block['text']);
    if (match?.[1]) return match[1];
  }
  return null;
}

interface SubagentState {
  readonly meta: AcpSubagentMeta;
  readonly agent?: string;
  ended: boolean;
}

/**
 * OpenCode：`mode=orchestrator` 时用 `subagent` 工具派生 child session。
 *
 * 子会话的 update 仍走同一个 `session/update`，但 `params._meta` 带
 * `opencode/child-session`；父工具的完成内容里带 child id。这里把两者配对成
 * Hub 的 `subagent start/end`，并给子事件打 `subagentId`。
 */
export class OpenCodeSessionCodec implements AcpSessionCodec {
  private readonly subagents = new Map<string, SubagentState>();
  /** 父会话里正在跑的 subagent 工具调用；子会话第一次出现时用它补 agent 名字。 */
  private activeSubagent: { readonly toolCallId: string; readonly agent?: string; childId?: string } | null = null;

  decode(context: AcpCodecContext): AcpCodecResult | null {
    const child = readSubagentMeta(context.meta);
    if (child) {
      const events: SessionEvent[] = [];
      const start = this.noteSubagent(child);
      if (start) events.push(start);
      events.push(...mapAcpUpdate(context.update, context.toolNames, child.id));
      return { events };
    }

    const kind = context.update['sessionUpdate'];
    if (kind !== 'tool_call' && kind !== 'tool_call_update') return null;

    // 父工具完成时，end 先于父 tool_result，与旧行为一致。
    const ended = this.noteParentTool(context.update);
    const mapped = mapAcpUpdate(context.update, context.toolNames);
    return { events: [...ended, ...mapped] };
  }

  finish(status: 'completed' | 'failed' | 'cancelled'): readonly SessionEvent[] {
    const events: SessionEvent[] = [];
    for (const id of this.subagents.keys()) {
      const end = this.endSubagent(id, status);
      if (end) events.push(end);
    }
    return events;
  }

  /** 第一次看到某个 child session：发 start，并把正在跑的父工具锚点记下来。 */
  private noteSubagent(meta: AcpSubagentMeta): SessionEvent | null {
    if (this.subagents.has(meta.id)) return null;
    const agent = this.activeSubagent?.agent;
    this.subagents.set(meta.id, { meta, ...(agent ? { agent } : {}), ended: false });
    if (this.activeSubagent) this.activeSubagent.childId = meta.id;
    return {
      kind: 'subagent',
      phase: 'start',
      id: meta.id,
      parentId: meta.parentId,
      depth: meta.depth,
      ...(meta.title ? { title: meta.title } : {}),
      ...(agent ? { agent } : {}),
      status: 'running'
    };
  }

  /** OpenCode 把子代理包在 title=subagent 的父工具调用里；用 rawInput 补 agent 名字。 */
  private noteParentTool(update: AcpUpdate): readonly SessionEvent[] {
    const toolCallId = String(update['toolCallId'] ?? '');
    if (!toolCallId) return [];
    const raw = update['rawInput'];
    const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const title = String(update['title'] ?? '').toLowerCase();
    const looksSubagent = title === 'subagent' || title === 'task' || typeof input['agent'] === 'string';
    const agent = typeof input['agent'] === 'string' && input['agent'] ? input['agent'] : undefined;
    if (looksSubagent) {
      if (this.activeSubagent?.toolCallId !== toolCallId) {
        this.activeSubagent = { toolCallId, ...(agent ? { agent } : {}) };
      } else if (agent && !this.activeSubagent.agent) {
        this.activeSubagent = { ...this.activeSubagent, agent };
      }
    }
    const status = update['status'];
    if (status !== 'completed' && status !== 'failed') return [];
    const childId = subagentIdFromToolContent(update['content']) ?? this.activeSubagent?.childId;
    const end = childId ? this.endSubagent(childId, status === 'completed' ? 'completed' : 'failed') : null;
    if (this.activeSubagent?.toolCallId === toolCallId) this.activeSubagent = null;
    return end ? [end] : [];
  }

  private endSubagent(id: string, status: 'completed' | 'failed' | 'cancelled'): SessionEvent | null {
    const state = this.subagents.get(id);
    if (!state || state.ended) return null;
    state.ended = true;
    return {
      kind: 'subagent',
      phase: 'end',
      id: state.meta.id,
      parentId: state.meta.parentId,
      depth: state.meta.depth,
      ...(state.meta.title ? { title: state.meta.title } : {}),
      ...(state.agent ? { agent: state.agent } : {}),
      status
    };
  }
}

export const opencodeCodec: AcpRuntimeCodec = {
  id: 'opencode',
  session: () => new OpenCodeSessionCodec()
};
