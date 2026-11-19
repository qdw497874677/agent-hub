import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, request as apiRequest, type APIRequestContext } from '@playwright/test';
import { loginByApi } from './login.ts';
import { e2eHubModel, piModel } from './hub-model.ts';
import { serverEnv } from './server-env.ts';
import { e2eWorkerRoots } from './isolation.ts';

/**
 * 会话通信 P1d（docs/design/session-communication.md §5.4 / §10.2 / E2 子集）：外部 agent 只用开放 API / MCP，
 * 在远程机器上开两条会话 → session_link → session_peers → session_message(ask) → message_get(waitSec) / message_inbox 取回复
 * → events / get_session 的 waitSec → 本机 Worker 上的会话拒绝 → 吊销令牌后 401。
 */
type Accepted = { messageId: string; status: string };

test('外部 agent：连线、同伴、ask 回复进外部收件箱、长轮询、本机拒绝、吊销 401', async ({ page, baseURL }) => {
  test.setTimeout(420_000);
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const name = `e2e-sc-ext-${Date.now().toString(36)}`;
  const scopes = ['projects:write', 'sessions:write', 'workers:read', ...(e2eHubModel() ? ['providers:use'] : [])];
  const minted = await page.request.post('/api/tokens', { data: { name, scopes }, headers });
  expect(minted.status(), await minted.text()).toBe(201);
  const { token, info } = (await minted.json()) as { token: string; info: { id: string } };
  const bot = await apiRequest.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${token}` } });

  const pairing = (await (await page.request.post('/api/workers/pairing', { headers })).json()) as { code: string };
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], {
    env: { PATH: process.env['PATH'] ?? '', HUB_URL: hubUrl, HUB_PAIR: pairing.code, WORKER_LABEL: 'e2e 会话通信外部' },
    encoding: 'utf8'
  });
  expect(enrolled.status, enrolled.stderr).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-sc-ext-'));
  const dir = join(state, 'repo');
  mkdirSync(dir);
  let worker: ChildProcess | null = null;
  try {
    worker = spawn(process.execPath, ['apps/worker/src/main.ts'], {
      env: { ...serverEnv(), HUB_URL: hubUrl, HUB_WORKER_CREDENTIAL: credential, WORKER_ID: workerId, WORKER_ORIGIN: 'remote', WORKER_LABEL: 'e2e 会话通信外部', WORKER_ROOTS: e2eWorkerRoots(), WORKER_STATE_DIR: state },
      stdio: 'ignore'
    });
    let agentId: string | undefined;
    await expect.poll(async () => {
      const list = (await (await bot.get('/openapi/v1/workers')).json()) as { workerId: string; agentIds?: string[]; state: string }[];
      agentId = list.find((entry) => entry.workerId === workerId && entry.state === 'online')?.agentIds?.[0];
      return Boolean(agentId);
    }, { timeout: 30_000 }).toBe(true);

    const project = (await (await bot.post('/openapi/v1/projects', { data: { name: `${name} 远程`, rootPath: dir, workerId } })).json()) as { id: string };
    const taskId = ((await (await bot.post('/openapi/v1/tasks', { data: { projectId: project.id, title: '外部编排' } })).json()) as { id: string }).id;
    const start = async () => {
      const started = await bot.post('/openapi/v1/sessions', { data: { taskId, agentId, model: piModel(), workerId } });
      expect(started.status(), await started.text()).toBe(201);
      return ((await started.json()) as { id: string }).id;
    };
    const [dev, verify] = [await start(), await start()];

    // session_link / session_peers
    const linked = await bot.post(`/openapi/v1/sessions/${dev}/links`, { data: { otherSessionId: verify } });
    expect(linked.status(), await linked.text()).toBe(201);
    const peers = (await (await bot.get(`/openapi/v1/sessions/${dev}/peers`)).json()) as { peers: { address: string; handle: string; workerId: string }[] };
    expect(peers.peers.map((p) => p.address)).toEqual([`session:${verify}`]);
    expect(peers.peers[0]!.workerId).toBe(workerId);

    // session_message(ask) → message_get(waitSec)
    const asked = await bot.post(`/openapi/v1/sessions/${verify}/messages`, {
      data: { kind: 'ask', body: '请只回复四个字母 PONG', parts: [{ type: 'data', schema: 'task/v1', data: { check: 'pong' } }], timeoutSec: 600 }
    });
    expect(asked.status(), await asked.text()).toBe(201);
    const { messageId } = (await asked.json()) as Accepted;
    let reply: { replyStatus: string | null; body: string; failure: string | null } | null = null;
    for (let i = 0; i < 6 && !reply; i++) {
      const got = (await (await bot.get(`/openapi/v1/messages/${messageId}?waitSec=50`, { timeout: 70_000 })).json()) as { message: { status: string; from: string }; reply: typeof reply };
      expect(got.message.from).toBe(`external:${info.id}`);
      reply = got.reply;
    }
    expect(reply, '6 次长轮询内应当拿到回复').toBeTruthy();
    expect(['ok', 'failed', 'refused']).toContain(reply!.replyStatus);
    test.info().annotations.push({ type: 'external-reply', description: `${reply!.replyStatus} ${reply!.failure ?? ''} ${reply!.body.slice(0, 40)}` });
    const inbox = (await (await bot.get('/openapi/v1/inbox')).json()) as { messages: { replyTo: string | null }[]; next: number };
    expect(inbox.messages.map((m) => m.replyTo)).toContain(messageId);
    const empty = (await (await bot.get(`/openapi/v1/inbox?after=${inbox.next}`)).json()) as { messages: unknown[] };
    expect(empty.messages.length).toBe(0);
    // 被问的会话时间线里有带「外部」署名的不可信包装
    const events = await (await page.request.get(`/api/sessions/${verify}/events`)).text();
    expect(events).toContain('external:');

    // waitSec：get_session 等这一轮结束；events 没新事件时等到点返回
    const session = (await (await bot.get(`/openapi/v1/sessions/${verify}?waitSec=20`, { timeout: 40_000 })).json()) as { status: string; lastSeq?: number };
    expect(session.status).not.toBe('running');
    const t0 = Date.now();
    const tail = (await (await bot.get(`/openapi/v1/sessions/${verify}/events?after=999999&waitSec=2`)).json()) as { events: unknown[]; nextAfter: number };
    expect(Array.isArray(tail.events)).toBe(true);
    expect(tail.events.length).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1500);

    // 防风暴：重复内容
    const fyi = { kind: 'send', body: 'FYI：主干已更新', wake: false };
    expect((await bot.post(`/openapi/v1/sessions/${dev}/messages`, { data: fyi })).status()).toBe(201);
    const dup = await bot.post(`/openapi/v1/sessions/${dev}/messages`, { data: fyi });
    expect(dup.status()).toBe(403);
    expect(await dup.text()).toContain('duplicate');

    // MCP：工具在清单里；session_message 带 clientRequestId 重放同一条
    const mcp = async (body: unknown) => (await (await bot.post('/openapi/v1/mcp', { data: body, headers: { accept: 'application/json, text/event-stream' } })).json()) as any;
    await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } });
    const tools = (await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })).result.tools.map((tool: { name: string }) => tool.name) as string[];
    for (const tool of ['session_link', 'session_unlink', 'session_peers', 'session_message', 'message_get', 'message_inbox']) expect(tools).toContain(tool);
    const call = (id: number) => mcp({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'session_message', arguments: { sessionId: dev, kind: 'send', body: '经 MCP 的通知', wake: false, clientRequestId: `${name}-1` } } });
    const first = await call(3);
    expect(first.result.isError, JSON.stringify(first.result)).toBe(false);
    const second = await call(4);
    expect(second.result.structuredContent.messageId).toBe(first.result.structuredContent.messageId);
    const viaMcp = await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'message_inbox', arguments: {} } });
    expect(viaMcp.result.isError).toBe(false);

    // session_unlink
    expect((await bot.post(`/openapi/v1/sessions/${dev}/unlink`, { data: { otherSessionId: verify } })).status()).toBe(200);
    expect(((await (await bot.get(`/openapi/v1/sessions/${dev}/peers`)).json()) as { peers: unknown[] }).peers.length).toBe(0);
  } finally {
    worker?.kill();
    rmSync(state, { recursive: true, force: true });
    await page.request.delete(`/api/workers/${workerId}`, { headers }).catch(() => undefined);
  }

  // 本机 Worker 上的会话：令牌发消息也被拒（会开新一轮，等同 session_reply）
  const browserWorkers = (await (await page.request.get('/api/workers')).json()) as { workerId: string; origin: string; agentIds: string[]; state: string }[];
  const local = browserWorkers.find((w) => w.origin === 'local' && w.state === 'online');
  if (local) {
    const localDir = mkdtempSync(join(tmpdir(), 'e2e-sc-ext-local-'));
    const p = (await (await page.request.post('/api/projects', { data: { name: `${name} local`, rootPath: localDir }, headers })).json()) as { id: string };
    const t = (await (await page.request.post('/api/tasks', { data: { projectId: p.id, title: '本机' }, headers })).json()) as { id: string };
    const s = (await (await page.request.post('/api/sessions/derive', { data: { taskId: t.id, agentId: local.agentIds[0], model: piModel(), workerId: local.workerId }, headers })).json()) as { id: string };
    const denied = await bot.post(`/openapi/v1/sessions/${s.id}/messages`, { data: { kind: 'send', body: 'hi' } });
    expect(denied.status(), await denied.text()).toBe(403);
  } else {
    test.info().annotations.push({ type: 'local-worker', description: '没有在线的本机 Worker，跳过本机拒绝这一步' });
  }

  // 吊销：收件箱随令牌关闭
  expect((await page.request.delete(`/api/tokens/${info.id}`, { headers })).ok()).toBe(true);
  expect((await bot.get('/openapi/v1/inbox')).status()).toBe(401);
});
