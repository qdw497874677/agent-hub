import {
  DISTILL_LIMITS,
  parseHubModel,
  providerUsableIn,
  ruleDistiller,
  secretKind,
  type AuditLog,
  type DistillCandidate,
  type MemoryDistiller,
  type MemorySettingsStore,
  type ModelProvider,
  type ProviderRepository,
  type SourceRef
} from '@agent-hub/domain';

/**
 * 模型版会后提炼器（ADR 0024）。
 * - 模型来自项目设置（hub-<slug>/<model>），就是项目能用的已注册 ModelProvider；没选 = 规则版。
 * - 每次调用前重新核对：提供商还在、启用、有密钥、作用域对得上项目团队、模型还在列表里；个人提供商不用于提炼。
 * - 一律由 hub 进程直接调上游（不管提供商 routing 是 direct 还是 hub）：密钥只在 hub 里解密，绝不下发。
 * - 输入先过密钥过滤（含疑似密钥整段不送模型）；输出逐条再过滤、截断、限条数；状态只给 staged / proposed。
 * - 任何失败（网络、超时、非 2xx、JSON 不对、零条）都回落到规则版，并记一次失败用量。
 * - 用量：提供商累计（requests / errors / bytes，和中转一样）+ 每次一条 memory.distill 审计（带项目和团队）。
 */
export interface ModelDistillerDeps {
  readonly settings: Pick<MemorySettingsStore, 'distillModel'>;
  readonly providers: Pick<ProviderRepository, 'bySlug' | 'revealKey' | 'addUsage'>;
  readonly projectTeam: (projectId: string) => Promise<string | null>;
  readonly audit: Pick<AuditLog, 'append'>;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export const DISTILL_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

const SYSTEM_PROMPT = [
  '你是记忆提炼器。输入是一段编码会话的压缩摘要。',
  '只输出一个 JSON 对象，不要别的文字：{"summary":{"title":"…","body":"…"},"principles":[{"title":"…","body":"…"}]}',
  'summary：这次会话做了什么、结论是什么（title ≤ 60 字，body ≤ 800 字）。',
  'principles：摘要里明确出现的、以后应长期遵守的约定 / 规则 / 做法（最多 4 条；没有就给空数组；不要编造）。',
  '绝不输出密码、令牌、密钥、连接串等任何凭据。'
].join('\n');

export function createModelDistiller(deps: ModelDistillerDeps): MemoryDistiller {
  const doFetch = deps.fetch ?? fetch;
  return {
    id: 'model',
    async distill(input) {
      const text = input.summary.trim().slice(0, DISTILL_LIMITS.inputTokens * 2);
      if (text === '' || secretKind(text)) return [];
      const model = await deps.settings.distillModel(input.projectId);
      const parsed = parseHubModel(model ?? undefined);
      if (!model || !parsed) return ruleDistiller.distill(input);
      const provider = await deps.providers.bySlug(parsed.slug);
      const problem = await unusable(provider, parsed.modelId, input.projectId);
      if (problem || !provider) {
        deps.log(`项目 ${input.projectId} 的提炼模型 ${model} 不能用（${problem}），改用规则版`);
        return ruleDistiller.distill(input);
      }
      const apiKey = await deps.providers.revealKey(provider.id);
      if (!apiKey) return ruleDistiller.distill(input);
      const started = deps.now();
      let bytesIn = 0;
      let bytesOut = 0;
      let failure: string | null = null;
      let out: DistillCandidate[] = [];
      try {
        const request = buildRequest(provider, parsed.modelId, text);
        bytesOut = Buffer.byteLength(request.body);
        const response = await doFetch(request.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(provider, apiKey) },
          body: request.body,
          signal: AbortSignal.timeout(deps.timeoutMs ?? DISTILL_TIMEOUT_MS)
        });
        const raw = await response.text();
        bytesIn = Buffer.byteLength(raw);
        if (!response.ok) throw new Error(`上游 ${response.status}`);
        if (bytesIn > MAX_RESPONSE_BYTES) throw new Error('上游回复太大');
        out = toCandidates(extractText(provider, raw), { sessionId: input.sessionId, seq: input.seq });
        if (out.length === 0) throw new Error('模型没给出可用候选');
      } catch (error) {
        failure = error instanceof Error ? error.message.slice(0, 120) : '调用失败';
      }
      await deps.providers.addUsage(provider.id, { requests: 1, errors: failure ? 1 : 0, bytesIn, bytesOut }, deps.now()).catch(() => undefined);
      await deps.audit
        .append({
          id: crypto.randomUUID(),
          actorId: 'system' as never,
          actorEmail: '',
          action: 'memory.distill',
          target: `project:${input.projectId}`,
          detail: `${model} · 会话 ${input.sessionId}#${input.seq} · ${failure ? `失败（${failure}），回落规则版` : `${out.length} 条候选`} · 发 ${bytesOut}B 收 ${bytesIn}B · ${deps.now() - started}ms`,
          at: deps.now(),
          teamId: await deps.projectTeam(input.projectId)
        })
        .catch(() => undefined);
      if (failure) {
        deps.log(`模型提炼失败（${model}：${failure}），改用规则版`);
        return ruleDistiller.distill(input);
      }
      return out;
    }
  };

  async function unusable(provider: ModelProvider | null, modelId: string, projectId: string): Promise<string | null> {
    if (!provider) return '提供商不存在';
    if (provider.scope === 'personal') return '个人提供商不用于提炼';
    if (!provider.models.some((item) => item.id === modelId)) return '提供商里没有这个模型';
    const usable = providerUsableIn(provider, await deps.projectTeam(projectId), null);
    return usable.ok ? null : usable.error.message;
  }
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}

