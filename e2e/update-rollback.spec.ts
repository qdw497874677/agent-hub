import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * 自更新后新版本起不来、启动守卫把旧版换回来之后：Worker 用旧版连上 hub 时补报「已回退」，
 * 运营后台「机器」里显示「已回退」、坏掉的提交和原因（日志可展开），而不是停在「更新成功」。
 * 这里直接放一份守卫写的回退记录（update-rolledback），模拟守卫刚回退完。
 */
test('自动回退后，运营后台显示「已回退」和原因', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const pairing = await page.request.post('/api/workers/pairing', { data: {}, headers });
  expect(pairing.ok()).toBe(true);
  const code = ((await pairing.json()) as { code: string }).code;
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  const PATH = '/usr/local/bin:/usr/bin:/bin';
  const label = 'e2e 回退机器';
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], { env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label }, encoding: 'utf8' });
  expect(enrolled.status).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');

  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-rb-'));
  const failed = 'c'.repeat(40);
  const restored = 'd'.repeat(40);
  const note = join(state, 'update-rolledback');
  writeFileSync(note, `${failed} ${restored}\n新版本 ccccccc 连续 2 次启动都没能连上 hub 并稳定运行，启动守卫已把旧版目录换回来。\n--- 最近的 Worker 日志 ---\nError: e2e 故意坏掉\n`);
  let worker: ChildProcess | null = null;
  try {
    worker = spawn(process.execPath, ['apps/worker/src/main.ts'], {
      env: { PATH, HOME: state, HUB_URL: hubUrl, HUB_WORKER_CREDENTIAL: credential, WORKER_ID: workerId, WORKER_ORIGIN: 'remote', WORKER_LABEL: label, WORKER_ROOTS: '/tmp', WORKER_STATE_DIR: state, WORKER_RUNTIMES_DIR: join(state, 'runtimes') },
      stdio: 'ignore'
    });
    await page.goto('/#/admin/workers');
    const row = page.getByTestId('admin-worker').filter({ hasText: label });
    const update = row.getByTestId('worker-update');
    await expect(update).toContainText('已回退', { timeout: 30_000 });
    await expect(update).toContainText('新版本 ccccccc 没能正常启动，已自动回退到 ddddddd');
    await update.locator('summary').click();
    await expect(update.locator('pre')).toContainText('Error: e2e 故意坏掉');
    await expect(update.locator('span').first()).toHaveClass(/text-rust/);
    await expect.poll(() => existsSync(note), { timeout: 10_000 }).toBe(false);
  } finally {
    worker?.kill();
    await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
    rmSync(state, { recursive: true, force: true });
  }
});
