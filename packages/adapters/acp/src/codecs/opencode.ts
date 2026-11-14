import type { SessionEvent } from '@agent-hub/domain';
import type { AcpChildUpdate, AcpCodecContext, AcpCodecResult, AcpRuntimeCodec, AcpSessionCodec, AcpUpdate } from '../codec.ts';
import { mapAcpUpdate } from '../map-acp.ts';

/**
 * 旧版 OpenCode 会把子会话更新塞进 `session/update` 的 `_meta`；
 * 2.2.6 实际走 extNotification `opencode/session/child_update`，两种都兼容。
 */
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

export interface SubagentToolEnd {
  readonly id: string;
  readonly failed: boolean;
}

const SUBAGENT_END_STATES = new Set(['completed', 'failed', 'error', 'aborted']);

/**
 * 父工具内容里的 `<subagent sessionID="…" state="…">`。
 *
 * 只有 `state` 是终态才算子代理结束：后台 task 的父工具在派发时就返回，
 * 同一个标签那时也可能是 `state="running"`，不能一见 sessionID 就收尾。
 */
export function subagentEndFromToolContent(content: unknown): SubagentToolEnd | null {
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    const block = item as Record<string, unknown> | null;
    if (block?.['type'] !== 'text' || typeof block['text'] !== 'string') continue;
    for (const match of block['text'].matchAll(/<subagent\b([^>]*)>/g)) {
      const attrs = match[1] ?? '';
      const id = /\bsessionID="([^"]+)"/.exec(attrs)?.[1];
      if (!id) continue;
      const state = /\bstate="([^"]+)"/.exec(attrs)?.[1];
      if (!state || !SUBAGENT_END_STATES.has(state)) continue;
      return { id, failed: state !== 'completed' };
    }
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

  childUpdate(update: AcpChildUpdate, toolNames: ReadonlyMap<string, string>): readonly SessionEvent[] {
    const meta: AcpSubagentMeta = {
      id: update.childSessionId,
      parentId: update.parentSessionId,
      depth: update.depth,
      ...(update.title ? { title: update.title } : {})
    };
    const events: SessionEvent[] = [];
    const start = this.noteSubagent(meta);
    if (start) events.push(start);

    if (update.type === 'update') {
      if (update.update) events.push(...mapAcpUpdate(update.update, toolNames, update.childSessionId));
      return events;
    }

    if (update.status === 'completed' || update.status === 'failed' || update.status === 'interrupted') {
      const end = this.endSubagent(
        update.childSessionId,
        update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed' : 'cancelled'
      );
      if (end) events.push(end);
    }
    return events;
  }

  finish(status: 'completed' | 'failed' | 'cancelled'): readonly SessionEvent[] {
    const events: SessionEvent[] = [];
    for (const id of this.subagents.keys()) {
      const end = this.endSubagent(id, status);
      if (end) events.push(end);
    }
    return events;
  }

  /**
   * 后台子代理：父回合已 end_turn，但 child 还在跑。opencode 那之后不再推任何
   * `session/update`，只能靠 worker 周期性 `session/load` 把新总结拉回来。
   */
  pendingSubagents(): number {
    let pending = 0;
    for (const state of this.subagents.values()) if (!state.ended) pending += 1;
    return pending;
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
    // 只认「父工具内容里写着终态 state」这一个权威信号。
    // 不能用 activeSubagent.childId 兜底：后台 task 那一轮父工具会先返回、子代理还在跑，
    // 兜底会把子代理提前标成结束，之后的事件就只能挂在一个已完成的组下面。
    const ended = subagentEndFromToolContent(update['content']);
    const end = ended ? this.endSubagent(ended.id, ended.failed ? 'failed' : 'completed') : null;
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
