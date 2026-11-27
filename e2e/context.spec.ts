import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';

/**
 * ADR 0020 · 上下文策略 P1：会话详情显示生效策略（默认 compaction / 运行时原生）、估算用量和 L1 缺口；
 * 项目 / 会话选择的接口校验和 404（390px 手机宽度）。
 */
test.afterAll(() => stopFakeWorker());

test('上下文策略：默认 compaction，会话详情显示用量和缺口；只能从启用的里选', async ({ page, baseURL }, testInfo) => {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  expect((await page.request.get('/api/projects/no-such/context')).status()).toBe(404);
  expect((await page.request.put('/api/projects/no-such/context', { headers, data: { strategy: 'compaction', enabled: ['compaction'] } })).status()).toBe(404);
  expect((await page.request.get('/api/sessions/no-such/context')).status()).toBe(404);
  expect((await page.request.put('/api/sessions/no-such/context', { headers, data: { strategy: null } })).status()).toBe(404);

  const workerId = await ensureFakeWorker(page, baseURL!);
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 上下文 ${Date.now().toString(36)}`, rootPath: mkdtempSync(join(tmpdir(), 'e2e-ctx-')), workerId }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '上下文' }, headers })).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: FAKE_AGENT_ID, model: '', workerId }, headers });
  expect(derived.status(), await derived.text()).toBe(201);
  const sid = ((await derived.json()) as { id: string }).id;

  const view = (await (await page.request.get(`/api/projects/${project.id}/context`)).json()) as { strategy: string; enabled: string[]; inherited: boolean };
  expect(view).toMatchObject({ strategy: 'compaction', enabled: ['compaction'], inherited: true });
  expect((await page.request.put(`/api/projects/${project.id}/context`, { headers, data: { strategy: 'nope', enabled: ['nope'] } })).status()).toBe(400);
  // P3：trim 已内置（hub-managed），能启用
  expect((await page.request.put(`/api/projects/${project.id}/context`, { headers, data: { strategy: 'compaction', enabled: ['compaction', 'trim'] } })).status()).toBe(200);
  expect((await page.request.put(`/api/projects/${project.id}/context`, { headers, data: { strategy: 'compaction', enabled: ['compaction'] } })).status()).toBe(200);
  expect((await page.request.put(`/api/sessions/${sid}/context`, { headers, data: { strategy: 'context-pruning' } })).status()).toBe(400);
  const set = await page.request.put(`/api/sessions/${sid}/context`, { headers, data: { strategy: 'compaction' } });
  expect(set.status(), await set.text()).toBe(200);
  const ctx = (await set.json()) as { strategy: { id: string }; mode: string; source: string; usage: { estimated: boolean }; capability: { gaps: string[] } };
  expect(ctx).toMatchObject({ strategy: { id: 'compaction' }, mode: 'native', source: 'session', usage: { estimated: true } });
  expect(ctx.capability.gaps.length).toBeGreaterThan(0);
  // 角色层：只能从启用的里选；角色名有格式
  expect((await page.request.put(`/api/projects/${project.id}/context/roles/bad%20role`, { headers, data: { strategy: 'compaction' } })).status()).toBe(400);
  expect((await page.request.put(`/api/projects/${project.id}/context/roles/coder`, { headers, data: { strategy: 'trim' } })).status()).toBe(400);
  // 手动压缩：不存在 404；不支持的假 ACP 运行时 400
  expect((await page.request.post('/api/sessions/no-such/context/compact', { headers, data: {} })).status()).toBe(404);
  const compact = await page.request.post(`/api/sessions/${sid}/context/compact`, { headers, data: {} });
  expect(compact.status()).toBe(400);
  const audit = await page.request.get(`/api/admin/audit?target=${sid}&limit=20`);
  if (audit.ok()) expect(await audit.text()).toContain('session.context.set');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/p/${project.id}/focus/${sid}`);
  await page.getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: /^详情/ }).click();
  const panel = page.getByRole('complementary', { name: '会话详情' }).getByTestId('session-context');
  await expect(panel.getByTestId('context-strategy')).toContainText('自动压缩');
  await expect(panel.getByTestId('context-strategy')).toHaveAttribute('title', /来自会话设置/);
  await expect(panel.getByTestId('context-usage')).toHaveAttribute('title', /平台估算|运行时报告/);
  await expect(panel.getByTestId('context-gaps')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('session-context-390.png') });

  // 项目设置 · 上下文策略：给角色单独设置，再改回跟随项目
  await page.getByRole('complementary', { name: '会话详情' }).getByRole('button', { name: '关闭' }).click();
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await page.getByRole('button', { name: '项目设置' }).click();
  await page.getByRole('button', { name: '返回设置目录' }).click();
  await page.getByRole('link', { name: '上下文', exact: true }).click();
  const box = page.getByTestId('project-context');
  await expect(box.getByTestId('project-context-strategy')).toHaveValue('compaction');
  await box.getByTestId('project-context-role-input').fill('coder');
  await box.getByTestId('project-context-role-add').click();
  await expect(box.getByTestId('project-context-roles')).toContainText('@coder');
  await page.screenshot({ path: testInfo.outputPath('project-context-390.png') });
  await box.getByRole('button', { name: '改回跟随项目' }).click();
  await expect(box.getByTestId('project-context-roles')).not.toContainText('@coder');
});
