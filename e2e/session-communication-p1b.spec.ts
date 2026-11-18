import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { piModel } from './hub-model.ts';

/**
 * 会话通信 P1b · 一仓一会话（docs/design/session-communication.md §12 P1b）：
 * 开会话带 repoId → 只为那个仓开隔离 worktree；带 handle / linkWith → 建好就有短名、和对方连上能互发消息；
 * E2E_REAL=1 时再让真模型用 agent.spawn（repo_id + handle）派一条会话，派出来自动和自己连线。
 */
const REAL = process.env['E2E_REAL'] === '1';
type Peer = { address: string; handle: string; repo: string | null; branch: string | null; connected?: boolean };

function makeRepo(root: string, name: string, url: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e', 'commit', '-q', '--allow-empty', '-m', 'init');
  git('remote', 'add', 'origin', url);
  return dir;
}

async function world(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  let agentId: string | undefined;
  for (let i = 0; i < 40 && !agentId; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((worker) => worker.state === 'online')?.agentIds[0];
    if (!agentId) await page.waitForTimeout(500);
  }
  test.skip(!agentId, '这台机器上没有可用的 agent');
  const root = mkdtempSync(join(tmpdir(), 'e2e-p1b-'));
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot, { recursive: true });
  const repos = [
    { name: 'web', url: 'https://example.invalid/acme/web.git' },
    { name: 'api', url: 'https://example.invalid/acme/api.git' }
  ];
  const dirs = repos.map((repo) => makeRepo(join(root, 'repos'), repo.name, repo.url));
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 一仓一会话 ${Date.now().toString(36)}`, rootPath: projectRoot }, headers })).json()) as { id: string };
  const patched = await page.request.patch(`/api/projects/${project.id}`, { data: { repos: repos.map((repo) => ({ ...repo, defaultBranch: 'main' })) }, headers });
  expect(patched.status(), await patched.text()).toBe(200);
  const view = (await patched.json()) as { repos: Array<{ id: string; name: string }> };
  const web = view.repos.find((repo) => repo.name === 'web')!;
  const api = view.repos.find((repo) => repo.name === 'api')!;
  expect((await page.request.patch(`/api/projects/${project.id}`, { data: { primaryRepoId: web.id }, headers })).status()).toBe(200);
  for (const [index, repo] of repos.entries()) {
    const linked = await page.request.post('/api/workspaces', { data: { workerId: null, mode: 'link', path: dirs[index], repoUrl: repo.url, branch: 'main', name: repo.name, projectId: project.id }, headers });
    expect(linked.status(), await linked.text()).toBe(201);
  }
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '一仓一会话' }, headers })).json()) as { id: string };
  const derive = (data: Record<string, unknown>) => page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: piModel(), ...data }, headers });
  const peers = async (id: string): Promise<Peer[]> => ((await (await page.request.get(`/api/sessions/${id}/peers`)).json()) as { peers: Peer[] }).peers;
  const worktrees = (dir: string) => execFileSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  return { headers, project: project.id, task: task.id, web, api, dirs, derive, peers, worktrees };
}

test('P1b：repoId 一仓一会话（各自的 worktree）；handle + linkWith 建好就连上；重名 409、仓库不在项目里 400、linkWith 不存在 404', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const w = await world(page, baseURL!);
  const dev = await w.derive({ repoId: w.web.id, handle: 'dev' });
  expect(dev.status(), await dev.text()).toBe(201);
  const devId = ((await dev.json()) as { id: string }).id;
  expect(w.worktrees(w.dirs[0]!)).toMatch(/\.worktrees\/web\//);
  expect(w.worktrees(w.dirs[0]!)).toMatch(/branch refs\/heads\/agent-hub\/web-/);
  expect(w.worktrees(w.dirs[1]!), '只开了 web 仓').not.toMatch(/\.worktrees/);

  const verify = await w.derive({ repoId: 'api', handle: 'verify', linkWith: [devId] });
  expect(verify.status(), await verify.text()).toBe(201);
  const verifyId = ((await verify.json()) as { id: string }).id;
  expect(w.worktrees(w.dirs[1]!)).toMatch(/\.worktrees\/api\//);

  const fromDev = await w.peers(devId);
  expect(fromDev.map((p) => [p.address, p.handle, p.connected ?? false])).toEqual([[`session:${verifyId}`, 'verify', true]]);
  expect(fromDev[0]!.branch ?? '').toMatch(/^agent-hub\/api-/);
  expect((await w.peers(verifyId)).map((p) => p.handle)).toEqual(['dev']);

  // 连上就能直接发（不唤醒，免得起一轮）
  const sent = await page.request.post(`/api/sessions/${devId}/messages`, { data: { kind: 'send', to: 'peer:verify', body: 'api 分支准备好了吗？', wake: false }, headers: w.headers });
  expect(sent.status(), await sent.text()).toBe(201);

  expect((await w.derive({ handle: 'dev' })).status(), '同任务内短名重复').toBe(409);
  expect((await w.derive({ handle: 'Bad Name' })).status()).toBe(400);
  expect((await w.derive({ repoId: 'nope' })).status()).toBe(400);
  expect((await w.derive({ repoId: 'api', workspaceId: 'ws-x' })).status()).toBe(400);
  expect((await w.derive({ linkWith: ['no-such-session'] })).status()).toBe(404);
});

test('真模型（P1b）：agent.spawn 带 repo_id + handle 派出一条会话，派出来自动和自己连线', async ({ page, baseURL }) => {
  test.skip(!REAL, '要真模型（E2E_REAL=1）');
  test.setTimeout(300_000);
  const w = await world(page, baseURL!);
  const lead = await w.derive({ repoId: 'web', handle: 'lead' });
  expect(lead.status(), await lead.text()).toBe(201);
  const leadId = ((await lead.json()) as { id: string }).id;
  const prompt = [
    '请调用 agent.spawn 工具（不要用别的方式），参数：',
    'repo_id = "api"',
    'handle = "helper"',
    '不要给 prompt 参数。调用成功后直接结束这一轮，不要做别的。'
  ].join('\n');
  const prompted = await page.request.post(`/api/sessions/${leadId}/prompt`, { data: { text: prompt, attachments: [] }, headers: w.headers });
  expect(prompted.ok(), await prompted.text()).toBe(true);
  await expect.poll(async () => (await w.peers(leadId)).map((p) => p.handle), { timeout: 240_000, intervals: [3000] }).toContain('helper');
  const helper = (await w.peers(leadId)).find((p) => p.handle === 'helper')!;
  expect(helper.connected).toBe(true);
  expect(helper.branch ?? '').toMatch(/^agent-hub\/api-/);
  expect(w.worktrees(w.dirs[1]!)).toMatch(/\.worktrees\/api\//);
});
