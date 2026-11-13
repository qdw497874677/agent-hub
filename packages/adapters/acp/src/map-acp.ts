import type { DomainError, PromptInput, Result, SessionEvent, StartSpec } from '@agent-hub/domain';
import { clipToolOutput, invalid } from '@agent-hub/domain';

/**
 * ACP（Agent Client Protocol）→ 平台归一化事件。
 * 纯函数，与 mapPiEvent 形状对称：所有 ACP agent（OpenCode、Grok……）共用这一份映射。
 *
 * `toolNames` 对外是只读视图：codec 拿到的就是 `ReadonlyMap`，类型上无法 `set`；
 * 写入收敛在本文件内部（`rememberToolName`），只有持有真实 `Map` 的 runtime 会生效。
 */
export function mapAcpUpdate(
  update: unknown,
  toolNames: ReadonlyMap<string, string>,
  subagentId?: string
): SessionEvent[] {
  if (typeof update !== 'object' || update === null) return [];
  const u = update as Record<string, unknown>;
  const sub = subagentId ? { subagentId } : {};

  switch (u['sessionUpdate']) {
    case 'agent_message_chunk': {
      const content = u['content'] as Record<string, unknown> | undefined;
      if (content?.['type'] === 'text' && typeof content['text'] === 'string' && content['text']) {
        return [{ kind: 'text', delta: content['text'], ...sub }];
      }
      return [];
    }
    case 'agent_thought_chunk': {
      const content = u['content'] as Record<string, unknown> | undefined;
      if (content?.['type'] === 'text' && typeof content['text'] === 'string' && content['text']) {
        return [{ kind: 'thinking', delta: content['text'], ...sub }];
      }
      return [];
    }
    case 'tool_call': {
      const id = String(u['toolCallId'] ?? '');
      const name = String(u['title'] ?? u['kind'] ?? 'tool');
      if (id) rememberToolName(toolNames, id, name);
      const raw = u['rawInput'];
      return [{ kind: 'tool_call', name, input: typeof raw === 'string' ? raw : safeJson(raw), ...sub }];
    }
    case 'tool_call_update': {
      const id = String(u['toolCallId'] ?? '');
      const status = u['status'];
      if (status !== 'completed' && status !== 'failed') return [];
      const name = toolNames.get(id) ?? 'tool';
      const events: SessionEvent[] = [
        { kind: 'tool_result', name, ok: status === 'completed', durationMs: 0, ...acpOutput(u['content'], u['rawOutput']), ...sub }
      ];
      if (status === 'completed') events.push(...diffArtifacts(u['content'], subagentId));
      const artifact = artifactOf(u['rawOutput'], subagentId);
      if (artifact && !events.some((e) => e.kind === 'artifact' && e.path === artifact.path)) events.push(artifact);
      return events;
    }
    case 'available_commands_update': {
      const raw = u['availableCommands'];
      if (!Array.isArray(raw)) return [];
      const commands = raw.flatMap((item) => {
        if (typeof item !== 'object' || item === null) return [];
        const command = item as Record<string, unknown>;
        if (typeof command['name'] !== 'string' || command['name'].trim() === '') return [];
        const input = command['input'] as Record<string, unknown> | undefined;
        const hint = input && typeof input['hint'] === 'string' ? input['hint'].slice(0, 4000) : undefined;
        const description = typeof command['description'] === 'string' ? command['description'].slice(0, 4000) : undefined;
        return [{ name: command['name'].slice(0, 200), ...(description ? { description } : {}), ...(hint ? { hint } : {}) }];
      });
      return commands.length ? [{ kind: 'commands', commands }] : [];
    }
    default:
      return [];
  }
}

/**
 * 工具名写入的唯一入口：`toolNames` 对外只读，真实存储是 runtime 的 `Map`。
 * codec 若传进纯只读视图（没有 `set`）就静默跳过——读路径不受影响。
 */
function rememberToolName(store: ReadonlyMap<string, string>, id: string, name: string): void {
  const writable = store as { set?: (id: string, name: string) => unknown };
  if (typeof writable.set === 'function') writable.set(id, name);
}

