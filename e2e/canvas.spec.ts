import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { FAKE_AGENT_ID, ensureFakeWorker, stopFakeWorker } from './fake-worker.ts';

/**
 * 画布主流程。全部用假 ACP agent + 真 Worker：
 *
 * - 不再调用用户配置的模型（真 Pi 曾把整轮拖到 150s 超时，还依赖本机登录态）。
 * - 每个用例自己建项目 / 任务 / 会话（`seedProject`），不共享上一个用例的 module 级 RUN 投影。
 *   旧写法把 RUN 写进模块常量，worker 重启或并发跑一次就换一个 run-id，后续用例找不到项目。
 * - 只走当前产品语义：项目默认列表，全局搜索只搜项目名 / 任务标题 / 会话标题 / 会话 ID，不搜聊天内容。
 */

const STAMP = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
let seq = 0;
const SCRATCH: string[] = [];

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ah-e2e-canvas-${prefix}-`));
  SCRATCH.push(dir);
  return dir;
}

test.beforeEach(async ({ page }) => {
  await loginByApi(page);
});

test.afterAll(() => {
  stopFakeWorker();
  for (const dir of SCRATCH) rmSync(dir, { recursive: true, force: true });
});

const sessionNode = (page: Page) => page.locator('.react-flow__node-session');
const taskNode = (page: Page, title: string) => page.locator('.react-flow__node-task').filter({ hasText: title });

/**
 * 打开某个项目的列表页或画布页。直接走 hash 深链：`#/` 会在 projects 拉完后
 * replace 到「上次打开的项目」，和首页侧栏点击抢时序时首页会中途卸载。
 */
async function openProject(page: Page, projectId: string, view: 'list' | 'canvas'): Promise<void> {
  await page.goto(`/#/p/${projectId}/${view}`);
  await expect(page.locator('[data-testid=view-switch]:visible').first()).toBeVisible();
  if (view === 'list') await expect(page.getByTestId('list-view')).toBeVisible();
}

/** 桌面 project bar 与窄屏 header 可能各有一个视图切换，只点可见的那个。 */
async function switchView(page: Page, view: 'list' | 'canvas'): Promise<void> {
  const bar = page.locator('[data-testid=view-switch]:visible').first();
  await bar.getByRole('button', { name: view === 'canvas' ? '画布' : '列表', exact: true }).click();
}

interface Seeded {
  projectId: string;
  name: string;
  taskId: string;
  taskTitle: string;
  sessionId: string;
  dir: string;
  echo: string;
}

function apiHeaders(csrf: string, origin: string) {
  return { origin, 'x-hub-csrf': csrf };
}

async function seedProject(
  page: Page,
  baseURL: string,
  label: string,
  options: { prompt?: boolean } = {}
): Promise<Seeded> {
  const token = `${STAMP}-${++seq}`;
  const name = `e2e-canvas-${label}-${token}`;
  const taskTitle = `任务-${label}-${token}`;
  const echo = `OK-${token}`;
  const dir = scratchDir(label);
  const workerId = await ensureFakeWorker(page, baseURL);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = apiHeaders(csrf, baseURL);

  const projectResponse = await page.request.post('/api/projects', {
    data: { name, rootPath: dir, workerId },
    headers
  });
  expect(projectResponse.ok(), await projectResponse.text()).toBe(true);
  const project = (await projectResponse.json()) as { id: string };

  const taskResponse = await page.request.post('/api/tasks', {
    data: { projectId: project.id, title: taskTitle },
    headers
  });
  expect(taskResponse.ok(), await taskResponse.text()).toBe(true);
  const task = (await taskResponse.json()) as { id: string };

  const derivedResponse = await page.request.post('/api/sessions/derive', {
    data: { taskId: task.id, agentId: FAKE_AGENT_ID, model: '' },
    headers
  });
  expect(derivedResponse.ok(), await derivedResponse.text()).toBe(true);
  const session = (await derivedResponse.json()) as { id: string };

  if (options.prompt !== false) {
    const promptResponse = await page.request.post(`/api/sessions/${session.id}/prompt`, {
      data: { text: `只回这段文字，不要用工具：${echo}` },
      headers
    });
    expect(promptResponse.ok(), await promptResponse.text()).toBe(true);
    await expect
      .poll(
        async () => {
          const canvasResponse = await page.request.get(`/api/projects/${project.id}/canvas`);
          if (!canvasResponse.ok()) return `http-${canvasResponse.status()}`;
          const canvas = (await canvasResponse.json()) as {
            sessions: Array<{ id: string; status: string }>;
          };
          return canvas.sessions.find((candidate) => candidate.id === session.id)?.status ?? 'missing';
        },
        { timeout: 60_000 }
      )
      .toBe('done');
  }

  return {
    projectId: project.id,
    name,
    taskId: task.id,
    taskTitle,
    sessionId: session.id,
    dir,
    echo
  };
}

