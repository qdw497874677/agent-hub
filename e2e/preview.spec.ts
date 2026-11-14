import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { piModel } from './hub-model.ts';

/**
 * 预览链接（docs/design/preview.md §4）：会话页登记一个 worker 回环端口，
 * hub 在自己的端口上把它转发出去；这一版只测「登记 / 列出 / 移除 / 端口复用」，
 * 上游真的跑起来的效果留给手动验证（e2e 里没有常驻的 dev server）。
 */
async function setup(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  let agentId: string | undefined;
  for (let attempt = 0; attempt < 30 && agentId === undefined; attempt++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((worker) => worker.state === 'online')?.agentIds?.[0];
    if (agentId === undefined) await page.waitForTimeout(500);
  }
  test.skip(!agentId, '这台机器上没有可用的 agent');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-preview-'));
  const project = (await (
    await page.request.post('/api/projects', {
      data: { name: `e2e 预览 ${Date.now().toString(36)}`, rootPath: dir },
      headers
    })
  ).json()) as { id: string };
  const task = (await (
    await page.request.post('/api/tasks', { data: { projectId: project.id, title: '预览' }, headers })
  ).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', {
    data: { taskId: task.id, agentId, model: piModel() },
    headers
  });
  expect(derived.status(), await derived.text()).toBe(201);
  const { id } = (await derived.json()) as { id: string };
  return { sessionId: id, headers };
}

test('预览链接：登记端口、列出来、同一端口重复登记沿用同一条', async ({ page, baseURL }) => {
  const { sessionId, headers } = await setup(page, baseURL ?? '');
  const created = await page.request.post(`/api/sessions/${sessionId}/previews`, {
    data: { port: 5173, label: 'dev' },
    headers
  });
  expect(created.status(), await created.text()).toBe(201);
  const link = ((await created.json()) as { link: { id: string; hubPort: number; port: number; state: string; label: string } }).link;
  expect(link.port).toBe(5173);
  expect(link.label).toBe('dev');
  expect(link.hubPort).toBeGreaterThan(0);
  expect(link.state).toBe('ready');

  const again = await page.request.post(`/api/sessions/${sessionId}/previews`, {
    data: { port: 5173 },
    headers
  });
  expect(again.status(), await again.text()).toBe(201);
  expect(((await again.json()) as { link: { id: string } }).link.id).toBe(link.id);

  const list = ((await (await page.request.get(`/api/sessions/${sessionId}/previews`)).json()) as { links: Array<{ id: string }> }).links;
  expect(list.map((entry) => entry.id)).toContain(link.id);

  const removed = await page.request.delete(`/api/sessions/${sessionId}/previews/${link.id}`, { headers });
  expect(removed.status(), await removed.text()).toBe(200);
  const after = ((await (await page.request.get(`/api/sessions/${sessionId}/previews`)).json()) as { links: Array<{ id: string }> }).links;
  expect(after.map((entry) => entry.id)).not.toContain(link.id);
});

test('预览链接：上游没在跑时，hub 的端口回一张说明页', async ({ page, baseURL }) => {
  const { sessionId, headers } = await setup(page, baseURL ?? '');
  const created = await page.request.post(`/api/sessions/${sessionId}/previews`, {
    data: { port: 5199 },
    headers
  });
  expect(created.status(), await created.text()).toBe(201);
  const { hubPort } = ((await created.json()) as { link: { hubPort: number } }).link;
  const response = await page.request.get(`http://127.0.0.1:${hubPort}/`);
  expect([502, 504]).toContain(response.status());
  expect(await response.text()).toContain('服务没在跑');
});
