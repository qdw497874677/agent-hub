import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { e2eWorkerPath, e2eWorkerRoots } from './isolation.ts';

/**
 * 等我处理（ADR 0031 P4）：显式提问 → 等回答；问号结尾 → 可能在等你；这一轮 commit → 等审查；失败 → 失败了。
 * 首页顶部收件箱 + 角标 + 标题 (N)；「稍后」收起；打开会话停几秒自动看过。用假 ACP agent。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'];
const FAKE = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');

test('等我处理：四种要人的状态上榜，角标和标题带数，稍后 / 打开即收起', async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const code = ((await (await page.request.post('/api/workers/pairing', { data: {}, headers })).json()) as { code: string }).code;
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  const PATH = e2eWorkerPath();
  const label = `e2e 待办机器 ${Date.now().toString(36)}`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], { env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label }, encoding: 'utf8' });
  expect(enrolled.status).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-att-'));
  const agents = [{ id: 'fakeacp', label: '假 ACP', command: process.execPath, args: [FAKE], listModelsArgs: [FAKE, '--models'] }];
  const worker: ChildProcess = spawn(process.execPath, ['apps/worker/src/main.ts'], {
    env: {
      PATH, HOME: state, HUB_URL: hubUrl, HUB_WORKER_CREDENTIAL: credential, WORKER_ID: workerId, WORKER_ORIGIN: 'remote', WORKER_LABEL: label,
      WORKER_ROOTS: e2eWorkerRoots(), WORKER_STATE_DIR: state, WORKER_RUNTIMES_DIR: join(state, 'runtimes'), ACP_AGENTS: JSON.stringify(agents)
    },
    stdio: 'ignore'
  });
  const dir = mkdtempSync(join(tmpdir(), 'e2e-att-'));
  try {
    for (let i = 0; i < 120; i++) {
      const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ id?: string; workerId?: string; state: string }>;
      if (workers.find((x) => (x.workerId ?? x.id) === workerId)?.state === 'online') break;
      await page.waitForTimeout(500);
    }
    const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 待办 ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers })).json()) as { id: string };
    const run = async (title: string, text: string) => {
      const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title }, headers })).json()) as { id: string };
      const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: 'fakeacp', model: '' }, headers });
      expect(derived.ok(), await derived.text()).toBe(true);
      const s = (await derived.json()) as { id: string };
      expect((await page.request.post(`/api/sessions/${s.id}/prompt`, { data: { text }, headers })).ok()).toBe(true);
      return s.id;
    };
    const ids = {
      answer: await run('待办·显式提问', 'please-asktool'),
      maybe: await run('待办·问号结尾', 'please-question'),
      review: await run('待办·提交了', 'please-commit'),
      failed: await run('待办·失败', 'please-refuse'),
      quiet: await run('待办·安静', 'OK')
    };
    type Att = { items: Array<{ sessionId: string; phase: string; possible: boolean; since: number }>; working: number };
    let att: Att = { items: [], working: 0 };
    await expect.poll(async () => {
      att = (await (await page.request.get('/api/attention')).json()) as Att;
      return att.items.filter((i) => Object.values(ids).includes(i.sessionId)).length;
    }, { timeout: 60_000 }).toBe(4);
    const phase = (id: string) => att.items.find((i) => i.sessionId === id);
    expect(phase(ids.answer)).toMatchObject({ phase: 'needs_answer', possible: false });
    expect(phase(ids.maybe)).toMatchObject({ phase: 'needs_answer', possible: true });
    expect(phase(ids.review)?.phase).toBe('needs_review');
    expect(phase(ids.failed)?.phase).toBe('failed');
    expect(phase(ids.quiet)).toBeUndefined();

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    const inbox = page.getByTestId('attention-inbox');
    await expect(inbox).toContainText('等我处理');
    await expect(inbox).toContainText('等回答');
    await expect(inbox).toContainText('可能在等你');
    await expect(inbox).toContainText('等审查');
    await expect(inbox).toContainText('失败了');
    const n = att.items.length;
    await expect(page.getByTestId('attention-badge')).toContainText(String(n));
    await expect.poll(() => page.title()).toMatch(new RegExp(`^\\(${n}\\) `));
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/attention-1280.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/attention-390.png` });

    // 稍后：收起这一条
    await inbox.getByTestId('attention-item').filter({ hasText: '待办·问号结尾' }).getByTestId('attention-later').click();
    await expect(inbox.getByTestId('attention-item').filter({ hasText: '待办·问号结尾' })).toHaveCount(0);
    // 打开会话停几秒 = 看过
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/#/p/${project.id}/focus/${ids.review}`);
    await expect(page.getByTestId('attention-badge')).toContainText(String(n - 1));
    await expect(page.getByTestId('attention-badge')).toContainText(String(n - 2), { timeout: 15_000 });
    // 阶段变了重新上榜：失败那条再说一句提问
    await page.request.post(`/api/sessions/${ids.maybe}/prompt`, { data: { text: 'please-asktool' }, headers });
    await expect.poll(async () => {
      const a = (await (await page.request.get('/api/attention')).json()) as Att;
      return a.items.find((i) => i.sessionId === ids.maybe)?.possible;
    }, { timeout: 30_000 }).toBe(false);
  } finally {
    worker.kill();
    await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
    rmSync(state, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
