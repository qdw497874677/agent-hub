import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type APIResponse, type Page } from '@playwright/test';
import { readHubLog, reservePort, spawnHub, stop } from '../apps/server/src/test-support/spawn.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { TEST_EMAIL } from './login.ts';

type Target = {
  port: number; workerId: string; label: string | null; linkId: string | null; url: string | null;
  mapping: 'ready' | 'pending' | 'unavailable';
};
type Link = { id: string; hubPort: number; port: number; state: string; label: string };

async function fixture(page: Page, root: string, enabled = true) {
  const port = await reservePort();
  const availablePort = await reservePort();
  const from = Math.min(availablePort, 65528);
  const origin = `http://127.0.0.1:${port}`;
  const path = join(root, 'web-app');
  const home = join(root, 'home');
  mkdirSync(path);
  mkdirSync(home);
  const account = join(root, 'account');
  const log = join(root, 'hub.log');
  const hub = spawnHub(process.execPath, ['apps/server/src/main.ts'], {
    env: {
      PATH: process.env.PATH, HOME: home, TMPDIR: root, HUB_HOST: '127.0.0.1', HUB_PORT: String(port),
      HUB_PUBLIC_URL: origin, HUB_DATA_DIR: join(root, 'data'), HUB_TEST_ACCOUNT_FILE: account,
      HUB_SPAWN_WORKER: '0', HUB_PREVIEW_PORTS: `${from}-${from + 7}`, HUB_PREVIEW_AUTO: '0',
      ...(enabled ? {} : { HUB_PREVIEW_WORKFLOW: '0' })
    },
    logFile: log
  });
  const api = async <T>(pathname: string, { method = 'GET', data, status = 200 }: { method?: string; data?: unknown; status?: number } = {}) => {
    const csrf = (await page.context().cookies(origin)).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
    const response = await page.request.fetch(`${origin}${pathname}`, {
      method, headers: { origin, 'x-hub-csrf': csrf }, ...(data === undefined ? {} : { data })
    });
    expect(response.status(), `${method} ${pathname}: ${await response.text()}`).toBe(status);
    return await response.json() as T;
  };
  try {
    await expect.poll(async () => (await fetch(`${origin}/api/health`).catch(() => null))?.status ?? hub.exitCode).toBe(200);
    await api('/api/auth/login', { method: 'POST', data: { email: TEST_EMAIL, password: readFileSync(account, 'utf8').trim() } });
    const workerId = await ensureFakeWorker(page, origin);
    const project = await api<{ id: string }>('/api/projects', { method: 'POST', status: 201, data: { name: '真实预览链路' } });
    const workspace = await api<{ id: string }>(`/api/projects/${project.id}/workspaces`, {
      method: 'POST', status: 201, data: { kind: 'long_lived', mode: 'link', workerId, path }
    });
    const task = await api<{ id: string }>('/api/tasks', { method: 'POST', status: 201, data: { projectId: project.id, title: '预览前端' } });
    const session = await api<{ id: string }>('/api/sessions/derive', {
      method: 'POST', status: 201, data: { taskId: task.id, workerId, workspaceId: workspace.id, agentId: FAKE_AGENT_ID, model: '' }
    });
    return { origin, project, path, workerId, session, api, log, stop: () => stop(hub) };
  } catch (failure) {
    await stop(hub);
    throw new Error(`预览测试 Hub/Worker 建立失败：${readHubLog(log)}`, { cause: failure });
  }
}

