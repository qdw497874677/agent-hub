import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { loginByApi } from './login.ts';

for (const width of [1280, 390]) {
  const touch = width < 640;
  test.describe(`会话页与画布 ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: touch, isMobile: touch });

    test('两处使用相同的目录内会话切换，慢记录不会错写草稿', async ({ page, baseURL }, testInfo) => {
      const dir = mkdtempSync(join(tmpdir(), 'session-surface-'));
      const origin = baseURL!;
      const draft = '只属于当前会话的草稿';
      let release!: () => void;
      const held = new Promise<void>((done) => { release = done; });
      try {
        await loginByApi(page);
        const workerId = await ensureFakeWorker(page, origin);
        const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
        const headers = { origin, 'x-hub-csrf': csrf };
        const post = async <T>(url: string, data: unknown, status = 201): Promise<T> => {
          const response = await page.request.post(url, { headers, data });
          expect(response.status(), await response.text()).toBe(status);
          return await response.json() as T;
        };
        const project = await post<{ id: string }>('/api/projects', { name: `会话切换-${width}-${Date.now()}` });
        const task = await post<{ id: string }>('/api/tasks', { projectId: project.id, title: '同一任务也可以使用不同目录' });
        const link = async (parent: string) => {
          const path = join(dir, parent, 'same-name');
          mkdirSync(path, { recursive: true });
          return await post<{ id: string }>(`/api/projects/${project.id}/workspaces`, { workerId, kind: 'long_lived', mode: 'link', path });
        };
        const workspace = await link('a');
        const other = await link('b');
        const start = (workspaceId: string) => post<{ id: string }>('/api/sessions/derive', { taskId: task.id, workerId, workspaceId, agentId: FAKE_AGENT_ID, model: '' });
        const a = await start(workspace.id);
        const b = await start(workspace.id);
        const excluded = await start(other.id);
        await post(`/api/sessions/${a.id}/prompt`, { text: '会话 A 的记录' }, 202);

        const item = (scope: Locator, id: string) => scope.locator(`:is([data-testid="session-tab-item"], [data-testid="session-tab-open-existing"])[data-session-id="${id}"]`);
        const options = async (scope: Locator, active: string, count: number) => {
          const trigger = scope.getByTestId('session-tab-trigger');
          await expect(trigger).toHaveAccessibleName(new RegExp(`切换标签.*${count}`));
          const bounds = (await trigger.boundingBox())!;
          if (touch) { expect(bounds.width).toBeGreaterThanOrEqual(44); expect(bounds.height).toBeGreaterThanOrEqual(44); }
          await trigger.click();
          const picker = page.getByTestId('session-tab-picker');
          await expect(picker).toBeVisible();
          await expect(picker.getByTestId('session-tab-item')).toHaveCount(count);
          await expect(picker.getByTestId('session-tab-open-existing')).toHaveCount(2 - count);
          await expect(item(picker, active)).toHaveAttribute('aria-current', /true|page/);
          await expect(item(picker, excluded.id)).toHaveCount(0);
          return picker;
        };

        await page.goto(`/#/p/${project.id}/focus/${a.id}`);
        await expect(page.getByTestId('focus-header')).toBeVisible();
        await expect(page.getByTestId('msg-user').filter({ hasText: '会话 A 的记录' })).toBeVisible();
        await page.getByRole('textbox', { name: '发送消息' }).fill(draft);
        await page.screenshot({ path: testInfo.outputPath(`session-standalone-${width}.png`) });

        let requests = 0;
        await page.route(`**/api/sessions/${b.id}/events`, async (route) => {
          requests++;
          await held;
          await route.continue();
        });
        await item(await options(page.locator('body'), a.id, 1), b.id).click();
        await expect(page).toHaveURL(new RegExp(`/focus/${b.id}$`));
        await expect.poll(() => requests).toBeGreaterThan(0);
        await expect(page.getByTestId('session-history-state')).toContainText('正在读取会话记录');
        await expect(page.getByRole('textbox', { name: '发送消息' })).toHaveValue('');
        await expect(page.getByRole('log', { name: '会话记录' }).getByTestId('msg-user').filter({ hasText: '会话 A 的记录' })).toHaveCount(0);
        release();
        await expect(page.getByTestId('session-history-state')).toHaveCount(0);
        await item(await options(page.locator('body'), b.id, 2), a.id).click();
        await expect(page.getByRole('textbox', { name: '发送消息' })).toHaveValue(draft);

        // 只换同一运行中的 hash，不重新载入文档或伪造一份草稿。
        await page.evaluate((hash) => { window.location.hash = hash; }, `#/p/${project.id}/canvas`);
        await page.locator(`.react-flow__node-session[data-id="${a.id}"]`).getByRole('button', { name: '在画布中展开' }).click();
        let window = page.locator(`[data-testid="canvas-window"][data-session-id="${a.id}"]`);
        await expect(window.getByRole('textbox', { name: '发送消息' })).toHaveValue(draft);
        await expect(window.getByTestId('msg-user').filter({ hasText: '会话 A 的记录' })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`session-canvas-${width}.png`) });
        await item(await options(window, a.id, 1), b.id).click();
        window = page.locator(`[data-testid="canvas-window"][data-session-id="${b.id}"]`);
        await expect(window).toBeVisible();
        await expect(page).toHaveURL(/\/canvas$/);
        await expect(window.getByRole('textbox', { name: '发送消息' })).toHaveValue('');
        await item(await options(window, b.id, 2), a.id).click();
        await expect(page.locator(`[data-testid="canvas-window"][data-session-id="${a.id}"]`).getByRole('textbox', { name: '发送消息' })).toHaveValue(draft);
      } finally {
        release();
        stopFakeWorker();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
