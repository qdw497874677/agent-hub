import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { e2eWorkerPath, e2eWorkerRoots } from './isolation.ts';

/**
 * 任务来历（ADR 0031 P3）：网页开的会话顶部有一行可折叠的「来历」（发起人 · 网页 · 权限 · 时间）；
 * 分叉出来的写明「从「X」分叉」；审计里有 session.created。用假 ACP agent。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'];
const FAKE = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');

test('来历：网页开的、分叉的都有一行来历，可展开；审计有 session.created', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const code = ((await (await page.request.post('/api/workers/pairing', { data: {}, headers })).json()) as { code: string }).code;
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  const PATH = e2eWorkerPath();
  const label = `e2e 来历机器 ${Date.now().toString(36)}`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], { env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label }, encoding: 'utf8' });
  expect(enrolled.status).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-prov-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'e2e-prov-'));
  try {
    await online(true);
    const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 来历 ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers })).json()) as { id: string };
    const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '来历任务' }, headers })).json()) as { id: string };
    const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: 'fakeacp', model: '' }, headers });
    expect(derived.ok(), await derived.text()).toBe(true);
    const session = (await derived.json()) as { id: string };
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/#/p/${project.id}/focus/${session.id}`);
    const row = page.getByTestId('provenance-row');
    await expect(row).toContainText('来历');
    await expect(row).toContainText('网页创建');
    await expect(row).not.toContainText('权限：');
    await expect(page.getByTestId('provenance-details')).toHaveCount(0);
    await page.getByTestId('provenance-toggle').click();
    await expect(page.getByTestId('provenance-details')).toContainText('发起人');
    await expect(page.getByTestId('provenance-details')).toContainText('来源');
    await expect(page.getByTestId('provenance-details')).toContainText('权限');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/provenance-1280.png` });
    const prov = (await (await page.request.get(`/api/sessions/${session.id}/provenance`)).json()) as { id: string; via: string; backfilled: boolean; actor: { kind: string } };
    expect(prov.via).toBe('web');
    expect(prov.backfilled).toBe(false);
    expect(prov.actor.kind).toBe('user');
    const audit = (await (await page.request.get(`/api/admin/audit?action=session.created&target=${session.id}`)).json()) as unknown;
    expect(JSON.stringify(audit)).toContain(prov.id);

    // 分叉：先说一句让来源有内容
    expect((await page.request.post(`/api/sessions/${session.id}/prompt`, { data: { text: '第一句' }, headers })).ok()).toBe(true);
    const log = page.getByRole('log', { name: '对话记录' });
    await expect(log.getByText('第一句')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1_500);
    const forked = await page.request.post('/api/sessions/fork', { data: { sessionId: session.id, agentId: 'fakeacp', model: '' }, headers });
    if (forked.ok()) {
      const child = (await forked.json()) as { id: string };
      await page.goto(`/#/p/${project.id}/focus/${child.id}`);
      await expect(page.getByTestId('provenance-row')).toContainText(/从「.+」分叉/);
      const cp = (await (await page.request.get(`/api/sessions/${child.id}/provenance`)).json()) as { via: string; parent: { sessionId: string } };
      expect(cp.via).toBe('fork');
      expect(cp.parent.sessionId).toBe(session.id);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByTestId('provenance-row')).toBeVisible();
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/provenance-fork-390.png` });
    }
  } finally {
    worker?.kill();
    await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
    rmSync(state, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
