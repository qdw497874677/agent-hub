import type { DomainError, PromptInput, Result, SessionEvent } from '@agent-hub/domain';
import { invalid } from '@agent-hub/domain';

/**
 * ACP（Agent Client Protocol）→ 平台归一化事件。
 * 纯函数，与 mapPiEvent 形状对称：所有 ACP agent（OpenCode、Grok……）共用这一份映射。
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
 * ACP 的 write/edit 工具在完成时可以带 `content: [{ type: 'diff', path, newText }]`（ACP 标准的 diff 内容块；Grok 1.0.70 实测会带），
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

/** agent 在 initialize 里声明的 promptCapabilities；没声明就按 ACP 基线（只收 text / resource_link）。 */
export interface AcpPromptCapabilities {
  readonly image: boolean;
  readonly embeddedContext: boolean;
}

export function readPromptCapabilities(init: Record<string, unknown>): AcpPromptCapabilities {
  const agent = (init['agentCapabilities'] ?? {}) as Record<string, unknown>;
  const prompt = (agent['promptCapabilities'] ?? {}) as Record<string, unknown>;
  return { image: prompt['image'] === true, embeddedContext: prompt['embeddedContext'] === true };
}

/** agent 在 initialize 里声明能接哪些 MCP 传输（stdio 是 ACP 必选，不用声明）。 */
export function readMcpCapabilities(init: Record<string, unknown>): { http: boolean; sse: boolean } {
  const agent = (init['agentCapabilities'] ?? {}) as Record<string, unknown>;
  const mcp = (agent['mcpCapabilities'] ?? {}) as Record<string, unknown>;
  return { http: mcp['http'] === true, sse: mcp['sse'] === true };
}

/** MCP 服务器名：agent 会拿它给工具加前缀（如 agent-hub__task_get）。 */
export const HUB_MCP_SERVER = 'agent-hub';

/**
 * session/new|load 的 mcpServers：hub 能力层。
 * relay（默认）：URL 已被 worker 换成它本机的 MCP 入口；会 HTTP MCP 的 agent 直连它，否则给 stdio 垫片。
 * 令牌放 Authorization 头（不放 URL，免得进访问日志）。
 * agent 没声明 http 能力就不给——宁可没有工具，也不让握手失败。
 */
export function mcpServersFor(
  tools: { transport: 'relay'; url: string; token: string } | undefined,
  caps: { http: boolean },
  shim?: { command: string; args: readonly string[] }
): Record<string, unknown>[] {
  if (!tools) return [];
  const http = [
    { type: 'http', name: HUB_MCP_SERVER, url: tools.url, headers: [{ name: 'Authorization', value: `Bearer ${tools.token}` }] }
  ];
  const stdio = shim
    ? [
        {
          name: HUB_MCP_SERVER,
          command: shim.command,
          args: [...shim.args],
          env: [
            { name: 'AGENT_HUB_TOOL_URL', value: tools.url },
            { name: 'AGENT_HUB_TOOL_TOKEN', value: tools.token }
          ]
        }
      ]
    : [];
  // 两种模式同一条规则：会 HTTP MCP 就直连（少一个进程），否则退到垫片（stdio 是 ACP 必须支持的）。
  return caps.http ? http : stdio;
}

const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|typescript|x-yaml|yaml|toml|x-sh|sql))/;
const TEXT_EXT = /\.(md|txt|json|ya?ml|toml|csv|tsv|log|xml|html?|css|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|sh|sql|ini|conf|env)$/i;

function fileUri(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** 解码成文本；不是合法 UTF-8 就返回 null（二进制文件只给链接）。 */
function decodeText(data: string): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(data, 'base64'));
  } catch {
    return null;
  }
}

/**
 * 平台的 PromptInput → ACP content blocks。
 * 图片要 agent 声明 image 能力，否则拒绝并说明原因——静默丢图会让用户以为 agent 看过了。
 * 文本文件在 embeddedContext 可用时内嵌，否则（以及二进制文件、@ 引用）一律给 resource_link，
 * 那是 ACP 规定所有 agent 都必须接收的基线。
 */
export function toAcpPrompt(
  input: PromptInput,
  caps: AcpPromptCapabilities,
  label: string
): Result<Record<string, unknown>[], DomainError> {
  const blocks: Record<string, unknown>[] = [];
  if (input.text.trim() !== '') blocks.push({ type: 'text', text: input.text });
  for (const part of input.parts) {
    if (part.kind === 'image') {
      if (!caps.image) return { ok: false, error: invalid(`${label} 没有声明图片输入能力，这张图发不过去：${part.name}`) };
      blocks.push({ type: 'image', mimeType: part.mimeType, data: part.data, uri: fileUri(part.path) });
      continue;
    }
    if (part.kind === 'file' && caps.embeddedContext && (TEXT_MIME.test(part.mimeType) || TEXT_EXT.test(part.name))) {
      const text = decodeText(part.data);
      if (text !== null) {
        blocks.push({
          type: 'resource',
          resource: { uri: fileUri(part.path), mimeType: part.mimeType || 'text/plain', text }
        });
        continue;
      }
    }
    blocks.push({
      type: 'resource_link',
      uri: fileUri(part.path),
      name: part.name,
      ...(part.kind === 'file' && part.mimeType ? { mimeType: part.mimeType } : {})
    });
  }
  return { ok: true, value: blocks };
}
