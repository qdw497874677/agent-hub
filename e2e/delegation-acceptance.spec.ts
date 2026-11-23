import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';

/**
 * 派工验收 / 测试证据 / 转交记录（docs/design/vibex-borrowing.md 第二期 V4 / V6 / V7）。
 *
 * 服务端行为由 workspace-delegation 的单测负责；这里用明确范围的 route mock 验界面契约：
 * 完整 SHA、勾选绑定、HEAD 变化不继承、同内容重试复用请求键、没有可信测试记录就不编造、
 * 转交记录只说投递事实。
 */

interface Seed {
  readonly projectId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly repoId: string;
  readonly agentId: string;
}

/** A / B 都是合法 40 位小写提交；字符串可读，失败时一眼能分辨。 */
const SHA_A = 'a1'.repeat(20);
const SHA_B = 'b2'.repeat(20);

type Headers = { origin: string; 'x-hub-csrf': string };

test.afterAll(() => {
  stopFakeWorker();
});

const headers = async (page: Page, baseURL: string | undefined): Promise<Headers> => {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  return { origin: baseURL!, 'x-hub-csrf': csrf };
};

async function seed(page: Page, h: Headers): Promise<Seed> {
  const workerId = await ensureFakeWorker(page, h.origin);
  const agentId = FAKE_AGENT_ID;
  const name = `e2e 验收 ${Date.now().toString(36)}`;
  const project = (await (
    await page.request.post('/api/projects', {
      data: { name, rootPath: mkdtempSync(join(tmpdir(), 'e2e-acceptance-')), workerId },
      headers: h
    })
  ).json()) as { id: string };
  const workspace = await page.request.post(`/api/projects/${project.id}/workspaces`, {
    data: { kind: 'long_lived', mode: 'create', path: mkdtempSync(join(tmpdir(), 'e2e-acceptance-ws-')), workerId },
    headers: h
  });
  expect(workspace.ok(), await workspace.text()).toBeTruthy();
  const workspaceId = ((await workspace.json()) as { id: string }).id;

  const patched = await page.request.patch(`/api/projects/${project.id}`, {
    data: { repos: [{ name: 'demo', url: 'https://github.com/e2e/demo.git', defaultBranch: 'main' }] },
    headers: h
  });
  expect(patched.ok(), await patched.text()).toBeTruthy();
  const repoId = ((await patched.json()) as { repos: Array<{ id: string }> }).repos[0]!.id;

  const taskTitle = `验收任务 ${Date.now().toString(36)}`;
  const task = await page.request.post('/api/tasks', { data: { projectId: project.id, title: taskTitle }, headers: h });
  expect(task.ok(), await task.text()).toBeTruthy();
  const taskId = ((await task.json()) as { id: string }).id;

  const started = await page.request.post('/api/coordinators', {
    data: { projectId: project.id, workspaceId, agentId, model: '' },
    headers: h
  });
  expect(started.status(), await started.text()).toBe(201);
  const session = ((await started.json()) as { session: { id: string } }).session;

  return { projectId: project.id, sessionId: session.id, taskId, taskTitle, repoId, agentId };
}

function delegation(seedValue: Seed, over: Record<string, unknown> = {}) {
  return {
    id: 'del-accept',
    coordinatorSessionId: seedValue.sessionId,
    requestKey: 'req-验收-1',
    projectId: seedValue.projectId,
    taskId: seedValue.taskId,
    repoId: seedValue.repoId,
    workerId: 'worker-e2e',
    baseBranch: 'main',
    baseSha: 'c'.repeat(40),
    instructions: '把空态文案改短，跑一次 typecheck',
    executionSessionId: 'exec-session-accept',
    executionSessionExists: true,
    worktreePath: '/tmp/e2e-acceptance-ws.delegation-accept',
    branch: 'delegation/accept1',
    state: 'prepared',
    failure: null,
    canConfirm: false,
    startup: { agentId: seedValue.agentId, model: '', profileId: null },
    createdAt: 1,
    updatedAt: 2,
    ...over
  };
}

interface Entry {
  requestKey: string;
  sha: string;
  createdAt: number;
  note: string | null;
}

