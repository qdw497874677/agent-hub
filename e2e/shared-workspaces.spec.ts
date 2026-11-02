import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, expect, type Page } from '@playwright/test';
import { currentRun } from './run-id.ts';
import { loginByApi } from './login.ts';

/**
 * 共享工作空间（ADR 0026）：团队页建一个不关联的工作空间 → 项目设置里关联 → 另一个项目开始任务时
 * 只列已关联的、没有就给「🔗 关联工作空间…」入口，关联完直接选中。桌面 1280 + 手机 390。
 */
const RUN = currentRun();
const SHOTS = process.env.SHOTS_DIR;

async function csrfHeaders(page: Page, baseURL: string) {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  return { origin: baseURL, 'x-hub-csrf': csrf };
}

test('团队工作空间：新建 → 项目关联 → 开始任务只列已关联的，可就地关联', async ({ page, baseURL }) => {
  await loginByApi(page);
  const headers = await csrfHeaders(page, baseURL!);
  const dir = join(tmpdir(), `shared-ws-${RUN}`);
  mkdirSync(dir, { recursive: true });
  const mk = async (name: string) => {
    const made = await page.request.post('/api/projects', { data: { name }, headers });
    expect(made.status(), await made.text()).toBe(201);
    return (await made.json()) as { id: string; name: string };
  };
  const a = await mk(`shared-a-${RUN}`);
  const b = await mk(`shared-b-${RUN}`);
  const made = await page.request.post('/api/workspaces', { data: { mode: 'link', path: dir }, headers });
  expect(made.status(), await made.text()).toBeLessThan(300);
  const ws = (await made.json()) as { id: string; projectId: string | null; teamId: string | null };
  expect(ws.projectId).toBeNull();
  expect(ws.teamId).not.toBeNull();

  try {
    // 首页「工作空间」入口 → 团队页，未关联
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await page.getByTestId('nav-workspaces').click();
    await expect(page.getByRole('heading', { name: '团队工作空间' })).toBeVisible();
    const row = page.getByTestId('team-ws-row').filter({ hasText: `shared-ws-${RUN}` });
    await expect(row).toContainText('未关联项目');
    await expect(page.getByTestId('team-ws-new')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/1280-team-unlinked.png`, fullPage: true });

    // 项目 A 设置里关联
    await page.goto(`/#/p/${a.id}`);
    await page.getByTitle('项目设置').first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByTestId('ws-link-open').click();
    const pick = dialog.getByTestId('ws-link').locator('li').filter({ hasText: `shared-ws-${RUN}` });
    await pick.getByTestId('ws-link-one').click();
    await expect(dialog.getByText(dir.split('/').pop()!).first()).toBeVisible();
    await expect(dialog.getByRole('button', { name: '取消关联' }).first()).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/1280-project-linked.png`, fullPage: true });
    const viewsA = (await (await page.request.get(`/api/projects/${a.id}/workspaces`)).json()) as Array<{ workspace: { id: string } }>;
    expect(viewsA.map((v) => v.workspace.id)).toContain(ws.id);

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
      // 每种宽度都从「B 没关联」开始
      await page.request.delete(`/api/projects/${b.id}/workspaces/${ws.id}`, { headers });
      // 项目 B：开始任务时没有已关联的 → 空提示 + 关联入口
      const title = `共享-${width}`;
      const task = await page.request.post('/api/tasks', { data: { projectId: b.id, title }, headers });
      expect(task.ok(), await task.text()).toBe(true);
      await page.goto(`/#/p/${b.id}`);
      await page.reload();
      await page.locator('.react-flow__node-task').filter({ hasText: title }).getByRole('button', { name: '＋ 会话' }).click();
      const run = page.getByRole('dialog', { name: '在哪台机器、哪个工作空间干活？' });
      {
        await expect(run.getByTestId('ws-none-linked')).toBeVisible();
        await expect(run.getByRole('radio', { name: new RegExp(`shared-ws-${RUN}`) })).toHaveCount(0);
        await run.getByTestId('ws-link-open').click();
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/${width}-picker-link.png`, fullPage: true });
        await run.getByTestId('ws-link').locator('li').filter({ hasText: `shared-ws-${RUN}` }).getByTestId('ws-link-one').click();
      }
      const radio = run.getByRole('radio', { name: new RegExp(`shared-ws-${RUN}`) });
      await expect(radio).toHaveAttribute('aria-checked', 'true');
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${width}-picker-linked.png`, fullPage: true });
      await page.keyboard.press('Escape');

      // 团队页：两个项目都在
      await page.goto('/#/workspaces');
      await page.reload();
      const shared = page.getByTestId('team-ws-row').filter({ hasText: `shared-ws-${RUN}` });
      await expect(shared).toContainText(a.name);
      await expect(shared).toContainText(b.name);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${width}-team-shared.png`, fullPage: true });
    }

    // 取消关联只影响本项目
    const unlinked = await page.request.delete(`/api/projects/${a.id}/workspaces/${ws.id}`, { headers });
    expect(unlinked.ok(), await unlinked.text()).toBe(true);
    const afterA = (await (await page.request.get(`/api/projects/${a.id}/workspaces`)).json()) as Array<{ workspace: { id: string } }>;
    const afterB = (await (await page.request.get(`/api/projects/${b.id}/workspaces`)).json()) as Array<{ workspace: { id: string } }>;
    expect(afterA.map((v) => v.workspace.id)).not.toContain(ws.id);
    expect(afterB.map((v) => v.workspace.id)).toContain(ws.id);
  } finally {
    await page.request.post(`/api/workspaces/${ws.id}/remove`, { data: { deleteDirectory: false, force: false }, headers });
    for (const p of [a, b]) await page.request.delete(`/api/projects/${p.id}`, { data: { confirmName: p.name }, headers });
    rmSync(dir, { recursive: true, force: true });
  }
});
