import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * ADR 0025 · 工作空间文件浏览 P1（390px 手机）：目录下钻、预览、敏感文件确认、被忽略的灰显、
 * 改动列表 + diff、实时刷新（新建文件后列表自己出现）、路径越界拒绝。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'] ?? '/workspace/shots/files';

test('文件浏览：下钻、预览、敏感确认、改动 diff、实时刷新', async ({ page, baseURL }) => {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  expect((await page.request.get('/api/sessions/no-such/files?path=')).status()).toBe(404);

  let agentId: string | undefined;
  for (let i = 0; i < 40 && !agentId; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((worker) => worker.state === 'online')?.agentIds[0];
    if (!agentId) await page.waitForTimeout(500);
  }
  test.skip(!agentId, '这台机器上没有可用的 agent');

  const root = mkdtempSync(join(tmpdir(), 'e2e-files-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@x', ...args], { cwd: root });
  git('init', '-q');
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'src/app.ts'), 'export const answer = 41;\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(root, 'node_modules/x.js'), '1');
  writeFileSync(join(root, '.env'), 'SECRET=not-real\n');
  git('add', 'src', '.gitignore');
  git('commit', '-qm', 'init');

  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 文件 ${Date.now().toString(36)}`, rootPath: root }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '文件' }, headers })).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers });
  expect(derived.status(), await derived.text()).toBe(201);
  const sid = ((await derived.json()) as { id: string }).id;

  // 接口：越界 / .git 拒绝，敏感文件不确认 403/400
  for (const bad of ['../', '.git', '/etc']) expect((await page.request.get(`/api/sessions/${sid}/files?path=${encodeURIComponent(bad)}`)).status()).toBe(400);
  const listing = await page.request.get(`/api/sessions/${sid}/files?path=`);
  expect(listing.status(), await listing.text()).toBe(200);
  const names = ((await listing.json()) as { entries: { name: string; ignored: boolean; sensitive: boolean }[] }).entries;
  expect(names.map((e) => e.name)).not.toContain('.git');
  expect(names.find((e) => e.name === 'node_modules')?.ignored).toBe(true);
  expect(names.find((e) => e.name === '.env')?.sensitive).toBe(true);
  expect((await page.request.get(`/api/sessions/${sid}/files/content?path=.env`)).ok()).toBe(false);
  expect((await page.request.get(`/api/sessions/${sid}/files/content?path=.env&confirm=1`)).status()).toBe(200);
  const dl = await page.request.get(`/api/sessions/${sid}/files/download?path=src%2Fapp.ts`);
  expect(dl.headers()['content-disposition']).toContain('app.ts');
  expect(await dl.text()).toContain('answer');

  writeFileSync(join(root, 'src/app.ts'), 'export const answer = 42;\n');
  const changes = (await (await page.request.get(`/api/sessions/${sid}/git/changes?base=head`)).json()) as { files: { path: string }[] };
  expect(changes.files.map((f) => f.path)).toContain('src/app.ts');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/p/${project.id}/focus/${sid}`);
  await page.getByRole('button', { name: '详情' }).click();
  await page.getByTestId('open-files').click();
  const browser = page.getByTestId('files-browser');
  await expect(browser.locator('[data-path="src"]')).toBeVisible();
  await expect(browser.locator('[data-path=".env"]')).toHaveCount(0);
  await expect(browser.locator('[data-path="node_modules"]')).toHaveClass(/opacity-50/);
  await browser.locator('[data-path="src"]').click();
  await browser.locator('[data-path="src/app.ts"]').click();
  await expect(browser.getByTestId('file-content')).toContainText('answer = 42');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/file-390.png` });
  await browser.getByTestId('files-back').click();

  // 实时：Worker 上新建文件，展开着的目录自己刷新
  writeFileSync(join(root, 'src/new.ts'), 'x');
  await expect(browser.locator('[data-path="src/new.ts"]')).toBeVisible({ timeout: 15_000 });

  // 敏感：勾上才显示，打开要确认
  await browser.getByTestId('files-show-sensitive').check();
  page.once('dialog', (d) => void d.accept());
  await browser.locator('[data-path=".env"]').click();
  await expect(browser.getByTestId('file-content')).toContainText('SECRET');
  await browser.getByTestId('files-back').click();

  // 改动：列表 + diff
  await browser.getByTestId('files-tab-changes').click();
  await browser.getByTestId('changes-base').selectOption('head');
  await browser.getByTestId('change-row').filter({ hasText: 'src/app.ts' }).click();
  await expect(browser.getByTestId('diff-view')).toContainText('42');
  await page.screenshot({ path: `${SHOTS}/diff-390.png` });
  await browser.getByTestId('files-close').click();
  await expect(browser).toHaveCount(0);
});
