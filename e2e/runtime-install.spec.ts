import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';

const SHOTS = process.env['E2E_INSTALL_SHOTS'] ?? process.env['E2E_SCREENSHOTS'];

/**
 * 运行时安装（ADR 0010）的整条路：一台「什么 agent 都没装」的远程机器接进来 →
 * 机器面板显示「未安装」→ 点安装 Pi（真去 npm 装推荐版本）→ 进度日志 → 变成「hub 安装 v1.4.0」、shim 落在 WORKER_RUNTIMES_DIR
 * → 卸载 → 回到「未安装」。审计里两条记录。全程不重启 Worker。
 */
test('运行时安装：在远程机器上装 Pi、看进度、再卸载', async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  await loginByApi(page);
  const pairing = await page.request.post('/api/workers/pairing', { data: {} });
  expect(pairing.ok()).toBe(true);
  const code = ((await pairing.json()) as { code: string }).code;
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  // 剥掉 PATH：机器上找不到 pi / opencode / grok，只留 node 和 npm
  const PATH = '/usr/local/bin:/usr/bin:/bin';
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], {
    env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: 'e2e 空机器' },
    encoding: 'utf8'
  });
  expect(enrolled.status).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');

  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-rt-'));
  const runtimesDir = join(state, 'runtimes');
  let worker: ChildProcess | null = null;
  try {
    worker = spawn(process.execPath, ['apps/worker/src/main.ts'], {
      env: {
        PATH,
        HOME: state,
        HUB_URL: hubUrl,
        HUB_WORKER_CREDENTIAL: credential,
        WORKER_ID: workerId,
        WORKER_ORIGIN: 'remote',
        WORKER_LABEL: 'e2e 空机器',
        WORKER_ROOTS: '/tmp',
        WORKER_STATE_DIR: state,
        WORKER_RUNTIMES_DIR: runtimesDir
      },
      stdio: 'ignore'
    });

    await page.goto('/');
    await page.getByRole('button', { name: /^Worker：/ }).first().click();
    await page.getByRole('button', { name: /e2e 空机器/ }).click();
    const pi = page.getByTestId('runtime-pi');
    await expect(page.getByTestId('runtime-pi-source')).toHaveText('未安装', { timeout: 30_000 });
    await expect(page.getByTestId('runtime-opencode-source')).toHaveText('未安装');
    await expect(page.getByTestId('runtime-grok-source')).toHaveText('未安装');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'install-01-missing.png') });

    await pi.getByTestId('runtime-pi-install').click();
    await expect(pi.getByTestId('runtime-pi-install')).toHaveText('确认安装 v1.4.0');
    await pi.getByTestId('runtime-pi-install').click();
    await expect(page.getByTestId('runtime-job-state')).toContainText('Pi 安装 · 进行中');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'install-02-running.png') });
    await expect(page.getByTestId('runtime-job-state')).toContainText('完成', { timeout: 240_000 });
    await expect(page.getByTestId('runtime-pi-source')).toHaveText('hub 安装 v1.4.0', { timeout: 20_000 });
    expect(existsSync(join(runtimesDir, 'bin', 'pi'))).toBe(true);
    const version = spawnSync(join(runtimesDir, 'bin', 'pi'), ['--version'], { encoding: 'utf8', env: { PATH } });
    expect(version.stdout).toContain('1.4.0');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'install-03-installed.png') });

    // 正在装的时候再点会被拒；装完之后同版本也不让重装（按钮本来就没有）
    const again = await page.request.post(`/api/workers/${encodeURIComponent(workerId)}/runtimes/pi`, { data: { action: 'install', version: '1.4.0' } });
    expect(again.status()).toBe(409);

    await pi.getByTestId('runtime-pi-uninstall').click();
    await pi.getByTestId('runtime-pi-uninstall').click();
    await expect(page.getByTestId('runtime-pi-source')).toHaveText('未安装', { timeout: 30_000 });
    expect(existsSync(join(runtimesDir, 'bin', 'pi'))).toBe(false);

    const audit = (await (await page.request.get('/api/admin/audit')).json()) as { action: string }[];
    expect(audit.slice(0, 2).map((entry) => entry.action)).toEqual(['runtime.uninstall', 'runtime.install']);
  } finally {
    worker?.kill();
    rmSync(state, { recursive: true, force: true });
  }
});

test('运行时安装：机器自带的不让装，坏请求被挡', async ({ page }) => {
  await loginByApi(page);
  const workers = (await (await page.request.get('/api/workers')).json()) as {
    workerId: string;
    origin?: string;
    agentModels?: { agentId: string; provision?: { source: string } }[];
  }[];
  const local = workers.find((worker) => worker.origin === 'local');
  test.skip(!local, '没有本机 worker');
  const bad = await page.request.post(`/api/workers/${encodeURIComponent(local!.workerId)}/runtimes/pi`, { data: { action: 'install', version: '1.0; rm -rf /' } });
  expect(bad.status()).toBe(400);
  const machine = local!.agentModels?.find((harness) => harness.provision?.source === 'machine');
  if (machine) {
    const refused = await page.request.post(`/api/workers/${encodeURIComponent(local!.workerId)}/runtimes/${machine.agentId}`, { data: { action: 'install' } });
    expect(refused.status()).toBe(409);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain('以机器上的为准');
  }
});

test('窄屏：运行时一节不溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginByApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: /^Worker：/ }).first().click();
  await page.getByRole('button', { name: /本机/ }).first().click();
  const section = page.getByTestId('runtime-section');
  await expect(section).toBeVisible();
  const box = await section.boundingBox();
  expect(box && box.x + box.width).toBeLessThanOrEqual(390);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'install-04-mobile.png') });
});
