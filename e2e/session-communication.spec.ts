import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { piModel } from './hub-model.ts';

/**
 * 会话通信 P1a（docs/design/session-communication.md §16 E1/E3/E4/E5 的单机子集）：
 * peer:<短名>、parts、wake=false 未读、防风暴（重复 / 按对限速）、已收起返回 archived；
 * E2E_REAL=1 时再跑一条真模型：A 用 agent.ask 问 peer:verify，B 用 agent.reply（或最后一轮文字）答。
 * 来回打转被拦下（held）与放行在 domain 单测里逐条测（要求同一条链里连续往返，真模型不好诱导稳定复现）。
 */
type Msg = {
  messageId: string; kind: string; status: string; to: string; from: string; reply: string | null; failure: string | null; replyTo: string | null;
  parts: { type: string }[]; wake: boolean; replyStatus: string | null; readAt: number | null; holdReason: string | null;
};
type Peer = { address: string; handle: string; status: string; workerId: string | null; repo: string | null; branch: string | null };
const REAL = process.env['E2E_REAL'] === '1';

async function world(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  let agentId: string | undefined;
  for (let i = 0; i < 40 && !agentId; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((worker) => worker.state === 'online')?.agentIds[0];
    if (!agentId) await page.waitForTimeout(500);
  }
  test.skip(!agentId, '这台机器上没有可用的 agent');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-sc-'));
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 会话通信 ${Date.now().toString(36)}`, rootPath: dir }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '会话通信' }, headers })).json()) as { id: string };
  const session = async (): Promise<string> => {
    const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: piModel() }, headers });
    expect(derived.status(), await derived.text()).toBe(201);
    return ((await derived.json()) as { id: string }).id;
  };
  const send = (from: string, data: Record<string, unknown>) => page.request.post(`/api/sessions/${from}/messages`, { data, headers });
  const link = (aSessionId: string, bSessionId: string) => page.request.post(`/api/projects/${project.id}/session-links`, { data: { aSessionId, bSessionId }, headers });
  const messages = async (id: string, unread = false): Promise<Msg[]> => ((await (await page.request.get(`/api/sessions/${id}/messages${unread ? '?unread=1' : ''}`)).json()) as { messages: Msg[] }).messages;
  const peers = async (id: string): Promise<Peer[]> => ((await (await page.request.get(`/api/sessions/${id}/peers`)).json()) as { peers: Peer[] }).peers;
  const setHandle = (id: string, handle: string) => page.request.put(`/api/sessions/${id}/handle`, { data: { handle }, headers });
  return { agentId: agentId!, project: project.id, headers, session, send, link, messages, peers, setHandle };
}

test('同伴与短名：peers 列出短名 / 机器 / 状态；peer:<短名> 能投；重名 409；没连线的找不到并列出可用短名', async ({ page, baseURL }) => {
  const w = await world(page, baseURL!);
  const [a, b, c] = [await w.session(), await w.session(), await w.session()];
  expect((await w.link(a, b)).status()).toBe(201);
  const peers = await w.peers(a);
  expect(peers.map((p) => p.address)).toEqual([`session:${b}`]);
  expect(peers[0]!.handle).toMatch(/^[a-z][a-z0-9-]+-[a-z0-9]{4}$/);
  expect(peers[0]!.workerId).toBeTruthy();

  expect((await w.setHandle(b, 'verify')).status()).toBe(200);
  expect((await w.setHandle(c, 'verify')).status(), '同任务内重名').toBe(409);
  expect((await w.setHandle(c, 'Bad Name')).status()).toBe(400);
  expect((await w.peers(a))[0]!.handle).toBe('verify');

  const sent = await w.send(a, { kind: 'send', to: 'peer:verify', body: 'FYI：只是通知，不用回复', wake: false });
  expect(sent.status(), await sent.text()).toBe(201);
  expect(((await sent.json()) as { status: string; targetSessionId: string }).targetSessionId).toBe(b);

  const missing = await w.send(a, { kind: 'send', to: 'peer:nobody', body: 'hi' });
  expect(missing.status()).toBe(403);
  expect(await missing.text()).toContain('peer:verify');
  const notLinked = await w.send(c, { kind: 'send', to: `session:${b}`, body: 'hi' });
  expect(notLinked.status()).toBe(403);
});

test('wake=false 只进收件箱：不起新一轮，未读可查；parts 校验与回显', async ({ page, baseURL }) => {
  const w = await world(page, baseURL!);
  const [a, b] = [await w.session(), await w.session()];
  expect((await w.link(a, b)).status()).toBe(201);
  const bad = await w.send(a, { kind: 'send', to: `session:${b}`, body: 'x', parts: [{ type: 'link', url: 'javascript:alert(1)' }] });
  expect(bad.status()).toBe(400);
  const badAsk = await w.send(a, { kind: 'ask', to: `session:${b}`, body: 'x', wake: false });
  expect(badAsk.status()).toBe(400);
  const note = await w.send(a, {
    kind: 'send', to: `session:${b}`, body: '主干更新了，空了再看', wake: false,
    parts: [{ type: 'link', url: 'https://example.com/pr/1', label: 'PR 1' }, { type: 'data', schema: 'note/v1', data: { n: 1 } }]
  });
  expect(note.status(), await note.text()).toBe(201);
  const { messageId, status } = (await note.json()) as { messageId: string; status: string };
  expect(status).toBe('done');
  const unread = await w.messages(b, true);
  expect(unread.map((m) => m.messageId)).toContain(messageId);
  const stored = unread.find((m) => m.messageId === messageId)!;
  expect(stored.wake).toBe(false);
  expect(stored.parts.map((p) => p.type)).toEqual(['link', 'data']);
  // 没有起新一轮：B 的事件里没有 <agent-message>
  const events = await (await page.request.get(`/api/sessions/${b}/events`)).text();
  expect(events.includes('<agent-message')).toBe(false);
});

test('防风暴：相同内容被拒 duplicate；同一对 1 分钟超过 6 条 rate_limited；审计留 denied', async ({ page, baseURL }) => {
  const w = await world(page, baseURL!);
  const [a, b] = [await w.session(), await w.session()];
  expect((await w.link(a, b)).status()).toBe(201);
  expect((await w.send(a, { kind: 'send', to: `session:${b}`, body: '同一句话', wake: false })).status()).toBe(201);
  const dup = await w.send(a, { kind: 'send', to: `session:${b}`, body: '同一句话', wake: false });
  expect(dup.status()).toBe(403);
  expect(await dup.text()).toContain('duplicate');
  for (let i = 0; i < 5; i++) expect((await w.send(a, { kind: 'send', to: `session:${b}`, body: `第 ${i} 条`, wake: false })).status()).toBe(201);
  const seventh = await w.send(a, { kind: 'send', to: `session:${b}`, body: '第 7 条', wake: false });
  expect(seventh.status()).toBe(409);
  expect(await seventh.text()).toContain('rate_limited');
});

test('已收起的会话：消息直接返回 archived；peers 里标 archived', async ({ page, baseURL }) => {
  const w = await world(page, baseURL!);
  const [a, b] = [await w.session(), await w.session()];
  expect((await w.link(a, b)).status()).toBe(201);
  const stopped = await page.request.post(`/api/sessions/${b}/interrupt`, { headers: w.headers });
  expect(stopped.ok(), await stopped.text()).toBe(true);
  const settled = await page.request.post(`/api/sessions/${b}/settle`, { headers: w.headers, data: { settled: true } });
  expect(settled.ok(), await settled.text()).toBe(true);
  const sent = await w.send(a, { kind: 'ask', to: `session:${b}`, body: '还在吗？' });
  expect(sent.status()).toBe(403);
  expect(await sent.text()).toContain('archived');
  expect((await w.peers(a)).find((p) => p.address === `session:${b}`)?.status).toBe('archived');
});

test('真模型：A 用 agent.ask 问 peer:verify，B 答复带 replyStatus；回到 A 的同一条 messageId', async ({ page, baseURL }) => {
  test.skip(!REAL, '只在 E2E_REAL=1 时跑');
  test.setTimeout(420_000);
  const w = await world(page, baseURL!);
  const [a, b] = [await w.session(), await w.session()];
  expect((await w.link(a, b)).status()).toBe(201);
  expect((await w.setHandle(b, 'verify')).status()).toBe(200);
  const prompt = [
    '请调用 agent.ask 工具（不要用别的方式），参数：',
    'to = "peer:verify"',
    'body = "请只回复四个字母 PONG"',
    'parts = [{"type":"data","schema":"task/v1","data":{"check":"pong"}}]',
    '调用成功后直接结束这一轮，不要等待、不要轮询。'
  ].join('\n');
  const prompted = await page.request.post(`/api/sessions/${a}/prompt`, { data: { text: prompt, attachments: [] }, headers: w.headers });
  expect(prompted.ok(), await prompted.text()).toBe(true);
  await expect.poll(async () => (await w.messages(a)).some((m) => m.kind === 'ask' && m.from === `session:${a}`), { timeout: 180_000, intervals: [2000] }).toBe(true);
  const ask = (await w.messages(a)).find((m) => m.kind === 'ask' && m.from === `session:${a}`)!;
  expect(ask.to).toBe('peer:verify');
  test.info().annotations.push({ type: 'ask-parts', description: JSON.stringify(ask.parts) });
  await expect.poll(async () => (await w.messages(a)).find((m) => m.kind === 'reply' && m.replyTo === ask.messageId)?.replyStatus ?? null, { timeout: 240_000, intervals: [3000] }).not.toBeNull();
  const reply = (await w.messages(a)).find((m) => m.kind === 'reply' && m.replyTo === ask.messageId)!;
  expect(['ok', 'failed', 'refused']).toContain(reply.replyStatus);
  const final = (await w.messages(a)).find((m) => m.messageId === ask.messageId)!;
  test.info().annotations.push({ type: 'ask-result', description: `${final.status} ${reply.replyStatus} ${final.failure ?? ''}` });
  expect(final.status).toMatch(/answered|failed/);
  // B 收到的那一轮带不可信包装
  expect((await (await page.request.get(`/api/sessions/${b}/events`)).text()).includes('<agent-message')).toBe(true);
});
