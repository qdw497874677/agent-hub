import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * 机器资源（ADR 0014）：
 * - 真链路：测试环境的 worker 握手声明 metrics 能力，hub 在 welcome 里接受，之后 /api/workers 带上资源、/metrics 有历史；
 * - 界面：机器列表的摘要按压力着色、展开有明细和「满了拒绝新会话」开关；画布机器框有徽标（窄屏只剩一个点）；会话卡有用量；
 * - 兼容：老 worker（没资源）照常显示，摘要是「—」，框上没有徽标。
 * 界面用例在 /api/workers 响应里注入固定的资源和一台老 worker，免得数字跳。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'];
const GiB = 1024 ** 3;
const OLD = 'old-worker-e2e';

type WorkerJson = { workerId: string; state: string; agentIds: string[]; label: string; resources?: unknown; [key: string]: unknown };

async function login(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  return { origin: baseURL, 'x-hub-csrf': csrf };
}

async function onlineWorker(page: Page, withResources = false): Promise<WorkerJson | undefined> {
  for (let i = 0; i < 80; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as WorkerJson[];
    const found = workers.find((worker) => worker.state === 'online' && worker.agentIds.length > 0 && (!withResources || worker.resources));
    if (found) return found;
    await page.waitForTimeout(500);
  }
  return undefined;
}

test('真链路：worker 上报资源，/api/workers 带最新一份，/metrics 有历史，开关能开能关', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  const headers = await login(page, baseURL!);
  const worker = await onlineWorker(page, true);
  expect(worker, '40 秒内应收到第一份资源').toBeTruthy();
  const resources = worker!.resources as { sample: { machine: { memTotal: number; cores: number; disks: unknown[] } }; pressure: { level: string }; refuseWhenFull: boolean };
  expect(resources.sample.machine.memTotal).toBeGreaterThan(0);
  expect(resources.sample.machine.cores).toBeGreaterThan(0);
  expect(resources.sample.machine.disks.length).toBeGreaterThan(0);
  expect(['ok', 'warn', 'full']).toContain(resources.pressure.level);
  const history = (await (await page.request.get(`/api/workers/${encodeURIComponent(worker!.workerId)}/metrics`)).json()) as { samples: unknown[] };
  expect(history.samples.length).toBeGreaterThan(0);
  // 没上报过的机器：空历史，不报错
  expect(((await (await page.request.get('/api/workers/nope-e2e/metrics')).json()) as { samples: unknown[] }).samples).toEqual([]);

  const put = (on: boolean) => page.request.put(`/api/workers/${encodeURIComponent(worker!.workerId)}/resource-policy`, { data: { refuseWhenFull: on }, headers });
  expect((await put(true)).ok()).toBe(true);
  const after = (await (await page.request.get('/api/workers')).json()) as WorkerJson[];
  expect((after.find((w) => w.workerId === worker!.workerId)?.resources as { refuseWhenFull: boolean }).refuseWhenFull).toBe(true);
  expect((await put(false)).ok()).toBe(true);
  expect((await page.request.put(`/api/workers/${encodeURIComponent(worker!.workerId)}/resource-policy`, { data: { refuseWhenFull: 'yes' }, headers })).status()).toBe(400);
});

