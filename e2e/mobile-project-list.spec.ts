import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { loginByApi } from './login.ts';

const LONG_TITLE = '把本地启动流程整理成脚本，顺便补齐文档、回滚说明和权限检查';

test.afterAll(() => stopFakeWorker());

type Seed = {
  project: { id: string };
  longTask: { id: string };
  session: { id: string };
  headers: Record<string, string>;
  csrf: string;
};

/** 起一个项目：一条任务带会话（有内容可读），一条长标题任务还没有会话。 */
async function seed(page: Page, baseURL: string | undefined, taskCount = 2): Promise<Seed> {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const workerId = await ensureFakeWorker(page, baseURL!);
  const dir = mkdtempSync(join(tmpdir(), 'e2e-mobile-list-'));
  const project = (await (
    await page.request.post('/api/projects', { data: { name: `e2e 手机列表 ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers })
  ).json()) as { id: string };
  const longTask = (await (
    await page.request.post('/api/tasks', { data: { projectId: project.id, title: LONG_TITLE }, headers })
  ).json()) as { id: string };
  const startedTask = (await (
    await page.request.post('/api/tasks', { data: { projectId: project.id, title: '构建日志排查' }, headers })
  ).json()) as { id: string };
  for (let i = 2; i < taskCount; i++) {
    await page.request.post('/api/tasks', { data: { projectId: project.id, title: `排队任务 ${i}` }, headers });
  }
  const derived = await page.request.post('/api/sessions/derive', {
    data: { taskId: startedTask.id, agentId: FAKE_AGENT_ID, model: '' }, headers
  });
  expect(derived.status(), await derived.text()).toBe(201);
  const session = (await derived.json()) as { id: string };
  const prompted = await page.request.post(`/api/sessions/${session.id}/prompt`, { data: { text: '看下构建日志' }, headers });
  expect(prompted.ok(), await prompted.text()).toBe(true);
  return { project, longTask, session, headers, csrf };
}

async function openList(page: Page, projectId: string): Promise<void> {
  await page.goto(`/#/p/${projectId}/list`);
  await expect(page.getByTestId('list-view')).toBeVisible();
}

test.describe('手机上的项目列表', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('会话在前、单行不竖排、标题进详情、刷新真的重拉且不丢状态', async ({ page, baseURL }, testInfo) => {
    const { project, session, headers } = await seed(page, baseURL);
    await openList(page, project.id);

    // 顶栏已经有项目名，列表头只剩计数，旁边是刷新。
    await expect(page.getByTestId('list-context')).toContainText('2 个任务 · 1 条会话');
    await expect(page.getByTestId('list-refresh')).toBeVisible();

    // 会话区在「暂无会话的任务」之前：手机上先给「上次聊到哪」。
    const group = page.getByTestId('list-task-group').first();
    await expect(group).toContainText('1 条会话');
    await expect(page.getByTestId('list-unstarted')).toContainText('暂无会话的任务');
    const groupBox = (await group.boundingBox())!;
    const tasksBox = (await page.getByTestId('list-unstarted').boundingBox())!;
    expect(groupBox.y).toBeLessThan(tasksBox.y);

    // 行里能认出这条会话：不是「—」，也不是调度器模板原文。
    await expect(group.getByTestId('list-session-row').first().getByTestId('list-session-label')).toHaveText('看下构建日志');

    // 长标题不把状态挤成竖排：任务行还是单行（≤56px），状态小胶囊在标题右侧同一行。
    const row = page.getByTestId('list-task-row').first();
    const rowBox = (await row.boundingBox())!;
    expect(rowBox.height).toBeLessThanOrEqual(56);
    const badge = row.getByTestId('task-status').first();
    const badgeBox = (await badge.boundingBox())!;
    expect(badgeBox.height).toBeLessThanOrEqual(24);
    expect(badgeBox.width).toBeGreaterThan(badgeBox.height);

    // 标题点开任务详情，详情里能再开一条会话（进显式配置，不猜 agent/model）。
    await row.getByTestId('list-task-open').click();
    await expect(page.getByTestId('task-detail')).toBeVisible();
    await expect(page.getByTestId('task-detail')).toContainText(LONG_TITLE);
    await page.getByTestId('task-derive').click();
    await expect(page.getByTestId('derive-target')).toContainText(LONG_TITLE);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('derive-target')).toBeHidden();

    // 底部那排重复的 chip 在手机上不出现（桌面还在）。
    await expect(page.getByText('任务 · 点一下从它再开一条会话')).toBeHidden();

    // 刷新：请求真的发出去，转圈期间禁用；拿回新数据后就地更新。
    await page.route('**/api/projects/*/canvas', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });
    const refresh = page.getByTestId('list-refresh');
    const requested = page.waitForRequest((req) => req.url().includes('/canvas') && req.method() === 'GET');
    await refresh.dispatchEvent('click');
    await expect(refresh).toHaveAttribute('aria-busy', 'true');
    await expect(refresh).toBeDisabled();
    await requested;
    await expect(refresh).toHaveAttribute('aria-busy', 'false');
    await expect(refresh).toBeEnabled();
    // 已经在线上的会话还在原处（刷新没有把页面重置掉）。
    await expect(group.getByTestId('list-session-row')).toHaveCount(1);
    await expect(page.getByTestId('list-view')).toBeVisible();
    expect(page.url()).toContain('/list');
    await page.screenshot({ path: testInfo.outputPath('mobile-list-390.png') });

    // 服务器上多出来的任务，点一下刷新就出现，不用整页重载。
    const late = (await (
      await page.request.post('/api/tasks', { data: { projectId: project.id, title: '刷新后才出现的任务' }, headers })
    ).json()) as { id: string };
    const lateRow = page.getByTestId('list-task-row').filter({ hasText: '刷新后才出现的任务' });
    await expect(lateRow).toHaveCount(0);
    const second = page.waitForRequest((req) => req.url().includes('/canvas') && req.method() === 'GET');
    await page.getByTestId('list-refresh').dispatchEvent('click');
    await second;
    await expect(lateRow).toHaveCount(1);
    await expect(lateRow).toBeVisible();
    await expect(page.getByTestId('list-context')).toContainText('3 个任务');
    expect(late.id).toBeTruthy();

    // 会话本身还在（刷新不是重新建一条）。
    await expect(page.getByTestId('list-view').locator(`[data-session-id="${session.id}"]`)).toHaveCount(1);
  });
});

test.describe('手机上的项目列表（窄屏 320）', () => {
  test.use({ viewport: { width: 320, height: 700 } });

  test('一屏不横滑，按钮够 44px，长标题仍在单行里', async ({ page, baseURL }, testInfo) => {
    const { project } = await seed(page, baseURL);
    await openList(page, project.id);

    // 320 宽不出现横向滚动：长标题被截断，而不是把整页撑宽。
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    for (const id of ['list-refresh', 'list-task-open', 'list-task-start']) {
      const box = (await page.getByTestId(id).first().boundingBox())!;
      expect(box.height, `${id} 的高度`).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width, `${id} 的右边界`).toBeLessThanOrEqual(320.5);
    }
    const rowBox = (await page.getByTestId('list-task-row').first().boundingBox())!;
    expect(rowBox.height).toBeLessThanOrEqual(56);
    const sessionBox = (await page.getByTestId('list-session-row').first().boundingBox())!;
    expect(sessionBox.x + sessionBox.width).toBeLessThanOrEqual(320.5);
    await page.screenshot({ path: testInfo.outputPath('mobile-list-320.png') });
  });
});