test('从建项目到会话跑出第一段文字', async ({ page, baseURL }) => {
  const dir = scratchDir('ui');
  // 先让假 ACP 机器上线：这个用例从 UI 建项目，没有 seedProject 帮忙起 worker，
  // 否则派生弹窗里根本没有可选 agent。
  await ensureFakeWorker(page, baseURL!);

  // 首页侧栏 → 新建项目。项目只登记名字和（可选的）说明 / 仓库，不再在这里选本机目录。
  await page.goto('/');
  const homeSide = page.getByRole('complementary', { name: '首页侧栏' });
  await homeSide.getByTitle('新建项目').click();
  const panel = page.getByRole('region', { name: '新建项目' });
  await expect(panel.getByLabel('项目名')).toBeVisible();
  await panel.getByLabel('项目名').fill(`e2e-canvas-ui-${STAMP}`);
  await panel.getByRole('button', { name: '创建', exact: true }).click();

  // 建完默认落在列表视图。
  await expect(page.getByTestId('list-view')).toBeVisible();
  await page.getByTestId('no-tasks').getByRole('button', { name: '新建任务' }).click();
  const taskDialog = page.getByRole('dialog', { name: '新建任务' });
  await taskDialog.getByLabel('标题').fill(`第一条任务-${STAMP}`);
  await taskDialog.getByRole('button', { name: '创建任务' }).click();

  await switchView(page, 'canvas');
  const task = taskNode(page, `第一条任务-${STAMP}`);
  await expect(task).toBeVisible();
  await expect(task).toContainText('0 个会话');

  // 任务卡 → 派生会话：假 ACP 是唯一提供者，机器自动选中；
  // 工作目录选「新建持久工作目录 → 选已有目录」，走一遍目录选择器。
  await page.mouse.move(2, 2);
  await task.getByRole('button', { name: '＋ 会话' }).click();
  const run = page.getByRole('dialog', { name: '开始会话' });
  await expect(run.getByRole('button', { name: '开始', exact: true })).toBeDisabled();

  const agentSelect = run.locator('#derive-agent');
  await expect(agentSelect.locator(`option[value="${FAKE_AGENT_ID}"]`)).toHaveCount(1);
  await agentSelect.selectOption(FAKE_AGENT_ID);

  await expect(run.getByRole('radio', { name: '新建持久工作目录' })).toBeVisible();
  await run.getByRole('radio', { name: '新建持久工作目录' }).click();
  await run.getByRole('radio', { name: '选已有目录' }).click();

  const picker = run.getByLabel('目录选择器');
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: '输入路径' }).click();
  const pathInput = picker.getByRole('textbox', { name: '路径' });
  await pathInput.fill(dir);
  await pathInput.press('Enter');
  await expect(picker.getByRole('navigation', { name: '当前位置' }).locator('[aria-current="page"]')).toHaveAttribute(
    'title',
    dir
  );
  await picker.getByRole('button', { name: '选此文件夹' }).click();
  await expect(run).toContainText(basename(dir));

  const start = run.getByRole('button', { name: '开始', exact: true });
  await expect(start).toBeEnabled();
  await start.click();

  // 派生成功后直接进专注视图；回画布看卡片。
  const focusComposer = page.getByRole('textbox', { name: '发送消息' });
  await expect(focusComposer).toBeVisible();
  await switchView(page, 'canvas');

  const card = sessionNode(page);
  await expect(card).toHaveCount(1);
  const composer = card.getByLabel(/说一句/);
  await expect(composer).toHaveCount(1);
  const prompt = `只回这段文字，不要用工具：${`OK-${STAMP}`}`;
  await composer.fill(prompt);
  await composer.press('Control+Enter');
  await expect(composer).toHaveValue('');

  const log = card.getByTestId('session-card-log');
  // 假 ACP 对含 OK 的 prompt 只回 `OK`（不回原句），原句自己会作为用户消息留在卡片上。
  await expect(log.getByText('OK', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(card.getByTestId('card-status')).toHaveText('已完成');

  // 打开专注视图：消息记录里有完整往来，「返回」回画布。
  await card.getByRole('button', { name: '打开', exact: true }).click();
  const history = page.getByRole('log', { name: '会话记录' });
  await expect(history).toContainText(prompt);
  await expect(history.getByText('OK', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回' }).click();
  await expect(sessionNode(page)).toHaveCount(1);
});

test('刷新之后画布还在，布局被记住', async ({ page, baseURL }) => {
  const seeded = await seedProject(page, baseURL!, 'layout');
  await openProject(page, seeded.projectId, 'canvas');
  const card = sessionNode(page);
  await expect(card).toHaveCount(1);
  const before = await card.boundingBox();
  expect(before).not.toBeNull();

  await page.reload();
  await expect(sessionNode(page)).toHaveCount(1);
  // 等布局稳定（emoji/字体加载会把节点顶一下）。
  let previous = await sessionNode(page).boundingBox();
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(250);
    const current = await sessionNode(page).boundingBox();
    if (previous && current && Math.abs(current.x - previous.x) < 1 && Math.abs(current.y - previous.y) < 1) break;
    previous = current;
  }
  const after = await sessionNode(page).boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.x - before!.x)).toBeLessThan(2);
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(2);
});

