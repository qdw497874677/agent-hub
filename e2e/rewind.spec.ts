import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { e2eWorkerPath, e2eWorkerRoots } from './isolation.ts';

/**
 * ADR 0027 阶段 4：回滚到某条消息（「⋯ → 从这里重来」），远端 Worker 上真的 git worktree。
 * 1) 长期工作空间：只能回滚对话，文件选项灰掉并写明原因；
 * 2) 临时工作空间：连文件一起回滚——这一轮写的文件没了，之前的还在；新会话从这条之前分叉，原消息回填输入框；原会话不动；
 * 3) 非 git 临时目录：任务结束时目录里还有文件 → 保留并在清理记录写明原因，清空后才删。
 */
const SHOTS = '/workspace/shots/git-workflow/4-rollback';
const FAKE = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');

async function waitTurns(page: Page, sid: string, count: number): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const turns = ((await (await page.request.get(`/api/sessions/${sid}/git/turns`)).json()) as { turns?: { after: string | null }[] }).turns ?? [];
    if (turns.length >= count && turns.every((t) => t.after !== null)) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`等不到 ${count} 轮检查点`);
}

test('从这里重来：长期只回滚对话；临时连文件一起回滚；非 git 临时目录有文件就保留', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const code = ((await (await page.request.post('/api/workers/pairing', { data: {}, headers })).json()) as { code: string }).code;
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-rewind-'));
  const PATH = e2eWorkerPath();
  const label = `e2e 回滚机器 ${Date.now().toString(36)}`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], { env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label }, encoding: 'utf8' });
  expect(enrolled.status).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');

  const root = mkdtempSync(join(tmpdir(), 'e2e-rewind-'));
  const dir = join(root, 'demo');
  const plain = join(root, 'plain');
  const bare = join(root, 'origin.git');
  mkdirSync(dir);
  mkdirSync(plain);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@x', ...args], { cwd, encoding: 'utf8' });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', 'origin', 'main');
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
    const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 回滚 ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers })).json()) as { id: string };
    const newTask = async (projectId: string, title: string) => ((await (await page.request.post('/api/tasks', { data: { projectId, title }, headers })).json()) as { id: string }).id;
    const temp = async (projectId: string, taskId: string) => {
      const r = await page.request.post(`/api/projects/${projectId}/workspaces`, { data: { kind: 'temporary', taskId, workerId }, headers });
      expect(r.ok(), await r.text()).toBe(true);
      return (await r.json()) as { id: string; path: string; branch: string | null; state: string };
    };
    const derive = async (taskId: string, workspaceId?: string) => {
      const r = await page.request.post('/api/sessions/derive', { data: { taskId, agentId: 'fakeacp', model: '', ...(workspaceId ? { workspaceId } : {}) }, headers });
      expect(r.ok(), await r.text()).toBe(true);
      return ((await r.json()) as { id: string }).id;
    };
    const say = async (sid: string, text: string, turns: number) => {
      expect((await page.request.post(`/api/sessions/${sid}/prompt`, { data: { text }, headers })).ok()).toBe(true);
      await waitTurns(page, sid, turns);
    };
    const promptSeqs = async (sid: string) =>
      (((await (await page.request.get(`/api/sessions/${sid}/git/turns`)).json()) as { turns?: { promptSeq: number }[] }).turns ?? []).map((t) => t.promptSeq);

    // ── 1. 长期工作空间（项目目录）：文件选项灰掉，写明原因 ──
    const t0 = await newTask(project.id, '长期');
    const s0 = await derive(t0);
    await say(s0, 'please-write:long.txt=one', 1);
    const [p0 = 0] = await promptSeqs(s0);
    const pre0 = (await (await page.request.get(`/api/sessions/${s0}/rewind?promptSeq=${p0}`)).json()) as { filesAllowed: boolean; filesBlocked: string };
    expect(pre0.filesAllowed).toBe(false);
    expect(pre0.filesBlocked).toMatch(/临时工作空间/);
    const refused = await page.request.post(`/api/sessions/${s0}/rewind`, { data: { promptSeq: p0, files: true }, headers });
    expect(refused.status()).toBe(409);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/#/p/${project.id}/focus/${s0}`);
    await page.getByTestId('msg-menu').first().click();
    await page.getByTestId('msg-rewind').click();
    const d0 = page.getByTestId('rewind-dialog');
    await expect(d0.getByTestId('rewind-files')).toBeDisabled();
    await expect(d0.getByTestId('rewind-files-note')).toContainText('临时工作空间');
    await page.screenshot({ path: join(SHOTS, 'dialog-long-lived-390.png') });
    await page.keyboard.press('Escape');

    // ── 2. 临时工作空间：两轮各写一个文件，从第二条重来并回滚文件 ──
    const t1 = await newTask(project.id, '临时');
    const w1 = await temp(project.id, t1);
    const s1 = await derive(t1, w1.id);
    await say(s1, 'please-write:a.txt=one', 1);
    await say(s1, 'please-write:b.txt=two', 2);
    expect(existsSync(join(w1.path, 'b.txt'))).toBe(true);
    const [, p2 = 0] = await promptSeqs(s1);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 860 : 844 });
      await page.goto(`/#/p/${project.id}/focus/${s1}`);
      await page.reload();
      await page.getByTestId('msg-menu').nth(1).click();
      await page.screenshot({ path: join(SHOTS, `menu-${width}.png`) });
      await page.getByTestId('msg-rewind').click();
      const dialog = page.getByTestId('rewind-dialog');
      await expect(dialog.getByTestId('rewind-files')).toBeEnabled();
      await expect(dialog.getByTestId('rewind-files-note')).toContainText('撤掉之后 1 轮');
      await dialog.getByTestId('rewind-files').check();
      await page.screenshot({ path: join(SHOTS, `dialog-temporary-${width}.png`) });
      if (width === 390) {
        const overflow = await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
        expect(overflow).toBe(false);
        const created = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/rewind'));
        await dialog.getByTestId('rewind-go').click();
        const res = await created;
        expect(res.status(), await res.text()).toBe(201);
        const out = (await res.json()) as { session: { id: string; origin: { kind: string; fromSessionId: string; atSeq: number } }; files: { restored: number; removed: number } };
        expect(out.session.origin).toEqual({ kind: 'fork', fromSessionId: s1, atSeq: p2 - 1 });
        expect(out.files.removed).toBe(1);
        // 新会话打开，原消息在输入框里
        await expect(page).toHaveURL(new RegExp(out.session.id));
        await expect(page.locator('textarea').last()).toHaveValue('please-write:b.txt=two');
        expect(existsSync(join(w1.path, 'b.txt'))).toBe(false);
        expect(readFileSync(join(w1.path, 'a.txt'), 'utf8')).toContain('one');
        // 原会话一个字没少，只多了一条记号
        expect(await promptSeqs(s1)).toContain(p2);
        await expect(page.getByTestId('fork-divider')).toBeVisible();
        await page.screenshot({ path: join(SHOTS, `after-rewind-${width}.png`) });
      } else {
        await page.keyboard.press('Escape');
      }
    }

    // ── 3. 非 git 临时目录：有文件 → 任务结束保留并记原因；清空后才删 ──
    const plainProject = (await (await page.request.post('/api/projects', { data: { name: `e2e 非git ${Date.now().toString(36)}`, rootPath: plain, workerId }, headers })).json()) as { id: string };
    const t2 = await newTask(plainProject.id, '非 git');
    const w2 = await temp(plainProject.id, t2);
    writeFileSync(join(w2.path, 'notes.md'), 'keep me');
    expect((await page.request.patch(`/api/tasks/${t2}/status`, { data: { status: 'done' }, headers })).ok()).toBe(true);
    const sweep = async () => (await (await page.request.post(`/api/projects/${plainProject.id}/cleanup/sweep`, { headers })).json()) as { removed: string[]; kept: string[] };
    expect((await sweep()).kept).toEqual([w2.id]);
    expect(existsSync(join(w2.path, 'notes.md'))).toBe(true);
    const records = (await (await page.request.get(`/api/projects/${plainProject.id}/cleanup/records`)).json()) as { items: { action: string; reason: string }[] };
    expect(records.items[0]).toMatchObject({ action: 'kept' });
    expect(records.items[0]?.reason).toMatch(/不是 git 仓库，目录里还有 1 个文件/);
    rmSync(join(w2.path, 'notes.md'));
    expect((await sweep()).removed).toEqual([w2.id]);
    expect(existsSync(w2.path)).toBe(false);
  } finally {
    worker?.kill();
    await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
    rmSync(state, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
