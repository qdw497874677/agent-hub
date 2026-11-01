import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';

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
  let agentId: string | undefined;
  for (let i = 0; i < 40 && !agentId; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((worker) => worker.state === 'online')?.agentIds[0];
    if (!agentId) await page.waitForTimeout(500);
  }
  test.skip(!agentId, '这台机器上没有可用的 agent');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-approval-'));
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 批准 ${Date.now().toString(36)}`, rootPath: dir }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '批准' }, headers })).json()) as { id: string };
  const { id } = (await (await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers })).json()) as { id: string };
  await page.request.post(`/api/sessions/${id}/prompt`, { data: { text: '你好', attachments: [] }, headers });
  await expect
    .poll(async () => ((await (await page.request.get(`/api/sessions/${id}/events`)).json()) as Array<{ event?: { kind?: string } }>).length > 0, { timeout: 30_000 })
    .toBe(true);

  const missing = await page.request.post(`/api/sessions/${id}/approvals/nope`, { data: { decision: 'allow' }, headers });
  expect(missing.status()).toBe(409);
  const bad = await page.request.post(`/api/sessions/${id}/approvals/nope`, { data: { decision: 'always' }, headers });
  expect(bad.status()).toBe(400);

  await page.route(`**/api/sessions/${id}/events**`, async (route) => {
    const response = await route.fetch();
    const entries = (await response.json()) as Array<{ seq: number; at?: number; event?: Record<string, unknown> }>;
    const last = entries[entries.length - 1]!;
    const extra = { ...last, seq: last.seq + 1, event: { kind: 'approval', phase: 'request', id: 'run_x:req_1', title: 'rm -rf build/', expiresAt: Date.now() + 120_000 } };
    await route.fulfill({ response, json: [...entries, extra] });
  });
  await page.route(`**/api/sessions/${id}/approvals/**`, (route) => route.fulfill({ status: 202, json: { requested: true } }));
  await page.goto(`/#/p/${project.id}/focus/${id}`);
  const card = page.getByRole('log', { name: '对话记录' }).getByTestId('msg-approval').last();
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
  expect(decodeURIComponent(request.url())).toContain('/approvals/run_x:req_1');
  expect(request.postDataJSON()).toEqual({ decision: 'allow' });
});
