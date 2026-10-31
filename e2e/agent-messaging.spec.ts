import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * ADR 0018 · agent 间通信 P2P：A ask B 拿到回复、B 忙时排队、没权限 / 找不到被拒、派生要人批（批准卡片，390px 手机宽度）。
 * 深度 / 扇出 / 并发上限和隔离在 domain 单测里逐条测。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'] ?? '/workspace/shots/agent-messaging';
type Msg = { messageId: string; kind: string; status: string; reply: string | null; failure: string | null; replyTo: string | null; from: string };

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
  const dir = mkdtempSync(join(tmpdir(), 'e2e-msg-'));
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 协作 ${Date.now().toString(36)}`, rootPath: dir }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: 'agent 协作' }, headers })).json()) as { id: string };
  const session = async (): Promise<string> => {
    const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers });
    expect(derived.status(), await derived.text()).toBe(201);
    return ((await derived.json()) as { id: string }).id;
  };
  const send = (from: string, data: { kind: 'send' | 'ask'; to: string; body: string }) => page.request.post(`/api/sessions/${from}/messages`, { data, headers });
  const messages = async (id: string): Promise<{ messages: Msg[]; awaitingApproval: Msg[] }> => (await page.request.get(`/api/sessions/${id}/messages`)).json();
  return { agentId: agentId!, project: project.id, headers, session, send, messages };
}

const TERMINAL = ['answered', 'done', 'failed', 'denied'];

test('A ask B：B 这一轮结束后回复排回 A；审计按 traceId 串起来', async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const w = await world(page, baseURL!);
  const a = await w.session();
  const b = await w.session();
  const asked = await w.send(a, { kind: 'ask', to: `session:${b}`, body: '只回复四个字母：PONG' });
  expect(asked.status(), await asked.text()).toBe(201);
  const { messageId } = (await asked.json()) as { messageId: string };
  // B 收到的是一轮带 <agent-message> 包装的提问，作者标成 agent 消息
  await expect.poll(async () => (await (await page.request.get(`/api/sessions/${b}/events`)).text()).includes('<agent-message'), { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await w.messages(a)).messages.find((m) => m.messageId === messageId)?.status, { timeout: 200_000, intervals: [2000] }).toMatch(/answered|failed/);
  const ask = (await w.messages(a)).messages.find((m) => m.messageId === messageId)!;
  // 回到 A 的一定有一条 reply（成功是回复正文，失败是带 failure 的通知）
  const reply = (await w.messages(a)).messages.find((m) => m.kind === 'reply' && m.replyTo === messageId);
  expect(reply, JSON.stringify(ask)).toBeTruthy();
  if (ask.status === 'answered') expect(ask.reply ?? '').not.toBe('');
  else expect(ask.failure).toBeTruthy();
  const trace = (await (await page.request.get(`/api/messages/${messageId}/trace`)).json()) as { audit: { action: string }[] };
  for (const action of ['accepted', 'delivered']) expect(trace.audit.map((e) => e.action)).toContain(action);
  test.info().annotations.push({ type: 'ask-result', description: `${ask.status} ${ask.replySource ?? ''} ${ask.failure ?? ''}` });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/p/${w.project}/focus/${a}`);
  await page.getByRole('button', { name: '详情' }).click();
  const panel = page.getByRole('complementary', { name: '会话详情' }).getByTestId('session-messages');
  await expect(panel.getByTestId('agent-message-row').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/messages-390.png` });
});

test('B 忙：第二条排队，等第一轮结束后才投', async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const w = await world(page, baseURL!);
  const [a, b, c] = [await w.session(), await w.session(), await w.session()];
  const first = await w.send(a, { kind: 'ask', to: `session:${b}`, body: '只回复：1' });
  expect(first.status()).toBe(201);
  expect(((await first.json()) as { status: string }).status).toBe('delivered');
  const second = await w.send(c, { kind: 'send', to: `session:${b}`, body: '只回复：2' });
  expect(second.status()).toBe(201);
  const queued = (await second.json()) as { messageId: string; status: string };
  expect(queued.status).toBe('queued');
  await expect.poll(async () => (await w.messages(c)).messages.find((m) => m.messageId === queued.messageId)?.status, { timeout: 200_000, intervals: [2000] }).not.toBe('queued');
  const firstState = (await w.messages(b)).messages.find((m) => m.from === `session:${a}`)?.status ?? '';
  expect(TERMINAL).toContain(firstState);
});

test('没权限 / 找不到 / 派生要人批：拒绝有审计；批准卡片在手机宽度能点「拒绝」', async ({ page, baseURL }) => {
  const w = await world(page, baseURL!);
  const a = await w.session();
  const missing = await w.send(a, { kind: 'ask', to: 'session:not-a-session', body: 'hi' });
  expect(missing.status()).toBe(403);
  expect(await missing.text()).toContain('unresolvable');
  const noRole = await w.send(a, { kind: 'ask', to: 'role:nobody', body: 'hi' });
  expect(noRole.status()).toBe(403);
  const toSelf = await w.send(a, { kind: 'send', to: `session:${a}`, body: 'hi' });
  expect(toSelf.status()).toBe(400);

  // 配一个角色：没有现成会话时派生要 agent.spawn + 人批
  const agentId = w.agentId;
  const tooHigh = await page.request.put(`/api/projects/${w.project}/messaging`, { headers: w.headers, data: { roles: [], limits: { maxDepth: 9 } } });
  expect(tooHigh.status(), '超过默认 2 倍的上限被拒').toBe(400);
  const saved = await page.request.put(`/api/projects/${w.project}/messaging`, { headers: w.headers, data: { roles: [{ name: 'reviewer', description: '审代码', agentId, model: '', reuse: 'sticky' }], limits: { maxDepth: 8 } } });
  expect(saved.status(), await saved.text()).toBe(200);
  const spawnAsk = await w.send(a, { kind: 'ask', to: 'role:reviewer', body: '帮我审一下这个改动' });
  expect(spawnAsk.status()).toBe(201);
  const pending = (await spawnAsk.json()) as { messageId: string; status: string };
  expect(pending.status).toBe('awaiting_approval');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/p/${w.project}/focus/${a}`);
  await page.getByRole('button', { name: '详情' }).click();
  const card = page.getByRole('complementary', { name: '会话详情' }).getByTestId('spawn-approval');
  await expect(card).toContainText('role:reviewer');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/approval-390.png` });
  await card.getByTestId('spawn-reject').click();
  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await w.messages(a)).messages.find((m) => m.messageId === pending.messageId)?.status).toBe('denied');
  const trace = (await (await page.request.get(`/api/messages/${pending.messageId}/trace`)).json()) as { audit: { action: string }[] };
  expect(trace.audit.map((e) => e.action)).toEqual(expect.arrayContaining(['accepted', 'spawn_requested', 'spawn_rejected']));
});
