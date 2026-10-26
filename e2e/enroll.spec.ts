import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, request as apiRequest } from '@playwright/test';
import { loginByApi } from './login.ts';

const SHOTS = process.env['E2E_SCREENSHOTS'];

/**
 * 添加机器的整条路：控制台签码 → 新机器经 /worker 长连接凭码换凭据 → 用专属凭据连上（对话框里显示已连上）
 * → 在机器面板里吊销 → 那台立刻断开、不再重连、码也不能再用。
 */
test('添加机器：一行命令、倒计时、凭码接入、吊销后断开', async ({ page, baseURL }) => {
  await loginByApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: /^Worker：/ }).first().click();
  await page.getByRole('button', { name: '添加机器' }).click();

  const dialog = page.getByRole('dialog', { name: '添加机器' });
  const command = dialog.getByLabel('安装命令');
  await expect(command).toContainText('/install-worker.sh | HUB_PAIR=ahw_pair_');
  await expect(dialog.getByText(/1[45]:\d\d 后过期 · 只能用一次/)).toBeVisible();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'add-machine-desktop.png') });

  const text = (await command.textContent()) ?? '';
  const code = /HUB_PAIR=(\S+)/.exec(text)?.[1] ?? '';
  const script = await page.request.get('/install-worker.sh');
  expect(await script.text()).toContain(`HUB_HTTP="\${HUB_HTTP:-${baseURL}}"`);

  // 新机器那一侧：不带任何登录态，跑安装脚本用的同一个 CLI，经 /worker 长连接凭码换凭据
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  const enroll = (pair: string) =>
    spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], {
      env: { PATH: process.env['PATH'] ?? '', HUB_URL: hubUrl, HUB_PAIR: pair, WORKER_LABEL: 'e2e 新机器' },
      encoding: 'utf8'
    });
  const enrolled = enroll(code);
  expect(enrolled.status).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  expect(credential).toMatch(/^ahw_/);
  const reused = enroll(code);
  expect(reused.status).toBe(1);
  expect(reused.stdout).toBe('');
  // 旧的 HTTP 兑换口已拿掉
  const machine = await apiRequest.newContext({ baseURL });
  expect((await machine.post('/api/workers/enroll', { data: { code, label: 'x' } })).ok()).toBe(false);

  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-worker-'));
  let worker: ChildProcess | null = null;
  try {
    worker = spawn(process.execPath, ['apps/worker/src/main.ts'], {
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: state,
        HUB_URL: hubUrl,
        HUB_WORKER_CREDENTIAL: credential,
        WORKER_ID: workerId,
        WORKER_ORIGIN: 'remote',
        WORKER_LABEL: 'e2e 新机器',
        WORKER_ROOTS: '/tmp',
        WORKER_STATE_DIR: state
      },
      stdio: 'ignore'
    });
    await expect(dialog.getByText('✓ e2e 新机器 已连上')).toBeVisible();
    await dialog.getByRole('button', { name: '完成' }).click();

    await page.getByRole('button', { name: /^Worker：/ }).first().click();
    await page.getByRole('button', { name: /e2e 新机器/ }).click();
    await page.getByRole('button', { name: '吊销这台机器' }).click();
    await page.getByRole('button', { name: '确认吊销' }).click();
    await expect(page.getByRole('button', { name: /e2e 新机器/ })).toHaveCount(0);

    const audit = (await (await page.request.get('/api/admin/audit')).json()) as { action: string; target: string }[];
    expect(audit.slice(0, 3).map((entry) => entry.action)).toEqual(['worker.revoke', 'worker.enroll', 'worker.pair']);
    // 吊销后它不会再回来（4401 不重连）
    await page.waitForTimeout(1500);
    const workers = (await (await page.request.get('/api/workers')).json()) as { workerId: string }[];
    expect(workers.some((entry) => entry.workerId === workerId)).toBe(false);
  } finally {
    worker?.kill();
    rmSync(state, { recursive: true, force: true });
  }
});

test('窄屏：添加机器贴底成 sheet，命令可读可复制', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginByApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: /^Worker：/ }).first().click();
  await page.getByRole('button', { name: '添加机器' }).click();
  const dialog = page.getByRole('dialog', { name: '添加机器' });
  await expect(dialog.getByLabel('安装命令')).toContainText('HUB_PAIR=ahw_pair_');
  const box = await dialog.boundingBox();
  expect(box && box.width).toBeLessThanOrEqual(390);
  expect(box && box.y + box.height).toBeGreaterThan(700); // 贴底，拇指够得着
  await expect(dialog.getByRole('button', { name: '复制命令' })).toBeEnabled();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'add-machine-mobile.png') });
});
