import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { e2eWorkerPath, e2eWorkerRoots } from './isolation.ts';

/**
 * 首页在窄屏上只有一个滚动源：上段（招牌 / 导航 / 项目）与下段（等我处理 / 任务队列 / 搜索 /
 * 接着干哪条）在同一个滚动容器里，手指在哪一屏划都是同一份内容。
 *
 * 之前的实现是 aside `max-h-[40dvh]` 自带滚动 + main 再滚一次：在上半屏划手指到不了会话，
 * 角标的「滚到收件箱」也只能滚 main、滚不动 aside，40dvh 还不跟 --app-height 收
 * （键盘弹起时下段被压到几乎没有）。这里按真实结构断言，不数「整页有几个可滚元素」。
 */

const SHOTS = process.env['E2E_SCREENSHOTS'];
const FAKE = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');

test.use({ hasTouch: true });

type Box = { overflowY: string; clientHeight: number; scrollHeight: number; scrollTop: number } | null;

/** 首页自身的三层盒子：外层滚动容器 / 侧栏 / 内容区。 */
async function structure(page: Page): Promise<{
  root: Box;
  aside: Box;
  main: Box;
  docScrollY: number;
  docScrollHeight: number;
  innerHeight: number;
}> {
  return page.getByTestId('home-root').evaluate((root) => {
    const pick = (el: Element | null) => {
      if (!el) return null;
      const style = getComputedStyle(el);
      return {
        overflowY: style.overflowY,
        clientHeight: (el as HTMLElement).clientHeight,
        scrollHeight: (el as HTMLElement).scrollHeight,
        scrollTop: (el as HTMLElement).scrollTop
      };
    };
    return {
      root: pick(root),
      aside: pick(root.querySelector('aside')),
      main: pick(root.querySelector('main')),
      docScrollY: window.scrollY,
      docScrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight
    };
  });
}

/**
 * 手指在 (x, y) 处往上划：真实的触摸滚动，不是 mouse wheel。
 * 这台机器上的 Chromium 不吃 `Input.synthesizeScrollGesture` 的 touch 源（实测 scrollTop 不动），
 * 所以自己发 touchStart/touchMove/touchEnd 序列——同一条触摸管线，能真触发浏览器原生滚动。
 */
async function touchSwipeUp(page: Page, x: number, y: number, distance = 300): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const steps = 12;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - (distance * i) / steps }] });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
  await page.waitForTimeout(200);
}

async function pollAttention(page: Page, sessionIds: readonly string[], workerLog: string): Promise<void> {
  let detail = '';
  for (let i = 0; i < 180; i++) {
    const view = (await (await page.request.get('/api/attention')).json()) as {
      items: Array<{ sessionId: string; phase: string }>;
    };
    const found = view.items.filter((item) => sessionIds.includes(item.sessionId));
    if (found.length === sessionIds.length) return;
    const home = (await (await page.request.get('/api/home')).json()) as {
      recentSessions: Array<{ sessionId: string; status: string }>;
    };
    detail = sessionIds
      .map((id) => {
        const item = view.items.find((row) => row.sessionId === id);
        const row = home.recentSessions.find((r) => r.sessionId === id);
        return `${id.slice(0, 8)} item=${item?.phase ?? '-'} status=${row?.status ?? '?'}`;
      })
      .join('\n');
    await page.waitForTimeout(500);
  }
  throw new Error(`等不到 ${sessionIds.length} 条待办，只到 ${detail.split('\n').filter((l) => !l.includes('item=-')).length} 条：\n${detail}\nworker log: ${workerLog}`);
}

