import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  await expect(page.getByTestId('observe-access')).toContainText('没有登录的请求会被拒绝');
  await expect(page.getByTestId('observe-scan')).toContainText('先取最近 500 条');
  await expect(page.getByTestId('observe-list')).toBeVisible();
  await expect(page.getByTestId('observe-row').filter({ hasText: `e2e acme/demo ${tag}` })).toBeVisible();
  await page.getByTestId('observe-needs-look').check();
  await expect(page.getByTestId('observe-row').filter({ hasText: `e2e acme/demo ${tag}` })).toBeVisible();
  await expect(page.getByTestId('observe-scan')).toContainText('先取最近 500 条');
  await page.screenshot({ path: '/opt/cursor/artifacts/observe-impl-list-1280.png' });
  await page.getByTestId('observe-row').filter({ hasText: `e2e acme/demo ${tag}` }).getByRole('link', { name: '打开树' }).click();
  await expect(page.getByTestId('observe-tree')).toBeVisible();
  await expect(page.getByTestId('observe-node').filter({ hasText: '回写' })).toBeVisible();
  await expect(page.getByText('未记录').first()).toBeVisible();
  await expect(page.getByText('由这次唤醒建下')).toBeVisible();
  const trigger = page.getByTestId('observe-node').filter({ hasText: `e2e acme/demo ${tag}` });
  await trigger.click();
  await expect(page.getByTestId('observe-node-detail')).toContainText('记录跨度');
  await expect(page.getByTestId('observe-node-detail')).not.toContainText('不应出现在页面上的正文');
  await expect(page.getByText('由这次唤醒建下')).toHaveCount(0);
  await trigger.click();
  await expect(page.getByText('由这次唤醒建下')).toBeVisible();
  await page.screenshot({ path: '/opt/cursor/artifacts/observe-impl-tree-1280.png' });
});

test('未登录调用可观测接口被拒绝，不是空列表', async ({ browser, baseURL }) => {
  const fresh = await browser.newContext();
  const response = await fresh.request.get(`${baseURL}/api/observe?since=0`);
  expect(response.status()).toBe(401);
  expect(JSON.stringify(await response.json())).toContain('请先登录');
  await fresh.close();
});

/**
 * 假 ACP 派生出一个真会话，再写入一条时间窗内的送达行。
 * 这不是真模型端到端：agent 是仓库里的 fake-agent.mjs，送达行是测试插入的。
 */
test('可观测树含送达节点（假 ACP 会话 + 测试送达行，1280×800）', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const code = ((await (await page.request.post('/api/workers/pairing', { data: {}, headers })).json()) as { code: string }).code;
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  const pathEnv = '/usr/local/bin:/usr/bin:/bin';
  const label = `e2e 可观测假ACP ${Date.now().toString(36)}`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], { env: { PATH: pathEnv, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label }, encoding: 'utf8' });
  expect(enrolled.status, enrolled.stderr).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-obs-'));
  const fake = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');
  const agents = [{ id: 'fakeacp', label: '假 ACP', command: process.execPath, args: [fake], listModelsArgs: [fake, '--models'] }];
  const worker: ChildProcess = spawn(process.execPath, ['apps/worker/src/main.ts'], {
    env: {
      PATH: pathEnv, HOME: state, HUB_URL: hubUrl, HUB_WORKER_CREDENTIAL: credential, WORKER_ID: workerId, WORKER_ORIGIN: 'remote', WORKER_LABEL: label,
      WORKER_ROOTS: '/tmp', WORKER_STATE_DIR: state, WORKER_RUNTIMES_DIR: join(state, 'runtimes'), ACP_AGENTS: JSON.stringify(agents)
    },
    stdio: 'ignore'
  });
  const dir = mkdtempSync(join(tmpdir(), 'e2e-obs-'));
  try {
    for (let i = 0; i < 120; i++) {
      const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ id?: string; workerId?: string; state: string }>;
      if (workers.some((item) => (item.workerId ?? item.id) === workerId && item.state === 'online')) break;
      if (i === 119) throw new Error('假 ACP worker 没有上线');
      await page.waitForTimeout(500);
    }
    const tag = Date.now().toString(36);
    const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 送达 ${tag}`, rootPath: dir, workerId }, headers })).json()) as { id: string };
    const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: `测试数据 送达 ${tag}` }, headers })).json()) as { id: string };
    const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: 'fakeacp', model: '' }, headers });
    expect(derived.ok(), await derived.text()).toBe(true);
    const sessionId = ((await derived.json()) as { id: string }).id;
    expect((await page.request.post(`/api/projects/${project.id}/agents`, { headers, data: { name: 'router', displayName: '总管', agentId: 'fakeacp', description: '测试' } })).ok()).toBe(true);
    const binding = await page.request.post(`/api/projects/${project.id}/agents/router/bindings`, {
      headers,
      data: { connector: 'github', kind: 'issue', name: `测试数据 假ACP ${tag}`, target: 'main', projectId: null, params: { repo: 'acme/demo', label: 'agent', everyMin: 15 }, timeZone: 'Asia/Shanghai' }
    });
    expect(binding.ok(), await binding.text()).toBe(true);
    const bindingId = ((await binding.json()) as { id: string }).id;
    const now = Date.now();
    const runId = `e2e-dlv-${tag}`;
    const db = new DatabaseSync(`${DATA}/hub.db`);
    db.prepare(`INSERT INTO trigger_run (id, binding_id, external_id, planned_at, catchup, state, reason, session_id, text, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 0, 'done', NULL, ?, '不应出现的正文', ?, ?)`).run(runId, bindingId, `acme/demo#${tag}@evt`, sessionId, now - 30_000, now);
    db.prepare(`INSERT INTO message_delivery (id, session_id, seq, kind, payload, state, attempt, next_at, last_error, created_at, updated_at)
      VALUES (?, ?, 1, 'prompt', '{"text":"测试送达，不是模型原文"}', 'delivered', 1, NULL, NULL, ?, ?)`).run(`e2e-msg-${tag}`, sessionId, now - 10_000, now - 4_000);
    db.close();
    await page.goto('/#/observe');
    await page.getByTestId('observe-row').filter({ hasText: `测试数据 假ACP ${tag}` }).getByRole('link', { name: '打开树' }).click();
    const delivery = page.getByTestId('observe-node').filter({ hasText: '会话送达' });
    await expect(delivery).toBeVisible();
    await expect(page.getByText('未关联')).toBeVisible();
    await delivery.click();
    await expect(page.getByTestId('observe-node-detail')).toContainText('无外键，只是时间窗里的候选');
    await expect(page.getByTestId('observe-node-detail')).toContainText('送达用时');
    await expect(page.getByTestId('observe-node-detail')).not.toContainText('测试送达');
    await page.screenshot({ path: '/opt/cursor/artifacts/observe-impl-tree-delivery-1280.png' });
  } finally {
    worker.kill();
    await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
    rmSync(state, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