function acceptanceView(over: Record<string, unknown> = {}) {
  return {
    delegationId: 'del-accept',
    state: 'prepared',
    history: [] as Entry[],
    latest: null as Entry | null,
    current: null as Entry | null,
    headSha: SHA_A as string | null,
    headUnavailable: null as string | null,
    headObservedAt: 1_760_000_000_000,
    status: 'none',
    canAccept: true,
    ...over
  };
}

/** 默认给每个对话框一个干净的「没有转交记录」，需要具体记录的用例再覆盖。 */
async function stubEmptyHandoff(page: Page) {
  await page.route('**/api/workspace-delegations/*/handoff', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        delegationId: 'del-accept',
        projectId: 'p',
        executionSessionId: 'exec',
        state: 'none',
        scanTruncated: false,
        handoffs: []
      })
    })
  );
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const openPanel = async (page: Page, seedValue: Seed, delegationId: string) => {
  await page.goto(`/#/p/${seedValue.projectId}/focus/${seedValue.sessionId}`);
  await page.locator(`[data-testid="delegation-row"][data-delegation-id="${delegationId}"]`).getByTestId('delegation-evidence-open').click();
};

test.use({ viewport: { width: 390, height: 844 } });

test('验收 A：完整 SHA、勾选绑定、同内容重试复用请求键；测试证据明说未记录', async ({ page, baseURL }) => {
  await loginByApi(page);
  const h = await headers(page, baseURL);
  const seedValue = await seed(page, h);
  const record = delegation(seedValue);
  await stubEmptyHandoff(page);

  await page.route('**/api/coordinators/*/delegations', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return json(route, { delegations: [record] });
  });

  const posts: Array<{ requestKey: string; expectedHeadSha: string; note: string | null }> = [];
  const history: Entry[] = [];
  let latest: Entry | null = null;
  let current: Entry | null = null;
  let status = 'none';

  await page.route('**/api/workspace-delegations/*/acceptance', async (route) => {
    if (route.request().method() === 'GET') {
      return json(route, acceptanceView({ history, latest, current, status, headSha: SHA_A, canAccept: true }));
    }
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      requestKey: string;
      expectedHeadSha: string;
      note: string | null;
    };
    posts.push(body);
    if (posts.length === 1) {
      // 网络/服务端抖动：内容没落库，重试应该原样复用请求键
      return json(route, { error: { code: 'internal', message: '假装没记上' } }, 500);
    }
    latest = { requestKey: body.requestKey, sha: body.expectedHeadSha, createdAt: 1_760_000_100_000, note: body.note };
    current = latest;
    history.push(latest);
    status = 'accepted';
    return json(route, { delegationId: record.id, outcome: 'created', acceptance: latest });
  });

  await openPanel(page, seedValue, 'del-accept');
  const dialog = page.getByTestId('delegation-evidence');
  await expect(dialog).toBeVisible();
  // 完整 40 位、可选中的 SHA；不是截短值
  await expect(page.getByTestId('acceptance-head')).toHaveText(SHA_A);
  await expect(page.getByTestId('acceptance-title')).toContainText('还没验收过');
  await expect(page.getByTestId('delegation-test-evidence')).toHaveAttribute('data-state', 'not-recorded');
  await expect(page.getByTestId('delegation-test-evidence')).toContainText('未记录');

  // 没勾选之前不能记
  const accept = page.getByTestId('delegation-accept');
  await expect(accept).toBeDisabled();
  await page.getByTestId('acceptance-confirm').check();
  await expect(accept).toBeEnabled();
  await page.getByTestId('acceptance-note').fill('首页文案已看，typecheck 过了');

  await accept.click();
  await expect(page.getByTestId('acceptance-error')).toContainText('假装没记上');

  // 失败后勾选作废（HEAD 可能已经变了），重新核对才能再点
  await expect(page.getByTestId('acceptance-confirm')).not.toBeChecked();
  await expect(accept).toBeDisabled();
  await page.getByTestId('acceptance-confirm').check();
  await accept.click();

  await expect.poll(() => posts.length).toBe(2);
  expect(posts[0]).toEqual(posts[1]);
  expect(posts[1]).toEqual({
    requestKey: posts[1]!.requestKey,
    expectedHeadSha: SHA_A,
    note: '首页文案已看，typecheck 过了'
  });
  expect(Object.keys(posts[1]!).sort()).toEqual(['expectedHeadSha', 'note', 'requestKey']);
  expect(posts[1]!.requestKey.trim().length).toBeGreaterThan(8);

  // 成功后服务端回读：当前已验收、历史一条；不再给第二个「记录」按钮
  await expect(page.getByTestId('acceptance-title')).toContainText('当前已验收');
  await expect(page.getByTestId('acceptance-history-entry')).toHaveCount(1);
  await expect(page.getByTestId('acceptance-history-entry')).toContainText('当前验收');
  await expect(page.getByTestId('delegation-accept')).toHaveCount(0);

  // 面板/抽屉在手机上不顶出屏幕
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(391);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(845);
});

