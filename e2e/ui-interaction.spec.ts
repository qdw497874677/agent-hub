/**
 * 交互回归（UI 审计 P0）：
 * - 派生对话框：模型框显示的东西和真正的状态一致——不替人选模型，也不显示一个「看起来选了、其实没选」的模型。
 *   这条测试故意 **不** 去重新选模型（老的 worktree.spec 之所以没发现，就是因为它先选了一遍）。
 * - 模态框焦点：打开时焦点进框，Tab 不出框，Esc 关掉，焦点还给打开它的按钮。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { chooseHubModel, e2eHubModel } from './hub-model.ts';

async function setup(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  const dir = mkdtempSync(join(tmpdir(), 'e2e-ui-interaction-'));
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 交互 ${Date.now().toString(36)}`, rootPath: dir }, headers })).json()) as { id: string };
  await page.request.post('/api/tasks', { data: { projectId: project.id, title: '交互回归' }, headers });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/p/${project.id}/canvas`);
  const plus = page.locator('.react-flow__node-task').filter({ hasText: '交互回归' }).getByRole('button', { name: '＋ 会话' });
  await expect(plus).toBeVisible();
  return plus;
}

const inDialog = (page: Page) => page.evaluate(() => (document.activeElement?.closest('[role="dialog"]') ?? null) !== null);

test('模态框：焦点进框、Tab 不出框、Esc 关掉、焦点回到「＋ 会话」', async ({ page, baseURL }) => {
  const plus = await setup(page, baseURL ?? '');
  await plus.click();
  const dialog = page.getByRole('dialog', { name: '开始会话' });
  await expect(dialog).toBeVisible();
  await expect.poll(() => inDialog(page)).toBe(true);
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press(i % 7 === 6 ? 'Shift+Tab' : 'Tab');
    expect(await inDialog(page), `第 ${i + 1} 下 Tab 焦点跑出了对话框`).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(plus).toBeFocused();
});

test('派生对话框：不重新选模型，模型框显示与「开始」是否可用一致', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  const plus = await setup(page, baseURL ?? '');
  await plus.click();
  const dialog = page.getByRole('dialog', { name: '开始会话' });
  await expect(dialog).toBeVisible();
  // 选好目录，剩下唯一可能缺的就是模型
  await dialog.getByRole('radio', { name: /新建临时工作目录/ }).click();
  const model = dialog.locator('#derive-model');
  await expect(model).toBeVisible();
  // 模型框是统一的选择器按钮：aria-label 写「模型：<当前值或占位>」
  const start = dialog.getByRole('button', { name: '开始', exact: true });
  await page.waitForTimeout(1_000); // 机器 / 模型列表落定
  const shown = ((await model.getAttribute('aria-label')) ?? '').replace(/^模型：/, '');
  const value = shown === '默认' || shown === '选择模型…' || shown === '用 agent 自己的默认' ? '' : shown;
  if (await start.isDisabled()) {
    // 不能开始时，模型框不能显示一个真模型（审计 P0-1：显示 glm-5.3-flash，状态却是空）
    expect(value, `「开始」不可用，模型框却显示「${shown}」`).toBe('');
    await expect(dialog.getByTestId('derive-start-hint')).toBeVisible();
  } else {
    expect(shown).not.toBe('');
  }
  if (value === '' && e2eHubModel()) {
    await expect(dialog.getByTestId('derive-start-hint')).toContainText('Hub 模型');
    await chooseHubModel(dialog);
    await expect(start).toBeEnabled();
  }
});
