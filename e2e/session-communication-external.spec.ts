import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, request as apiRequest } from '@playwright/test';
import { loginByApi } from './login.ts';
import { e2eHubModel } from './hub-model.ts';
import { ensureFakeWorker, stopFakeWorker } from './fake-worker.ts';

/**
 * 会话通信 P1d（docs/design/session-communication.md §5.4 / §10.2 / E2 子集）：外部 agent 只用开放 API / MCP，
 * 在远程机器上开两条会话 → session_link → session_peers → session_message(ask) → message_get(waitSec) / message_inbox 取回复
 * → events / get_session 的 waitSec → 令牌在本机 Worker 上开会话被拒 → 吊销令牌后 401。
 */
type Accepted = { messageId: string; status: string };

// 用 e2e/fake-worker.ts 里那个真跑 ACP 的假 Worker：它显式带 ACP_AGENTS，机器一上线就有确定的 agentId，
// 不依赖宿主机装没装 Pi。enroll / 启动 worker 的这些步骤由该 fixture 覆盖，本文件不再手工重复一遍。
const AGENT_ID = 'fakeacpext';

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

  const workerId = await ensureFakeWorker(page, baseURL!, AGENT_ID);
  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-sc-ext-'));
  const dir = join(state, 'repo');
  mkdirSync(dir);
  try {
    // 外部令牌看到的是同一份机器清单：这台机器在线，并且上报了我们显式配的那个 agent。
    await expect.poll(async () => {
      const list = (await (await bot.get('/openapi/v1/workers')).json()) as { workerId: string; agentIds?: string[]; state: string }[];
      const entry = list.find((each) => each.workerId === workerId);
      return entry?.state === 'online' && (entry.agentIds ?? []).includes(AGENT_ID);
    }, { timeout: 30_000, message: `外部令牌应看到 ${workerId} 在线并上报 ${AGENT_ID}` }).toBe(true);

    const project = (await (await bot.post('/openapi/v1/projects', { data: { name: `${name} 远程`, rootPath: dir, workerId } })).json()) as { id: string };
    const taskId = ((await (await bot.post('/openapi/v1/tasks', { data: { projectId: project.id, title: '外部编排' } })).json()) as { id: string }).id;
    const start = async () => {
      // 这是 fake ACP --models 实际上报的模型；不依赖项目默认 Agent 或宿主模型。
      const started = await bot.post('/openapi/v1/sessions', { data: { taskId, agentId: AGENT_ID, model: 'fake/m1', workerId } });
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
    type Reply = { replyStatus: string | null; body: string; failure: string | null };
    let reply: Reply | null = null;
    for (let i = 0; i < 6 && !reply; i++) {
      const got = (await (await bot.get(`/openapi/v1/messages/${messageId}?waitSec=50`, { timeout: 70_000 })).json()) as { message: { status: string; from: string }; reply: Reply | null };
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
    expect(typeof tail.nextAfter).toBe('number');
    expect(tail.nextAfter).toBeGreaterThanOrEqual(999999);
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
    const afterUnlink = (await (await bot.get(`/openapi/v1/sessions/${dev}/peers`)).json()) as { peers: { address: string; relation?: string; connected?: boolean }[] };
    const sameTaskPeer = afterUnlink.peers.find((peer) => peer.address === `session:${verify}`);
    expect(sameTaskPeer?.relation).toBe('task_tree');
    expect(sameTaskPeer?.connected).not.toBe(true);
  } finally {
    stopFakeWorker();
    rmSync(state, { recursive: true, force: true });
    await page.request.delete(`/api/workers/${workerId}`, { headers }).catch(() => undefined);
  }

  // 本机 Worker：令牌连"开"都不许（openapi 永远不能用 hub 同机的机器）。
  // 这条策略在 deriveSessionUseCase 里先于就绪检查拒绝（packages/domain/src/use-cases/sessions.ts:178-183），
  // 所以不需要本机真装某个 agent、也不受「检测超时」影响——不依赖环境里的 pi。
  const localWorker = async (): Promise<{ workerId: string; agentIds: string[] } | undefined> => {
    const browserWorkers = (await (await page.request.get('/api/workers')).json()) as { workerId: string; origin: string; agentIds: string[]; state: string }[];
    return browserWorkers.find((w) => w.origin === 'local' && w.state === 'online');
  };
  await expect.poll(localWorker, { message: 'E2E Hub 应启动本机 Worker' }).toBeDefined();
  const local = (await localWorker())!;
  const localDir = mkdtempSync(join(tmpdir(), 'e2e-sc-ext-local-'));
  try {
    const p = (await (await page.request.post('/api/projects', { data: { name: `${name} local`, rootPath: localDir }, headers })).json()) as { id: string };
    const t = (await (await page.request.post('/api/tasks', { data: { projectId: p.id, title: '本机' }, headers })).json()) as { id: string };
    const denied = await bot.post('/openapi/v1/sessions', {
      // model 显式给一个原生名（不是 hub 模型 → checkModel 放行），跳过「没有默认模型」那条 400，
      // 让拒绝来自真正的策略点（authorizeWorker：本机只给集群管理员）。
      data: { taskId: t.id, agentId: local.agentIds[0] ?? 'pi', model: 'm1', workerId: local.workerId }
    });
    expect(denied.status(), await denied.text()).toBe(403);
    expect((await denied.json() as { error?: { message?: string } }).error?.message ?? '').toContain('本机');
  } finally {
    rmSync(localDir, { recursive: true, force: true });
  }

  // 吊销：收件箱随令牌关闭
  expect((await page.request.delete(`/api/tokens/${info.id}`, { headers })).ok()).toBe(true);
  expect((await bot.get('/openapi/v1/inbox')).status()).toBe(401);
});
