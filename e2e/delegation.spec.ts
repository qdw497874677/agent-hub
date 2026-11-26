import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';

/**
 * 主会话派工：界面这一侧能保证的东西。
 *
 * 真路由能跑到哪一步：主会话、任务、仓库都走真实的 A2 路由种出来（这条链路是硬门禁）。
 * 派工的创建 / 确认 / 发布需要真远端（服务端要对着真仓库 `ls-remote`），本地 E2E 没有真远端凭据，
 * 所以这三段用「明确范围的 route mock」：只截派工与发布这几个端点，并且断言请求体——
 * 服务端自己的行为由 workspace-delegation 的单测 / 集成测试负责，这里只验证界面不会乱发东西。
 */

interface Seed {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly repoId: string;
  readonly agentId: string;
}

const SHA = 'c0ffee1'.padEnd(40, '0');

type Headers = { origin: string; 'x-hub-csrf': string };

/** 本文件的用例共用一个假 ACP Worker，跑完整个文件再关。 */
test.afterAll(() => {
  stopFakeWorker();
});

const headers = async (page: Page, baseURL: string | undefined): Promise<Headers> => {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  return { origin: baseURL!, 'x-hub-csrf': csrf };
};

/** 主会话 + 同项目任务 + 绑一个 HTTPS 仓库（派工表单要求项目有仓库）。 */
async function seed(page: Page, h: Headers): Promise<Seed> {
  // 会话种在只装假 ACP 的远端 Worker 上：不碰宿主机 pi 的就绪探测（探测超时会偶发 503）。
  const workerId = await ensureFakeWorker(page, h.origin);
  const agentId = FAKE_AGENT_ID;
  const name = `e2e 派工 ${Date.now().toString(36)}`;
  const project = (await (
    await page.request.post('/api/projects', {
      data: { name, rootPath: mkdtempSync(join(tmpdir(), 'e2e-delegation-')), workerId },
      headers: h
    })
  ).json()) as { id: string };
  // 工作目录不能落在项目根目录里（服务端按「目录互相嵌套」拒）
  const workspace = await page.request.post(`/api/projects/${project.id}/workspaces`, {
    data: { kind: 'long_lived', mode: 'create', path: mkdtempSync(join(tmpdir(), 'e2e-delegation-ws-')), workerId },
    headers: h
  });
  expect(workspace.ok(), await workspace.text()).toBeTruthy();
  const created = (await workspace.json()) as { id: string; workerId: string | null };
  expect(created.workerId, '主会话目录要在假 ACP 机器上，不能落到本机 pi').toBe(workerId);
  const workspaceId = created.id;

  const patched = await page.request.patch(`/api/projects/${project.id}`, {
    data: { repos: [{ name: 'demo', url: 'https://github.com/e2e/demo.git', defaultBranch: 'main' }] },
    headers: h
  });
  expect(patched.ok(), await patched.text()).toBeTruthy();
  const repoId = ((await patched.json()) as { repos: Array<{ id: string }> }).repos[0]!.id;

  const taskTitle = `派工任务 ${Date.now().toString(36)}`;
  const task = await page.request.post('/api/tasks', {
    data: { projectId: project.id, title: taskTitle },
    headers: h
  });
  expect(task.ok(), await task.text()).toBeTruthy();
  const taskId = ((await task.json()) as { id: string }).id;

  const started = await page.request.post('/api/coordinators', {
    data: { projectId: project.id, workspaceId, agentId, model: '' },
    headers: h
  });
  expect(started.status(), await started.text()).toBe(201);
  const body = (await started.json()) as { session: { id: string; taskId: string | null; workerId: string | null } };
  expect(body.session.taskId).toBeNull();
  expect(body.session.workerId, '主会话要在假 ACP 机器上').toBe(workerId);

  return { projectId: project.id, workspaceId, sessionId: body.session.id, taskId, taskTitle, repoId, agentId };
}

