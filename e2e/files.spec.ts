import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { backToChat, openSessionTool } from './session-tools.ts';

/**
 * ADR 0025 · 工作目录文件浏览 P1（390px 手机）：目录下钻、预览、敏感文件确认、被忽略的灰显、
 * 改动列表 + diff、实时刷新（新建文件后列表自己出现）、路径越界拒绝。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'] ?? '/tmp/opencode/shots/files';
mkdirSync(SHOTS, { recursive: true });
test.afterAll(stopFakeWorker);

test('文件浏览：下钻、预览、敏感确认、改动 diff、实时刷新', async ({ page, baseURL }) => {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  expect((await page.request.get('/api/sessions/no-such/files?path=')).status()).toBe(404);

  const workerId = await ensureFakeWorker(page, baseURL!);

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

  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 文件 ${Date.now().toString(36)}`, rootPath: root, workerId }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '文件' }, headers })).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: FAKE_AGENT_ID, model: '' }, headers });
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
  // 手机上「详情」收进了「更多」菜单（IA 分层改动之后）。
  await page.getByRole('button', { name: '更多' }).click();
  await page.getByTestId('session-more-details').click();
  await page.getByRole('menuitem', { name: /^详情/ }).click();
  await page.getByTestId('open-files').click();
  // 详情 → 浏览文件：关掉详情，切到会话的「文件」标签页（不再是全屏浮层）
  await expect(page.getByTestId('session-back-to-chat')).toBeVisible();
  await expect(page.getByTestId('open-files')).toBeHidden();
  const browser = page.getByTestId('files-panel-files');
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
  await openSessionTool(page, 'changes');
  const changesPanel = page.getByTestId('files-panel-changes');
  await changesPanel.getByTestId('changes-base').selectOption('head');
  await changesPanel.getByTestId('change-row').filter({ hasText: 'src/app.ts' }).click();
  await expect(changesPanel.getByTestId('diff-view')).toContainText('42');
  await page.screenshot({ path: `${SHOTS}/diff-390.png` });
  await backToChat(page);
  await expect(page.getByTestId('files-panel-changes')).toBeHidden();
});

/** 桌面端：根目录整行显示（不再被截断成一行省略号），文件列表宽度可拖、刷新后记得。 */
test('文件浏览（桌面）：根目录完整、列表宽度可拖动并记住', async ({ page, baseURL }) => {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const workerId = await ensureFakeWorker(page, baseURL!);

  const root = mkdtempSync(join(tmpdir(), 'e2e-files-desktop-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 桌面 ${Date.now().toString(36)}`, rootPath: root, workerId }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '文件' }, headers })).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: FAKE_AGENT_ID, model: '' }, headers });
  expect(derived.status(), await derived.text()).toBe(201);
  const sid = ((await derived.json()) as { id: string }).id;

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/#/p/${project.id}/focus/${sid}`);
  await page.getByTestId('session-tab-files').click();
  const browser = page.getByTestId('files-panel-files');
  const rootLine = browser.getByTestId('files-root');
  await expect(rootLine).toHaveText(root);
  await expect(rootLine).not.toContainText('…');

  const aside = browser.locator('aside');
  const before = (await aside.boundingBox())!.width;
  const handle = browser.getByTestId('files-resizer');
  await expect(handle).toHaveAttribute('aria-orientation', 'vertical');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  const after = (await aside.boundingBox())!.width;
  expect(after).toBeGreaterThan(before + 80);
  expect(await page.evaluate(() => localStorage.getItem('agent-hub:files-list-width'))).toBe(String(Math.round(after)));

  await page.reload();
  await expect(page.getByTestId('session-tab-files')).toHaveAttribute('aria-pressed', 'true');
  const reloaded = (await page.getByTestId('files-panel-files').locator('aside').boundingBox())!.width;
  expect(Math.abs(reloaded - after)).toBeLessThan(2);
  await page.screenshot({ path: `${SHOTS}/file-1280.png` });
});