test('验收 B：HEAD 换了旧勾选作废，B 不继承 A 的验收', async ({ page, baseURL }) => {
  await loginByApi(page);
  const h = await headers(page, baseURL);
  const seedValue = await seed(page, h);
  const record = delegation(seedValue, { id: 'del-accept-b' });
  await stubEmptyHandoff(page);

  await page.route('**/api/coordinators/*/delegations', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return json(route, { delegations: [record] });
  });

  const entryA: Entry = { requestKey: 'req-A', sha: SHA_A, createdAt: 1_759_999_000_000, note: null };
  const history: Entry[] = [entryA];
  const posts: Array<{ requestKey: string; expectedHeadSha: string; note: string | null }> = [];
  // 打开时 HEAD 已经走到 B：A 的记录保留，但状态是 changed（当前未验收）
  let headSha = SHA_B;
  let current: Entry | null = null;
  let status = 'changed';

  await page.route('**/api/workspace-delegations/*/acceptance', async (route) => {
    if (route.request().method() === 'GET') {
      return json(route, acceptanceView({ history, latest: history[history.length - 1] ?? null, current, status, headSha, canAccept: true }));
    }
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      requestKey: string;
      expectedHeadSha: string;
      note: string | null;
    };
    posts.push(body);
    const entry: Entry = { requestKey: body.requestKey, sha: body.expectedHeadSha, createdAt: 1_760_000_200_000, note: body.note };
    history.push(entry);
    current = entry;
    status = 'accepted';
    return json(route, { delegationId: record.id, outcome: 'created', acceptance: entry });
  });

  await openPanel(page, seedValue, 'del-accept-b');
  const dialog = page.getByTestId('delegation-evidence');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('acceptance-title')).toContainText('当前提交还没验收');
  await expect(page.getByTestId('acceptance-state')).toHaveAttribute('data-status', 'changed');
  // 旧记录看得见（完整 SHA），但不允许点着 A 的结论去验收 B
  await expect(page.getByTestId('acceptance-history-entry')).toHaveCount(1);
  await expect(page.getByTestId('acceptance-history-entry')).toContainText(SHA_A);
  await expect(page.getByTestId('acceptance-history-entry')).not.toContainText('当前验收');
  await expect(page.getByTestId('acceptance-head')).toHaveText(SHA_B);
  await expect(page.getByTestId('delegation-accept')).toBeDisabled();

  // A 的勾选不能跨到 B：勾上之后 HEAD 变成 A，再刷新 → 勾选作废
  headSha = SHA_A;
  await page.getByTestId('acceptance-confirm').check();
  await page.getByTestId('acceptance-reload').click();
  await expect(page.getByTestId('acceptance-confirm')).not.toBeChecked();
  await expect(page.getByTestId('acceptance-head')).toHaveText(SHA_A);

  // 回到 B 重新核对并提交：发的是 B，不是历史里的 A
  headSha = SHA_B;
  await page.getByTestId('acceptance-reload').click();
  // A→B→A 走一圈之后，之前对 B 的勾选不能悄悄回来
  await expect(page.getByTestId('acceptance-head')).toHaveText(SHA_B);
  await expect(page.getByTestId('acceptance-confirm')).not.toBeChecked();
  await page.getByTestId('acceptance-confirm').check();
  await page.getByTestId('acceptance-note').fill('只在 B 上复核');
  await page.getByTestId('delegation-accept').click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]!.expectedHeadSha).toBe(SHA_B);
  expect(posts[0]!.note).toBe('只在 B 上复核');

  // 成功之后 A 仍在历史里（不覆盖），当前验收指向 B
  await expect.poll(async () => page.getByTestId('acceptance-history-entry').count()).toBe(2);
  await expect(page.getByTestId('acceptance-title')).toContainText('当前已验收');
  await expect(page.getByTestId('acceptance-history-entry').first()).toContainText(SHA_B);
  await expect(page.getByTestId('acceptance-history-entry').first()).toContainText('当前验收');
  await expect(page.getByTestId('acceptance-history-entry').last()).toContainText(SHA_A);
});

