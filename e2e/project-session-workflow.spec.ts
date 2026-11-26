import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test, expect, type APIResponse, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { e2eWorkerPath, e2eWorkerRoots } from './isolation.ts';
import { GITHUB_ORIGIN, GITHUB_REPO, startGitOrigin, type GitOrigin } from './workspace-delegation-origin.ts';

/**
 * 设计文档 §38 的最小真实浏览器验收（不是权限单测）。
 *
 * 布局：
 *  - 同一个项目、同一台 remote Worker；
 *  - 来源是带真实 delegation 记录的执行会话（不是普通派生会话）；
 *  - 验收方是另一个独立 clone 上的长期任务会话；
 *  - 两个 prompt：先只审查汇报、不发消息，再把结构化 candidate 交给验收方；
 *  - 验收方显式获得 candidate:import 后，把精确 SHA 导入专用 ref；
 *  - 测试随后从该 ref checkout，并用真实 Chromium 打开提交里的文件，证明
 *    「导入的 SHA → 文件内容 → 浏览器行为」是一条可复现链，而不只是消息文本。
 *
 * 运行时是 ACP fixture（fake-agent.mjs --mcp-http），不是真实模型，也不需要凭据。
 * 诚实边界：checkout 和浏览器断言由测试在导入之后显式执行，不是 agent 自己 checkout 或跑测试；
 * fixture 只负责调用 handoff / candidate.import 工具。发布、部署和真实 GitHub 都不在范围内。
 *
 * 跑法（独立端口 + 全新数据目录）：
 *   E2E_PORT=7900 E2E_DATA_DIR=$(mktemp -d /tmp/agent-hub-e2e-workflow-XXXXXX) \
 *     npx playwright test e2e/project-session-workflow.spec.ts --reporter=list
 */
const FAKE = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');

type Entry = { seq: number; event?: { kind?: string; outcome?: string; delta?: string } };
type Part = { type?: string; schema?: string; data?: Record<string, unknown> };
type Message = {
  messageId: string;
  kind: string;
  status: string;
  from: string;
  to: string;
  body?: string;
  wake?: boolean;
  parts?: Part[];
};
type Observation = {
  action: string;
  names: string[];
  listError?: unknown;
  callError?: unknown;
  isError: boolean;
  text: string;
};
type Delegation = {
  id: string;
  state: string;
  worktreePath: string;
  branch: string;
  executionSessionId: string;
  baseSha: string;
};

async function openDetails(page: Page): Promise<void> {
  const panel = page.getByRole('complementary', { name: '会话详情' });
  if (await panel.isVisible().catch(() => false)) return;
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    await page.getByRole('button', { name: '更多' }).click();
    await page.getByTestId('session-more-details').click();
    await page.getByRole('menuitem', { name: /^详情/ }).click();
  } else {
    await page.getByRole('button', { name: '详情', exact: true }).click();
  }
  await expect(panel).toBeVisible();
}

async function openSession(page: Page, projectId: string, sessionId: string): Promise<void> {
  await page.goto(`/#/p/${projectId}/focus/${sessionId}`);
  await page.reload();
  await expect(page.getByRole('textbox', { name: '发送消息' })).toBeVisible();
}

async function sendPrompt(page: Page, text: string): Promise<void> {
  const box = page.getByRole('textbox', { name: '发送消息' });
  await box.fill(text);
  const send = page.locator('button[title="发送（⌘↵）"]');
  await expect(send).toBeEnabled();
  await send.click();
}

async function jsonResponse<T>(response: APIResponse, expected: number[], label: string): Promise<T> {
  const text = await response.text();
  expect(expected, `${label}：HTTP ${response.status()} ${text}`).toContain(response.status());
  return JSON.parse(text) as T;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', ...args],
    { cwd, encoding: 'utf8' }
  ).trim();
}

