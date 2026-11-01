import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { loginByApi } from './login.ts';
import { currentRun } from './run-id.ts';

/**
 * hermes-acp（ADR 0022 D7）对着真的 hub MCP 跑一遍：真 hermes acp 进程 + 本机 worker + 真 hub，
 * 模型换成本地假 OpenAI 网关——第一轮叫 hub 工具 task_get，第二轮把工具结果念回来。
 * 需要本机装了 hermes、并用 WORKER_HERMES=1 起 e2e；否则跳过。
 */
const LOG = process.env['HERMES_IT_LOG'] ?? join(tmpdir(), 'hermes-it-requests.jsonl');
let upstream: Server;
let port = 0;
let toolSeen: string | null = null;

function reply(res: import('node:http').ServerResponse, stream: boolean, message: Record<string, unknown>, finish: string) {
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', created: 1, model: 'm-1', choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta: unknown, finish_reason: string | null) =>
    res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm-1', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (message['tool_calls']) {
    const calls = (message['tool_calls'] as Array<Record<string, unknown>>).map((call, index) => ({ index, ...call }));
    chunk({ role: 'assistant', content: null, tool_calls: calls }, null);
  } else chunk({ role: 'assistant', content: message['content'] }, null);
  chunk({}, finish);
  res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm-1', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}

test.beforeAll(async () => {
  writeFileSync(LOG, '');
  upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'm-1', object: 'model' }] }));
        return;
      }
      const body = (raw ? JSON.parse(raw) : {}) as { stream?: boolean; tools?: Array<{ function: { name: string; description?: string } }>; messages?: Array<{ role: string; content?: unknown }> };
      appendFileSync(LOG, `${JSON.stringify({ url: req.url, bridgeDesc: body.tools?.find((t) => t.function.name === 'tool_call')?.function.description?.slice(0, 2000), tools: body.tools?.map((t) => t.function.name), roles: body.messages?.map((m) => m.role) })}\n`);
      const toolMsg = body.messages?.find((m) => m.role === 'tool');
      // Hermes 默认开着 Tool Search：MCP 工具不直接出现，藏在 tool_call 桥后面，名字列在桥的描述里
      const direct = body.tools?.map((t) => t.function.name).find((name) => /task_get$/.test(name));
      const bridge = body.tools?.find((t) => t.function.name === 'tool_call');
      const bridged = body.tools?.map((t) => t.function.description ?? '').join('\n').match(/mcp__\w+?__task_get/)?.[0];
      const hubTool = direct ?? (bridge ? 'tool_call' : undefined);
      const hubArgs = direct ? '{}' : JSON.stringify({ calls: [{ name: bridged ?? 'mcp__editor_agent_hub__task_get', arguments: {} }] });
      if (toolMsg) {
        toolSeen = typeof toolMsg.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg.content);
        reply(res, body.stream === true, { content: `HUB_TOOL_OK ${toolSeen.includes('hermes 工具任务') ? 'title-matched' : 'title-missing'}` }, 'stop');
      } else if (hubTool) {
        reply(res, body.stream === true, { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: hubTool, arguments: hubArgs } }] }, 'tool_calls');
      } else {
        reply(res, body.stream === true, { content: `NO_HUB_TOOL (${(body.tools ?? []).length} tools)` }, 'stop');
      }
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  port = (upstream.address() as { port: number }).port;
});
test.afterAll(() => {
  upstream?.closeAllConnections();
  upstream?.close();
});

test('hermes-acp：真 hermes acp 会话调到 hub MCP 工具（task_get），结果回到对话', async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  let has = false;
  for (let i = 0; i < 40 && !has; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    has = workers.some((w) => w.state === 'online' && w.agentIds.includes('hermes-acp'));
    if (!has) await page.waitForTimeout(500);
  }
  test.skip(!has, '本机 worker 没有 hermes-acp（没装 hermes 或没设 WORKER_HERMES=1）');

  const slug = `hacp${currentRun().replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase()}`;
  const provider = await page.request.post('/api/providers', {
    data: { slug, name: '假网关（hermes-acp）', protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'fake-key', models: ['m-1'], routing: 'direct', scope: 'personal' },
    headers
  });
  expect(provider.ok(), await provider.text()).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), 'e2e-hermes-acp-'));
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e hermes-acp ${Date.now().toString(36)}`, rootPath: dir }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: 'hermes 工具任务' }, headers })).json()) as { id: string };
  const models = (await (await page.request.get(`/api/providers/models?taskId=${task.id}`)).json()) as Array<{ slug: string; models: Array<{ id: string }> }>;
  const model = models.find((p) => p.slug === slug)?.models[0]?.id;
  expect(model).toBeTruthy();
  const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: 'hermes-acp', model }, headers });
  expect(derived.ok(), await derived.text()).toBe(true);
  const session = (await derived.json()) as { id: string };
  const prompted = await page.request.post(`/api/sessions/${session.id}/prompt`, { data: { text: '读一下当前任务' }, headers });
  expect(prompted.ok(), await prompted.text()).toBe(true);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/#/p/${project.id}/focus/${session.id}`);
  await expect(page.getByText(/HUB_TOOL_OK|NO_HUB_TOOL/).first()).toBeVisible({ timeout: 180_000 });
  await page.screenshot({ path: '/workspace/shots/hermes-acp/session.png' });
  await expect(page.getByText('HUB_TOOL_OK title-matched').first()).toBeVisible();
  expect(toolSeen).toContain('hermes 工具任务');
  // Hermes 回报的是 custom:m-1；hub 这边仍应记成 hub 模型，重开会话才配得上提供商
  await expect(page.getByText('custom:m-1', { exact: true })).toHaveCount(0);
});
