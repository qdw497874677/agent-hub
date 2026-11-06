import { DatabaseSync } from 'node:sqlite';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';

/** 可观测页：真实页面、测试库里的一条连接器链。1280×800。 */
const DATA = process.env['E2E_DATA_DIR'] ?? '/tmp/agent-hub-e2e-data';

test('可观测：列表和树（测试数据，1280×800）', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const tag = Date.now().toString(36);
  const me = await page.request.get('/api/auth/state');
  expect(me.ok()).toBe(true);
  const userId = ((await me.json()) as { user: { id: string } }).user.id;
  const project = await page.request.post('/api/projects', { headers, data: { name: `e2e 可观测 ${tag}` } });
  expect(project.ok(), await project.text()).toBe(true);
  const projectId = ((await project.json()) as { id: string }).id;
  expect((await page.request.post(`/api/projects/${projectId}/agents`, { headers, data: { name: 'router', displayName: '总管', agentId: 'pi', description: '拆任务' } })).ok()).toBe(true);
  const binding = await page.request.post(`/api/projects/${projectId}/agents/router/bindings`, {
    headers,
    data: { connector: 'github', kind: 'issue', name: `e2e acme/demo ${tag}`, target: 'main', projectId: null, params: { repo: 'acme/demo', label: 'agent', everyMin: 15 }, timeZone: 'Asia/Shanghai' }
  });
  expect(binding.ok(), await binding.text()).toBe(true);
  const bindingId = ((await binding.json()) as { id: string }).id;
  const task = await page.request.post('/api/tasks', { headers, data: { projectId, title: `e2e 修一下 ${tag}`, goal: '测试目标' } });
  expect(task.ok(), await task.text()).toBe(true);
  const taskId = ((await task.json()) as { id: string }).id;
  const now = Date.now();
  const runId = `e2e-run-${tag}`;
  const db = new DatabaseSync(`${DATA}/hub.db`);
  db.prepare(`INSERT INTO trigger_run (id, binding_id, external_id, planned_at, catchup, state, reason, session_id, text, created_at, updated_at)
    VALUES (?, ?, ?, NULL, 0, 'done', NULL, NULL, '不应出现在页面上的正文', ?, ?)`).run(runId, bindingId, 'acme/demo#18@evt_91', now - 60_000, now);
  db.prepare(`INSERT INTO agent_task_request (id, task_id, account_id, agent, session_id, project_id, title, goal, origin_connector, origin_external_id, wake_key, counted, approval, created_at, updated_at)
    VALUES (?, ?, ?, 'router', 's-bot', ?, ?, '不应出现的目标', 'github', 'acme/demo#18', ?, 1, 'none', ?, ?)`).run(`e2e-req-${tag}`, taskId, userId, projectId, `e2e 修一下 ${tag}`, runId, now, now);
  db.prepare(`INSERT INTO task_dispatch (id, task_id, account_id, project_id, title, goal, human, notify_session_id, agent_id, model, origin_connector, origin_external_id, state, worker_id, session_id, wait_reason, result, notified, created_at, started_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'g', 0, NULL, 'pi', 'm', 'github', 'acme/demo#18', 'failed', NULL, NULL, NULL, '测试挂了', 1, ?, ?, ?)`).run(`e2e-d-${tag}`, taskId, userId, projectId, `e2e 修一下 ${tag}`, now, now + 1_000, now + 180_000);
  db.close();

  await page.goto('/#/observe');
  await expect(page.getByTestId('observe-list')).toBeVisible();
  await expect(page.getByTestId('observe-row').filter({ hasText: `e2e acme/demo ${tag}` })).toBeVisible();
  await page.screenshot({ path: '/opt/cursor/artifacts/observe-impl-list-1280.png' });
  await page.getByTestId('observe-row').filter({ hasText: `e2e acme/demo ${tag}` }).getByRole('link', { name: '打开树' }).click();
  await expect(page.getByTestId('observe-tree')).toBeVisible();
  await expect(page.getByTestId('observe-node').filter({ hasText: '回写' })).toBeVisible();
  await expect(page.getByText('未记录').first()).toBeVisible();
  await expect(page.getByText('由这次唤醒建下')).toBeVisible();
  await page.screenshot({ path: '/opt/cursor/artifacts/observe-impl-tree-1280.png' });
});
