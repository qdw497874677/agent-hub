import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';

/** Bot 页「连接器」：关联项目 + 定时触发 建 / 太短被拒 / 暂停恢复 / 删除；390 / 1280。 */
const SHOTS = process.env['CONN_SHOTS_DIR'] ?? 'test-results/connectors';
mkdirSync(SHOTS, { recursive: true });

for (const width of [390, 1280]) {
  test(`连接器：关联项目、建定时、5 分钟以下被拒、暂停恢复、删除（${width}px）`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await loginByApi(page);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
    const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
    const mk = async (name: string) => {
      const r = await page.request.post('/api/projects', { headers, data: { name, rootPath: mkdtempSync(join(tmpdir(), 'e2e-conn-')) } });
      expect(r.ok(), await r.text()).toBe(true);
      return ((await r.json()) as { id: string }).id;
    };
    const tag = Date.now().toString(36);
    const project = await mk(`e2e conn ${tag}`);
    await mk(`e2e conn other ${tag}`);
    expect((await page.request.post(`/api/projects/${project}/agents`, { headers, data: { name: 'router', displayName: '总管', agentId: 'pi', description: '拆任务' } })).ok()).toBe(true);

    // 太短的间隔接口直接拒
    const bad = await page.request.post(`/api/projects/${project}/agents/router/bindings`, { headers, data: { connector: 'timer', kind: 'tick', name: 'x', params: { everyMin: 1, prompt: 'hi' } } });
    expect(bad.status()).toBe(400);

    await page.goto(`/#/bots/${project}`);
    const bot = page.locator('[data-testid="bot-item"][data-name="router"]');
    const conn = bot.getByTestId('bot-connectors');
    await expect(conn).toBeVisible();
    // 默认项目锁定；关联另一个
    await expect(conn.locator('[data-testid="agent-project"][data-on="1"]')).toHaveCount(1);
    await conn.locator('[data-testid="agent-project"][data-on="0"]', { hasText: `other ${tag}` }).click();
    await expect(conn.locator('[data-testid="agent-project"][data-on="1"]')).toHaveCount(2);

    await conn.getByTestId('trigger-new').click();
    await conn.getByTestId('timer-name').fill('巡检');
    await conn.getByTestId('timer-every').fill('3');
    await conn.getByTestId('timer-prompt').fill('看看有没有新任务');
    await expect(conn.getByTestId('timer-save')).toBeDisabled();
    await conn.getByTestId('timer-every').fill('15');
    await page.screenshot({ path: `${SHOTS}/${width}-form.png`, fullPage: true });
    await conn.getByTestId('timer-save').click();
    const item = conn.getByTestId('trigger-item');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('巡检');
    await item.getByTestId('trigger-toggle').click();
    await expect(item.getByTestId('trigger-toggle')).toHaveText('恢复');
    await item.getByTestId('trigger-toggle').click();
    await expect(item.getByTestId('trigger-toggle')).toHaveText('暂停');
    await item.getByTestId('trigger-runs').click();
    await expect(item.getByTestId('trigger-run-list')).toBeVisible();
    const box = await conn.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: `${SHOTS}/${width}-list.png`, fullPage: true });
    await item.getByTestId('trigger-delete').click();
    await expect(conn.getByTestId('trigger-item')).toHaveCount(0);

    // GitHub 绑定（R4）：仓库格式不对不能存；存好显示 仓库 · 标签 · 间隔；接口拒绝 5 分钟以下
    const badGh = await page.request.post(`/api/projects/${project}/agents/router/bindings`, { headers, data: { connector: 'github', kind: 'issue', name: 'x', params: { repo: 'acme/app', everyMin: 2 } } });
    expect(badGh.status()).toBe(400);
    await conn.getByTestId('trigger-new-github').click();
    await conn.getByTestId('github-repo').fill('not a repo');
    await expect(conn.getByTestId('github-save')).toBeDisabled();
    await conn.getByTestId('github-repo').fill('acme/app');
    await conn.getByTestId('github-every').fill('20');
    await page.screenshot({ path: `${SHOTS}/${width}-github-form.png`, fullPage: true });
    await conn.getByTestId('github-save').click();
    const gh = conn.getByTestId('trigger-item');
    await expect(gh).toHaveCount(1);
    await expect(gh).toContainText('acme/app · 标签 agent · 每 20 分钟');
    await page.screenshot({ path: `${SHOTS}/${width}-github-list.png`, fullPage: true });
    await gh.getByTestId('trigger-delete').click();
    await expect(conn.getByTestId('trigger-item')).toHaveCount(0);
  });
}
