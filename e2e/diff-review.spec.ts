import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { loginByApi } from './login.ts';
import { backToChat, openSessionTool } from './session-tools.ts';

test.afterAll(stopFakeWorker);

async function fixture(page: Page, baseURL: string, root: string) {
  await loginByApi(page);
  const workerId = await ensureFakeWorker(page, baseURL);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  const post = async <T>(path: string, data: unknown): Promise<T> => {
    const response = await page.request.post(path, { headers, data });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()) as T;
  };
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@x', ...args], { cwd: root });
  git('init', '-q', '-b', 'main');
  for (const file of ['alpha.txt', 'beta.txt', 'gamma.txt']) {
    writeFileSync(join(root, file), 'before one\nbefore two\n');
  }
  git('add', '.');
  git('commit', '-qm', 'initial');
  const project = await post<{ id: string }>('/api/projects', { name: `diff-review-${Date.now()}`, rootPath: root, workerId });
  const task = await post<{ id: string }>('/api/tasks', { projectId: project.id, title: '批量审阅' });
  const derive = (taskId = task.id) => post<{ id: string }>('/api/sessions/derive', { taskId, agentId: FAKE_AGENT_ID, model: '' });
  const source = await derive();
  const target = await derive();
  const otherTask = await post<{ id: string }>('/api/tasks', { projectId: project.id, title: '另一个任务' });
  const unrelated = await derive(otherTask.id);
  for (const file of ['alpha.txt', 'beta.txt', 'gamma.txt']) {
    writeFileSync(join(root, file), 'after one\nafter two\n');
  }
  return { project, source, target, unrelated, headers };
}

type Send = { batchId: string; targetSessionId: string; noteIds: string[] };
const shots = process.env['E2E_SCREENSHOTS'];

