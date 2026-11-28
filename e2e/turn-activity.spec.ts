import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { loginByApi } from './login.ts';

const SHOTS = process.env['E2E_SCREENSHOTS'];

for (const width of [1280, 390]) {
  test.describe(`回合工作过程 ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: width < 600, isMobile: width < 600 });

    test('正文切开活动，流式追加不重置，回放保留正文和操作', async ({ page, baseURL }) => {
      const dir = mkdtempSync(join(tmpdir(), 'e2e-turn-activity-'));
      try {
        await loginByApi(page);
        const workerId = await ensureFakeWorker(page, baseURL!, FAKE_AGENT_ID, { agentArgs: ['--gate-dir', dir] });
        const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')!.value;
        const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
        const post = async (url: string, data: object) => {
          const response = await page.request.post(url, { data, headers });
          expect(response.ok(), await response.text()).toBe(true);
          return response;
        };
        const project = await (await post('/api/projects', { name: `回合工作过程 ${width}`, rootPath: dir, workerId })).json() as { id: string };
        const task = await (await post('/api/tasks', { projectId: project.id, title: '汇总工具和思考' })).json() as { id: string };
        const session = await (await post('/api/sessions/derive', { taskId: task.id, agentId: FAKE_AGENT_ID, model: '' })).json() as { id: string };
        const sessionApi = `/api/sessions/${session.id}`;
        const prompt = (text: string) => post(`${sessionApi}/prompt`, { text, briefing: false });
        await page.goto(`/#/p/${project.id}/focus/${session.id}`);
        const log = page.getByRole('log', { name: '会话记录' });
        await expect(log).toBeVisible();

        await prompt('please-turn-activity');
        const group = log.getByTestId('work-group');
        const first = group.nth(0);
        const second = group.nth(1);
        const toggle = first.getByTestId('work-group-toggle');
        const nextToggle = second.getByTestId('work-group-toggle');
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(toggle.getByTestId('work-group-types')).toHaveText('思考 1');
        await expect(log.getByText('先看目录思路', { exact: true })).toBeHidden();
        if (width < 600) await toggle.tap();
        else { await toggle.focus(); await page.keyboard.press('Enter'); }
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        writeFileSync(join(dir, 'activity.go'), 'go');
        await expect(group).toHaveCount(2);
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(toggle.getByTestId('work-group-types')).toHaveText(/思考 1.*读取 1/);
        await expect(nextToggle).toHaveAttribute('aria-expanded', 'false');
        await expect(nextToggle.getByTestId('work-group-types')).toHaveText(/命令 1|执行 1/);
        const middle = log.getByText('工具之间的正文', { exact: true });
        await expect(middle.locator('xpath=ancestor::*[@data-testid="work-group"]')).toHaveCount(0);
        await expect(middle).toBeVisible();
        const textY = (await middle.boundingBox())!.y;
        expect((await first.boundingBox())!.y).toBeLessThan(textY);
        expect((await second.boundingBox())!.y).toBeGreaterThan(textY);
        await expect(first.getByTestId('work-group-progress')).toHaveCount(0);
        await expect(second.getByTestId('work-group-progress')).toBeVisible();
        writeFileSync(join(dir, 'activity-shell.go'), 'go');
        await expect(log.getByText('这一轮正常结束', { exact: true })).toBeVisible();
        await expect(group).toHaveCount(2);
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(first.getByTestId('tool-card')).toHaveCount(1);
        await expect(second.getByTestId('tool-card')).toBeHidden();
        await expect(second.getByTestId('work-group-progress')).toHaveCount(0);
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `turn-activity-open-${width}.png`) });

        await page.reload();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(nextToggle).toHaveAttribute('aria-expanded', 'false');
        await expect(toggle.getByTestId('work-group-types')).toHaveText(/思考 1.*读取 1/);
        await expect(nextToggle.getByTestId('work-group-types')).toHaveText(/命令 1|执行 1/);
        await expect(middle).toBeVisible();
        await expect(log.getByText('这一轮正常结束', { exact: true })).toBeVisible();
        await expect(log.getByTestId('tool-card').first()).toBeHidden();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `turn-activity-closed-${width}.png`) });

        await toggle.focus();
        await page.keyboard.press('Control+f');
        await page.getByTestId('find-input').fill('活动搜索标记');
        await expect(page.getByTestId('find-count')).toHaveText('1 个结果');
        await expect(log.getByText('活动搜索标记', { exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');

        await prompt('please-activity-error');
        const failure = log.locator('[data-testid="tool-card"][data-tool-ok="false"]');
        await expect(failure).toBeVisible();
        await expect(failure.getByTestId('tool-params')).toContainText('missing-activity.txt');
        await expect(failure.locator('xpath=ancestor::*[@data-testid="work-group"]')).toHaveCount(0);

        // 同一轮先思考、再提问：不展开也能看到问题和选项。
        await prompt('please-activity-question');
        const question = log.getByTestId('agent-question');
        await expect(question).toContainText('是否继续检查？');
        await expect(question.getByText('暂停', { exact: true })).toBeVisible();
        await expect(group).toHaveCount(3);
        await expect(group.last().getByTestId('work-group-toggle')).toHaveAttribute('aria-expanded', 'false');
        await expect(group.last().getByTestId('work-group-types')).toHaveText('思考 1');
        await expect(question.locator('xpath=ancestor::*[@data-testid="work-group"]')).toHaveCount(0);
        for (const disclosure of await group.getByTestId('work-group-toggle').all()) await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
      } finally {
        stopFakeWorker();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