test('入口与证据边界：没有执行会话不给入口，读不到 HEAD 或服务端不允许时不给动作', async ({ page, baseURL }) => {
  await loginByApi(page);
  const h = await headers(page, baseURL);
  const seedValue = await seed(page, h);
  await stubEmptyHandoff(page);

  const gone = delegation(seedValue, {
    id: 'del-no-session',
    executionSessionExists: false,
    state: 'prepared'
  });
  const noHead = delegation(seedValue, { id: 'del-no-head' });
  const readOnly = delegation(seedValue, { id: 'del-readonly' });

  await page.route('**/api/coordinators/*/delegations', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return json(route, { delegations: [gone, noHead, readOnly] });
  });

  let acceptanceReads = 0;
  await page.route('**/api/workspace-delegations/*/acceptance', async (route) => {
    acceptanceReads += 1;
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    if (id === noHead.id) {
      return json(
        route,
        acceptanceView({
          delegationId: noHead.id,
          headSha: null,
          headUnavailable: '工作区不在这台机器上：先让 worker 同步工作目录',
          headObservedAt: null,
          status: 'unavailable',
          canAccept: false
        })
      );
    }
    return json(
      route,
      acceptanceView({
        delegationId: readOnly.id,
        history: [{ requestKey: 'req-old', sha: SHA_A, createdAt: 1_700_000_000_000, note: '早先人工看过' }],
        latest: { requestKey: 'req-old', sha: SHA_A, createdAt: 1_700_000_000_000, note: '早先人工看过' },
        current: null,
        headSha: SHA_B,
        status: 'changed',
        canAccept: false
      })
    );
  });

  await page.goto(`/#/p/${seedValue.projectId}/focus/${seedValue.sessionId}`);
  const goneRow = page.locator('[data-testid="delegation-row"][data-delegation-id="del-no-session"]');
  await expect(goneRow).toBeVisible();
  // 没有执行会话：进入、发布、验收三个入口都不画
  await expect(goneRow.getByTestId('delegation-open')).toHaveCount(0);
  await expect(goneRow.getByTestId('delegation-publish-open')).toHaveCount(0);
  await expect(goneRow.getByTestId('delegation-evidence-open')).toHaveCount(0);
  expect(acceptanceReads).toBe(0);

  await openPanel(page, seedValue, 'del-no-head');
  const dialog = page.getByTestId('delegation-evidence');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('acceptance-title')).toContainText('无法确认当前验收状态');
  await expect(page.getByTestId('acceptance-head-missing')).toContainText('工作区不在这台机器上');
  // 拿不到 HEAD 就没有可执行的动作；也不允许把「没读到」写成通过或未通过
  await expect(page.getByTestId('acceptance-form')).toHaveCount(0);
  await expect(page.getByTestId('delegation-accept')).toHaveCount(0);
  await expect(page.getByTestId('delegation-test-evidence')).toHaveAttribute('data-state', 'not-recorded');
  await expect(page.getByTestId('acceptance-history-empty')).toBeVisible();
  await page.getByRole('button', { name: '关闭' }).click();

  // 服务端明确说不能再记（归档/任务停更）：给原因，但历史照常显示
  await openPanel(page, seedValue, 'del-readonly');
  await expect(page.getByTestId('acceptance-not-allowed')).toBeVisible();
  await expect(page.getByTestId('acceptance-form')).toHaveCount(0);
  await expect(page.getByTestId('delegation-accept')).toHaveCount(0);
  await expect(page.getByTestId('acceptance-history-entry')).toHaveCount(1);
  await expect(page.getByTestId('acceptance-history-entry')).toContainText('早先人工看过');
  expect(acceptanceReads).toBe(2);
});

