import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { loginByApi } from './login.ts';
import { currentRun } from './run-id.ts';

/**
 * 资产中心的 MCP 资产：上传 → 装到本机 → 派生会话 → 模型真的通过注入的 stdio MCP 调工具。
 * 模型换成本地假 OpenAI 网关：第一轮从工具清单里挑出 echo 并调用，第二轮把工具结果念回来。
 * 这样断言的是 MCP 工具真的进了模型可见的工具清单，而不是只看会话资产清单。
 */
const RUN = currentRun().replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase();
const ASSET = `e2e-echo-${RUN}`;
const MARKER = `MCP-ECHO-${RUN}`;
const ECHO_SCRIPT = join(process.cwd(), 'e2e/fixtures/mcp-echo.mjs');

let upstream: Server;
let gatewayPort = 0;
let seenTools: string[] = [];

function reply(res: import('node:http').ServerResponse, stream: boolean, message: Record<string, unknown>, finish: string) {
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'c1',
        object: 'chat.completion',
        created: 1,
        model: 'm-1',
        choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    );
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta: unknown, finish_reason: string | null) =>
    res.write(
      `data: ${JSON.stringify({
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'm-1',
        choices: [{ index: 0, delta, finish_reason }]
      })}\n\n`
    );
  if (message['tool_calls']) {
    const calls = (message['tool_calls'] as Array<Record<string, unknown>>).map((call, index) => ({ index, ...call }));
    chunk({ role: 'assistant', content: null, tool_calls: calls }, null);
  } else chunk({ role: 'assistant', content: message['content'] }, null);
  chunk({}, finish);
  res.write(
    `data: ${JSON.stringify({
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'm-1',
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    })}\n\n`
  );
  res.end('data: [DONE]\n\n');
}

test.beforeAll(async () => {
  upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'm-1', object: 'model' }] }));
        return;
      }
      const body = (raw ? JSON.parse(raw) : {}) as {
        stream?: boolean;
        tools?: Array<{ function: { name: string } }>;
        messages?: Array<{ role: string; content?: unknown }>;
      };
      const tools = (body.tools ?? []).map((tool) => tool.function.name);
      seenTools = tools;
      const toolMessage = body.messages?.find((message) => message.role === 'tool');
      if (toolMessage) {
        const text = typeof toolMessage.content === 'string' ? toolMessage.content : JSON.stringify(toolMessage.content);
        reply(res, body.stream === true, { content: `MCP_ASSET_OK ${text.includes(MARKER) ? 'marker-matched' : 'marker-missing'}` }, 'stop');
        return;
      }
      // 垫片给工具名加「资产名__」前缀；Pi 可能再加一层服务器前缀，所以按后缀找。
      const target = tools.find((name) => name === 'echo' || name.endsWith('__echo'));
      if (!target) {
        reply(res, body.stream === true, { content: `NO_MCP_TOOL (${tools.join(', ') || 'none'})` }, 'stop');
        return;
      }
      reply(
        res,
        body.stream === true,
        {
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: target, arguments: JSON.stringify({ text: MARKER }) } }
          ]
        },
        'tool_calls'
      );
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  gatewayPort = (upstream.address() as { port: number }).port;
});

test.afterAll(() => {
  upstream?.closeAllConnections();
  upstream?.close();
});

test('MCP 资产：上传、装到本机，会话模型真的调到注入的工具', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };

  let workerId = '';
  for (let i = 0; i < 60 && !workerId; i++) {
    const overview = (await (await page.request.get('/api/admin/assets')).json()) as {
      workers: Array<{ workerId: string; label: string; state: string }>;
    };
    workerId = (overview.workers.find((worker) => worker.state === 'online' && worker.label === '本机') ?? overview.workers.find((worker) => worker.state === 'online'))?.workerId ?? '';
    if (!workerId) await page.waitForTimeout(500);
  }
  expect(workerId, '本机 Worker 必须在线').toBeTruthy();

  let assetId = '';
  try {
    const mcp = {
      name: ASSET,
      description: 'e2e 的 echo MCP',
      transport: 'stdio',
      command: process.execPath,
      args: [ECHO_SCRIPT]
    };
    const uploaded = await page.request.post('/api/admin/assets/upload', {
      headers,
      data: { kind: 'mcp', files: [{ path: 'mcp.json', data: Buffer.from(JSON.stringify(mcp)).toString('base64') }] }
    });
    expect(uploaded.status(), await uploaded.text()).toBe(201);
    assetId = ((await uploaded.json()) as { id: string }).id;

    const installed = await page.request.put(`/api/admin/assets/${assetId}/workers/${workerId}`, {
      headers,
      data: { installed: true }
    });
    expect(installed.ok(), await installed.text()).toBe(true);

    const slug = `mcp${RUN}`;
    const provider = await page.request.post('/api/providers', {
      headers,
      data: {
        slug,
        name: '假网关（MCP 资产）',
        protocol: 'openai-chat',
        baseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
        apiKey: 'fake-key',
        models: ['m-1'],
        routing: 'direct',
        scope: 'personal'
      }
    });
    expect(provider.ok(), await provider.text()).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'e2e-mcp-asset-'));
    const project = (await (
      await page.request.post('/api/projects', { headers, data: { name: `e2e mcp ${RUN}`, rootPath: dir } })
    ).json()) as { id: string };
    const task = (await (
      await page.request.post('/api/tasks', { headers, data: { projectId: project.id, title: `MCP 资产 ${RUN}` } })
    ).json()) as { id: string };
    const models = (await (
      await page.request.get(`/api/providers/models?taskId=${task.id}`)
    ).json()) as Array<{ slug: string; models: Array<{ id: string }> }>;
    const model = models.find((entry) => entry.slug === slug)?.models[0]?.id;
    expect(model, '假网关模型要出现在可选模型里').toBeTruthy();

    const derived = await page.request.post('/api/sessions/derive', {
      headers,
      data: { taskId: task.id, agentId: 'pi', model }
    });
    expect(derived.status(), await derived.text()).toBe(201);
    const session = (await derived.json()) as { id: string };

    // 会话启动那一刻把 MCP 资产清单记下来；先确认 hub 确实把这项发给了会话。
    await expect
      .poll(
        async () => {
          const manifest = (await (await page.request.get(`/api/sessions/${session.id}/assets`)).json()) as {
            entries: Array<{ name: string; kind: string }>;
          };
          return manifest.entries.some((entry) => entry.kind === 'mcp' && entry.name === ASSET);
        },
        { timeout: 30_000 }
      )
      .toBe(true);

    const prompted = await page.request.post(`/api/sessions/${session.id}/prompt`, {
      headers,
      data: { text: `调用 ${ASSET}__echo，参数 text 填 ${MARKER}；只调用一次。` }
    });
    expect(prompted.ok(), await prompted.text()).toBe(true);

    await expect
      .poll(
        async () => {
          const events = await (await page.request.get(`/api/sessions/${session.id}/events?after=0`)).text();
          return events;
        },
        { timeout: 120_000, intervals: [1000, 2000] }
      )
      .toContain('MCP_ASSET_OK marker-matched');

    // 工具清单里必须有注入的 echo；没有的话上面的 NO_MCP_TOOL 会先暴露出来。
    expect(seenTools.some((name) => name === 'echo' || name.endsWith('__echo'))).toBe(true);
  } finally {
    if (assetId) {
      await page.request.put(`/api/admin/assets/${assetId}/workers/${workerId}`, { headers, data: { installed: false } }).catch(() => undefined);
      await page.request.delete(`/api/admin/assets/${assetId}`, { headers }).catch(() => undefined);
    }
  }
});
