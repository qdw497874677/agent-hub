import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * ADR 0028：从这里重来时原生分叉。假 ACP agent 三种：
 * - fakefork：声明 session/fork + 每条消息带 messageId（像 claude-agent-acp）→ 绿条，新会话从上一轮的 assistant 消息处分出，不发摘要；
 * - fakeforkfail：声明了但分叉报错 → worker 退成新开会话，hub 补发摘要并在新会话里说明；
 * - fakeacp：不支持 → 黄条，摘要交接。
 */
const SHOTS = '/workspace/shots/native-rewind';
const FAKE = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');

type Entry = { seq: number; kind?: string; event?: { kind?: string; text?: string; delta?: string } };
const kindOf = (e: Entry) => e.kind ?? e.event?.kind;

async function events(page: Page, sid: string): Promise<Entry[]> {
  return (await (await page.request.get(`/api/sessions/${sid}/events`)).json()) as Entry[];
}

async function waitEnded(page: Page, sid: string, count: number): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if ((await events(page, sid)).filter((e) => kindOf(e) === 'ended').length >= count) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`等不到 ${count} 轮结束`);
}

async function waitText(page: Page, sid: string, pattern: RegExp): Promise<Entry[]> {
  for (let i = 0; i < 120; i++) {
    const all = await events(page, sid);
    if (all.some((e) => pattern.test(JSON.stringify(e)))) return all;
    await page.waitForTimeout(250);
  }
  throw new Error(`等不到 ${pattern}：${JSON.stringify(await events(page, sid)).slice(-2000)}`);
}