function delegation(seed: Seed, over: Record<string, unknown> = {}) {
  return {
    id: 'del-confirmable',
    coordinatorSessionId: seed.sessionId,
    requestKey: 'req-提案-1',
    projectId: seed.projectId,
    taskId: seed.taskId,
    repoId: seed.repoId,
    workerId: 'worker-e2e',
    baseBranch: 'main',
    baseSha: 'b'.repeat(40),
    instructions: '把首页的空态文案改短一点，跑一次 typecheck',
    executionSessionId: 'exec-session-1',
    executionSessionExists: true,
    worktreePath: '/tmp/e2e-delegation-ws.delegation-abc',
    branch: 'delegation/abc123',
    state: 'prepared',
    failure: null,
    canConfirm: false,
    startup: { agentId: seed.agentId, model: '', profileId: null },
    createdAt: 1,
    updatedAt: 2,
    ...over
  };
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

test.use({ viewport: { width: 390, height: 844 } });

test('派工表单：失败重试只发一个 requestKey，请求体里没有选项杂物', async ({ page, baseURL }) => {
  await loginByApi(page);
  const h = await headers(page, baseURL);
  const seedValue = await seed(page, h);

  const bodies: Array<Record<string, unknown>> = [];
  await page.route('**/api/coordinators/*/delegations', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    bodies.push(JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>);
    if (bodies.length === 1) return json(route, { error: { code: 'internal', message: '假装失败' } }, 500);
    return json(route, { created: true, claimed: true, delegation: delegation(seedValue) }, 201);
  });

  await page.goto(`/#/p/${seedValue.projectId}/focus/${seedValue.sessionId}`);
  await page.getByRole('button', { name: '更多' }).click();
  await page.getByTestId('session-more-actions').click();
  await page.getByTestId('session-delegate').click();

  const dialog = page.getByTestId('delegate-dialog');
  await expect(dialog).toBeVisible();
  // 任务默认选中同项目里唯一那条；仓库是绑定的那个
  await expect(page.getByTestId('delegate-task')).toHaveValue(seedValue.taskId);
  await expect(page.getByTestId('delegate-repo')).toHaveValue(seedValue.repoId);
  await page.getByTestId('delegate-instructions').fill('把首页的空态文案改短一点，跑一次 typecheck');

  await page.getByTestId('delegate-submit').click();
  await expect(page.getByTestId('delegate-hint')).toContainText('假装失败');
  await page.getByTestId('delegate-submit').click();
  await expect(dialog).toHaveCount(0);

  expect(bodies).toHaveLength(2);
  expect(bodies[0]!.requestKey).toBe(bodies[1]!.requestKey);
  // 人写的部分逐项对上，且不许夹带 options（提议/确认阶段不回传选项）
  expect(bodies[1]!.taskId).toBe(seedValue.taskId);
  expect(bodies[1]!.repoId).toBe(seedValue.repoId);
  expect(bodies[1]!.baseBranch).toBe('main');
  expect(bodies[1]!.instructions).toBe('把首页的空态文案改短一点，跑一次 typecheck');
  expect('options' in bodies[1]!).toBe(false);
});

