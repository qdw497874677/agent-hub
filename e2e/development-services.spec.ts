import { spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readHubLog, reservePort, spawnHub, stop } from '../apps/server/src/test-support/spawn.ts';
import { e2eWorkerPath } from './isolation.ts';
import { FAKE_AGENT_ID } from './fake-worker.ts';
import { TEST_EMAIL } from './login.ts';

type Group = { workspaceId: string | null; services: { id: string | null; port: number; openable: boolean }[] };
type Detail = { state: string; groups: Group[] };

async function fixture(page: Page, info: TestInfo, enabled: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'development-services-'));
  const home = join(root, 'home');
  mkdirSync(home);
  const port = await reservePort();
  const legacyPort = await reservePort();
  let developmentPort = await reservePort();
  while (developmentPort === legacyPort || developmentPort === port) developmentPort = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const log = join(root, 'hub.log');
  const account = join(root, 'account');
  const children: ChildProcess[] = [];
  const hub = spawnHub(process.execPath, ['apps/server/src/main.ts'], { logFile: log, env: {
    PATH: process.env.PATH, HOME: home, TMPDIR: root, HUB_HOST: '127.0.0.1', HUB_PORT: String(port),
    HUB_PUBLIC_URL: origin, HUB_DATA_DIR: join(root, 'data'), HUB_TEST_ACCOUNT_FILE: account,
    HUB_SPAWN_WORKER: '0', HUB_PREVIEW_PORTS: String(legacyPort), HUB_PREVIEW_AUTO: '0',
    ...(enabled ? { HUB_DEVELOPMENT_PREVIEW_PORTS: String(developmentPort) } : {})
  } });
  const api = async <T>(pathname: string, options: { method?: string; data?: unknown; status?: number } = {}) => {
    const csrf = (await page.context().cookies(origin)).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
    const response = await page.request.fetch(`${origin}${pathname}`, { method: options.method ?? 'GET', headers: { origin, 'x-hub-csrf': csrf }, ...(options.data === undefined ? {} : { data: options.data }) });
    expect(response.status(), `${options.method ?? 'GET'} ${pathname}: ${await response.text()}`).toBe(options.status ?? 200);
    return await response.json() as T;
  };
  const cleanup = async () => {
    for (const child of children.reverse()) await stop(child);
    await stop(hub);
    if (info.status !== info.expectedStatus) {
      await info.attach('development-services-hub.log', { body: readHubLog(log), contentType: 'text/plain' });
      for (const name of ['worker-a.log', 'worker-b.log']) await info.attach(name, { body: readHubLog(join(root, name)), contentType: 'text/plain' });
    }
    rmSync(root, { recursive: true, force: true });
  };
  try {
    await expect.poll(async () => (await fetch(`${origin}/api/health`).catch(() => null))?.status ?? hub.exitCode).toBe(200);
    await api('/api/auth/login', { method: 'POST', data: { email: TEST_EMAIL, password: readFileSync(account, 'utf8').trim() } });
    async function worker(name: string) {
      const { code } = await api<{ code: string }>('/api/workers/pairing', { method: 'POST', data: {} });
      const hubUrl = `${origin.replace(/^http/, 'ws')}/worker`;
      const label = `fixture-${name}`;
      const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], { env: { PATH: e2eWorkerPath(), HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label }, encoding: 'utf8' });
      if (enrolled.status !== 0) throw new Error(`enroll ${name}: ${enrolled.stderr || enrolled.stdout}`);
      const [id, credential] = enrolled.stdout.trim().split('\n');
      if (!id || !credential) throw new Error(`enroll ${name}: missing id or credential`);
      const state = join(root, `worker-${name}`);
      mkdirSync(state);
      const child = spawnHub(process.execPath, ['apps/worker/src/main.ts'], { logFile: join(root, `worker-${name}.log`), env: {
        PATH: e2eWorkerPath(), HOME: state, HUB_URL: hubUrl, HUB_WORKER_CREDENTIAL: credential,
        WORKER_ID: id, WORKER_ORIGIN: 'remote', WORKER_LABEL: label, WORKER_ROOTS: root,
        WORKER_STATE_DIR: state, WORKER_RUNTIMES_DIR: join(state, 'runtimes'), WORKER_MODEL_CHECK: '0',
        ACP_AGENTS: JSON.stringify([{ id: FAKE_AGENT_ID, label: '假 ACP', command: process.execPath, args: [resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs')], listModelsArgs: [resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs'), '--models'] }])
      } });
      children.push(child);
      await expect.poll(async () => (await api<Array<{ workerId?: string; id?: string; state: string }>>('/api/workers')).find((w) => (w.workerId ?? w.id) === id)?.state, { message: `worker ${name} online: ${readHubLog(join(root, `worker-${name}.log`))}` }).toBe('online');
      return id;
    }
    const a = await worker('a');
    const b = await worker('b');
    const project = await api<{ id: string }>('/api/projects', { method: 'POST', status: 201, data: { name: '开发服务测试' } });
    const workspace = async (workerId: string, path: string) => api<{ id: string }>(`/api/projects/${project.id}/workspaces`, { method: 'POST', status: 201, data: { kind: 'long_lived', mode: 'link', workerId, path } });
    const pathA = join(root, 'current');
    const pathNested = join(root, 'sibling');
    const pathB = join(root, 'other');
    mkdirSync(pathA);
    mkdirSync(pathNested);
    mkdirSync(pathB);
    const current = await workspace(a, pathA);
    const nested = await workspace(a, pathNested);
    const other = await workspace(b, pathB);
    const task = await api<{ id: string }>('/api/tasks', { method: 'POST', status: 201, data: { projectId: project.id, title: '开发服务会话' } });
    const session = await api<{ id: string }>('/api/sessions/derive', { method: 'POST', status: 201, data: { taskId: task.id, workerId: a, workspaceId: current.id, agentId: FAKE_AGENT_ID, model: '' } });
    async function listener(cwd: string, text: string, fixedPort?: number) {
      const listenPort = fixedPort ?? await reservePort();
      const child = spawnHub(process.execPath, ['-e', `require('node:http').createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(${JSON.stringify(text)})}).listen(${listenPort},'127.0.0.1')`], { cwd, logFile: join(root, `listener-${listenPort}.log`) });
      children.push(child);
      await expect.poll(async () => (await fetch(`http://127.0.0.1:${listenPort}`).catch(() => null))?.status ?? child.exitCode).toBe(200);
      return { port: listenPort, stop: () => stop(child) };
    }
    return { root, origin, api, a, b, project, session, current, nested, other, pathA, pathNested, pathB, listener, cleanup };
  } catch (error) {
    const logs = `Hub: ${readHubLog(log)}\nWorker a: ${readHubLog(join(root, 'worker-a.log'))}\nWorker b: ${readHubLog(join(root, 'worker-b.log'))}`;
    await cleanup();
    throw new Error(`fixture failed: ${logs}`, { cause: error });
  }
}

