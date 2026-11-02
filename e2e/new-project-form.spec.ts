import { test, expect, type Page } from '@playwright/test';
import { currentRun } from './run-id.ts';
import { loginByApi } from './login.ts';

/**
 * 新建项目表单：第一行就是「项目名 + 创建」，说明紧跟其下；
 * 机器 / 目录 / git 仓库收在「放到某台机器上（可选）」里，默认收起、不替人选机器、不自动打开目录选择器。
 * 只填名字就能建（不带工作空间）。桌面 1280 和手机 390 都走一遍。
 */
const RUN = currentRun();
const SHOTS = process.env.SHOTS_DIR;

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 844 });
  await page.goto('/');
  await page.getByRole('navigation').getByTitle('新建项目').click();
  return page.getByLabel('新建项目');
}

for (const width of [1280, 390]) {
  test(`新建项目表单 ${width}px：默认收起、名字醒目、只填名字就能建`, async ({ page }) => {
    await loginByApi(page);
    const panel = await open(page, width);
    const name = panel.getByLabel('项目名');
    const toggle = panel.getByRole('button', { name: '放到某台机器上（可选）' });

    // 默认：收起、没有目录框、没有选择器、没有机器被选中
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(panel.getByLabel('目录', { exact: true })).toHaveCount(0);
    await expect(panel.getByLabel('git 仓库')).toHaveCount(0);
    await expect(page.getByLabel('目录选择器')).toHaveCount(0);
    await expect(panel.getByRole('radio', { checked: true })).toHaveCount(0);

    // 名字框占满第一行（除去「创建」按钮），说明在它正下方
    const panelBox = (await panel.boundingBox())!;
    const nameBox = (await name.boundingBox())!;
    const createBox = (await panel.getByRole('button', { name: '创建' }).boundingBox())!;
    expect(Math.abs(nameBox.y - createBox.y)).toBeLessThan(8);
    expect(nameBox.width).toBeGreaterThan(panelBox.width * 0.6);
    const descBox = (await panel.getByLabel('项目说明').boundingBox())!;
    expect(descBox.y).toBeGreaterThan(nameBox.y + nameBox.height - 1);
    expect(descBox.y).toBeLessThan(toggle ? (await toggle.boundingBox())!.y : Infinity);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${width}-collapsed.png`, fullPage: true });

    // 展开：出现目录 + 浏览 + git；选择器仍要点「浏览…」才开
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.getByLabel('目录', { exact: true })).toBeVisible();
    await expect(panel.getByLabel('git 仓库')).toBeVisible();
    await expect(page.getByLabel('目录选择器')).toHaveCount(0);
    await expect(panel.getByRole('radio', { checked: true })).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${width}-expanded.png`, fullPage: true });
    await panel.getByRole('button', { name: '浏览…' }).click();
    await expect(page.getByLabel('目录选择器')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${width}-browsing.png`, fullPage: true });
    // 手机上选择器全屏盖住表单，用它自己的「关闭」；桌面上点「收起」
    if (width < 768) await page.getByLabel('目录选择器').getByRole('button', { name: '关闭' }).click();
    else await panel.getByRole('button', { name: '收起' }).click();
    await expect(page.getByLabel('目录选择器')).toHaveCount(0);
    await toggle.click();

    // 只填名字 → 建成，进到项目画布；服务端记录里没有工作空间目录
    const projectName = `e2e-form-${width}-${RUN}`;
    await name.fill(projectName);
    const created = page.waitForResponse((r) => r.url().endsWith('/api/projects') && r.request().method() === 'POST');
    await name.press('Enter');
    const response = await created;
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as { rootPath?: string | null; name: string };
    expect(body.name).toBe(projectName);
    expect(body.rootPath ?? null).toBeNull();
    await expect(page.getByRole('button', { name: '新建任务' }).first()).toBeVisible();
  });
}