/** 造出「项目多、待办多、会话多」的首页：11 个项目 / 7 条待办 / 19 条近会话。 */
async function seedRichHome(page: Page, baseURL: string): Promise<{
  attentionTitles: string[];
  lastSessionTitle: string;
  extraProjectNames: string[];
  cleanup: () => Promise<void>;
}> {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const code = (
    (await (await page.request.post('/api/workers/pairing', { data: {}, headers })).json()) as { code: string }
  ).code;
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  const PATH = e2eWorkerPath();
  const label = `e2e 首页手机 ${Date.now().toString(36)}`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], {
    env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label },
    encoding: 'utf8'
  });
  expect(enrolled.status).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-home-'));
  const agents = [{ id: 'fakeacp', label: '假 ACP', command: process.execPath, args: [FAKE], listModelsArgs: [FAKE, '--models'] }];
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
      // 造数要同时留 19 条会话的 agent 进程；默认保活上限 8 会把早先那条收掉（会话落成 interrupted）。
      HUB_KEEPALIVE_MAX: '40',
      ACP_AGENTS: JSON.stringify(agents)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  // 造数期间 Worker 的日志留着：偶发某条会话落成 interrupted 时，靠它判断是掉线还是别的原因。
  const workerLog = join(state, 'worker.log');
  const appendLog = (chunk: Buffer): void => appendFileSync(workerLog, chunk.toString());
  worker.stdout?.on('data', appendLog);
  worker.stderr?.on('data', appendLog);
  worker.on('exit', (code, signal) => process.stderr.write(`[home-mobile worker] exit code=${String(code)} signal=${String(signal)}\n`));
  const dirs: string[] = [];
  const scratch = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
  const cleanup = async (): Promise<void> => {
    worker.kill();
    await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  };

  try {
    for (let i = 0; i < 120; i++) {
      const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ id?: string; workerId?: string; state: string }>;
      if (workers.find((x) => (x.workerId ?? x.id) === workerId)?.state === 'online') break;
      await page.waitForTimeout(500);
    }

    const project = async (name: string, extra: Record<string, unknown> = {}): Promise<{ id: string }> =>
      (await (
        await page.request.post('/api/projects', { data: { name, rootPath: scratch('e2e-home-'), ...extra }, headers })
      ).json()) as { id: string };
    const task = async (projectId: string, title: string): Promise<string> =>
      (await (await page.request.post('/api/tasks', { data: { projectId, title }, headers })).json() as { id: string }).id;
    const derive = async (taskId: string): Promise<string> => {
      const derived = await page.request.post('/api/sessions/derive', { data: { taskId, agentId: 'fakeacp', model: '' }, headers });
      expect(derived.ok(), await derived.text()).toBe(true);
      return ((await derived.json()) as { id: string }).id;
    };

    // 待办：4 条「可能在等你」+ 2 条「等回答」+ 1 条「失败了」，凑够 7 条角标。
    const todo = await project('首页待办', { workerId });
    const attentionTitles = ['首页待办 01', '首页待办 02', '首页待办 03', '首页待办 04', '首页待办 05', '首页待办 06', '首页待办 07'];
    const prompts = ['please-question', 'please-question', 'please-question', 'please-question', 'please-asktool', 'please-asktool', 'please-refuse'];
    const attentionIds: string[] = [];
    for (const [index, title] of attentionTitles.entries()) {
      const id = await derive(await task(todo.id, title!));
      attentionIds.push(id);
      expect((await page.request.post(`/api/sessions/${id}/prompt`, { data: { text: prompts[index]! }, headers })).ok()).toBe(true);
    }

    // 近会话：12 条，把「接着干哪条」拉长到要滚动才看得完。挂同一台机器，派生时派发才成功（否则会话会躺在 failed 里，混进待办）。
    const recents = await project('首页近项目', { workerId });
    const recentTitles = Array.from({ length: 12 }, (_, i) => `首页近会话 ${String(i + 1).padStart(2, '0')}`);
    for (const title of recentTitles) await derive(await task(recents.id, title));

    // 再塞 8 个空项目：项目清单在窄屏上远超一屏。
    const extraProjectNames = Array.from({ length: 8 }, (_, i) => `首页空项目 ${String(i + 1).padStart(2, '0')}`);
    for (const name of extraProjectNames) await project(name);

    await pollAttention(page, attentionIds, workerLog);
    return { attentionTitles, lastSessionTitle: recentTitles.at(-1)!, extraProjectNames, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

test('手机首页：一个滚动源、角标直达标题、末条可达、视口收窄后搜索可见', async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const seed = await seedRichHome(page, baseURL!);
  try {
    // —— 390×844：结构 = 外层滚，侧栏和内容区都不滚
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByTestId('home-root')).toBeVisible();

    let shot = await structure(page);
    expect(shot.root?.overflowY, '窄屏由 home-root 承担滚动').toBe('auto');
    expect(shot.root!.scrollHeight).toBeGreaterThan(shot.root!.clientHeight + 100);
    expect(shot.aside?.overflowY, '侧栏在窄屏不许自己滚').toBe('visible');
    expect(shot.aside!.scrollHeight, '侧栏内容全部摊开，不再被 40dvh 截半').toBe(shot.aside!.clientHeight);
    expect(shot.main?.overflowY, '内容区在窄屏不许自己滚').toBe('visible');
    expect(shot.main!.scrollHeight).toBe(shot.main!.clientHeight);
    expect(shot.docScrollHeight, '文档层不滚：滚动留在应用里').toBeLessThanOrEqual(shot.innerHeight + 1);

    // —— 手指在上半屏往上划：整页跟着走（旧实现只会滚那个 40dvh 的小盒子）
    await touchSwipeUp(page, 195, 220);
    shot = await structure(page);
    expect(shot.root!.scrollTop, '在上段区域划手指，滚的是同一个容器').toBeGreaterThan(50);
    expect(shot.docScrollY).toBe(0);

    // —— 角标直达标题
    await page.goto('/');
    const badge = page.getByTestId('attention-badge');
    await expect(badge).toContainText('7');
    const inbox = page.getByTestId('attention-inbox');
    await expect(inbox).toContainText('等我处理 · 7');
    await badge.click();
    const inboxTitle = inbox.getByText('等我处理 · 7').first();
    await expect(inboxTitle).toBeInViewport();
    await expect(page.getByTestId('attention-item')).toHaveCount(7);
    // 平滑滚动要时间：等 home-root 真的滚起来，标题也被顶到视口上方。
    await expect
      .poll(async () => (await structure(page)).root!.scrollTop, { message: '角标点下去滚的是 home-root' })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await inboxTitle.boundingBox())?.y ?? 999, { message: '收件箱标题被顶到视口上方，不是「刚好在视口里」' })
      .toBeLessThan(120);

    // —— 最后一条待办 / 最后一条会话都能滚到；滚到底时上段招牌已经离开视口
    await page.goto('/');
    const lastItem = page.getByTestId('attention-item').last();
    await lastItem.scrollIntoViewIfNeeded();
    await expect(lastItem).toBeInViewport();
    const brand = page.getByText('agent-hub', { exact: true });
    const brandBox = await brand.boundingBox();
    expect(brandBox!.y + brandBox!.height, '单滚动：上段不再常驻').toBeLessThanOrEqual(1);

    const lastRow = page.getByRole('button', { name: new RegExp(seed.lastSessionTitle) });
    await lastRow.scrollIntoViewIfNeeded();
    await expect(lastRow).toBeInViewport();
    const rowBox = await lastRow.boundingBox();
    expect(rowBox!.y + rowBox!.height, '最后一条近会话整个落在视口里').toBeLessThanOrEqual(845);

    // 再往下是回收站和机器徽标：同一个容器还能继续滚到底，滚动条也夹在最大值上
    await page.getByTestId('home-root').evaluate((root) => root.scrollTo(0, root.scrollHeight));
    const bottom = await structure(page);
    expect(bottom.root!.scrollTop + bottom.root!.clientHeight, '滚到底就真的到底了').toBeGreaterThanOrEqual(bottom.root!.scrollHeight - 2);
    expect(bottom.docScrollY, '滚的始终是 home-root，不是文档').toBe(0);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'home-mobile-390-bottom.png') });

    // —— 320×667：不横向溢出，角标不压招牌，导航仍然点得到
    await page.setViewportSize({ width: 320, height: 667 });
    await page.goto('/');
    const narrow = await structure(page);
    expect(narrow.root!.clientHeight).toBe(667);
    const overflowX = await page.getByTestId('home-root').evaluate((root) => root.scrollWidth - root.clientWidth);
    expect(overflowX, '320 下不该有横向滚动').toBeLessThanOrEqual(0);
    const brandBox320 = await page.getByText('agent-hub', { exact: true }).boundingBox();
    const badgeBox320 = await page.getByTestId('attention-badge').boundingBox();
    expect(brandBox320!.x + brandBox320!.width).toBeLessThanOrEqual(badgeBox320!.x + 1);
    for (const nav of await page.locator('[data-testid^="nav-"]').all()) {
      const box = await nav.boundingBox();
      // min-h-12 在 13px 根字号下量出来是 39px：比 44 的标准触控目标小一点，但不是这次改出来的问题。
      expect(box!.height, '导航是手指能点的块').toBeGreaterThanOrEqual(36);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(321);
    }
    await page.getByTestId('attention-badge').click();
    await expect(page.getByTestId('attention-inbox').getByText('等我处理 · 7').first()).toBeInViewport();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'home-mobile-320-inbox.png') });

    // —— 视口收窄（软键盘）：搜索框聚焦后能滚进可见区，不会被上段挤没
    await page.setViewportSize({ width: 390, height: 430 });
    await page.goto('/');
    const search = page.getByPlaceholder('搜会话、任务或项目');
    await search.scrollIntoViewIfNeeded();
    await search.focus();
    await expect(search).toBeInViewport();
    const searchBox = await search.boundingBox();
    expect(searchBox!.y).toBeGreaterThanOrEqual(0);
    expect(searchBox!.y + searchBox!.height).toBeLessThanOrEqual(430);
    expect((await structure(page)).aside!.overflowY, '收窄后侧栏仍不自己滚').toBe('visible');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    // —— 键盘焦点：Tab 到第 5 个项目，焦点框可见且被滚进视口
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const target = seed.extraProjectNames[4]!;
    // 项目清单是异步来的：等它真的在 DOM 里再 Tab，否则前几格焦点会落到还没渲染的空白上。
    await expect(page.getByText(seed.extraProjectNames.at(-1)!)).toBeAttached();
    let focused = '';
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
      if (focused.startsWith(target)) break;
    }
    expect(focused, 'Tab 能走到第 5 个项目').toContain(target);
    const focus = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return { outline: style.outlineStyle, width: parseFloat(style.outlineWidth), top: rect.top, bottom: rect.bottom };
    });
    expect(focus.outline).not.toBe('none');
    expect(focus.width).toBeGreaterThanOrEqual(2);
    expect(focus.top, '焦点元素被滚进可见区，不是被夹在上段').toBeGreaterThanOrEqual(-4);
    expect(focus.bottom).toBeLessThanOrEqual(848);
  } finally {
    await seed.cleanup();
  }
});

