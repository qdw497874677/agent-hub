import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { loginByApi } from './login.ts';
import { openSessionTool } from './session-tools.ts';

test.afterAll(stopFakeWorker);

for (const width of [1280, 390]) {
  const phone = width < 640;
  test.describe(`源代码控制 ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: phone, isMobile: phone });

    test('分支、改动与任务 PR 各有范围；刷新与切换不执行 Git 写操作', async ({ page, baseURL }, testInfo) => {
      const root = mkdtempSync(join(tmpdir(), 'ah-source-control-'));
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@x', ...args], { cwd: root });
      try {
        git('init', '-q', '-b', 'scoped-branch');
        writeFileSync(join(root, 'example.txt'), 'before example\n');
        git('add', '.');
        git('commit', '-qm', 'initial');
        await loginByApi(page);
        const workerId = await ensureFakeWorker(page, baseURL!);
        const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
        const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
        const post = async (path: string, data: unknown) => {
          const response = await page.request.post(path, { headers, data });
          expect(response.status(), await response.text()).toBe(201);
          return await response.json() as { id: string };
        };
        const project = await post('/api/projects', { name: `源代码控制-${width}-${Date.now()}`, rootPath: root, workerId });
        const task = await post('/api/tasks', { projectId: project.id, title: '检查代码与评审' });
        const session = await post('/api/sessions/derive', { taskId: task.id, workerId, agentId: FAKE_AGENT_ID, model: '' });
        writeFileSync(join(root, 'example.txt'), 'after example\n');

        const gitCalls: string[] = [];
        page.on('request', (request) => {
          const path = new URL(request.url()).pathname;
          if (path.startsWith(`/api/sessions/${session.id}/git/`) && request.method() !== 'GET') gitCalls.push(path);
        });
        // Core status/diff use the real Worker. The task PR result is synthetic:
        // deliberately from a different repo/branch and not opened in the browser.
        const prUrl = 'https://github.com/example/other-repository/pull/42';
        let prs = false;
        await page.route(`**/api/tasks/${task.id}/pull-requests`, (route) => route.fulfill({ json: { pullRequests: prs ? [{
          id: 'pr-fixture', taskId: task.id, sessionId: null, via: 'gh', repo: 'example/other-repository', number: 42, url: prUrl,
          branch: 'other-branch', base: 'main', state: 'merged', mergedAt: 101, createdAt: 100, lastSyncedAt: 102
        }] : [] } }));

        await page.goto(`/#/p/${project.id}/focus/${session.id}`);
        await openSessionTool(page, 'changes');
        const panel = page.getByTestId('source-control-panel');
        const branch = panel.getByTestId('source-control-branch');
        const changes = panel.getByTestId('source-control-tab-changes');
        const pullRequests = panel.getByTestId('source-control-tab-pr');
        const prPanel = page.getByTestId('source-control-pr-content');
        const menu = panel.getByTestId('source-control-menu');
        const list = page.getByTestId('files-panel-changes');
        const file = list.getByTestId('change-row').filter({ hasText: 'example.txt' });
        const diff = list.getByTestId('diff-view');

        await expect(branch).toContainText('scoped-branch');
        await expect(changes).toHaveAttribute('aria-selected', 'true');
        await expect(file).toBeVisible();
        if (phone) {
          for (const control of [changes, pullRequests, menu]) {
            const box = (await control.boundingBox())!;
            expect(box.height).toBeGreaterThanOrEqual(44);
            expect(box.width).toBeGreaterThanOrEqual(44);
          }
        }
        await page.screenshot({ path: testInfo.outputPath(`source-control-changes-${width}.png`) });
        await file.click();
        await expect(diff).toContainText('after example');
        if (phone) await expect(branch).toBeHidden();
        await pullRequests.click();
        await expect(pullRequests).toHaveAttribute('aria-selected', 'true');
        await expect(prPanel).toContainText(/此任务|当前任务/);
        await expect(prPanel).toContainText('此任务尚未记录 PR');
        await expect(prPanel.getByTestId('source-control-pr-item')).toHaveCount(0);

        prs = true;
        git('checkout', '-q', '--detach');
        await menu.click();
        await expect(page.getByRole('menuitem', { name: /提交与推送/ })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: /强制推送|切换分支|同步|变基/ })).toHaveCount(0);
        await page.getByTestId('source-control-refresh').click();
        await expect(branch).toContainText('分离 HEAD');
        const link = prPanel.getByTestId('source-control-pr-item');
        await expect(link).toHaveAttribute('href', prUrl);
        await expect(link).toContainText('已合并');
        await expect(link).toContainText('example/other-repository #42');
        await page.screenshot({ path: testInfo.outputPath(`source-control-pr-${width}.png`) });

        await changes.click();
        await expect(diff).toBeVisible();
        await expect(diff).toContainText('after example');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        expect(gitCalls).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}
