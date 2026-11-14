import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { e2eWorkerPath, e2eWorkerRoots } from './isolation.ts';

/**
 * 送达状态（ADR 0031 P2）：Worker 断开时发的消息在气泡下显示「未送达 · 第 n 次重试 · 立即重试 · 撤回」，
 * 后面那条显示「排队中 · 等上一条送达」；撤回后标「已撤回」；Worker 回来后送达，气泡下什么都不显示。用假 ACP agent。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'];
const FAKE = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');

test('送达状态：未送达 / 排队中 / 撤回 / 重连后送达', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const code = ((await (await page.request.post('/api/workers/pairing', { data: {}, headers })).json()) as { code: string }).code;
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  const PATH = e2eWorkerPath();
  const label = `e2e 送达机器 ${Date.now().toString(36)}`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], { env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label }, encoding: 'utf8' });
  expect(enrolled.status).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-dlv-'));
  const agents = [{ id: 'fakeacp', label: '假 ACP', command: process.execPath, args: [FAKE], listModelsArgs: [FAKE, '--models'] }];
  const start = (): ChildProcess =>
    spawn(process.execPath, ['apps/worker/src/main.ts'], {
      env: {
        PATH, HOME: state, HUB_URL: hubUrl, HUB_WORKER_CREDENTIAL: credential, WORKER_ID: workerId, WORKER_ORIGIN: 'remote', WORKER_LABEL: label,
        WORKER_ROOTS: e2eWorkerRoots(), WORKER_STATE_DIR: state, WORKER_RUNTIMES_DIR: join(state, 'runtimes'), ACP_AGENTS: JSON.stringify(agents)
      },
      stdio: 'ignore'
    });
  const online = async (want: boolean) => {
    for (let i = 0; i < 120; i++) {
      const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ id?: string; workerId?: string; state: string }>;
      const w = workers.find((x) => (x.workerId ?? x.id) === workerId);
      if ((w?.state === 'online') === want) return;
      await page.waitForTimeout(500);
    }
    throw new Error(`worker 没有${want ? '上线' : '下线'}`);
  };
  let worker: ChildProcess | null = start();
  const dir = mkdtempSync(join(tmpdir(), 'e2e-dlv-'));
  try {
    await online(true);
    const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 送达 ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers })).json()) as { id: string };
    const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '送达任务' }, headers })).json()) as { id: string };
    const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: 'fakeacp', model: '' }, headers });
    expect(derived.ok(), await derived.text()).toBe(true);
    const session = (await derived.json()) as { id: string };
    const say = async (text: string) => expect((await page.request.post(`/api/sessions/${session.id}/prompt`, { data: { text }, headers })).ok()).toBe(true);
    await say('第一句');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/#/p/${project.id}/focus/${session.id}`);
    const log = page.getByRole('log', { name: '会话记录' });
    await expect(log.getByText('第一句')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1_500);
    await expect(log.getByTestId('delivery-note')).toHaveCount(0); // 送达了就安静

    // 发送即时反馈：API 慢时，用户气泡先贴上，journal 回来后再让位给真实事件。
    let delayPrompt = true;
    await page.route('**/api/sessions/*/prompt', async (route) => {
      if (!delayPrompt) return route.continue();
      delayPrompt = false;
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await route.continue();
    });
    const composer = page.getByLabel('发送消息');
    await composer.fill('乐观反馈第四句');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByTestId('pending-prompts')).toContainText('乐观反馈第四句', { timeout: 600 });
    await expect(page.getByTestId('pending-prompts')).toHaveCount(0, { timeout: 15_000 });
    await expect(log.getByText('乐观反馈第四句')).toBeVisible({ timeout: 15_000 });

    worker.kill();
    worker = null;
    await online(false);
    await say('离线时发的第二句');
    await say('离线时发的第三句');
    const notes = page.getByTestId('delivery-note');
    await expect(notes.nth(0)).toContainText(/未送达 · 第 \d+ 次重试 \d+ 秒后/, { timeout: 30_000 });
    await expect(notes.nth(0).getByRole('button', { name: '立即重试' })).toBeVisible();
    await expect(notes.nth(1)).toHaveText('排队中 · 等上一条送达');
    // 排队的消息留在时间线原位（不再有独立排队区），靠状态字认出来
    await expect(log.getByText('离线时发的第二句')).toBeVisible();
    await expect(log.getByText('离线时发的第三句')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/delivery-pending-1280.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(notes.nth(1)).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/delivery-pending-390.png` });
    await page.setViewportSize({ width: 1280, height: 800 });

    // 「立即重试」：机器还不在，仍然没送到，但不报错
    await notes.nth(0).getByRole('button', { name: '立即重试' }).click();
    await expect(notes.nth(0)).toContainText('未送达');
    // 撤回第二句：标「已撤回」，第三句顶上来
    await notes.nth(0).getByRole('button', { name: '撤回' }).click();
    await expect(notes.nth(0)).toHaveText('已撤回 · 没有发给 agent');
    await expect(notes.nth(1)).toContainText(/未送达|排队中|发送中/);

    // Worker 回来：第三句送达，气泡下只剩「已撤回」
    worker = start();
    await online(true);
    await expect(notes).toHaveCount(1, { timeout: 90_000 });
    await expect(notes.first()).toHaveText('已撤回 · 没有发给 agent');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/delivery-done-1280.png` });
  } finally {
    worker?.kill();
    await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
    rmSync(state, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
