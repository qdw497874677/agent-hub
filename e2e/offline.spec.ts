import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { FAKE_AGENT_ID, ensureFakeWorker, stopFakeWorker } from './fake-worker.ts';

/**
 * 弱网 / 离线：发送出去之后的每一段都要有落点。
 *
 * - 请求慢（弱网）：气泡先出来，超过回执超时变成「未送达 · 重试」，点重试用同一个 clientMessageId，
 *   服务端幂等，不会出现两条一样的消息。
 * - 机器离线：清楚说明消息可以先排队，并验证服务器真的持久排队，而不是只模拟离线显示。
 */
async function openSession(page: Page, baseURL: string, dir: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  const workerId = await ensureFakeWorker(page, baseURL);
  const post = async (url: string, data: object) => {
    const response = await page.request.post(url, { headers, data });
    expect(response.status(), await response.text()).toBe(201);
    return await response.json() as { id: string };
  };
  const project = await post('/api/projects', { name: `e2e 弱网 ${Date.now().toString(36)}`, rootPath: dir, workerId });
  const task = await post('/api/tasks', { projectId: project.id, title: '弱网' });
  const derived = await page.request.post('/api/sessions/derive', {
    data: { taskId: task.id, agentId: FAKE_AGENT_ID, model: '' },
    headers
  });
  expect(derived.status(), await derived.text()).toBe(201);
  const { id } = (await derived.json()) as { id: string };
  await page.goto(`/#/p/${project.id}/focus/${id}`);
  const area = page.getByLabel('发送消息');
  await expect(area).toBeVisible();
  return { area, headers, project, sessionId: id };
}

/** 已经进 journal 的 prompt 条数（按文本数，够用了）。 */
async function promptCount(page: Page, headers: Record<string, string>, sessionId: string, text: string): Promise<number> {
  const events = (await (await page.request.get(`/api/sessions/${sessionId}/events`, { headers })).json()) as Array<{
    event: { kind: string; text?: string };
  }>;
  return events.filter((entry) => entry.event.kind === 'prompt' && entry.event.text === text).length;
}

test('弱网：回执超时后气泡变未送达，重试不会产生重复消息', async ({ page, baseURL }) => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-offline-'));
  try {
    const { area, headers, sessionId } = await openSession(page, baseURL!, dir);
    const text = `弱网消息 ${Date.now().toString(36)}`;

    // 第一次请求卡住 9 秒（超过 8 秒回执超时），之后放行。
    let first = true;
    await page.route('**/api/sessions/*/prompt', async (route) => {
      if (first) {
        first = false;
        await new Promise((resolve) => setTimeout(resolve, 9_000));
      }
      await route.continue();
    });

    await area.fill(text);
    await area.press('Control+Enter');

    const pending = page.getByTestId('pending-prompts');
    await expect(pending).toBeVisible();
    await expect(page.getByTestId('turn-hint')).toContainText('正在发送…');

    // 8 秒超时后：同一颗气泡原地说明没收到回执，给出重试/放弃。
    await expect(page.getByTestId('pending-unknown')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByTestId('pending-unknown')).toContainText('未收到回执');
    await expect(page.getByTestId('pending-retry')).toBeVisible();

    await page.getByTestId('pending-retry').click();

    // 重试用的是同一个 clientMessageId：journal 里只有一条。
    await expect
      .poll(async () => promptCount(page, headers, sessionId, text), { timeout: 15_000 })
      .toBe(1);
    await expect(page.getByTestId('pending-prompts')).toHaveCount(0);
  } finally {
    stopFakeWorker();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const width of [1280, 390]) {
  test(`机器离线：说明原因，仍可发送并持久排队 (${width}px)`, async ({ page, baseURL }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 844 });
    await loginByApi(page);
    const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
    const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
    const dir = mkdtempSync(join(tmpdir(), 'e2e-offline-queue-'));
    let workerId = '';
    try {
      workerId = await ensureFakeWorker(page, baseURL!, FAKE_AGENT_ID);
      const post = async <T>(url: string, data: unknown): Promise<T> => {
        const response = await page.request.post(url, { data, headers });
        expect(response.ok(), await response.text()).toBe(true);
        return await response.json() as T;
      };
      const project = await post<{ id: string }>('/api/projects', { name: `offline-queue-${width}-${Date.now()}`, rootPath: dir, workerId });
      const task = await post<{ id: string }>('/api/tasks', { projectId: project.id, title: '离线排队' });
      const session = await post<{ id: string }>('/api/sessions/derive', { taskId: task.id, agentId: FAKE_AGENT_ID, model: '' });
      const api = `/api/sessions/${session.id}`;
      await page.goto(`/#/p/${project.id}/focus/${session.id}`);
      const area = page.getByLabel('发送消息');
      await expect(area).toBeVisible();

      // 断开真正的独立 Worker；/workers 和 /startup 都由服务器报告，不造矛盾夹具。
      stopFakeWorker();
      await expect.poll(async () => {
        const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ id?: string; workerId?: string; state: string }>;
        return workers.find((worker) => (worker.workerId ?? worker.id) === workerId)?.state;
      }, { timeout: 30_000 }).toBe('offline');
      await expect.poll(async () => ((await (await page.request.get(`${api}/startup`)).json()) as { state: string }).state, { timeout: 30_000 }).toBe('offline');
      const status = page.getByTestId('session-startup-status');
      await expect(status).toHaveAttribute('data-state', 'offline');
      await expect(status).toContainText('机器离线');
      await expect(status).toContainText('消息可先排队');

      const text = `离线排队消息 ${width}`;
      await area.fill(text);
      const send = page.getByRole('button', { name: /^(发送|排队发送)$/ });
      await expect(send).toBeEnabled();
      const ack = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`${api}/prompt`));
      await send.click();
      const response = await ack;
      expect(response.ok(), await response.text()).toBe(true);
      const { deliveryId } = await response.json() as { deliveryId: string };
      const rows = async () => (await (await page.request.get(`${api}/deliveries`)).json()) as Array<{ id: string; state: string; attempt: number }>;
      await expect.poll(async () => {
        const delivery = (await rows()).find((row) => row.id === deliveryId);
        return `${delivery?.state}/${delivery?.attempt}`;
      }).toBe('queued/0');
      const note = page.getByRole('log', { name: '会话记录' }).getByTestId('msg-user').filter({ hasText: text }).getByTestId('delivery-note');
      await expect(note).toHaveAttribute('data-state', 'queued');
      await expect(note).toContainText('已排队 · 等待机器上线');
      await expect(note.getByRole('button', { name: '撤回' })).toBeVisible();
    } finally {
      stopFakeWorker();
      if (workerId) await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
