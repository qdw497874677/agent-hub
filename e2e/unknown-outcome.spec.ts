import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { loginByApi } from './login.ts';

test.afterAll(() => stopFakeWorker());

/**
 * 结果未知（Hermes outcome_unknown）的一轮：对话里只给一张说明卡。
 * 不提供一键重发，也不在浏览器里假装「已处理」。先在测试 Worker 上完成一轮，
 * 再用历史接口的测试替身把 ended 改为适配器可上报的结果未知。
 */
for (const width of [1280, 390]) {
  test(`结果未知的一轮：画布与对话只说明，不重发、不本地消解 ${width}px`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 844 });
    await loginByApi(page);
    const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
    const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
    const workerId = await ensureFakeWorker(page, baseURL!);
    const dir = mkdtempSync(join(tmpdir(), 'e2e-unknown-'));
    try {
      const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 结果未知 ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers })).json()) as { id: string };
      const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '结果未知' }, headers })).json()) as { id: string };
      const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: FAKE_AGENT_ID, model: '' }, headers });
      expect(derived.status(), await derived.text()).toBe(201);
      const { id } = (await derived.json()) as { id: string };
      const ended = async () => {
        const events = (await (await page.request.get(`/api/sessions/${id}/events`)).json()) as Array<{ event?: { kind?: string } }>;
        return events.filter((entry) => entry.event?.kind === 'ended').length;
      };
      const sent = await page.request.post(`/api/sessions/${id}/prompt`, { data: { text: '改一下 README', attachments: [] }, headers });
      expect(sent.ok(), await sent.text()).toBe(true);
      await expect.poll(ended, { timeout: 15_000 }).toBeGreaterThan(0);

      const entries = (await (await page.request.get(`/api/sessions/${id}/events`)).json()) as Array<{ seq: number; event?: Record<string, unknown> }>;
      const rewritten = entries.map((entry) =>
        entry.event?.['kind'] === 'ended' ? { ...entry, event: { kind: 'ended', outcome: 'interrupted', reason: '运行时未确认结果', outcomeUnknown: true } } : entry
      );
      await page.route(`**/api/projects/${project.id}/canvas`, async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.previews[id] = rewritten;
        await route.fulfill({ response, json: body });
      });
      await page.route(`**/api/sessions/${id}/events**`, async (route) => {
        const after = Number(new URL(route.request().url()).searchParams.get('after') ?? 0);
        await route.fulfill({ json: rewritten.filter((entry) => entry.seq > after) });
      });
      await page.goto(`/#/p/${project.id}/canvas`);
      const canvasCard = page.locator('.react-flow__node-session');
      await expect(canvasCard.getByTestId('card-msg-unknown')).toContainText('先核对工作目录和会话记录');
      await expect(canvasCard.getByTestId('card-msg-unknown')).not.toContainText('重发');
      await page.locator('.react-flow__node-session').getByRole('button', { name: '打开' }).click();
      const log = page.getByRole('log', { name: '会话记录' });
      const card = log.getByTestId('msg-unknown').last();
      await expect(card).toBeVisible();
      await expect(card).toContainText('这一轮结果待确认');
      await expect(card.getByTestId('unknown-guidance')).toContainText('先核对工作目录和会话记录');
      // 没有「重发 / 不用了」这类可以假装结论的按钮。
      await expect(card.getByRole('button')).toHaveCount(0);
      await expect(page.getByTestId('turn-progress-elapsed')).toHaveCount(0);

      await page.reload();
      await expect(log.getByTestId('msg-unknown').last()).toContainText('这一轮结果待确认');
      // 普通输入框仍然在：要继续，就明确发一条新消息。
      await expect(page.getByRole('textbox', { name: '发送消息' })).toBeVisible();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