test('刷新失败：TanStack 留着的旧记录只当历史，不给写入动作', async ({ page, baseURL }) => {
  await loginByApi(page);
  const h = await headers(page, baseURL);
  const seedValue = await seed(page, h);
  const record = delegation(seedValue, { id: 'del-stale' });
  await stubEmptyHandoff(page);

  await page.route('**/api/coordinators/*/delegations', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return json(route, { delegations: [record] });
  });

  const entryA: Entry = { requestKey: 'req-accepted-A', sha: SHA_A, createdAt: 1_759_000_000_000, note: '上次人工看过' };
  let failing = false;
  let writes = 0;

  await page.route('**/api/workspace-delegations/*/acceptance', async (route) => {
    if (route.request().method() === 'POST') {
      writes += 1;
      return json(route, { error: { code: 'internal', message: '不该写' } }, 500);
    }
    if (failing) {
      return json(route, { error: { code: 'unavailable', message: '验收记录暂时读不到' } }, 503);
    }
    return json(
      route,
      acceptanceView({
        delegationId: record.id,
        history: [entryA],
        latest: entryA,
        current: entryA,
        status: 'accepted',
        headSha: SHA_A,
        canAccept: true
      })
    );
  });

  await openPanel(page, seedValue, 'del-stale');
  const dialog = page.getByTestId('delegation-evidence');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('acceptance-title')).toContainText('当前已验收');
  await expect(page.getByTestId('acceptance-history-entry')).toContainText('当前验收');

  // 刷新失败：缓存里的 accepted 不能继续当当前状态，也不能给记录动作
  failing = true;
  await page.getByTestId('acceptance-reload').click();
  await expect(page.getByTestId('evidence-error')).toBeVisible();
  await expect(page.getByTestId('acceptance-state')).toHaveAttribute('data-status', 'stale');
  await expect(page.getByTestId('acceptance-title')).toContainText('暂时读不到');
  await expect(page.getByTestId('acceptance-title')).not.toContainText('当前已验收');
  await expect(page.getByTestId('acceptance-current')).toHaveCount(0);
  await expect(page.getByTestId('delegation-accept')).toHaveCount(0);
  // 旧记录还在，但只作为历史，不再带「当前验收」标签
  await expect(page.getByTestId('acceptance-history-entry')).toHaveCount(1);
  await expect(page.getByTestId('acceptance-history-entry')).toContainText(SHA_A);
  await expect(page.getByTestId('acceptance-history-entry')).not.toContainText('当前验收');
  expect(writes).toBe(0);

  // 读取恢复后可以重新确认状态（仍然不需要写）
  failing = false;
  await page.getByTestId('evidence-reload').click();
  await expect(page.getByTestId('evidence-error')).toHaveCount(0);
  await expect(page.getByTestId('acceptance-state')).toHaveAttribute('data-status', 'accepted');
  await expect(page.getByTestId('acceptance-title')).toContainText('当前已验收');
  expect(writes).toBe(0);
});