test('桌面断点：md 起恢复「侧栏 + 内容区」双栏，桌面仍是 main 单滚', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  for (const name of ['断点项目 01', '断点项目 02', '断点项目 03']) {
    await page.request.post('/api/projects', { data: { name }, headers });
  }

  // 767：还是窄屏，单滚动
  await page.setViewportSize({ width: 767, height: 800 });
  await page.goto('/');
  await expect(page.getByText('断点项目 01').first()).toBeVisible();
  let shot = await structure(page);
  expect(shot.root!.overflowY).toBe('auto');
  expect(shot.aside!.overflowY).toBe('visible');

  // 768：横排，侧栏 220px 自己滚，main 自己滚，外层不滚
  await page.setViewportSize({ width: 768, height: 800 });
  await page.goto('/');
  shot = await structure(page);
  const asideBox = await page.getByRole('complementary', { name: '首页侧栏' }).boundingBox();
  expect(Math.round(asideBox!.width)).toBe(220);
  expect(Math.round(asideBox!.height)).toBe(800);
  expect(shot.root!.overflowY, 'md 起外层不再滚').toBe('visible');
  expect(shot.aside!.overflowY).toBe('auto');
  expect(shot.main!.overflowY).toBe('auto');
  const borderBottom = await page.getByRole('complementary', { name: '首页侧栏' }).evaluate((el) => getComputedStyle(el).borderBottomWidth);
  expect(borderBottom).toBe('0px');

  // 1024 / 1280：导航成竖列，桌面布局与改造前一致
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto('/');
  const navDirection = await page.getByTestId('global-nav').evaluate((el) => getComputedStyle(el).flexDirection);
  expect(navDirection).toBe('column');
  shot = await structure(page);
  expect(shot.main!.overflowY).toBe('auto');
  expect(shot.aside!.overflowY).toBe('auto');

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const asideWide = await page.getByRole('complementary', { name: '首页侧栏' }).evaluate((el) => {
    const style = getComputedStyle(el);
    return { width: el.getBoundingClientRect().width, borderRight: style.borderRightWidth, maxHeight: style.maxHeight };
  });
  expect(Math.round(asideWide.width)).toBe(220);
  expect(asideWide.borderRight).toBe('1px');
  expect(asideWide.maxHeight).toBe('none');
  shot = await structure(page);
  expect(shot.root!.overflowY).toBe('visible');
  expect(shot.main!.overflowY).toBe('auto');
  await expect(page.getByRole('complementary', { name: '首页侧栏' })).toBeInViewport();
  expect(shot.docScrollHeight).toBeLessThanOrEqual(801);
});