test('搜索找项目/任务/会话，不搜聊天内容；列表保留草稿', async ({ page, baseURL }) => {
  const seeded = await seedProject(page, baseURL!, 'search');
  const draft = `草稿-${STAMP}`;

  // 先看首页的全局搜索。注意：进入过项目后 `#/` 会自动 replace 到「上次打开的项目」，
  // 所以搜索必须在第一次进项目之前做，否则首页会被替换掉、输入框随组件卸载。
  await page.goto('/');
  const metadata = page.getByRole('combobox', { name: '搜项目、任务或会话' });
  await expect(metadata).toBeVisible();

  // 产品语义：全局搜索是元数据搜索，不搜聊天内容。会话里出现过的字样搜不到，并明确说明。
  await metadata.fill(seeded.echo);
  await expect(page.getByTestId('metadata-search-empty')).toContainText('不搜聊天内容');

  // 任务标题能搜到，Enter 打开任务详情，Esc 回到项目列表。
  await metadata.fill(seeded.taskTitle);
  const taskHit = page.getByTestId('metadata-task').filter({ hasText: seeded.taskTitle }).first();
  await expect(taskHit).toBeVisible();
  await metadata.press('Enter');
  await expect(page.getByTestId('task-detail')).toBeVisible();
  await expect(page.getByTestId('task-detail')).toContainText(seeded.taskTitle);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('list-view')).toBeVisible();

  // 画布 → 打开会话 → 写草稿。
  await openProject(page, seeded.projectId, 'canvas');
  const card = sessionNode(page);
  await expect(card).toHaveCount(1);
  await card.locator('header').click();
  await card.getByRole('button', { name: '打开', exact: true }).click();

  const composer = page.getByRole('textbox', { name: '发送消息' });
  await expect(composer).toBeVisible();
  await composer.fill(draft);

  // 切到列表：同一会话的草稿跟着走，行元信息仍是派生。
  await switchView(page, 'list');
  const group = page.getByRole('region', { name: `任务：${seeded.taskTitle}` });
  await expect(group).toBeVisible();
  const row = group.getByTestId('list-session-row');
  await expect(row).toHaveCount(1);
  await expect(group.getByTestId('list-session-meta')).toHaveText(
    /\d+-\d{2} \d{2}:\d{2} · 派生/
  );
  await row.click();
  await expect(page.getByRole('textbox', { name: '发送消息' })).toHaveValue(draft);
});