for (const width of [1280, 390]) {
  const phone = width < 640;
  test.describe(`Diff 批注 ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: phone, isMobile: phone });

    test('保留跨文件批注，区分陈旧锚点，重试不重复入队', async ({ page, baseURL }) => {
      const root = mkdtempSync(join(tmpdir(), 'ah-diff-review-'));
      try {
        const { project, source, target, unrelated, headers } = await fixture(page, baseURL!, root);
        const sourceApi = `/api/sessions/${source.id}/git/review`;
        const targetApi = `/api/sessions/${target.id}`;
        await page.goto(`/#/p/${project.id}/focus/${source.id}`);
        await openSessionTool(page, 'changes');
        const changes = page.getByTestId('files-panel-changes');
        const panel = changes.getByTestId('review-panel');
        const diff = changes.getByTestId('diff-view');
        const note = (text: string) => panel.getByTestId('review-note').filter({ hasText: text });
        const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
        const showReviewList = async () => {
          if (!await panel.isVisible()) await diff.getByTestId('files-back').click({ timeout: 10_000 });
          await expect(panel).toBeVisible({ timeout: 10_000 });
        };

        async function add(file: string, text: string, side: 'new' | 'old', end: number) {
          await changes.getByTestId('change-row').filter({ hasText: file }).click();
          const line = (n: number) => diff.getByTestId('diff-line').and(diff.locator(`[data-side="${side}"][data-line="${n}"]`));
          await line(1).click();
          if (end > 1) await line(end).click();
          await diff.getByTestId('review-add').click();
          await diff.getByTestId('review-text').fill(text);
          expect(await fits()).toBe(true);
          await diff.getByTestId('review-save').click();
          await expect(diff.getByTestId('review-text')).toHaveCount(0);
          await showReviewList();
          await expect(note(text)).toBeVisible();
        }

        await add('alpha.txt', '检查改后两行', 'new', 2);
        await add('beta.txt', '检查原始第一行', 'old', 1);
        await add('gamma.txt', '这条版本会变化', 'new', 1);

        await page.reload();
        await openSessionTool(page, 'changes');
        await showReviewList();
        await expect(panel.getByTestId('review-note')).toHaveCount(3);
        await note('检查改后两行').getByTestId('review-open').click();
        await expect(diff).toContainText('after two');
        await showReviewList();
        writeFileSync(join(root, 'gamma.txt'), 'changed again\nafter two\n');
        await panel.getByTestId('review-refresh').click();
        await expect(note('这条版本会变化')).toContainText('版本已变化');
        await expect(note('这条版本会变化').getByTestId('review-select')).toBeDisabled();

        const currentReview = await page.request.get(sourceApi);
        expect(currentReview.ok()).toBe(true);
        const persisted = await currentReview.json() as { notes: Array<{ id: string; text: string }>; targets: Array<{ id: string }> };
        expect(persisted.targets.map(({ id }) => id)).not.toContain(unrelated.id);
        const staleId = persisted.notes.find((entry) => entry.text === '这条版本会变化')!.id;
        const stale = await page.request.post(`${sourceApi}/send`, {
          headers, data: { batchId: 'stale-anchor', targetSessionId: target.id, noteIds: [staleId] }
        });
        expect(stale.status(), await stale.text()).toBe(409);
        const outside = await page.request.post(`${sourceApi}/send`, {
          headers, data: { batchId: 'unrelated-task', targetSessionId: unrelated.id, noteIds: [persisted.notes.find((entry) => entry.text === '检查改后两行')!.id] }
        });
        expect(outside.status(), await outside.text()).toBe(404);

        await note('检查改后两行').getByTestId('review-select').check();
        await note('检查原始第一行').getByTestId('review-select').check();
        await panel.getByTestId('review-target').selectOption(target.id);
        const attempts: Send[] = [];
        // Drop the first request before admission. Retrying must keep the draft
        // selection and reuse the same request key rather than creating a batch.
        await page.route(`**${sourceApi}/send`, (route) => {
          attempts.push(route.request().postDataJSON() as Send);
          return attempts.length === 1 ? route.abort() : route.continue();
        });
        await panel.getByTestId('review-send').click();
        await expect(panel.getByRole('alert')).toBeVisible();
        await expect(panel.getByTestId('review-note')).toHaveCount(3);
        await panel.getByTestId('review-send').click();
        await expect.poll(() => attempts.length).toBe(2);
        expect(attempts[1]).toEqual(attempts[0]);
        await expect(note('检查改后两行')).toContainText('已送达');
        await expect(note('检查原始第一行')).toContainText('已送达');

        // Simulate a client retry after the durable receipt was lost.
        const send = attempts[1]!;
        expect(send.noteIds).toHaveLength(2);
        const replay = await page.request.post(`${sourceApi}/send`, { headers, data: { ...send, noteIds: [...send.noteIds].reverse() } });
        expect(replay.status(), await replay.text()).toBe(202);
        await note('检查改后两行').getByTestId('review-open').click();
        await expect(diff.locator('[data-testid="diff-line"][data-side="new"][data-line="2"]')).toHaveAttribute('aria-pressed', 'true');
        const deliveryResponse = await page.request.get(`${targetApi}/deliveries`);
        expect(deliveryResponse.ok(), await deliveryResponse.text()).toBe(true);
        expect(await deliveryResponse.json()).toEqual([expect.objectContaining({ state: 'delivered' })]);
        const eventResponse = await page.request.get(`${targetApi}/events`);
        expect(eventResponse.ok(), await eventResponse.text()).toBe(true);
        const prompts = (await eventResponse.json() as Array<{ event: { kind: string; text?: string } }>).filter(({ event }) => event.kind === 'prompt');
        expect(prompts).toHaveLength(1);
        expect(prompts[0]?.event.text).toContain('检查改后两行');
        expect(prompts[0]?.event.text).toContain('检查原始第一行');
        expect(prompts[0]?.event.text).not.toContain('这条版本会变化');
        expect(await fits()).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}

test.describe('会话与改动并排', () => {
  test.use({ viewport: { width: 1440, height: 960 } });

  test('同一个 Diff 和对话草稿在并排与窄屏标签之间保留', async ({ page, baseURL }) => {
    const root = mkdtempSync(join(tmpdir(), 'ah-diff-split-'));
    try {
      const { project, source, target } = await fixture(page, baseURL!, root);
      await page.goto(`/#/p/${project.id}/focus/${source.id}`);
      const chat = page.getByRole('log', { name: '会话记录' });
      const composer = page.getByRole('textbox', { name: '发送消息' });
      const changes = page.getByTestId('files-panel-changes');
      const split = page.getByTestId('changes-split-toggle');
      await expect(chat).toBeVisible();
      await composer.fill('只回复 OK');
      await composer.press('Control+Enter');
      await expect(chat.getByText('OK', { exact: true })).toBeVisible();
      await expect(chat.getByTestId('turn-hint')).toBeHidden();
      await composer.fill('保留这段未发送的草稿');
      await expect(changes).toBeHidden();

      await openSessionTool(page, 'changes');
      const diff = changes.getByTestId('diff-view');
      await expect(split).toHaveAccessibleName('展开改动');
      await expect(chat).toBeVisible();
      await expect(composer).toHaveValue('保留这段未发送的草稿');
      await expect(page.getByTestId('changes-workspace')).toBeVisible();
      await expect(changes).toHaveCount(1);
      await expect(changes.getByTestId('change-row')).toHaveCount(3);
      if (shots) await page.screenshot({ path: join(shots, 'workbench-changes-list-desktop.png') });
      const failAlpha = (url: URL) => url.pathname.endsWith(`/sessions/${source.id}/git/diff`) && url.searchParams.get('path') === 'alpha.txt';
      await page.route(failAlpha, (route) => route.abort());
      await changes.getByTestId('change-row').filter({ hasText: 'alpha.txt' }).click();
      await expect(diff.getByTestId('files-error')).toBeVisible();
      await expect(composer).toHaveValue('保留这段未发送的草稿');
      await page.unroute(failAlpha);
      await diff.getByTestId('files-back').click();
      await changes.getByTestId('change-row').filter({ hasText: 'beta.txt' }).click();
      await expect(diff).toBeVisible();
      await expect(diff).toContainText('beta.txt');
      await expect(diff).toContainText('after two');
      const [chatBox, diffBox] = await Promise.all([chat.boundingBox(), diff.boundingBox()]);
      expect(chatBox!.x + chatBox!.width).toBeLessThanOrEqual(diffBox!.x);
      expect(chatBox!.y + chatBox!.height).toBeGreaterThan(diffBox!.y);

      const line = diff.locator('[data-testid="diff-line"][data-side="new"][data-line="2"]');
      await line.click();
      await diff.getByTestId('review-add').click();
      const note = diff.getByTestId('review-text');
      await note.fill('这条批注先不提交');
      if (shots) await page.screenshot({ path: join(shots, 'workbench-changes-split-desktop.png') });

      // Make the wide layout unavailable, without creating a new tab or tearing down its editor.
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(split).toBeHidden();
      await expect(page.getByTestId('session-back-to-chat')).toBeVisible();
      await expect(chat).toBeHidden();
      await expect(diff).toContainText('beta.txt');
      await expect(note).toHaveValue('这条批注先不提交');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
      if (shots) await page.screenshot({ path: join(shots, 'workbench-changes-narrow.png') });

      await test.step('窄屏返回对话后重新打开改动', async () => {
        await backToChat(page);
        await expect(composer).toHaveValue('保留这段未发送的草稿', { timeout: 10_000 });
        await openSessionTool(page, 'changes');
        await expect(note).toHaveValue('这条批注先不提交', { timeout: 10_000 });
      });

      await test.step('恢复并排并引用选中差异', async () => {
        await page.setViewportSize({ width: 1440, height: 960 });
        await expect(split).toHaveAccessibleName('展开改动', { timeout: 10_000 });
        await expect(note).toHaveValue('这条批注先不提交', { timeout: 10_000 });
        await expect(chat).toBeVisible({ timeout: 10_000 });
        await diff.getByTestId('diff-quote').click({ timeout: 10_000 });
        await expect(composer).toHaveValue(/保留这段未发送的草稿[\s\S]*beta\.txt/, { timeout: 10_000 });
        await expect(changes).toBeHidden({ timeout: 10_000 });
        await expect(chat).toBeVisible({ timeout: 10_000 });
        await openSessionTool(page, 'changes');
        await expect(changes).toHaveCount(1);
        await expect(diff).toBeVisible({ timeout: 10_000 });
        await expect(diff).toContainText('beta.txt', { timeout: 10_000 });
      });

      // The project sidebar takes space on desktop. A 1180px viewport is still a desktop UI,
      // but the workbench is under 1000px; don't switch away from an unrelated active tab.
      await test.step('桌面中等宽度保留文件工具', async () => {
        await openSessionTool(page, 'files');
        await page.setViewportSize({ width: 1180, height: 844 });
        await expect(split).toBeHidden({ timeout: 10_000 });
        await expect(page.getByTestId('session-tab-files')).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
        await expect(page.getByTestId('files-panel-files')).toBeVisible({ timeout: 10_000 });
      });

      // Another session restoring its Changes tab must not inherit the open Diff or notes editor.
      await test.step('不同会话隔离 Diff 和备注编辑器', async () => {
        await page.goto(`/#/p/${project.id}/focus/${target.id}`);
        await openSessionTool(page, 'changes');
        await page.goto(`/#/p/${project.id}/focus/${source.id}`);
        await openSessionTool(page, 'changes');
        await expect(diff).toBeVisible({ timeout: 10_000 });
        await expect(diff).toContainText('beta.txt', { timeout: 10_000 });
        const gamma = changes.getByTestId('change-row').filter({ hasText: 'gamma.txt' });
        if (!await gamma.isVisible()) await diff.getByTestId('files-back').click({ timeout: 10_000 });
        await expect(gamma).toBeVisible({ timeout: 10_000 });
        await gamma.click({ timeout: 10_000 });
        await expect(diff).toContainText('gamma.txt', { timeout: 10_000 });
        await page.goto(`/#/p/${project.id}/focus/${target.id}`);
        await expect(page.getByTestId('session-tab-changes')).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
        await expect(changes.getByTestId('change-row').filter({ hasText: 'gamma.txt' })).toBeVisible({ timeout: 10_000 });
        await expect(diff).toBeHidden({ timeout: 10_000 });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

for (const width of [1440, 390]) {
  const phone = width < 768;
  test.describe(`从对话继续审阅 ${width}px`, () => {
    test.use({ viewport: { width, height: phone ? 844 : 960 }, hasTouch: phone, isMobile: phone });

    test('打开指定回合、保存备注并在切回会话后恢复文件', async ({ page, baseURL }) => {
      const root = mkdtempSync(join(tmpdir(), 'ah-diff-resume-'));
      try {
        const { project, source, target, headers } = await fixture(page, baseURL!, root);
        const focus = (id: string) => page.goto(`/#/p/${project.id}/focus/${id}`);
        const chat = page.getByRole('log', { name: '会话记录' });
        const composer = page.getByRole('textbox', { name: '发送消息' });
        const changes = page.getByTestId('files-panel-changes');
        const diff = changes.getByTestId('diff-view');
        const split = page.getByTestId('changes-split-toggle');
        const response = await page.request.post(`/api/sessions/${source.id}/prompt`, {
          headers, data: { text: 'please-write:gamma.txt=written-in-turn' }
        });
        expect(response.ok(), await response.text()).toBe(true);
        await focus(source.id);
        await expect(chat).toBeVisible();
        await composer.fill('评审时保留这段对话草稿');
        if (!phone) {
          await openSessionTool(page, 'changes');
          await expect(changes.getByTestId('change-row').filter({ hasText: 'beta.txt' })).toBeVisible();
          await changes.getByTestId('change-row').filter({ hasText: 'beta.txt' }).click();
          await expect(diff).toContainText('beta.txt');
          await backToChat(page);
        }

        const badge = chat.getByTestId('turn-badge').first();
        await expect(badge).toContainText('改了 1 个文件');
        await badge.click();
        await expect(changes.getByTestId('changes-base')).toHaveValue('turn:1');
        await expect(changes.getByTestId('change-row')).toHaveCount(1);
        if (phone) {
          await expect(chat).toBeHidden();
          await expect(page.getByTestId('session-back-to-chat')).toBeVisible();
        } else {
          await expect(chat).toBeVisible();
          await expect(composer).toHaveValue('评审时保留这段对话草稿');
        }
        await changes.getByTestId('change-row').filter({ hasText: 'gamma.txt' }).click();
        await expect(diff).toContainText('written-in-turn');
        await expect(diff).toContainText('第 1 轮的两个快照');
        const headerToggle = diff.getByRole('button', { name: 'Git 头信息' });
        await expect(headerToggle).toHaveAttribute('aria-expanded', 'false');
        await expect(diff.getByText('diff --git a/gamma.txt b/gamma.txt', { exact: true })).toBeHidden();
        await headerToggle.click();
        await expect(diff.getByText('diff --git a/gamma.txt b/gamma.txt', { exact: true })).toBeVisible();
        await headerToggle.click();

        const line = diff.locator('[data-testid="diff-line"][data-side="new"][data-line="3"]');
        await line.click();
        await diff.getByTestId('review-add').click();
        const note = diff.getByTestId('review-text');
        await note.fill('确认本轮新增的这一行');
        const save = diff.getByTestId('review-save');
        if (!phone) {
          await split.click();
          await expect(chat).toBeHidden();
          await expect(note).toHaveValue('确认本轮新增的这一行');
          await expect(save).toBeEnabled();
          await expect(split).toHaveAccessibleName('返回并排');
          if (shots) await page.screenshot({ path: join(shots, 'p0-review-expanded.png') });
          await split.click();
          await expect(chat).toBeVisible();
          await expect(note).toHaveValue('确认本轮新增的这一行');
        }
        await expect(save).toBeEnabled();
        if (shots) await page.screenshot({ path: join(shots, `p0-review-${width}.png`) });
        await save.click();
        await expect(note).toHaveCount(0);
        await focus(target.id);
        await expect(chat).toBeVisible();
        await expect(changes).toBeHidden();
        await focus(source.id);
        await expect(diff).toContainText('written-in-turn');
        await expect(diff).toContainText('第 1 轮的两个快照');
        if (phone) await expect(chat).toBeHidden();
        else await expect(chat).toBeVisible();
        await page.reload();
        await expect(diff).toContainText('written-in-turn');
        await diff.getByTestId('files-back').click();
        await expect(changes.getByTestId('review-note').filter({ hasText: '确认本轮新增的这一行' })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}

for (const width of [1440, 390]) {
  const phone = width < 768;
  test.describe(`会话显示设置 ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: phone, isMobile: phone });

    test('默认只展示常用项，展开详细设置后可修改且刷新保留', async ({ page, baseURL }) => {
      const root = mkdtempSync(join(tmpdir(), 'ah-chat-display-'));
      try {
        const { project, source } = await fixture(page, baseURL!, root);
        await page.goto(`/#/p/${project.id}/focus/${source.id}`);
        async function openDisplaySettings() {
          if (phone) {
            await page.getByTestId('session-more-trigger').click();
            await page.getByTestId('session-more-details').click();
            await page.getByRole('menuitem', { name: /^显示设置/ }).click();
          } else {
            await page.getByTestId('session-more-trigger').click();
            await page.getByRole('menuitem', { name: /^显示设置/ }).click();
          }
        }
        const settings = page.getByTestId('display-settings');
        const tools = settings.getByRole('radiogroup', { name: '工具调用' });
        const compact = settings.getByRole('switch', { name: '紧凑' });
        const contrast = settings.getByRole('radiogroup', { name: '增强对比' });
        const toggle = settings.getByText('详细设置', { exact: true });
        const shell = settings.getByRole('switch', { name: '命令输出默认展开' });
        await openDisplaySettings();
        await expect(settings.getByRole('heading', { name: '常用' })).toBeVisible();
        await expect(tools).toBeVisible();
        await expect(shell).toBeHidden();
        await compact.check();
        await contrast.getByRole('radio', { name: '更高' }).click();
        await expect(page.locator('html')).toHaveAttribute('data-contrast', 'more');
        await toggle.click();
        await shell.check();
        await tools.getByRole('radio', { name: '隐藏' }).click();
        await expect(shell).toBeDisabled();
        await tools.getByRole('radio', { name: '折叠' }).click();
        await expect(shell).toBeEnabled();
        await expect(shell).toBeChecked();
        if (shots) await page.screenshot({ path: join(shots, `workbench-display-settings-${width}.png`) });
        await page.reload();
        await expect(page.locator('html')).toHaveAttribute('data-contrast', 'more');
        await openDisplaySettings();
        await expect(compact).toBeChecked();
        await expect(contrast.getByRole('radio', { name: '更高' })).toHaveAttribute('aria-checked', 'true');
        await expect(shell).toBeHidden();
        await toggle.click();
        await expect(shell).toBeChecked();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}
