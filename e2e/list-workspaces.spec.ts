import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { loginByApi } from './login.ts';

test.afterAll(() => stopFakeWorker());

for (const width of [1280, 320]) {
  test.describe(`${width}px`, () => {
    if (width < 640) test.use({ isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

    test('同一任务中的工作空间独立展开，会话返回后记住状态', async ({ page, baseURL }, testInfo) => {
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
        const a = await link(join(root, 'left', 'shared'));
        const b = await link(join(root, 'right', 'shared'));
        const other = await post<{ id: string }>('/api/tasks', { projectId: project.id, title: '另一个任务' });
        const derive = (taskId: string, workspaceId: string) => post<{ id: string }>('/api/sessions/derive', { taskId, workspaceId, workerId, agentId: FAKE_AGENT_ID, model: '' });
        const first = await derive(task.id, a.id);
        const second = await derive(task.id, a.id);
        const third = await derive(task.id, b.id);
        const fourth = await derive(other.id, a.id);

        await page.goto(`/#/p/${project.id}/list`);
        const taskRegion = page.getByRole('region', { name: '任务：同一任务', exact: true });
        const otherRegion = page.getByRole('region', { name: '任务：另一个任务', exact: true });
        const groups = taskRegion.getByTestId('list-workspace-group');
        await expect(groups).toHaveCount(2);
        const row = (session: { id: string }) => page.locator(`[data-session-id="${session.id}"]`).getByTestId('list-session-row');
        const left = groups.filter({ has: row(first) });
        const right = groups.filter({ has: row(third) });
        await expect(left.getByTestId('list-session-row')).toHaveCount(2);
        await expect(left).toContainText('2 条');
        await expect(right.getByTestId('list-session-row')).toHaveCount(1);
        await expect(otherRegion.getByTestId('list-session-row')).toHaveCount(1);
        const leftKey = (await left.getAttribute('data-workspace-key'))!;
        const leftToggle = taskRegion.locator(`[data-testid="list-workspace-group"][data-workspace-key=${JSON.stringify(leftKey)}]`).getByTestId('list-workspace-toggle');
        await expect(leftToggle).toBeVisible();
        await expect(row(second)).toBeVisible();
        const rowBox = (await row(second).boundingBox())!;
        expect(rowBox.height).toBeGreaterThanOrEqual(44);
        expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(width);
        await page.screenshot({ path: testInfo.outputPath(`list-workspaces-${width}.png`) });
        if (width < 640) await leftToggle.tap();
        else { await leftToggle.focus(); await page.keyboard.press('Enter'); }
        await expect(leftToggle).toHaveAttribute('aria-expanded', 'false');
        await expect(row(first)).toHaveCount(0);
        await expect(row(third)).toBeVisible();
        await expect(row(fourth)).toBeVisible();
        await row(third).click();
        await expect.poll(() => new URL(page.url()).hash).toBe(`#/p/${project.id}/focus/${third.id}`);
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