test('提议：只有服务端说 canConfirm 的才给确认按钮，确认只发这一条提议的 id', async ({ page, baseURL }) => {
  await loginByApi(page);
  const h = await headers(page, baseURL);
  const seedValue = await seed(page, h);

  const proposals = [
    delegation(seedValue, { id: 'del-waiting', requestKey: 'req-等提议', canConfirm: false, state: 'pending' }),
    delegation(seedValue, { id: 'del-confirmable', requestKey: 'req-可确认', canConfirm: true, state: 'pending' }),
    delegation(seedValue, { id: 'del-gone', requestKey: 'req-会话没了', canConfirm: false, state: 'prepared', executionSessionExists: false })
  ];
  await page.route('**/api/coordinators/*/delegations', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return json(route, { delegations: proposals });
  });

  const confirmed: Array<{ url: string; body: string | null }> = [];
  await page.route('**/api/coordinators/*/delegations/*/confirm', async (route) => {
    confirmed.push({ url: route.request().url(), body: route.request().postData() });
    return json(route, {
      created: false,
      claimed: true,
      delegation: delegation(seedValue, { id: 'del-confirmable', state: 'preparing', canConfirm: false })
    });
  });

  await page.goto(`/#/p/${seedValue.projectId}/focus/${seedValue.sessionId}`);
  const panel = page.getByTestId('delegation-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('delegation-row')).toHaveCount(3);

  // 等人确认 vs 等 Runtime 提议，说法要分开——不能把 pending 一律画成「可确认」
  const waiting = panel.locator('[data-delegation-id="del-waiting"]');
  const ready = panel.locator('[data-delegation-id="del-confirmable"]');
  const gone = panel.locator('[data-delegation-id="del-gone"]');
  await expect(gone.getByTestId('delegation-open')).toHaveCount(0);
  await expect(gone.getByTestId('delegation-publish-open')).toHaveCount(0);
  await expect(gone.getByTestId('delegation-execution-missing')).toContainText('先看任务记录');
  await expect(waiting.getByTestId('delegation-status')).toContainText('等待 Runtime 提议');
  await expect(waiting.getByTestId('delegation-confirm')).toHaveCount(0);
  await expect(ready.getByTestId('delegation-status')).toContainText('等你确认');
  // 人写的那几项：任务名、基线、说明、执行配置
  await expect(ready.getByTestId('delegation-task')).toHaveText(seedValue.taskTitle);
  await expect(ready.getByTestId('delegation-meta')).toContainText('基线 main');
  await expect(ready.getByTestId('delegation-meta')).toContainText('默认模型');
  await expect(ready.getByTestId('delegation-instructions')).toContainText('把首页的空态文案改短一点');

  await ready.getByTestId('delegation-confirm').click();
  await expect.poll(() => confirmed.length).toBe(1);
  const call = confirmed[0]!;
  // 精确到这条提议：路径里是它自己的 id，没有 query、没有 body（不重新组一遍派工参数）
  expect(call.url).toContain('/api/coordinators/');
  expect(call.url).toContain('/delegations/del-confirmable/confirm');
  expect(new URL(call.url).search).toBe('');
  expect(call.body === null || call.body === '').toBe(true);
});

