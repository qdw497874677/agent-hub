import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FAKE_AGENT_ID, ensureFakeWorker, stopFakeWorker } from './fake-worker.ts';
import { loginByApi } from './login.ts';

for (const width of [1280, 390]) {
  test(`运行时初始化期间可以排队，失败后明确重试 (${width}px)`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 844 });
    const root = mkdtempSync(join(tmpdir(), 'ah-runtime-start-'));
    const gate = join(root, 'startup');
    try {
      await loginByApi(page);
      const workerId = await ensureFakeWorker(page, baseURL!, FAKE_AGENT_ID, { agentArgs: ['--startup-gate', gate, '--gate-dir', root] });
      const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
      const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
      const post = async <T>(url: string, data: unknown): Promise<T> => {
        const response = await page.request.post(url, { data, headers });
        expect(response.ok(), await response.text()).toBe(true);
        return await response.json() as T;
      };
      const project = await post<{ id: string }>('/api/projects', { name: `runtime-start-${width}-${Date.now()}`, rootPath: root, workerId });
      const task = await post<{ id: string }>('/api/tasks', { projectId: project.id, title: '等待运行时初始化' });
      const session = await post<{ id: string }>('/api/sessions/derive', { taskId: task.id, agentId: FAKE_AGENT_ID, model: '' });
      const api = `/api/sessions/${session.id}`;
      const startup = page.getByTestId('session-startup-status');
      const readCount = (file: string) => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').length : 0;
      const count = (key: string) => readCount(join(root, `mark-${key}.started`));
      const deliveries = async () => (await (await page.request.get(`${api}/deliveries`)).json()) as Array<{ id: string; seq: number; state: string; attempt: number }>;
      const states = async () => (await deliveries()).sort((a, b) => a.seq - b.seq).map(({ state, attempt }) => `${state}:${attempt}`);
      await expect.poll(() => readCount(`${gate}.started`)).toBe(1);
      await page.goto(`/#/p/${project.id}/focus/${session.id}`);
      await expect(startup).toHaveAttribute('data-state', 'starting');
      const composer = page.getByLabel('发送消息');
      for (const key of ['a', 'b', 'withdraw']) {
        await composer.fill(`please-mark:${key}`);
        await page.getByRole('button', { name: /^(发送|排队发送)$/ }).click();
        await expect(composer).toHaveValue('');
      }
      await expect.poll(states).toEqual(['queued:0', 'queued:0', 'queued:0']);
      for (const key of ['a', 'b', 'withdraw']) expect(count(key)).toBe(0);
      const notes = page.getByTestId('delivery-note');
      await expect(notes).toHaveCount(3);
      await expect(notes.first()).toContainText('已排队 · 等待运行时就绪');
      await expect(notes.nth(1)).toContainText('已排队 · 前面还有消息');
      await expect(notes.getByRole('button', { name: '撤回' })).toHaveCount(3);

      writeFileSync(`${gate}.fail`, 'fail\n');
      await expect(startup).toHaveAttribute('data-state', 'failed');
      await expect.poll(states).toEqual(['queued:0', 'queued:0', 'queued:0']);
      await expect(page.getByRole('button', { name: '立即重试' })).toHaveCount(1);
      const withdrawals = page.getByTestId('delivery-note').getByRole('button', { name: '撤回' });
      await expect(withdrawals).toHaveCount(3);
      await withdrawals.last().click();
      await expect.poll(states).toEqual(['queued:0', 'queued:0', 'cancelled:0']);
      rmSync(`${gate}.fail`);
      writeFileSync(`${gate}.go`, 'go\n');
      await page.getByRole('button', { name: '立即重试' }).click();

      await expect.poll(() => readCount(`${gate}.started`)).toBe(2);
      await expect.poll(async () => (await states()).map((s) => s.split(':')[0])).toEqual(['delivered', 'delivered', 'cancelled']);
      await expect(startup).toHaveAttribute('data-state', 'ready');
      expect([count('a'), count('b'), count('withdraw')]).toEqual([1, 1, 0]);
      const ordered = (await deliveries()).sort((a, b) => a.seq - b.seq);
      const journal = (await (await page.request.get(`${api}/events`)).json()) as Array<{ event: { kind: string; deliveryId?: string } }>;
      expect(journal.filter(({ event }) => event.kind === 'ended').map(({ event }) => event.deliveryId)).toEqual(ordered.slice(0, 2).map(({ id }) => id));
    } finally {
      // Unblock a failing fixture before the Worker terminates.
      writeFileSync(`${gate}.go`, 'cleanup\n');
      stopFakeWorker();
      rmSync(root, { force: true, recursive: true });
    }
  });
}

