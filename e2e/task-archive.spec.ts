import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { e2eWorkerPath, e2eWorkerRoots } from './isolation.ts';

const FAKE = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');
const workers: ChildProcess[] = [];

test.afterAll(() => {
  for (const worker of workers) worker.kill();
});

/**
 * 归档是任务自己的退场，不是删除：
 * - 列表 / 画布不再展示它，但直接链接和搜索还找得到；
 * - 恢复不启动工作，也不动会话的收起状态；
 * - 已归档区在列表底部，手机上也够得着。
 */
async function seed(page: Page, baseURL: string, tag: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  const code = ((await (await page.request.post('/api/workers/pairing', { data: {}, headers })).json()) as { code: string }).code;
  const hubUrl = `${baseURL.replace(/^http/, 'ws')}/worker`;
  const PATH = e2eWorkerPath();
  const label = `e2e 归档机器 ${tag} ${Date.now().toString(36)}`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], {
    env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label },
    encoding: 'utf8'
  });
  expect(enrolled.status, enrolled.stderr).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  const state = mkdtempSync(join(tmpdir(), `hub-e2e-archive-${tag}-`));
  const agents = [{ id: 'fakeacp', label: '假 ACP', command: process.execPath, args: [FAKE], listModelsArgs: [FAKE, '--models'] }];
  const worker = spawn(process.execPath, ['apps/worker/src/main.ts'], {
    env: {
      PATH,
      HOME: state,
      HUB_URL: hubUrl,
      HUB_WORKER_CREDENTIAL: credential,
      WORKER_ID: workerId,
      WORKER_ORIGIN: 'remote',
      WORKER_LABEL: label,
      WORKER_ROOTS: e2eWorkerRoots(),
      WORKER_STATE_DIR: state,
      WORKER_RUNTIMES_DIR: join(state, 'runtimes'),
      ACP_AGENTS: JSON.stringify(agents)
    },
    stdio: 'ignore'
  });
  workers.push(worker);
  for (let i = 0; i < 120; i++) {
    const online = (await (await page.request.get('/api/workers')).json()) as Array<{ id?: string; workerId?: string; state: string }>;
    if (online.find((item) => (item.workerId ?? item.id) === workerId)?.state === 'online') break;
    await page.waitForTimeout(500);
  }

  const dir = mkdtempSync(join(tmpdir(), `e2e-archive-${tag}-`));
  const project = (await (
    await page.request.post('/api/projects', {
      data: { name: `e2e 归档项目 ${tag} ${Date.now().toString(36)}`, rootPath: dir, workerId },
      headers
    })
  ).json()) as { id: string };
  const task = (await (
    await page.request.post('/api/tasks', { data: { projectId: project.id, title: `归档任务-${tag}` }, headers })
  ).json()) as { id: string };
  const keep = (await (
    await page.request.post('/api/tasks', { data: { projectId: project.id, title: `保留任务-${tag}` }, headers })
  ).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', {
    data: { taskId: task.id, agentId: 'fakeacp', model: '' },
    headers
  });
  expect(derived.ok(), await derived.text()).toBe(true);
  const session = (await derived.json()) as { id: string };
  const named = await page.request.put(`/api/sessions/${session.id}/title`, {
    data: { title: `归档会话-${tag}` },
    headers
  });
  expect(named.ok(), await named.text()).toBe(true);
  // 归档要求会话停下来；先停掉，等画布确认，而不是凭 HTTP 返回猜。
  expect((await page.request.post(`/api/sessions/${session.id}/interrupt`, { data: {}, headers })).ok()).toBe(true);
  for (let i = 0; i < 120; i++) {
    const canvas = (await (await page.request.get(`/api/projects/${project.id}/canvas`, { headers })).json()) as {
      sessions: Array<{ id: string; status: string }>;
    };
    if (canvas.sessions.find((item) => item.id === session.id)?.status !== 'running') break;
    await page.waitForTimeout(250);
  }
  return { project, task, keep, session: session.id, headers };
}

async function openTaskLog(page: Page, title: string) {
  await page.getByRole('button', { name: `${title} 的日志` }).click();
  await expect(page.getByTestId('task-detail')).toBeVisible();
}

