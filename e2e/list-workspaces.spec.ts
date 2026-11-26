import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { loginByApi } from './login.ts';

test.afterAll(() => stopFakeWorker());

for (const width of [1280, 320]) {
  test.describe(`${width}px`, () => {
    if (width < 640) test.use({ isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

    test('列表与导航都先按工作空间分组，再按会话所属任务展示', async ({ page, baseURL }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      await loginByApi(page);
      const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
      const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
      const workerId = await ensureFakeWorker(page, baseURL!);
      const root = mkdtempSync(join(tmpdir(), 'e2e-workspace-groups-'));
      try {
        const post = async <T>(url: string, data: object): Promise<T> => {
          const response = await page.request.post(url, { headers, data });
          expect(response.ok(), await response.text()).toBe(true);
          return response.json();
        };
        const id = () => `${width}-${Date.now()}`;
        const home = join(root, 'home');
        mkdirSync(home);
        const project = await post<{ id: string }>('/api/projects', { name: `工作空间分组-${id()}`, rootPath: home, workerId });
        const task = await post<{ id: string }>('/api/tasks', { projectId: project.id, title: '同一任务' });
        const link = async (path: string) => {
          mkdirSync(path, { recursive: true });
          return post<{ id: string }>(`/api/projects/${project.id}/workspaces`, { kind: 'long_lived', mode: 'link', path, workerId });
        };
        const leftPath = join(root, 'left', 'shared');
        const rightPath = join(root, 'right', 'shared');
        const a = await link(leftPath);
        const b = await link(rightPath);
        const other = await post<{ id: string }>('/api/tasks', { projectId: project.id, title: '另一个任务' });
        const unstartedTitle = '还没有会话的任务';
        await post('/api/tasks', { projectId: project.id, title: unstartedTitle });
        const derive = (taskId: string, workspaceId: string) => post<{ id: string }>('/api/sessions/derive', { taskId, workspaceId, workerId, agentId: FAKE_AGENT_ID, model: '' });
        const first = await derive(task.id, a.id);
        const second = await derive(task.id, a.id);
        const third = await derive(task.id, b.id);
        const fourth = await derive(other.id, a.id);

        await page.goto(`/#/p/${project.id}/list`);
        const taskGroup = (scope: Locator, title: string) => scope.getByRole('region', { name: `任务：${title}`, exact: true });
        const groups = page.getByTestId('list-workspace-group');
        await expect(groups).toHaveCount(2);
        const row = (session: { id: string }) => page.locator(`[data-session-id="${session.id}"]`).getByTestId('list-session-row');
        const left = groups.filter({ hasText: leftPath });
        const right = groups.filter({ hasText: rightPath });
        await expect(left.getByTestId('list-session-row')).toHaveCount(3);
        await expect(right.getByTestId('list-session-row')).toHaveCount(1);
        await expect(taskGroup(left, '同一任务').getByTestId('list-session-row')).toHaveCount(2);
        await expect(taskGroup(right, '同一任务').getByTestId('list-session-row')).toHaveCount(1);
        await expect(taskGroup(left, '另一个任务').getByTestId('list-session-row')).toHaveCount(1);
        await expect(groups.getByText(unstartedTitle, { exact: true })).toHaveCount(0);
        await expect(page.getByTestId('list-unstarted')).toContainText(unstartedTitle);
        const leftToggle = left.getByTestId('list-workspace-toggle');
        await expect(leftToggle).toBeVisible();
        await expect(leftToggle).toContainText(leftPath);
        await expect(right.getByTestId('list-workspace-toggle')).toContainText(rightPath);
        await expect(row(second)).toBeVisible();
        const rowBox = (await row(second).boundingBox())!;
        expect(rowBox.height).toBeGreaterThanOrEqual(44);
        expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(width);
        await page.screenshot({ path: testInfo.outputPath(`list-workspaces-${width}.png`) });
        await taskGroup(left, '同一任务').getByTestId('list-group-open').click();
        const detail = page.getByTestId('task-detail');
        for (const session of [first, second, third]) {
          await expect(detail.getByRole('button', { name: `${FAKE_AGENT_ID} · ${session.id.slice(0, 6)}`, exact: true })).toBeVisible();
        }
        await expect(detail.getByRole('button', { name: `${FAKE_AGENT_ID} · ${fourth.id.slice(0, 6)}`, exact: true })).toHaveCount(0);
        await detail.getByRole('button', { name: '关闭' }).click();
        if (width < 640) await leftToggle.tap();
        else { await leftToggle.focus(); await page.keyboard.press('Enter'); }
        await expect(leftToggle).toHaveAttribute('aria-expanded', 'false');
        await expect(row(first)).toHaveCount(0);
        await expect(row(third)).toBeVisible();
        await expect(row(fourth)).toHaveCount(0);
        await row(third).click();
        await expect.poll(() => new URL(page.url()).hash).toBe(`#/p/${project.id}/focus/${third.id}`);
        if (width < 640) await page.getByRole('button', { name: '项目与全部会话' }).tap();
        const nav = width < 640 ? page.getByTestId('nav-sheet') : page.getByTestId('project-sidebar');
        const navGroups = nav.getByTestId('sidebar-workspace-group');
        await expect(navGroups).toHaveCount(2);
        const navLeft = navGroups.filter({ hasText: leftPath });
        const navRight = navGroups.filter({ hasText: rightPath });
        await expect(navLeft.getByTestId('sidebar-workspace-toggle')).toContainText(leftPath);
        await expect(navRight.getByTestId('sidebar-workspace-toggle')).toContainText(rightPath);
        for (const [group, path] of [[navLeft, leftPath], [navRight, rightPath]] as const) {
          const pathLabel = group.getByTestId('sidebar-workspace-toggle').getByText(path, { exact: true });
          await expect.poll(() => pathLabel.evaluate((node) => node.getBoundingClientRect().width), {
            message: '侧栏路径有空间显示不同的末尾，不能只显示两个同名工作空间'
          }).toBeGreaterThanOrEqual(64);
        }
        await expect(navLeft.getByTestId('sidebar-session-row')).toHaveCount(3);
        await expect(navRight.locator(`[data-testid="sidebar-session-row"][data-session-id="${third.id}"] [aria-current="page"]`)).toBeVisible();
        await expect(navLeft.getByRole('button', { name: '为同一任务开始会话' })).toBeVisible();
        await expect(navRight.getByRole('button', { name: '为同一任务开始会话' })).toBeVisible();
        await expect(navGroups.getByText(unstartedTitle, { exact: true })).toHaveCount(0);
        await expect(nav.getByRole('button', { name: `为${unstartedTitle}开始会话` })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`sidebar-workspaces-${width}.png`) });

        if (width < 640) {
          const navLeftToggle = navLeft.getByTestId('sidebar-workspace-toggle');
          const navRightToggle = navRight.getByTestId('sidebar-workspace-toggle');
          await navLeftToggle.tap();
          await navRightToggle.tap();
          await expect(navRightToggle).toHaveAttribute('aria-expanded', 'false');
          await nav.getByRole('button', { name: '关闭侧栏' }).tap();
          await page.getByRole('button', { name: '项目与全部会话' }).tap();
          await expect(navRightToggle).toHaveAttribute('aria-expanded', 'true');
          await expect(navRight.locator(`[data-testid="sidebar-session-row"][data-session-id="${third.id}"] [aria-current="page"]`)).toBeVisible();
          await expect(navLeftToggle).toHaveAttribute('aria-expanded', 'false');
          await nav.getByRole('button', { name: '关闭侧栏' }).tap();
        }
        await page.goBack();
        await expect(leftToggle).toHaveAttribute('aria-expanded', 'false');
        await leftToggle.click();
        await expect(row(first)).toBeVisible();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}
