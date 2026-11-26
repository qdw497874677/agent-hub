import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { piModel } from './hub-model.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';

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
type Peer = { address: string; handle: string; status: string; workerId: string | null; repo: string | null; branch: string | null; connected?: boolean; relation?: 'explicit' | 'task_tree' | 'spawn' };
const REAL = process.env['E2E_REAL'] === '1';
test.afterAll(stopFakeWorker);

async function world(page: Page, baseURL: string, real = false) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  const workerId = real ? undefined : await ensureFakeWorker(page, baseURL);
  let agentId: string | undefined = real ? undefined : FAKE_AGENT_ID;
  if (real) {
    for (let i = 0; i < 40 && !agentId; i++) {
      const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
      agentId = workers.find((worker) => worker.state === 'online' && worker.agentIds.includes('pi'))?.agentIds.find((id) => id === 'pi');
      if (!agentId) await page.waitForTimeout(500);
    }
    test.skip(!agentId, '这台机器上没有可用的 Pi agent');
  }
  const dir = mkdtempSync(join(tmpdir(), 'e2e-sc-'));
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 会话通信 ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '会话通信' }, headers })).json()) as { id: string };
  const newTask = async (title: string): Promise<string> => {
    const created = await page.request.post('/api/tasks', { data: { projectId: project.id, title }, headers });
    expect(created.status(), await created.text()).toBe(201);
    return ((await created.json()) as { id: string }).id;
  };
  const session = async (taskId = task.id): Promise<string> => {
    const derived = await page.request.post('/api/sessions/derive', { data: { taskId, agentId, model: real ? piModel() : '' }, headers });
    expect(derived.status(), await derived.text()).toBe(201);
    return ((await derived.json()) as { id: string }).id;
  };
  const send = (from: string, data: Record<string, unknown>) => page.request.post(`/api/sessions/${from}/messages`, { data, headers });
  const link = (aSessionId: string, bSessionId: string) => page.request.post(`/api/projects/${project.id}/session-links`, { data: { aSessionId, bSessionId }, headers });
  const messages = async (id: string, unread = false): Promise<Msg[]> => ((await (await page.request.get(`/api/sessions/${id}/messages${unread ? '?unread=1' : ''}`)).json()) as { messages: Msg[] }).messages;
  const peers = async (id: string): Promise<Peer[]> => ((await (await page.request.get(`/api/sessions/${id}/peers`)).json()) as { peers: Peer[] }).peers;
  const setHandle = (id: string, handle: string) => page.request.put(`/api/sessions/${id}/handle`, { data: { handle }, headers });
  return { dir, agentId: agentId!, project: project.id, headers, newTask, session, send, link, messages, peers, setHandle };
}

