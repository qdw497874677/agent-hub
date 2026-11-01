import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';

test.use({ viewport: { width: 390, height: 844 } });

// 同一个任务下两条会话（一条派生、一条分叉）在手机上要分得清：组头是任务，行上是第一句话 / 时间 / 分叉自 #n
test('列表视图：按任务分组，手机上每行都有能区分的信息', async ({ page }) => {
  await page.goto('/');
  const headers = { 'content-type': 'application/json' };
  const project = await (await page.request.post('/api/projects', { headers, data: { name: `列表分组-${Date.now()}`, rootPath: `/tmp/list-group-${Date.now()}` } })).json();
  const task = await (await page.request.post(`/api/projects/${project.id}/tasks`, { headers, data: { title: '同名任务' } })).json();
  const agents = await (await page.request.get('/api/agents')).json();
  const agentId = (agents.find((a: { id: string }) => a.id === 'echo') ?? agents[0]).id;
  const first = await (await page.request.post(`/api/tasks/${task.id}/sessions`, { headers, data: { agentId } })).json();
  await page.request.post(`/api/sessions/${first.id}/prompt`, { headers, data: { text: '第一条会话：看看日志' } });
  await expect.poll(async () => (await (await page.request.get(`/api/sessions/${first.id}`)).json()).lastSeq ?? 0).toBeGreaterThan(1);
  const fork = await page.request.post(`/api/sessions/${first.id}/fork`, { headers, data: { atSeq: 1 } });
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
  await expect(rows.nth(1).getByTestId('list-session-meta')).toContainText('分叉自 #1');
  const box = await rows.nth(1).boundingBox();
  expect(box && box.height >= 44 && box.x + box.width <= 390).toBe(true);
  mkdirSync('/workspace/shots/list', { recursive: true });
  await page.screenshot({ path: '/workspace/shots/list/list-390.png' });
});
