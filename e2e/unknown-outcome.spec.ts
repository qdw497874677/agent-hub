import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * 结果未知（Hermes outcome_unknown）的一轮：对话里给一张说明卡，「重发这一轮」把上一句再发一次，「不用了」只收起按钮。
 * 真 worker 上做不出 outcome_unknown：先跑出一轮真的失败（目录删了），再把历史接口里那条 ended 改写成结果未知。
 */
test('结果未知的一轮：说明卡 + 重发 / 不用了', async ({ page, baseURL }) => {
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
  const dir = mkdtempSync(join(tmpdir(), 'e2e-unknown-'));
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 结果未知 ${Date.now().toString(36)}`, rootPath: dir }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '结果未知' }, headers })).json()) as { id: string };
  rmSync(dir, { recursive: true, force: true });
  const { id } = (await (await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers })).json()) as { id: string };
  const ended = async () => {
    const events = (await (await page.request.get(`/api/sessions/${id}/events`)).json()) as Array<{ event?: { kind?: string } }>;
    return events.filter((entry) => entry.event?.kind === 'ended').length;
  };
  await page.request.post(`/api/sessions/${id}/prompt`, { data: { text: '改一下 README', attachments: [] }, headers });
  await expect.poll(ended, { timeout: 15_000 }).toBeGreaterThan(0);

  await page.route(`**/api/sessions/${id}/events**`, async (route) => {
    const response = await route.fetch();
    const entries = (await response.json()) as Array<{ event?: Record<string, unknown> }>;
    const rewritten = entries.map((entry) =>
      entry.event?.['kind'] === 'ended' ? { ...entry, event: { kind: 'ended', outcome: 'interrupted', reason: 'Hermes 这一轮的结果未知（outcome_unknown）' } } : entry
    );
    await route.fulfill({ response, json: rewritten });
  });
  await page.goto(`/#/p/${project.id}/canvas`);
  await page.locator('.react-flow__node-session').getByRole('button', { name: '打开' }).click();
  const log = page.getByRole('log', { name: '对话记录' });
  const card = log.getByTestId('msg-unknown').last();
  await expect(card).toBeVisible();
  await expect(card).toContainText('这一轮结果不确定');

  // 「不用了」：按钮收起，刷新后也不再出现（本浏览器记住）
  await card.getByTestId('unknown-dismiss').click();
  await expect(card.getByTestId('unknown-resend')).toHaveCount(0);
  await expect(card).toContainText('已处理');
  await page.reload();
  await expect(log.getByTestId('msg-unknown').last()).toContainText('已处理');

  // 换一个浏览器存储再来：「重发这一轮」把上一句原样发出去
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const prompted = page.waitForRequest((request) => request.url().endsWith(`/api/sessions/${id}/prompt`) && request.method() === 'POST');
  await log.getByTestId('unknown-resend').click(); // 只有最后一块有按钮
  expect((await prompted).postDataJSON()).toMatchObject({ text: '改一下 README' });
  await expect(log.getByTestId('msg-unknown').last()).toContainText('已处理');
});
