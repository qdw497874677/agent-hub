import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type APIRequestContext, type BrowserContext, type Request } from '@playwright/test';
import { stop } from '../apps/server/src/test-support/spawn.ts';
import { e2eWorkerRoots } from './isolation.ts';
import { loginByApi, mailedLink } from './login.ts';
import { currentRun } from './run-id.ts';

/**
 * 机器：全站只有一个家（#/machines）。
 *
 * - 侧栏 / 首页 / 折叠侧栏 / 全站导航的「机器」都指向同一页；
 * - 一行一台，点进去是 `#/machines/<id>`，页签进地址，手机上进详情从顶部看、退回来还在原来的位置；
 * - 能做哪些管理动作由服务端的 actions 决定：主人能更新 / 断开，接入机器的人只能轮换、吊销自己那台。
 */

const csrfOf = async (context: BrowserContext) =>
  (await context.cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';

/** 测试里接进来的机器都真跑着：离线又没连过的机器不会出现在 /api/workers 里，界面也就没有它。 */
const running: { child: ChildProcess; state: string }[] = [];
test.afterEach(async () => {
  await Promise.all(running.splice(0).map(async ({ child, state }) => {
    await stop(child);
    rmSync(state, { recursive: true, force: true, maxRetries: 3 });
  }));
});

/** 走真实 CLI 凭码接入一台远程机器，然后让它一直连着（界面里的列表只收已连上的机器）。 */
async function enrollMachine(
  request: APIRequestContext,
  baseURL: string,
  headers: Record<string, string>,
  label: string
): Promise<string> {
  const issued = await request.post('/api/workers/pairing', { headers, data: { preset: 'full' } });
  expect(issued.ok()).toBe(true);
  const { code } = (await issued.json()) as { code: string };
  const hubUrl = `${baseURL.replace(/^http/, 'ws')}/worker`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], {
    env: { PATH: process.env['PATH'] ?? '', HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label },
    encoding: 'utf8'
  });
  expect(enrolled.status, enrolled.stderr).toBe(0);
  const [workerId, credential] = enrolled.stdout.trim().split('\n');
  expect(workerId).toBeTruthy();

  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-machines-'));
  const child = spawn(process.execPath, ['apps/worker/src/main.ts'], {
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: state,
      HUB_URL: hubUrl,
      HUB_WORKER_CREDENTIAL: credential ?? '',
      WORKER_ID: workerId ?? '',
      WORKER_ORIGIN: 'remote',
      WORKER_LABEL: label,
      WORKER_ROOTS: e2eWorkerRoots(),
      WORKER_STATE_DIR: state
    },
    stdio: 'ignore'
  });
  running.push({ child, state });
  return workerId ?? '';
}

/**
 * 一台「版本落后」的机器：代码是现在的，但它报上来的是旧提交。
 *
 * 拷一份 worker 源码到临时目录、写 `.agent-hub-commit`，就是 tarball 安装那种没有 `.git` 的形态——
 * 版本状态于是由安装目录自己说了算，和 hub 的提交对不上。
 */
async function enrollStaleMachine(
  request: APIRequestContext,
  baseURL: string,
  headers: Record<string, string>,
  label: string
): Promise<string> {
  const issued = await request.post('/api/workers/pairing', { headers, data: { preset: 'full' } });
  expect(issued.ok()).toBe(true);
  const { code } = (await issued.json()) as { code: string };
  const hubUrl = `${baseURL.replace(/^http/, 'ws')}/worker`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], {
    env: { PATH: process.env['PATH'] ?? '', HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label },
    encoding: 'utf8'
  });
  expect(enrolled.status, enrolled.stderr).toBe(0);
  const [workerId, credential] = enrolled.stdout.trim().split('\n');
  expect(workerId).toBeTruthy();

  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-machines-'));
  const install = join(state, 'install');
  cpSync(resolve('apps/worker/src'), join(install, 'apps/worker/src'), { recursive: true });
  writeFileSync(join(install, 'package.json'), JSON.stringify({ name: 'agent-hub-install', version: '0.0.1' }));
  writeFileSync(join(install, '.agent-hub-commit'), `${'a'.repeat(40)}\n`);
  symlinkSync(resolve('node_modules'), join(install, 'node_modules'), 'dir');

  const child = spawn(process.execPath, [join(install, 'apps/worker/src/main.ts')], {
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: state,
      HUB_URL: hubUrl,
      HUB_WORKER_CREDENTIAL: credential ?? '',
      WORKER_ID: workerId ?? '',
      WORKER_ORIGIN: 'remote',
      WORKER_LABEL: label,
      WORKER_ROOTS: e2eWorkerRoots(),
      WORKER_STATE_DIR: state
    },
    stdio: 'ignore'
  });
  running.push({ child, state });
  return workerId ?? '';
}

