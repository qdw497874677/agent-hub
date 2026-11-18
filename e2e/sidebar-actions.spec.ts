import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { e2eWorkerPath, e2eWorkerRoots } from './isolation.ts';

/**
 * 侧栏会话行的操作菜单（「⋯」和右键）：和画布 / 会话页「⋯」同一套动作。
 * 用假 ACP agent（test-fixtures/fake-agent.mjs）起会话，不调真模型。
 */
const SHOTS = process.env['E2E_SHOTS_DIR'] ?? '/tmp/opencode/shots/sidebar-actions';
const FAKE = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');

interface Ctx {
  readonly projectId: string;
  readonly headers: Record<string, string>;
  readonly derive: (title: string) => Promise<string>;
}

async function withFakeWorker(page: Page, baseURL: string, body: (ctx: Ctx) => Promise<void>): Promise<void> {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  const pairing = await page.request.post('/api/workers/pairing', { data: {}, headers });
  expect(pairing.ok()).toBe(true);
  const code = ((await pairing.json()) as { code: string }).code;
  const hubUrl = `${baseURL.replace(/^http/, 'ws')}/worker`;
  const PATH = e2eWorkerPath();
  const label = `e2e 侧栏菜单 ${Date.now().toString(36)}`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], { env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label }, encoding: 'utf8' });
  expect(enrolled.status).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-sidebar-'));
  const dir = mkdtempSync(join(tmpdir(), 'e2e-sidebar-actions-'));
  let worker: ChildProcess | null = null;
  try {
    worker = spawn(process.execPath, ['apps/worker/src/main.ts'], {
      env: {
        PATH, HOME: state, HUB_URL: hubUrl, HUB_WORKER_CREDENTIAL: credential, WORKER_ID: workerId, WORKER_ORIGIN: 'remote', WORKER_LABEL: label,
        WORKER_ROOTS: e2eWorkerRoots(), WORKER_STATE_DIR: state, WORKER_RUNTIMES_DIR: join(state, 'runtimes'),
        ACP_AGENTS: JSON.stringify([{ id: 'fakeacp', label: '假 ACP', command: process.execPath, args: [FAKE], listModelsArgs: [FAKE, '--models'] }]),
        WORKER_MODEL_CHECK: '0'
      },
      stdio: 'ignore'
    });
    await expect
      .poll(async () => {
        const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ workerId: string; state: string; agentIds?: string[] }>;
        const row = workers.find((candidate) => candidate.workerId === workerId);
        return row?.state === 'online' && (row.agentIds ?? []).includes('fakeacp') ? 'online' : row?.state;
      }, { timeout: 30_000 })
      .toBe('online');
    const project = (await (
      await page.request.post('/api/projects', { data: { name: `e2e 侧栏菜单 ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers })
    ).json()) as { id: string };
    const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '侧栏菜单' }, headers })).json()) as { id: string };
    const derive = async (title: string): Promise<string> => {
      const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: 'fakeacp', model: '' }, headers });
      expect(derived.ok(), await derived.text()).toBe(true);
      const { id } = (await derived.json()) as { id: string };
      expect((await page.request.put(`/api/sessions/${id}/title`, { data: { title }, headers })).ok()).toBe(true);
      // 跑着的会话不能删也不能收起：先停掉
      expect((await page.request.post(`/api/sessions/${id}/interrupt`, { headers })).ok()).toBe(true);
      return id;
    };
    await body({ projectId: project.id, headers, derive });
  } finally {
    worker?.kill();
    await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
    rmSync(state, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

async function canvasSession(page: Page, projectId: string, headers: Record<string, string>, sessionId: string) {
  const canvas = (await (await page.request.get(`/api/projects/${projectId}/canvas`, { headers })).json()) as {
    sessions: { id: string; title?: string | null; settledAt?: number | null; pinned?: boolean }[];
  };
  return canvas.sessions.find((row) => row.id === sessionId) ?? null;
}

test('侧栏会话菜单：改名、键盘操作、收起、删除要确认', async ({ page, baseURL }) => {
  test.setTimeout(150_000);
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await withFakeWorker(page, baseURL ?? '', async ({ projectId, headers, derive }) => {
    const suffix = Date.now().toString(36);
    const first = await derive(`甲-${suffix}`);
    const second = await derive(`乙-${suffix}`);
    await page.goto(`/#/p/${projectId}/list`);
    const sidebar = page.getByTestId('project-sidebar');
    const rowOf = (id: string) => sidebar.locator(`[data-testid="sidebar-session-row"][data-session-id="${id}"]`);
    await expect(rowOf(first)).toBeVisible({ timeout: 30_000 });

    // 桌面上「⋯」平时藏着，悬停才出现
    const more = rowOf(first).getByTestId('sidebar-session-more');
    await expect(more).toHaveCSS('opacity', '0');
    await rowOf(first).hover();
    await expect(more).toHaveCSS('opacity', '1');
    await more.click();
    const menu = page.getByTestId('sidebar-session-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText(['在画布中展开', '重命名', '分叉', '收起', '设为常驻', '删除…']);
    await page.screenshot({ path: join(SHOTS, 'menu-1280.png') });

    // 1) 改名：就地输入，回车保存，服务端落库
    await menu.getByRole('menuitem', { name: '重命名' }).click();
    const input = sidebar.getByTestId('sidebar-rename-input');
    await expect(input).toBeFocused();
    await input.fill(`  甲  改名-${suffix} `);
    await input.press('Enter');
    await expect(rowOf(first).getByTestId('sidebar-session')).toContainText(`甲 改名-${suffix}`);
    await expect.poll(async () => (await canvasSession(page, projectId, headers, first))?.title).toBe(`甲 改名-${suffix}`);
    // 焦点回到这一行
    await expect(rowOf(first).getByTestId('sidebar-session')).toBeFocused();

    // 2) 键盘：Tab 到「⋯」、回车打开、↓ 移动、Esc 关掉并把焦点还给「⋯」
    await page.keyboard.press('Tab');
    await expect(more).toBeFocused();
    await expect(more).toHaveCSS('opacity', '1');
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: '在画布中展开' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: '重命名' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(menu.getByRole('menuitem', { name: '删除…' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();
    // Shift+F10 在行上也能打开（右键菜单的键盘入口）；收起
    await rowOf(first).getByTestId('sidebar-session').focus();
    await page.keyboard.press('Shift+F10');
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: '收起' }).click();
    await expect.poll(async () => (await canvasSession(page, projectId, headers, first))?.settledAt ?? null).not.toBeNull();
    await expect(rowOf(first)).toHaveCount(0);
    await expect(page.getByTestId('sidebar-settled-toggle')).toContainText('已收起 1');

    // 3) 右键 → 删除：先取消（会话还在），再确认（侧栏和服务端都没了）
    await rowOf(second).getByTestId('sidebar-session').click({ button: 'right' });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: '删除…' }).click();
    const dialog = page.getByTestId('session-delete-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`乙-${suffix}`);
    await page.screenshot({ path: join(SHOTS, 'delete-1280.png') });
    await dialog.getByTestId('session-delete-cancel').click();
    await expect(dialog).toHaveCount(0);
    expect(await canvasSession(page, projectId, headers, second)).not.toBeNull();
    await rowOf(second).getByTestId('sidebar-session').click({ button: 'right' });
    await menu.getByRole('menuitem', { name: '删除…' }).click();
    await dialog.getByTestId('session-delete-confirm').click();
    await expect(dialog).toHaveCount(0);
    await expect(rowOf(second)).toHaveCount(0);
    await expect.poll(async () => await canvasSession(page, projectId, headers, second)).toBeNull();

    // 4) 在画布中展开：切到画布，这条会话开成窗口（收起过的也行，画布上还在）
    await page.getByTestId('sidebar-settled-toggle').click();
    await rowOf(first).getByTestId('sidebar-session-more').click();
    await menu.getByRole('menuitem', { name: '在画布中展开' }).click();
    await expect(page).toHaveURL(new RegExp(`/p/${projectId}/canvas`));
    await expect(page.locator(`[data-testid="canvas-window"][data-session-id="${first}"]`)).toBeVisible({ timeout: 20_000 });
  });
});

test('侧栏会话菜单：手机 390px 上「⋯」常驻，菜单不出屏', async ({ page, baseURL }) => {
  test.setTimeout(150_000);
  mkdirSync(SHOTS, { recursive: true });
  const context = await page.context().browser()!.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await context.newPage();
  try {
    await withFakeWorker(phone, baseURL ?? '', async ({ projectId, headers, derive }) => {
      const suffix = Date.now().toString(36);
      const id = await derive(`手机-${suffix}`);
      await phone.goto(`/#/p/${projectId}/list`);
      await phone.getByRole('button', { name: '打开侧栏' }).click();
      // 桌面那份侧栏在手机上藏着（同一份组件挂两次），只看抽屉里的
      const sidebar = phone.getByTestId('project-sidebar').filter({ visible: true });
      const row = sidebar.locator(`[data-testid="sidebar-session-row"][data-session-id="${id}"]`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      const more = row.getByTestId('sidebar-session-more');
      await expect(more).toHaveCSS('opacity', '1');
      // 触控区和侧栏里其它图标按钮（关闭侧栏）一样大
      const box = await more.boundingBox();
      const close = await sidebar.getByRole('button', { name: '关闭侧栏' }).boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(close?.width ?? 40);
      await more.tap();
      const menu = phone.getByTestId('sidebar-session-menu');
      await expect(menu).toBeVisible();
      const rect = await menu.boundingBox();
      expect(rect).not.toBeNull();
      expect(rect!.x).toBeGreaterThanOrEqual(0);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(390);
      expect(rect!.y + rect!.height).toBeLessThanOrEqual(844);
      await phone.screenshot({ path: join(SHOTS, 'menu-390.png') });
      await menu.getByRole('menuitem', { name: '设为常驻' }).tap();
      await expect.poll(async () => (await canvasSession(phone, projectId, headers, id))?.pinned).toBe(true);
    });
  } finally {
    await context.close();
  }
});
