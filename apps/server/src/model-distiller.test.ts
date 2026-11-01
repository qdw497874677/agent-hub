import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelProvider } from '@agent-hub/domain';
import { createModelDistiller, toCandidates } from './model-distiller.ts';

const provider = (over: Partial<ModelProvider> = {}): ModelProvider => ({
  id: 'p1',
  scope: 'hub',
  ownerId: null,
  slug: 'acme',
  name: 'Acme',
  protocol: 'openai-chat',
  baseUrl: 'https://llm.example/v1',
  models: [{ id: 'm1' }],
  routing: 'direct',
  enabled: true,
  hasKey: true,
  lastCheck: null,
  createdBy: 'u',
  createdAt: 0,
  updatedAt: 0,
  ...over
});

function setup(opts: { model?: string | null; provider?: ModelProvider | null; reply?: () => Response; team?: string | null } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const usage: unknown[] = [];
  const audits: { action: string; target: string; detail: string; teamId: string | null }[] = [];
  const distiller = createModelDistiller({
    settings: { distillModel: async () => (opts.model === undefined ? 'hub-acme/m1' : opts.model) },
    providers: {
      bySlug: async () => (opts.provider === undefined ? provider() : opts.provider),
      revealKey: async () => 'sk-hub-only',
      addUsage: async (id, delta) => void usage.push({ id, ...delta })
    },
    projectTeam: async () => opts.team ?? null,
    audit: { append: async (entry) => void audits.push(entry as never) },
    now: () => 1000,
    log: () => undefined,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return opts.reply ? opts.reply() : Response.json({ choices: [{ message: { content: JSON.stringify({ summary: { title: '修登录', body: '修好了登录跳转' }, principles: [{ title: '上线前快照', body: '上线前必须先做数据库快照' }] }) } }] });
    }) as typeof fetch
  });
  return { distiller, calls, usage, audits };
}

const input = { summary: '修好了登录。约定：上线前必须先做数据库快照。'.repeat(3), sessionId: 's1', seq: 2, projectId: 'proj' };

test('选了模型：hub 直调上游，密钥只在请求头，候选 staged + proposed，记用量和审计', async () => {
  const { distiller, calls, usage, audits } = setup({ provider: provider({ routing: 'direct' }) });
  const out = await distiller.distill(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://llm.example/v1/chat/completions');
  assert.equal((calls[0]!.init.headers as Record<string, string>)['authorization'], 'Bearer sk-hub-only');
  assert.ok(!String(calls[0]!.init.body).includes('sk-hub-only'));
  assert.deepEqual(out.map((c) => [c.status, c.draft.kind]), [['staged', 'episodic'], ['proposed', 'procedural']]);
  assert.equal(usage.length, 1);
  assert.deepEqual({ ...(usage[0] as object), bytesIn: 0, bytesOut: 0 }, { id: 'p1', requests: 1, errors: 0, bytesIn: 0, bytesOut: 0 });
  assert.equal(audits[0]!.action, 'memory.distill');
  assert.equal(audits[0]!.target, 'project:proj');
});

test('没选模型 → 规则版，不调上游', async () => {
  const { distiller, calls } = setup({ model: null });
  const out = await distiller.distill(input);
  assert.equal(calls.length, 0);
  assert.ok(out.length > 0);
});

test('上游失败 → 回落规则版，记一次错误', async () => {
  const { distiller, usage } = setup({ reply: () => new Response('boom', { status: 500 }) });
  const out = await distiller.distill(input);
  assert.ok(out.length > 0);
  assert.equal((usage[0] as { errors: number }).errors, 1);
});

test('不能用的提供商（停用 / 个人 / 团队不符 / 模型不在列表）→ 规则版，不调上游', async () => {
  for (const p of [provider({ enabled: false }), provider({ scope: 'personal', ownerId: 'u1' }), provider({ scope: 'team', ownerId: 't2' }), provider({ models: [{ id: 'other' }] })]) {
    const { distiller, calls } = setup({ provider: p, team: 't1' });
    await distiller.distill(input);
    assert.equal(calls.length, 0, JSON.stringify(p));
  }
});

test('摘要含密钥：不送模型，返回空', async () => {
  const { distiller, calls } = setup();
  assert.deepEqual(await distiller.distill({ ...input, summary: 'API_KEY=abcdef0123456789xyz' }), []);
  assert.equal(calls.length, 0);
});

test('anthropic 协议拼 /v1/messages 和 x-api-key', async () => {
  const { distiller, calls } = setup({
    provider: provider({ protocol: 'anthropic', baseUrl: 'https://a.example' }),
    reply: () => Response.json({ content: [{ type: 'text', text: '{"summary":{"title":"t","body":"b"},"principles":[]}' }] })
  });
  const out = await distiller.distill(input);
  assert.equal(calls[0]!.url, 'https://a.example/v1/messages');
  assert.equal((calls[0]!.init.headers as Record<string, string>)['x-api-key'], 'sk-hub-only');
  assert.equal(out.length, 1);
});

test('toCandidates：过滤密钥、限 5 条、截断、非 JSON 为空', () => {
  const many = { summary: { title: 't', body: 'x'.repeat(5000) }, principles: Array.from({ length: 9 }, (_, i) => ({ title: `p${i}`, body: i === 0 ? 'token ghp_abcdefghijklmnopqrstuvwxyz0123' : 'b' })) };
  const out = toCandidates(`好的：${JSON.stringify(many)}`, { sessionId: 's', seq: 1 });
  assert.equal(out.length, 5);
  assert.ok(out[0]!.draft.body.length <= 1000);
  assert.ok(!out.some((c) => c.draft.title === 'p0'));
  assert.deepEqual(toCandidates('not json', { sessionId: 's', seq: 1 }), []);
});
