import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { piModel } from './hub-model.ts';

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

type ContrastSample = { fg: string; bg: string; ratio: number; theme: string };

/** 临时切主题只改 DOM；不写 localStorage，免得影响同页后续断言。 */
async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((next) => {
    document.documentElement.dataset['theme'] = next;
  }, theme);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

/**
 * 取元素真实的前景/背景计算对比度。背景沿祖先往上找，alpha 层按顺序叠，
 * 断言的是浏览器算出来的颜色，而不是测试里另抄一份令牌。
 */
async function contrastOf(locator: Locator): Promise<ContrastSample> {
  return locator.evaluate((element) => {
    const parse = (value: string): [number, number, number, number] => {
      const parts = (value.match(/[-+]?\d*\.?\d+/g) ?? []).map(Number);
      // Chromium 把 color-mix 算成 color(srgb …) 或 oklab(…)；都换回 0–255 的 sRGB。
      if (value.startsWith('oklab(') || value.startsWith('oklch(')) {
        const lightness = parts[0] ?? 0;
        const isPolar = value.startsWith('oklch(');
        const chroma = parts[1] ?? 0;
        const hue = parts[2] ?? 0;
        const a = isPolar ? chroma * Math.cos((hue * Math.PI) / 180) : chroma;
        const b = isPolar ? chroma * Math.sin((hue * Math.PI) / 180) : hue;
        const l1 = lightness + 0.3963377774 * a + 0.2158037573 * b;
        const m1 = lightness - 0.1055613458 * a - 0.0638541728 * b;
        const s1 = lightness - 0.0894841775 * a - 1.291485548 * b;
        const l3 = l1 ** 3;
        const m3 = m1 ** 3;
        const s3 = s1 ** 3;
        const linear = [
          4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
          -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
          -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3
        ];
        const toSrgb = (channel: number): number => {
          const clamped = Math.min(1, Math.max(0, channel));
          const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
          return encoded * 255;
        };
        return [toSrgb(linear[0]!), toSrgb(linear[1]!), toSrgb(linear[2]!), parts[3] ?? 1];
      }
      const scale = value.startsWith('color(srgb') ? 255 : 1;
      return [(parts[0] ?? 0) * scale, (parts[1] ?? 0) * scale, (parts[2] ?? 0) * scale, parts[3] ?? 1];
    };
    const channel = (value: number): number => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance = ([r, g, b]: [number, number, number, number]): number =>
      0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    const over = (
      top: [number, number, number, number],
      bottom: [number, number, number, number]
    ): [number, number, number, number] => {
      const alpha = top[3];
      return [
        top[0] * alpha + bottom[0] * (1 - alpha),
        top[1] * alpha + bottom[1] * (1 - alpha),
        top[2] * alpha + bottom[2] * (1 - alpha),
        1
      ];
    };
    const format = ([r, g, b]: [number, number, number, number]): string =>
      `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;

    const layers: [number, number, number, number][] = [];
    let node: Element | null = element;
    while (node) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color[3] > 0) layers.push(color);
      if (color[3] >= 0.999) break;
      node = node.parentElement;
    }
    let background = layers[layers.length - 1] ?? ([255, 255, 255, 1] as [number, number, number, number]);
    for (let index = layers.length - 2; index >= 0; index -= 1) background = over(layers[index]!, background);

    const foreground = parse(getComputedStyle(element).color);
    const a = luminance(foreground);
    const b = luminance(background);
    return {
      fg: format(foreground),
      bg: format(background),
      ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      theme: document.documentElement.dataset['theme'] ?? ''
    };
  });
}

const WARNING_COLOR = { light: 'rgb(122, 92, 0)', dark: 'rgb(214, 180, 80)' } as const;

async function expectWarningContrast(locator: Locator, theme: 'light' | 'dark', label: string): Promise<void> {
  const sample = await contrastOf(locator);
  console.log(`${label} ${theme}: ${sample.fg} on ${sample.bg} = ${sample.ratio.toFixed(2)}:1`);
  expect(sample.theme, `${label}：主题`).toBe(theme);
  expect(sample.fg, `${label}：${theme} 下用的是 --color-warning`).toBe(WARNING_COLOR[theme]);
  expect(sample.ratio, `${label}：${theme} 下 ${sample.fg} on ${sample.bg} 对比度`).toBeGreaterThanOrEqual(4.5);
}

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
  // 派生会话：worker 刚上线 / 工作目录还在准备时，derive 会瞬时被拒（409 冲突或 5xx），给两三次机会；
  // 最终失败时断言 201 并把真实响应体带进报错和 annotations，别让状态码被吞掉。
  const derive = async () => {
    const data = { taskId: task.id, agentId: worker!.agentIds[0], model: piModel() };
    let status = 0;
    let text = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await page.request.post('/api/sessions/derive', { data, headers });
      status = res.status();
      text = await res.text();
      if (status === 201) return (JSON.parse(text) as { id: string }).id;
      const transient = status === 409 || status >= 500;
      console.warn(`[e2e] POST /api/sessions/derive 第 ${attempt} 次被拒：${status} ${text}`);
      if (!transient || attempt === 3) break;
      await page.waitForTimeout(1000 * attempt);
    }
    test.info().annotations.push({ type: 'derive-failed', description: `${status} ${text}` });
    expect(status, text).toBe(201);
    throw new Error(`POST /api/sessions/derive 被拒：${status} ${text}`);
  };
  const a = await derive();
  const b = await derive();
  const now = Date.now();
  await page.route('**/api/workers', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    // 用例收尾关页面时轮询可能还在路上：这时 fetch 会抛「页面已关」，忽略即可
    const response = await route.fetch().catch(() => null);
    if (!response) return;
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
      await expect(badge).toHaveAttribute('title', /资源偏紧/);
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        // 390 下徽标只剩一个点，文本按设计隐藏；真正渲染出字的宽度才量文字对比度。
        if (width >= 640) {
          await expectWarningContrast(
            badge.getByTestId('worker-frame-resources-text'),
            theme,
            '画布资源徽标'
          );
        }
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `canvas-${width}-${theme}.png`) });
      }

      // 机器列表：窄屏顶栏不放机器徽标，在首页侧栏底部
      if (width < 768) await page.goto('/#/');
      await page.getByRole('link', { name: /^机器：/ }).first().click();
      const summaries = page.getByTestId('worker-resources');
      await expect(summaries).toHaveCount(2);
      const fresh = page.locator('[data-testid="worker-resources"][data-level="warn"]');
      await expect(fresh).toContainText('CPU 37%');
      await expect(fresh).toContainText('内存 91%');
      await expect(fresh).toContainText('盘剩 64G');
      await expect(fresh).toContainText('GPU 20%');
      await expect(fresh).toHaveAttribute('title', /资源偏紧/);
      await expect(page.locator('[data-testid="worker-resources"][data-level="none"]')).toHaveText('CPU — · 内存 — · 盘 —');
      // 摘要不横向溢出（窄屏）
      const box = (await fresh.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await expectWarningContrast(fresh, theme, '机器列表资源摘要');
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `machines-${width}-${theme}.png`) });
      }
      await fresh.click();
      const details = page.getByTestId('worker-resource-details');
      await expect(details).toContainText('资源偏紧');
      await expect(details).toContainText('内存只剩 9%');
      await expect(details).toContainText('/home 剩 64G / 200G');
      await expect(details).toContainText('NVIDIA T4');
      await expect(page.getByTestId('refuse-when-full')).not.toBeChecked();
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await expectWarningContrast(
          details.getByTestId('worker-resource-warning'),
          theme,
          '机器详情资源警告'
        );
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `machines-detail-${width}-${theme}.png`) });
      }
    });
  }
});
