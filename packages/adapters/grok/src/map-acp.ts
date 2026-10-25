import type { SessionEvent } from '@agent-hub/domain';

/**
 * ACP（Agent Client Protocol）→ 平台归一化事件。
 * 纯函数，与 OpenCode 的 mapAcpUpdate 同构：Grok Build 也说 ACP，但归一到同一组事件。
 */
export function mapAcpUpdate(
  update: unknown,
  toolNames: Map<string, string>
): SessionEvent[] {
  if (typeof update !== 'object' || update === null) return [];
  const u = update as Record<string, unknown>;

  switch (u['sessionUpdate']) {
    case 'agent_message_chunk': {
      const content = u['content'] as Record<string, unknown> | undefined;
      if (content?.['type'] === 'text' && typeof content['text'] === 'string' && content['text']) {
        return [{ kind: 'text', delta: content['text'] }];
      }
      return [];
    }
    case 'tool_call': {
      const id = String(u['toolCallId'] ?? '');
      const name = String(u['title'] ?? u['kind'] ?? 'tool');
      if (id) toolNames.set(id, name);
      const raw = u['rawInput'];
      return [{ kind: 'tool_call', name, input: typeof raw === 'string' ? raw : safeJson(raw) }];
    }
    case 'tool_call_update': {
      const id = String(u['toolCallId'] ?? '');
      const status = u['status'];
      if (status !== 'completed' && status !== 'failed') return [];
      const name = toolNames.get(id) ?? 'tool';
      const events: SessionEvent[] = [
        { kind: 'tool_result', name, ok: status === 'completed', durationMs: 0 }
      ];
      if (status === 'completed') events.push(...diffArtifacts(u['content']));
      const artifact = artifactOf(u['rawOutput']);
      if (artifact && !events.some((e) => e.kind === 'artifact' && e.path === artifact.path)) events.push(artifact);
      return events;
    }
    default:
      return [];
  }
}

/**
 * Grok 的 write/edit 工具在完成时带 `content: [{ type: 'diff', path, newText }]`（grok 1.0.70 实测），
 * 这是权威的文件路径；bytes 取 newText 的 UTF-8 长度。
 */
function diffArtifacts(content: unknown): (SessionEvent & { kind: 'artifact' })[] {
  if (!Array.isArray(content)) return [];
  const out: (SessionEvent & { kind: 'artifact' })[] = [];
  for (const item of content) {
    const c = item as Record<string, unknown> | null;
    if (c?.['type'] !== 'diff' || typeof c['path'] !== 'string' || !c['path'].startsWith('/')) continue;
    if (out.some((a) => a.path === c['path'])) continue;
    const text = typeof c['newText'] === 'string' ? c['newText'] : '';
    out.push({ kind: 'artifact', path: c['path'], bytes: Buffer.byteLength(text, 'utf8') });
  }
  return out;
}

/** 只认写文件类工具的输出，且必须带绝对路径。 */
function artifactOf(rawOutput: unknown): (SessionEvent & { kind: 'artifact' }) | null {
  if (typeof rawOutput !== 'object' || rawOutput === null) return null;
  const path = (rawOutput as Record<string, unknown>)['path'];
  if (typeof path !== 'string' || !path.startsWith('/')) return null;
  return { kind: 'artifact', path, bytes: 0 };
}

export function endedFromStopReason(stopReason: unknown): SessionEvent {
  return {
    kind: 'ended',
    outcome: stopReason === 'cancelled' ? 'stopped' : 'done'
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}
