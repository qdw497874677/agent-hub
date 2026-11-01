import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';

/** ADR 0024 · 模型版提炼：项目设置里选提炼模型；默认规则版；只能选已注册、项目能用的 hub 模型（390px）。 */
const SHOTS = process.env['E2E_SCREENSHOTS'] ?? '/workspace/shots/distill';

test('会后提炼：默认规则版；乱填的模型被拒；项目设置里有下拉框', async ({ page, baseURL }) => {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 提炼 ${Date.now().toString(36)}`, rootPath: mkdtempSync(join(tmpdir(), 'e2e-distill-')) }, headers })).json()) as { id: string };
  const path = `/api/projects/${project.id}/memory/distill`;
  expect(await (await page.request.get(path)).json()).toMatchObject({ model: null });
  expect((await page.request.put(path, { headers, data: { model: 123 } })).status()).toBe(400);
  expect((await page.request.put(path, { headers, data: { model: 'gpt-4o' } })).status()).toBe(400);
  expect((await page.request.put(path, { headers, data: { model: 'hub-no-such/x' } })).status()).toBe(400);
  expect((await page.request.put(path, { headers, data: { model: null } })).status()).toBe(200);
  expect(await (await page.request.get(path)).json()).toMatchObject({ enabled: true });
  expect((await page.request.put(path, { headers, data: { enabled: 'no' } })).status()).toBe(400);
  expect((await page.request.put(path, { headers, data: {} })).status()).toBe(400);
  expect((await page.request.get(`/api/providers/models?projectId=${project.id}`)).ok()).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/p/${project.id}`);
  await page.getByRole('button', { name: '项目设置' }).click();
  const box = page.getByTestId('project-distill');
  await expect(box.getByTestId('project-distill-model')).toHaveValue('');
  await expect(box.getByTestId('project-distill-model')).toContainText('规则版');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const toggle = box.getByTestId('project-distill-enabled');
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(box.getByTestId('project-distill-model')).toBeDisabled();
  expect(await (await page.request.get(path)).json()).toMatchObject({ enabled: false });
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/project-distill-390.png` });
});