test('机器入口：项目侧栏展开或收起时均从更多进入，老后台地址换到新家', async ({ page }) => {
  await loginByApi(page);
  await page.goto('/');

  // 首页的机器概览和全站导航都指向同一个机器页面
  await expect(page.getByRole('link', { name: /^机器：/ }).first()).toBeVisible();
  await page.getByTestId('shell-more').click();
  await expect(page.getByTestId('nav-machines')).toHaveAttribute('href', '#/machines');

  await page.getByTestId('nav-machines').click();
  await expect(page).toHaveURL(/#\/machines$/);
  await expect(page.getByTestId('machines-page')).toBeVisible();
  await expect(page.getByTestId('machines-summary')).toContainText(/在线/);

  // 刷新：一次点击把列表（/api/workers，首页机器徽标共用同一条 query）和版本数据（/api/admin/workers）都拉一遍
  const seen: string[] = [];
  const watch = (req: Request) => seen.push(new URL(req.url()).pathname);
  page.on('request', watch);
  await page.getByTestId('machines-refresh').click();
  await expect
    .poll(() => ['/api/workers', '/api/admin/workers'].filter((path) => !seen.includes(path)), { timeout: 5_000 })
    .toEqual([]);
  page.off('request', watch);
  await expect(page.getByTestId('machines-refresh')).not.toHaveAttribute('aria-busy', 'true');
  // 刷新是重取数据，不是换一页：列表还在原处
  await expect(page.getByTestId('machines-summary')).toContainText(/在线/);

  // 一行一台，点进去是它自己的地址
  const localRow = page.getByTestId('machine-row').filter({ hasText: '本机' }).first();
  await localRow.getByRole('link').click();
  await expect(page).toHaveURL(/#\/machines\/[^/]+$/);
  await expect(page.getByTestId('worker-detail')).toBeVisible();
  await expect(page.getByTestId('worker-tab-overview')).toHaveAttribute('aria-selected', 'true');

  // 页签直接进地址：刷新 / 分享打开同一页
  const workerId = new URL(page.url()).hash.split('/')[2];
  await page.goto(`/#/machines/${workerId}/agent`);
  await expect(page.getByTestId('worker-detail')).toBeVisible();
  await expect(page.getByTestId('worker-tab-agent')).toHaveAttribute('aria-selected', 'true');

  // 老地址 #/admin/workers：换到新家，而且不是「只有 hub 管理员能进」那页
  await page.goto('/#/admin/workers');
  await expect(page).toHaveURL(/#\/machines$/);
  await expect(page.getByTestId('machines-page')).toBeVisible();

  // 项目侧栏的展开状态不改变全站「更多」中的唯一机器导航
  await page.goto('/#/home');
  await expect(page.getByTestId('machines-badge')).toBeVisible();
  const csrf = await csrfOf(page.context());
  const created = await page.request.post('/api/projects', {
    headers: { 'x-hub-csrf': csrf },
    data: { name: `machines rail ${Date.now()}` }
  });
  expect(created.ok()).toBe(true);
  const { id } = (await created.json()) as { id: string };
  await page.goto('/#/home');
  await page.reload();
  await page.goto(`/#/p/${id}/list`);
  await expect(page.getByTestId('project-sidebar')).toBeVisible();
  await page.getByTestId('shell-more').click();
  await expect(page.getByTestId('nav-machines')).toHaveCount(1);
  await expect(page.locator('a[href="#/machines"]')).toHaveCount(1);
  await expect(page.getByTestId('nav-machines')).toHaveAttribute('href', '#/machines');
  await page.keyboard.press('Escape');
  // 真按一下「收起侧栏」，不是直接改 localStorage
  await page.getByRole('button', { name: '收起侧栏' }).click();
  await page.getByTestId('shell-more').click();
  await expect(page.getByTestId('nav-machines')).toHaveCount(1);
  await expect(page.locator('a[href="#/machines"]')).toHaveCount(1);
  await expect(page.getByTestId('nav-machines')).toHaveAttribute('href', '#/machines');
  await page.getByTestId('nav-machines').click();
  await expect(page).toHaveURL(/#\/machines$/);
  await page.evaluate(() => localStorage.removeItem('agent-hub.sidebar.collapsed'));
});

test('机器：谁看得到哪些按钮，全由服务端的 actions 决定', async ({ page, browser, baseURL }) => {
  await loginByApi(page);
  const csrf = await csrfOf(page.context());
  const tag = currentRun();
  const password = 'machines pw 12345';

  const invite = async (email: string) => {
    const invited = await page.request.post('/api/team/invites', { headers: { 'x-hub-csrf': csrf }, data: { email, role: 'member' } });
    expect(invited.status()).toBe(201);
    return new URL((await mailedLink(email, 'invite')).replace('#/invite?', '?')).searchParams.get('token');
  };

  const owner = { email: `machines-own-${tag}@example.com` };
  const other = { email: `machines-other-${tag}@example.com` };
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    for (const [context, email] of [
      [first, owner.email],
      [second, other.email]
    ] as const) {
      const token = await invite(email);
      expect((await context.request.post('/api/auth/invite/accept', { data: { token, password, displayName: 'm' } })).ok()).toBe(true);
    }

    // 第一台机器由 owner.email 那个人接入并一直连着
    const label = `e2e 成员机器 ${tag}`;
    const workerId = await enrollMachine(first.request, baseURL!, { 'x-hub-csrf': await csrfOf(first) }, label);

    // 接入它的人：能轮换、吊销自己那台；没有更新 / 断开（那是 hub 管理员的活）
    const member = await first.newPage();
    await member.goto(`/#/machines/${workerId}/settings`);
    await expect(member.getByTestId('worker-detail')).toContainText(label);
    await expect(member.getByTestId('machine-revoke')).toBeVisible();
    await expect(member.getByTestId('credential-rotation')).toBeVisible();
    await expect(member.getByTestId('machine-disconnect')).toHaveCount(0);
    await expect(member.getByTestId('machine-update-button')).toHaveCount(0);
    // 版本一样就是「已是最新」，不能因为看不到后台数据就说成「等主人」
    await expect(member.getByTestId('machine-update')).toContainText('已是最新');

    // 同团队、但不是他接入的：没有吊销 / 轮换，只有一句「由接入它的人管理」
    const stranger = await second.newPage();
    await stranger.goto(`/#/machines/${workerId}/settings`);
    await expect(stranger.getByTestId('worker-detail')).toContainText(label);
    await expect(stranger.getByTestId('machine-revoke')).toHaveCount(0);
    await expect(stranger.getByTestId('credential-rotation')).toHaveCount(0);
    await expect(stranger.getByTestId('machine-managed-by-owner')).toContainText('这台机器由接入它的人管理');
    await expect(stranger.getByTestId('machine-update')).toContainText('已是最新');

    // hub 管理员：远程在线的机器能断开、能吊销（他是全站的 admin），管理说明那行不出现
    await page.goto(`/#/machines/${workerId}/settings`);
    await expect(page.getByTestId('worker-detail')).toContainText(label);
    await expect(page.getByTestId('machine-disconnect')).toBeVisible();
    await expect(page.getByTestId('machine-revoke')).toBeVisible();
    await expect(page.getByTestId('machine-managed-by-owner')).toHaveCount(0);

    // 本机始终没有「更新 / 断开」（和 hub 同源、同生共死）
    await page.goto(`/#/machines/${(await (await page.request.get('/api/workers')).json() as { workerId: string; origin: string }[]).find((w) => w.origin === 'local')!.workerId}/settings`);
    await expect(page.getByTestId('machine-update')).toContainText('和 hub 同源');
    await expect(page.getByTestId('machine-update-button')).toHaveCount(0);
    await expect(page.getByTestId('machine-disconnect')).toHaveCount(0);

    // 接入它的人吊销，列表里就没了
    await member.getByTestId('machine-revoke').click();
    await member.getByRole('button', { name: '确认吊销' }).click();
    await expect(member).toHaveURL(/#\/machines$/);
    await expect(member.getByTestId('machine-row').filter({ hasText: label })).toHaveCount(0);
  } finally {
    await first.close();
    await second.close();
  }
});

test('落后于 hub：成员看得懂，但「更新」只在 hub 管理员那儿', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  await loginByApi(page);
  const csrf = await csrfOf(page.context());
  const tag = currentRun();
  const email = `machines-stale-${tag}@example.com`;

  const invited = await page.request.post('/api/team/invites', { headers: { 'x-hub-csrf': csrf }, data: { email, role: 'member' } });
  expect(invited.status()).toBe(201);
  const token = new URL((await mailedLink(email, 'invite')).replace('#/invite?', '?')).searchParams.get('token');
  const context = await browser.newContext();
  try {
    expect((await context.request.post('/api/auth/invite/accept', { data: { token, password: 'machines stale 12345', displayName: 'm' } })).ok()).toBe(true);
    const label = `e2e 旧版本机器 ${tag}`;
    const workerId = await enrollStaleMachine(context.request, baseURL!, { 'x-hub-csrf': await csrfOf(context) }, label);

    // 接入它的人：列表里有「过期」，详情里说清落后，但没有更新按钮
    const member = await context.newPage();
    await member.goto('/#/machines');
    const row = member.getByTestId('machine-row').filter({ hasText: label });
    await expect(row.getByTestId('machine-outdated')).toBeVisible();
    await row.getByRole('link').click();
    await expect(member.getByTestId('machine-update')).toContainText('落后于 hub 的版本');
    await expect(member.getByTestId('machine-update')).toContainText('等 hub 主人更新这台机器');
    await expect(member.getByTestId('machine-update-button')).toHaveCount(0);

    // hub 管理员：同一台机器，按钮在这儿，而且只有这一个
    await page.goto(`/#/machines/${workerId}`);
    await expect(page.getByTestId('worker-detail')).toContainText(label);
    await expect(page.getByTestId('machine-update-button')).toHaveText('更新');
    await expect(page.getByTestId('machine-update').getByRole('button')).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test('窄屏：列表滚到哪，进详情再退回来还在哪', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  await loginByApi(page);
  const csrf = await csrfOf(page.context());
  const tag = currentRun();
  // 多接几台，列表才滚得起来（页头之外不再有底部添加块，列表本身要够长）
  const workerIds: string[] = [];
  for (let index = 0; index < 16; index += 1) {
    workerIds.push(await enrollMachine(page.request, baseURL!, { 'x-hub-csrf': csrf }, `e2e 长列表 ${tag}-${index}`));
  }
  // CLI 接入完成不代表子进程已连上；等本轮全部在线，再测试真实刷新而非启动中的列表变化。
  await expect.poll(async () => {
    const workers = await (await page.request.get('/api/workers')).json() as Array<{ workerId: string; state: string }>;
    return workerIds.filter((id) => workers.some((worker) => worker.workerId === id && worker.state === 'online')).length;
  }, { timeout: 120_000, message: '等待本轮 16 台机器上线' }).toBe(workerIds.length);

  await page.setViewportSize({ width: 390, height: 520 });
  await page.goto('/#/machines');
  const main = page.locator('main').first();
  await expect(page.getByTestId('machine-row').filter({ hasText: `e2e 长列表 ${tag}-` })).toHaveCount(workerIds.length);
  await expect.poll(() => main.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(200);
  await main.evaluate((node) => {
    node.scrollTop = 200;
  });
  const at = await main.evaluate((node) => node.scrollTop);
  expect(at).toBeGreaterThan(150);

  // 手机上点刷新：请求走一趟，列表不重挂载，滚动位置不动
  const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/workers');
  await page.getByTestId('machines-refresh').click();
  await refreshed;
  await expect(page.getByTestId('machines-refresh')).not.toHaveAttribute('aria-busy', 'true');
  expect(await main.evaluate((node) => node.scrollTop)).toBe(at);

  const row = page.getByTestId('machine-row').nth(3);
  await row.getByRole('link').click();
  await expect(page.getByTestId('worker-detail')).toBeVisible();
  // 详情从顶部看起，不是接着列表的滚动位置
  expect(await main.evaluate((node) => node.scrollTop)).toBe(0);

  await page.getByLabel('返回机器列表').click();
  await expect(page.getByTestId('machine-row').first()).toBeVisible();
  // 回到刚才的位置，刚才那一行还在屏幕上
  await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBeGreaterThan(150);
  const restored = (await main.evaluate((node) => node.scrollTop)) as number;
  const visible = await page.getByTestId('machine-row').nth(3).boundingBox();
  expect(visible && visible.y).toBeLessThan(520);
  expect(restored).toBeLessThan(400);
});

test('添加机器只有一个入口：页头；空态/无权限都说明下一步', async ({ page }, testInfo) => {
  await loginByApi(page);
  await page.setViewportSize({ width: 390, height: 844 });

  // 有机器时：页头那一个，列表底部不再重复。
  await page.goto('/#/machines');
  await expect(page.getByTestId('machines-page')).toBeVisible();
  await expect(page.getByTestId('machine-row').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /添加机器/ })).toHaveCount(1);
  await expect(page.getByTestId('machines-add')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('machines-add-390.png') });

  // 空态：仍然只有页头一个入口，卡片里给的是下一步说明，不是第二个按钮。
  await page.route('**/api/workers', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto('/#/machines');
  await expect(page.getByTestId('machines-summary')).toContainText('还没有机器');
  await expect(page.getByTestId('machines-add')).toBeVisible();
  await expect(page.getByRole('button', { name: /添加机器/ })).toHaveCount(1);
  await expect(page.getByText('点右上角「添加机器」')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('machines-add-empty-390.png') });

  // 没有权限：页头入口消失，空态明确说找主人；任何地方都不再冒出「添加机器」按钮。
  await page.route('**/api/workers/enroll-info', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ allowed: false }) })
  );
  await page.goto('/#/machines');
  await page.reload();
  await expect(page.getByTestId('machines-add')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /添加机器/ })).toHaveCount(0);
  await expect(page.getByText('要加机器请联系主人')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('machines-add-denied-390.png') });
});
