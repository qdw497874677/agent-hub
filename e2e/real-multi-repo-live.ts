/**
 * 手工真实场景（t436u），不进默认 `npm run e2e`（文件名不是 *.spec.ts）。
 * 需已启动隔离 Hub，并设置 E2E_HUB_MODEL=hub-cn-glm-flash/glm-5.3-flash 与测试进程里的 ZAI_CODING_CN_API_KEY。
 * 只使用 Hub 管理的 glm-5.3-flash / Pi，不走 Go。
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { piModel } from './hub-model.ts';

const BASE = 'http://127.0.0.1:17998';
const SHOTS = '/workspace/agent-hub-multirepo/docs/design/multi-repo-mvp';
const EVIDENCE = '/tmp/real-multi-repo/evidence.json';
const TOKEN = 'ghp_e2eFakeToken000000000000000000ABCD';

type Step = { step: string; pass: boolean; detail: string };
const steps: Step[] = [];
function record(step: string, pass: boolean, detail: string) {
  steps.push({ step, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${step}  ${detail}`);
}

type Pr = { number: number; repo: string; state: 'open' | 'merged'; sha: string; url: string };
function startFakeGithub(): { server: Server; prs: Pr[]; setMerged: () => void } {
  const prs: Pr[] = [];
  let next = 101;
  const merged = { on: false };
  const read = (req: IncomingMessage) =>
    new Promise<string>((done) => {
      let text = '';
      req.on('data', (c) => (text += c));
      req.on('end', () => done(text));
    });
  const server = createServer(async (req, res) => {
    const body = await read(req);
    const url = req.url ?? '';
    res.setHeader('content-type', 'application/json');
    const create = /^\/repos\/e2e\/([^/]+)\/pulls$/.exec(url);
    if (req.method === 'POST' && create) {
      const repo = create[1]!;
      const number = next++;
      const parsed = body ? (JSON.parse(body) as { head?: string }) : {};
      const pr: Pr = {
        number,
        repo,
        state: 'open',
        sha: 'pending',
        url: `https://github.com/e2e/${repo}/pull/${number}`
      };
      prs.push(pr);
      res.statusCode = 201;
      res.end(JSON.stringify({ number, html_url: pr.url, state: 'open', head: { sha: pr.sha, ref: parsed.head }, merged_at: null }));
      return;
    }
    const view = /^\/repos\/e2e\/([^/]+)\/pulls\/(\d+)$/.exec(url);
    if (req.method === 'GET' && view) {
      const pr = prs.find((item) => item.repo === view[1] && item.number === Number(view[2]));
      if (!pr) {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: 'Not Found' }));
        return;
      }
      const state = merged.on ? 'closed' : pr.state === 'merged' ? 'closed' : 'open';
      res.end(JSON.stringify({
        number: pr.number,
        html_url: pr.url,
        state,
        head: { sha: pr.sha },
        merged_at: merged.on || pr.state === 'merged' ? '2026-11-18T16:00:00Z' : null
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'Not Found' }));
  });
  return {
    server,
    prs,
    setMerged: () => {
      merged.on = true;
      for (const pr of prs) pr.state = 'merged';
    }
  };
}

function sh(cwd: string, ...args: string[]) {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'e2e',
      GIT_AUTHOR_EMAIL: 'e2e@example.invalid',
      GIT_COMMITTER_NAME: 'e2e',
      GIT_COMMITTER_EMAIL: 'e2e@example.invalid'
    }
  });
}

function makeOrigin(root: string, name: string, writeSeed: (seed: string) => void): { bare: string; dir: string; url: string } {
  const seed = join(root, `${name}-seed`);
  mkdirSync(seed, { recursive: true });
  sh(seed, 'init', '-q', '-b', 'main');
  writeSeed(seed);
  sh(seed, 'add', '.');
  sh(seed, 'commit', '-qm', `init ${name}`);
  const bare = join(root, `${name}.git`);
  sh(root, 'clone', '-q', '--bare', seed, bare);
  const dir = join(root, name);
  execFileSync('git', ['clone', '-q', bare, dir], { stdio: 'ignore' });
  const url = `https://github.com/e2e/${name}.git`;
  sh(dir, 'remote', 'set-url', 'origin', url);
  sh(dir, 'config', `url.${bare}.insteadOf`, url);
  sh(dir, 'remote', 'set-head', 'origin', 'main');
  return { bare, dir, url };
}

async function headersOf(page: Page, origin: string) {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  return { origin, 'x-hub-csrf': csrf };
}

async function waitOnlineAgent(page: Page): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    const local = workers.find((worker) => worker.state === 'online' && worker.agentIds.includes('pi'));
    if (local) return 'pi';
    await page.waitForTimeout(500);
  }
  throw new Error('本机 worker 没有上线，或没有 Pi');
}

async function waitFiles(paths: string[], timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (paths.every((path) => existsSync(path))) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`等不到文件：${paths.filter((path) => !existsSync(path)).join(', ')}`);
}

function writeEvidence() {
  writeFileSync(EVIDENCE, `${JSON.stringify({ at: new Date().toISOString(), steps }, null, 2)}\n`);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const github = startFakeGithub();
  await new Promise<void>((done) => github.server.listen(17983, '127.0.0.1', done));

  const browser = await chromium.launch({ executablePath: process.env['E2E_CHROME'] ?? '/usr/bin/google-chrome', headless: true });
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  try {
    await loginByApi(page);
    const headers = await headersOf(page, BASE);

    const root = mkdtempSync(join(tmpdir(), 'real-combo-'));
    const origins = {
      web: makeOrigin(root, 'web', (seed) => {
        writeFileSync(
          join(seed, 'AGENTS.md'),
          [
            '# web 主仓库说明',
            '',
            '这是组合工作空间的主仓库（cwd）。附加仓 api 在 `../repos/api`。',
            '如果用户请你留一份说明：',
            '- 在本仓库根目录创建 `NOTE.md`，写一行「primary note from agents.md」',
            '- 在 `../repos/api/NOTE.md` 写一行「api note from agents.md」',
            '- 不要改其他文件，不要提交。',
            ''
          ].join('\n')
        );
        mkdirSync(join(seed, '.agents'), { recursive: true });
        writeFileSync(join(seed, '.agents/setup'), '#!/bin/sh\necho setup-ok > SETUP_OK\n');
        chmodSync(join(seed, '.agents/setup'), 0o755);
        writeFileSync(join(seed, 'README.md'), '# web\n');
      }),
      api: makeOrigin(root, 'api', (seed) => writeFileSync(join(seed, 'README.md'), '# api\n')),
      docs: makeOrigin(root, 'docs', (seed) => writeFileSync(join(seed, 'README.md'), '# docs\n'))
    };

    const projectRoot = join(root, 'project');
    mkdirSync(projectRoot, { recursive: true });
    const created = await page.request.post('/api/projects', {
      data: { name: `real combo ${Date.now().toString(36)}`, rootPath: projectRoot },
      headers
    });
    if (created.status() !== 201 && created.status() !== 200) throw new Error(`建项目失败：${created.status()} ${await created.text()}`);
    const project = (await created.json()) as { id: string };
    const repos = [
      { name: 'web', url: origins.web.url, defaultBranch: 'main' },
      { name: 'api', url: origins.api.url, defaultBranch: 'main' },
      { name: 'docs', url: origins.docs.url, defaultBranch: 'main' }
    ];
    const patched = await page.request.patch(`/api/projects/${project.id}`, { data: { repos }, headers });
    if (patched.status() !== 200) throw new Error(`保存仓库失败：${await patched.text()}`);
    const view = (await patched.json()) as { repos: Array<{ id: string; name: string }> };
    const webId = view.repos.find((repo) => repo.name === 'web')!.id;
    const apiId = view.repos.find((repo) => repo.name === 'api')!.id;
    const docsId = view.repos.find((repo) => repo.name === 'docs')!.id;
    const primary = await page.request.patch(`/api/projects/${project.id}`, { data: { primaryRepoId: webId }, headers });
    if (primary.status() !== 200) throw new Error(`指定主仓库失败：${await primary.text()}`);
    const setup = await page.request.patch(`/api/projects/${project.id}`, {
      data: { worktree: { mode: 'isolated', setup: { command: 'test -x .agents/setup && .agents/setup', waitForSetup: true, timeoutSeconds: 60 } } },
      headers
    });
    if (setup.status() !== 200) throw new Error(`写准备命令失败：${await setup.text()}`);

    // 让本机 worker 的 git 把 e2e 仓库地址指到本地 bare，fetch / clone / push 都不出网。
    const workerHome = '/var/tmp/agent-hub-e2e-glm-amp-17998-home';
    for (const name of ['web', 'api', 'docs'] as const) {
      execFileSync('git', ['config', '--global', `url.${origins[name].bare}.insteadOf`, origins[name].url], { env: { ...process.env, HOME: workerHome } });
    }
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ id?: string; workerId?: string; state: string }>;
    const localId = workers.find((worker) => worker.state === 'online')?.workerId ?? workers.find((worker) => worker.state === 'online')?.id ?? null;
    for (const name of ['web', 'api', 'docs'] as const) {
      const linked = await page.request.post('/api/workspaces', {
        data: { workerId: localId, mode: 'link', path: origins[name].dir, repoUrl: origins[name].url, branch: 'main', name, projectId: project.id },
        headers
      });
      if (linked.status() !== 201) throw new Error(`关联 ${name} 失败：${await linked.text()}`);
    }
    record('1. 建项目：主仓库 + 两个成员仓（本地 bare，主仓库含 AGENTS.md 与 setup）', true, `project=${project.id} primary=web`);

    const token = await page.request.put('/api/git-host/token', { data: { token: TOKEN }, headers });
    if (!token.ok()) throw new Error(`保存 git token 失败：${await token.text()}`);

    const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '真实多仓场景' }, headers })).json()) as { id: string };
    const built = await page.request.post(`/api/projects/${project.id}/workspace-groups`, {
      data: { taskId: task.id, workerId: localId, repoIds: [webId] },
      headers
    });
    if (built.status() !== 201) throw new Error(`建组失败：${await built.text()}`);
    const group = (await built.json()) as { id: string; root: string; state: string; error: string | null; members: Array<{ workspaceId: string; name: string }> };
    if (group.state !== 'ready') throw new Error(`组未就绪：${group.state} ${group.error ?? ''}`);
    const subsetOnlyPrimary = group.members.length === 1 && group.members[0]?.name === 'web';
    const setupOk = existsSync(join(group.root, 'web', 'SETUP_OK'));
    const agentsOk = existsSync(join(group.root, 'web', 'AGENTS.md'));
    record('2. 只选主仓库建组合会话组', subsetOnlyPrimary && setupOk && agentsOk, `members=${group.members.map((m) => m.name).join(',')} setupOk=${setupOk} agents=${agentsOk} root=${group.root}`);
    if (!subsetOnlyPrimary) throw new Error('建组成员不是只含主仓库');

    const added = await page.request.post(`/api/workspace-groups/${group.id}/members`, { data: { repoId: apiId }, headers });
    if (added.status() !== 200 && added.status() !== 201) throw new Error(`添加 api 失败：${await added.text()}`);
    const addedDocs = await page.request.post(`/api/workspace-groups/${group.id}/members`, { data: { repoId: docsId }, headers });
    if (addedDocs.status() !== 200 && addedDocs.status() !== 201) throw new Error(`添加 docs 失败：${await addedDocs.text()}`);
    const after = (await (await page.request.get(`/api/workspace-groups/${group.id}`, { headers })).json()) as typeof group;
    const names = after.members.map((m) => m.name).sort().join(',');
    const apiTree = existsSync(join(group.root, 'repos', 'api'));
    const docsTree = existsSync(join(group.root, 'repos', 'docs'));
    record('3. 之后添加 api 与 docs，附加仓在 repos/', names === 'api,docs,web' && apiTree && docsTree, `members=${names} api=${apiTree} docs=${docsTree}`);

    const agentId = await waitOnlineAgent(page);
    const derived = await page.request.post('/api/sessions/derive', {
      data: { taskId: task.id, agentId, model: piModel(), groupId: group.id },
      headers
    });
    if (derived.status() !== 201) throw new Error(`派生失败：${derived.status()} ${await derived.text()}`);
    const session = (await derived.json()) as { id: string; groupId: string | null };
    const cwd = await page.request.get(`/api/sessions/${session.id}/files/context`, { headers });
    const cwdBody = (await cwd.json()) as { root: string };
    const cwdOk = cwdBody.root === join(group.root, 'web');
    record('4. 派生组合会话，cwd 是主仓库', cwdOk && session.groupId === group.id, `cwd=${cwdBody.root} model=${piModel()} agent=${agentId}`);
    if (!cwdOk) throw new Error('cwd 不是主仓库');

    const promptText =
      '请先阅读当前目录的 AGENTS.md，然后严格按其中说明：在主仓库根目录创建 NOTE.md（一行 primary note from agents.md），在 ../repos/api/NOTE.md 写一行 api note from agents.md。不要改其他文件，不要提交。';
    const prompted = await page.request.post(`/api/sessions/${session.id}/prompt`, { data: { text: promptText }, headers });
    if (!prompted.ok()) throw new Error(`提问失败：${await prompted.text()}`);

    const webNote = join(group.root, 'web', 'NOTE.md');
    const apiNote = join(group.root, 'repos', 'api', 'NOTE.md');
    try {
      await waitFiles([webNote, apiNote], 300_000);
      record('5. 智能体阅读 AGENTS.md 并在主仓库与 api 写出 NOTE.md', true, `web=${readFileSync(webNote, 'utf8').trim()} api=${readFileSync(apiNote, 'utf8').trim()}`);
    } catch (error) {
      record('5. 智能体阅读 AGENTS.md 并在主仓库与 api 写出 NOTE.md', false, error instanceof Error ? error.message : String(error));
      await page.goto(`${BASE}/#/p/${project.id}/focus/${session.id}`);
      await page.screenshot({ path: join(SHOTS, 'real-agent-failed.png') });
      throw error;
    }

    await page.goto(`${BASE}/#/p/${project.id}/focus/${session.id}`);
    await page.getByTestId('session-tab-changes').click();
    await page.getByTestId('changes-list').waitFor({ timeout: 30_000 });
    const webGroup = page.getByTestId('changes-group-web');
    const apiGroup = page.getByTestId('changes-group-api');
    const webVisible = await webGroup.isVisible().catch(() => false);
    const apiVisible = await apiGroup.isVisible().catch(() => false);
    await page.screenshot({ path: join(SHOTS, 'real-changes.png') });
    record('6. 改动页汇总两个仓库的 diff', webVisible && apiVisible, `webGroup=${webVisible} apiGroup=${apiVisible} shot=real-changes.png`);

    const webMember = after.members.find((m) => m.name === 'web')!.workspaceId;
    const apiMember = after.members.find((m) => m.name === 'api')!.workspaceId;
    const prWeb = await page.request.post(`/api/sessions/${session.id}/git/run?member=${webMember}`, {
      data: { action: 'pr', message: 'chore: primary note', title: 'primary note' },
      headers
    });
    const prApi = await page.request.post(`/api/sessions/${session.id}/git/run?member=${apiMember}`, {
      data: { action: 'pr', message: 'chore: api note', title: 'api note' },
      headers
    });
    const webBody = (await prWeb.json()) as { pushed?: boolean; pullRequest?: { number: number; state: string } | null };
    const apiBody = (await prApi.json()) as { pushed?: boolean; pullRequest?: { number: number; state: string } | null };
    const webLog = execFileSync('git', ['--git-dir', origins.web.bare, 'log', '--oneline', '-5'], { encoding: 'utf8' });
    const apiLog = execFileSync('git', ['--git-dir', origins.api.bare, 'log', '--oneline', '-5'], { encoding: 'utf8' });
    const pushed = prWeb.ok() && prApi.ok() && webBody.pushed && apiBody.pushed && Boolean(webBody.pullRequest) && Boolean(apiBody.pullRequest);
    record('7. 两个成员仓提交并推送，模拟开 PR', Boolean(pushed), `web=${JSON.stringify(webBody)} api=${JSON.stringify(apiBody)} webLog=${webLog.trim()} apiLog=${apiLog.trim()}`);

    await page.request.post(`/api/sessions/${session.id}/interrupt`, { headers });
    github.setMerged();
    const synced = await page.request.get(`/api/tasks/${task.id}/pull-requests?refresh=1`, { headers });
    const prs = (await synced.json()) as { pullRequests?: Array<{ number: number; state: string; repo?: string }> };
    const mergedOk = (prs.pullRequests ?? []).filter((pr) => pr.state === 'merged').length >= 2;
    record('7b. 将 PR 标成已合并并同步', mergedOk, JSON.stringify(prs.pullRequests ?? prs));

    const sweep = async () => (await (await page.request.post(`/api/projects/${project.id}/cleanup/sweep`, { headers })).json()) as { removed: string[]; kept: string[]; skipped: string[] };
    const first = await sweep();
    let settled = ((await (await page.request.get(`/api/sessions/${session.id}`, { headers })).json()) as { settledAt: number | null }).settledAt;
    if (settled == null) {
      // 同步时若会话还在收尾，再扫一轮应收起
      await sweep();
      settled = ((await (await page.request.get(`/api/sessions/${session.id}`, { headers })).json()) as { settledAt: number | null }).settledAt;
    }
    const stillThere = existsSync(join(group.root, 'web')) && existsSync(join(group.root, 'repos', 'api'));
    record('8. 全部合并后先自动收起，worktree 仍在', settled != null && stillThere && first.removed.length === 0, `settledAt=${settled} firstRemoved=${JSON.stringify(first)} stillThere=${stillThere}`);

    await page.screenshot({ path: join(SHOTS, 'real-archived.png') });

    const second = await sweep();
    const webGone = !existsSync(join(group.root, 'web'));
    const apiGone = !existsSync(join(group.root, 'repos', 'api'));
    const groupLeft = await page.request.get(`/api/workspace-groups/${group.id}`, { headers });
    record('9. 下一轮清理整组拆掉干净 worktree，组行仍保留以便恢复', second.removed.length >= 2 && webGone && apiGone && groupLeft.ok(), `removed=${JSON.stringify(second)} webGone=${webGone} apiGone=${apiGone} groupStatus=${groupLeft.status()}`);

    const reopened = await page.request.post(`/api/sessions/${session.id}/settle`, { data: { settled: false }, headers });
    const reopenedBody = await reopened.text();
    const webBack = existsSync(join(group.root, 'web'));
    const apiBack = existsSync(join(group.root, 'repos', 'api'));
    record('10. 重新打开会话，worktree 按原分支恢复', reopened.ok() && webBack && apiBack, `settle=${reopened.status()} ${reopenedBody.slice(0, 300)} webBack=${webBack} apiBack=${apiBack}`);

    await page.goto(`${BASE}/#/p/${project.id}/focus/${session.id}`);
    await page.screenshot({ path: join(SHOTS, 'real-restored.png') });
  } finally {
    writeEvidence();
    await browser.close();
    github.server.close();
  }
}

main().catch((error) => {
  record('fatal', false, error instanceof Error ? error.stack ?? error.message : String(error));
  writeEvidence();
  console.error(error);
  process.exitCode = 1;
});
