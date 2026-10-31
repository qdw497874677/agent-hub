import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';

async function writeHeaders(page: import('@playwright/test').Page, baseURL: string): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  return { origin: baseURL, 'x-hub-csrf': csrf };
}

const SHOTS = process.env['E2E_SCREENSHOTS'];

/**
 * 运行时套件 P1（ADR 0021 §7）：远程机器连上就报清单。
 * 用户自己在 ~/.pi/agent/settings.json 里装的包显示为「外部安装」、不算能力；
 * hub 目录里来路不明（不在期望 pins 里）的组件显示「不可信」。全程只读，不装任何东西。
 */
test('套件清单：外部组件只显示，来路不明的 hub 组件标不可信', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await loginByApi(page);
  const headers = await writeHeaders(page, baseURL!);
  const pairing = await page.request.post('/api/workers/pairing', { data: {}, headers });
  expect(pairing.ok()).toBe(true);
  const code = ((await pairing.json()) as { code: string }).code;
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  const PATH = '/usr/local/bin:/usr/bin:/bin';
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], { env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: 'e2e 清单机器' }, encoding: 'utf8' });
  expect(enrolled.status).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');

  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-inv-'));
  const runtimesDir = join(state, 'runtimes');
  mkdirSync(join(state, '.pi', 'agent'), { recursive: true });
  writeFileSync(join(state, '.pi', 'agent', 'settings.json'), JSON.stringify({ packages: ['npm:some-pi-ext@0.3.1'] }));
  const comp = join(runtimesDir, 'components', 'pi', 'stray-ext');
  mkdirSync(join(comp, '2.0.0'), { recursive: true });
  writeFileSync(join(comp, '2.0.0', '.component.json'), JSON.stringify({ integrity: '', provides: [{ capability: 'context-strategy:stray' }] }));
  symlinkSync('2.0.0', join(comp, 'current'));
  let worker: ChildProcess | null = null;
  try {
    worker = spawn(process.execPath, ['apps/worker/src/main.ts'], {
      env: { PATH, HOME: state, HUB_URL: hubUrl, HUB_WORKER_CREDENTIAL: credential, WORKER_ID: workerId, WORKER_ORIGIN: 'remote', WORKER_LABEL: 'e2e 清单机器', WORKER_ROOTS: '/tmp', WORKER_STATE_DIR: state, WORKER_RUNTIMES_DIR: runtimesDir },
      stdio: 'ignore'
    });
    await expect
      .poll(async () => {
        const list = (await (await page.request.get('/api/workers')).json()) as { workerId: string; inventory?: unknown }[];
        return list.find((w) => w.workerId === workerId)?.inventory !== undefined;
      }, { timeout: 30_000 })
      .toBe(true);
    const info = ((await (await page.request.get('/api/workers')).json()) as {
      workerId: string;
      inventory: { components: { id: string; managedBy: string }[] };
      drift: { items: { kind: string; componentId: string }[]; trusted: unknown[]; untrusted: { via: string }[] };
    }[]).find((w) => w.workerId === workerId)!;
    expect(info.inventory.components.map((c) => `${c.managedBy}:${c.id}`).sort()).toEqual(['external:some-pi-ext', 'hub:stray-ext']);
    expect(info.drift.trusted).toEqual([]);
    expect(info.drift.untrusted.map((c) => c.via)).toEqual(['stray-ext']);
    expect(info.drift.items.map((i) => `${i.kind}:${i.componentId}`).sort()).toEqual(['external:some-pi-ext', 'unexpected:stray-ext']);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByRole('button', { name: /^Worker：/ }).first().click();
    await page.getByRole('button', { name: /e2e 清单机器/ }).click();
    const section = page.getByTestId('inventory-section');
    await expect(section).toBeVisible({ timeout: 20_000 });
    await expect(section.getByTestId('inventory-external')).toContainText('外部安装');
    await expect(section).toContainText('stray-ext');
    await expect(section).toContainText('不可信：不是 hub 装的');
    await expect(page.getByTestId('inventory-drift')).toContainText('漂移：1 项');
    await section.scrollIntoViewIfNeeded();
    await expect(page.getByTestId('inventory-drift')).toContainText('上次清单');
    const box = await section.boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(390);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'inventory-390.png') });
  } finally {
    worker?.kill();
    await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
    rmSync(state, { recursive: true, force: true });
  }
});
