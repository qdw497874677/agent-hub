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
 * 项目默认列表、任务与会话的分工、返回原处。
 *
 * 以前「新建任务」只建一条记录，手机上看起来像什么都没发生；首页也把同一任务下的
 * 多条会话显示成同一行。这里把这两件事钉在浏览器里：未开始的任务在列表最上面、
 * 建完有回执且能直接开始会话；首页/等我处理优先显示会话自己的名字。
 *
 * 自带一台假 ACP 机器：不依赖开发机上装了哪些运行时，也不去真调模型。
 */
async function seed(page: Page, baseURL: string, tag: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  const code = ((await (await page.request.post('/api/workers/pairing', { data: {}, headers })).json()) as { code: string }).code;
  const hubUrl = `${baseURL.replace(/^http/, 'ws')}/worker`;
  const PATH = e2eWorkerPath();
  const label = `e2e 阶段一机器 ${tag} ${Date.now().toString(36)}`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], {
    env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label },
    encoding: 'utf8'
  });
  expect(enrolled.status, enrolled.stderr).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  const state = mkdtempSync(join(tmpdir(), `hub-e2e-phase1-${tag}-`));
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
  const dir = mkdtempSync(join(tmpdir(), `e2e-phase1-${tag}-`));
  const project = (await (
    await page.request.post('/api/projects', { data: { name: `e2e 阶段一 ${tag} ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers })
  ).json()) as { id: string };
  const withSession = (await (
    await page.request.post('/api/tasks', { data: { projectId: project.id, title: `有会话的任务-${tag}` }, headers })
  ).json()) as { id: string };
  const unstarted = (await (
    await page.request.post('/api/tasks', { data: { projectId: project.id, title: `还没开始的任务-${tag}` }, headers })
  ).json()) as { id: string };
  const make = async (title: string) => {
    const made = await page.request.post('/api/sessions/derive', {
      data: { taskId: withSession.id, agentId: 'fakeacp', model: '' },
      headers
    });
    expect(made.ok(), await made.text()).toBe(true);
    const session = (await made.json()) as { id: string };
    const renamed = await page.request.put(`/api/sessions/${session.id}/title`, { data: { title }, headers });
    expect(renamed.ok(), await renamed.text()).toBe(true);
    return session.id;
  };
  const first = await make(`甲会话-${tag}`);
  const second = await make(`乙会话-${tag}`);
  return { project, withSession, unstarted, first, second, headers };
}

test.describe('桌面 1280', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('项目默认列表；未开始的任务在最上面；返回回到列表而不是画布', async ({ page, baseURL }) => {
    const { project, withSession, unstarted, first } = await seed(page, baseURL!, '桌面');

    // 首页先认会话名：同一任务下的两条会话不再长得一模一样。
    await page.goto('/');
    await expect(page.getByTestId('home-session-row').filter({ hasText: '甲会话-桌面' })).toHaveCount(1);
    await expect(page.getByTestId('home-session-row').filter({ hasText: '乙会话-桌面' })).toHaveCount(1);
    await expect(page.getByPlaceholder('搜项目、任务或会话')).toBeVisible();

    // 首页搜索条件在「进会话 → 返回」后还在，不要求用户重新搜一遍。
    const homeSearch = page.getByLabel('搜项目、任务或会话');
    await homeSearch.fill('乙会话-桌面');
    await expect(page.getByTestId('metadata-session')).toHaveCount(1);
    await page.getByTestId('metadata-session').click();
    await expect(page.getByLabel('发送消息')).toBeVisible();
    await page.getByRole('button', { name: '返回' }).click();
    await expect(page.getByTestId('home-root')).toBeVisible();
    await expect(page.getByLabel('搜项目、任务或会话')).toHaveValue('乙会话-桌面');
    await expect(page.getByTestId('metadata-session')).toHaveCount(1);

    // 项目落在列表：没有选会话时不再摆一个点不动的「会话」页签。
    await page.goto(`/#/p/${project.id}`);
    await expect(page.getByTestId('list-view')).toBeVisible();
    await expect(page.getByRole('button', { name: '会话', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('list-context')).toContainText('2 个任务 · 2 条会话');

    // 没有会话的任务不是消失，而是在最上面明说「未开始」。
    const unstartedSection = page.getByTestId('list-unstarted');
    await expect(unstartedSection).toBeVisible();
    await expect(unstartedSection).toContainText('未开始');
    await expect(unstartedSection).toContainText('1 个任务');
    const pendingRow = unstartedSection.getByTestId('list-task-row').filter({ hasText: '还没开始的任务-桌面' });
    await expect(pendingRow).toContainText('待开始');
    await expect(pendingRow.getByRole('button', { name: '开始会话：还没开始的任务-桌面' })).toBeVisible();
    await expect(page.getByRole('region', { name: `任务：有会话的任务-桌面` })).toContainText('2 条会话');
    // 已派生但还没发第一句话：列表和侧栏都该说「就绪」，不能一边「工作中」一边「就绪」。
    await expect(page.getByRole('region', { name: `任务：有会话的任务-桌面` }).getByText('就绪').first()).toBeVisible();

    // 从列表进会话，再点页头的返回：回到列表，不跳到画布。
    await page.getByTestId('list-session-row').first().click();
    await expect(page.getByLabel('发送消息')).toBeVisible();
    await page.getByRole('button', { name: '返回' }).click();
    await expect(page.getByTestId('list-view')).toBeVisible();
    expect(new URL(page.url()).hash).toBe(`#/p/${project.id}`);

    // 直接打开一条会话（没有来源记录）时，返回也落到列表，而不是 blank / 画布。
    await page.goto(`/#/p/${project.id}/focus/${first}`);
    await expect(page.getByLabel('发送消息')).toBeVisible();
    await page.getByRole('button', { name: '返回' }).click();
    await expect(page.getByTestId('list-view')).toBeVisible();
    expect(new URL(page.url()).hash).toBe(`#/p/${project.id}/list`);

    // 没改成功的状态要留在屏幕上，不能静默。
    await page.route(`**/api/tasks/${unstarted.id}/status`, async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'forbidden', message: '你没有权限改这个任务' } })
      });
    });
    await page.getByTestId('list-task-row').filter({ hasText: '还没开始的任务-桌面' }).getByRole('button', { name: '查看任务日志：还没开始的任务-桌面' }).click();
    const detail = page.getByTestId('task-detail');
    await expect(detail).toBeVisible();
    await page.getByRole('button', { name: '开始', exact: true }).click();
    await expect(detail.getByTestId('task-status-error')).toContainText('没改成功');
    await expect(detail.getByTestId('task-status-error')).toContainText('你没有权限改这个任务');
    await page.unroute(`**/api/tasks/${unstarted.id}/status`).catch(() => undefined);
  });
});

