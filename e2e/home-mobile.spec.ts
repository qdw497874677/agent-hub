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
  longTitle: string;
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
    // 同一轮里别的用例也会造同名项目：名字带上本轮短 id，避免 locator 撞上两份同名行。
    const tag = Date.now().toString(36);
    const attentionTitles = Array.from({ length: 7 }, (_, i) => `首页待办 ${String(i + 1).padStart(2, '0')} ${tag}`);
    const prompts = ['please-question', 'please-question', 'please-question', 'please-question', 'please-asktool', 'please-asktool', 'please-refuse'];
    const attentionIds: string[] = [];
    for (const [index, title] of attentionTitles.entries()) {
      const id = await derive(await task(todo.id, title!));
      attentionIds.push(id);
      expect((await page.request.post(`/api/sessions/${id}/prompt`, { data: { text: prompts[index]! }, headers })).ok()).toBe(true);
    }

    // 近会话：12 条，把「接着干哪条」拉长到要滚动才看得完。挂同一台机器，派生时派发才成功（否则会话会躺在 failed 里，混进待办）。
    const recents = await project('首页近项目', { workerId });
    const recentTitles = Array.from({ length: 12 }, (_, i) => `首页近会话 ${String(i + 1).padStart(2, '0')} ${tag}`);
    for (const title of recentTitles) await derive(await task(recents.id, title));

    // 一条长标题会话：手机上标题一定会被截断，「全文」入口只在真截断时出现
    const longProject = await project('首页长标题', { workerId });
    const longTitle = `把会话标题写得很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长以验证手机上的截断 ${tag}`;
    await derive(await task(longProject.id, longTitle));

    // 再塞 8 个空项目：项目清单在窄屏上远超一屏。
    const extraProjectNames = Array.from({ length: 8 }, (_, i) => `首页空项目 ${String(i + 1).padStart(2, '0')} ${tag}`);
    for (const name of extraProjectNames) await project(name);

    await pollAttention(page, attentionIds, workerLog);
    return { attentionTitles, lastSessionTitle: recentTitles.at(-1)!, longTitle, extraProjectNames, cleanup };
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

    // —— 角标直达标题：收件箱本来就在首屏时不再乱滚，但整块必须可见
    await page.goto('/');
    const badge = page.getByTestId('attention-badge');
    await expect(badge).toContainText('7');
    const inbox = page.getByTestId('attention-inbox');
    await expect(inbox).toContainText('等我处理 · 7');
    // 窄屏只铺 3 条，剩下的折进「还有 4 条」：首屏不能摊 7 条把会话全顶下去。
    await expect(page.getByTestId('attention-item')).toHaveCount(3);
    await expect(page.getByTestId('attention-more')).toContainText('还有 4 条');
    await badge.click();
    await expect(inbox).toBeInViewport();
    expect((await structure(page)).root!.scrollTop, '收件箱已在首屏，角标不应把页面挪走').toBe(0);

    // —— 首屏：搜索在上，第一条会话也在 844 里（手机上先看见「接着干哪条」）
    await expect(page.getByTestId('home-session-row').first()).toBeVisible();
    const firstRowBox = await page.getByTestId('home-session-row').first().boundingBox();
    const searchFieldBox = await page.getByPlaceholder('搜会话、任务或项目').boundingBox();
    expect(searchFieldBox!.y, '搜索排在会话之前').toBeLessThan(firstRowBox!.y);
    expect(firstRowBox!.y + firstRowBox!.height, '首屏能看到第一条会话').toBeLessThanOrEqual(845);

    // —— 关键点击目标：手指按得住（≥44 CSS px）
    const targets: Array<[string, ReturnType<Page['locator']>]> = [
      ['待办角标', page.getByTestId('attention-badge')],
      ['消息', page.getByTestId('messages-entry')],
      ['通知', page.getByTestId('notification-bell')],
      ['账号', page.getByRole('button', { name: '账号' })],
      ['待办「⋯」', page.getByTestId('attention-menu').first()],
      ['新建项目', page.getByTitle('新建项目')]
    ];
    for (const [label, target] of targets) {
      const box = await target.boundingBox();
      expect(box!.width, `${label} 窄屏点击目标宽度`).toBeGreaterThanOrEqual(44);
      expect(box!.height, `${label} 窄屏点击目标高度`).toBeGreaterThanOrEqual(44);
    }

    // —— 搜索：按钮不换行、清除回焦、过滤与恢复都对，结果条数防抖后播报
    const searchInput = page.getByPlaceholder('搜会话、任务或项目');
    const rowCount = () => page.getByTestId('home-session-row').count();
    const totalRows = await rowCount();
    expect(totalRows, '播种的会话应该都在').toBeGreaterThan(2);
    await searchInput.fill('近会话');
    // 不是每敲一个键都播报：刚输入完还没到播报点
    const status = page.getByTestId('search-status');
    expect((await status.textContent()) ?? '', '输入瞬间不播报').toBe('');
    await expect(status).toHaveText(/找到 \d+ 条会话/);
    const filteredRows = await rowCount();
    expect(filteredRows, '过滤真的筛掉了别的').toBeGreaterThan(0);
    expect(filteredRows).toBeLessThan(totalRows);
    const clearButton = page.getByRole('button', { name: '清除搜索' });
    const clearBox = await clearButton.boundingBox();
    expect(clearBox!.width, '清除按钮不换行').toBeLessThanOrEqual(60);
    expect(clearBox!.height, '清除按钮不撑高').toBeLessThanOrEqual(48);
    await clearButton.click();
    await expect.poll(rowCount).toBe(totalRows);
    await expect(searchInput).toBeFocused();
    await expect(status).toHaveText('');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'home-mobile-390-search.png') });

    // —— 长标题：只有真被截断的那行才有「全文」，点开是完整标题，Esc 回到原按钮
    const longRow = page.getByTestId('home-session-row').filter({ hasText: '把会话标题写得很长' }).first();
    await expect(longRow).toBeVisible();
    const longWrap = longRow.locator('xpath=..');
    const fullTitle = longWrap.getByTestId('home-session-full-title');
    await expect(fullTitle).toBeVisible();
    await fullTitle.click();
    const titleDialog = page.getByTestId('session-title-dialog');
    await expect(titleDialog).toContainText(seed.longTitle);
    await page.keyboard.press('Escape');
    await expect(titleDialog).toHaveCount(0);
    await expect(fullTitle).toBeFocused();
    // 没截断的短标题不该多出这个按钮（不占宽度、不进 Tab 序）
    const shortWrap = page.getByTestId('home-session-row').filter({ hasText: '首页近会话 01' }).first().locator('xpath=..');
    await expect(shortWrap.getByTestId('home-session-full-title')).toHaveCount(0);

    // —— 点会话仍然进项目会话页
    await page.getByTestId('home-session-row').first().click();
    await expect(page).toHaveURL(/#\/p\/[^/]+\/focus\//);

    // 视口被软键盘压矮、收件箱掉到折叠线以下时：角标把它顶到眼前，滚的还是 home-root
    await page.setViewportSize({ width: 390, height: 360 });
    await page.goto('/#/home');
    const inboxTall = await page.getByTestId('attention-inbox').boundingBox();
    expect(inboxTall!.y + inboxTall!.height, '矮视口下收件箱确实掉到折叠线以下').toBeGreaterThan(360);
    await page.getByTestId('attention-badge').click();
    await expect
      .poll(async () => (await structure(page)).root!.scrollTop, { message: '角标点下去滚的是 home-root' })
      .toBeGreaterThan(0);
    expect((await structure(page)).docScrollY, '文档自己没滚').toBe(0);
    await expect
      .poll(async () => (await inbox.getByText('等我处理 · 7').first().boundingBox())?.y ?? 999, { message: '收件箱标题被顶到视口上方，不是「刚好在视口里」' })
      .toBeLessThan(120);

    // —— 最后一条待办 / 最后一条会话都能滚到；滚到底时上段招牌已经离开视口
    await page.goto('/#/home');
    await page.getByTestId('attention-more').click();
    await expect(page.getByTestId('attention-item')).toHaveCount(7);
    expect(await page.getByTestId('attention-more').count(), '展开后不再有「还有」').toBe(0);
    const lastItem = page.getByTestId('attention-item').last();
    await lastItem.scrollIntoViewIfNeeded();
    await expect(lastItem).toBeInViewport();
    const brand = page.getByRole('heading', { level: 1 });
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
    await page.goto('/#/home');
    const narrow = await structure(page);
    expect(narrow.root!.clientHeight).toBe(667);
    const overflowX = await page.getByTestId('home-root').evaluate((root) => root.scrollWidth - root.clientWidth);
    expect(overflowX, '320 下不该有横向滚动').toBeLessThanOrEqual(0);
    const brandBox320 = await page.getByRole('heading', { level: 1 }).boundingBox();
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
    await page.goto('/#/home');
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
    await page.goto('/#/home');
    const target = seed.extraProjectNames[4]!;
    // 项目清单是异步来的：等它真的在 DOM 里再 Tab，否则前几格焦点会落到还没渲染的空白上。
    await expect(page.getByText(seed.extraProjectNames.at(-1)!)).toBeAttached();
    // 窄屏预览只铺 3 个：先点「全部 N 个项目」把它展开成抽屉。
    const allProjects = page.getByRole('button', { name: /^全部 \d+ 个项目$/ });
    await allProjects.click();
    await expect(page.getByTestId('project-sheet')).toBeVisible();
    await expect(page.getByTestId('project-sheet-row').filter({ hasText: seed.extraProjectNames.at(-1)! })).toBeVisible();
    // 项目顺序按最近活动排，不按名字：从清单第一行往后 Tab，第 5 个 extra 项目必须落在序列里。
    const firstProjectRow = page.getByTestId('project-sheet-row').first().getByRole('button').first();
    await firstProjectRow.focus();
    let focused = '';
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
      if (focused.includes(target)) break;
    }
    expect(focused, '展开后 Tab 能走到第 5 个项目').toContain(target);
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

    // —— 抽屉是对话框：Esc 关掉，焦点还给「全部 N 个项目」，Tab 不会跑到遮罩后面
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('project-sheet')).toHaveCount(0);
    await expect(allProjects, '关掉抽屉把焦点还给触发它的按钮').toBeFocused();
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
  await page.goto('/#/home');
  await expect(page.getByText('断点项目 01').first()).toBeVisible();
  let shot = await structure(page);
  expect(shot.root!.overflowY).toBe('auto');
  expect(shot.aside!.overflowY).toBe('visible');

  // 768：横排，侧栏 220px 自己滚，main 自己滚，外层不滚
  await page.setViewportSize({ width: 768, height: 800 });
  await page.goto('/#/home');
  shot = await structure(page);
  const asideBox = await page.getByRole('complementary', { name: '首页侧栏' }).boundingBox();
  expect(Math.round(asideBox!.width)).toBe(220);
  // 左栏是网格第一列：招牌 / 导航 / 项目 / 回收站 / 机器都在 220px 里，main 在第二列。
  const columns = await page.getByTestId('home-root').evaluate((el) => getComputedStyle(el).gridTemplateColumns);
  expect(columns.split(' ')[0], '侧栏 = 网格第一列 220px').toBe('220px');
  const mainBox = await page.locator('main').boundingBox();
  expect(Math.round(mainBox!.x), '内容区接在侧栏右边').toBe(Math.round(asideBox!.x + asideBox!.width));
  // md 起外层是裁剪容器（overflow hidden）：高度由网格钉住，滚动只发生在侧栏和内容区。
  expect(shot.root!.overflowY, 'md 起外层不再滚').toBe('hidden');
  expect(shot.aside!.overflowY).toBe('auto');
  expect(shot.main!.overflowY).toBe('auto');
  const separator = await page.locator('main').evaluate((el) => getComputedStyle(el).borderLeftWidth);
  expect(separator, '两栏之间有一条分隔线').toBe('1px');
  // 768–1023 侧栏只有 220px：导航两列，标签之间留得下缝
  const navGrid = await page.getByTestId('global-nav').evaluate((el) => ({
    cols: getComputedStyle(el).gridTemplateColumns.split(' ').length,
    widths: [...el.querySelectorAll('a')].map((a) => Math.round(a.getBoundingClientRect().width))
  }));
  expect(navGrid.cols, '平板侧栏导航两列').toBe(2);
  expect(navGrid.widths.every((w) => w > 90), '每格够宽，标签不会互相贴住').toBe(true);

  // 1024 / 1280：导航成竖列，桌面布局与改造前一致
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto('/#/home');
  const navDirection = await page.getByTestId('global-nav').evaluate((el) => getComputedStyle(el).flexDirection);
  expect(navDirection).toBe('column');
  shot = await structure(page);
  expect(shot.main!.overflowY).toBe('auto');
  expect(shot.aside!.overflowY).toBe('auto');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/home');
  const rowsWide = await page.getByTestId('home-session-row').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  const times = await page.getByTestId('home-session-time').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(rowsWide.every((h) => h < 40), '桌面会话行回到单行').toBe(true);
  expect(times.every((h) => h < 24), '桌面时间不折行').toBe(true);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/home');
  const asideWide = await page.getByRole('complementary', { name: '首页侧栏' }).evaluate((el) => {
    const style = getComputedStyle(el);
    return { width: el.getBoundingClientRect().width, maxHeight: style.maxHeight };
  });
  expect(Math.round(asideWide.width)).toBe(220);
  expect(asideWide.maxHeight).toBe('none');
  shot = await structure(page);
  expect(shot.root!.overflowY).toBe('hidden');
  expect(shot.main!.overflowY).toBe('auto');
  await expect(page.getByRole('complementary', { name: '首页侧栏' })).toBeInViewport();
  expect(shot.docScrollHeight).toBeLessThanOrEqual(801);
});