test('连续两次在适配器前拒收后，显式重试按原队列各执行一次', async ({ page, baseURL }) => {
  const root = mkdtempSync(join(tmpdir(), 'ah-runtime-refusal-'));
  const obstruction = join(root, '.agent-hub', 'attachments');
  await loginByApi(page);
  try {
    const workerId = await ensureFakeWorker(page, baseURL!, FAKE_AGENT_ID, { agentArgs: ['--gate-dir', root] });
    const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
    const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
    const post = async <T>(url: string, data: unknown): Promise<T> => {
      const response = await page.request.post(url, { data, headers });
      expect(response.ok(), await response.text()).toBe(true);
      return await response.json() as T;
    };
    const project = await post<{ id: string }>('/api/projects', { name: `runtime-refusal-${Date.now()}`, rootPath: root, workerId });
    const task = await post<{ id: string }>('/api/tasks', { projectId: project.id, title: '附件落盘失败后恢复' });
    const session = await post<{ id: string }>('/api/sessions/derive', { taskId: task.id, agentId: FAKE_AGENT_ID, model: '' });
    const api = `/api/sessions/${session.id}`;
    const startup = page.getByTestId('session-startup-status');
    const deliveries = async () => {
      const response = await page.request.get(`${api}/deliveries`);
      expect(response.ok()).toBe(true);
      return ((await response.json()) as Array<{ id: string; seq: number; state: string; attempt: number }>).sort((a, b) => a.seq - b.seq);
    };
    const states = async () => (await deliveries()).map(({ state, attempt }) => `${state}:${attempt}`);
    await page.goto(`/#/p/${project.id}/focus/${session.id}`);
    await expect(startup).toHaveAttribute('data-state', 'ready');
    // A regular file at the expected directory makes the real Worker file write
    // fail before it invokes ACP. No external services or secrets are involved.
    mkdirSync(join(root, '.agent-hub'), { recursive: true });
    writeFileSync(obstruction, 'test fixture\n');
    await post(`${api}/prompt`, { text: 'please-mark:refused-a', attachments: [{ kind: 'file', name: 'sample.txt', mimeType: 'text/plain', data: 'Zml4dHVyZQ==' }] });
    await post(`${api}/prompt`, { text: 'please-mark:refused-b' });
    const refused = async () => {
      await expect(startup).toHaveAttribute('data-state', 'failed');
      await expect.poll(states).toEqual(['queued:0', 'queued:0']);
      for (const key of ['refused-a', 'refused-b']) expect(existsSync(join(root, `mark-${key}.started`))).toBe(false);
    };
    await refused();
    const [head, next] = await deliveries();
    if (!head || !next) throw new Error('expected both queued messages');
    const retry = `${api}/deliveries/${head.id}/retry`;
    const retryResponse = await page.request.post(retry, { headers });
    expect(retryResponse.ok(), await retryResponse.text()).toBe(true);
    await refused();
    rmSync(obstruction);
    await page.getByRole('button', { name: '立即重试' }).click();
    // Confirmed execution counts as one attempt; the two proven refusals did not.
    await expect.poll(states).toEqual(['delivered:1', 'delivered:1']);
    for (const key of ['refused-a', 'refused-b']) expect(readFileSync(join(root, `mark-${key}.started`), 'utf8').trim().split('\n')).toHaveLength(1);
    const journal = (await (await page.request.get(`${api}/events`)).json()) as Array<{ event: { kind: string; deliveryId?: string } }>;
    expect(journal.filter(({ event }) => event.kind === 'ended').map(({ event }) => event.deliveryId)).toEqual([head.id, next.id]);
  } finally {
    stopFakeWorker();
    rmSync(root, { force: true, recursive: true });
  }
});
