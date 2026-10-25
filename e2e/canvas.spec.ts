import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { currentRun } from './run-id.ts';

/**
 * 闭环的那条线：一个干净的浏览器，从零到「会话在卡片里真的跑起来了」。
 * 这是 docs/plan/mvp-plan.md §4 M6 的验收，也是定位 §8 成功判据的机器版。
 *
 * 用例不假设库里是空的：每次跑用带时间戳的项目名，断言只落在自己造出来的节点上。
 */
const RUN = currentRun();
const PROJECT_NAME = `e2e-${RUN}`;
const PROJECT_DIR = `/tmp/agent-hub-e2e-project-${RUN}`;
const TASK_TITLE = `第一条任务-${RUN}`;
const ECHO = `E2E-OK-${RUN}`;

const sessionNode = (page: Page) => page.locator('.react-flow__node-session');
const taskNode = (page: Page, title: string) => page.locator('.react-flow__node-task').filter({ hasText: title });

test.beforeAll(() => {
  mkdirSync(PROJECT_DIR, { recursive: true });
});

test('从建项目到会话跑出第一段文字', async ({ page }) => {
  await page.goto('/');

  // 首页是门厅，不是一上来就一个输入框
  await expect(page.getByRole('heading', { name: 'agent-hub' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '项目' })).toBeVisible();

  // M1：指一个本地目录（打字也行，点选也行——点选见下一条用例）
  await page.getByRole('button', { name: '新建项目' }).click();
  await page.getByPlaceholder('选一个目录，或者直接打绝对路径').fill(PROJECT_DIR);
  await page.getByPlaceholder('选目录后自动取最后一段，可改').fill(PROJECT_NAME);
  await page.getByRole('button', { name: '开始' }).click();

  // M1：画布出现
  await expect(page.getByRole('button', { name: '新建任务' })).toBeVisible();

  // M1：建任务
  await page.getByRole('button', { name: '新建任务' }).click();
  await page.getByPlaceholder('任务标题').fill(TASK_TITLE);
  await page.getByRole('button', { name: '建', exact: true }).click();
  await expect(taskNode(page, TASK_TITLE)).toContainText('0 个会话');

  // M2：双击任务派生会话
  await taskNode(page, TASK_TITLE).dblclick();
  await expect(page.getByText('从任务派生会话')).toBeVisible();
  await page.getByRole('button', { name: '派生' }).click();

  // M2：卡片出现，并从对话流里读回模型真吐出的一句话
  await expect(sessionNode(page)).toHaveCount(1);
  await sessionNode(page).click();
  await page.getByPlaceholder('接着这条思路说下去…').fill(`只回这段文字，不要用工具：${ECHO}`);
  await page.getByRole('button', { name: '发送' }).click();

  // 只认模型真的吐出来的那个词，而且要落在卡片里（textarea 里也有这个词，会假通过）
  await expect(sessionNode(page).getByText(ECHO)).toBeVisible({ timeout: 120_000 });
  await expect(sessionNode(page)).toContainText('完成');
});

test('目录可以点选，不必手打路径', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建项目' }).click();

  // 打开就在家目录，往上走一级，再进 /tmp 找我们自己的目录
  await expect(page.getByRole('button', { name: '↑' })).toBeVisible();
  // 收窄到选择器里点：首页的项目行按钮，可访问名字里也带着这个路径字符串
  const picker = page.getByLabel('目录选择器');
  await picker.getByLabel('当前目录').fill('/tmp');
  await picker.getByRole('button', { name: `agent-hub-e2e-project-${RUN}` }).click();

  await picker.getByRole('button', { name: '用这个目录' }).click();
  await expect(page.getByPlaceholder('选一个目录，或者直接打绝对路径')).toHaveValue(PROJECT_DIR);
  // 选完目录，项目名自动取最后一段
  await expect(page.getByPlaceholder('选目录后自动取最后一段，可改')).toHaveValue(
    `agent-hub-e2e-project-${RUN}`
  );
  await page.getByRole('button', { name: '取消' }).click();
});

test('刷新之后画布还在，布局被记住', async ({ page }) => {
  await page.goto('/');
  // 新浏览器没有 localStorage：从选择页回到自己刚建的那个项目
  await page.getByRole('button', { name: new RegExp(PROJECT_NAME) }).click();
  await expect(sessionNode(page)).toHaveCount(1);
  await expect(taskNode(page, TASK_TITLE)).toContainText('1 个会话');

  const before = await sessionNode(page).boundingBox();
  await page.mouse.move(0, 0);
  await page.goto('/');
  const after = await sessionNode(page).boundingBox();
  expect(after?.x).toBeCloseTo(before?.x ?? -1, 0);
  expect(after?.y).toBeCloseTo(before?.y ?? -1, 0);
});

test('搜索能搜到会话里说过的话，列表能给画布降级', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '项目' })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(PROJECT_NAME) }).click();
  await expect(sessionNode(page)).toHaveCount(1);

  // S6.4 的前半截：切视图不丢草稿
  await sessionNode(page).click();
  const composer = page.getByPlaceholder('接着这条思路说下去…');
  await composer.fill('这段草稿要活过视图切换');
  await page.getByRole('button', { name: '列表' }).click();
  await expect(page.getByRole('columnheader', { name: '任务' })).toBeVisible();
  await page.getByRole('button', { name: '画布' }).click();
  await expect(composer).toHaveValue('这段草稿要活过视图切换');

  // 搜索：用会话正文里的词命中，回车跳到那个节点
  await page.getByRole('button', { name: /搜索/ }).click();
  const palette = page.getByPlaceholder('搜任务标题，或者你记得的那句话');
  await palette.fill(ECHO);
  await expect(page.getByRole('button', { name: new RegExp(ECHO) }).first()).toBeVisible();
  await palette.press('Enter');
  await expect(sessionNode(page)).toHaveCount(1);
  await expect(page.locator('.react-flow__node-session').getByText(ECHO)).toBeVisible();

  // 列表视图：一行一个会话，点一行回到画布并打开检查器
  await page.getByRole('button', { name: '列表' }).click();
  await page.getByRole('cell', { name: TASK_TITLE }).click();
  await expect(page.getByRole('button', { name: '画布' })).toBeVisible();
  await expect(page.locator('.react-flow__node-session')).toHaveCount(1);
});

test('节点在线状态可见，任务的收尾与放弃是两个动作', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '项目' })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(PROJECT_NAME) }).click();
  await expect(sessionNode(page)).toHaveCount(1);

  // S1.2：「它挂了」和「我改坏了配置」要能分辨，所以节点状态是常驻可查的
  await page.getByRole('button', { name: /节点$/ }).click();
  await expect(page.getByText('本机')).toBeVisible();
  await expect(page.getByText('在线')).toBeVisible();
  await page.getByRole('button', { name: /节点$/ }).click();

  // S4.2：收尾不是放弃。先收尾，卡片改口，再重开回到进行中
  await taskNode(page, TASK_TITLE).hover();
  await taskNode(page, TASK_TITLE).getByRole('button', { name: '收尾' }).click();
  await expect(taskNode(page, TASK_TITLE)).toContainText('已收尾');

  await taskNode(page, TASK_TITLE).hover();
  await taskNode(page, TASK_TITLE).getByRole('button', { name: '重开' }).click();
  await expect(taskNode(page, TASK_TITLE)).toContainText('进行中');
});
