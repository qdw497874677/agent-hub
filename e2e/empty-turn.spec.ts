import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { e2eWorkerPath, e2eWorkerRoots } from './isolation.ts';

/**
 * 空回合（ACP agent 一句话没回就 end_turn）要显示成红色错误，不能静默成「完成」；
 * Worker 启动后的模型自检要把「模型不通」报到控制台。用假 ACP agent（test-fixtures/fake-agent.mjs），不调真模型。
 */
const SHOTS = '/tmp/opencode/shots/empty-turn-error';
const FAKE = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');

test('空回合显示红色错误，模型自检失败显示在机器列表', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const pairing = await page.request.post('/api/workers/pairing', { data: {}, headers });
  expect(pairing.ok()).toBe(true);
  const code = ((await pairing.json()) as { code: string }).code;
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  const PATH = e2eWorkerPath();
  const label = `e2e 空回合机器 ${Date.now().toString(36)}`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], { env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label }, encoding: 'utf8' });
  expect(enrolled.status).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-empty-'));
  const agents = [
    { id: 'fakeacp', label: '假 ACP', command: process.execPath, args: [FAKE], listModelsArgs: [FAKE, '--models'] },
    { id: 'fakebroken', label: '坏 ACP', command: process.execPath, args: [FAKE, '--empty-all'], listModelsArgs: [FAKE, '--models'] }
  ];
  let worker: ChildProcess | null = null;
  try {
    worker = spawn(process.execPath, ['apps/worker/src/main.ts'], {
      env: {
        PATH, HOME: state, HUB_URL: hubUrl, HUB_WORKER_CREDENTIAL: credential, WORKER_ID: workerId, WORKER_ORIGIN: 'remote', WORKER_LABEL: label,
        WORKER_ROOTS: e2eWorkerRoots(), WORKER_STATE_DIR: state, WORKER_RUNTIMES_DIR: join(state, 'runtimes'),
        ACP_AGENTS: JSON.stringify(agents), WORKER_MODEL_CHECK_TIMEOUT_MS: '15000'
      },
      stdio: 'ignore'
    });

    // 1) 控制台：坏 agent 的模型自检失败（红字），好 agent 通过
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/#/admin/workers');
    const row = page.getByTestId('admin-worker').filter({ hasText: label });
    const check = row.getByTestId('harness-check');
    await expect(check).toContainText('模型自检失败', { timeout: 60_000 });
    await expect(check).toContainText('fakebroken');
    await expect(check).toContainText('agent 没有返回任何内容');
    await expect(check).not.toContainText('livesecret');
    await expect(row.locator('[data-check="ok"]')).toHaveCount(1);
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, 'selfcheck-1280.png') });

    // 2) 会话：空回合 → 红色错误，带 stopReason 和脱敏后的 stderr
    const dir = mkdtempSync(join(tmpdir(), 'e2e-empty-turn-'));
    const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 空回合 ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers })).json()) as { id: string };
    const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '空回合任务' }, headers })).json()) as { id: string };
    const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: 'fakeacp', model: '' }, headers });
    expect(derived.ok(), await derived.text()).toBe(true);
    const session = (await derived.json()) as { id: string };
    const prompted = await page.request.post(`/api/sessions/${session.id}/prompt`, { data: { text: 'please-empty' }, headers });
    expect(prompted.ok(), await prompted.text()).toBe(true);

    await page.goto(`/#/p/${project.id}/focus/${session.id}`);
    const error = page.getByText('agent 没有返回任何内容（可能是模型/鉴权/网络问题）').first();
    await expect(error).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/stopReason: end_turn/).first()).toBeVisible();
    await expect(page.getByText(/401 Unauthorized/).first()).toBeVisible();
    await expect(page.getByText(/livesecret|abcdefghijklmnop/)).toHaveCount(0);
    await page.screenshot({ path: join(SHOTS, 'session-1280.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByText('agent 没有返回任何内容（可能是模型/鉴权/网络问题）').first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: join(SHOTS, 'session-390.png') });
    await page.goto('/#/admin/workers');
    await expect(page.getByTestId('admin-worker').filter({ hasText: label }).getByTestId('harness-check')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('admin-worker').filter({ hasText: label }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, 'selfcheck-390.png') });
    rmSync(dir, { recursive: true, force: true });
  } finally {
    worker?.kill();
    await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
    rmSync(state, { recursive: true, force: true });
  }
});
