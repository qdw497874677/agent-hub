import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { e2eWorkerPath, e2eWorkerRoots } from './isolation.ts';

/**
 * ADR 0027 阶段 2：提交 / 推送 / 开 PR，整条真路径——
 * 远端 Worker + 假 ACP agent 真的写文件；origin 叫 https://github.com/e2e/demo.git，
 * 但 git 的 insteadOf 把它指到本地 bare 仓库（推送真落地，不碰 GitHub）；
 * PR 三条路：团队 token（假 GitHub API）→ Worker 的 gh（PATH 里的假 gh）→ 只推送 + 链接。
 */
const SHOTS = '/workspace/shots/git-workflow/2-commit-push-pr';
const FAKE = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');
const TOKEN = 'ghp_e2eFakeToken000000000000000000ABCD';

type Seen = { method: string; url: string; auth: string; body: string };
function fakeGitHub(seen: Seen[]): Promise<Server> {
  const body = (req: IncomingMessage) => new Promise<string>((done) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => done(text));
  });
  const server = createServer(async (req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', auth: String(req.headers['authorization'] ?? ''), body: await body(req) });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/repos/e2e/demo/pulls') {
      res.statusCode = 201;
      res.end(JSON.stringify({ number: 41, html_url: 'https://github.com/e2e/demo/pull/41', state: 'open', head: { sha: 'x' }, merged_at: null }));
      return;
    }
    if (req.method === 'GET' && req.url === '/repos/e2e/demo/pulls/41') {
      res.end(JSON.stringify({ number: 41, html_url: 'https://github.com/e2e/demo/pull/41', state: 'closed', head: { sha: 'x' }, merged_at: '2026-11-01T00:00:00Z' }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'Not Found' }));
  });
  return new Promise((done) => server.listen(17982, '127.0.0.1', () => done(server)));
}

async function waitTurns(page: Page, sid: string, count: number): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const turns = ((await (await page.request.get(`/api/sessions/${sid}/git/turns`)).json()) as { turns?: { after: string | null }[] }).turns ?? [];
    if (turns.length >= count && turns.every((t) => t.after !== null)) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`等不到 ${count} 轮检查点`);
}

