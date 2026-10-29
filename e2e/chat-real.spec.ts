import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * 真 agent 跑一轮带工具的对话（bash、读文件、改文件），看对话页把它们都画出来。
 * 要真 agent、要时间，所以只在 E2E_REAL=1 时跑（发布前手动跑一遍，截图进指南）。
 */
const REAL = process.env['E2E_REAL'] === '1';
const SHOTS = process.env['E2E_SCREENSHOTS'];
const AGENTS = (process.env['E2E_REAL_AGENTS'] ?? 'pi').split(',');

for (const agent of AGENTS) {
  test(`真对话（${agent}）：bash、读、改文件、思考都在对话里；手机宽度也能看`, async ({ page, baseURL }) => {
    test.skip(!REAL, '只在 E2E_REAL=1 时跑');
    test.setTimeout(420_000);
    await loginByApi(page);
    const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
    const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    const agentId = workers.flatMap((worker) => (worker.state === 'online' ? worker.agentIds : [])).find((id) => id.includes(agent));
    test.skip(!agentId, `没有在线的 ${agent}：${JSON.stringify(workers.map((w) => w.agentIds))}`);
    const dir = mkdtempSync(join(tmpdir(), 'e2e-real-'));
    writeFileSync(join(dir, 'notes.md'), '# 笔记\n\n颜色：红色\n');
    const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 真对话 ${agent} ${Date.now().toString(36)}`, rootPath: dir }, headers })).json()) as { id: string };
    const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: `真对话：${agent}` }, headers })).json()) as { id: string };
    const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers });
    expect(derived.status(), await derived.text()).toBe(201);
    const { id } = (await derived.json()) as { id: string };

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/#/p/${project.id}/canvas`);
    await page.locator('.react-flow__node-session').locator('header, p').first().click();
    const log = page.getByRole('log', { name: '对话记录' });
    await expect(log).toBeVisible();
    const composer = page.getByLabel('发送消息');
    await composer.fill(
      '请依次用工具做三件事：1) 用 bash 执行 `ls -la`；2) 读取 notes.md；3) 把 notes.md 里的「红色」改成「蓝色」。做完用一句话总结，并用 **加粗** 写出新颜色。'
    );
    await composer.press('Control+Enter');
    await expect(log.getByTestId('msg-user')).toBeVisible();
    await expect.poll(() => readFileSync(join(dir, 'notes.md'), 'utf8'), { timeout: 300_000, intervals: [2000] }).toContain('蓝色');
    await expect(page.getByText(/正在回复/)).toHaveCount(0, { timeout: 120_000 });
    await expect(log.getByTestId('tool-card').first()).toBeVisible();
    await expect(log.getByTestId('msg-assistant').last()).toBeVisible();

    // 展开所有工具卡，确认 bash 有输出、改动有 diff
    await page.getByRole('button', { name: '显示设置' }).click();
    await page.getByRole('radio', { name: '展开' }).first().click();
    await page.keyboard.press('Escape');
    await expect(log.getByTestId('tool-output').first()).toBeVisible();
    await expect(log.getByTestId('tool-diff').first()).toContainText('蓝色');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/real-${agent}-desktop.png`, fullPage: true });

    for (const width of [360, 430]) {
      await page.setViewportSize({ width, height: 860 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/real-${agent}-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    void id;
  });
}