for (const width of [1280, 390, 320]) {
  test.describe(`开发服务 ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: width < 640, isMobile: width < 640 });
    test('所有机器独立展开，归属精确，引用只写草稿并打开已验证服务', async ({ page }, info) => {
      const world = await fixture(page, info, true);
      try {
        const { api, a, b, current, nested, other } = world;
        const first = await world.listener(world.pathA, '当前目录真实服务');
        const second = await world.listener(world.pathNested, '嵌套目录真实服务');
        const third = await world.listener(world.pathB, '另一机器真实服务');
        const detail = (worker: string) => api<Detail>(`/api/development-services/workers/${worker}`);
        const ports = (groups: Group[], id: string) => groups.find((g) => g.workspaceId === id)?.services.map((s) => s.port) ?? [];
        await expect.poll(async () => ports((await detail(a)).groups, current.id)).toEqual([first.port]);
        expect(ports((await detail(a)).groups, nested.id)).toEqual([second.port]);
        expect(ports((await detail(b)).groups, other.id)).toEqual([third.port]);
        expect((await detail(a)).groups.flatMap((g) => g.services.map((s) => s.port))).not.toContain(third.port);
        const selected = (await detail(a)).groups.find((g) => g.workspaceId === current.id)!.services[0]!;
        expect(selected.id).toBeTruthy();
        expect(selected.openable).toBe(true);
        await page.goto(`${world.origin}/#/p/${world.project.id}/focus/${world.session.id}`);
        await expect(page.getByTestId('focus-header')).toBeVisible();
        const composer = page.getByRole('textbox', { name: '发送消息' });
        await composer.fill('保留草稿');
        let promptWrites = 0;
        page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/sessions/${world.session.id}/prompt`) promptWrites++; });
        if (width < 768) {
          await page.getByTestId('session-tab-trigger').click();
          await expect(page.getByTestId('session-tab-picker').getByTestId('development-services-trigger')).toBeVisible();
        }
        await page.getByTestId('development-services-trigger').click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        const panel = page.getByTestId('development-services-panel');
        const workers = panel.getByTestId('development-services-worker');
        await expect(workers).toHaveCount(2);
        // Locate the section itself (rather than descendants) by its stable worker id.
        const machineA = panel.locator(`[data-testid="development-services-worker"][data-worker-id="${a}"]`);
        const machineB = panel.locator(`[data-testid="development-services-worker"][data-worker-id="${b}"]`);
        await expect(workers.first()).toHaveAttribute('data-worker-id', a);
        await expect(machineA.getByTestId('development-services-worker-toggle')).toHaveAttribute('aria-expanded', 'true');
        await expect(machineB.getByTestId('development-services-worker-toggle')).toHaveAttribute('aria-expanded', 'false');
        const groups = machineA.getByTestId('development-services-group');
        await expect(groups).toHaveCount(2);
        await expect(groups.first()).toHaveAttribute('data-workspace-id', current.id);
        await expect(groups.first()).toContainText(`端口 ${first.port}`);
        await expect(groups.nth(1)).toHaveAttribute('data-workspace-id', nested.id);
        await expect(groups.nth(1)).toContainText(`端口 ${second.port}`);
        await machineB.getByTestId('development-services-worker-toggle').click();
        await expect(machineB.getByTestId('development-services-group')).toContainText(`端口 ${third.port}`);
        await expect(machineA.getByTestId('development-services-worker-toggle')).toHaveAttribute('aria-expanded', 'true');
        await expect(machineB.getByTestId('development-service-reference')).toHaveCount(0);
        await expect(groups.nth(1).getByTestId('development-service-reference')).toHaveCount(0);
        const popupPromise = page.waitForEvent('popup');
        await groups.first().getByTestId('development-service-open').click();
        const popup = await popupPromise;
        await expect(popup.getByText('当前目录真实服务')).toBeVisible();
        expect(new URL(popup.url()).hostname).toMatch(/^dev-\d+\.localhost$/);
        expect(new URL(popup.url()).port).not.toBe(String(first.port));
        await popup.close();
        await groups.first().getByTestId('development-service-reference').click();
        await expect(composer).toHaveValue(`保留草稿\n[[dev-service:${selected.id}]]\n`);
        expect(promptWrites).toBe(0);
        await first.stop();
        const replacement = await world.listener(world.pathA, '替换后的服务不得使用旧标识', first.port);
        const stale = await page.request.post(`${world.origin}/api/development-services/open`, { headers: { origin: world.origin, 'x-hub-csrf': (await page.context().cookies(world.origin)).find((c) => c.name === 'hub_csrf')?.value ?? '' }, data: { id: selected.id } });
        expect(stale.status()).toBe(404);
        await replacement.stop();
      } finally { await world.cleanup(); }
    });
  });
}

test('未启用新监听端口时仍可发现服务但不能打开', async ({ page }, info) => {
  const world = await fixture(page, info, false);
  try {
    const service = await world.listener(world.pathA, '仅发现服务');
    const detail = () => world.api<Detail>(`/api/development-services/workers/${world.a}`);
    await expect.poll(async () => (await detail()).groups.find((g) => g.workspaceId === world.current.id)?.services.map((s) => s.port) ?? []).toEqual([service.port]);
    const discovered = (await detail()).groups.find((g) => g.workspaceId === world.current.id)!.services[0]!;
    expect(discovered.openable).toBe(false);
    expect(discovered.id).toBeTruthy();
    await page.goto(`${world.origin}/#/p/${world.project.id}/focus/${world.session.id}`);
    await page.getByTestId('development-services-trigger').click();
    const machine = page.locator(`[data-testid="development-services-worker"][data-worker-id="${world.a}"]`);
    await expect(machine).toContainText(`端口 ${service.port}`);
    await expect(machine.getByTestId('development-service-open')).toHaveCount(0);
  } finally { await world.cleanup(); }
});