test('发布：完整 SHA、必须勾选、同一次批准重试复用批准键，结果不明只对账', async ({ page, baseURL }) => {
  await loginByApi(page);
  const h = await headers(page, baseURL);
  const seedValue = await seed(page, h);

  const record = delegation(seedValue, { id: 'del-publish', state: 'prepared' });
  const submitted: Array<{ approvalKey: string; expectedHeadSha: string }> = [];
  await page.route('**/api/coordinators/*/delegations', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return json(route, { delegations: [record] });
  });

  // GET 跟着 POST 结果走：发布打断后重新读到的必须是「结果不明」，界面才会把发布按钮换成对账。
  let phase: 'ready' | 'uncertain' = 'ready';
  const attempt = {
    state: 'uncertain',
    headSha: SHA,
    remote: null,
    pullRequest: null,
    failure: null,
    createdAt: 3,
    updatedAt: 4
  };
  await page.route('**/api/workspace-delegations/*/publish', async (route) => {
    if (route.request().method() === 'GET') {
      return json(route, {
        delegationId: record.id,
        state: 'prepared',
        projectId: seedValue.projectId,
        taskId: seedValue.taskId,
        executionSessionId: record.executionSessionId,
        workerId: record.workerId,
        repo: 'e2e/demo',
        branch: record.branch,
        baseBranch: 'main',
        baseSha: record.baseSha,
        failure: null,
        headSha: SHA,
        headUnavailable: null,
        attempt: phase === 'uncertain' ? attempt : null,
        createdAt: 1,
        updatedAt: 2
      });
    }
    const body = JSON.parse(route.request().postData() ?? '{}') as { approvalKey: string; expectedHeadSha: string };
    submitted.push(body);
    phase = 'uncertain';
    // 服务端在这一步之后「结果不明」：界面只能给对账，不许再发一次
    return json(route, {
      delegationId: record.id,
      state: 'prepared',
      projectId: seedValue.projectId,
      taskId: seedValue.taskId,
      executionSessionId: record.executionSessionId,
      workerId: record.workerId,
      repo: 'e2e/demo',
      branch: record.branch,
      baseBranch: 'main',
      baseSha: record.baseSha,
      failure: null,
      headSha: SHA,
      headUnavailable: null,
      attempt,
      createdAt: 1,
      updatedAt: 2,
      attempted: true,
      replayed: false,
      reconciled: false
    });
  });

  const reconciled: Array<{ approvalKey: string }> = [];
  await page.route('**/api/workspace-delegations/*/reconcile', async (route) => {
    reconciled.push(JSON.parse(route.request().postData() ?? '{}') as { approvalKey: string });
    return json(route, { delegationId: record.id, state: 'prepared', reconciled: true });
  });

  await page.goto(`/#/p/${seedValue.projectId}/focus/${seedValue.sessionId}`);
  await page.getByTestId('delegation-publish-open').click();

  const dialog = page.getByTestId('delegation-publish');
  await expect(dialog).toBeVisible();
  // 完整 40 位、可选中；按钮在勾选前不能点
  await expect(page.getByTestId('publish-head')).toHaveText(SHA);
  await expect(page.getByTestId('publish-go')).toBeDisabled();
  await page.getByTestId('publish-confirm').check();
  const go = page.getByTestId('publish-go');
  await expect(go).toBeEnabled();
  await go.click();

  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0]!.expectedHeadSha).toBe(SHA);
  expect(submitted[0]!.approvalKey.trim().length).toBeGreaterThan(8);

  // 结果不明：发布按钮退场，只剩对账；对账复用同一把批准键
  await expect(page.getByTestId('publish-go')).toHaveCount(0);
  await expect(page.getByTestId('publish-outcome')).toContainText('结果不明');
  await page.getByTestId('publish-reconcile').click();
  await expect.poll(() => reconciled.length).toBe(1);
  expect(reconciled[0]!.approvalKey).toBe(submitted[0]!.approvalKey);
});

test('拿不到工作区 HEAD 时不给发布按钮，并说明原因', async ({ page, baseURL }) => {
  await loginByApi(page);
  const h = await headers(page, baseURL);
  const seedValue = await seed(page, h);

  const record = delegation(seedValue, { id: 'del-no-head', state: 'prepared' });
  await page.route('**/api/coordinators/*/delegations', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return json(route, { delegations: [record] });
  });
  await page.route('**/api/workspace-delegations/*/publish', async (route) =>
    json(route, {
      delegationId: record.id,
      state: 'prepared',
      projectId: seedValue.projectId,
      taskId: seedValue.taskId,
      executionSessionId: record.executionSessionId,
      workerId: record.workerId,
      repo: 'e2e/demo',
      branch: record.branch,
      baseBranch: 'main',
      baseSha: record.baseSha,
      failure: null,
      headSha: null,
      headUnavailable: '工作区不在这台机器上：先让 worker 同步工作目录',
      attempt: null,
      createdAt: 1,
      updatedAt: 2
    })
  );

  await page.goto(`/#/p/${seedValue.projectId}/focus/${seedValue.sessionId}`);
  await page.getByTestId('delegation-publish-open').click();

  await expect(page.getByTestId('delegation-publish')).toBeVisible();
  await expect(page.getByTestId('publish-head-missing')).toContainText('工作区不在这台机器上');
  await expect(page.getByTestId('publish-blocked')).toContainText('先让 worker 同步工作目录');
  await expect(page.getByTestId('publish-confirm')).toHaveCount(0);
  await expect(page.getByTestId('publish-go')).toBeDisabled();
});