function buildRequest(provider: ModelProvider, model: string, text: string): { url: string; body: string } {
  const user = `会话摘要：\n${text}`;
  if (provider.protocol === 'anthropic') {
    const base = provider.baseUrl.replace(/\/+$/, '');
    return {
      url: base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`,
      body: JSON.stringify({ model, max_tokens: 1500, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: user }] })
    };
  }
  if (provider.protocol === 'openai-responses') {
    return { url: joinUrl(provider.baseUrl, '/responses'), body: JSON.stringify({ model, instructions: SYSTEM_PROMPT, input: user, max_output_tokens: 1500 }) };
  }
  return {
    url: joinUrl(provider.baseUrl, '/chat/completions'),
    body: JSON.stringify({ model, max_tokens: 1500, temperature: 0, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }] })
  };
}

function authHeaders(provider: ModelProvider, apiKey: string): Record<string, string> {
  return provider.protocol === 'anthropic' ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${apiKey}` };
}

/** 从三种协议的回复里取出模型文本。 */
export function extractText(provider: Pick<ModelProvider, 'protocol'>, raw: string): string {
  const body = JSON.parse(raw) as Record<string, unknown>;
  const pick = (value: unknown): string => (typeof value === 'string' ? value : '');
  if (provider.protocol === 'anthropic') {
    const content = Array.isArray(body['content']) ? (body['content'] as { type?: string; text?: unknown }[]) : [];
    return content.filter((part) => part.type === 'text').map((part) => pick(part.text)).join('');
  }
  if (provider.protocol === 'openai-responses') {
    if (typeof body['output_text'] === 'string') return body['output_text'];
    const output = Array.isArray(body['output']) ? (body['output'] as { content?: { text?: unknown }[] }[]) : [];
    return output.flatMap((item) => item.content ?? []).map((part) => pick(part.text)).join('');
  }
  const choices = Array.isArray(body['choices']) ? (body['choices'] as { message?: { content?: unknown } }[]) : [];
  return pick(choices[0]?.message?.content);
}

/** 模型文本 → 候选：只认 JSON；逐条过密钥过滤、截断；第一条 episodic staged，其余 procedural proposed；总数 ≤ 5。 */
export function toCandidates(text: string, origin: { sessionId: string; seq: number }): DistillCandidate[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const object = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const clip = (input: string, max: number) => (input.length > max ? `${input.slice(0, max - 1)}…` : input);
  const item = (raw: unknown): { title: string; body: string } | null => {
    const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const title = typeof record['title'] === 'string' ? record['title'].trim() : '';
    const body = typeof record['body'] === 'string' ? record['body'].trim() : '';
    if (!title || !body || secretKind(`${title}\n${body}`)) return null;
    return { title: clip(title, 80), body: clip(body, DISTILL_LIMITS.outputChars) };
  };
  const ref: SourceRef = { source: 'session', uri: `session:${origin.sessionId}#${origin.seq}` };
  const out: DistillCandidate[] = [];
  const summary = item(object['summary']);
  if (summary) out.push({ status: 'staged', draft: { kind: 'episodic', title: summary.title, body: summary.body, tags: ['distill', 'model'], sources: [ref] } });
  const principles = Array.isArray(object['principles']) ? object['principles'] : [];
  for (const raw of principles) {
    if (out.length >= DISTILL_LIMITS.maxOutputs) break;
    const principle = item(raw);
    if (principle) out.push({ status: 'proposed', draft: { kind: 'procedural', title: principle.title, body: principle.body, tags: ['distill', 'model', 'principle-candidate'], sources: [ref] } });
  }
  return out;
}
