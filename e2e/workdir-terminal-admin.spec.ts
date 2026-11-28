import { expect, test } from '@playwright/test';
import { loginByApi } from './login.ts';

const endpoint = '/api/admin/workdir-terminal-settings';

for (const width of [1280, 390]) {
  test.describe(`终端管理 ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390 });

    test('普通部署不可修改；受保护入口的授权、停开新建和丢回执交互', async ({ page, baseURL }) => {
      await loginByApi(page);
      await page.goto('/#/admin/overview');
      const settings = page.getByTestId('workdir-terminal-settings');
      await expect(settings).toContainText('需要受保护的连接');
      await expect(settings.getByRole('switch')).toHaveCount(0);
      const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value;
      expect(csrf).toBeTruthy();
      const denied = await page.request.put(endpoint, { headers: { origin: baseURL!, 'x-hub-csrf': csrf! }, data: { action: 'set-enabled', enabled: true } });
      expect(denied.status()).toBe(403);

      // Only the management DTO is simulated for presentation coverage. The unprotected
      // response and rejection above come from the actual Hub on this isolated deployment.
      let enabled = false;
      let grants: { userId: string; workerId: string }[] = [];
      let reads = 0;
      const writes: unknown[] = [];
      const snapshot = () => ({ mode: 'managed', enabled, canEnable: true, blockedReason: null,
        users: [{ id: 'person', label: '测试人员' }], workers: [{ id: 'machine', label: '测试机器' }], grants });
      await page.route(`**${endpoint}`, async (route) => {
        if (route.request().method() === 'GET') { reads++; return route.fulfill({ json: snapshot() }); }
        const action = route.request().postDataJSON() as { action: string; enabled?: boolean; userId?: string; workerId?: string };
        writes.push(action);
        if (action.action === 'grant') grants = [{ userId: action.userId!, workerId: action.workerId! }];
        else if (action.action === 'revoke') grants = [];
        else if (action.action === 'set-enabled') enabled = action.enabled === true;
        // The server applied this write; the browser lost the response and must only read back.
        if (action.action === 'grant') return route.abort('connectionreset');
        return route.fulfill({ json: snapshot() });
      });
      await page.reload();
      const worker = settings.getByTestId('workdir-terminal-worker');
      const user = settings.getByTestId('workdir-terminal-user');
      const grant = settings.getByTestId('workdir-terminal-grant');
      const toggle = settings.getByTestId('workdir-terminal-enabled');
      await expect(toggle).not.toBeChecked();
      await expect(grant).toBeDisabled();
      await user.selectOption('person');
      await worker.selectOption('machine');
      await grant.click();
      const row = settings.getByTestId('workdir-terminal-grant-row');
      await expect(row).toContainText('测试人员');
      await expect(row).toContainText('测试机器');
      await expect(settings).toContainText('保存未确认，已重新读取当前设置');
      expect(writes).toEqual([{ action: 'grant', userId: 'person', workerId: 'machine' }]);
      expect(reads).toBeGreaterThanOrEqual(2);

      page.once('dialog', (dialog) => dialog.accept());
      await toggle.click();
      await expect(toggle).toBeChecked();
      await toggle.click();
      await expect(toggle).not.toBeChecked();
      await expect(row).toHaveCount(1);
      page.once('dialog', (dialog) => dialog.accept());
      await row.getByRole('button', { name: /撤销/ }).click();
      await expect(row).toHaveCount(0);
      await expect(settings).toContainText('暂无授权');
      expect(writes).toEqual([
        { action: 'grant', userId: 'person', workerId: 'machine' }, { action: 'set-enabled', enabled: true },
        { action: 'set-enabled', enabled: false }, { action: 'revoke', userId: 'person', workerId: 'machine' }
      ]);
    });
  });
}