test.describe('桌面 1280', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('归档后从列表/画布退场，搜索与直接链接仍可打开，恢复不启动工作', async ({ page, baseURL }) => {
    const { project, task, session } = await seed(page, baseURL!, '桌面');
    await page.goto(`/#/p/${project.id}/list`);
    await expect(page.getByTestId('list-task-group').filter({ hasText: `归档任务-桌面` })).toBeVisible();

    await openTaskLog(page, `归档任务-桌面`);
    await page.getByTestId('task-archive').click();
    await expect(page.getByTestId('task-archived')).toBeVisible();
    await page.getByRole('button', { name: '关闭' }).click();

    // 日常分组里退场；保留任务本来就没有会话，仍在「未开始」区。
    await expect(page.getByTestId('list-task-group').filter({ hasText: `归档任务-桌面` })).toHaveCount(0);
    await expect(page.getByTestId('list-unstarted')).toContainText('保留任务-桌面');
    await expect(page.getByTestId('list-archived')).toContainText('1 个任务');
    await page.getByTestId('list-archived').getByRole('button', { name: /已归档/ }).click();
    await expect(page.getByTestId('list-archived-task')).toContainText('归档任务-桌面');
    await expect(page.getByTestId('list-archived-task').getByTestId('list-archived-restore')).toBeVisible();

    // 画布也不摆这个节点。
    await page.goto(`/#/p/${project.id}/canvas`);
    await expect(page.getByText('归档任务-桌面', { exact: true })).toHaveCount(0);
    await expect(page.getByText('保留任务-桌面', { exact: true }).first()).toBeVisible();

    // 搜索还能找到；打开的是任务详情，不是一条“开始会话”入口。
    await page.goto('/#/home');
    const search = page.getByLabel('搜项目、任务或会话');
    await search.fill('归档任务-桌面');
    await expect(page.getByTestId('metadata-task')).toContainText('归档任务-桌面');
    await page.getByTestId('metadata-task').click();
    await expect(page.getByTestId('task-detail')).toBeVisible();
    await expect(page.getByTestId('task-archived')).toBeVisible();
    await expect(page.getByRole('button', { name: `开始会话：归档任务-桌面` })).toHaveCount(0);
    await page.getByRole('button', { name: '关闭' }).click();

    // 直接链接打开已有会话，不因任务归档而 404。
    await page.goto(`/#/p/${project.id}/focus/${session}`);
    await expect(page.getByLabel('发送消息')).toBeVisible();
    await expect(page.getByRole('button', { name: '返回' })).toBeVisible();

    // 恢复：任务回到列表，不新增会话，也不自动开始。
    await page.goto(`/#/p/${project.id}/list`);
    await page.getByTestId('list-archived').getByRole('button', { name: /已归档/ }).click();
    await page.getByTestId('list-archived-open').click();
    await page.getByTestId('task-archive').click();
    await expect(page.getByTestId('task-archived')).toHaveCount(0);
    await page.getByRole('button', { name: '关闭' }).click();
    await expect(page.getByTestId('list-task-group').filter({ hasText: '归档任务-桌面' })).toBeVisible();
    await expect(page.getByTestId('list-task-start').filter({ hasText: '归档任务-桌面' })).toHaveCount(0);
  });
});

test.describe('手机 390', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('手机从已归档区恢复，入口和按钮都够大', async ({ page, baseURL }) => {
    const { project, task, headers } = await seed(page, baseURL!, '手机');
    const archived = await page.request.post(`/api/tasks/${task.id}/archive`, { data: { archived: true }, headers });
    expect(archived.ok(), await archived.text()).toBe(true);

    await page.goto(`/#/p/${project.id}/list`);
    const section = page.getByTestId('list-archived');
    await expect(section).toContainText('1 个任务');
    const toggle = section.getByRole('button', { name: /已归档/ });
    const toggleBox = await toggle.boundingBox();
    expect(toggleBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    await toggle.click();

    const restore = page.getByTestId('list-archived-restore');
    const restoreBox = await restore.boundingBox();
    expect(restoreBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    // 恢复失败时别把行抽走：保留现场，给出服务端的原话和一次重试。
    await page.route('**/api/tasks/*/archive', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'conflict', message: '任务下还有会话在运行或回合结果未确认，请先处理' } })
      })
    );
    await restore.click();
    await expect(page.getByTestId('list-action-toast')).toContainText('没恢复「归档任务-手机」');
    await expect(page.getByTestId('list-action-toast')).toContainText('任务下还有会话在运行或回合结果未确认，请先处理');
    await expect(section).toContainText('1 个任务');

    // 重试走同一条真实请求；成功后行才退场。
    await page.unroute('**/api/tasks/*/archive');
    await page.getByTestId('list-action-undo').click();
    await expect(page.getByTestId('list-action-toast')).toContainText('已恢复「归档任务-手机」');
    await expect(section).toHaveCount(0);
    await expect(page.getByTestId('list-task-group').filter({ hasText: '归档任务-手机' })).toBeVisible();
    await expect(page.getByTestId('list-context')).toContainText('2 个任务 · 1 条会话');
  });
});
