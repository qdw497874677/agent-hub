import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { openSessionTool } from './session-tools.ts';

/**
 * VibeX 第三期：仓库阅读的导航（docs/design/vibex-borrowing.md）。
 *
 * - 手机上「返回列表」和「清掉所选文件」是两件事：返回后列表还是同一页（展开、滚动），
 *   范围还是那个范围，刚看过的文件仍然高亮，键盘焦点回到那一行。
 * - 正文自己写着在比什么（列表标题、正文顶栏、桌面空正文共用一句），不靠切回去确认。
 * - 这些范围都不是任意 Git 版本，文案不能暗示能「和任意提交比」。
 * - 只取真正打开的那一个文件的 diff：换范围、切文件都不会顺手把别的文件或范围拉下来。
 */
const SHOTS = process.env['E2E_SCREENSHOTS_NAV'] ?? '/tmp/opencode/shots/files-nav';
test.afterAll(stopFakeWorker);

async function setup(page: Page, baseURL: string) {
  await loginByApi(page);
  const workerId = await ensureFakeWorker(page, baseURL);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  const root = mkdtempSync(join(tmpdir(), 'e2e-files-nav-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@x', ...args], { cwd: root });
  git('init', '-q');
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'many'));
  writeFileSync(join(root, 'src/app.ts'), 'export const answer = 41;\n');
  writeFileSync(join(root, 'README.md'), '# demo\n');
  // 够长，手机上目录列表真的能滚：返回时滚到哪儿还在哪儿
  for (let i = 0; i < 40; i++) writeFileSync(join(root, 'many', `f${i}.ts`), `export const n${i} = ${i}; // file ${i}\n`);
  git('add', '.');
  git('commit', '-qm', 'init');
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 导航 ${Date.now().toString(36)}`, rootPath: root, workerId }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '仓库导航' }, headers })).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: FAKE_AGENT_ID, model: '' }, headers });
  expect(derived.status(), await derived.text()).toBe(201);
  const sid = ((await derived.json()) as { id: string }).id;
  // 会话开始之后才改：和会话起点比时看得到
  writeFileSync(join(root, 'src/app.ts'), 'export const answer = 42;\n');
  return { projectId: project.id, sid };
}

/** 记下每个 diff 请求带的 path：断言只取了选中的文件，没预先拉别的。 */
function watchDiffs(page: Page): string[] {
  const paths: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.endsWith('/git/diff')) return;
    paths.push(url.searchParams.get('path') ?? '');
  });
  return paths;
}

test('手机读文件：返回后列表还是那一页，焦点回到刚看过的文件（390）', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  mkdirSync(SHOTS, { recursive: true });
  const { projectId, sid } = await setup(page, baseURL!);
  const diffs = watchDiffs(page);
  await page.goto(`/#/p/${projectId}/focus/${sid}`);
  await openSessionTool(page, 'files');
  const files = page.getByTestId('files-panel-files');
  const list = files.getByTestId('files-list');
  const tree = files.getByTestId('files-tree');
  await files.locator('[data-path="many"]').click();
  await expect(files.locator('[data-path="many/f0.ts"]')).toBeVisible();
  // 滚到中间再进去：返回时不能跳回顶部
  await tree.evaluate((el) => {
    el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) / 2);
  });
  const scrolled = await tree.evaluate((el) => el.scrollTop);
  expect(scrolled).toBeGreaterThan(0);
  const findY = (await files.getByTestId('files-find').boundingBox())!.y;
  await files.locator('[data-path="many/f20.ts"]').click();
  await expect(files.getByTestId('file-content')).toContainText('file 20');
  // 读正文时列表整页让位，不是两半挤在一起
  await expect(list).toBeHidden();
  await expect(files.getByTestId('files-back')).toBeFocused();
  await page.screenshot({ path: `${SHOTS}/mobile-read.png` });

  await files.getByTestId('files-back').click();
  await expect(list).toBeVisible();
  await expect(files.getByTestId('file-content')).toHaveCount(0);
  const row = files.locator('[data-path="many/f20.ts"]');
  // 返回后：目录仍然展开、这个文件仍然算「当前项」，焦点也在它身上（不用重新 Tab 一大圈）
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(row).toBeFocused();
  const after = await tree.evaluate((el) => el.scrollTop);
  expect(Math.abs(after - scrolled)).toBeLessThan(40);
  // 列表头（根路径）没被挤扁：滚回来的是列表里的内容，不是整页
  const rootBox = await files.getByTestId('files-root').boundingBox();
  expect(rootBox?.height ?? 0).toBeGreaterThan(14);
  // 整页没被焦点带得挪位：找文件那一行还在原来的位置
  const findBackY = (await files.getByTestId('files-find').boundingBox())!.y;
  expect(Math.abs(findBackY - findY)).toBeLessThan(1);
  // 文件页的正文不比较任何东西，不该有范围行，也不该请求 diff
  expect(diffs).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/mobile-back.png` });
});

test('手机改动页：返回后范围与选中文件都还在，正文自己写着比的是什么（390）', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  mkdirSync(SHOTS, { recursive: true });
  const { projectId, sid } = await setup(page, baseURL!);
  const diffs = watchDiffs(page);
  await page.goto(`/#/p/${projectId}/focus/${sid}`);
  await openSessionTool(page, 'changes');
  const changes = page.getByTestId('files-panel-changes');
  await expect(changes.getByTestId('changes-base')).toHaveValue('session');
  await expect(changes.getByTestId('changes-scope')).toContainText('工作树 vs 会话起点');
  await changes.getByTestId('changes-base').selectOption('head');
  await expect(changes.getByTestId('changes-scope')).toContainText('工作树 vs 当前 HEAD');
  // 说清边界：工作树含着没提交的改动
  await expect(changes.getByTestId('changes-scope')).toContainText('含未提交改动');
  await page.waitForTimeout(300);
  // 只换范围、还没选文件：一个 diff 都不该请求
  expect(diffs).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/mobile-changes-list.png` });

  const row = changes.getByTestId('change-row').filter({ hasText: 'src/app.ts' });
  await row.click();
  await expect(changes.getByTestId('diff-view')).toContainText('42');
  await expect(changes.getByTestId('diff-range')).toContainText('范围 工作树 vs 当前 HEAD');
  await expect(changes.getByTestId('diff-range')).toContainText('含未提交改动');
  await expect(changes.getByTestId('files-list')).toBeHidden();
  expect(diffs).toEqual(['src/app.ts']);
  await page.screenshot({ path: `${SHOTS}/mobile-diff.png` });

  // Esc 等于返回；回来还是刚才那个范围
  await page.keyboard.press('Escape');
  await expect(changes.getByTestId('files-list')).toBeVisible();
  await expect(changes.getByTestId('diff-view')).toHaveCount(0);
  await expect(changes.getByTestId('changes-base')).toHaveValue('head');
  await expect(changes.getByTestId('changes-scope')).toContainText('工作树 vs 当前 HEAD');
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(row).toBeFocused();

  // 「返回」按钮同样把焦点交回那一行；再打开也只是同一个文件
  await row.click();
  await expect(changes.getByTestId('diff-view')).toBeVisible();
  await changes.getByTestId('files-back').click();
  await expect(row).toBeFocused();
  expect(new Set(diffs)).toEqual(new Set(['src/app.ts']));

  // 回到会话范围也照原样说，不把「会话起点」说成任意版本
  await changes.getByTestId('changes-base').selectOption('session');
  await expect(changes.getByTestId('changes-scope')).toContainText('工作树 vs 会话起点');
  await expect(changes.getByTestId('changes-base').locator('option')).toHaveText([
    '会话开始以来',
    '相对当前 HEAD',
    '相对分支起点'
  ]);
});

test('桌面改动页：左边列表右边正文，没选文件先说清范围，只重取选中的那个文件（1280）', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  mkdirSync(SHOTS, { recursive: true });
  const { projectId, sid } = await setup(page, baseURL!);
  const diffs = watchDiffs(page);
  await page.goto(`/#/p/${projectId}/focus/${sid}`);
  await page.getByTestId('session-tab-changes').click();
  await page.getByTestId('changes-split-toggle').click();
  const changes = page.getByTestId('files-panel-changes');
  // 分栏：列表和正文同时在，正文空着时先交代范围
  await expect(changes.getByTestId('files-list')).toBeVisible();
  await expect(changes.getByTestId('reader-empty')).toContainText('选一个改动看');
  await expect(changes.getByTestId('reader-scope')).toContainText('工作树 vs 会话起点');
  await expect(changes.getByTestId('changes-scope')).toContainText('工作树 vs 会话起点');
  await page.waitForTimeout(300);
  expect(diffs).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/desktop-empty.png` });

  const row = changes.getByTestId('change-row').filter({ hasText: 'src/app.ts' });
  await row.click();
  await expect(changes.getByTestId('diff-view')).toContainText('42');
  // 正文自带范围行，桌面不用回列表确认
  await expect(changes.getByTestId('diff-range')).toContainText('范围 工作树 vs 会话起点');
  await expect(changes.getByTestId('file-path')).toContainText('src/app.ts');
  // 桌面没有「返回」，列表一直在
  await expect(changes.getByTestId('files-list')).toBeVisible();
  await expect(changes.getByTestId('files-back')).toHaveCount(0);
  expect(diffs).toEqual(['src/app.ts']);
  await page.screenshot({ path: `${SHOTS}/desktop-diff.png` });

  // 换范围：只重取当前这一个文件，不预取别的文件、也不预取别的范围
  await changes.getByTestId('changes-base').selectOption('head');
  await expect(changes.getByTestId('diff-range')).toContainText('范围 工作树 vs 当前 HEAD');
  await expect(changes.getByTestId('changes-scope')).toContainText('工作树 vs 当前 HEAD');
  await expect.poll(() => diffs.length, { timeout: 15_000 }).toBe(2);
  expect(new Set(diffs)).toEqual(new Set(['src/app.ts']));

  // 回到会话范围，读的还是同一个文件：正文范围跟着变，列表高亮跟着走
  await changes.getByTestId('changes-base').selectOption('session');
  await expect(changes.getByTestId('diff-range')).toContainText('范围 工作树 vs 会话起点');
  await expect(changes.getByTestId('file-path')).toContainText('src/app.ts');
  await expect(changes.getByTestId('change-row').filter({ hasText: 'src/app.ts' })).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => diffs.length, { timeout: 15_000 }).toBe(3);
  expect(new Set(diffs)).toEqual(new Set(['src/app.ts']));
});
