import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { ensureFakeWorker, stopFakeWorker } from './fake-worker.ts';
import { loginByApi } from './login.ts';

/**
 * 会话通信 · 检查器里的「同伴」范围（任务树第一刀）：
 * 同一棵顶层任务树、显式连线、派生三种关系都要说清楚；老服务端不给 relation 时不许瞎猜成「派生」。
 * 「连线」和「同任务树」走真后端真接口——同任务里另派生一条不连线的会话，页面就该标「同任务树」；
 * 「派生」还只有 fixture 能稳定造出来，和「老条目没 relation」一起用来验渲染与防御性留空。
 * agent 用假 ACP Worker（见 ./fake-worker.ts）：不依赖本机 pi 的在线探测，派生不会因宿主机忙而 503。
 */
const AGENT_ID = 'fakeacppeers';

test.afterAll(() => stopFakeWorker());
type Peer = {
  address: string;
  handle?: string;
  label: string;
  status: string;
  connected?: boolean;
  relation?: 'explicit' | 'task_tree' | 'spawn';
  workerId?: string | null;
};

const SHOTS = process.env['E2E_SCREENSHOTS'] ?? 'test-results/session-peers';

async function world(page: Page, baseURL: string, workerId: string) {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  const dir = mkdtempSync(join(tmpdir(), 'e2e-peers-'));
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 同伴范围 ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '同伴范围' }, headers })).json()) as { id: string };
  const session = async (): Promise<string> => {
    const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: AGENT_ID, model: '' }, headers });
    expect(derived.status(), await derived.text()).toBe(201);
    return ((await derived.json()) as { id: string }).id;
  };
  return { project: project.id, headers, session };
}

async function openDetails(page: Page, projectId: string, sessionId: string) {
  await page.goto(`/#/p/${projectId}/focus/${sessionId}`);
  // 同一个地址再 goto 不会重载：先刷一次，别带着上一轮开着的抽屉判断
  await page.reload();
  const details = page.getByRole('complementary', { name: '会话详情' });
  const direct = page.getByRole('banner').getByRole('button', { name: '详情', exact: true });
  await expect(page.getByRole('button', { name: '更多' })).toBeVisible();
  if (!(await details.isVisible())) {
    if (await direct.isVisible()) await direct.click({ timeout: 15_000 });
    else {
      await page.getByRole('button', { name: '更多' }).click({ timeout: 15_000 });
      await page.getByTestId('session-more-details').click({ timeout: 15_000 });
      await page.getByRole('menuitem', { name: /^详情/ }).click({ timeout: 15_000 });
    }
  }
  return details;
}

test('检查器同伴：连线 / 同任务树 / 派生分开标；没有 relation 的老条目保持沉默；空状态与权限说明（1280 / 390）', async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  await loginByApi(page);
  const workerId = await ensureFakeWorker(page, baseURL!, AGENT_ID);
  const w = await world(page, baseURL!, workerId);
  // a 和 b 显式连线；c 是同一任务里另派生的一条，没连过线——它就是「同任务树」。
  const [a, b, c] = [await w.session(), await w.session(), await w.session()];
  const linked = await page.request.post(`/api/projects/${w.project}/session-links`, { data: { aSessionId: a, bSessionId: b }, headers: w.headers });
  expect(linked.status(), await linked.text()).toBe(201);
  expect((await page.request.put(`/api/sessions/${b}/handle`, { data: { handle: 'verify' }, headers: w.headers })).status()).toBe(200);
  expect((await page.request.put(`/api/sessions/${c}/handle`, { data: { handle: 'sibling' }, headers: w.headers })).status()).toBe(200);

  // 先走真实接口：显式连线和同任务树都由后端回 relation，页面上分别标「连线」「同任务树」。
  await page.setViewportSize({ width: 1280, height: 860 });
  const realDetails = await openDetails(page, w.project, a);
  const realRows = realDetails.getByTestId('session-peer-row');
  await expect(realRows).toHaveCount(2);
  const realRelation = (handle: string) => realRows.filter({ hasText: `peer:${handle}` }).getByTestId('session-peer-relation');
  await expect(realRelation('verify')).toHaveText('连线');
  await expect(realRelation('verify')).toHaveAttribute('data-relation', 'explicit');
  await expect(realRelation('sibling')).toHaveText('同任务树');
  await expect(realRelation('sibling')).toHaveAttribute('data-relation', 'task_tree');
  console.log('[peers] real explicit link + same task tree ok');

  // 固定响应：保留「派生」和一条老服务端条目（relation / connected 都没有），再带上真连线；
  // 派生关系目前只有 fixture 能稳定造出来，这条也顺带撑多行布局。
  const fixture: { peers: Peer[]; handle: string | null } = {
    handle: null,
    peers: [
      { address: `session:${b}`, handle: 'verify', label: '显式连线的会话', status: 'idle', connected: true, relation: 'explicit', workerId: 'worker-a' },
      { address: 'session:spawn-child', handle: 'child', label: '派生出来的会话', status: 'idle', relation: 'spawn', workerId: 'worker-a' },
      { address: 'session:legacy-peer', handle: 'legacy', label: '老服务端条目', status: 'idle', workerId: 'worker-a' }
    ]
  };
  await page.route(`**/api/sessions/${a}/peers`, (route) => route.fulfill({ json: fixture }));

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width > 500 ? 860 : 844 });
    const details = await openDetails(page, w.project, a);
    const peers = details.getByTestId('session-peers');
    const rows = peers.getByTestId('session-peer-row');
    await expect(rows).toHaveCount(3);
    await expect(peers.getByTestId('session-peers-count')).toHaveText('3');

    const relation = (handle: string) => rows.filter({ hasText: `peer:${handle}` }).getByTestId('session-peer-relation');
    await expect(relation('verify')).toHaveText('连线');
    await expect(relation('verify')).toHaveAttribute('data-relation', 'explicit');
    await expect(relation('child')).toHaveText('派生');
    await expect(relation('child')).toHaveAttribute('data-relation', 'spawn');
    // 老服务端只给会话、不给原因：不猜「派生」，留空
    await expect(relation('legacy')).toHaveText('');
    await expect(relation('legacy')).toHaveAttribute('data-relation', 'unknown');

    await expect(peers.getByTestId('session-peers-scope')).toContainText('同一棵任务树');
    await expect(peers.getByTestId('session-peers-scope')).toContainText('项目权限');
    console.log(`[peers] ${width} relation chips ok`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '不横向溢出').toBe(true);
    await peers.screenshot({ path: `${SHOTS}/relations-${width}.png`, timeout: 20_000 });
  }

  // 空状态：同一棵任务树也要提，别只说「去画布连线」。
  // 另起一条会话 d，避免 c 那条真同伴把空列表填上。
  const d = await w.session();
  await page.unroute(`**/api/sessions/${a}/peers`);
  await page.route(`**/api/sessions/${d}/peers`, (route) => route.fulfill({ json: { peers: [], handle: null } }));
  await page.setViewportSize({ width: 1280, height: 860 });
  const details = await openDetails(page, w.project, d);
  const empty = details.getByTestId('session-peers').getByTestId('session-peers-empty');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('同一棵任务树');
  await expect(details.getByTestId('session-peers-count')).toHaveText('0');
  console.log('[peers] empty state ok');
  await details.getByTestId('session-peers').screenshot({ path: `${SHOTS}/empty-1280.png`, timeout: 20_000 });
});
