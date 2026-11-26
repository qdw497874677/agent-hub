import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { ensureFakeWorker, stopFakeWorker } from './fake-worker.ts';
import { loginByApi } from './login.ts';
import { showSessionHandoff } from './session-composer-controls.ts';

// Both aliases are actual ACP descriptors on the same real remote Worker. The
// startup and prompt files count invocations in the fake ACP process itself.
for (const width of [1280, 390]) {
  test(`real agent handoff, explicit no-history and idempotent retries (${width}px)`, async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const root = mkdtempSync(join(tmpdir(), 'ah-handoff-real-'));
    const startup = join(root, 'startup');
    const fake = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');
    const count = (path: string) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').length : 0;
    // Do not block session/new, but retain its append-only startup count.
    writeFileSync(`${startup}.go`, 'go\n');
    try {
      await page.setViewportSize({ width, height: 844 });
      await loginByApi(page);
      const agents = ['fakeacp', 'handoffacp'].map((id) => ({
        id, label: id, command: process.execPath,
        args: [fake, '--startup-gate', startup, '--gate-dir', root, '--session-ref', `native-${id}`],
        listModelsArgs: [fake, '--models']
      }));
      const workerId = await ensureFakeWorker(page, baseURL!, 'fakeacp', { env: { ACP_AGENTS: JSON.stringify(agents), HUB_KEEPALIVE_MAX: '1' } });
      const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
      const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
      const post = async <T>(url: string, data: unknown): Promise<T> => {
        const response = await page.request.post(url, { data, headers });
        expect(response.ok(), `${url}: ${await response.text()}`).toBe(true);
        return await response.json() as T;
      };
      const get = async <T>(url: string): Promise<T> => {
        const response = await page.request.get(url);
        expect(response.ok(), `${url}: ${await response.text()}`).toBe(true);
        return await response.json() as T;
      };
      const project = await post<{ id: string }>('/api/projects', { name: `real-handoff-${width}-${Date.now()}`, rootPath: root, workerId });
      const task = await post<{ id: string }>('/api/tasks', { projectId: project.id, title: '真实交接' });
      const source = await post<{ id: string }>('/api/sessions/derive', { taskId: task.id, agentId: 'fakeacp', model: '' });
      const sourceApi = `/api/sessions/${source.id}`;
      const sourceDelivery = await post<{ deliveryId: string }>(`${sourceApi}/prompt`, { text: 'source turn please-mark:source' });
      type Entry = { event: { kind: string; deliveryId?: string; outcome?: string; text?: string } };
      await expect.poll(async () => (await get<Entry[]>(`${sourceApi}/events`)).filter(({ event }) => event.kind === 'ended' && event.deliveryId === sourceDelivery.deliveryId).map(({ event }) => event.outcome), { timeout: 60_000 }).toEqual(['done']);
      expect(count(join(root, 'mark-source.started'))).toBe(1);
      expect(count(`${startup}.started`)).toBe(1);

      const reservations: Array<{ agentId: string; model: string; requestId: string }> = [];
      const firsts: Array<{ text: string; clientMessageId: string; withHistory: boolean }> = [];
      page.on('request', (request) => {
        if (request.method() !== 'POST') return;
        const url = new URL(request.url()).pathname;
        if (url === `${sourceApi}/agent-handoff`) reservations.push(request.postDataJSON());
        else if (/\/api\/sessions\/[^/]+\/agent-handoff\/first$/.test(url)) firsts.push(request.postDataJSON());
      });
      await page.goto(`/#/p/${project.id}/focus/${source.id}`);
      const picker = await showSessionHandoff(page, width < 640);
      await expect(picker).toBeVisible();
      await picker.click();
      const dialog = page.getByRole('dialog', { name: '选择要换的 Agent' });
      await dialog.getByRole('option', { name: /handoffacp.*fake\/m1/ }).last().click();
      await expect(page.getByTestId('handoff-confirm')).toContainText('同一台机器、同一工作区');
      await page.getByRole('button', { name: '确认新建会话' }).click();
      const gate = page.getByTestId('handoff-gate');
      await expect(gate).toContainText('没有可用历史');
      expect(reservations).toHaveLength(1);
      const targetId = new URL(page.url()).hash.split('/').at(-1)!;
      expect(targetId).not.toBe(source.id);
      const targetApi = `/api/sessions/${targetId}`;
      const metadata = await get<{ handoff: { sourceSessionId: string; firstAccepted: boolean; startup: string; historyAvailable: boolean } }>(`${targetApi}/agent-handoff`);
      expect(metadata.handoff).toEqual({ sourceSessionId: source.id, firstAccepted: false, startup: 'pending', historyAvailable: false });
      const canvas = await get<{ sessions: Array<{ id: string; workerId: string; workspaceId: string; taskId: string; agentId: string }> }>(`/api/projects/${project.id}/canvas`);
      const from = canvas.sessions.find((s) => s.id === source.id)!;
      const target = canvas.sessions.find((s) => s.id === targetId)!;
      expect(target).toMatchObject({ workerId, workspaceId: from.workspaceId, taskId: task.id, agentId: 'handoffacp' });
      expect(await post<{ sessionId: string }>(`${sourceApi}/agent-handoff`, reservations[0])).toEqual({ sessionId: targetId });
      expect(count(`${startup}.started`)).toBe(1);
      expect(await get<unknown[]>(`${targetApi}/deliveries`)).toEqual([]);
      expect((await get<Entry[]>(`${targetApi}/events`)).filter(({ event }) => event.kind === 'prompt')).toEqual([]);

      await gate.getByLabel('交接后的首条消息').fill('target turn please-mark:target');
      await expect(gate.getByRole('button', { name: '提交首条消息' })).toBeDisabled();
      await gate.getByLabel('我确认不带历史继续').check();
      await gate.getByRole('button', { name: '提交首条消息' }).click();
      await expect(gate).toContainText('首条已接收');
      expect(firsts).toHaveLength(1);
      expect(firsts[0]).toMatchObject({ text: 'target turn please-mark:target', withHistory: false });
      const replay = await post<{ deliveryId: string; seq: number }>(`${targetApi}/agent-handoff/first`, firsts[0]);
      await expect.poll(() => count(join(root, 'mark-target.started')), { timeout: 60_000 }).toBe(1);
      await expect.poll(async () => (await get<Entry[]>(`${targetApi}/events`)).filter(({ event }) => event.kind === 'ended' && event.deliveryId === replay.deliveryId).map(({ event }) => event.outcome), { timeout: 60_000 }).toEqual(['done']);
      const rows = await get<Array<{ id: string }>>(`${targetApi}/deliveries`);
      expect(rows.map((row) => row.id)).toEqual([replay.deliveryId]);
      expect((await get<Entry[]>(`${targetApi}/events`)).filter(({ event }) => event.kind === 'prompt')).toHaveLength(1);
      expect(count(`${startup}.started`)).toBe(2);
      expect(count(join(root, 'mark-target.started'))).toBe(1);

      expect((await get<{ agentSessionRef: string }>(sourceApi)).agentSessionRef).toBe('native-fakeacp');
      expect((await get<{ agentSessionRef: string }>(targetApi)).agentSessionRef).toBe('native-handoffacp');
      // Rehost A to evict the completed B with the one-session keepalive limit.
      const a2 = await post<{ deliveryId: string }>(`${sourceApi}/prompt`, { text: 'source again please-mark:source-again' });
      await expect.poll(async () => (await get<Entry[]>(`${sourceApi}/events`)).some(({ event }) => event.kind === 'ended' && event.deliveryId === a2.deliveryId && event.outcome === 'done'), { timeout: 60_000 }).toBe(true);
      await expect.poll(async () => (await get<{ state: string }>(`${targetApi}/startup`)).state, { timeout: 60_000 }).toBe('untracked');
      const b2 = await post<{ deliveryId: string }>(`${targetApi}/prompt`, { text: 'target after rehost please-mark:target-again' });
      await expect.poll(async () => (await get<Entry[]>(`${targetApi}/events`)).some(({ event }) => event.kind === 'ended' && event.deliveryId === b2.deliveryId && event.outcome === 'done'), { timeout: 60_000 }).toBe(true);
      expect(readFileSync(`${startup}.loaded`, 'utf8').trim().split('\n')).toEqual(['native-fakeacp', 'native-handoffacp']);
      expect(count(`${startup}.started`)).toBe(2);
      expect(count(join(root, 'mark-target.started'))).toBe(1);
      expect(count(join(root, 'mark-target-again.started'))).toBe(1);
    } finally {
      stopFakeWorker();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