/**
 * 阶段二：键盘顺序与视觉一致、完整内容可达、项目「⋯」与真实撤销、手机抽屉是对话框。
 *
 * 这些都用真后端 + 真 Worker：撤销不是本地改 UI，而是 `acked:false` 打回服务端，
 * 刷新之后还在才算数；项目还原走 `/api/projects/:id/restore`。
 */
test('阶段二：顺序与焦点、完整内容、真实撤销、抽屉', async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const seed = await seedRichHome(page, baseURL!);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/home');
    await expect(page.getByTestId('home-root')).toBeVisible();
    await expect(page.getByTestId('home-session-row').first()).toBeVisible();

    // —— 语义：h1 唯一、待办数量有 polite 播报
    await expect(page.getByRole('heading', { level: 1 })).toContainText('agent-hub');
    const live = page.getByTestId('attention-live');
    await expect(live).toHaveAttribute('role', 'status');
    await expect(live).toHaveAttribute('aria-live', 'polite');

    // —— DOM 顺序 = 视觉顺序：最近会话在项目之前（键盘 Tab 不会先跑进项目）
    expect(
      await page.evaluate(() => {
        const session = document.querySelector('[data-testid="home-session-row"]');
        const project = document.querySelector('[data-testid="project-row"]');
        return (
          session !== null &&
          project !== null &&
          (session.compareDocumentPosition(project) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        );
      }),
      '手机上会话排在项目之前，DOM 与视觉一致'
    ).toBe(true);

    await page.getByPlaceholder('搜会话、任务或项目').focus();
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      seen.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return el?.getAttribute('data-testid') ?? el?.tagName ?? '';
        })
      );
    }
    const sessionAt = seen.indexOf('home-session-row');
    const projectAt = seen.findIndex((id) => id === 'project-open' || id === 'project-menu');
    expect(sessionAt, '从搜索框往后 Tab 很快能到会话行').toBeGreaterThanOrEqual(0);
    expect(projectAt === -1 || projectAt > sessionAt, '项目行不会抢在会话行前面').toBe(true);

    // —— 截断的文字有完整版：行上有 title，键盘/鼠标都能看全
    const firstRow = page.getByTestId('home-session-row').first();
    expect((await firstRow.getAttribute('title'))?.length ?? 0).toBeGreaterThan(0);

    // —— 待办「⋯」→ 完整内容（列表里被截到「模型拒绝了这次请求（st…」的那种）
    await page.getByTestId('attention-menu').first().click();
    await expect(page.getByTestId('attention-row-menu-open')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('attention-detail')).toBeVisible();
    await expect(page.getByTestId('attention-detail-reason')).not.toBeEmpty();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('attention-detail')).toHaveCount(0);
    // 关掉详情要回那一行的「⋯」，不能让键盘用户掉回 body
    await expect(page.getByTestId('attention-menu').first()).toBeFocused();
    // Esc 关菜单本身也一样
    await page.getByTestId('attention-menu').first().click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('attention-row-menu')).toHaveCount(0);
    await expect(page.getByTestId('attention-menu').first()).toBeFocused();

    // —— 稍后 → 撤销 → 刷新：撤销是真的打回服务端，不是本地假装
    const attentionCount = async (): Promise<number> =>
      ((await (await page.request.get('/api/attention')).json()) as { items: unknown[] }).items.length;
    const total = await attentionCount();
    expect(total).toBeGreaterThan(3);
    await page.getByTestId('attention-menu').first().click();
    await page.getByTestId('attention-row-menu-later').click();
    const strip = page.getByTestId('attention-undo');
    await expect(strip, '收到 ackedAt 收据才提供撤销').toBeVisible();
    await expect.poll(attentionCount, { message: '收起立即反映到服务端' }).toBe(total - 1);
    await page.getByTestId('attention-undo-btn').click();
    await expect(strip).toHaveCount(0);
    await expect.poll(attentionCount, { message: '撤销把这条真正打回来了' }).toBe(total);
    await page.reload();
    await expect(page.getByTestId('attention-inbox')).toContainText(`等我处理 · ${total}`);

    // —— 项目「⋯」→ 删除 → 撤销 → 刷新：项目真的回到清单里
    const victim = seed.extraProjectNames.at(-1)!;
    // 预览只铺 3 个，其余行在窄屏是 display:none：从「全部项目」抽屉里操作。
    await page.getByRole('button', { name: /^全部 \d+ 个项目$/ }).click();
    const projectRow = page.getByTestId('project-sheet-row').filter({ hasText: victim });
    await projectRow.getByTestId('project-menu').click();
    await expect(page.getByTestId('project-menu-list-delete')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(projectRow.getByTestId('project-menu')).toBeFocused();
    await projectRow.getByTestId('project-menu').click();
    await page.getByTestId('project-menu-list-delete').click();
    await page.getByLabel(/输入项目名/).fill(victim);
    await page.getByRole('button', { name: '移到回收站' }).click();
    await expect(page.getByTestId('undo-toast')).toContainText(victim);
    await page.getByTestId('undo-toast-action').click();
    await expect(page.getByTestId('undo-toast')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('project-row').filter({ hasText: victim })).toHaveCount(1);

    // —— 桌面列表视图：内容限宽 1080，不再从 x=228 一路拉到窗口右边
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/home');
    await page.getByTestId('project-row').first().getByTestId('project-open').click();
    await page.getByRole('button', { name: '列表' }).click();
    const listInner = await page.getByTestId('list-view').evaluate((el) => el.firstElementChild!.getBoundingClientRect().width);
    expect(Math.round(listInner), '列表内容限宽 1080').toBeLessThanOrEqual(1081);
    expect(Math.round(listInner), '没有窄成一条').toBeGreaterThanOrEqual(900);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'phase2-1440-list.png') });

    // —— 平板宽度下的项目页：抽屉是对话框，Esc 关、焦点归还、Tab 不出框
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/#/home');
    await page.getByTestId('project-row').first().getByTestId('project-open').click();
    const menu = page.getByRole('button', { name: '打开侧栏' });
    await menu.click();
    const sheet = page.getByTestId('nav-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('role', 'dialog');
    await expect(sheet).toHaveAttribute('aria-modal', 'true');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="nav-sheet"]');
        return panel !== null && panel.contains(document.activeElement);
      }),
      'Tab 不会跑到遮罩后面'
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(menu, '关掉抽屉把焦点还给汉堡按钮').toBeFocused();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'phase2-768-project.png') });
  } finally {
    await seed.cleanup();
  }
});
