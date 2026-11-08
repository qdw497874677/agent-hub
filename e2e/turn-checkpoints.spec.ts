import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { e2eWorkerPath, e2eWorkerRoots } from './isolation.ts';

/**
 * ADR 0027 阶段 1：回合检查点 + 本轮 diff，整条真路径——
 * 远端 Worker（files.checkpoint RPC）+ 假 ACP agent 真的在工作区里写文件，两轮对话；
 * 每轮前后各一个 refs/agent-hub/checkpoints/<会话>/<n>；「本轮」只看到这一轮的改动；用户自己暂存的东西不被碰。
 */
const SHOTS = '/workspace/shots/git-workflow/1-checkpoints';
const FAKE = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');

type Turn = { turn: number; after: string | null; files: number | null };

async function waitTurns(page: Page, sid: string, count: number): Promise<Turn[]> {
  for (let i = 0; i < 120; i++) {
    const turns = ((await (await page.request.get(`/api/sessions/${sid}/git/turns`)).json()) as { turns?: Turn[] }).turns ?? [];
    if (turns.length >= count && turns.every((t) => t.after !== null)) return turns;
    await page.waitForTimeout(500);
  }
  throw new Error(`等不到 ${count} 轮检查点`);
}

test('回合检查点：两轮真对话，本轮 / 整个会话 / 对比 HEAD，ref 落在仓库里，真 index 不动', async ({ page, baseURL }) => {
  test.setTimeout(150_000);
  mkdirSync(SHOTS, { recursive: true });
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const pairing = await page.request.post('/api/workers/pairing', { data: {}, headers });
  expect(pairing.ok()).toBe(true);
  const code = ((await pairing.json()) as { code: string }).code;
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  const PATH = e2eWorkerPath();
  const label = `e2e 检查点机器 ${Date.now().toString(36)}`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], { env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label }, encoding: 'utf8' });
  expect(enrolled.status).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-ckpt-'));
  const dir = mkdtempSync(join(tmpdir(), 'e2e-ckpt-repo-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@x', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  // 用户自己暂存了一个文件：检查点用临时 index，不能把它弄丢 / 改掉
  writeFileSync(join(dir, 'mine.txt'), 'staged by me\n');
  git('add', 'mine.txt');
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
    const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 检查点 ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers })).json()) as { id: string };
    const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '检查点任务' }, headers })).json()) as { id: string };
    const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: 'fakeacp', model: '' }, headers });
    expect(derived.ok(), await derived.text()).toBe(true);
    const sid = ((await derived.json()) as { id: string }).id;
    expect(((await (await page.request.get(`/api/sessions/${sid}/git/changes?base=turn`)).json()) as { error?: unknown }).error).toBeTruthy();

    // 第 1 轮：agent 写 a.txt；第 2 轮：写 b.txt 并给 a.txt 再加一行
    const p1 = await page.request.post(`/api/sessions/${sid}/prompt`, { data: { text: 'please-write:a.txt=one' }, headers });
    expect(p1.ok(), await p1.text()).toBe(true);
    await waitTurns(page, sid, 1);
    const p2 = await page.request.post(`/api/sessions/${sid}/prompt`, { data: { text: 'please-write:b.txt=two please-write:a.txt=more' }, headers });
    expect(p2.ok(), await p2.text()).toBe(true);
    const turns = await waitTurns(page, sid, 2);
    expect(turns.map((t) => [t.turn, t.files])).toEqual([[1, 1], [2, 2]]);

    const changesOf = async (q: string) =>
      ((await (await page.request.get(`/api/sessions/${sid}/git/changes?${q}`)).json()) as { files: { path: string; additions: number }[] }).files.map((f) => `${f.path}+${f.additions}`);
    expect(await changesOf('base=turn&turn=1')).toEqual(['a.txt+1']);
    expect(await changesOf('base=turn')).toEqual(['a.txt+1', 'b.txt+1']);
    // 整个会话（会话开始的 HEAD → 工作区）：两轮的都在，外加用户暂存的 mine.txt
    expect(await changesOf('base=session')).toEqual(['a.txt+2', 'b.txt+1', 'mine.txt+1']);
    const diff = (await (await page.request.get(`/api/sessions/${sid}/git/diff?path=a.txt&base=turn&turn=2`)).json()) as { patch: string };
    expect(diff.patch).toContain('+more');
    expect(diff.patch).not.toContain('+one');

    // 仓库里：4 个检查点 ref，真 index 只有用户暂存的 mine.txt
    expect(git('for-each-ref', '--format=%(refname)', `refs/agent-hub/checkpoints/${sid}/`).trim().split('\n')).toEqual([1, 2, 3, 4].map((n) => `refs/agent-hub/checkpoints/${sid}/${n}`));
    expect(git('diff', '--cached', '--name-only').trim()).toBe('mine.txt');

    // 界面：改动页「本轮」只列这一轮；选第 1 轮只剩 a.txt
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 860 : 844 });
      await page.goto(`/#/p/${project.id}/focus/${sid}`);
      await page.reload();
      await page.getByTestId('session-tab-changes').click();
      const panel = page.getByTestId('files-panel-changes');
      await panel.getByTestId('changes-base').selectOption('turn');
      // files-error 只在失败时才挂上。textContent() 会等到整段测试超时，改动行其实已经画出来。
      const changesBody = await (await page.request.get(`/api/sessions/${sid}/git/changes?base=turn`)).text();
      const changesErrorCount = await panel.getByTestId('files-error').count();
      await expect(panel.getByTestId('change-row'), `接口=${changesBody.slice(0, 500)} files-error=${changesErrorCount}`).toHaveCount(2);
      await panel.getByTestId('change-row').filter({ hasText: 'a.txt' }).click();
      await expect(panel.getByTestId('diff-view')).toContainText('more');
      await page.screenshot({ path: join(SHOTS, `turn-${width}.png`) });
      if (width < 500) await panel.getByTestId('files-back').click();
      await panel.getByTestId('changes-base').selectOption('turn:1');
      await expect(panel.getByTestId('change-row')).toHaveCount(1);
      await expect(panel.getByTestId('change-row')).toContainText('a.txt');
      await panel.getByTestId('changes-base').selectOption('session');
      await expect(panel.getByTestId('change-row')).toHaveCount(3);
      await page.screenshot({ path: join(SHOTS, `session-${width}.png`) });
    }
  } finally {
    worker?.kill();
    await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
    rmSync(state, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
