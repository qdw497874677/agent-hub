import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { loginByApi } from './login.ts';

test.afterAll(() => stopFakeWorker());

/**
 * 批准卡（ADR 0023）：运行时要批准时对话里出一张「允许 / 拒绝」卡，手机上按钮整行、≥44px。
 * 真 worker（假 agent）不会要批准：跑一轮真的，再把历史接口里插一条 approval(request)。
 * 服务端只认事件流里还开着的请求——直接调接口回答一个不存在的请求要 409。
 */
test('批准卡：显示、手机尺寸、点允许发出回答；不存在的请求 409', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const workerId = await ensureFakeWorker(page, baseURL!);
  const dir = mkdtempSync(join(tmpdir(), 'e2e-approval-'));
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 批准 ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '批准' }, headers })).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: FAKE_AGENT_ID, model: '' }, headers });
  expect(derived.status(), await derived.text()).toBe(201);
  const { id } = (await derived.json()) as { id: string };
  const sent = await page.request.post(`/api/sessions/${id}/prompt`, { data: { text: '你好', attachments: [] }, headers });
  expect(sent.ok(), await sent.text()).toBe(true);
  await expect
    .poll(async () => ((await (await page.request.get(`/api/sessions/${id}/events`)).json()) as Array<{ event?: { kind?: string } }>).some((entry) => entry.event?.kind === 'ended'), { timeout: 30_000 })
    .toBe(true);

  const missing = await page.request.post(`/api/sessions/${id}/approvals/nope`, { data: { decision: 'allow' }, headers });
  expect(missing.status()).toBe(409);
  const bad = await page.request.post(`/api/sessions/${id}/approvals/nope`, { data: { decision: 'always' }, headers });
  expect(bad.status()).toBe(400);

  let ackSubmitted = false;
  let journalResolved = false;
  await page.route(`**/api/sessions/${id}/events**`, async (route) => {
    const response = await route.fetch();
    const entries = (await response.json()) as Array<{ seq: number; at?: number; event?: Record<string, unknown> }>;
    const last = entries[entries.length - 1]!;
    const request = { ...last, seq: last.seq + 1, event: { kind: 'approval', phase: 'request', id: 'run_x:req_1', title: 'rm -rf build/', expiresAt: Date.now() + 120_000 } };
    // 202 回执和 journal 里的 resolved 分开控制：刷新时只认后者。
    const resolved = {
      ...last,
      seq: last.seq + 2,
      event: { kind: 'approval', phase: 'resolved', id: 'run_x:req_1', decision: 'deny', by: 'runtime', author: { id: 'e2e', name: '运行时' } }
    };
    const question = {
      ...last,
      seq: last.seq + 3,
      event: { kind: 'tool_call', name: 'AskUserQuestion', input: JSON.stringify({ question: '用 A 还是 B？', options: [{ label: 'A' }, { label: 'B' }] }) }
    };
    const malformed = {
      ...last,
      seq: last.seq + 4,
      event: { kind: 'tool_call', name: 'AskUserQuestion', input: 'RAW_QUESTION_SHOULD_NOT_RENDER' }
    };
    const injected = journalResolved ? [request, resolved, question, malformed] : [request, question, malformed];
    await route.fulfill({ response, json: [...entries, ...injected] });
  });
  await page.route(`**/api/sessions/${id}/approvals/**`, (route) => {
    ackSubmitted = true;
    return route.fulfill({ status: 202, json: { requested: true } });
  });
  await page.goto(`/#/p/${project.id}/focus/${id}`);
  const card = page.getByRole('log', { name: '会话记录' }).getByTestId('msg-approval').last();
  await expect(card).toBeVisible();
  await expect(card).toContainText('rm -rf build/');
  await expect(card.getByTestId('approval-countdown')).toContainText('秒内不回答就当拒绝');
  for (const button of [card.getByTestId('approval-allow'), card.getByTestId('approval-deny')]) {
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThan(250);
  }
  const answered = page.waitForRequest((request) => request.url().includes(`/api/sessions/${id}/approvals/`) && request.method() === 'POST');
  await card.getByTestId('approval-allow').click();
  const request = await answered;
  expect(ackSubmitted).toBe(true);
  expect(decodeURIComponent(request.url())).toContain('/approvals/run_x:req_1');
  expect(request.postDataJSON()).toEqual({ decision: 'allow' });

  // 202 只是「收到了」，不是允许/拒绝；不能在本地说成结论。
  await expect(card).toHaveAttribute('data-state', 'submitted');
  await expect(card.getByTestId('approval-submitted')).toContainText('已提交，等待结果确认');
  await expect(card.getByTestId('approval-verdict')).toHaveCount(0);
  await expect(card.getByTestId('approval-allow')).toHaveCount(0);
  await expect(card.getByTestId('approval-deny')).toHaveCount(0);

  // 显式提问只展示原始问题，不声称仍在等待，也不自动生成答案。
  const question = page.getByRole('log', { name: '会话记录' }).getByTestId('agent-question');
  await expect(question).toBeVisible();
  await expect(question).toContainText('Agent 提问');
  await expect(question).toContainText('不代表仍在等待回答');
  await expect(question).toContainText('用 A 还是 B？');
  await expect(question.getByText('A', { exact: true })).toBeVisible();
  await expect(question).not.toContainText('已回答');

  // 刷新后只认 journal：运行时实际给的是拒绝，和刚才点的允许不同。
  journalResolved = true;
  const me = (await (await page.request.get('/api/auth/state')).json()) as { user: { id: string } };
  await page.evaluate(
    (userId) => localStorage.setItem(`agent-hub.display.${userId}`, JSON.stringify({ tools: 'hidden' })),
    me.user.id
  );
  await page.reload();
  const persisted = page.getByRole('log', { name: '会话记录' }).getByTestId('msg-approval').last();
  await expect(persisted).toHaveAttribute('data-state', 'deny');
  await expect(persisted.getByTestId('approval-verdict')).toContainText('运行时已不再等待');
  await expect(persisted.getByTestId('approval-submitted')).toHaveCount(0);
  await expect(persisted.getByTestId('approval-allow')).toHaveCount(0);
  await expect(persisted.getByTestId('approval-deny')).toHaveCount(0);
  const persistedQuestions = page.getByRole('log', { name: '会话记录' }).getByTestId('agent-question');
  await expect(persistedQuestions).toHaveCount(1);
  await expect(persistedQuestions).toContainText('用 A 还是 B？');
  // 工具行设成隐藏后，仍保留能解析的提问卡；解析不了的原始参数不能冒充问题。
  await expect(page.getByText('RAW_QUESTION_SHOULD_NOT_RENDER')).toHaveCount(0);
});