function branches(bare: string, root: string): string[] {
  return git(root, '--git-dir', bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

function snapshot(dir: string): { head: string; branch: string; status: string } {
  return {
    head: git(dir, 'rev-parse', 'HEAD'),
    branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    status: git(dir, 'status', '--porcelain')
  };
}

async function events(page: Page, sessionId: string): Promise<Entry[]> {
  const response = await page.request.get(`/api/sessions/${sessionId}/events`);
  return jsonResponse<Entry[]>(response, [200], '会话事件');
}

async function messages(page: Page, sessionId: string): Promise<Message[]> {
  const response = await page.request.get(`/api/sessions/${sessionId}/messages`);
  const body = await jsonResponse<{ messages?: Message[] }>(response, [200], '会话收件箱');
  return body.messages ?? [];
}

async function observations(page: Page, sessionId: string, action: string): Promise<Observation[]> {
  const found: Observation[] = [];
  for (const entry of await events(page, sessionId)) {
    if (entry.event?.kind !== 'text') continue;
    const text = entry.event.delta ?? '';
    const marker = text.indexOf('project-observation:');
    if (marker < 0) continue;
    try {
      const parsed = JSON.parse(text.slice(marker + 'project-observation:'.length)) as Observation;
      if (parsed.action === action && typeof parsed.text === 'string') found.push(parsed);
    } catch {
      // 文本块可能还在流式写入；下一轮会重读整段事件。
    }
  }
  return found;
}

async function waitObservation(page: Page, sessionId: string, action: string, count = 1): Promise<Observation> {
  let found: Observation[] = [];
  await expect.poll(async () => {
    found = await observations(page, sessionId, action);
    return found.length;
  }, { timeout: 120_000, message: `等不到第 ${count} 次 ${action} 观测` }).toBeGreaterThanOrEqual(count);
  return found[count - 1]!;
}

async function endedCount(page: Page, sessionId: string): Promise<number> {
  return (await events(page, sessionId)).filter((entry) => entry.event?.kind === 'ended' && entry.event.outcome === 'done').length;
}

async function enableScopes(page: Page, sessionId: string, scopes: string[]): Promise<void> {
  for (const scope of scopes) {
    const row = page.locator(`[data-testid="project-grant-row"][data-scope="${scope}"]`);
    await expect(row).toBeVisible();
    const toggle = row.getByTestId('project-grant-toggle');
    if (!(await toggle.isChecked())) {
      const saved = page.waitForResponse((response) =>
        response.url().includes(`/api/sessions/${sessionId}/project-tool-grant`) && response.request().method() === 'PUT'
      );
      await toggle.click();
      const response = await saved;
      expect(response.ok(), `授权 ${scope}：HTTP ${response.status()} ${await response.text()}`).toBe(true);
    }
    await expect(toggle).toBeChecked();
  }
}

async function workerState(page: Page, workerId: string): Promise<string | null> {
  const response = await page.request.get('/api/workers');
  const workers = await jsonResponse<Array<{ id?: string; workerId?: string; state: string }>>(response, [200], '机器列表');
  return workers.find((item) => (item.workerId ?? item.id) === workerId)?.state ?? null;
}

async function waitForWorker(page: Page, workerId: string, expected: 'online' | 'offline', timeout = 60_000): Promise<void> {
  await expect.poll(async () => {
    const state = await workerState(page, workerId);
    return expected === 'online' ? state === 'online' : state !== 'online';
  }, { timeout, message: `worker ${workerId} 没有在 ${timeout / 1000}s 内变成 ${expected}` }).toBe(true);
}

function stopWorker(child: ChildProcess | null): Promise<void> {
  return new Promise((resolve) => {
    if (child === null || child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function serveFile(file: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || (request.url !== '/' && request.url !== '/acceptance.html')) {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    try {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(readFileSync(file));
    } catch {
      response.statusCode = 500;
      response.end('read failed');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/acceptance.html`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

test('§38 组合验收：真实派工来源 → 结构化交接 → 验收方导入 → checkout 导入 SHA 跑浏览器断言（ACP fixture）', async ({ page, baseURL }) => {
  test.setTimeout(360_000);
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const tag = Date.now().toString(36);

  const root = mkdtempSync(join(tmpdir(), 'hub-e2e-workflow-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const source = join(root, 'source', 'demo');
  const receiverPath = join(root, 'receiver', 'demo');
  const bare = join(root, 'origin', `${GITHUB_REPO}.git`);
  mkdirSync(source, { recursive: true });
  mkdirSync(dirname(receiverPath), { recursive: true });
  mkdirSync(dirname(bare), { recursive: true });

  let worker: ChildProcess | null = null;
  let workerId = '';
  let origin: GitOrigin | null = null;
  let checkoutPath = '';

  try {
    // ── 真 bare + 两个独立 clone：同一个 HTTPS origin，repo-local 只信任本次运行的 CA ──
    git(source, 'init', '-q', '-b', 'main');
    writeFileSync(join(source, 'README.md'), '# demo\n');
    git(source, 'add', '.');
    git(source, 'commit', '-q', '-m', 'init');
    git(root, 'init', '-q', '--bare', '-b', 'main', bare);
    git(root, '--git-dir', bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    git(source, 'remote', 'add', 'origin', GITHUB_ORIGIN);
    git(source, 'push', '-q', bare, 'main');

    origin = await startGitOrigin(join(root, 'origin'), { workDir: join(root, 'tls') });
    const trustOrigin = (dir: string): void => {
      git(dir, 'config', 'http.proxy', `http://127.0.0.1:${origin!.port}`);
      git(dir, 'config', `http.https://github.com/e2e/demo.git.sslCAInfo`, origin!.caFile);
    };
    trustOrigin(source);

    git(root, 'clone', '-q', bare, receiverPath);
    git(receiverPath, 'remote', 'set-url', 'origin', GITHUB_ORIGIN);
    trustOrigin(receiverPath);
    const receiverBefore = snapshot(receiverPath);
    const bareBefore = branches(bare, root);

    // ── 真 remote Worker + 测试账号 ──
    const code = (await jsonResponse<{ code: string }>(
      await page.request.post('/api/workers/pairing', { data: {}, headers }),
      [200],
      '配对'
    )).code;
    const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
    const PATH = e2eWorkerPath();
    const label = `e2e 项目工作流 ${tag}`;
    const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], {
      env: { PATH, HOME: home, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label },
      encoding: 'utf8'
    });
    expect(enrolled.status, enrolled.stderr).toBe(0);
    const [enrolledWorkerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
    workerId = enrolledWorkerId;
    expect(workerId).not.toBe('');
    expect(credential).not.toBe('');

    worker = spawn(process.execPath, ['apps/worker/src/main.ts'], {
      env: {
        PATH,
        HOME: home,
        HUB_URL: hubUrl,
        HUB_WORKER_CREDENTIAL: credential,
        WORKER_ID: workerId,
        WORKER_ORIGIN: 'remote',
        WORKER_LABEL: label,
        WORKER_ROOTS: e2eWorkerRoots(),
        WORKER_STATE_DIR: home,
        WORKER_RUNTIMES_DIR: join(home, 'runtimes'),
        ACP_AGENTS: JSON.stringify([
          { id: 'fakeacp', label: '假 ACP', command: process.execPath, args: [FAKE, '--mcp-http'], listModelsArgs: [FAKE, '--models'] }
        ])
      },
      stdio: 'ignore'
    });
    await waitForWorker(page, workerId, 'online');

    // ── 项目 + 两个 link 工作空间 + 明确任务 ──
    const project = await jsonResponse<{ id: string }>(
      await page.request.post('/api/projects', { data: { name: `e2e 组合验收 ${tag}` }, headers }),
      [201],
      '建项目'
    );
    const patched = await jsonResponse<{ repos: { id: string }[] }>(
      await page.request.patch(`/api/projects/${project.id}`, {
        data: { repos: [{ name: 'demo', url: GITHUB_ORIGIN, defaultBranch: 'main' }] },
        headers
      }),
      [200],
      '设仓库'
    );
    const repoId = patched.repos[0]?.id ?? '';
    expect(repoId).not.toBe('');

    const sourceWorkspace = await jsonResponse<{ id: string; isGit: boolean; workerId: string | null }>(
      await page.request.post(`/api/projects/${project.id}/workspaces`, {
        data: { kind: 'long_lived', mode: 'link', path: source, workerId },
        headers
      }),
      [200, 201],
      '关联来源工作空间'
    );
    expect(sourceWorkspace.isGit).toBe(true);
    expect(sourceWorkspace.workerId).toBe(workerId);

    const receiverWorkspace = await jsonResponse<{ id: string; isGit: boolean; workerId: string | null }>(
      await page.request.post(`/api/projects/${project.id}/workspaces`, {
        data: { kind: 'long_lived', mode: 'link', path: receiverPath, workerId },
        headers
      }),
      [200, 201],
      '关联验收工作空间'
    );
    expect(receiverWorkspace.isGit).toBe(true);
    expect(receiverWorkspace.workerId).toBe(workerId);
    expect(receiverWorkspace.id).not.toBe(sourceWorkspace.id);

    const senderTask = await jsonResponse<{ id: string }>(
      await page.request.post('/api/tasks', { data: { projectId: project.id, title: `发送任务 ${tag}` }, headers }),
      [201],
      '建发送任务'
    );
    const receiverTask = await jsonResponse<{ id: string }>(
      await page.request.post('/api/tasks', { data: { projectId: project.id, title: `验收任务 ${tag}` }, headers }),
      [201],
      '建验收任务'
    );
    const sender = await jsonResponse<{ id: string; workspaceId: string | null; workerId: string | null }>(
      await page.request.post('/api/sessions/derive', {
        data: { taskId: senderTask.id, agentId: 'fakeacp', model: '', workspaceId: sourceWorkspace.id, workerId },
        headers
      }),
      [201],
      '派生发送会话'
    );
    const receiver = await jsonResponse<{ id: string; workspaceId: string | null; workerId: string | null }>(
      await page.request.post('/api/sessions/derive', {
        data: { taskId: receiverTask.id, agentId: 'fakeacp', model: '', workspaceId: receiverWorkspace.id, workerId },
        headers
      }),
      [201],
      '派生验收会话'
    );
    expect(sender.workspaceId).toBe(sourceWorkspace.id);
    expect(receiver.workspaceId).toBe(receiverWorkspace.id);
    expect(receiver.workerId).toBe(workerId);

    const coordinator = await jsonResponse<{ session: { id: string } }>(
      await page.request.post('/api/coordinators', {
        data: { projectId: project.id, workspaceId: sourceWorkspace.id, agentId: 'fakeacp', model: '' },
        headers
      }),
      [201],
      '建主会话'
    );
    const delegated = await jsonResponse<{ delegation: Delegation }>(
      await page.request.post(`/api/coordinators/${coordinator.session.id}/delegations`, {
        data: {
          requestKey: `workflow-source-${tag}`,
          taskId: senderTask.id,
          repoId,
          baseBranch: 'main',
          instructions: `§38 candidate ${tag}`,
          agentId: 'fakeacp',
          model: ''
        },
        headers
      }),
      [200, 201],
      '发起真实派工'
    );
    const delegation = delegated.delegation;
    expect(delegation.state).toBe('prepared');
    expect(delegation.worktreePath).not.toBe(receiverPath);
    expect(delegation.branch).toMatch(/^delegation\//);
    expect(delegation.executionSessionId).not.toBe('');

    // ── 候选提交：在派工 worktree 的分支上，未推送 ──
    writeFileSync(
      join(delegation.worktreePath, 'acceptance.html'),
      `<!doctype html><html><body><h1 id="acceptance">candidate-${tag}</h1><script>document.body.dataset.marker=${JSON.stringify(tag)}</script></body></html>\n`
    );
    git(delegation.worktreePath, 'add', 'acceptance.html');
    git(delegation.worktreePath, 'commit', '-q', '-m', `feat: acceptance ${tag}`);
    const candidateSha = git(delegation.worktreePath, 'rev-parse', 'HEAD');
    expect(candidateSha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(delegation.worktreePath, 'rev-parse', `refs/heads/${delegation.branch}`)).toBe(candidateSha);
    expect(branches(bare, root)).not.toContain(delegation.branch);
    expect(() => git(root, '--git-dir', bare, 'cat-file', '-e', candidateSha)).toThrow();

    // ── Prompt 1：只审查汇报，不调用交接；两次显式授权触发登录令牌刷新，但不重启 Worker ──
    await openSession(page, project.id, sender.id);
    await openDetails(page);
    await enableScopes(page, sender.id, ['message:send', 'project:read']);
    const senderGrant = await jsonResponse<{ grant: { scopes: string[] } | null }>(
      await page.request.get(`/api/sessions/${sender.id}/project-tool-grant`),
      [200],
      '发送方授权'
    );
    expect([...(senderGrant.grant?.scopes ?? [])].sort()).toEqual(['message:send', 'project:read']);

    const senderLog = page.getByRole('log', { name: '会话记录' });
    await sendPrompt(page, '请只审查当前改动并在这里汇报结论，不要给验收会话发消息。');
    await expect(senderLog).toContainText('methods:', { timeout: 120_000 });
    await expect.poll(async () => endedCount(page, sender.id), { timeout: 120_000 }).toBe(1);
    expect(await messages(page, receiver.id)).toEqual([]);

    // ── Prompt 2：结构化 candidate 交接；验收方收件箱收到 project-candidate/v1 ──
    await sendPrompt(
      page,
      `please-project-handoff key=handoff-${tag} target=${receiver.id} body=handoff-${tag} candidate_source=${delegation.executionSessionId} candidate_repo=${repoId} candidate_sha=${candidateSha}`
    );
    const handoffObservation = await waitObservation(page, sender.id, 'handoff');
    expect(handoffObservation.isError, handoffObservation.text).toBe(false);
    expect(handoffObservation.names).toContain('project_session_handoff');
    const handoffResult = JSON.parse(handoffObservation.text) as { targetSessionId: string; status: string; wake: boolean };
    expect(handoffResult.targetSessionId).toBe(receiver.id);
    expect(handoffResult.status).toBe('done');
    expect(handoffResult.wake).toBe(false);
    await expect.poll(async () => endedCount(page, sender.id), { timeout: 120_000 }).toBe(2);

    let handoffMessage: Message | undefined;
    await expect.poll(async () => {
      handoffMessage = (await messages(page, receiver.id)).find((message) => message.body === `handoff-${tag}`);
      return handoffMessage !== undefined;
    }, { timeout: 60_000 }).toBe(true);
    expect(handoffMessage!.wake).toBe(false);
    const parts = Array.isArray(handoffMessage!.parts) ? handoffMessage!.parts : [];
    const notice = parts.find((part) => part.schema === 'project-candidate/v1');
    expect(notice?.data?.sha).toBe(candidateSha);
    expect(notice?.data?.sourceSessionId).toBe(delegation.executionSessionId);
    expect(notice?.data?.repoId).toBe(repoId);
    expect(notice?.data?.projectId).toBe(project.id);
    expect(typeof notice?.data?.notice).toBe('string');

    // 交接本身绝不能触发导入。
    expect(git(receiverPath, 'for-each-ref', '--format=%(refname)', 'refs/agent-hub/imports')).toBe('');
    expect(snapshot(receiverPath)).toEqual(receiverBefore);

    // 验收方在真实 UI 里看到结构化交接，但默认不唤醒。
    await openSession(page, project.id, receiver.id);
    await openDetails(page);
    const inboxPanel = page.getByRole('complementary', { name: '会话详情' });
    const handoffRow = inboxPanel.getByTestId('agent-message-row').filter({ hasText: `handoff-${tag}` });
    await expect(handoffRow).toBeVisible();
    await expect(handoffRow.getByTestId('agent-message-quiet')).toContainText('不唤醒');

    // ── 验收方独立授权 candidate:import；第二次 PUT 扩大范围时替换旧 bearer ──
    await enableScopes(page, receiver.id, ['candidate:import', 'project:read']);
    const receiverGrant = await jsonResponse<{ grant: { scopes: string[] } | null }>(
      await page.request.get(`/api/sessions/${receiver.id}/project-tool-grant`),
      [200],
      '验收方授权'
    );
    expect([...(receiverGrant.grant?.scopes ?? [])].sort()).toEqual(['candidate:import', 'project:read']);

    await sendPrompt(
      page,
      `please-project-import key=import-${tag} source=${delegation.executionSessionId} target=${receiver.id} repo=${repoId} sha=${candidateSha}`
    );
    const importObservation = await waitObservation(page, receiver.id, 'candidate.import');
    expect(importObservation.isError, importObservation.text).toBe(false);
    expect(importObservation.names).toContain('project_candidate_import');
    const imported = JSON.parse(importObservation.text) as { ref: string; sha: string; alreadyPresent: boolean; targetSessionId: string };
    const expectedRef = `refs/agent-hub/imports/${receiver.id}/${candidateSha}`;
    expect(imported).toEqual({ ref: expectedRef, sha: candidateSha, alreadyPresent: false, targetSessionId: receiver.id });
    expect(git(receiverPath, 'rev-parse', '--verify', expectedRef)).toBe(candidateSha);
    expect(git(receiverPath, 'cat-file', '-t', candidateSha)).toBe('commit');

    // 导入只写专用 ref，不 checkout、不建分支、不推远端。
    expect(snapshot(receiverPath)).toEqual(receiverBefore);
    expect(existsSync(join(receiverPath, 'acceptance.html'))).toBe(false);
    expect(branches(bare, root)).toEqual(bareBefore);
    expect(() => git(root, '--git-dir', bare, 'cat-file', '-e', candidateSha)).toThrow();

    // ── 测试显式从导入 ref checkout；用真实 Chromium 执行提交里的文件 ──
    checkoutPath = join(root, 'acceptance-checkout');
    git(receiverPath, 'worktree', 'add', '--detach', checkoutPath, expectedRef);
    expect(git(checkoutPath, 'rev-parse', 'HEAD')).toBe(candidateSha);
    const checkedOutHtml = readFileSync(join(checkoutPath, 'acceptance.html'), 'utf8');
    expect(checkedOutHtml).toContain(`candidate-${tag}`);

    const harness = await serveFile(join(checkoutPath, 'acceptance.html'));
    try {
      const acceptance = await page.context().newPage();
      await acceptance.goto(harness.url);
      await expect(acceptance.locator('#acceptance')).toHaveText(`candidate-${tag}`);
      await expect.poll(() => acceptance.evaluate(() => document.body.dataset.marker)).toBe(tag);
      await acceptance.close();
    } finally {
      await harness.close();
    }

    test.info().annotations.push(
      { type: 'runtime', description: 'ACP fixture fake-agent.mjs --mcp-http；不是真实模型；本地 Hub/Worker；本机 HTTPS git origin；无凭据' },
      { type: 'delegation', description: `${delegation.id} ${delegation.branch}` },
      { type: 'head', description: candidateSha },
      {
        type: 'limitation',
        description: '候选导入只写 refs/agent-hub/imports/...；checkout 与浏览器断言由测试在导入后显式执行，不是 agent 自己跑测试；fixture 不 checkout/执行提交；没有发布或部署。'
      }
    );
  } finally {
    if (checkoutPath !== '' && existsSync(checkoutPath)) {
      try {
        git(receiverPath, 'worktree', 'remove', '--force', checkoutPath);
      } catch {
        // 清理失败不覆盖真正的断言结果。
      }
    }
    await stopWorker(worker);
    if (workerId !== '') {
      await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
    }
    if (origin !== null) await origin.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