test('发布：HEAD 换了就作废上次勾选，重新核对之前不能发', async ({ page, baseURL }) => {
  await loginByApi(page);
  const h = await headers(page, baseURL);
  const seedValue = await seed(page, h);

  const record = delegation(seedValue, { id: 'del-head-moved', state: 'prepared' });
  const SHA_OLD = 'a'.repeat(40);
  const SHA_NEW = 'b'.repeat(40);
  let headSha = SHA_OLD;
  let published: Record<string, unknown> | null = null;

  await page.route('**/api/coordinators/*/delegations', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return json(route, { delegations: [record] });
  });

  const view = () => ({
    delegationId: record.id,
    state: 'prepared',
    projectId: seedValue.projectId,
    taskId: seedValue.taskId,
    executionSessionId: record.executionSessionId,
    workerId: record.workerId,
    repo: 'e2e/demo',
    branch: record.branch,
    baseBranch: 'main',
    baseSha: record.baseSha,
    failure: null,
    headSha,
    headUnavailable: null,
    attempt: published,
    createdAt: 1,
    updatedAt: 2
  });

  const submitted: Array<{ approvalKey: string; expectedHeadSha: string }> = [];
  await page.route('**/api/workspace-delegations/*/publish', async (route) => {
    if (route.request().method() === 'GET') return json(route, view());
    submitted.push(JSON.parse(route.request().postData() ?? '{}') as { approvalKey: string; expectedHeadSha: string });
    if (submitted.length === 1) {
      // 核对之后工作区又提交了一次：服务端按 expectedHeadSha 拒掉，并让界面重新读 HEAD
      headSha = SHA_NEW;
      return json(route, { error: { code: 'head-moved', message: '工作区 HEAD 已经变了，重新核对再发' } }, 409);
    }
    published = { state: 'published', headSha, remote: null, pullRequest: null, failure: null, createdAt: 3, updatedAt: 4 };
    return json(route, { ...view(), attempted: true, replayed: false, reconciled: false });
  });

  await page.goto(`/#/p/${seedValue.projectId}/focus/${seedValue.sessionId}`);
  await page.getByTestId('delegation-publish-open').click();
  const dialog = page.getByTestId('delegation-publish');
  await expect(dialog).toBeVisible();

  await expect(page.getByTestId('publish-head')).toHaveText(SHA_OLD);
  await page.getByTestId('publish-confirm').check();
  await expect(page.getByTestId('publish-go')).toBeEnabled();
  await page.getByTestId('publish-go').click();

  // 失败后重新读到的提交已经不是刚才核对的那个
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0]!.expectedHeadSha).toBe(SHA_OLD);
  await expect(page.getByTestId('publish-failure')).toContainText('重新核对');
  await expect(page.getByTestId('publish-head')).toHaveText(SHA_NEW);

  // 旧勾选作废：新提交必须重新核对，按钮在此之前点不动，也不会偷偷补发一次
  await expect(page.getByTestId('publish-confirm')).not.toBeChecked();
  await expect(page.getByTestId('publish-head-changed')).toContainText(SHA_OLD.slice(0, 7));
  await expect(page.getByTestId('publish-go')).toBeDisabled();
  expect(submitted, '没重新核对之前不许再发').toHaveLength(1);

  // 重新核对之后可以发，带的是新 SHA；批准键也跟着换（一个键只对一个提交有效）
  await page.getByTestId('publish-confirm').check();
  await expect(page.getByTestId('publish-go')).toBeEnabled();
  await page.getByTestId('publish-go').click();
  await expect.poll(() => submitted.length).toBe(2);
  expect(submitted[1]!.expectedHeadSha).toBe(SHA_NEW);
  expect(submitted[1]!.approvalKey).not.toBe(submitted[0]!.approvalKey);
  await expect(page.getByTestId('publish-go')).toHaveCount(0);
});