async function setupCanvas(page: Page, baseURL: string) {
  const headers = await login(page, baseURL);
  const worker = await onlineWorker(page);
  test.skip(!worker, '这台机器上没有可用的 agent');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-res-'));
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 资源 ${Date.now().toString(36)}`, rootPath: dir }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '资源' }, headers })).json()) as { id: string };
  rmSync(dir, { recursive: true, force: true });
  const derive = async () => ((await (await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: worker!.agentIds[0], model: '' }, headers })).json()) as { id: string }).id;
  const a = await derive();
  const b = await derive();
  const now = Date.now();
  await page.route('**/api/workers', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as WorkerJson[];
    for (const w of body) {
      if (w.workerId !== worker!.workerId) continue;
      w.resources = {
        sample: {
          at: now,
          machine: {
            cpuPercent: 37,
            cores: 8,
            load: [1.2, 0.9, 0.7],
            memTotal: 16 * GiB,
            memAvailable: 1.5 * GiB,
            swapUsed: 0,
            disks: [{ root: '/home', total: 200 * GiB, free: 64 * GiB }],
            gpus: [{ name: 'NVIDIA T4', utilPercent: 20, memTotal: 16 * GiB, memUsed: 2 * GiB }],
            uptimeSec: 3600
          },
          sessions: [{ sessionId: a, cpuPercent: 12, rss: 480 * 1024 ** 2, processes: 3 }]
        },
        pressure: { level: 'warn', reasons: ['内存只剩 9%'] },
        refusing: false,
        refuseWhenFull: false
      };
    }
    body.push({ ...body[0]!, workerId: OLD, label: '老 worker', origin: 'remote', state: 'online', resources: undefined, sessionCount: 0 });
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/api/projects/${project.id}/canvas`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { sessions: Array<{ id: string; workerId: string | null }> };
    for (const session of body.sessions) if (session.id === b) session.workerId = OLD;
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/#/p/${project.id}/canvas`);
  await expect(page.locator('.react-flow__node-session')).toHaveCount(2);
  return { worker: worker!, a, b };
}

test.describe('资源展示', () => {
  test.use({ hasTouch: true });
  for (const width of [1280, 390]) {
    test(`${width}px：机器列表摘要与明细、画布框徽标、会话用量；老 worker 显示「—」`, async ({ page, baseURL }) => {
      await page.setViewportSize({ width, height: 844 });
      const { a, b } = await setupCanvas(page, baseURL!);

      // 画布：新 worker 框有徽标（桌面带数字，窄屏只剩点），老 worker 框没有
      const frames = page.getByTestId('worker-frame');
      await expect(frames).toHaveCount(2);
      const badge = page.getByTestId('worker-frame-resources');
      await expect(badge).toHaveCount(1);
      await expect(badge).toHaveAttribute('data-level', 'warn');
      if (width >= 640) await expect(badge).toContainText('CPU 37%');
      else await expect(badge.getByText(/CPU/)).toBeHidden();
      // 徽标不能把标题栏挤出框
      const handle = (await page.getByTestId('worker-frame-handle').first().boundingBox())!;
      const badgeBox = (await badge.boundingBox())!;
      expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(handle.x + handle.width + 1);
      await expect(page.locator(`.react-flow__node[data-id="${a}"]`).getByTestId('session-usage')).toHaveText('◔ 12% · 480M');
      await expect(page.locator(`.react-flow__node[data-id="${b}"]`).getByTestId('session-usage')).toHaveCount(0);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `canvas-${width}.png`) });

      // 机器列表：窄屏顶栏不放机器徽标，在首页侧栏底部
      if (width < 768) await page.goto('/#/');
      await page.getByRole('button', { name: /^Worker：/ }).first().click();
      const summaries = page.getByTestId('worker-resources');
      await expect(summaries).toHaveCount(2);
      const fresh = page.locator('[data-testid="worker-resources"][data-level="warn"]');
      await expect(fresh).toContainText('CPU 37%');
      await expect(fresh).toContainText('内存 91%');
      await expect(fresh).toContainText('盘剩 64G');
      await expect(fresh).toContainText('GPU 20%');
      await expect(page.locator('[data-testid="worker-resources"][data-level="none"]')).toHaveText('CPU — · 内存 — · 盘 —');
      // 摘要不横向溢出（窄屏）
      const box = (await fresh.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await fresh.click();
      const details = page.getByTestId('worker-resource-details');
      await expect(details).toContainText('内存只剩 9%');
      await expect(details).toContainText('/home 剩 64G / 200G');
      await expect(details).toContainText('NVIDIA T4');
      await expect(page.getByTestId('refuse-when-full')).not.toBeChecked();
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `machines-${width}.png`) });
    });
  }
});
