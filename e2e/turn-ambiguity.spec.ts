import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, stopFakeWorker } from './fake-worker.ts';

test.afterAll(() => stopFakeWorker());

for (const width of [1280, 390]) {
  test(`不确定的回合只属于对应投递，${width}px`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 844 });
    await loginByApi(page);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
    const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
    const workerId = await ensureFakeWorker(page, baseURL!);
    const dir = mkdtempSync(join(tmpdir(), 'turn-ambiguity-'));
    try {
      const project = await (await page.request.post('/api/projects', { data: { name: `回合状态 ${width} ${Date.now()}`, rootPath: dir, workerId }, headers })).json() as { id: string };
      const task = await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '回合状态' }, headers })).json() as { id: string };
      const response = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: 'fakeacp', model: '' }, headers });
      expect(response.ok(), await response.text()).toBeTruthy();
      const session = await response.json() as { id: string };
      let mode: 'healthy' | 'unrelated' | 'uncertain' | 'queued' | 'later' | 'ended' = 'healthy';
      const entry = (seq: number, event: object) => ({ seq, at: Date.now(), event });
      const entries = () => [
        entry(1, { kind: 'prompt', text: '第一轮 A' }),
        ...(mode !== 'healthy' ? [entry(2, { kind: 'diagnostic', level: 'error', text: 'SECRET RAW DIAGNOSTIC', uncertainDeliveryId: mode === 'unrelated' ? 'missing' : 'a' })] : []),
        ...(['queued', 'later', 'ended'].includes(mode) ? [entry(3, { kind: 'prompt', text: '第二轮 B' })] : []),
        ...(mode === 'ended' ? [entry(4, { kind: 'ended', outcome: 'done', deliveryId: 'a' })] : [])
      ];
      const item = (id: string, seq: number, state: string) => ({ id, sessionId: session.id, seq, kind: 'prompt', state, attempt: 0, nextAt: null, lastError: null, createdAt: 1, updatedAt: 1 });
      const deliveries = () => [item('a', 1, mode === 'later' ? 'delivered' : 'sending'), ...(['queued', 'later', 'ended'].includes(mode) ? [item('b', 3, mode === 'queued' ? 'queued' : 'sending')] : [])];
      await page.route(`**/api/projects/${project.id}/canvas`, async (route) => {
        const result = await route.fetch();
        const body = await result.json();
        body.previews[session.id] = entries();
        body.sessions = body.sessions.map((s: any) => s.id === session.id ? { ...s, status: 'running', lastSeq: entries().length } : s);
        await route.fulfill({ response: result, json: body });
      });
      await page.route(new RegExp(`/api/sessions/${session.id}/events(?:\\?.*)?$`), (route) => {
        const after = Number(new URL(route.request().url()).searchParams.get('after') ?? 0);
        return route.fulfill({ json: entries().filter((entry) => entry.seq > after) });
      });
      await page.route(`**/api/sessions/${session.id}/deliveries`, (route) => route.fulfill({ json: deliveries() }));
      await page.addInitScript(() => {
        class FakeSource {
          static CLOSED = 2;
          readyState = 0;
          listeners: Record<string, (event: any) => void> = {};
          constructor() {
            (window as any).emitTestFrame = (frame: unknown) => this.listeners.frame?.({ data: JSON.stringify(frame) });
            queueMicrotask(() => {
              if (this.readyState === FakeSource.CLOSED) return;
              this.readyState = 1;
              this.listeners.open?.({});
              (window as any).testStreamOpened = true;
            });
          }
          addEventListener(name: string, callback: (event: any) => void) { this.listeners[name] = callback; }
          close() { this.readyState = FakeSource.CLOSED; }
        }
        (window as any).EventSource = FakeSource;
      });
      const open = async () => { await page.goto(`/#/p/${project.id}/focus/${session.id}`); await expect(page.getByText('第一轮 A', { exact: true })).toBeVisible(); };
      const a = () => page.getByTestId('msg-user').filter({ hasText: '第一轮 A' });
      const b = () => page.getByTestId('msg-user').filter({ hasText: '第二轮 B' });
      await open();
      await expect(page.getByTestId('turn-hint')).toHaveText('等待模型首次回应');
      await page.waitForFunction(() => (window as any).testStreamOpened === true);
      await expect(page.getByTestId('session-history-state')).toHaveCount(0);
      await expect(page.getByTestId('session-sync-state')).toHaveCount(0);
      await page.evaluate((sessionId) => (window as any).emitTestFrame({ sessionId, seq: 2, status: 'running', event: { kind: 'diagnostic', level: 'error', text: 'SECRET RAW DIAGNOSTIC', uncertainDeliveryId: 'a' } }), session.id);
      await expect(page.getByTestId('turn-hint')).toHaveText('暂未确认这一轮的结果');
      mode = 'unrelated';
      await page.reload();
      await expect(page.getByTestId('turn-hint')).toHaveText('等待模型首次回应');
      mode = 'uncertain';
      await page.reload();
      await expect(page.getByTestId('turn-hint')).toHaveText('暂未确认这一轮的结果');
      await expect(page.getByText('SECRET RAW DIAGNOSTIC')).toHaveCount(0);
      await expect(page.getByRole('button', { name: '立即重试' })).toHaveCount(0);
      await page.goto(`/#/p/${project.id}/canvas`);
      const canvasCard = page.locator('.react-flow__node-session');
      await expect(canvasCard.getByTestId('card-delivery-uncertain')).toHaveText('暂未确认这一轮的结果');
      await expect(canvasCard.getByTestId('card-msg-unknown')).toHaveCount(0);
      await expect(canvasCard.getByRole('button', { name: '立即重试' })).toHaveCount(0);
      mode = 'queued';
      await open();
      await expect(a().getByTestId('delivery-note')).toContainText('暂未确认这一轮的结果');
      await expect(b().getByTestId('delivery-note')).toContainText('已排队 · 等待上一轮状态确认');
      await expect(b().getByRole('button', { name: '撤回' })).toBeVisible();
      await expect(page.getByRole('button', { name: '立即重试' })).toHaveCount(0);
      mode = 'later';
      await page.reload();
      await expect(b()).toBeVisible();
      await expect(page.getByTestId('turn-hint')).toHaveText('等待模型首次回应');
      await expect(page.getByText('暂未确认这一轮的结果')).toHaveCount(0);
      mode = 'ended';
      await page.reload();
      await expect(b()).toBeVisible();
      await expect(page.getByTestId('turn-hint')).toHaveText('等待模型首次回应');
      await expect(page.getByText('暂未确认这一轮的结果')).toHaveCount(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