test('节点在线状态可见，任务的收尾与放弃是两个动作', async ({ page, baseURL }) => {
  const seeded = await seedProject(page, baseURL!, 'status');
  await openProject(page, seeded.projectId, 'canvas');

  await expect(sessionNode(page)).toHaveCount(1);
  await page.getByRole('link', { name: /^机器：/ }).click();
  await expect(page.getByTestId('machines-summary')).toContainText('在线');
  // 假 ACP worker 是一台远程机器，标签由测试助手起名；按 agent 标签找到它。
  await expect(page.locator('[data-testid=machine-row]').filter({ hasText: '假 ACP' }).first()).toBeVisible();
  await page.goBack();
  await expect(sessionNode(page)).toHaveCount(1);

  const task = taskNode(page, seeded.taskTitle);
  await task.hover();
  await task.getByRole('button', { name: '收尾', exact: true }).click();
  await expect(task).toContainText('已收尾');
  await task.hover();
  await task.getByRole('button', { name: '重开', exact: true }).click();
  await expect(task).toContainText('进行中');
});

test('任务详情：日志按作者区分、写日志刷新当前进展、可手改、改状态留痕', async ({ page, baseURL }) => {
  const seeded = await seedProject(page, baseURL!, 'detail');
  await openProject(page, seeded.projectId, 'canvas');

  const task = taskNode(page, seeded.taskTitle);
  await task.hover();
  await task.getByRole('button', { name: '收尾', exact: true }).click();
  await expect(task).toContainText('已收尾');
  await task.hover();
  await task.getByRole('button', { name: '重开', exact: true }).click();

  await task.hover();
  await task.getByRole('button', { name: '日志', exact: true }).click();
  const drawer = page.getByTestId('task-detail');
  await expect(drawer.getByTestId('task-status')).toHaveText('进行中');
  await expect(drawer).toContainText(seeded.taskTitle);

  const log = drawer.getByTestId('work-log');
  await expect(log).toContainText('开了');
  await expect(log.locator('[data-author="system"]').first()).toBeVisible();
  await expect(log).toContainText('改为「已收尾」');
  await expect(log).toContainText('改为「进行中」');

  const marker = `交接-${STAMP}`;
  await drawer.getByLabel('写日志').fill(marker);
  await drawer.getByRole('button', { name: '记录', exact: true }).click();
  await expect(log.locator('[data-author="user"]').filter({ hasText: marker })).toBeVisible();
  await expect(drawer.getByTestId('task-summary')).toContainText(`当前进展：${marker}`);

  const edited = `手改-${STAMP}`;
  await drawer.getByRole('button', { name: '改', exact: true }).click();
  await drawer.getByLabel('当前进展').fill(edited);
  await drawer.getByRole('button', { name: '保存', exact: true }).click();
  await expect(drawer.getByTestId('task-summary')).toContainText(`当前进展：${edited}`);

  await drawer.getByRole('button', { name: '受阻', exact: true }).click();
  await expect(drawer.getByTestId('task-status')).toHaveText('受阻');
  await expect(log).toContainText('改为「受阻」');
  await drawer.getByRole('button', { name: '继续', exact: true }).click();
  await expect(drawer.getByTestId('task-status')).toHaveText('进行中');
});

