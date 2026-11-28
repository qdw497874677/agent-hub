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

        let releaseDirectories!: () => void;
        const heldDirectories = new Promise<void>((resolve) => { releaseDirectories = resolve; });
        await page.route(`**/api/projects/${project.id}/workspaces`, async (route) => {
          await heldDirectories;
          await route.continue();
        }, { times: 1 });
        await page.goto(`/#/p/${project.id}/list`);
        const taskGroup = (scope: Locator, title: string) => scope.getByRole('region', { name: `任务：${title}`, exact: true });
        const groups = page.getByTestId('list-workspace-group');
        try {
          await expect(groups).toHaveCount(2);
          await expect(page.getByTestId('list-view').getByTestId('workdir-entry')).toHaveCount(0);
        } finally {
          releaseDirectories();
        }
        const row = (session: { id: string }) => page.locator(`[data-session-id="${session.id}"]`).getByTestId('list-session-row');
        const left = groups.filter({ hasText: leftPath });
        const right = groups.filter({ hasText: rightPath });
        const registeredDirs = page.getByTestId('list-view').getByRole('region', { name: '登记的工作目录' });
        for (const [workspace, path] of [[a, leftPath], [b, rightPath]] as const) {
          const entry = registeredDirs.locator(`[data-testid="workdir-entry"][data-workspace-id="${workspace.id}"]`);
          await expect(entry).toContainText('e2e 假 ACP 机器');
          await expect(entry.getByTestId('workdir-entry-path')).toHaveText(path);
        }
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
        const single = taskGroup(right, '同一任务');
        const groupTitle = single.getByRole('heading');
        await expect(groupTitle).toContainText('任务');
        await groupTitle.getByText('同一任务', { exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`/p/${project.id}/list$`));
        await expect(page.getByTestId('task-detail')).toHaveCount(0);
        const details = single.getByTestId('list-group-open');
        await expect(details).toContainText('任务详情');
        if (width < 640) expect((await details.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await details.click();
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
        await row(third).getByTestId('list-session-meta').click();
        await expect.poll(() => new URL(page.url()).hash).toBe(`#/p/${project.id}/focus/${third.id}`);
        await expect(page.getByLabel('发送消息')).toBeVisible();
        await expect(detail).toHaveCount(0);
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
        const sidebarDirs = nav.getByRole('region', { name: '登记的工作目录' });
        const sidebarEntry = (id: string) => sidebarDirs.locator(`[data-testid="workdir-entry-row"][data-workspace-id="${id}"]`);
        const focusHash = `#/p/${project.id}/focus/${third.id}`;
        // The deliberately long parent of `home` must not clip the basename on the right.
        const homeTail = sidebarDirs.getByTestId('workdir-entry-path-tail').filter({ hasText: /\/home$/ });
        await expect(homeTail).toBeVisible();
        const tailBounds = await homeTail.evaluate((viewport) => {
          const outer = viewport.getBoundingClientRect();
          const text = viewport.firstElementChild!.getBoundingClientRect();
          return { overflow: text.width - outer.width, rightOverflow: text.right - outer.right };
        });
        if (width >= 640) expect(tailBounds.overflow).toBeGreaterThan(0);
        expect(tailBounds.rightOverflow).toBeLessThanOrEqual(1);
        for (const [workspace, path, tail] of [[a, leftPath, 'left/shared'], [b, rightPath, 'right/shared']] as const) {
          const entry = sidebarEntry(workspace.id);
          const toggle = entry.getByTestId('workdir-entry-path-toggle');
          const fullPath = entry.getByTestId('workdir-entry-path');
          await expect(entry).toContainText('e2e 假 ACP 机器');
          await expect(entry).toContainText(tail);
          await expect(toggle).toHaveText('查看路径');
          await expect(toggle).toHaveAttribute('aria-expanded', 'false');
          await expect(fullPath).toBeHidden();
          if (width < 640) await toggle.tap();
          else { await toggle.focus(); await toggle.press('Enter'); }
          await expect(toggle).toHaveAttribute('aria-expanded', 'true');
          await expect(fullPath).toBeVisible();
          await expect(fullPath).toHaveText(path);
          expect(new URL(page.url()).hash).toBe(focusHash);
          if (workspace.id === a.id) await page.screenshot({ path: testInfo.outputPath(`sidebar-expanded-path-${width}.png`) });
          await toggle.click();
          await expect(fullPath).toBeHidden();
        }

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
        await row(first).getByTestId('list-session-label').click();
        await expect.poll(() => new URL(page.url()).hash).toBe(`#/p/${project.id}/focus/${first.id}`);
        if (width < 640) await page.getByRole('button', { name: '项目与全部会话' }).tap();
        const directory = sidebarEntry(b.id).getByTestId('workdir-entry');
        if (width < 640) await directory.tap();
        else await directory.click();
        await expect.poll(() => new URL(page.url()).hash).toBe(`#/p/${project.id}/workdir/${b.id}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}