test.describe('手机 390', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('新建任务有回执，任务出现在未开始组，点回执直接开始会话', async ({ page, baseURL }) => {
    const { project } = await seed(page, baseURL!, '手机');
    await page.goto(`/#/p/${project.id}/list`);
    await expect(page.getByTestId('list-view')).toBeVisible();
    // 手机抽屉里的全站导航要在任务树之前就能看到，不用先滚过一长串会话。
    await page.getByRole('button', { name: '打开侧栏' }).click();
    const drawerNav = page.getByTestId('drawer-global-nav');
    await expect(drawerNav).toBeVisible();
    // 抽屉是滑上来的，等动画停稳再量，否则拿到的是中途的坐标。
    await expect
      .poll(async () => {
        const box = await drawerNav.boundingBox();
        return box === null ? 9999 : Math.round(box.y + box.height);
      })
      .toBeLessThanOrEqual(844);
    const drawerNavBox = await drawerNav.boundingBox();
    expect(drawerNavBox!.y).toBeGreaterThanOrEqual(0);
    const taskNav = page.getByRole('navigation', { name: '任务与会话' });
    expect(drawerNavBox!.y).toBeLessThan((await taskNav.boundingBox())!.y);
    await expect(drawerNav.getByTestId('nav-home')).toBeVisible();
    await page.getByRole('button', { name: '关闭侧栏' }).click();
    await expect(page.getByTestId('nav-sheet')).toHaveCount(0);

    // 先把列表滚到底：建完任务要自己滚回「未开始」，不能只让 toast 出现。
    await page.getByTestId('list-view').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const title = `手机新建-${Date.now().toString(36)}`;

    await page.getByRole('button', { name: '新建任务' }).click();
    const dialog = page.getByRole('dialog', { name: '新建任务' });
    await dialog.getByLabel('标题').fill(title);
    await dialog.getByRole('button', { name: '创建任务' }).click();

    // 建完不能只是「弹窗关了」：给一条带下一步的回执。
    const toast = page.getByTestId('task-created-toast');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(`任务「${title}」已创建`);
    const pendingRow = page.getByTestId('list-unstarted').getByTestId('list-task-row').filter({ hasText: title });
    await expect(pendingRow).toBeVisible();
    await expect(pendingRow).toContainText('待开始');
    const pendingBox = await pendingRow.boundingBox();
    expect(pendingBox!.y, '新任务滚进了视口').toBeLessThan(844);
    await expect(page.getByTestId('list-unstarted')).toContainText('2 个任务');

    // 回执上的「开始会话」直接打开派生面板；环境仍然要人明确选，不替用户猜机器。
    await page.getByTestId('task-created-start').click();
    const run = page.getByRole('dialog', { name: '开始会话' });
    await expect(run).toBeVisible();
    await expect(run.getByText('为这条任务开一条新会话')).toBeVisible();
    await expect(run.getByRole('button', { name: '开始', exact: true })).toBeDisabled();
  });
});
