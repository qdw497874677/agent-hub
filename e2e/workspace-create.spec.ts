import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { currentRun } from './run-id.ts';
import { loginByApi } from './login.ts';

const RUN = currentRun();
const NAME = `ws-create-${RUN}`;
const SHOTS = process.env['E2E_SCREENSHOTS'];

/**
 * 新建持久工作空间：和建项目一样必须选目录——同一个目录选择器（从托管目录起步、就地「新建文件夹」、手机全屏），
 * 选好的目录就是工作空间的位置。桌面和手机各走一遍（一条用例只登录一次）。
 */
test('新建持久工作空间：先选目录（可就地新建文件夹），没选「开始」是灰的；桌面 + 手机', async ({ page, baseURL }) => {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const made = await page.request.post('/api/projects', { data: { name: NAME }, headers });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string };
  const created: string[] = [];

  async function viaDialog(width: number, tag: string) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    const title = `选目录-${tag}`;
    const task = await page.request.post('/api/tasks', { data: { projectId: project.id, title }, headers });
    expect(task.ok(), await task.text()).toBe(true);
    await page.goto(`/#/p/${project.id}`);
    await page.locator('.react-flow__node-task').filter({ hasText: title }).getByRole('button', { name: '＋ 会话' }).click();
    const run = page.getByRole('dialog', { name: '在哪台机器、哪个工作空间干活？' });
    await run.getByRole('radio', { name: /新建持久工作空间/ }).click();
    const start = run.getByRole('button', { name: '开始' });
    await expect(start, '没选目录不能开始').toBeDisabled();

    // 选择器自动打开，起点是托管目录那一层
    const picker = page.getByLabel('目录选择器');
    await expect(picker).toBeVisible();
    const input = picker.getByLabel('路径');
    await expect(input).toHaveValue(/^\/tmp\//);
    const button = picker.getByRole('button', { name: '新建文件夹' });
    await expect(button).toBeInViewport();
    await button.click();
    const folder = `${tag}-${RUN}`;
    await picker.getByLabel('新文件夹名').fill(folder);
    await picker.getByLabel('新文件夹名').press('Enter');
    await expect(input).toHaveValue(new RegExp(`/${folder}/$`));
    const path = (await input.inputValue()).replace(/\/$/, '');
    created.push(path);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `workspace-create-picker-${tag}.png`) });
    await picker.getByRole('button', { name: '使用', exact: true }).click();

    await expect(run.getByText('新建持久工作空间', { exact: false }).last()).toBeVisible();
    await expect(run).toContainText(folder);
    await expect(start).toBeEnabled();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `workspace-create-ready-${tag}.png`) });
    await start.click();
    await expect(run).toHaveCount(0);

    const views = (await (await page.request.get(`/api/projects/${project.id}/workspaces`)).json()) as Array<{
      workspace: { path: string; kind: string; source: string };
    }>;
    const mine = views.find((view) => view.workspace.path === path);
    expect(mine, `工作空间就在选的目录：${path}`).toBeTruthy();
    expect(mine!.workspace.kind).toBe('long_lived');
    expect(mine!.workspace.source).toBe('created');
    expect(readdirSync(path).filter((entry) => !entry.startsWith('.'))).toEqual([]);
  }

  await test.step('桌面 1280', () => viaDialog(1280, 'desktop'));
  await test.step('手机 390', () => viaDialog(390, 'mobile'));

  // 选到有东西的目录：服务端拒（该走「选已有目录」）
  writeFileSync(join(created[0]!, 'a.txt'), 'x');
  const full = await page.request.post(`/api/projects/${project.id}/workspaces`, {
    data: { kind: 'long_lived', mode: 'create', path: created[0] },
    headers
  });
  expect(full.status()).toBe(409);

  const sessions = (await (await page.request.get(`/api/projects/${project.id}/canvas`)).json()) as { sessions?: Array<{ id: string }> };
  for (const session of sessions.sessions ?? []) await page.request.post(`/api/sessions/${session.id}/interrupt`, { data: {}, headers });
  await page.request.delete(`/api/projects/${project.id}`, { data: { confirmName: NAME }, headers });
  for (const path of created) if (existsSync(path)) rmSync(path, { recursive: true, force: true });
});
