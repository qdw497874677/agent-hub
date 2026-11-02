import { test, expect, type Page } from '@playwright/test';
import { currentRun } from './run-id.ts';
import { loginByApi } from './login.ts';

/**
 * 新建项目表单：项目只是 hub 里的一条记录，不绑机器——表单里只有项目名、说明，和收起的「git 仓库（可选）」。
 * 没有机器选择、没有目录框、没有目录选择器；工作空间在开始任务时再选。桌面 1280 和手机 390 都走一遍。
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
  test(`新建项目表单 ${width}px：只有名字 / 说明 / 可选 git，只填名字就能建`, async ({ page }) => {
    await loginByApi(page);
    const panel = await open(page, width);
    const name = panel.getByLabel('项目名');
    const git = panel.getByRole('button', { name: 'git 仓库（可选）' });

    // 没有机器、目录、浏览、选择器；git 默认收起
    await expect(panel.getByLabel('目录', { exact: true })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: '浏览…' })).toHaveCount(0);
    await expect(panel.getByRole('radio')).toHaveCount(0);
    await expect(page.getByLabel('目录选择器')).toHaveCount(0);
    await expect(panel.getByText(/放到某台机器上/)).toHaveCount(0);
    await expect(git).toHaveAttribute('aria-expanded', 'false');
    await expect(panel.getByLabel('git 仓库', { exact: true })).toHaveCount(0);

    // 名字框占满第一行（除去「创建」），说明在它正下方
    const panelBox = (await panel.boundingBox())!;
    const nameBox = (await name.boundingBox())!;
    const createBox = (await panel.getByRole('button', { name: '创建' }).boundingBox())!;
    expect(Math.abs(nameBox.y - createBox.y)).toBeLessThan(8);
    expect(nameBox.width).toBeGreaterThan(panelBox.width * 0.6);
    const descBox = (await panel.getByLabel('项目说明').boundingBox())!;
    expect(descBox.y).toBeGreaterThan(nameBox.y + nameBox.height - 1);
    expect(descBox.y).toBeLessThan((await git.boundingBox())!.y);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${width}-collapsed.png`, fullPage: true });

    // 展开 git：仓库 + 默认分支（没填仓库时分支是灰的）；仍然没有目录 / 机器
    await git.click();
    await expect(git).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.getByLabel('git 仓库', { exact: true })).toBeVisible();
    await expect(panel.getByLabel('默认分支')).toBeDisabled();
    await expect(panel.getByLabel('目录', { exact: true })).toHaveCount(0);
    await expect(panel.getByRole('radio')).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${width}-expanded.png`, fullPage: true });
    await git.click();

    // 只填名字 → 建成，没有工作空间
    const projectName = `e2e-form-${width}-${RUN}`;
    await name.fill(projectName);
    const created = page.waitForResponse((r) => r.url().endsWith('/api/projects') && r.request().method() === 'POST');
    await name.press('Enter');
    const response = await created;
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as { id: string; name: string; rootPath?: string | null };
    expect(body.name).toBe(projectName);
    expect(body.rootPath ?? null).toBeNull();
    const request = response.request().postDataJSON() as Record<string, unknown>;
    expect(request).not.toHaveProperty('rootPath');
    expect(request).not.toHaveProperty('workerId');
    const workspaces = (await (await page.request.get(`/api/projects/${body.id}/workspaces`)).json()) as unknown[];
    expect(workspaces).toEqual([]);
    await expect(page.getByRole('button', { name: '新建任务' }).first()).toBeVisible();
  });
}

test('新建项目：填了 git 仓库和默认分支就带上', async ({ page }) => {
  await loginByApi(page);
  const panel = await open(page, 1280);
  await panel.getByLabel('项目名').fill(`e2e-form-git-${RUN}`);
  await panel.getByRole('button', { name: 'git 仓库（可选）' }).click();
  await panel.getByLabel('git 仓库', { exact: true }).fill('https://example.com/acme/demo.git');
  await panel.getByLabel('默认分支').fill('main');
  const created = page.waitForResponse((r) => r.url().endsWith('/api/projects') && r.request().method() === 'POST');
  await panel.getByRole('button', { name: '创建' }).click();
  const response = await created;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON()).toMatchObject({ repoUrl: 'https://example.com/acme/demo.git', defaultBranch: 'main' });
});