/**
 * ACP 的 write/edit 工具在完成时可以带 `content: [{ type: 'diff', path, newText }]`（ACP 标准的 diff 内容块；Grok 1.0.70 实测会带），
 * 这是权威的文件路径；bytes 取 newText 的 UTF-8 长度。
 */
function diffArtifacts(content: unknown, subagentId?: string): (SessionEvent & { kind: 'artifact' })[] {
  if (!Array.isArray(content)) return [];
  const out: (SessionEvent & { kind: 'artifact' })[] = [];
  for (const item of content) {
    const c = item as Record<string, unknown> | null;
    if (c?.['type'] !== 'diff' || typeof c['path'] !== 'string' || !c['path'].startsWith('/')) continue;
    if (out.some((a) => a.path === c['path'])) continue;
    const text = typeof c['newText'] === 'string' ? c['newText'] : '';
    out.push({ kind: 'artifact', path: c['path'], bytes: Buffer.byteLength(text, 'utf8'), ...(subagentId ? { subagentId } : {}) });
  }
  return out;
}

/** 只认写文件类工具的输出，且必须带绝对路径。 */
function artifactOf(rawOutput: unknown, subagentId?: string): (SessionEvent & { kind: 'artifact' }) | null {
  if (typeof rawOutput !== 'object' || rawOutput === null) return null;
  const path = (rawOutput as Record<string, unknown>)['path'];
  if (typeof path !== 'string' || !path.startsWith('/')) return null;
  return { kind: 'artifact', path, bytes: 0, ...(subagentId ? { subagentId } : {}) };
}

/** 这一轮里 agent 有没有吐出过东西，以及它 stderr 最后几行（已脱敏）。 */
export interface TurnFacts {
  readonly produced: boolean;
  readonly stderrTail?: readonly string[];
}

/** 只有「真的回答了」才算 done：空回合、拒答、截断都要让人看见原因（红色错误），不能静默成「完成」。 */
export function endedFromStopReason(stopReason: unknown, facts: TurnFacts = { produced: true }): SessionEvent {
  const reason = typeof stopReason === 'string' ? stopReason : String(stopReason ?? 'unknown');
  if (reason === 'cancelled') return { kind: 'ended', outcome: 'stopped' };
  const tail = facts.stderrTail && facts.stderrTail.length > 0 ? `\n最近的 agent 日志：\n${facts.stderrTail.join('\n')}` : '';
  if (reason === 'refusal') return { kind: 'ended', outcome: 'failed', reason: `模型拒绝了这次请求（stopReason: refusal）${tail}` };
  if (reason === 'max_tokens') return { kind: 'ended', outcome: 'failed', reason: `输出达到长度上限被截断（stopReason: max_tokens）${tail}` };
  if (reason === 'max_turn_requests') return { kind: 'ended', outcome: 'failed', reason: `这一轮调用模型的次数达到上限，被中止（stopReason: max_turn_requests）${tail}` };
  if (!facts.produced) return { kind: 'ended', outcome: 'failed', reason: `agent 没有返回任何内容（可能是模型/鉴权/网络问题）。stopReason: ${reason}${tail}` };
  return { kind: 'ended', outcome: 'done' };
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{6,}/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  /\b([A-Za-z_]*(?:key|token|secret|password|passwd|pwd|auth)[A-Za-z_]*)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}/g
];

/** stderr 行脱敏：密钥、令牌、长串一律打码；只保留 300 字符。 */
export function redactLine(line: string): string {
  let out = line;
  out = out.replace(SECRET_PATTERNS[0]!, (m) => `${m.split(/[-_]/)[0]}-***`);
  out = out.replace(SECRET_PATTERNS[1]!, (_m, kind: string) => `${kind} ***`);
  out = out.replace(SECRET_PATTERNS[2]!, (_m, name: string, sep: string) => `${name}${sep}***`);
  out = out.replace(SECRET_PATTERNS[3]!, '***');
  out = out.replace(SECRET_PATTERNS[4]!, '***');
  return out.length > 300 ? `${out.slice(0, 300)}…` : out;
}

