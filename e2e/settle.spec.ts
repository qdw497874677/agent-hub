import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { piModel } from './hub-model.ts';

/**
 * I1 收起（docs/design/interaction-borrowing.md §1）：做完的会话移出活跃列表，随时能移回。
 * 这里走真路径——起一条会话、停掉、从「更多」里收起，再看画布卡片与侧栏的表现。
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
  const dir = mkdtempSync(join(tmpdir(), 'e2e-settle-'));
  const project = (await (
    await page.request.post('/api/projects', {
      data: { name: `e2e 收起 ${Date.now().toString(36)}`, rootPath: dir },
      headers
    })
  ).json()) as { id: string };
  const task = (await (
    await page.request.post('/api/tasks', { data: { projectId: project.id, title: '收起' }, headers })
  ).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', {
    data: { taskId: task.id, agentId, model: piModel() },
    headers
  });
  expect(derived.status(), await derived.text()).toBe(201);
  const { id } = (await derived.json()) as { id: string };
  const title = `收起-${Date.now().toString(36)}`;
  const renamed = await page.request.put(`/api/sessions/${id}/title`, { data: { title }, headers });
  expect(renamed.ok(), await renamed.text()).toBe(true);
  // 跑着的会话不允许收起：先停掉。
  const stopped = await page.request.post(`/api/sessions/${id}/interrupt`, { headers });
  expect(stopped.ok(), await stopped.text()).toBe(true);
  return { projectId: project.id, sessionId: id, title, headers };
}

test('收起：会话移出活跃列表，画布退到背景，能移回', async ({ page, baseURL }) => {
  const { projectId, sessionId, title, headers } = await setup(page, baseURL ?? '');

  await page.goto(`/#/p/${projectId}/focus/${sessionId}`);
  await page.getByRole('button', { name: '更多' }).click();
  await page.getByTestId('session-settle').click();
  // 服务端确实落库了
  await expect
    .poll(async () => {
      // `GET /api/sessions/:id` 不是 API（走 SPA 兜底），状态从画布投影里读。
      const canvas = (await (await page.request.get(`/api/projects/${projectId}/canvas`, { headers })).json()) as {
        sessions: { id: string; settledAt?: number | null }[];
      };
      return canvas.sessions.find((row) => row.id === sessionId)?.settledAt ?? null;
    })
    .not.toBeNull();

  // 画布上还在，但标记成已收起
  await page.goto(`/#/p/${projectId}/canvas`);
  const card = page.locator(`.react-flow__node-session[data-settled="true"]`).filter({ hasText: title });
  await expect(card).toHaveCount(1, { timeout: 20_000 });
  await expect(card.getByTestId('card-status')).toContainText('已收起');

  // 侧栏活跃列表里没有它，但「已收起 N」能展开
  const toggle = page.getByTestId('sidebar-settled-toggle');
  await expect(toggle).toContainText('已收起 1');
  await expect(page.getByRole('button', { name: new RegExp(title) })).toHaveCount(0);
  await toggle.click();
  await expect(page.getByRole('button', { name: new RegExp(title) })).toHaveCount(1);

  // 移回活跃列表
  await page.goto(`/#/p/${projectId}/focus/${sessionId}`);
  await page.getByRole('button', { name: '更多' }).click();
  await page.getByTestId('session-settle').click();
  await expect
    .poll(async () => {
      // `GET /api/sessions/:id` 不是 API（走 SPA 兜底），状态从画布投影里读。
      const canvas = (await (await page.request.get(`/api/projects/${projectId}/canvas`, { headers })).json()) as {
        sessions: { id: string; settledAt?: number | null }[];
      };
      return canvas.sessions.find((row) => row.id === sessionId)?.settledAt ?? null;
    })
    .toBeNull();
  await page.goto(`/#/p/${projectId}/canvas`);
  await expect(page.getByTestId('sidebar-settled-toggle')).toContainText('已收起 0');
});

test('跑着的会话收起会被拒，提示先停', async ({ page, baseURL }) => {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL ?? '', 'x-hub-csrf': csrf };
  let agentId: string | undefined;
  for (let attempt = 0; attempt < 30 && agentId === undefined; attempt++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((worker) => worker.state === 'online')?.agentIds?.[0];
    if (agentId === undefined) await page.waitForTimeout(500);
  }
  test.skip(!agentId, '这台机器上没有可用的 agent');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-settle-busy-'));
  const project = (await (
    await page.request.post('/api/projects', { data: { name: `e2e 收起忙 ${Date.now().toString(36)}`, rootPath: dir }, headers })
  ).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '忙' }, headers })).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: piModel() }, headers });
  expect(derived.status(), await derived.text()).toBe(201);
  const { id } = (await derived.json()) as { id: string };
  const busy = await page.request.post(`/api/sessions/${id}/settle`, { data: { settled: true }, headers });
  expect(busy.status()).toBe(409);
  expect(await busy.text()).toContain('先停止');
});