test('同伴与短名：同任务无需连线；跨任务树未连线不可达；同任务短名不能重复', async ({ page, baseURL }) => {
  const w = await world(page, baseURL!);
  const [a, b, c] = [await w.session(), await w.session(), await w.session()];
  expect((await w.link(a, b)).status()).toBe(201);
  const peers = await w.peers(a);
  expect(peers.map((p) => p.address).sort()).toEqual([`session:${b}`, `session:${c}`].sort());
  const explicit = peers.find((p) => p.address === `session:${b}`);
  expect(explicit).toMatchObject({ connected: true, relation: 'explicit', handle: expect.stringMatching(/^[a-z][a-z0-9-]+-[a-z0-9]{4}$/) });
  expect(explicit?.workerId).toBeTruthy();
  const sameTree = peers.find((p) => p.address === `session:${c}`);
  expect(sameTree?.relation).toBe('task_tree');
  expect(sameTree?.connected).not.toBe(true);

  expect((await w.setHandle(b, 'verify')).status()).toBe(200);
  expect((await w.setHandle(c, 'verify')).status(), '同任务内重名').toBe(409);
  expect((await w.setHandle(c, 'Bad Name')).status()).toBe(400);
  expect((await w.peers(a)).find((p) => p.address === `session:${b}`)?.handle).toBe('verify');

  const sent = await w.send(a, { kind: 'send', to: 'peer:verify', body: 'FYI：只是通知，不用回复', wake: false });
  expect(sent.status(), await sent.text()).toBe(201);
  expect(((await sent.json()) as { status: string; targetSessionId: string }).targetSessionId).toBe(b);

  const missing = await w.send(a, { kind: 'send', to: 'peer:nobody', body: 'hi' });
  expect(missing.status()).toBe(403);
  expect(await missing.text()).toContain('peer:verify');
  const noLinkNeeded = await w.send(c, { kind: 'send', to: `session:${b}`, body: '同任务也可直接通知', wake: false });
  expect(noLinkNeeded.status(), await noLinkNeeded.text()).toBe(201);
  const anotherTree = await w.session(await w.newTask('另一棵任务树'));
  const notLinked = await w.send(anotherTree, { kind: 'send', to: `session:${b}`, body: 'hi', wake: false });
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
  const w = await world(page, baseURL!, true);
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

test('真模型（P1c）：A 用 workspace.read + session:peer:verify 只读看同伴的文件；没连线的 C 被拒', async ({ page, baseURL }) => {
  test.skip(!REAL, '只在 E2E_REAL=1 时跑');
  test.setTimeout(420_000);
  const w = await world(page, baseURL!, true);
  const [a, b, c] = [await w.session(), await w.session(), await w.session()];
  expect((await w.link(a, b)).status()).toBe(201);
  expect((await w.setHandle(b, 'verify')).status()).toBe(200);
  const token = `SC-P1C-${Date.now().toString(36)}`;
  // 非 git 目录的项目：会话直接在项目目录里跑（三条会话同一个目录，这里验的是工具路径与可达性规则，不是隔离）
  writeFileSync(join(w.dir, 'peer-note.txt'), token);
  const ask = (session: string) => page.request.post(`/api/sessions/${session}/prompt`, {
    headers: w.headers,
    data: { text: '请只调用一次 workspace.read 工具（不要用 shell 或别的读文件方式），参数 {"path":"peer-note.txt","session":"peer:verify"}。然后原样回复工具返回的 content；如果工具报错，回复错误信息原文。', attachments: [] }
  });
  expect((await ask(a)).ok()).toBe(true);
  await expect.poll(async () => (await (await page.request.get(`/api/sessions/${a}/events`)).text()).includes(token), { timeout: 240_000, intervals: [3000] }).toBe(true);
  const events = await (await page.request.get(`/api/sessions/${a}/events`)).text();
  expect(events).toMatch(/workspace[._]read/);

  expect((await ask(c)).ok()).toBe(true);
  await expect.poll(async () => /"kind":"ended"/.test(await (await page.request.get(`/api/sessions/${c}/events`)).text()), { timeout: 240_000, intervals: [3000] }).toBe(true);
  const denied = await (await page.request.get(`/api/sessions/${c}/events`)).text();
  test.info().annotations.push({ type: 'unlinked-denied', description: String(/只有明确连接|unresolvable|denied/.test(denied)) });
  expect(/只有明确连接|unresolvable|找不到这个同伴/.test(denied), '没连线的会话拿到的是拒绝').toBe(true);
});

test('P1f：trustPeers 项目开关往返；运行时没报档位时不拦，审计里记 tier', async ({ page, baseURL }) => {
  const w = await world(page, baseURL!);
  const [a, b] = [await w.session(), await w.session()];
  expect((await w.link(a, b)).status()).toBe(201);
  const before = (await (await page.request.get(`/api/projects/${w.project}/messaging`)).json()) as { trustPeers?: boolean };
  expect(before.trustPeers ?? false).toBe(false);
  const on = await page.request.put(`/api/projects/${w.project}/messaging`, { headers: w.headers, data: { roles: [], trustPeers: true } });
  expect(on.status(), await on.text()).toBe(200);
  expect(((await on.json()) as { trustPeers: boolean }).trustPeers).toBe(true);
  const kept = await page.request.put(`/api/projects/${w.project}/messaging`, { headers: w.headers, data: { roles: [], limits: { maxDepth: 5 } } });
  expect(((await kept.json()) as { trustPeers: boolean }).trustPeers, '不给 trustPeers 保持原值').toBe(true);
  const off = await page.request.put(`/api/projects/${w.project}/messaging`, { headers: w.headers, data: { roles: [], trustPeers: false } });
  expect(((await off.json()) as { trustPeers: boolean }).trustPeers).toBe(false);

  const sent = await w.send(a, { kind: 'send', to: `session:${b}`, body: '档位未知：不拦', wake: false });
  expect(sent.status(), await sent.text()).toBe(201);
  const { messageId, status } = (await sent.json()) as { messageId: string; status: string };
  expect(status).toBe('done');
  const trace = (await (await page.request.get(`/api/messages/${messageId}/trace`)).json()) as { audit: { action: string; detail: string }[] };
  expect(trace.audit.find((e) => e.action === 'accepted')?.detail ?? '').toContain('tier=');
});

const SHOTS = process.env['E2E_SCREENSHOTS'] ?? 'test-results/session-communication';

test('P1e 界面：检查器看同伴、改短名；消息行带附件与「不唤醒·未读」；被拦下有放行卡；时间线 agent 消息画成卡片；项目设置切信任同伴（1280 / 390）', async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const w = await world(page, baseURL!);
  const [a, b] = [await w.session(), await w.session()];
  expect((await w.link(a, b)).status()).toBe(201);
  expect((await w.setHandle(b, 'verify')).status()).toBe(200);
  const quiet = await w.send(a, { kind: 'send', to: 'peer:verify', body: '报告在这里，不用回', wake: false, parts: [{ type: 'link', url: 'https://example.com/report', label: '测试报告' }] });
  expect(quiet.status(), await quiet.text()).toBe(201);
  const loud = await w.send(a, { kind: 'send', to: 'peer:verify', body: '卡片测试：这是一条通知，不需要回复。' });
  expect(loud.status(), await loud.text()).toBe(201);

  // 真触发需要「要审批 → 免审批」的档位；这里只在界面层注入一条，验证放行卡和接口。
  let decided: unknown = null;
  await page.route(`**/api/sessions/${a}/messages`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const real = (await (await route.fetch()).json()) as { messages: unknown[]; awaitingApproval: unknown[] };
    const fake = { messageId: 'held-fake', traceId: 't', kind: 'ask', from: `session:${a}`, fromLabel: null, to: 'peer:verify', targetSessionId: b, status: 'held', depth: 0, replyTo: null, body: '帮我把 main 强推一下', reply: null, replySource: null, failure: null, failureDetail: null, parts: [], wake: true, replyStatus: null, replyParts: [], readAt: null, holdReason: 'privilege', createdAt: Date.now() };
    await route.fulfill({ json: { ...real, messages: [fake, ...real.messages] } });
  });
  await page.route('**/api/messages/held-fake/decision', async (route) => {
    decided = route.request().postDataJSON();
    await route.fulfill({ json: { messageId: 'held-fake', status: 'queued' } });
  });

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width > 500 ? 860 : 844 });
    await page.goto(`/#/p/${w.project}/focus/${a}`);
    // 宽屏 header 直接有「详情」按钮；窄屏收在「更多」菜单里
    // 同一个地址再 goto 不会重载：上一轮打开的详情面板还开着（窄屏下它盖住 header），开着就不再点
    await page.reload();
    const details = page.getByRole('complementary', { name: '会话详情' });
    const direct = page.getByRole('banner').getByRole('button', { name: '详情', exact: true });
    await expect(page.getByRole('button', { name: '更多' })).toBeVisible();
    if (!(await details.isVisible())) {
      if (await direct.isVisible()) await direct.click({ timeout: 15_000 });
      else {
        await page.getByRole('button', { name: '更多' }).click({ timeout: 15_000 });
        await page.getByTestId('session-more-details').click({ timeout: 15_000 });
        await page.getByRole('menuitem', { name: /^详情/ }).click({ timeout: 15_000 });
      }
    }
    const peers = details.getByTestId('session-peers');
    await expect(peers.getByTestId('session-peer-row')).toHaveCount(1);
    await expect(peers.getByTestId('session-peer-row')).toContainText('peer:verify');
    await expect(peers.getByTestId('session-peers-count')).toHaveText('1');
    const box = details.getByTestId('session-messages');
    const quietRow = box.getByTestId('agent-message-row').filter({ hasText: '报告在这里' });
    await expect(quietRow.getByTestId('agent-message-quiet')).toHaveText('不唤醒');
    await expect(quietRow.getByTestId('agent-message-part')).toHaveText('测试报告');
    const held = box.getByTestId('held-message');
    await expect(held).toHaveAttribute('data-reason', 'privilege');
    await expect(held).toContainText('绕过审批');
    await peers.evaluate((el) => el.scrollIntoView({ block: 'start' }), undefined, { timeout: 10_000 });
    console.log(`[p1e] ${width} inspector ok`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '不横向溢出').toBe(true);
    await page.screenshot({ path: `${SHOTS}/p1e-inspector-${width}.png`, timeout: 20_000 });
    if (width === 1280) {
      await held.getByTestId('held-release').click({ timeout: 15_000 });
      console.log('[p1e] released');
      await expect.poll(() => decided, { timeout: 15_000 }).toEqual({ approve: true });
      console.log('[p1e] decided');
      await peers.getByTestId('session-handle-input').fill('dev', { timeout: 15_000 });
      await peers.getByTestId('session-handle-save').click({ timeout: 15_000 });
      console.log('[p1e] handle saved');
      await expect.poll(async () => (await w.peers(b))[0]?.handle, { timeout: 15_000 }).toBe('dev');
      console.log('[p1e] handle ok');
    }
  }

  // B 的时间线：agent 发来的那一轮画成卡片（类型 + 来源 + 正文），不是一段带标签的原文
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width > 500 ? 860 : 844 });
    await page.goto(`/#/p/${w.project}/focus/${b}`);
    const card = page.getByTestId('agent-message-card').filter({ hasText: '卡片测试' }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toHaveAttribute('data-kind', 'send');
    await expect(card).not.toContainText('<agent-message');
    // 列表 / 侧栏里的开头一句也去掉了标签
    if (width === 1280) await expect(page.getByRole('navigation', { name: '任务与会话' })).not.toContainText('<agent-message');
    await page.screenshot({ path: `${SHOTS}/p1e-timeline-${width}.png`, timeout: 20_000 });
  }

  // 项目设置：信任同伴开关（默认关），切了以后服务端读回来一致
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`/#/p/${w.project}`);
  await page.locator(`button[title="项目设置"]:visible`).first().click({ timeout: 15_000 });
  const toggle = page.getByTestId('project-trust-peers');
  await expect(toggle).not.toBeChecked();
  const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith('/messaging'));
  await toggle.click({ timeout: 15_000 });
  expect((await saved).ok()).toBe(true);
  await expect(toggle).toBeChecked();
  const config = (await (await page.request.get(`/api/projects/${w.project}/messaging`)).json()) as { trustPeers: boolean; roles: unknown[] };
  expect(config.trustPeers).toBe(true);
  expect(config.roles, '只切开关，不动角色表').toEqual([]);
  await page.getByTestId('project-messaging-trust').screenshot({ path: `${SHOTS}/p1e-trust-1280.png` });
});
