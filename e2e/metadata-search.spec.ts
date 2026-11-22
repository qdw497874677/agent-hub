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
 * 首页的全站元数据搜索。
 *
 * 只认项目名、任务标题、会话标题/短 ID，不读聊天正文；空项目、没有会话的任务
 * 也必须能被找到，且点进去落在项目的列表而不是画布。
 */
async function seed(page: Page, baseURL: string, tag: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };

  const code = ((await (await page.request.post('/api/workers/pairing', { data: {}, headers })).json()) as { code: string }).code;
  const hubUrl = `${baseURL.replace(/^http/, 'ws')}/worker`;
  const PATH = e2eWorkerPath();
  const label = `e2e 元数据搜索 ${tag} ${Date.now().toString(36)}`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], {
    env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label },
    encoding: 'utf8'
  });
  expect(enrolled.status, enrolled.stderr).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  const state = mkdtempSync(join(tmpdir(), `hub-e2e-search-${tag}-`));
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

  const makeProject = async (name: string) => {
    const rootPath = mkdtempSync(join(tmpdir(), `e2e-search-root-${tag}-`));
    return (await (
      await page.request.post('/api/projects', { data: { name, rootPath, workerId }, headers })
    ).json()) as { id: string; name: string };
  };
  const emptyProject = await makeProject(`空项目-${tag}`);
  const project = await makeProject(`搜索项目-${tag}`);
  const noSessionTask = (await (
    await page.request.post('/api/tasks', { data: { projectId: project.id, title: `零会话任务-${tag}` }, headers })
  ).json()) as { id: string; title: string };
  const task = (await (
    await page.request.post('/api/tasks', { data: { projectId: project.id, title: `有会话任务-${tag}` }, headers })
  ).json()) as { id: string; title: string };
  const made = await page.request.post('/api/sessions/derive', {
    data: { taskId: task.id, agentId: 'fakeacp', model: '' },
    headers
  });
  expect(made.ok(), await made.text()).toBe(true);
  const session = (await made.json()) as { id: string };
  const renamed = await page.request.put(`/api/sessions/${session.id}/title`, {
    data: { title: `命名会话-${tag}` },
    headers
  });
  expect(renamed.ok(), await renamed.text()).toBe(true);
  return { emptyProject, project, noSessionTask, task, session };
}

test.describe('桌面 1280', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('空项目、零会话任务、命名会话都能搜到，并跳到正确位置', async ({ page, baseURL }) => {
    const seedData = await seed(page, baseURL!, `桌面-${Date.now().toString(36)}`);
    const tag = seedData.project.name.replace('搜索项目-', '');
    await page.goto('/');

    const search = page.getByLabel('搜项目、任务或会话');
    await search.fill(tag);
    await expect(page.getByTestId('metadata-search-results')).toBeVisible();
    await expect(page.getByTestId('metadata-projects')).toContainText(`空项目-${tag}`);
    await expect(page.getByTestId('metadata-tasks')).toContainText(`零会话任务-${tag}`);
    await expect(page.getByTestId('metadata-sessions')).toContainText(`命名会话-${tag}`);

    // 空项目也在结果里；点进去是列表，不是画布。
    await page.getByTestId('metadata-project').filter({ hasText: `空项目-${tag}` }).click();
    await expect(page.getByTestId('list-view')).toBeVisible();
    expect(new URL(page.url()).hash).toBe(`#/p/${seedData.emptyProject.id}/list`);

    // 零会话任务点进去：列表 + 任务详情，不要求先找一条会话。
    await page.goto('/#/home');
    await page.getByLabel('搜项目、任务或会话').fill(tag);
    await page.getByTestId('metadata-task').filter({ hasText: `零会话任务-${tag}` }).click();
    await expect(page.getByTestId('list-view')).toBeVisible();
    await expect(page.getByTestId('task-detail')).toBeVisible();
    await page.getByRole('button', { name: '关闭' }).click();
    await expect(page.getByTestId('list-view')).toBeVisible();

    // 会话命中进会话；返回回到首页，搜索词还在。
    await page.goto('/#/home');
    await page.getByLabel('搜项目、任务或会话').fill(`命名会话-${tag}`);
    await expect(page.getByTestId('metadata-session')).toHaveCount(1);
    await page.getByTestId('metadata-session').click();
    await expect(page.getByLabel('发送消息')).toBeVisible();
    await page.getByRole('button', { name: '返回' }).click();
    await expect(page.getByTestId('home-root')).toBeVisible();
    await expect(page.getByLabel('搜项目、任务或会话')).toHaveValue(`命名会话-${tag}`);
    await expect(page.getByTestId('metadata-session')).toHaveCount(1);
  });

  test('键盘、空结果、错误和慢请求都有明确状态', async ({ page, baseURL }) => {
    const tag = (await seed(page, baseURL!, `状态-${Date.now().toString(36)}`)).project.name.replace('搜索项目-', '');
    await page.goto('/');
    const search = page.getByLabel('搜项目、任务或会话');

    // 慢请求：先给出「正在搜索」，而不是一片空白。
    await page.route('**/api/metadata-search*', async (route) => {
      const response = await route.fetch();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
      await route.fulfill({ response });
    });
    await search.fill(`命名会话-${tag}`);
    await expect(page.getByTestId('metadata-search-loading')).toBeVisible();
    await expect(page.getByTestId('metadata-session')).toHaveCount(1);
    await page.unroute('**/api/metadata-search*');

    // Enter 打开当前高亮结果；这里查得只剩一条会话。
    await search.press('Enter');
    await expect(page.getByLabel('发送消息')).toBeVisible();
    await page.getByRole('button', { name: '返回' }).click();

    await page.getByLabel('搜项目、任务或会话').fill(`没有这个-${tag}`);
    await expect(page.getByTestId('metadata-search-empty')).toContainText('没有匹配');
    await expect(page.getByTestId('metadata-search-empty')).toContainText('这里不搜聊天内容');

    await page.route('**/api/metadata-search*', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'internal', message: '搜索服务暂时不可用' } })
      })
    );
    await page.getByLabel('搜项目、任务或会话').fill(`命名会话-${tag}-错误`);
    await expect(page.getByTestId('metadata-search-error')).toContainText('搜索失败');
    await expect(page.getByTestId('metadata-search-error')).toContainText('搜索服务暂时不可用');
    await page.unroute('**/api/metadata-search*').catch(() => undefined);
  });
});

test.describe('手机 390', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('结果行是手指能点的块，且不产生横向滚动', async ({ page, baseURL }) => {
    const data = await seed(page, baseURL!, `手机-${Date.now().toString(36)}`);
    const tag = data.project.name.replace('搜索项目-', '');
    await page.goto('/');
    await page.getByLabel('搜项目、任务或会话').fill(tag);
    await expect(page.getByTestId('metadata-search-results')).toBeVisible();

    for (const testId of ['metadata-project', 'metadata-task', 'metadata-session']) {
      const row = page.getByTestId(testId).first();
      const box = await row.boundingBox();
      expect(box!.height, `${testId} 触控高度`).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    await page.getByTestId('metadata-session').filter({ hasText: `命名会话-${tag}` }).click();
    await expect(page.getByLabel('发送消息')).toBeVisible();
  });
});
