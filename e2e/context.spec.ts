import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * ADR 0020 · 上下文策略 P1：会话详情显示生效策略（默认 compaction / 运行时原生）、估算用量和 L1 缺口；
 * 项目 / 会话选择的接口校验和 404（390px 手机宽度）。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'] ?? '/workspace/shots/context';

test('上下文策略：默认 compaction，会话详情显示用量和缺口；只能从启用的里选', async ({ page, baseURL }) => {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  expect((await page.request.get('/api/projects/no-such/context')).status()).toBe(404);
  expect((await page.request.put('/api/projects/no-such/context', { headers, data: { strategy: 'compaction', enabled: ['compaction'] } })).status()).toBe(404);
  expect((await page.request.get('/api/sessions/no-such/context')).status()).toBe(404);
  expect((await page.request.put('/api/sessions/no-such/context', { headers, data: { strategy: null } })).status()).toBe(404);

  let agentId: string | undefined;
  for (let i = 0; i < 40 && !agentId; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((worker) => worker.state === 'online')?.agentIds[0];
    if (!agentId) await page.waitForTimeout(500);
  }
  test.skip(!agentId, '这台机器上没有可用的 agent');
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 上下文 ${Date.now().toString(36)}`, rootPath: mkdtempSync(join(tmpdir(), 'e2e-ctx-')) }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '上下文' }, headers })).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers });
  expect(derived.status(), await derived.text()).toBe(201);
  const sid = ((await derived.json()) as { id: string }).id;

  const view = (await (await page.request.get(`/api/projects/${project.id}/context`)).json()) as { strategy: string; enabled: string[]; inherited: boolean };
  expect(view).toMatchObject({ strategy: 'compaction', enabled: ['compaction'], inherited: true });
  expect((await page.request.put(`/api/projects/${project.id}/context`, { headers, data: { strategy: 'trim', enabled: ['trim'] } })).status()).toBe(400);
  expect((await page.request.put(`/api/projects/${project.id}/context`, { headers, data: { strategy: 'compaction', enabled: ['compaction'] } })).status()).toBe(200);
  expect((await page.request.put(`/api/sessions/${sid}/context`, { headers, data: { strategy: 'context-pruning' } })).status()).toBe(400);
  const set = await page.request.put(`/api/sessions/${sid}/context`, { headers, data: { strategy: 'compaction' } });
  expect(set.status(), await set.text()).toBe(200);
  const ctx = (await set.json()) as { strategy: { id: string }; mode: string; source: string; usage: { estimated: boolean }; capability: { gaps: string[] } };
  expect(ctx).toMatchObject({ strategy: { id: 'compaction' }, mode: 'native', source: 'session', usage: { estimated: true } });
  expect(ctx.capability.gaps.length).toBeGreaterThan(0);
  const audit = await page.request.get(`/api/admin/audit?target=${sid}&limit=20`);
  if (audit.ok()) expect(await audit.text()).toContain('session.context.set');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/p/${project.id}/focus/${sid}`);
  await page.getByRole('button', { name: '详情' }).click();
  const panel = page.getByRole('complementary', { name: '会话详情' }).getByTestId('session-context');
  await expect(panel.getByTestId('context-strategy')).toContainText('自动压缩');
  await expect(panel.getByTestId('context-strategy')).toContainText('来自会话设置');
  await expect(panel.getByTestId('context-usage')).toContainText('hub 估算');
  await expect(panel.getByTestId('context-gaps')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/session-context-390.png` });
});