async function upstream(root: string, cwd: string, backendPort?: number) {
  const port = await reservePort();
  const log = join(root, `upstream-${port}.log`);
  const source = `const http = require('node:http');
    const port = Number(process.argv[1]), backend = Number(process.argv[2]);
    http.createServer(async (req, res) => {
      console.log(JSON.stringify({ method: req.method, path: req.url, cookie: !!req.headers.cookie, authorization: !!req.headers.authorization }));
      if (req.url === '/api/check' && backend) {
        try { const upstream = await fetch('http://127.0.0.1:' + backend + '/'); res.writeHead(upstream.status); return res.end(await upstream.text()); }
        catch { res.writeHead(503); return res.end('fixture API offline'); }
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>preview fixture</title><main>真实上游页面</main>');
    }).listen(port, '127.0.0.1');`;
  const child = spawnHub(process.execPath, ['-e', source, String(port), String(backendPort ?? 0)], { cwd, logFile: log });
  try {
    await expect.poll(async () => (await fetch(`http://127.0.0.1:${port}/`).catch(() => null))?.status ?? child.exitCode).toBe(200);
    return { port, log, stop: () => stop(child) };
  } catch (failure) {
    await stop(child);
    throw new Error(`回环测试服务启动失败：${readHubLog(log)}`, { cause: failure });
  }
}

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('回环监听没有端口');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test('手动预览仍可登记、复用、鉴权与移除；登记不证明上游已响应', async ({ page, playwright }) => {
  const root = mkdtempSync(join(tmpdir(), 'pv-manual-'));
  let world: Awaited<ReturnType<typeof fixture>> | undefined;
  const anonymous = await playwright.request.newContext();
  try {
    world = await fixture(page, root);
    const { api, session, origin } = world;
    const route = `/api/sessions/${session.id}/previews`;
    const port = await unusedPort();
    const create = () => api<{ link: Link }>(route, { method: 'POST', data: { port, label: '未启动的开发服务' }, status: 201 });
    const { link } = await create();
    expect(link).toMatchObject({ port, label: '未启动的开发服务', state: 'ready' });
    expect((await create()).link.id).toBe(link.id);
    expect((await api<{ links: Link[] }>(route)).links.map((entry) => entry.id)).toEqual([link.id]);
    const url = `http://127.0.0.1:${link.hubPort}/`;
    const blocked = await anonymous.get(url, { maxRedirects: 0 });
    expect([302, 401, 403]).toContain(blocked.status());
    expect((await anonymous.post(`${origin}${route}/${link.id}/diagnostic`, { maxRedirects: 0 })).status()).toBe(401);
    await expect.poll(async () => (await page.request.get(url)).status()).toBe(502);
    await api(`${route}/${link.id}`, { method: 'DELETE' });
    expect((await api<{ links: Link[] }>(route)).links).toHaveLength(0);
  } finally {
    await anonymous.dispose();
    stopFakeWorker();
    await world?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('停用新流程不影响现有私有预览管理', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'pv-off-'));
  let world: Awaited<ReturnType<typeof fixture>> | undefined;
  let service: Awaited<ReturnType<typeof upstream>> | undefined;
  try {
    world = await fixture(page, root, false);
    const { api, project, session, origin, path } = world;
    service = await upstream(root, path);
    const previews = `/api/sessions/${session.id}/previews`;
    const { link } = await api<{ link: Link }>(previews, { method: 'POST', data: { port: service.port, label: '手动入口' }, status: 201 });
    const { addresses } = await api<{ addresses: Record<string, string | null> }>(previews);
    expect(addresses[link.id]).toBe(`http://127.0.0.1:${link.hubPort}/`);
    await page.goto(`${origin}/#/p/${project.id}/focus/${session.id}`);
    const workflow = await api<{ available: boolean; targets: Target[] }>(`/api/sessions/${session.id}/preview-workflow`);
    expect(workflow).toEqual({ available: false, targets: [] });
    await expect(page.getByTestId('focus-header')).toBeVisible();
    await expect(page.getByTestId('workflow-open-preview')).toHaveCount(0);
    await page.getByRole('tab', { name: '预览', exact: true }).click();
    const panel = page.getByTestId('preview-panel');
    await expect(panel.getByTestId('preview-row')).toContainText('手动入口');
    const popupPromise = page.waitForEvent('popup');
    await panel.getByTestId('preview-open').click();
    const popup = await popupPromise;
    await expect(popup.getByText('真实上游页面')).toBeVisible();
    expect(popup.url()).toBe(addresses[link.id]);
    await popup.close();
  } finally {
    await service?.stop();
    stopFakeWorker();
    await world?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const width of [1280, 390]) {
  const touch = width < 640;
  test.describe(`预览 ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: touch, isMobile: touch });
    test('已验证目标才登记；一个入口直接打开，多个目标先选择', async ({ page, playwright }) => {
      const root = mkdtempSync(join(tmpdir(), 'pv-open-'));
      let world: Awaited<ReturnType<typeof fixture>> | undefined;
      const services: Array<Awaited<ReturnType<typeof upstream>>> = [];
      const anonymous = await playwright.request.newContext();
      try {
        world = await fixture(page, root);
        const { api, origin, project, session, path, workerId } = world;
        const unrelatedCwd = join(root, 'not-the-session');
        mkdirSync(unrelatedCwd);
        const backend = await upstream(root, unrelatedCwd);
        services.push(backend);
        const frontend = await upstream(root, path, backend.port);
        services.push(frontend);
        const workflow = `/api/sessions/${session.id}/preview-workflow`;
        const previews = `/api/sessions/${session.id}/previews`;
        const inventory = () => api<{ available: boolean; targets: Target[] }>(workflow);
        await expect.poll(async () => (await inventory()).targets.map(({ port }) => port)).toEqual([frontend.port]);
        expect((await inventory()).targets[0]).toMatchObject({ port: frontend.port, workerId, linkId: null, url: null });
        expect((await api<{ links: Link[] }>(previews)).links).toHaveLength(0);
        expect((await anonymous.get(`${origin}${workflow}`, { maxRedirects: 0 })).status()).toBe(401);

        await page.goto(`${origin}/#/p/${project.id}/focus/${session.id}`);
        const showPreviewTab = async () => {
          const panel = page.getByTestId('preview-panel');
          const chat = page.getByRole('textbox', { name: '发送消息' });
          await expect.poll(async () => (await panel.isVisible()) || (await chat.isVisible())).toBe(true);
          if (await panel.isVisible()) return;
          if (touch) {
            await page.getByTestId('session-more-trigger').click();
            await page.getByTestId('session-more-preview').click();
          } else {
            await page.getByTestId('session-tab-preview').click();
          }
        };
        const workflowLoads = page.waitForResponse((response) => new URL(response.url()).pathname === workflow && response.request().method() === 'GET');
        await showPreviewTab();
        expect((await workflowLoads).ok()).toBe(true);
        let registrationPosts = 0;
        await page.route(`**${workflow}`, async (route) => {
          if (route.request().method() !== 'POST') return route.continue();
          registrationPosts++;
          const result = await route.fetch();
          expect(result.ok()).toBe(true);
          if (touch) await route.abort('failed'); // Lose only the response, after the real Hub committed.
          else await route.fulfill({ response: result });
        });
        const open = page.getByTestId('workflow-open-preview');
        await open.click();
        await expect.poll(async () => (await api<{ links: Link[] }>(previews)).links.map(({ port }) => port)).toEqual([frontend.port]);
        // Async registration can lose browser user activation; a real native link remains available.
        const dialog = page.getByTestId('preview-workflow-dialog');
        if (touch) {
          await expect(dialog.getByRole('status')).toContainText('尚未确认');
          await dialog.getByRole('button', { name: '重新检查' }).click();
        }
        const firstTarget = dialog.getByTestId('preview-workflow-target');
        // Hold a real successful diagnostic response across a second inventory refresh. This
        // deterministically covers the refresh/diagnostic race without faking a Hub response.
        const diagnosticPath = `**${previews}/*/diagnostic`;
        const holdDiagnostic = async () => {
          const ready = Promise.withResolvers<APIResponse>();
          const release = Promise.withResolvers<void>();
          await page.route(diagnosticPath, async (route) => {
            let response: APIResponse;
            try { response = await route.fetch(); }
            catch (error) { ready.reject(error); await route.abort('failed'); return; }
            ready.resolve(response);
            await release.promise;
            await route.fulfill({ response });
          }, { times: 1 });
          return { ready: ready.promise, release: () => release.resolve() };
        };
        const check = await holdDiagnostic();
        try {
          await firstTarget.getByRole('button', { name: '检查状态' }).click();
          const diagnostic = await check.ready;
          expect(diagnostic.ok()).toBe(true);
          expect(await diagnostic.json()).toMatchObject({ state: 'response', status: 200 });
          const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === workflow && response.request().method() === 'GET');
          const refresh = dialog.getByRole('button', { name: '重新检查', exact: true });
          await refresh.click();
          const response = await refreshed;
          expect(await response.json()).toMatchObject({ targets: [{ port: frontend.port, workerId, mapping: 'ready' }] });
          await expect(refresh).toBeEnabled();
          await expect(firstTarget.getByRole('button', { name: '检查中…', exact: true })).toBeDisabled();
        } finally {
          check.release();
        }
        await expect(firstTarget).toContainText('HTTP 200');
        await expect(firstTarget).toContainText('不代表你的设备可访问');
        expect(registrationPosts).toBe(1);
        if (touch) {
          // A response from an older dialog lifetime must not paint the newly opened dialog.
          const stale = await holdDiagnostic();
          try {
            await firstTarget.getByRole('button', { name: '检查状态' }).click();
            expect(await (await stale.ready).json()).toMatchObject({ state: 'response', status: 200 });
            await page.keyboard.press('Escape');
            await expect(dialog).toBeHidden();
            await page.getByRole('button', { name: '更多预览选项' }).click();
            const returned = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/diagnostic'));
            stale.release();
            expect(await (await returned).finished()).toBeNull();
          } finally { stale.release(); }
          await expect(firstTarget).toContainText('检查：未确认');
          await expect(firstTarget.getByRole('button', { name: '检查状态' })).toBeEnabled();
        }
        const nativeOpen = firstTarget.getByRole('link', { name: '打开预览', exact: true });
        const popupPromise = page.waitForEvent('popup');
        await nativeOpen.click();
        const popup = await popupPromise;
        await expect(popup.getByText('真实上游页面')).toBeVisible();
        expect(new URL(popup.url()).port).not.toBe(String(frontend.port));
        const mappedOrigin = new URL(popup.url()).origin;
        expect((await popup.request.get(`${mappedOrigin}/api/check`)).status()).toBe(200);
        await backend.stop();
        expect((await popup.request.get(`${mappedOrigin}/`)).status()).toBe(200);
        expect((await popup.request.get(`${mappedOrigin}/api/check`)).status()).toBe(503);
        const links = (await api<{ links: Link[] }>(previews)).links;
        expect(links.map(({ port }) => port)).toEqual([frontend.port]);
        expect(links[0]).toMatchObject({ shared: false });
        expect((await anonymous.get(`${mappedOrigin}/`, { maxRedirects: 0 })).status()).not.toBe(200);
        const observations = readHubLog(frontend.log).trim().split('\n').map((line) => JSON.parse(line) as { cookie: boolean; authorization: boolean });
        expect(observations.every((request) => !request.cookie && !request.authorization)).toBe(true);
        await popup.close();

        await page.keyboard.press('Escape');
        await expect(open).toHaveAttribute('target', '_blank');
        const directPopup = page.waitForEvent('popup');
        await open.click();
        const direct = await directPopup;
        await expect(direct.getByText('真实上游页面')).toBeVisible();
        await direct.close();

        if (touch) await page.getByTestId('session-back-to-chat').click();
        else await page.getByTestId('session-tab-chat').click();
        const composer = page.getByRole('textbox', { name: '发送消息' });
        const originalDraft = '原有草稿不能丢';
        await composer.fill(originalDraft);
        let promptWrites = 0;
        page.on('request', (request) => {
          if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/sessions/${session.id}/prompt`) promptWrites++;
        });
        await showPreviewTab();
        await page.getByRole('button', { name: '更多预览选项' }).click();
        await dialog.getByTestId('preview-feedback-open').click();
        const form = dialog.getByTestId('preview-feedback-form');
        const routePath = form.getByTestId('preview-feedback-path');
        const append = form.getByTestId('preview-feedback-submit');
        await routePath.fill('https://outside.invalid/other');
        await expect(append).toBeDisabled();
        await routePath.fill('/catalog/item?share=DO_NOT_RETAIN#fragment');
        await form.getByTestId('preview-feedback-description').fill('商品页的布局需要检查');
        await append.click();
        await expect(dialog).toBeHidden();
        await expect(composer).toHaveValue(`${originalDraft}\n\n预览：${links[0]!.label}\n页面路径：/catalog/item\n复现说明：商品页的布局需要检查`);
        expect(promptWrites).toBe(0);
        await expect(page).toHaveURL(new RegExp(`/focus/${session.id}$`));
        await showPreviewTab();
        await page.getByRole('button', { name: '更多预览选项' }).click();
        await dialog.getByTestId('preview-feedback-open').click();
        await expect(routePath).toHaveValue('/catalog/item');
        await page.keyboard.press('Escape');

        const second = await upstream(root, path);
        services.push(second);
        await expect.poll(async () => (await inventory()).targets.map(({ port }) => port).sort()).toEqual([frontend.port, second.port].sort());
        const reloadInventory = page.waitForResponse((response) => new URL(response.url()).pathname === workflow && response.request().method() === 'GET');
        await page.reload();
        await showPreviewTab();
        expect((await reloadInventory).ok()).toBe(true);
        await open.click();
        await expect(dialog.getByTestId('preview-workflow-target')).toHaveCount(2);
        await expect(dialog.getByTestId('preview-workflow-target').filter({ hasText: `:${frontend.port}` })).toBeVisible();
        await expect(dialog.getByTestId('preview-workflow-target').filter({ hasText: `:${second.port}` })).toBeVisible();
        expect((await api<{ links: Link[] }>(previews)).links.map(({ port }) => port)).toEqual([frontend.port]);
        expect(registrationPosts).toBe(1);
        if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, `preview-choices-${width}.png`) });

        const linkedTarget = dialog.getByTestId('preview-workflow-target').filter({ hasText: `:${frontend.port}` });
        await frontend.stop();
        await linkedTarget.getByRole('button', { name: '检查状态' }).click();
        await expect(linkedTarget).toContainText('拒绝连接');
        stopFakeWorker();
        await expect.poll(async () => {
          const workers = await api<Array<{ id?: string; workerId?: string; state: string }>>('/api/workers');
          return workers.find((worker) => (worker.workerId ?? worker.id) === workerId)?.state;
        }).toBe('offline');
        await linkedTarget.getByRole('button', { name: '检查状态' }).click();
        await expect(linkedTarget).toContainText('机器离线');
      } finally {
        await anonymous.dispose();
        for (const service of services) await service.stop();
        stopFakeWorker();
        await world?.stop();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}
