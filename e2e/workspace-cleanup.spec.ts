import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { e2eWorkerPath, e2eWorkerRoots } from './isolation.ts';

/**
 * ADR 0027 阶段 3：临时工作空间清理，整条真路径——远端 Worker 上真的 git worktree。
 * 1) 任务结束 + 有未跟踪文件 → 保留并写明原因；清掉后再清理 → 删目录、分支留着、检查点 ref 一起删；
 * 2) 任务重新开始 → 按分支在原路径重建；
 * 3) squash 合并：PR（假 gh 报 MERGED，head = HEAD）合并后远端分支被删，本地提交「只在本分支」也照样删；
 * 4) 孤儿目录只列出来；规则开关、清理记录（含大小）在项目设置里。
 */
const SHOTS = '/workspace/shots/git-workflow/3-cleanup';
const FAKE = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');

async function waitTurns(page: Page, sid: string, count: number): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const turns = ((await (await page.request.get(`/api/sessions/${sid}/git/turns`)).json()) as { turns?: { after: string | null }[] }).turns ?? [];
    if (turns.length >= count && turns.every((t) => t.after !== null)) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`等不到 ${count} 轮检查点`);
}

test('清理：保留有未跟踪文件的、删干净的、squash 合并也删；按分支重建；孤儿只列出；记录带大小', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const code = ((await (await page.request.post('/api/workers/pairing', { data: {}, headers })).json()) as { code: string }).code;
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-clean-'));
  const bin = join(state, 'bin');
  mkdirSync(bin);
  // 假 gh：create 打印链接；view 报「已合并」，head 就是当前 HEAD（squash 合并后 GitHub 的样子）
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nif [ "$2" = "create" ]; then echo "https://github.com/e2e/demo/pull/51"; exit 0; fi\necho "{\\"number\\":51,\\"url\\":\\"https://github.com/e2e/demo/pull/51\\",\\"state\\":\\"MERGED\\",\\"headRefOid\\":\\"$(git rev-parse HEAD)\\",\\"mergedAt\\":\\"2026-11-01T00:00:00Z\\"}"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const PATH = e2eWorkerPath(bin);
  const label = `e2e 清理机器 ${Date.now().toString(36)}`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], { env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label }, encoding: 'utf8' });
  expect(enrolled.status).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');

  const root = mkdtempSync(join(tmpdir(), 'e2e-clean-'));
  const dir = join(root, 'demo');
  const bare = join(root, 'origin.git');
  mkdirSync(dir);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@x', ...args], { cwd, encoding: 'utf8' });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  git(dir, 'remote', 'add', 'origin', 'https://github.com/e2e/demo.git');
  git(dir, 'config', `url.${bare}.insteadOf`, 'https://github.com/e2e/demo.git');
  git(dir, 'config', 'status.showUntrackedFiles', 'no'); // D7：这样也要看得见未跟踪文件
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'remote', 'set-head', 'origin', 'main');
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
      if (i === 59) throw new Error('假 ACP worker 没有上线');
      await page.waitForTimeout(500);
    }
    const created = await page.request.post('/api/projects', { data: { name: `e2e 清理 ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers });
    expect(created.ok(), await created.text()).toBe(true);
    const project = (await created.json()) as { id: string };
    const newTask = async (title: string) => ((await (await page.request.post('/api/tasks', { data: { projectId: project.id, title }, headers })).json()) as { id: string }).id;
    const temp = async (taskId: string) => {
      const r = await page.request.post(`/api/projects/${project.id}/workspaces`, { data: { kind: 'temporary', taskId, workerId }, headers });
      expect(r.ok(), await r.text()).toBe(true);
      return (await r.json()) as { id: string; path: string; branch: string; state: string };
    };
    const setStatus = async (taskId: string, status: string) => expect((await page.request.patch(`/api/tasks/${taskId}/status`, { data: { status }, headers })).ok()).toBe(true);
    const stateOf = async (id: string) =>
      ((await (await page.request.get(`/api/projects/${project.id}/workspaces`)).json()) as { workspace: { id: string; state: string } }[]).find((v) => v.workspace.id === id)?.workspace.state ?? 'removed'; // 列表不含已删的
    const settle = async (id: string, want: string) => {
      for (let i = 0; i < 60 && (await stateOf(id)) !== want; i++) await page.waitForTimeout(250);
      expect(await stateOf(id)).toBe(want);
    };
    const sweep = async () => (await (await page.request.post(`/api/projects/${project.id}/cleanup/sweep`, { headers })).json()) as { removed: string[]; kept: string[]; skipped: string[] };

    // 默认规则：PR 合并 开、任务结束 开、闲置 关
    expect(await (await page.request.get(`/api/projects/${project.id}/cleanup`)).json()).toEqual({ prMerged: true, taskEndedClean: true, idleDays: null });

    // ── 1. 任务结束：有未跟踪文件 → 保留；清掉 → 删目录，分支和检查点 ref 处理对 ──
    const t1 = await newTask('任务一');
    const w1 = await temp(t1);
    expect(w1.path).toContain('/.worktrees/demo/');
    const derived = await page.request.post('/api/sessions/derive', { data: { taskId: t1, agentId: 'fakeacp', model: '', workspaceId: w1.id }, headers });
    expect(derived.ok(), await derived.text()).toBe(true);
    const sid = ((await derived.json()) as { id: string }).id;
    expect((await page.request.post(`/api/sessions/${sid}/prompt`, { data: { text: 'please-write:notes.txt=draft' }, headers })).ok()).toBe(true);
    await waitTurns(page, sid, 1);
    expect(git(dir, 'for-each-ref', `refs/agent-hub/checkpoints/${sid}/`).trim()).not.toBe('');
    await setStatus(t1, 'done'); // 任务结束会自己清一轮
    await settle(w1.id, 'kept');
    expect((await sweep()).kept).toEqual([w1.id]);
    expect(existsSync(w1.path)).toBe(true);
    rmSync(join(w1.path, 'notes.txt'));
    const second = await sweep();
    expect(second.removed, JSON.stringify(second)).toEqual([w1.id]);
    expect(existsSync(w1.path)).toBe(false);
    expect(git(dir, 'branch', '--list', w1.branch)).toContain(w1.branch);
    expect(git(dir, 'for-each-ref', `refs/agent-hub/checkpoints/${sid}/`).trim()).toBe('');

    // ── 2. 任务重新开始 → 原路径、原分支重建 ──
    await setStatus(t1, 'in_progress');
    const revived = await temp(t1);
    expect(revived).toMatchObject({ path: w1.path, branch: w1.branch, state: 'ready' });
    expect(existsSync(join(w1.path, 'README.md'))).toBe(true);
    await setStatus(t1, 'done');
    await settle(revived.id, 'removed');

    // ── 3. squash 合并：任务还没结束，PR 合并了，远端分支已删 ──
    const t2 = await newTask('任务二');
    const w2 = await temp(t2);
    const d2 = await page.request.post('/api/sessions/derive', { data: { taskId: t2, agentId: 'fakeacp', model: '', workspaceId: w2.id }, headers });
    const sid2 = ((await d2.json()) as { id: string }).id;
    expect((await page.request.post(`/api/sessions/${sid2}/prompt`, { data: { text: 'please-write:b.txt=two' }, headers })).ok()).toBe(true);
    await waitTurns(page, sid2, 1);
    const pr = (await (await page.request.post(`/api/sessions/${sid2}/git/run`, { data: { action: 'pr', message: 'feat: b', title: '加 b' }, headers })).json()) as { pushed: boolean; pullRequest: { number: number; state: string } | null };
    expect(pr.pushed).toBe(true);
    expect(pr.pullRequest).toMatchObject({ number: 51, state: 'merged' });
    git(dir, 'push', '-q', 'origin', '--delete', w2.branch);
    git(dir, 'fetch', '-q', '--prune', 'origin');
    const third = await sweep();
    expect(third.removed, JSON.stringify(third)).toEqual([w2.id]);
    expect(existsSync(w2.path)).toBe(false);

    // ── 4. 孤儿目录只列出；记录（含大小）；界面 ──
    const stray = join(dirname(w1.path), 'stray-dir');
    mkdirSync(stray);
    const records = (await (await page.request.get(`/api/projects/${project.id}/cleanup/records`)).json()) as { items: { action: string; reason: string; sizeBytes: number | null }[]; orphans: { path: string }[] };
    expect(records.orphans.map((o) => o.path)).toEqual([stray]);
    expect(records.items.map((i) => i.action)).toEqual(['removed', 'removed', 'removed', 'kept']);
    expect(records.items[0]?.reason).toMatch(/PR #51 已合并/);
    expect(records.items[3]?.reason).toMatch(/未跟踪/);
    expect(records.items.every((i) => (i.sizeBytes ?? 0) > 0)).toBe(true);
    expect((await page.request.put(`/api/projects/${project.id}/cleanup`, { data: { idleDays: 0 }, headers })).status()).toBe(400);

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 860 : 844 });
      await page.goto(`/#/p/${project.id}`);
      await page.getByRole('button', { name: '项目设置' }).click();
      const panel = page.getByTestId('workspace-cleanup');
      await panel.scrollIntoViewIfNeeded();
      await expect(panel.getByTestId('cleanup-item')).toHaveCount(4);
      await expect(panel.getByTestId('cleanup-orphan')).toContainText('stray-dir');
      if (width === 1280) {
        const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith('/cleanup'));
        await panel.getByLabel(/闲置超过/).click();
        expect((await saved).ok()).toBe(true);
        await expect(panel.getByLabel(/闲置超过/)).toBeChecked();
        await expect(panel.locator('input[type=number]')).toHaveValue('14');
      }
      // 窄屏不横向溢出：每条记录两行（动作 + 分支截断 / 原因 · 大小 · 时间）
      const overflow = await panel.evaluate((el) => [...el.querySelectorAll('[data-testid=cleanup-item]')].some((li) => li.scrollWidth > li.clientWidth + 1) || el.scrollWidth > el.clientWidth + 1);
      expect(overflow).toBe(false);
      await panel.screenshot({ path: join(SHOTS, `cleanup-panel-${width}.png`) });
      await page.screenshot({ path: join(SHOTS, `settings-${width}.png`) });
      await page.keyboard.press('Escape');
    }
    // 截图耗时长，keep-alive 连接可能已被服务端关闭（ECONNRESET），失败重试一次
    const policy = await page.request.get(`/api/projects/${project.id}/cleanup`).catch(() => page.request.get(`/api/projects/${project.id}/cleanup`));
    expect(await policy.json()).toEqual({ prMerged: true, taskEndedClean: true, idleDays: 14 });
    expect(existsSync(stray)).toBe(true);
  } finally {
    worker?.kill();
    await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
    rmSync(state, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
