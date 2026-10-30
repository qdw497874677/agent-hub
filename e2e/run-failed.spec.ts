import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';

/** 运行失败（这里是目录不在 Worker 允许的范围里）：对话里有中文原因，输入框回到「发送」，不再挂着「中断」。 */
const SHOTS = process.env['E2E_SCREENSHOTS'];

test('运行失败后输入框显示「发送」而不是「中断」', async ({ page, baseURL }) => {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  // 单独跑这一条时本机 Worker 可能还没连上：等它最多 20 秒
  let agentId: string | undefined;
  for (let i = 0; i < 40 && !agentId; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((worker) => worker.state === 'online')?.agentIds[0];
    if (!agentId) await page.waitForTimeout(500);
  }
  test.skip(!agentId, '这台机器上没有可用的 agent');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-fail-'));
  const name = `e2e 失败 ${Date.now().toString(36)}`;
  const project = (await (await page.request.post('/api/projects', { data: { name, rootPath: dir }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '跑不起来的任务' }, headers })).json()) as { id: string };
  // 建完项目再把目录删掉：Worker 起 agent 时进不去，这次运行一定失败
  rmSync(dir, { recursive: true, force: true });
  const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers });
  await page.goto(`/#/p/${project.id}/canvas`);
  await page.locator('.react-flow__node-session header, .react-flow__node-session p').first().click();
  const log = page.getByRole('log', { name: '对话记录' });
  await expect(log).toBeVisible();
  const composer = page.getByLabel('发送消息');
  await composer.fill('你好');
  await composer.press('Control+Enter');
  await expect(log.getByTestId('msg-error').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: '中断' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/run-failed-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/run-failed-390.png` });
});
