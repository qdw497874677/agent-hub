import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';

/**
 * 窄屏工作区抽屉里的「添加仓库」：点了必须真的在做事。
 *
 * 之前的问题：单仓会话也长出「添加仓库」，点了前端直接 return（没有组可加），
 * 请求失败也只有一句 finally——看起来像按钮坏了。现在的约定是：
 * 短名单在抽屉里完整可见（不是飘出去被裁）→ 请求挂着时按钮说「添加中…」且只发一次 →
 * 服务端说成功但名单里没有这个仓库时不许报成功 → 真失败要看得见、能手动重试
 * （后端没有幂等键，不自动重试）→ 重试后服务端确认了才出现仓库页签。
 *
 * 还有一条更隐蔽的：结论没定（读不成 / 同名冲突）时，这个仓库必须从短名单里消失，
 * 否则人可以把同一个仓库从候选里原样再发一次——那正是多建一个工作目录的路。
 */
function makeRepo(root: string, name: string, url: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e', 'commit', '-q', '--allow-empty', '-m', 'init');
  git('remote', 'add', 'origin', url);
  return dir;
}

test.afterAll(stopFakeWorker);

/**
 * 建一个真实的组合工作目录（只含第一个仓库）+ 派生一条会话：加仓库 UI 只在组上才有意义，
 * 而且组里每个仓库都得有 link 工作空间当基座（见 workspace-groups.ts 的 baseForRepo）。
 */
async function setupCombo(page: Page, headers: Record<string, string>, workerId: string, names: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), 'e2e-add-repo-'));
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot, { recursive: true });
  const repos = names.map((name) => ({ name, url: `https://example.invalid/acme/${name}.git` }));
  const dirs = repos.map((repo) => makeRepo(join(root, 'repos'), repo.name, repo.url));

  const project = (await (
    await page.request.post('/api/projects', { data: { name: `e2e 加仓库 ${Date.now().toString(36)}`, rootPath: projectRoot, workerId }, headers })
  ).json()) as { id: string };
  const patched = await page.request.patch(`/api/projects/${project.id}`, {
    data: { repos: repos.map((repo) => ({ ...repo, defaultBranch: 'main' })) },
    headers
  });
  expect(patched.status(), await patched.text()).toBe(200);
  const projectView = (await patched.json()) as { repos: Array<{ id: string; name: string }> };
  const repoIds = names.map((name) => projectView.repos.find((repo) => repo.name === name)!.id);
  const repoIdOf = (name: string) => repoIds[names.indexOf(name)];
  const primary = await page.request.patch(`/api/projects/${project.id}`, { data: { primaryRepoId: repoIds[0] }, headers });
  expect(primary.status(), await primary.text()).toBe(200);

  for (const [index, repo] of repos.entries()) {
    const linked = await page.request.post('/api/workspaces', {
      data: { workerId, mode: 'link', path: dirs[index], repoUrl: repo.url, branch: 'main', name: repo.name, projectId: project.id },
      headers
    });
    expect(linked.status(), await linked.text()).toBe(201);
  }

  const task = (await (
    await page.request.post('/api/tasks', { data: { projectId: project.id, title: '加仓库' }, headers })
  ).json()) as { id: string };
  const built = await page.request.post(`/api/projects/${project.id}/workspace-groups`, {
    data: { taskId: task.id, workerId, repoIds: [repoIds[0]] },
    headers
  });
  expect(built.status(), await built.text()).toBe(201);
  const group = (await built.json()) as {
    id: string;
    state: string;
    error: string | null;
    members: Array<{ workspaceId: string; repoId: string | null; name: string; state: string; error: string | null }>;
  };
  expect(group.state, group.error ?? '').toBe('ready');

  const derived = await page.request.post('/api/sessions/derive', {
    data: { taskId: task.id, agentId: FAKE_AGENT_ID, model: '', groupId: group.id, workerId },
    headers
  });
  expect(derived.status(), await derived.text()).toBe(201);
  const session = (await derived.json()) as { id: string };
  return { projectId: project.id, sessionId: session.id, groupId: group.id, repoIdOf };
}

const SHOTS = process.env['E2E_SCREENSHOTS'];

