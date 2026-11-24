import { test, expect } from '@playwright/test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, stopFakeWorker } from './fake-worker.ts';

test('Agent 运行记录：同一会话的两条消息只认各自的结束证据', async ({ page, baseURL }) => {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  // 必须落在测试 Worker 允许的 /tmp；不取决于调用者的 TMPDIR。
  const dir = mkdtempSync('/tmp/ah-observe-agent-');
  const aKey = 'observe-a';
  const bKey = 'observe-b';
  const marker = (key: string, type: 'started' | 'go') => join(dir, `hold-${key}.${type}`);
  const promptText = (key: string) => `请勿在运行记录中显示这段正文 please-hold:${key}`;

  try {
    const workerId = await ensureFakeWorker(page, baseURL!, 'fakeacp', { agentArgs: ['--gate-dir', dir] });
    const created = await page.request.post('/api/projects', {
      headers,
      data: { name: `Agent 运行记录测试 ${Date.now().toString(36)}`, rootPath: dir, workerId }
    });
    expect(created.ok(), await created.text()).toBe(true);
    const project = (await created.json()) as { id: string };
    const taskResponse = await page.request.post('/api/tasks', {
      headers, data: { projectId: project.id, title: '检查每轮送达的结果' }
    });
    expect(taskResponse.ok(), await taskResponse.text()).toBe(true);
    const task = (await taskResponse.json()) as { id: string };
    const derived = await page.request.post('/api/sessions/derive', {
      headers, data: { taskId: task.id, agentId: 'fakeacp', model: '' }
    });
    expect(derived.ok(), await derived.text()).toBe(true);
    const session = (await derived.json()) as { id: string };

    const machineTrace = async (id: string) => {
      const response = await page.request.get(`/api/observe/machine/${encodeURIComponent(id)}`);
      expect(response.ok(), await response.text()).toBe(true);
      return ((await response.json()) as {
        trace: { projectId: string | null; nodes: { state: string; endedAt: number | null; attrs: { key: string; value: string }[] }[] };
      }).trace;
    };
    const machines = await page.request.get('/api/observe?source=machine');
    expect(machines.ok(), await machines.text()).toBe(true);
    const machineList = ((await machines.json()) as { items: { id: string; projectId: string | null }[] }).items;
    let connectionId: string | undefined;
    for (const row of machineList) {
      const id = row.id.slice('machine:'.length);
      const trace = await machineTrace(id);
      if (!trace.nodes.some((node) => node.attrs.some((attr) => attr.key === 'Worker' && attr.value === workerId))) continue;
      expect(trace.projectId).toBeNull();
      expect(trace.nodes[0]).toMatchObject({ state: 'connected', endedAt: null });
      connectionId = id;
      break;
    }
    if (!connectionId) throw new Error('没有找到已配对 Worker 的连接记录');

    const prompt = async (key: string) => {
      const response = await page.request.post(`/api/sessions/${session.id}/prompt`, {
        headers, data: { text: promptText(key) }
      });
      expect(response.ok(), await response.text()).toBe(true);
      return (await response.json()) as { deliveryId: string; state: string; seq: number };
    };
    const trace = async (id: string) => {
      const response = await page.request.get(`/api/observe/agent/${encodeURIComponent(id)}`);
      expect(response.ok(), await response.text()).toBe(true);
      const data = (await response.json()) as {
        trace: { id: string; nodes: { kind: string; id: string; state: string | null; attrs: { key: string; value: string }[] }[] };
      };
      expect(JSON.stringify(data)).not.toContain('请勿在运行记录中显示这段正文');
      return data.trace;
    };
    const deliveries = async () => {
      const response = await page.request.get(`/api/observe?source=agent&projectId=${project.id}`);
      expect(response.ok(), await response.text()).toBe(true);
      return ((await response.json()) as { items: { id: string; nativeState: string }[] }).items;
    };

    const a = await prompt(aKey);
    expect(a.state).toBe('sending');
    await expect.poll(() => existsSync(marker(aKey, 'started')), { timeout: 30_000 }).toBe(true);
    const b = await prompt(bKey);
    expect(b.state).toBe('queued');
    expect(b.seq).toBeGreaterThan(a.seq);
    expect((await deliveries()).map((item) => item.id)).toEqual([`agent:${b.deliveryId}`, `agent:${a.deliveryId}`]);
    const queued = await trace(b.deliveryId);
    expect(queued.id).toBe(`agent:${b.deliveryId}`);
    expect(queued.nodes.flatMap((node) => node.attrs)).toContainEqual({ key: '发起类别', value: '账号' });
    expect(existsSync(marker(bKey, 'started'))).toBe(false);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/observe');
    const aRow = page.locator(`[data-testid="observe-row"]:has(a[href$="/agent/${a.deliveryId}"])`);
    const bRow = page.locator(`[data-testid="observe-row"]:has(a[href$="/agent/${b.deliveryId}"])`);
    await expect(aRow).toBeVisible();
    await expect(bRow).toBeVisible();
    await expect(bRow).toHaveAttribute('data-state', 'queued');
    await aRow.getByRole('link').click();
    await expect(page.getByTestId('observe-tree')).toBeVisible();
    await expect(page.getByTestId('observe-detail')).not.toContainText('请勿在运行记录中显示这段正文');

    writeFileSync(marker(aKey, 'go'), 'go\n');
    await expect.poll(() => existsSync(marker(bKey, 'started')), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await deliveries()).find((item) => item.id === `agent:${a.deliveryId}`)?.nativeState).toBe('delivered');
    const keys = async () => {
      const response = await page.request.get(`/api/sessions/${session.id}/events`);
      const log = (await response.json()) as { seq: number; event: { kind: string; deliveryId?: string } }[];
      return log.filter(({ event }) => event.kind === 'ended').map(({ event }) => event.deliveryId);
    };
    expect(await keys()).toContain(a.deliveryId);
    expect(await keys()).not.toContain(b.deliveryId);
    const first = await trace(a.deliveryId);
    const second = await trace(b.deliveryId);
    expect(first.nodes.filter((node) => node.state === 'done')).toHaveLength(1);
    expect(second.nodes.every((node) => node.state !== 'done')).toBe(true);

    writeFileSync(marker(bKey, 'go'), 'go\n');
    await expect.poll(keys, { timeout: 30_000 }).toContain(b.deliveryId);
    await expect.poll(async () => (await trace(b.deliveryId)).nodes.filter((node) => node.state === 'done').length).toBe(1);
    stopFakeWorker();
    const closedConnection = connectionId;
    await expect.poll(async () => (await machineTrace(closedConnection)).nodes[0]?.state, { timeout: 30_000 }).toBe('disconnected');
    expect((await machineTrace(closedConnection)).nodes[0]?.endedAt).not.toBeNull();
  } finally {
    stopFakeWorker();
    rmSync(dir, { recursive: true, force: true });
  }
});
