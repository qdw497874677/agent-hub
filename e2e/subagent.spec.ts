import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { e2eWorkerPath, e2eWorkerRoots } from './isolation.ts';

/**
 * 子代理时间线：OpenCode 通过 child-session-updates 把子会话塞进同一轮。
 * 这里用 fake ACP agent 的 --child 场景，确认子代理折叠在主对话里，而不是多出一条 Hub 会话。
 */
const FAKE = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');

test('子代理事件折叠成会话内的卡片，并显示完成状态', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const code = ((await (await page.request.post('/api/workers/pairing', { data: {}, headers })).json()) as { code: string }).code;
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  const PATH = e2eWorkerPath();
  const label = `e2e 子代理机器 ${Date.now().toString(36)}`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], {
    env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label },
    encoding: 'utf8'
  });
  expect(enrolled.status).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-subagent-'));
  const agents = [
    {
      id: 'fakeacp',
      label: '假 ACP',
      command: process.execPath,
      args: [FAKE, '--child'],
      listModelsArgs: [FAKE, '--models'],
      codecId: 'opencode'
    }
  ];
  const worker: ChildProcess = spawn(process.execPath, ['apps/worker/src/main.ts'], {
    env: {
      PATH,
      HOME: state,
      HUB_URL: hubUrl,
      HUB_WORKER_CREDENTIAL: credential,
      WORKER_ID: workerId,
      WORKER_ORIGIN: 'remote',
      WORKER_LABEL: label,
      WORKER_ROOTS: e2eWorkerRoots(),
      WORKER_STATE_DIR: state,
      WORKER_RUNTIMES_DIR: join(state, 'runtimes'),
      ACP_AGENTS: JSON.stringify(agents)
    },
    stdio: 'ignore'
  });
  const dir = mkdtempSync(join(tmpdir(), 'e2e-subagent-'));
  try {
    for (let i = 0; i < 120; i++) {
      const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ id?: string; workerId?: string; state: string }>;
      if (workers.find((item) => (item.workerId ?? item.id) === workerId)?.state === 'online') break;
      await page.waitForTimeout(500);
    }
    const project = (await (
      await page.request.post('/api/projects', {
        data: { name: `e2e 子代理 ${Date.now().toString(36)}`, rootPath: dir, workerId },
        headers
      })
    ).json()) as { id: string };
    const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '子代理任务' }, headers })).json()) as { id: string };
    const derived = await page.request.post('/api/sessions/derive', {
      data: { taskId: task.id, agentId: 'fakeacp', model: '' },
      headers
    });
    expect(derived.ok(), await derived.text()).toBe(true);
    const session = (await derived.json()) as { id: string };
    expect((await page.request.post(`/api/sessions/${session.id}/prompt`, { data: { text: 'please-child' }, headers })).ok()).toBe(true);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/#/p/${project.id}/focus/${session.id}`);
    const log = page.getByRole('log', { name: '对话记录' });
    const card = log.getByTestId('subagent-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toHaveAttribute('data-status', 'completed');
    await expect(card).toContainText('explorer');
    await expect(card).toContainText('child task');
    await expect(card.locator('summary').first()).toContainText('2 步');
    await card.locator('summary').first().click();
    await expect(card).toContainText('child says hi');

    await page.getByRole('button', { name: '画布', exact: true }).click();
    const badge = page.getByTestId('card-subagent');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('explorer');
  } finally {
    worker.kill();
    await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
    rmSync(state, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
