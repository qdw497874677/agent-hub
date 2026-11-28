import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { readHubLog, reservePort, spawnHub, stop } from '../apps/server/src/test-support/spawn.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { TEST_EMAIL } from './login.ts';

type Terminal = { id: string; state: 'pending' | 'running' | 'closing' | 'ended' };
const shots = process.env['E2E_SCREENSHOTS'];

async function fixture(page: Page, root: string, grant = true) {
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const passwordFile = join(root, 'password');
  const log = join(root, 'hub.log');
  const home = join(root, 'home');
  mkdirSync(home);
  const start = async (grants: unknown[] = [], enabled = true) => {
    const child = spawnHub(process.execPath, ['apps/server/src/main.ts'], {
      env: {
        PATH: process.env.PATH, HOME: home, TMPDIR: root,
        HUB_HOST: '127.0.0.1', HUB_PORT: String(port), HUB_PUBLIC_URL: origin, HUB_DATA_DIR: join(root, 'data'),
        HUB_TEST_ACCOUNT_FILE: passwordFile, HUB_SPAWN_WORKER: '0', HUB_WORKDIR_TERMINALS: enabled ? '1' : '0',
        HUB_WORKDIR_SHELL_GRANTS: JSON.stringify(grants)
      }, logFile: log
    });
    try {
      await expect.poll(async () => (await fetch(`${origin}/api/health`).catch(() => null))?.status ?? child.exitCode, { timeout: 30_000 }).toBe(200);
      return child;
    } catch (error) {
      await stop(child);
      throw new Error(`隔离 Hub 启动失败：${readHubLog(log)}`, { cause: error });
    }
  };
  let hub = await start();
  const api = async <T>(path: string, data?: unknown, expected = data === undefined ? 200 : 201, method = 'POST') => {
    const csrf = (await page.context().cookies(origin)).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
    const headers = { origin, 'x-hub-csrf': csrf };
    const r = data === undefined ? await page.request.get(`${origin}${path}`) : await page.request.fetch(`${origin}${path}`, { method, headers, data });
    expect(r.status(), `${path}: ${await r.text()}`).toBe(expected);
    return await r.json() as T;
  };
  const signIn = () => api('/api/auth/login', { email: TEST_EMAIL, password: readFileSync(passwordFile, 'utf8').trim() }, 200);
  try {
    await signIn();
    const { user } = await api<{ user: { id: string } }>('/api/auth/state');
    const workerId = await ensureFakeWorker(page, origin, FAKE_AGENT_ID, { env: { TERMINAL_SHELL: '/bin/sh', WORKER_WORKDIR_TERMINAL: '1' } });
    const project = await api<{ id: string }>('/api/projects', { name: '独立终端测试' });
    const path = join(root, 'registered-directories-with-the-same-prefix', 'a-long-checkout-parent-for-mobile-path-wrapping', 'workdir');
    mkdirSync(path, { recursive: true });
    const workdir = await api<{ id: string }>(`/api/projects/${project.id}/workspaces`, { kind: 'long_lived', mode: 'empty', workerId, path });
    const terminals = `/api/projects/${project.id}/workdir-tabs/${workdir.id}/terminals`;
    // Explicitly prove that project ownership and Worker access alone are not a shell grant.
    await api(terminals, undefined, 403);
    const grants = [{ userId: user.id, workerId }];
    const restart = async (enabled = true) => {
      await stop(hub);
      hub = await start(grants, enabled);
      await signIn();
      await expect.poll(async () => {
        const workers = await api<Array<{ id?: string; workerId?: string; state: string }>>('/api/workers');
        return workers.some((worker) => (worker.workerId ?? worker.id) === workerId && worker.state === 'online');
      }, { timeout: 35_000 }).toBe(true);
      await expect.poll(async () => (await api<{ available: boolean }>(terminals)).available).toBe(enabled);
    };
    if (grant) await restart();
    return { origin, projectId: project.id, workspaceId: workdir.id, workerId, path, terminals, restart, api, stop: () => stop(hub) };
  } catch (error) {
    await stop(hub);
    throw error;
  }
}