test('会话卡片能改模型，改完不回弹', async ({ page, baseURL }) => {
  const seeded = await seedProject(page, baseURL!, 'model');
  await openProject(page, seeded.projectId, 'canvas');

  const card = sessionNode(page);
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('card-status')).toHaveText('已完成');

  const controls = card.getByTestId('option-controls-compact');
  await expect(controls).toBeVisible();
  // 假 ACP 只声明模型这一个可调项；标签由 agent 自报（这里叫 Model），不写死中文名。
  const model = controls.locator('button[aria-haspopup="dialog"]').first();
  await expect(model).toBeVisible();
  const before = await model.getAttribute('aria-label');
  await model.click();
  const sheet = page.getByRole('dialog', { name: /^选择/ });
  await expect(sheet).toBeVisible();
  expect(await sheet.getByRole('option').count()).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(model).toHaveAttribute('aria-label', before ?? '');

  // 假 ACP 不报思考强度（thought_level），这一支在真 agent 上才有；这里跳过而不假装覆盖。
  const thinking = card.getByLabel('思考强度');
  if ((await thinking.count()) > 0) {
    const valueBefore = await thinking.inputValue();
    const values = await thinking.locator('option').evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value)
    );
    const other = values.find((value) => value !== valueBefore && value !== '');
    if (other !== undefined) {
      await thinking.selectOption(other);
      await expect(thinking).toHaveValue(other);
      await page.waitForTimeout(1_500);
      await expect(thinking).toHaveValue(other);
    }
  }
});

test('窄屏：专注视图的更多菜单与连接会话', async ({ page, baseURL }) => {
  const seeded = await seedProject(page, baseURL!, 'narrow');
  await page.setViewportSize({ width: 390, height: 844 });
  await openProject(page, seeded.projectId, 'canvas');

  const card = sessionNode(page);
  await expect(card).toHaveCount(1);
  await card.locator('header').click();
  await card.getByRole('button', { name: '打开', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '发送消息' })).toBeVisible();

  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByTestId('session-more-details').click();
  await expect(page.getByRole('menuitem', { name: '连接会话' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '显示设置' })).toBeVisible();
  await page.getByRole('menuitem', { name: '显示设置' }).click();
  await expect(page.getByRole('dialog', { name: '显示设置' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '显示设置' })).toBeHidden();
});

test('窄屏：画布上把会话展开成窗口', async ({ page, baseURL }) => {
  const seeded = await seedProject(page, baseURL!, 'window');
  await page.setViewportSize({ width: 390, height: 844 });
  await openProject(page, seeded.projectId, 'canvas');

  const card = sessionNode(page);
  await expect(card).toHaveCount(1);
  await card.locator('header').click();
  await card.getByRole('button', { name: '在画布中展开' }).click();

  const canvasWindow = page.getByTestId('canvas-window');
  await expect(canvasWindow).toBeVisible();
  const composer = canvasWindow.getByRole('textbox', { name: '发送消息' });
  await expect(composer).toBeVisible();
  await composer.fill(`窗口草稿-${STAMP}`);
  await expect(composer).toHaveValue(`窗口草稿-${STAMP}`);
});

test('侧栏：桌面常驻，窄屏抽屉可开合，列表视图可切换', async ({ page, baseURL }) => {
  const seeded = await seedProject(page, baseURL!, 'sidebar');
  // 直接 goto('/') 会在 projects 拉完后 replace 到上次项目，中间会短暂卸载首页；
  // 统一走 openProject，避免和那次 replace 抢时序。
  await openProject(page, seeded.projectId, 'list');

  const desktopSide = page.getByTestId('project-sidebar');
  await expect(desktopSide).toBeVisible();
  await expect(desktopSide.getByRole('combobox', { name: '切换项目' })).toHaveValue(seeded.projectId);
  await expect(page.getByTestId('project-bar').getByTestId('view-switch')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  // 窄屏侧栏是抽屉：用抽屉容器判断开合（页面上同时存在桌面侧栏节点）。
  const navSheet = page.getByTestId('nav-sheet');
  await expect(navSheet).toBeHidden();
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await expect(navSheet).toBeVisible();
  await expect(navSheet.getByTestId('project-sidebar')).toBeVisible();
  await page.getByRole('button', { name: '关闭侧栏' }).click();
  await expect(navSheet).toBeHidden();

  await switchView(page, 'list');
  await expect(page.getByTestId('list-context')).toContainText('1 个任务 · 1 条会话');
});