test('转交记录：只说投递事实、原始正文与候选提交都是消息里的声明', async ({ page, baseURL }) => {
  await loginByApi(page);
  const h = await headers(page, baseURL);
  const seedValue = await seed(page, h);
  const record = delegation(seedValue, { id: 'del-handoff' });

  await page.route('**/api/coordinators/*/delegations', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return json(route, { delegations: [record] });
  });

  await page.route('**/api/workspace-delegations/*/acceptance', async (route) =>
    json(route, acceptanceView({ delegationId: record.id, headSha: SHA_A, status: 'none', canAccept: true }))
  );

  let handoffState: 'recorded' | 'unknown' | 'none' = 'recorded';
  await page.route('**/api/workspace-delegations/*/handoff', async (route) => {
    if (handoffState === 'unknown') {
      return json(route, {
        delegationId: record.id,
        projectId: seedValue.projectId,
        executionSessionId: 'exec-session-accept',
        state: 'unknown',
        scanTruncated: true,
        handoffs: []
      });
    }
    if (handoffState === 'none') {
      return json(route, {
        delegationId: record.id,
        projectId: seedValue.projectId,
        executionSessionId: 'exec-session-accept',
        state: 'none',
        scanTruncated: false,
        handoffs: []
      });
    }
    return json(route, {
      delegationId: record.id,
      projectId: seedValue.projectId,
      executionSessionId: 'exec-session-accept',
      state: 'recorded',
      scanTruncated: true,
      handoffs: [
        {
          messageId: 'msg-1',
          sentAt: 1_760_000_300_000,
          fromSessionId: 'coordinator-x',
          toSessionId: 'exec-session-accept',
          transport: 'delivered',
          failure: null,
          holdReason: null,
          deliveredAt: 1_760_000_310_000,
          readAt: 1_760_000_320_000,
          body: '候选提交在这里：https://example.com/private/commit 请复核。',
          bodyTruncated: true,
          candidate: { repoId: seedValue.repoId, sha: SHA_A },
          attachments: [
            { kind: 'ref', repo: 'demo', branch: 'main', sha: SHA_A },
            { kind: 'file' }
          ],
          hiddenPartCount: 2
        },
        {
          messageId: 'msg-2',
          sentAt: 1_760_000_400_000,
          fromSessionId: 'coordinator-x',
          toSessionId: 'exec-session-accept',
          transport: 'held',
          failure: null,
          holdReason: '等待用户确认是否继续',
          deliveredAt: null,
          readAt: null,
          body: '先别合并，等我看一眼。',
          bodyTruncated: false,
          candidate: null,
          attachments: [],
          hiddenPartCount: 0
        }
      ]
    });
  });

  await openPanel(page, seedValue, 'del-handoff');
  const section = page.getByTestId('delegation-handoff');
  await expect(section).toBeVisible();
  await expect(section).toHaveAttribute('data-state', 'recorded');
  await expect(page.getByTestId('handoff-entry')).toHaveCount(2);

  // 投递状态照实写：delivered 只说明送进了运行回合
  await expect(page.getByTestId('handoff-entry').first().getByTestId('handoff-transport')).toHaveText('已送入运行回合');
  await expect(page.getByTestId('handoff-entry').first()).toContainText('不代表任务完成、测试通过');
  await expect(page.getByTestId('handoff-entry').last().getByTestId('handoff-transport')).toHaveText('投递被暂停');
  await expect(page.getByTestId('handoff-entry').last()).toContainText('等待用户确认是否继续');

  // 原始正文按纯文本显示：URL 不变成可点链接
  await expect(page.getByTestId('handoff-body').first()).toContainText('https://example.com/private/commit');
  await expect(page.getByTestId('handoff-body').first().locator('a')).toHaveCount(0);
  await expect(page.getByTestId('handoff-body-truncated')).toBeVisible();
  await expect(page.getByTestId('handoff-hidden-parts')).toContainText('另有 2 段未显示');
  await expect(page.getByTestId('handoff-attachments')).toContainText('附件 2 个');
  await expect(page.getByTestId('handoff-attachment')).toHaveCount(2);
  await expect(page.getByTestId('handoff-attachment').first()).toContainText('引用 demo · main');
  await expect(page.getByTestId('handoff-attachment').first()).toContainText(SHA_A);
  await expect(page.getByTestId('handoff-attachments').locator('a')).toHaveCount(0);

  // 候选提交是消息带的引用，完整 SHA 照原样显示，但不写成已核验
  await expect(page.getByTestId('handoff-candidate')).toContainText(SHA_A);
  await expect(page.getByTestId('handoff-candidate')).toContainText('未核验提交是否可用');
  await expect(page.getByTestId('handoff-candidate').locator('a')).toHaveCount(0);

  // 扫描到上限：有记录但可能不全
  await expect(page.getByTestId('handoff-truncated')).toContainText('可能还有更早的记录');

  // 扫不完 ≠ 没有记录
  handoffState = 'unknown';
  await page.getByTestId('handoff-reload').click();
  await expect(section).toHaveAttribute('data-state', 'unknown');
  await expect(page.getByTestId('handoff-unknown')).toContainText('不能据此断定没有转交记录');
  await expect(page.getByTestId('handoff-empty')).toHaveCount(0);

  handoffState = 'none';
  await page.getByTestId('handoff-reload').click();
  await expect(section).toHaveAttribute('data-state', 'none');
  await expect(page.getByTestId('handoff-empty')).toContainText('没有找到转交');
  await expect(page.getByTestId('handoff-unknown')).toHaveCount(0);
});
