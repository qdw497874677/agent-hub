import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { currentRun } from './run-id.ts';
import { loginByApi } from './login.ts';
import { chooseHubModel } from './hub-model.ts';

const RUN = currentRun();
const PROJECT_NAME = `e2e-links-${RUN}`;
const PROJECT_DIR = `/tmp/agent-hub-e2e-links-${RUN}`;
const TASK_TITLE = `连线任务-${RUN}`;

const sessionNode = (page: Page) => page.locator('.react-flow__node-session');
const taskNode = (page: Page, title: string) => page.locator('.react-flow__node-task').filter({ hasText: title });

async function canvasEdges(page: Page, projectId: string): Promise<Array<{ kind: string }>> {
  const response = await page.request.get(`/api/projects/${projectId}/canvas`);
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { edges: Array<{ kind: string }> };
  return body.edges;
}

async function linkCount(page: Page, projectId: string): Promise<number> {
  return (await canvasEdges(page, projectId)).filter((edge) => edge.kind === 'link').length;
}

async function dragLink(page: Page, from: Locator, to: Locator): Promise<void> {
  const source = await from.boundingBox();
  const target = await to.boundingBox();
  if (!source || !target) throw new Error('找不到会话连线手柄');
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  await page.mouse.up();
}

test.beforeAll(() => {
  mkdirSync(PROJECT_DIR, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await loginByApi(page);
});

test('对话页选择器和画布拖线连的是同一份会话关系', async ({ page }) => {
  await page.goto('/');

  const nav = page.getByRole('navigation');
  await nav.getByTitle('新建项目').click();
  const panel = page.getByLabel('新建项目');
  await panel.getByLabel('项目名').fill(PROJECT_NAME);
  await panel.getByRole('button', { name: '创建' }).click();
  await expect(page.getByRole('button', { name: '新建任务' }).first()).toBeVisible();

  await page.getByTestId('no-tasks').getByRole('button', { name: '新建任务' }).click();
  await page.getByRole('dialog', { name: '新建任务' }).getByLabel('标题').fill(TASK_TITLE);
  await page.getByRole('button', { name: '创建任务' }).click();
  await expect(taskNode(page, TASK_TITLE)).toContainText('0 个会话');

  // 第一条会话：把 /tmp 下的目录登记成持久工作空间。
  await taskNode(page, TASK_TITLE).getByRole('button', { name: '＋ 会话' }).click();
  const firstRun = page.getByRole('dialog', { name: '在哪台机器、哪个工作空间干活？' });
  await firstRun.getByRole('radio', { name: /新建持久工作空间/ }).click();
  await firstRun.getByRole('radio', { name: '选已有目录' }).click();
  const picker = page.getByLabel('目录选择器');
  if ((await picker.count()) === 0) await firstRun.getByRole('button', { name: '浏览…' }).click();
  const pathInput = picker.getByRole('combobox', { name: '路径' });
  await expect(pathInput).toHaveValue(/\/$/);
  await pathInput.fill(PROJECT_DIR);
  await expect(picker.getByRole('option').filter({ hasText: `agent-hub-e2e-links-${RUN}` }).first()).toHaveAttribute('data-selected', 'true');
  await pathInput.press('Enter');
  await expect(pathInput).toHaveValue(`${PROJECT_DIR}/`);
  await picker.getByRole('button', { name: '使用', exact: true }).click();
  await expect(firstRun).toContainText(`agent-hub-e2e-links-${RUN}`);
  await chooseHubModel(firstRun);
  await firstRun.getByRole('button', { name: '开始' }).click();
  await expect(page.getByLabel('发送消息')).toBeVisible();
  await page.getByRole('button', { name: '画布', exact: true }).click();

  // 第二条会话：直接选刚登记的工作空间。
  await taskNode(page, TASK_TITLE).getByRole('button', { name: '＋ 会话' }).click();
  const secondRun = page.getByRole('dialog', { name: '在哪台机器、哪个工作空间干活？' });
  const existing = secondRun.getByRole('radio').filter({ hasText: `agent-hub-e2e-links-${RUN}` }).first();
  await expect(existing).toBeVisible();
  await existing.click();
  await chooseHubModel(secondRun);
  await secondRun.getByRole('button', { name: '开始' }).click();
  await expect(page.getByLabel('发送消息')).toBeVisible();
  await page.getByRole('button', { name: '画布', exact: true }).click();
  await expect(sessionNode(page)).toHaveCount(2);

  const projectId = /#\/p\/([^/]+)/.exec(new URL(page.url()).hash)?.[1];
  if (!projectId) throw new Error('地址栏里没有项目 id');
  expect(await linkCount(page, projectId)).toBe(0);

  // 入口一：专注对话里的「连接 N」选择器。
  await sessionNode(page).first().getByRole('button', { name: '打开' }).click();
  const firstSessionId = /#\/p\/[^/]+\/focus\/([^/]+)/.exec(new URL(page.url()).hash)?.[1];
  if (!firstSessionId) throw new Error('地址栏里没有会话 id');
  await expect(page.getByRole('button', { name: '连接 0', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '连接 0', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '连接会话' });
  await expect(dialog).toBeVisible();
  const checkbox = dialog.locator('input[type="checkbox"]').first();
  await expect(checkbox).not.toBeChecked();
  // 同名会话也能靠任务 / 机器 / 工作空间 / 短号区分。
  const firstOption = dialog.getByTestId('session-link-options').locator('label').first();
  const workerLabel = ((await (await page.request.get('/api/workers')).json()) as Array<{ label: string }>)[0]?.label ?? '本机';
  await expect(firstOption).toContainText(TASK_TITLE);
  await expect(firstOption).toContainText(workerLabel);
  await expect(firstOption).toContainText(/#[0-9a-f]{8}/);
  // 乐观更新：点击后立即显示已连接，后台再确认。
  await checkbox.click();
  await expect(page.getByRole('button', { name: '连接 1', exact: true })).toBeVisible();
  await expect(checkbox).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('session-link-chips')).toBeVisible();
  expect(await linkCount(page, projectId)).toBe(1);

  // 回到画布：link 边和两条 derive 边并存。
  await page.getByRole('button', { name: '画布', exact: true }).click();
  await expect(page.locator('.react-flow__edge')).toHaveCount(3);

  // 同一个选择器里断开，画布边一起消失。
  await page.goto(`/#/p/${projectId}/focus/${firstSessionId}`);
  await expect(page.getByRole('button', { name: '连接 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '连接 1', exact: true }).click();
  const again = page.getByRole('dialog', { name: '连接会话' });
  await expect(again.locator('input[type="checkbox"]').first()).toBeChecked();
  await again.locator('input[type="checkbox"]').first().click();
  await expect(page.getByRole('button', { name: '连接 0', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('session-link-chips')).toHaveCount(0);
  expect(await linkCount(page, projectId)).toBe(0);

  // 入口二：从会话节点底部的连接点拖到另一个会话节点顶部。
  await page.getByRole('button', { name: '画布', exact: true }).click();
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  const nodes = sessionNode(page);
  await expect(nodes).toHaveCount(2);
  const source = nodes.nth(0).locator('.react-flow__handle-bottom');
  const target = nodes.nth(1).locator('.react-flow__handle-top');
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  await dragLink(page, source, target);
  await expect.poll(async () => linkCount(page, projectId)).toBe(1);
  await expect(page.locator('.react-flow__edge')).toHaveCount(3);

  await page.goto(`/#/p/${projectId}/focus/${firstSessionId}`);
  await expect(page.getByRole('button', { name: '连接 1', exact: true })).toBeVisible();
  await expect(page.getByTestId('session-link-chips')).toBeVisible();

  // 离线机器：选择器不允许新建连接。
  await page.getByRole('button', { name: '连接 1', exact: true }).click();
  const onlineDialog = page.getByRole('dialog', { name: '连接会话' });
  await onlineDialog.locator('input[type="checkbox"]').first().click();
  await page.keyboard.press('Escape');
  await page.route('**/api/workers', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Array<Record<string, unknown>>;
    await route.fulfill({ response, json: body.map((worker) => ({ ...worker, state: 'offline' })) });
  });
  await page.reload();
  await expect(page.getByRole('button', { name: '连接 0', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '连接 0', exact: true }).click();
  const offlineDialog = page.getByRole('dialog', { name: '连接会话' });
  await expect(offlineDialog.locator('input[type="checkbox"]').first()).toBeDisabled();
  await expect(offlineDialog).toContainText('机器离线');

  // 画布拖线也不能连离线机器上的会话。
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '画布', exact: true }).click();
  await expect(sessionNode(page)).toHaveCount(2);
  const [offlineSource, offlineTarget] = await sessionNode(page).all();
  if (!offlineSource || !offlineTarget) throw new Error('离线场景缺少两个会话节点');
  await dragLink(
    page,
    offlineSource.locator('.react-flow__handle-bottom'),
    offlineTarget.locator('.react-flow__handle-top')
  );
  await expect.poll(async () => linkCount(page, projectId)).toBe(0);
});