test('窄屏添加仓库：短名单在抽屉里，挂着时不重复发，失败看得见且手动重试', async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const workerId = await ensureFakeWorker(page, baseURL!);

  const { projectId, sessionId, groupId, repoIdOf } = await setupCombo(page, headers, workerId, ['web', 'api', 'docs']);

  // 只截「加仓库」这一对请求（POST 提交 + 判真伪的那次 GET），其余照常打到真服务端。
  // post 侧：missing = 回 201 但名单里没有这次要加的仓库（前端不许当成功）；
  //         boom = 500 且 body 里带一句机器原话（前端不许把这句透出来）。
  // get 侧：stale = 组里已经有一个同名但不同 repoId 的仓库；fail = 读不成；pass = 真的去读服务端。
  let postMode: 'pass' | 'hold' | 'missing' | 'boom' = 'pass';
  let getMode: 'pass' | 'stale' | 'fail' = 'pass';
  let posts = 0;
  let gets = 0;
  let releaseHold: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    releaseHold = () => resolve();
  });
  const groupJson = async () => await (await page.request.get(`/api/workspace-groups/${groupId}`, { headers })).text();
  const staleJson = async () =>
    JSON.stringify({
      ...(JSON.parse(await groupJson()) as Record<string, unknown>),
      members: [
        ...((JSON.parse(await groupJson()) as { members: unknown[] }).members ?? []),
        { workspaceId: 'ws-samename', repoId: 'repo-samename', name: 'docs', state: 'ready', error: null }
      ]
    });
  let stale: string | null = null;

  await page.route('**/api/workspace-groups/*/members', async (route) => {
    posts += 1;
    if (postMode === 'hold') {
      await held;
      return route.continue();
    }
    if (postMode === 'missing') {
      return route.fulfill({ status: 201, contentType: 'application/json', body: await groupJson() });
    }
    if (postMode === 'boom') {
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'worker_error', message: '机器拒绝了这次操作' } })
      });
    }
    return route.continue();
  });
  // 后注册的通配先跑；非 GET（成员提交）交回上面那条。
  await page.route('**/api/workspace-groups/*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    gets += 1;
    if (getMode === 'fail') {
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'unavailable', message: '数据库忙' } })
      });
    }
    if (getMode === 'stale') {
      stale = stale ?? (await staleJson());
      return route.fulfill({ status: 200, contentType: 'application/json', body: stale });
    }
    // pass：让前端读到的就是服务端真状态，不拿开局那张快照顶替。
    return route.continue();
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/p/${projectId}/focus/${sessionId}`);
  await page.getByTestId('session-more-trigger').click();
  await page.getByTestId('session-more-workspace').click();

  const sheet = page.getByTestId('workspace-sheet');
  await expect(sheet).toBeVisible();
  // 组合会话一进来就该有分支：早先不带 ?member= 的 git/state 会被服务端拒成 400，
  // 而 retry:false 让抽屉里永远停在「暂未确认 Git 状态」。
  await expect(sheet.getByTestId('workspace-branch')).toHaveAttribute('data-git', 'yes', { timeout: 30_000 });
  await expect(sheet.getByTestId('workspace-branch')).not.toHaveText('暂未确认 Git 状态');
  const scroller = sheet.locator(':scope > div').first();
  const box = async (locator: typeof sheet) => {
    const found = await locator.boundingBox();
    expect(found, '元素应该有盒子').not.toBeNull();
    return found!;
  };
  const inside = async (locator: typeof sheet, label: string) => {
    const outer = await box(scroller);
    const inner = await box(locator);
    expect(inner.x, `${label} 左边界`).toBeGreaterThanOrEqual(outer.x - 1);
    expect(inner.x + inner.width, `${label} 右边界`).toBeLessThanOrEqual(outer.x + outer.width + 1);
    expect(inner.y, `${label} 上边界`).toBeGreaterThanOrEqual(outer.y - 1);
    expect(inner.y + inner.height, `${label} 下边界`).toBeLessThanOrEqual(outer.y + outer.height + 1);
  };
  const noticeFor = (name: string) => sheet.locator(`[data-testid="repo-add-notice"][data-repo="${repoIdOf(name)}"]`);

  // —— 短名单在抽屉里（不是飘出去被 overflow-y-auto 裁掉的那层）
  await sheet.getByTestId('repo-add').click();
  await expect(sheet.getByTestId('repo-add-menu')).toBeVisible();
  await expect(sheet.getByTestId('repo-add-api')).toBeVisible();
  await expect(sheet.getByTestId('repo-add-docs')).toBeVisible();
  await inside(sheet.getByTestId('repo-add-menu'), '短名单');
  // 手指点得中：入口、候选、仓库页签都是 44px 起。
  for (const testId of ['repo-add', 'repo-add-api', 'repo-switcher-web']) {
    expect((await box(sheet.getByTestId(testId))).height, `${testId} 触摸高度`).toBeGreaterThanOrEqual(44);
  }
  // 加两个仓库也只多两行：抽屉不该为了它变成一整屏滚动。
  expect(await scroller.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeLessThanOrEqual(1);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'add-repo-menu-390.png') });

  // —— 320 也一样完整可见，且没有横向溢出
  await page.setViewportSize({ width: 320, height: 720 });
  await expect(sheet.getByTestId('repo-add-menu')).toBeVisible();
  await inside(sheet.getByTestId('repo-add-menu'), '短名单（320）');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'add-repo-menu-320.png') });
  await page.setViewportSize({ width: 390, height: 844 });

  // —— 挂着的时候：按钮说「添加中…」、不接受第二下，服务端只收到一条
  postMode = 'hold';
  await sheet.getByTestId('repo-add-api').click();
  await expect(sheet.getByTestId('repo-add')).toHaveText('添加中…');
  await expect(sheet.getByTestId('repo-add')).toBeDisabled();
  // 禁用态下再点一次（直接派发点击，等浏览器吞掉）也不该多一条。
  await sheet.getByTestId('repo-add').dispatchEvent('click');
  expect(posts, '挂着的请求只该有一条').toBe(1);
  await expect(sheet.getByTestId('repo-switcher-api')).toHaveCount(0); // 还没确认，先别报成功
  releaseHold();

  // —— 服务端回了 201 并带上这个成员：页签跟着出现，明确说一句加上了
  await expect(sheet.getByTestId('repo-switcher-api')).toBeVisible({ timeout: 30_000 });
  await expect(noticeFor('api')).toHaveAttribute('data-kind', 'ok');
  await expect(noticeFor('api')).toContainText('已把「api」加进组合工作目录');
  expect(posts).toBe(1);

  // —— 组里已有同名但不同 repoId 的仓库：不许当成加上了，也不许给重试（再发一次会再建一个）
  getMode = 'stale';
  postMode = 'missing';
  await sheet.getByTestId('repo-add').click();
  await sheet.getByTestId('repo-add-docs').click();
  await expect(noticeFor('docs')).toHaveAttribute('data-kind', 'muted', { timeout: 30_000 });
  await expect(noticeFor('docs')).toContainText('组里已经有一个同名仓库');
  await expect(noticeFor('docs').getByTestId('repo-add-retry')).toHaveCount(0);
  await expect(noticeFor('docs').getByTestId('repo-add-recheck')).toBeVisible();
  // 结论没定的仓库从候选里消失：docs 是最后一个可加项，入口整体不再出现——不能借短名单再发一次。
  await expect(sheet.getByTestId('repo-add')).toHaveCount(0);
  await expect(sheet.getByTestId('repo-add-menu')).toHaveCount(0);
  expect(posts).toBe(2);

  // —— 「重新确认」只读：读到的组里确实没有这个 repoId，才长出重试，且绝不重发请求
  getMode = 'pass';
  await noticeFor('docs').getByTestId('repo-add-recheck').click();
  await expect(noticeFor('docs')).toHaveAttribute('data-kind', 'error', { timeout: 30_000 });
  await expect(noticeFor('docs')).toContainText('没有加上「docs」：组里还是没有这个仓库');
  await expect(noticeFor('docs').getByTestId('repo-add-retry')).toBeVisible();
  await expect(sheet.getByTestId('repo-switcher-docs')).toHaveCount(0);
  await expect(sheet.getByTestId('repo-add')).toHaveCount(0); // 确认没加上也不回到短名单，只走重试
  expect(posts, '重新确认不该发提交请求').toBe(2);
  expect(gets, '重新确认要真去读一次').toBeGreaterThanOrEqual(2);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'add-repo-unconfirmed.png') });

  // —— 真失败（500）：说人话，不透传服务端那句原话，仍然可以手动重试
  postMode = 'boom';
  await noticeFor('docs').getByTestId('repo-add-retry').click();
  await expect(noticeFor('docs')).toContainText('没有加上「docs」：机器那边没有完成这次操作', { timeout: 30_000 });
  await expect(noticeFor('docs')).not.toContainText('机器拒绝了这次操作');
  await expect(noticeFor('docs').getByTestId('repo-add-retry')).toBeVisible();
  expect(posts).toBe(3);

  // —— 判真伪的那次读也失败：只能说「没确认」，只给只读的重新确认，绝不给重试
  getMode = 'fail';
  await noticeFor('docs').getByTestId('repo-add-retry').click();
  await expect(noticeFor('docs')).toHaveAttribute('data-kind', 'muted', { timeout: 30_000 });
  await expect(noticeFor('docs')).toContainText('再读一次也没读成');
  await expect(noticeFor('docs').getByTestId('repo-add-retry')).toHaveCount(0);
  await expect(noticeFor('docs').getByTestId('repo-add-recheck')).toBeVisible();
  await expect(sheet.getByTestId('repo-add')).toHaveCount(0);
  expect(posts).toBe(4);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'add-repo-uncertain.png') });

  // —— 读得动了再确认：结论回到「确实没加上」，重试按钮回来（仍然只有一次点击才算一次请求）
  getMode = 'pass';
  await noticeFor('docs').getByTestId('repo-add-recheck').click();
  await expect(noticeFor('docs')).toHaveAttribute('data-kind', 'error', { timeout: 30_000 });
  await expect(noticeFor('docs').getByTestId('repo-add-retry')).toBeVisible();
  expect(posts, '重新确认不该发提交请求').toBe(4);

  // —— 重试打通：服务端确认后才出现 docs 页签
  postMode = 'pass';
  await noticeFor('docs').getByTestId('repo-add-retry').click();
  await expect(sheet.getByTestId('repo-switcher-docs')).toBeVisible({ timeout: 30_000 });
  await expect(noticeFor('docs')).toHaveAttribute('data-kind', 'ok');
  await expect(noticeFor('docs')).toContainText('已把「docs」加进组合工作目录');
  await expect(sheet.getByTestId('repo-add')).toHaveCount(0);
  expect(posts).toBe(5);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'add-repo-done.png') });

  await page.request.post(`/api/sessions/${sessionId}/interrupt`, { headers });
  await page.request.delete(`/api/workspace-groups/${groupId}`, { headers });
});

test('短名单空了，没确认的结论还得留在抽屉里', async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const workerId = await ensureFakeWorker(page, baseURL!);

  // 两个仓库、组里只有一个：docs 一旦结论没定，短名单就彻底空了。
  // 这时抽屉不能连「没确认」那句一起消失（旧的 `members.length < 2 && addable.length === 0` 就会）。
  const { projectId, sessionId, groupId, repoIdOf } = await setupCombo(page, headers, workerId, ['web', 'docs']);

  let posts = 0;
  await page.route('**/api/workspace-groups/*/members', async (route) => {
    posts += 1;
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'worker_error', message: '机器拒绝了这次操作' } })
    });
  });
  await page.route('**/api/workspace-groups/*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'unavailable', message: '数据库忙' } })
    });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/p/${projectId}/focus/${sessionId}`);
  await page.getByTestId('session-more-trigger').click();
  await page.getByTestId('session-more-workspace').click();

  const sheet = page.getByTestId('workspace-sheet');
  await expect(sheet).toBeVisible();
  await sheet.getByTestId('repo-add').click();
  await sheet.getByTestId('repo-add-docs').click();

  const notice = sheet.locator(`[data-testid="repo-add-notice"][data-repo="${repoIdOf('docs')}"]`);
  await expect(notice).toHaveAttribute('data-kind', 'muted', { timeout: 30_000 });
  await expect(notice).toContainText('再读一次也没读成');
  // 页签还在、结论在、短名单没了：三条同时成立才算「留在原地」。
  await expect(sheet.getByTestId('repo-switcher-web')).toBeVisible();
  await expect(sheet.getByTestId('repo-add')).toHaveCount(0);
  await expect(notice.getByTestId('repo-add-retry')).toHaveCount(0);

  // 再确认一次：读还是不成，仍然不给重试，也不多发提交请求。
  await notice.getByTestId('repo-add-recheck').click();
  await expect(notice).toHaveAttribute('data-kind', 'muted', { timeout: 30_000 });
  await expect(notice.getByTestId('repo-add-retry')).toHaveCount(0);
  expect(posts).toBe(1);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'add-repo-notice-only.png') });

  await page.request.post(`/api/sessions/${sessionId}/interrupt`, { headers });
  await page.request.delete(`/api/workspace-groups/${groupId}`, { headers });
});
