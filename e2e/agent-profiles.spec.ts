import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { currentRun } from './run-id.ts';
import { loginByApi } from './login.ts';
import { chooseHubModel } from './hub-model.ts';

const RUN = currentRun();
const PROJECT_NAME = `e2e-profile-${RUN}`;
const PROJECT_DIR = `/tmp/agent-hub-e2e-profile-${RUN}`;
const TASK_TITLE = `配置任务-${RUN}`;
const PROFILE_NAME = `配置-${RUN}`;

const taskNode = (page: Page, title: string) => page.locator('.react-flow__node-task').filter({ hasText: title });
const sessionNode = (page: Page) => page.locator('.react-flow__node-session');

async function chooseWorkspace(_page: Page, dialog: Locator): Promise<void> {
  // 这个测试只关心 profile 的保存/套用，不关心目录选择；用临时工作空间避免路径输入框。
  await dialog.getByRole('radio', { name: /新建临时工作空间/ }).click();
}

test.beforeAll(() => {
  mkdirSync(PROJECT_DIR, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await loginByApi(page);
});

test('Agent 配置：保存当前会话，派生时套用', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('complementary', { name: '首页侧栏' });
  await nav.getByTitle('新建项目').click();
  await page.getByLabel('新建项目').getByLabel('项目名').fill(PROJECT_NAME);
  await page.getByLabel('新建项目').getByRole('button', { name: '创建' }).click();
  await expect(page.getByRole('button', { name: '新建任务' }).first()).toBeVisible();

  await page.getByTestId('no-tasks').getByRole('button', { name: '新建任务' }).click();
  await page.getByRole('dialog', { name: '新建任务' }).getByLabel('标题').fill(TASK_TITLE);
  await page.getByRole('button', { name: '创建任务' }).click();
  await expect(taskNode(page, TASK_TITLE)).toContainText('0 个会话');

  // 第一条会话：保存成 profile。
  await taskNode(page, TASK_TITLE).getByRole('button', { name: '＋ 会话' }).click();
  const firstRun = page.getByRole('dialog', { name: '在哪台机器、哪个工作空间干活？' });
  await chooseWorkspace(page, firstRun);
  await chooseHubModel(firstRun);
  await firstRun.getByRole('button', { name: '开始' }).click();
  await expect(page.getByLabel('发送消息')).toBeVisible();

  await page.getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: /保存为 Agent 配置/ }).click();
  const saveDialog = page.getByRole('dialog', { name: '保存为 Agent 配置' });
  await saveDialog.getByLabel('名字').fill(PROFILE_NAME);
  await saveDialog.getByRole('button', { name: '保存' }).click();
  await expect(saveDialog).toHaveCount(0);

  // 管理页：改名，确认管理 UI 与派生下拉同步。
  await page.getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: /管理 Agent 配置/ }).click();
  const manage = page.getByRole('dialog', { name: 'Agent 配置' });
  const managedRow = manage.getByTestId('agent-profile-row').filter({ hasText: PROFILE_NAME });
  await expect(managedRow).toBeVisible();
  await managedRow.getByRole('button', { name: '编辑' }).click();
  await manage.getByLabel('名字').fill(`${PROFILE_NAME}-改`);
  await manage.getByRole('button', { name: '保存' }).click();
  await expect(manage.getByTestId('agent-profile-row').filter({ hasText: `${PROFILE_NAME}-改` })).toBeVisible();
  await page.keyboard.press('Escape');

  // 回画布，派生第二条会话并选 profile。
  await page.getByRole('button', { name: '画布', exact: true }).click();
  await taskNode(page, TASK_TITLE).getByRole('button', { name: '＋ 会话' }).click();
  const secondRun = page.getByRole('dialog', { name: '在哪台机器、哪个工作空间干活？' });
  await chooseWorkspace(page, secondRun);
  const profile = secondRun.getByLabel('Agent 配置（可留空）');
  const profileOption = profile.locator('option').filter({ hasText: `${PROFILE_NAME}-改` });
  await expect(profileOption).toHaveCount(1);
  const profileId = await profileOption.getAttribute('value');
  if (!profileId) throw new Error('Agent 配置没有 id');
  await profile.selectOption(profileId);
  await secondRun.getByRole('button', { name: '开始' }).click();
  await expect(page.getByLabel('发送消息')).toBeVisible();

  await page.getByRole('button', { name: '画布', exact: true }).click();
  await expect(sessionNode(page)).toHaveCount(2);

  const projectId = /#\/p\/([^/]+)/.exec(new URL(page.url()).hash)?.[1];
  if (!projectId) throw new Error('地址栏里没有项目 id');
  const response = await page.request.get(`/api/projects/${projectId}/canvas`);
  expect(response.ok()).toBeTruthy();
  const canvas = (await response.json()) as {
    sessions: Array<{ id: string; model: string; options: Record<string, string | boolean>; createdAt: number }>;
  };
  const sessions = [...canvas.sessions].sort((a, b) => a.createdAt - b.createdAt);
  expect(sessions).toHaveLength(2);
  expect(sessions[0]?.model).toBeTruthy();
  expect(sessions[1]?.model).toBe(sessions[0]?.model);
  expect(sessions[1]?.options).toMatchObject(sessions[0]?.options ?? {});
});
