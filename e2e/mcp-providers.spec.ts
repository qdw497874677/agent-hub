import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, request as apiRequest, type APIRequestContext } from '@playwright/test';
import { loginByApi } from './login.ts';
import { hubProviderBaseUrl } from './hub-model.ts';
import { serverEnv } from './server-env.ts';
import { e2eWorkerPath, e2eWorkerRoots } from './isolation.ts';
import { currentRun } from './run-id.ts';

/**
 * 外部 agent 只用 MCP 配置国内智谱 glm-5.3-flash：新建 → 探测/测试真实连通 → 开会话拿到真实回复 → 确认后删除。
 * 密钥来自测试进程的 ZAI_CODING_CN_API_KEY，不传给 hub / worker 环境，也不打印。
 */
const KEY = process.env['ZAI_CODING_CN_API_KEY'] ?? '';

test('外部 MCP：创建智谱提供商、实测、开会话、确认删除', async ({ page, baseURL }) => {
  test.skip(!KEY, '没有 ZAI_CODING_CN_API_KEY');
  test.setTimeout(420_000);
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const slug = `mcpglm${currentRun().replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase()}`;
  const model = `hub-${slug}/glm-5.3-flash`;
  const name = `e2e-mcp-prov-${slug}`;

  const minted = await page.request.post('/api/tokens', {
    data: { name, scopes: ['projects:write', 'sessions:write', 'workers:read', 'providers:manage'] },
    headers
  });
  expect(minted.status(), await minted.text()).toBe(201);
  const { token } = (await minted.json()) as { token: string };
  expect(token.includes(KEY), '令牌响应里出现了密钥').toBe(false);
  const bot = await apiRequest.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${token}` } });

  let rpcId = 1;
  const mcp = async (tool: string, args: Record<string, unknown> = {}) => {
    const body = { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: tool, arguments: args } };
    const res = await bot.post('/openapi/v1/mcp', { data: body, headers: { accept: 'application/json, text/event-stream' } });
    const text = await res.text();
    expect(text.includes(KEY), `${tool} 响应里出现了密钥`).toBe(false);
    expect(res.status(), text.slice(0, 300)).toBe(200);
    return JSON.parse(text) as { result: { isError?: boolean; content?: { text?: string }[]; structuredContent?: any } };
  };
  const listedTools = await bot.post('/openapi/v1/mcp', {
    data: { jsonrpc: '2.0', id: rpcId++, method: 'tools/list', params: {} },
    headers: { accept: 'application/json, text/event-stream' }
  });
  const listedText = await listedTools.text();
  expect(listedText.includes(KEY)).toBe(false);
  const names = ((JSON.parse(listedText) as { result: { tools: { name: string }[] } }).result.tools ?? []).map((t) => t.name);
  for (const tool of ['provider_list', 'provider_create', 'provider_probe', 'provider_test', 'provider_delete']) {
    expect(names, `缺 ${tool}`).toContain(tool);
  }

  const created = await mcp('provider_create', {
    slug,
    name: 'E2E 智谱 Coding',
    protocol: 'openai-chat',
    baseUrl: hubProviderBaseUrl(),
    models: [{ id: 'glm-5.3-flash' }],
    routing: 'hub',
    scope: 'hub',
    enabled: true,
    apiKey: KEY,
    clientRequestId: `${name}-create`
  });
  expect(created.result.isError, created.result.content?.[0]?.text ?? '').toBeFalsy();
  const provider = created.result.structuredContent as { id: string; hasKey: boolean; apiKey?: unknown };
  expect(provider.id).toBeTruthy();
  expect(provider.hasKey).toBe(true);
  expect(provider.apiKey).toBeUndefined();

  const probed = await mcp('provider_probe', { providerId: provider.id, clientRequestId: `${name}-probe` });
  expect(probed.result.isError, probed.result.content?.[0]?.text ?? '').toBeFalsy();
  expect(probed.result.structuredContent.ok).toBe(true);

  const pairing = (await (await page.request.post('/api/workers/pairing', { headers })).json()) as { code: string };
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], {
    env: { PATH: process.env['PATH'] ?? '', HUB_URL: hubUrl, HUB_PAIR: pairing.code, WORKER_LABEL: 'e2e mcp 提供商' },
    encoding: 'utf8'
  });
  expect(enrolled.status, enrolled.stderr).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-mcp-prov-'));
  const dir = join(state, 'repo');
  mkdirSync(dir);
  let worker: ChildProcess | null = null;
  try {
    worker = spawn(process.execPath, ['apps/worker/src/main.ts'], {
      env: {
        ...serverEnv(),
        PATH: e2eWorkerPath('', { agents: true }),
        HUB_URL: hubUrl,
        HUB_WORKER_CREDENTIAL: credential,
        WORKER_ID: workerId,
        WORKER_ORIGIN: 'remote',
        WORKER_LABEL: 'e2e mcp 提供商',
        WORKER_ROOTS: e2eWorkerRoots(),
        WORKER_STATE_DIR: state
      },
      stdio: 'ignore'
    });
    let agentId: string | undefined;
    await expect
      .poll(async () => {
        const list = (await (await bot.get('/openapi/v1/workers')).json()) as { workerId: string; agentIds?: string[]; state: string }[];
        agentId = list.find((entry) => entry.workerId === workerId && entry.state === 'online')?.agentIds?.[0];
        return Boolean(agentId);
      }, { timeout: 30_000, intervals: [1000] })
      .toBe(true);

    const tested = await mcp('provider_test', { providerId: provider.id, workerId, clientRequestId: `${name}-test` });
    expect(tested.result.isError, tested.result.content?.[0]?.text ?? '').toBeFalsy();
    expect(tested.result.structuredContent.ok).toBe(true);

    const project = (await (await bot.post('/openapi/v1/projects', { data: { name: `${name} 远程`, rootPath: dir, workerId } })).json()) as { id: string };
    const taskId = ((await (await bot.post('/openapi/v1/tasks', { data: { projectId: project.id, title: 'MCP 提供商会话' } })).json()) as { id: string }).id;
    const started = await bot.post('/openapi/v1/sessions', { data: { taskId, agentId, model, workerId } });
    expect(started.status(), await started.text()).toBe(201);
    const sessionId = ((await started.json()) as { id: string }).id;

    const prompt = await mcp('session_reply', {
      sessionId,
      text: '请只回复 MCP-PROVIDER-OK 这几个字，不要解释，不要加标点。',
      clientRequestId: `${name}-reply`,
      clientMessageId: `${name}-msg`
    });
    expect(prompt.result.isError, prompt.result.content?.[0]?.text ?? '').toBeFalsy();
    const turn = (prompt.result.structuredContent as { turn?: number }).turn;
    expect(turn, 'session_reply 应返回 turn').toEqual(expect.any(Number));

    const reply = await waitText(bot, sessionId, turn!, KEY);
    expect(reply).toMatch(/MCP-PROVIDER-OK/i);

    const preview = await mcp('provider_delete', { providerId: provider.id, clientRequestId: `${name}-del-preview` });
    expect(preview.result.isError, preview.result.content?.[0]?.text ?? '').toBeFalsy();
    expect(preview.result.structuredContent.confirmRequired).toBe(true);
    const still = await mcp('provider_list');
    const slugs = ((still.result.structuredContent?.providers ?? []) as { slug: string }[]).map((p) => p.slug);
    expect(slugs).toContain(slug);

    const removed = await mcp('provider_delete', { providerId: provider.id, confirm: true, clientRequestId: `${name}-del` });
    expect(removed.result.isError, removed.result.content?.[0]?.text ?? '').toBeFalsy();
    expect(removed.result.structuredContent.confirmed).toBe(true);
    const after = await mcp('provider_list');
    const afterSlugs = ((after.result.structuredContent?.providers ?? []) as { slug: string }[]).map((p) => p.slug);
    expect(afterSlugs).not.toContain(slug);
  } finally {
    worker?.kill();
    rmSync(state, { recursive: true, force: true });
    await page.request.delete(`/api/workers/${workerId}`, { headers }).catch(() => undefined);
    await bot.dispose();
  }
});

async function waitText(bot: APIRequestContext, sessionId: string, turn: number, secret: string): Promise<string> {
  let after = 0;
  const chunks: string[] = [];
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const res = await bot.get(`/openapi/v1/sessions/${sessionId}/events?after=${after}&sinceTurn=${turn}&waitSec=50`, { timeout: 70_000 });
    const text = await res.text();
    expect(text.includes(secret), '事件流里出现了密钥').toBe(false);
    if (res.status() === 429) {
      const retry = Number(res.headers()['retry-after'] ?? '2');
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, retry) * 1000));
      continue;
    }
    expect(res.status(), text.slice(0, 300)).toBe(200);
    const payload = JSON.parse(text) as { events?: { seq?: number; turn?: number; event?: { kind?: string; text?: string; delta?: string; outcome?: string; reason?: string } }[]; nextAfter?: number };
    if (!Array.isArray(payload.events)) throw new Error(`events 返回不是 { events, nextAfter }：${text.slice(0, 200)}`);
    // nextAfter 是本窗最后一条原始 seq：events 为空（只丢掉了 thinking/prompt）时也必须前进，不能只靠条目 seq。
    expect(typeof payload.nextAfter, text.slice(0, 200)).toBe('number');
    if (typeof payload.nextAfter === 'number') after = Math.max(after, payload.nextAfter);
    for (const entry of payload.events) {
      after = Math.max(after, entry.seq ?? 0);
      const event = entry.event ?? {};
      const piece = typeof event.text === 'string' && event.text
        ? event.text
        : typeof event.delta === 'string' ? event.delta : '';
      if (event.kind === 'text' && piece) chunks.push(piece);
      if (event.kind === 'ended' && (entry.turn === undefined || entry.turn === turn)) {
        if (event.outcome && event.outcome !== 'done') {
          throw new Error(`这一轮 ${event.outcome}：${event.reason ?? ''}；已收到：${chunks.join('').slice(0, 200)}`);
        }
        return chunks.join('');
      }
    }
  }
  throw new Error(`会话没有在时限内结束；已收到：${chunks.join('').slice(0, 200)}`);
}
