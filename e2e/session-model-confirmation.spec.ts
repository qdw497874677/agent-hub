import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FAKE_AGENT_ID, ensureFakeWorker, stopFakeWorker } from './fake-worker.ts';
import { loginByApi } from './login.ts';

test('模型确认来自当前运行时，首次显式选择不会只改界面', async ({ page, baseURL }) => {
  const root = mkdtempSync(join(tmpdir(), 'ah-model-confirmation-'));
  try {
    await loginByApi(page);
    const workerId = await ensureFakeWorker(page, baseURL!);
    const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
    const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
    const read = async <T>(url: string): Promise<T> => {
      const response = await page.request.get(url);
      expect(response.ok(), await response.text()).toBe(true);
      return await response.json() as T;
    };
    const post = async <T>(url: string, data: unknown): Promise<T> => {
      const response = await page.request.post(url, { data, headers });
      expect(response.ok(), await response.text()).toBe(true);
      return await response.json() as T;
    };
    const project = await post<{ id: string }>('/api/projects', { name: `model-confirmation-${Date.now()}`, rootPath: root, workerId });
    const task = await post<{ id: string }>('/api/tasks', { projectId: project.id, title: '模型回执' });
    const session = await post<{ id: string }>('/api/sessions/derive', { taskId: task.id, agentId: FAKE_AGENT_ID, model: '' });
    const api = `/api/sessions/${session.id}`;
    const deliveries = () => read<Array<{ id: string; seq: number; state: string }>>(`${api}/deliveries`);
    const journal = () => read<Array<{ event: { kind: string; delta?: string; deliveryId?: string } }>>(`${api}/events`);
    type Session = { id: string; model: string; agentId: string; agentSessionRef: string | null; workspaceId: string | null; workerId: string | null };
    const option = () => post<{ state: string; session: Session }>(`${api}/options`, { optionId: 'model', value: 'b', confirm: true });
    await expect.poll(async () => (await read<{ state: string }>(`${api}/startup`)).state).toBe('ready');
    await post(`${api}/prompt`, { text: 'please-report-effective-model' });
    await expect.poll(async () => (await deliveries()).map((entry) => entry.state)).toEqual(['delivered']);
    await expect.poll(async () => (await journal()).filter(({ event }) => event.kind === 'text').map(({ event }) => event.delta)).toEqual(['effective-model:a']);

    const before = await read<Session>(api);
    expect(before.model).toBe('');
    expect(before.agentSessionRef).toBeTruthy();
    const outcome = await option();
    expect(outcome.state).toBe('confirmed');
    expect(outcome.session).toMatchObject({ id: before.id, model: 'b', agentId: before.agentId, agentSessionRef: before.agentSessionRef, workspaceId: before.workspaceId, workerId: before.workerId });
    await post(`${api}/prompt`, { text: 'please-report-effective-model' });
    await expect.poll(async () => (await deliveries()).map((entry) => entry.state)).toEqual(['delivered', 'delivered']);
    const rows = await journal();
    expect(rows.filter(({ event }) => event.kind === 'text').map(({ event }) => event.delta)).toEqual(['effective-model:a', 'effective-model:b']);
    expect(rows.filter(({ event }) => event.kind === 'ended').map(({ event }) => event.deliveryId)).toEqual((await deliveries()).sort((a, b) => a.seq - b.seq).map(({ id }) => id));
  } finally {
    stopFakeWorker();
    rmSync(root, { recursive: true, force: true });
  }
});
