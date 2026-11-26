import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { loginByApi } from './login.ts';

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
        const tab = page.getByTestId('session-tab-changes');
        await tab.click();
        const changes = page.getByTestId('files-panel-changes');
        const panel = changes.getByTestId('review-panel');
        const diff = changes.getByTestId('diff-view');
        const note = (text: string) => panel.getByTestId('review-note').filter({ hasText: text });
        const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

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
          if (phone) await diff.getByTestId('files-back').click();
          await expect(note(text)).toBeVisible();
        }

        await add('alpha.txt', '检查改后两行', 'new', 2);
        await add('beta.txt', '检查原始第一行', 'old', 1);
        await add('gamma.txt', '这条版本会变化', 'new', 1);

        await page.reload();
        await tab.click();
        await expect(panel.getByTestId('review-note')).toHaveCount(3);
        await note('检查改后两行').getByTestId('review-open').click();
        await expect(diff).toContainText('after two');
        if (phone) await diff.getByTestId('files-back').click();
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