test('提交 / 推送 / 开 PR：token → gh → 链接；推送真落到 bare 仓库；token 只回末 4 位', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  const seen: Seen[] = [];
  const github = await fakeGitHub(seen);
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const me = (await (await page.request.get('/api/auth/state')).json()) as { user?: { displayName?: string; email?: string } };
  const pairing = await page.request.post('/api/workers/pairing', { data: {}, headers });
  expect(pairing.ok()).toBe(true);
  const code = ((await pairing.json()) as { code: string }).code;
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-git-'));
  // 假 gh：create 打印 PR 链接，view 打印 JSON；有 gh-broken 标记文件就失败
  const bin = join(state, 'bin');
  mkdirSync(bin);
  const broken = join(state, 'gh-broken');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nif [ -e "${broken}" ]; then echo "gh: not logged in" >&2; exit 1; fi\nif [ "$2" = "create" ]; then echo "https://github.com/e2e/demo/pull/42"; exit 0; fi\necho '{"number":42,"url":"https://github.com/e2e/demo/pull/42","state":"OPEN","headRefOid":"y","mergedAt":null}'\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const PATH = e2eWorkerPath(bin);
  const label = `e2e git 机器 ${Date.now().toString(36)}`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], { env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label }, encoding: 'utf8' });
  expect(enrolled.status).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');

  const dir = mkdtempSync(join(tmpdir(), 'e2e-git-repo-'));
  const bare = `${dir}-origin.git`;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@x', ...args], { cwd, encoding: 'utf8' });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  git(dir, 'remote', 'add', 'origin', 'https://github.com/e2e/demo.git');
  git(dir, 'config', `url.${bare}.insteadOf`, 'https://github.com/e2e/demo.git');
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'remote', 'set-head', 'origin', 'main');
  git(dir, 'checkout', '-qb', 'feat/e2e-git');
  let worker: ChildProcess | null = null;
  try {
    worker = spawn(process.execPath, ['apps/worker/src/main.ts'], {
      env: {
        PATH, HOME: state, HUB_URL: hubUrl, HUB_WORKER_CREDENTIAL: credential, WORKER_ID: workerId, WORKER_ORIGIN: 'remote', WORKER_LABEL: label,
        WORKER_ROOTS: e2eWorkerRoots(), WORKER_STATE_DIR: state, WORKER_RUNTIMES_DIR: join(state, 'runtimes'), WORKER_MODEL_CHECK: '0',
        ACP_AGENTS: JSON.stringify([{ id: 'fakeacp', label: '假 ACP', command: process.execPath, args: [FAKE], listModelsArgs: [FAKE, '--models'] }])
      },
      stdio: 'ignore'
    });
    for (let i = 0; i < 60; i++) {
      const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ id?: string; workerId?: string; state: string }>;
      if (workers.some((w) => (w.workerId ?? w.id) === workerId && w.state === 'online')) break;
      await page.waitForTimeout(500);
    }
    const project = (await (await page.request.post('/api/projects', { data: { name: `e2e git ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers })).json()) as { id: string };
    const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '给 demo 加 a.txt' }, headers })).json()) as { id: string };
    const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: 'fakeacp', model: '' }, headers });
    expect(derived.ok(), await derived.text()).toBe(true);
    const sid = ((await derived.json()) as { id: string }).id;
    const prompt = async (text: string, n: number) => {
      const r = await page.request.post(`/api/sessions/${sid}/prompt`, { data: { text }, headers });
      expect(r.ok(), await r.text()).toBe(true);
      await waitTurns(page, sid, n);
    };
    await prompt('please-write:a.txt=one', 1);

    // 状态：功能分支 + GitHub origin → 能开 PR；没 token → 走 gh
    const st = (await (await page.request.get(`/api/sessions/${sid}/git/state`)).json()) as { branch: string; repo: string; prBlocked: string | null; prVia: string; files: { path: string }[]; canPush: boolean };
    expect(st).toMatchObject({ branch: 'feat/e2e-git', repo: 'e2e/demo', prBlocked: null, prVia: 'gh', canPush: true });
    expect(st.files.map((f) => f.path)).toEqual(['a.txt']);

    // 团队 token：保存后只回末 4 位，绝不回全文
    const put = await page.request.put('/api/git-host/token', { data: { token: TOKEN }, headers });
    expect(put.ok(), await put.text()).toBe(true);
    const status = await (await page.request.get('/api/git-host/token')).text();
    expect(status).not.toContain(TOKEN.slice(0, 20));
    expect(JSON.parse(status)).toMatchObject({ configured: true, last4: 'ABCD' });

    // 界面：「改了 1 个文件」标记 + 提交与推送对话框（模板起草的说明，可改）
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 860 : 844 });
      await page.goto(`/#/p/${project.id}/focus/${sid}`);
      await page.reload();
      await expect(page.getByTestId('turn-badge').first()).toContainText('改了 1 个文件');
      await page.screenshot({ path: join(SHOTS, `turn-badge-${width}.png`) });
      await page.getByRole('button', { name: /更多/ }).first().click();
      await page.getByText('提交与推送…').click();
      const dialog = page.getByTestId('git-dialog');
      await expect(dialog.getByTestId('git-files')).toContainText('a.txt');
      await expect(dialog.getByTestId('git-message')).not.toHaveValue('');
      await expect(dialog.getByTestId('git-pr-title')).toHaveValue(/a\.txt|demo/);
      await page.screenshot({ path: join(SHOTS, `dialog-${width}.png`) });
      if (width === 390) {
        await dialog.getByTestId('git-message').fill('feat: 加 a.txt\n\n由 e2e 提交');
        await dialog.getByTestId('git-pr').click();
        await expect(dialog.getByTestId('git-result-pr')).toHaveText('#41');
        await page.screenshot({ path: join(SHOTS, `pr-token-${width}.png`) });
      } else {
        await page.keyboard.press('Escape');
      }
    }
    // token 路径：假 GitHub 收到了带 token 的开 PR 请求；bare 仓库真收到了提交，作者是当前用户
    const created = seen.find((s) => s.method === 'POST');
    expect(created?.auth).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(created!.body)).toMatchObject({ head: 'feat/e2e-git', base: 'main' });
    expect(git(bare, 'log', '-1', '--format=%s', 'feat/e2e-git').trim()).toBe('feat: 加 a.txt');
    const author = git(bare, 'log', '-1', '--format=%ae', 'feat/e2e-git').trim();
    if (me.user?.email) expect(author).toBe(me.user.email);
    // PR 挂在任务上，工作日志里有链接，PR 小标签出现
    const prs = (await (await page.request.get(`/api/tasks/${task.id}/pull-requests`)).json()) as { pullRequests: { number: number; via: string }[] };
    expect(prs.pullRequests.map((p) => [p.number, p.via])).toEqual([[41, 'token']]);
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.getByTestId('pr-chip').first()).toContainText('PR #41');
    await page.screenshot({ path: join(SHOTS, `pr-chip-390.png`) });
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.screenshot({ path: join(SHOTS, `pr-chip-1280.png`) });

    // gh 路径：删掉 token，再改一轮，用 Worker 上的 gh 开
    expect((await page.request.delete('/api/git-host/token', { headers })).ok()).toBe(true);
    expect(((await (await page.request.get('/api/git-host/token')).json()) as { configured: boolean }).configured).toBe(false);
    await prompt('please-write:b.txt=two', 2);
    const viaGh = (await (await page.request.post(`/api/sessions/${sid}/git/run`, { data: { action: 'pr', message: 'feat: b', title: '加 b' }, headers })).json()) as { pullRequest: { number: number; via: string } | null; pushed: boolean };
    expect(viaGh.pushed).toBe(true);
    expect(viaGh.pullRequest).toMatchObject({ number: 42, via: 'gh' });

    // 两条都不通：只推送，给「去 GitHub 新建」链接
    writeFileSync(broken, '1');
    await prompt('please-write:c.txt=three', 3);
    const link = (await (await page.request.post(`/api/sessions/${sid}/git/run`, { data: { action: 'pr', message: 'feat: c', title: '加 c' }, headers })).json()) as { pullRequest: unknown; pushed: boolean; compareUrl: string | null; notes: string[] };
    expect(link.pushed).toBe(true);
    expect(link.pullRequest).toBeNull();
    expect(link.compareUrl).toBe('https://github.com/e2e/demo/compare/main...feat%2Fe2e-git?expand=1');
    expect(git(bare, 'log', '-1', '--format=%s', 'feat/e2e-git').trim()).toBe('feat: c');

    // 只提交：在默认分支上不许开 PR
    git(dir, 'checkout', '-q', 'main');
    const onMain = (await (await page.request.get(`/api/sessions/${sid}/git/state`)).json()) as { prBlocked: string | null };
    expect(onMain.prBlocked).toMatch(/默认分支/);
    expect(existsSync(join(dir, '.git'))).toBe(true);
  } finally {
    worker?.kill();
    github.close();
    await page.request.delete('/api/git-host/token', { headers }).catch(() => undefined);
    await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
    rmSync(state, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});
