import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';

test.use({ viewport: { width: 390, height: 844 } });
test.afterAll(() => stopFakeWorker());

// 同一个任务下两条会话（一条派生、一条分叉）在手机上要分得清：组头是任务，行上是第一句话 / 时间 / 分叉自 #n
test('列表视图：按任务分组，手机上每行都有能区分的信息', async ({ page, baseURL }, testInfo) => {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const agentId = FAKE_AGENT_ID;
  const workerId = await ensureFakeWorker(page, baseURL!, agentId, { agentArgs: ['--fork'] });
  const dir = mkdtempSync(join(tmpdir(), 'e2e-list-'));
  try {
    const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 列表 ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers })).json()) as { id: string };
    const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '同名任务' }, headers })).json()) as { id: string };
    const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '', workerId }, headers });
    expect(derived.ok(), await derived.text()).toBe(true);
    const first = await derived.json() as { id: string };
    const prompt = await page.request.post(`/api/sessions/${first.id}/prompt`, { data: { text: '第一条会话：看看日志' }, headers });
    expect(prompt.ok(), await prompt.text()).toBe(true);
    await expect.poll(async () => {
      const response = await page.request.get(`/api/sessions/${first.id}`);
      return ((await response.json()) as { status: string }).status;
    }).toBe('done');
    const fork = await page.request.post('/api/sessions/fork', { data: { sessionId: first.id, agentId, model: '' }, headers });
    expect(fork.ok(), await fork.text()).toBe(true);

    await page.goto(`/#/p/${project.id}/list`);
    await expect(page.getByTestId('list-context')).toContainText('1 个任务 · 2 条会话');
    await expect(page.getByTestId('list-refresh')).toBeVisible();
    const group = page.getByRole('region', { name: '任务：同名任务' });
    await expect(group.getByRole('heading', { level: 3 })).toContainText('2 条会话');
    const rows = group.getByTestId('list-session-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).getByTestId('list-session-label')).toHaveText('第一条会话：看看日志');
    await expect(rows.nth(0).getByTestId('list-session-meta')).toBeVisible();
    await expect(rows.nth(0).getByTestId('list-session-meta')).toContainText('派生');
    await expect(rows.nth(1).getByTestId('list-session-meta')).toContainText(/分叉自 #\d+/);
    await expect(group.locator('xpath=ancestor::*[@data-testid="list-workspace-group"][1]').getByTestId('list-workspace-toggle')).toBeVisible();
    const box = await rows.nth(1).boundingBox();
    expect(box && box.height >= 44 && box.x + box.width <= 390).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('list-390.png') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