/** 环形缓存 stderr 最后 n 行（同时把管道读空，防止 agent 写满 stderr 卡住）。 */
export class StderrTail {
  private lines: string[] = [];
  private partial = '';
  private readonly max: number;
  constructor(max = 30) {
    this.max = max;
  }
  push(chunk: string): void {
    const parts = (this.partial + chunk).split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    if (this.partial.length > 4000) this.partial = this.partial.slice(-4000);
    for (const line of parts) this.add(line);
  }
  private add(line: string): void {
    const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd();
    if (clean.trim() === '') return;
    this.lines.push(redactLine(clean));
    if (this.lines.length > this.max) this.lines.shift();
  }
  tail(n = 12): string[] {
    const all = this.partial.trim() ? [...this.lines, redactLine(this.partial.trimEnd())] : this.lines;
    return all.slice(-n);
  }
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
  shim?: { command: string; args: readonly string[] },
  assets: StartSpec['mcp'] = []
): Record<string, unknown>[] {
  if (!tools) return [];
  return [...hubServers(tools, caps, shim), ...assetServers(tools, caps, shim, assets ?? [])];
}

/**
 * hub 下发的 MCP 资产，走 ACP 标准的 session/new.mcpServers（Grok、OpenCode 都认）：
 * - stdio：agent 自己拉起；env 里是已展开的密钥，只进那个子进程；
 * - http：指向 worker 本机中转（hub 代连远端），凭同一把会话令牌；agent 不会 HTTP MCP 就套 stdio 垫片。
 */
function assetServers(
  tools: { url: string; token: string },
  caps: { http: boolean },
  shim: { command: string; args: readonly string[] } | undefined,
  assets: NonNullable<StartSpec['mcp']>
): Record<string, unknown>[] {
  return assets.flatMap((entry): Record<string, unknown>[] => {
    if (entry.transport === 'stdio') {
      return [{ name: entry.name, command: entry.command, args: [...entry.args], env: Object.entries(entry.env).map(([name, value]) => ({ name, value })) }];
    }
    if (caps.http) return [{ type: 'http', name: entry.name, url: entry.url, headers: [{ name: 'Authorization', value: `Bearer ${tools.token}` }] }];
    return shim ? hubServers({ url: entry.url, token: tools.token }, caps, shim).map((server) => ({ ...server, name: entry.name })) : [];
  });
}

function hubServers(
  tools: { url: string; token: string },
  caps: { http: boolean },
  shim?: { command: string; args: readonly string[] }
): Record<string, unknown>[] {
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

/**
 * ACP 工具输出：`content` 里的 text 块（`{ type: 'content', content: { type: 'text', text } }`）和 diff 块，
 * 没有就退回 `rawOutput`（OpenCode 放 `{ output }`，也可能是字符串）。diff 写成统一 diff 的样子，界面按 diff 着色。
 */
function acpOutput(content: unknown, rawOutput: unknown): { output?: string } {
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const item of content) {
      const c = item as Record<string, unknown> | null;
      if (c?.['type'] === 'content') {
        const inner = c['content'] as Record<string, unknown> | undefined;
        if (inner?.['type'] === 'text' && typeof inner['text'] === 'string') parts.push(inner['text']);
      } else if (c?.['type'] === 'diff' && typeof c['path'] === 'string') {
        parts.push(simpleDiff(c['path'], typeof c['oldText'] === 'string' ? c['oldText'] : '', typeof c['newText'] === 'string' ? c['newText'] : ''));
      }
    }
  }
  if (parts.length === 0) {
    if (typeof rawOutput === 'string') parts.push(rawOutput);
    else if (typeof rawOutput === 'object' && rawOutput !== null) {
      const r = rawOutput as Record<string, unknown>;
      const text = r['output'] ?? r['stdout'] ?? r['content'];
      parts.push(typeof text === 'string' ? text : safeJson(rawOutput));
    }
  }
  const text = parts.join('\n').trim();
  return text === '' || text === '{}' ? {} : { output: clipToolOutput(text) };
}

/** 不做 LCS：旧文本全是「-」、新文本全是「+」。够看出改了什么，也不拖慢事件流。 */
function simpleDiff(path: string, oldText: string, newText: string): string {
  const minus = oldText === '' ? [] : oldText.split('\n').map((line) => `-${line}`);
  const plus = newText.split('\n').map((line) => `+${line}`);
  return [`--- ${path}`, `+++ ${path}`, ...minus, ...plus].join('\n');
}