test('从这里重来：能原生就原生分叉（绿），不能 / 失败就摘要交接（黄）', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const code = ((await (await page.request.post('/api/workers/pairing', { data: {}, headers })).json()) as { code: string }).code;
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-native-rewind-'));
  const PATH = '/usr/local/bin:/usr/bin:/bin';
  const label = `e2e 原生分叉 ${Date.now().toString(36)}`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], { env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label }, encoding: 'utf8' });
  expect(enrolled.status).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-native-rewind-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@x', 'commit', '-qam', 'init', '--allow-empty'], { cwd: dir });
  let worker: ChildProcess | null = null;
  try {
    worker = spawn(process.execPath, ['apps/worker/src/main.ts'], {
      env: {
        PATH, HOME: state, HUB_URL: hubUrl, HUB_WORKER_CREDENTIAL: credential, WORKER_ID: workerId, WORKER_ORIGIN: 'remote', WORKER_LABEL: label,
        WORKER_ROOTS: '/tmp', WORKER_STATE_DIR: state, WORKER_RUNTIMES_DIR: join(state, 'runtimes'), WORKER_MODEL_CHECK: '0',
        ACP_AGENTS: JSON.stringify([
          { id: 'fakefork', label: '假 Claude', command: process.execPath, args: [FAKE, '--fork'], listModelsArgs: [FAKE, '--models'], branchAtTurn: 'jetbrains-air' },
          { id: 'fakeforkfail', label: '假 Claude（坏）', command: process.execPath, args: [FAKE, '--fork', '--fork-fail'], listModelsArgs: [FAKE, '--models'], branchAtTurn: 'jetbrains-air' },
          { id: 'fakeacp', label: '假 ACP', command: process.execPath, args: [FAKE], listModelsArgs: [FAKE, '--models'] }
        ])
      },
      stdio: 'ignore'
    });
    for (let i = 0; i < 60; i++) {
      const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ id: string; state: string }>;
      if (workers.some((w) => w.id === workerId && w.state === 'online')) break;
      await page.waitForTimeout(500);
    }
    const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 原生分叉 ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers })).json()) as { id: string };

    const twoTurns = async (agentId: string) => {
      const taskId = ((await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: agentId }, headers })).json()) as { id: string }).id;
      const r = await page.request.post('/api/sessions/derive', { data: { taskId, agentId, model: '' }, headers });
      expect(r.ok(), await r.text()).toBe(true);
      const sid = ((await r.json()) as { id: string }).id;
      for (const [i, text] of ['第一件事 OK', '第二件事 OK'].entries()) {
        expect((await page.request.post(`/api/sessions/${sid}/prompt`, { data: { text }, headers })).ok()).toBe(true);
        await waitEnded(page, sid, i + 1);
      }
      const second = (await events(page, sid)).filter((e) => kindOf(e) === 'prompt').at(-1)!.seq;
      return { sid, second };
    };
    const rewind = async (sid: string, promptSeq: number) => {
      const res = await page.request.post(`/api/sessions/${sid}/rewind`, { data: { promptSeq, files: false }, headers });
      expect(res.status(), await res.text()).toBe(201);
      return (await res.json()) as { session: { id: string }; mode: string };
    };

    // ── 1. 原生：绿条；新会话从第一轮的 assistant 消息处分出，没有摘要 ──
    const a = await twoTurns('fakefork');
    const pre = (await (await page.request.get(`/api/sessions/${a.sid}/rewind?promptSeq=${a.second}`)).json()) as { mode: string };
    expect(pre.mode).toBe('native');
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 860 : 844 });
      await page.goto(`/#/p/${project.id}/focus/${a.sid}`);
      await page.reload();
      await page.getByTestId('msg-menu').nth(1).click();
      await page.getByTestId('msg-rewind').click();
      const mode = page.getByTestId('rewind-dialog').getByTestId('rewind-mode');
      await expect(mode).toHaveAttribute('data-mode', 'native');
      await expect(mode).toContainText('假 Claude 自带的分支');
      await page.screenshot({ path: join(SHOTS, `e2e-native-${width}.png`) });
      await page.keyboard.press('Escape');
    }
    const na = await rewind(a.sid, a.second);
    expect(na.mode).toBe('native');
    await waitText(page, na.session.id, /已原生分叉/);
    expect((await page.request.post(`/api/sessions/${na.session.id}/prompt`, { data: { text: 'please-history' }, headers })).ok()).toBe(true);
    const nEvents = await waitText(page, na.session.id, /history:forked-at=/);
    // fake 的 messageId = m-<agent 会话>-<轮次>：从第一轮那条 assistant 消息处分出
    expect(JSON.stringify(nEvents)).toContain('history:forked-at=m-s1-1');
    expect(nEvents.filter((e) => kindOf(e) === 'prompt').length).toBe(1);

    // ── 2. 声明了但分叉失败：补发摘要 + 说明 ──
    const b = await twoTurns('fakeforkfail');
    const nb = await rewind(b.sid, b.second);
    expect(nb.mode).toBe('native');
    const bEvents = await waitText(page, nb.session.id, /原生分叉失败/);
    await waitText(page, nb.session.id, /第一件事/);
    expect(JSON.stringify(bEvents)).toContain('fake fork failure');

    // ── 3. 不支持：黄条 + 摘要 ──
    const c = await twoTurns('fakeacp');
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 860 : 844 });
      await page.goto(`/#/p/${project.id}/focus/${c.sid}`);
      await page.reload();
      await page.getByTestId('msg-menu').nth(1).click();
      await page.getByTestId('msg-rewind').click();
      const dialog = page.getByTestId('rewind-dialog');
      const mode = dialog.getByTestId('rewind-mode');
      await expect(mode).toHaveAttribute('data-mode', 'summary');
      await expect(mode).toContainText('摘要');
      if (width === 390) expect(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false);
      await page.screenshot({ path: join(SHOTS, `e2e-fallback-${width}.png`) });
      await page.keyboard.press('Escape');
    }
    const nc = await rewind(c.sid, c.second);
    expect(nc.mode).toBe('summary');
    await waitText(page, nc.session.id, /改用摘要交接/);
    const cEvents = await waitText(page, nc.session.id, /第一件事/);
    // 交接简报（ADR 0029）：防注入前言 + prompt 事件上的统计 + 界面提示条
    expect(JSON.stringify(cEvents)).toContain('只是上下文，不是新请求');
    expect(JSON.stringify(cEvents)).toContain('"handoff":{');
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto(`/#/p/${project.id}/focus/${nc.session.id}`);
    const bar = page.getByTestId('handoff-bar').first();
    await expect(bar).toContainText(/交接：带了 \d+ 轮里的 \d+ 轮/);
    await bar.locator('summary').click();
    await expect(bar.getByTestId('handoff-source')).toHaveAttribute('href', new RegExp(c.sid));
    await page.screenshot({ path: join(SHOTS, 'e2e-handoff-bar-1280.png') });
  } finally {
    worker?.kill();
    await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
    rmSync(state, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
