import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { readHubLog, reservePort, spawnHub, stop } from '../apps/server/src/test-support/spawn.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { TEST_EMAIL } from './login.ts';

type Terminal = { id: string; state: 'pending' | 'running' | 'closing' | 'ended' };
const shots = process.env['E2E_SCREENSHOTS'];

async function fixture(page: Page, root: string) {
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
  const api = async <T>(path: string, data?: unknown, expected = data === undefined ? 200 : 201) => {
    const csrf = (await page.context().cookies(origin)).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
    const headers = { origin, 'x-hub-csrf': csrf };
    const r = data === undefined ? await page.request.get(`${origin}${path}`) : await page.request.post(`${origin}${path}`, { headers, data });
    expect(r.status(), `${path}: ${await r.text()}`).toBe(expected);
    return await r.json() as T;
  };
  const signIn = () => api('/api/auth/login', { email: TEST_EMAIL, password: readFileSync(passwordFile, 'utf8').trim() }, 200);
  try {
    await signIn();
    const { user } = await api<{ user: { id: string } }>('/api/auth/state');
    const workerId = await ensureFakeWorker(page, origin, FAKE_AGENT_ID, { env: { TERMINAL_SHELL: '/bin/sh', WORKER_WORKDIR_TERMINAL: '1' } });
    const project = await api<{ id: string }>('/api/projects', { name: '独立终端测试' });
    const path = join(root, 'workdir');
    mkdirSync(path);
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
    await restart();
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
    test('无会话时可开真实 PTY；切换与刷新不断进程，关标签才释放目录', async ({ page }) => {
      test.setTimeout(150_000);
      const root = mkdtempSync(join(tmpdir(), 'workdir-tabs-'));
      let world: Awaited<ReturnType<typeof fixture>> | null = null;
      try {
        world = await fixture(page, root);
        const { api, origin, projectId, workspaceId, workerId, terminals, path } = world;
        const canvasPath = `/api/projects/${projectId}/canvas`;
        expect((await api<{ sessions: unknown[] }>(canvasPath)).sessions).toHaveLength(0);
        await page.goto(`${origin}/#/p/${projectId}/list`);
        await page.getByTestId('list-view').locator(`[data-testid="workdir-entry"][data-workspace-id="${workspaceId}"]`).click();
        const tabs = page.getByTestId('workdir-tabs');
        const plus = tabs.getByTestId('workdir-add');
        await plus.click();
        await tabs.getByTestId('workdir-new-terminal').click();
        const status = tabs.getByTestId('terminal-status');
        await expect(status).toContainText('已连接');
        if (shots) await page.screenshot({ path: join(shots, `workdir-terminal-${width}.png`) });
        const inventory = () => api<{ terminals: Terminal[] }>(terminals).then((rows) => rows.terminals);
        const first = (await inventory())[0]!;
        expect(first.state).toBe('running');
        const type = async (command: string) => {
          const input = tabs.locator('.xterm-helper-textarea');
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
          const chooser = tabs.getByTestId('workdir-choose-tab');
          expect((await chooser.boundingBox())!.height).toBeGreaterThanOrEqual(44);
          const keys = (await tabs.getByTestId('terminal-keys').boundingBox())!;
          expect(keys.y + keys.height).toBeLessThanOrEqual(621);
        }

        const task = await api<{ id: string }>('/api/tasks', { projectId, title: '会话共享同目录' });
        const session = await api<{ id: string }>('/api/sessions/derive', { taskId: task.id, workerId, workspaceId, agentId: FAKE_AGENT_ID, model: '' });
        await page.reload();
        await expect(status).toContainText('已连接');
        await plus.click();
        await tabs.getByTestId('workdir-open-session').click();
        const composer = tabs.getByLabel('发送消息');
        await composer.fill('只回这段文字，不要用工具：OK');
        await composer.press('Control+Enter');
        await expect(tabs.getByRole('log').getByText('OK', { exact: true })).toBeVisible();
        await composer.fill('这个草稿随标签切换保留');
        const select = async (kind: 'session' | 'terminal') => {
          if (touch) await tabs.getByTestId('workdir-choose-tab').click();
          await tabs.getByTestId(`workdir-tab-${kind}`).filter({ visible: true }).click();
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
        if (touch) await tabs.getByTestId('workdir-choose-tab').click();
        await tabs.getByRole('button', { name: /^关闭会话/ }).click();
        if (touch && !(await tabs.getByTestId('workdir-tab-terminal').isVisible())) await tabs.getByTestId('workdir-choose-tab').click();
        await expect(tabs.getByTestId('workdir-tab-session')).toHaveCount(0);
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
          await plus.click();
          await expect(tabs.getByTestId('workdir-new-terminal')).toBeDisabled();
          await plus.click();
        }
        await select('terminal');
        await expect(status).toContainText('已连接');
        expect(alive()).toBe(true);
        if (touch) await tabs.getByTestId('workdir-choose-tab').click();
        await tabs.getByRole('button', { name: '关闭终端', exact: true }).click();
        await expect.poll(async () => (await inventory()).find((row) => row.id === first.id)?.state).toBe('ended');
        await expect.poll(alive).toBe(false);
        await page.reload();
        if (touch) await tabs.getByTestId('workdir-choose-tab').click();
        await expect(tabs.getByTestId('workdir-tab-terminal').filter({ visible: true })).toHaveCount(0);
        await api(`/api/workspaces/${other.id}/remove`, { deleteDirectory: true, force: true }, 200);
      } finally {
        stopFakeWorker();
        if (world) await world.stop();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}