for (const width of [1280, 390]) {
  const touch = width < 640;
  test.describe(`工作目录标签 ${width}px`, () => {
    test.use({ viewport: { width, height: touch ? 620 : 844 }, hasTouch: touch, isMobile: touch });
    test('未获终端授权不影响正常会话，标签优先使用会话和任务标题', async ({ page }) => {
      const root = mkdtempSync(join(tmpdir(), 'workdir-labels-'));
      let world: Awaited<ReturnType<typeof fixture>> | null = null;
      try {
        world = await fixture(page, root, false);
        const { api, origin, projectId, workspaceId, workerId, terminals } = world;
        const task = await api<{ id: string }>('/api/tasks', { projectId, title: '测试任务标题' });
        const start = () => api<{ id: string }>('/api/sessions/derive', { taskId: task.id, workerId, workspaceId, agentId: FAKE_AGENT_ID, model: '' });
        const first = await start();
        const second = await start();
        let terminalReads = 0;
        page.on('request', (request) => {
          if (request.method() === 'GET' && new URL(request.url()).pathname === terminals) terminalReads++;
        });
        await page.goto(`${origin}/#/p/${projectId}/workdir/${workspaceId}`);
        const tabs = page.getByTestId('session-document-tabs');
        const trigger = tabs.getByTestId('session-tab-trigger');
        const picker = page.getByTestId('session-tab-picker');
        const addMenu = touch ? page.getByTestId('session-tab-add-sheet') : tabs;
        const unavailable = addMenu.getByRole('status');
        const openAdd = async () => {
          if (touch) await trigger.click();
          await page.getByTestId('session-tab-add').click();
        };
        const openExisting = async (id: string) => {
          await trigger.click();
          await page.getByTestId('session-tab-picker').locator(`[data-testid="session-tab-open-existing"][data-session-id="${id}"]`).click();
        };
        await openAdd();
        await expect(unavailable).toContainText('终端');
        await expect(addMenu.getByTestId('session-tab-new-terminal')).toBeDisabled();
        await expect(addMenu.getByTestId('session-tab-new-session')).toBeEnabled();
        await page.keyboard.press('Escape');
        await openExisting(first.id);
        await expect(page.getByTestId('focus-header')).toContainText('测试任务标题');
        const legacy = await page.request.get(`${origin}/api/sessions/${first.id}/terminal-availability`);
        expect(legacy.status(), await legacy.text()).toBe(200);
        expect(await legacy.json()).toEqual({ available: false });
        await openAdd();
        await expect(addMenu.getByTestId('session-tab-new-terminal')).toBeDisabled();
        await page.keyboard.press('Escape');
        await trigger.click();
        const activeTab = picker.locator(`[data-testid="session-tab-item"][data-session-id="${first.id}"]`);
        await expect(activeTab).toContainText('测试任务标题');
        await expect(activeTab).not.toContainText(first.id.slice(-4));
        await expect(unavailable).toBeHidden();
        await expect(page.getByText('工作目录不可用', { exact: true })).toHaveCount(0);
        await page.keyboard.press('Escape');

        await openExisting(second.id);
        await trigger.click();
        const options = picker.locator('[data-testid="session-tab-item"][data-session-id]');
        await expect(options).toHaveCount(2);
        for (const session of [first, second]) {
          await expect(options.filter({ hasText: session.id.slice(-4) })).toContainText('测试任务标题');
        }
        await page.keyboard.press('Escape');
        const renamed = '一个会话的自定义标题，名字很长也不能遮住右边的新增按钮';
        await api(`/api/sessions/${second.id}/title`, { title: renamed }, 200, 'PUT');
        // Measure across the old 3 s interval: the authoritative 403 is not a retry loop.
        await expect.poll(() => terminalReads).toBe(1);
        await expect(page.getByTestId('focus-header')).toBeVisible();
        await page.clock.install();
        await page.clock.runFor(6_100);
        expect(terminalReads).toBe(1);
        await expect(page.getByLabel('发送消息')).toBeVisible();
        await page.reload();
        await expect(page.getByTestId('focus-header')).toContainText(renamed);
        if (touch) {
          await expect(trigger).toBeInViewport({ ratio: 1 });
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
        }
        await trigger.click();
        await expect(options.filter({ hasText: renamed })).toHaveCount(1);
      } finally {
        stopFakeWorker();
        if (world) await world.stop();
        rmSync(root, { recursive: true, force: true });
      }
    });

    test('无会话时可开真实 PTY；切换与刷新不断进程，关标签才释放目录', async ({ page }) => {
      test.setTimeout(150_000);
      const root = mkdtempSync(join(tmpdir(), 'workdir-tabs-'));
      let world: Awaited<ReturnType<typeof fixture>> | null = null;
      try {
        world = await fixture(page, root);
        const { api, origin, projectId, workspaceId, workerId, terminals, path } = world;
        const otherPath = `${path}-other`;
        mkdirSync(otherPath);
        const sibling = await api<{ id: string }>(`/api/projects/${projectId}/workspaces`, { kind: 'long_lived', mode: 'empty', workerId, path: otherPath });
        const canvasPath = `/api/projects/${projectId}/canvas`;
        expect((await api<{ sessions: unknown[] }>(canvasPath)).sessions).toHaveLength(0);
        await page.goto(`${origin}/#/p/${projectId}/list`);
        const entries = page.getByTestId('list-view').getByRole('region', { name: '登记的工作目录' });
        const entry = (id: string) => entries.locator(`[data-testid="workdir-entry"][data-workspace-id="${id}"]`);
        for (const [id, expected] of [[workspaceId, path], [sibling.id, otherPath]] as const) {
          const displayed = entry(id).getByTestId('workdir-entry-path');
          await expect(displayed).toBeVisible();
          await expect(displayed).toHaveText(expected);
          // A truncated span still contains the full string in the DOM. Check the rendered text fits.
          const { fits, lines } = await displayed.evaluate((node) => {
            const box = node.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(node);
            const rects = [...range.getClientRects()];
            return { fits: rects.length > 0 && rects.every((line) => line.left >= box.left - 1 && line.right <= box.right + 1 && line.bottom <= box.bottom + 1), lines: rects.length };
          });
          expect(fits).toBe(true);
          if (touch) expect(lines).toBeGreaterThan(1);
        }
        if (shots) await page.screenshot({ path: join(shots, `registered-workdir-paths-${width}.png`) });
        await entry(workspaceId).click();
        const tabs = page.getByTestId('session-document-tabs');
        const trigger = tabs.getByTestId('session-tab-trigger');
        const picker = page.getByTestId('session-tab-picker');
        const addMenu = touch ? page.getByTestId('session-tab-add-sheet') : tabs;
        const openAdd = async () => {
          if (touch) await trigger.click();
          await page.getByTestId('session-tab-add').click();
        };
        await openAdd();
        await addMenu.getByTestId('session-tab-new-terminal').click();
        const status = page.getByTestId('terminal-status');
        await expect(status).toContainText('已连接');
        if (shots) await page.screenshot({ path: join(shots, `workdir-terminal-${width}.png`) });
        const inventory = () => api<{ terminals: Terminal[] }>(terminals).then((rows) => rows.terminals);
        const first = (await inventory())[0]!;
        expect(first.state).toBe('running');
        const type = async (command: string) => {
          const input = page.locator('.xterm-helper-textarea');
          await input.focus();
          await page.keyboard.insertText(command);
          await page.keyboard.press('Enter');
        };
        const proof = join(path, 'process-proof');
        await type('printf "%s\\n%s\\n" "$PWD" "$$" >process-proof');
        await expect.poll(() => existsSync(proof)).toBe(true);
        const [cwd, pid] = readFileSync(proof, 'utf8').trim().split('\n');
        expect(cwd).toBe(path);
        expect(Number(pid)).toBeGreaterThan(1);
        // Keep a real child PID under the native shell's own lifecycle, not only a status label.
        const alive = () => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
        expect(alive()).toBe(true);
        if (touch) {
          expect((await trigger.boundingBox())!.height).toBeGreaterThanOrEqual(44);
          const keys = (await page.getByTestId('terminal-keys').boundingBox())!;
          expect(keys.y + keys.height).toBeLessThanOrEqual(621);
        }

        const task = await api<{ id: string }>('/api/tasks', { projectId, title: '会话共享同目录' });
        const session = await api<{ id: string }>('/api/sessions/derive', { taskId: task.id, workerId, workspaceId, agentId: FAKE_AGENT_ID, model: '' });
        await page.reload();
        await expect(status).toContainText('已连接');
        await trigger.click();
        await page.getByTestId('session-tab-picker').locator(`[data-testid="session-tab-open-existing"][data-session-id="${session.id}"]`).click();
        const composer = page.getByLabel('发送消息');
        await composer.fill('只回这段文字，不要用工具：OK');
        await composer.press('Control+Enter');
        await expect(page.getByRole('log').getByText('OK', { exact: true })).toBeVisible();
        await composer.fill('这个草稿随标签切换保留');
        const select = async (kind: 'session' | 'terminal') => {
          await trigger.click();
          await picker.locator(`[data-testid="session-tab-item"][data-${kind}-id]`).click();
        };
        await select('terminal');
        await expect(status).toContainText('已连接');
        await type('printf "%s\\n" "$$" >reattached');
        const proof2 = join(path, 'reattached');
        await expect.poll(() => existsSync(proof2)).toBe(true);
        expect(readFileSync(proof2, 'utf8').trim()).toBe(pid);
        await select('session');
        await expect(composer).toHaveValue('这个草稿随标签切换保留');
        if (shots) await page.screenshot({ path: join(shots, `workdir-session-${width}.png`) });
        await trigger.click();
        await picker.locator(`[data-testid="session-tab-close"][data-session-id="${session.id}"]`).click();
        await expect(page.getByTestId('session-tab-close').and(page.locator('[data-session-id]'))).toHaveCount(0);
        expect((await api<{ sessions: Array<{ id: string }> }>(canvasPath)).sessions[0]?.id).toBe(session.id);

        const other = await api<{ id: string }>(`/api/projects/${projectId}/workspaces`, { kind: 'long_lived', mode: 'empty', workerId });
        await api(`/api/workspaces/${other.id}/remove`, { deleteDirectory: true, force: true }, 409);
        // Restart without the feature flag: old PTY remains attached to its durable scope, but no new PTY is allowed.
        if (!touch) {
          await world.restart(false);
          const disabled = await api<{ available: boolean; reason?: string; terminals: Terminal[] }>(terminals);
          expect(disabled).toMatchObject({ available: false, reason: '工作目录终端未启用', terminals: [{ id: first.id, state: 'running' }] });
          await api(terminals, { requestId: 'disabled-must-not-create' }, 503);
          await api(`/api/workspaces/${other.id}/remove`, { deleteDirectory: true, force: true }, 409);
        }
        await page.reload();
        if (!touch) {
          await openAdd();
          await expect(addMenu.getByTestId('session-tab-new-terminal')).toBeDisabled();
          await page.keyboard.press('Escape');
        }
        await select('terminal');
        await expect(status).toContainText('已连接');
        expect(alive()).toBe(true);
        await trigger.click();
        await picker.locator(`[data-testid="session-tab-close"][data-terminal-id="${first.id}"]`).click();
        await expect.poll(async () => (await inventory()).find((row) => row.id === first.id)?.state).toBe('ended');
        await expect.poll(alive).toBe(false);
        await page.reload();
        await trigger.click();
        await expect(picker.locator('[data-testid="session-tab-item"][data-terminal-id]')).toHaveCount(0);
        await api(`/api/workspaces/${other.id}/remove`, { deleteDirectory: true, force: true }, 200);
      } finally {
        stopFakeWorker();
        if (world) await world.stop();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}
