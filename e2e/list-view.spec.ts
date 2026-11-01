import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { loginByApi } from './login.ts';

test.use({ viewport: { width: 390, height: 844 } });

// 同一个任务下两条会话（一条派生、一条分叉）在手机上要分得清：组头是任务，行上是第一句话 / 时间 / 分叉自 #n
test('列表视图：按任务分组，手机上每行都有能区分的信息', async ({ page, baseURL }) => {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  let agentId: string | undefined;
  for (let i = 0; i < 40 && !agentId; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((w) => w.state === 'online')?.agentIds[0];
    if (!agentId) await page.waitForTimeout(500);
  }
  test.skip(!agentId, '这台机器上没有可用的 agent');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-list-'));
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 列表 ${Date.now().toString(36)}`, rootPath: dir }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '同名任务' }, headers })).json()) as { id: string };
  const first = (await (await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers })).json()) as { id: string };
  await page.request.post(`/api/sessions/${first.id}/prompt`, { data: { text: '第一条会话：看看日志' }, headers });
  await page.waitForTimeout(1500);
  const fork = await page.request.post('/api/sessions/fork', { data: { sessionId: first.id, agentId, model: '' }, headers });
  expect(fork.ok()).toBe(true);

  await page.goto(`/#/p/${project.id}`);
  await page.getByRole('button', { name: '列表' }).click();
  const group = page.getByRole('region', { name: '任务：同名任务' });
  await expect(group.getByRole('heading')).toContainText('2 条会话');
  const rows = group.getByTestId('list-session-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByTestId('list-session-label')).toHaveText('第一条会话：看看日志');
  await expect(rows.nth(0).getByTestId('list-session-meta')).toBeVisible();
  await expect(rows.nth(0).getByTestId('list-session-meta')).toContainText('派生');
  await expect(rows.nth(1).getByTestId('list-session-meta')).toContainText(/分叉自 #\d+/);
  const box = await rows.nth(1).boundingBox();
  expect(box && box.height >= 44 && box.x + box.width <= 390).toBe(true);
  mkdirSync('/workspace/shots/list', { recursive: true });
  await page.screenshot({ path: '/workspace/shots/list/list-390.png' });
});
