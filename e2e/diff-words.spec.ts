import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type Locator } from '@playwright/test';
import { loginByApi } from './login.ts';
import { e2eWorkerPath, e2eWorkerRoots } from './isolation.ts';

/**
 * 会话里的 diff：整行红绿 → 词级高亮 + 旧 / 新两栏行号 + 复制只拿正文。
 *
 * 用例自己起一台假 ACP 机器（不调真模型），跑一轮真的，再往历史接口里插两条 bash 工具调用，
 * 输出是统一 diff：一条行号 1~3（1ch），一条行号 118~119（3ch），
 * 这样宽度「按最长行号算」是可断言的。词级高亮只认真正变的那几个字。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'] ?? '/tmp/opencode/shots/diff-words';
const FAKE = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');

/** `@@ -1,3 +1,3 @@`：行号一位数，gutter 应该 1ch。改的是 2 → 4。 */
const DIFF_SMALL = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 4;',
  ' const c = 3;'
].join('\n');

/** `@@ -118,2 +118,2 @@`：行号三位数，gutter 应该 3ch。改的是 30 → 60。 */
const DIFF_BIG = [
  '@@ -118,2 +118,2 @@',
  ' const timeout = 1000;',
  '-const retry = 30;',
  '+const retry = 60;'
].join('\n');

/** 21 行（⋯ + 20 行上下文）：只给 12 行预览，展开后全给；行号不能因为展开错位。 */
const DIFF_LONG = ['@@ -1,20 +1,20 @@', ...Array.from({ length: 20 }, (_, i) => ` const v${i + 1} = ${i + 1};`)].join('\n');

/** diff 里那两行本身有多长（用来核对「复制只拿正文」）。 */
const ADDED_BODY = 'const b = 4;';

async function setup(page: import('@playwright/test').Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };

  const pairing = await page.request.post('/api/workers/pairing', { data: {}, headers });
  expect(pairing.ok()).toBe(true);
  const code = ((await pairing.json()) as { code: string }).code;
  const hubUrl = `${baseURL.replace(/^http/, 'ws')}/worker`;
  const PATH = e2eWorkerPath();
  const label = `e2e diff 机器 ${Date.now().toString(36)}`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], { env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label }, encoding: 'utf8' });
  expect(enrolled.status).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-diff-'));
  const agents = [{ id: 'fakeacp', label: '假 ACP', command: process.execPath, args: [FAKE], listModelsArgs: [FAKE, '--models'] }];
  const worker: ChildProcess = spawn(process.execPath, ['apps/worker/src/main.ts'], {
    env: {
      PATH, HOME: state, HUB_URL: hubUrl, HUB_WORKER_CREDENTIAL: credential, WORKER_ID: workerId, WORKER_ORIGIN: 'remote', WORKER_LABEL: label,
      WORKER_ROOTS: e2eWorkerRoots(), WORKER_STATE_DIR: state, WORKER_RUNTIMES_DIR: join(state, 'runtimes'),
      ACP_AGENTS: JSON.stringify(agents), WORKER_MODEL_CHECK_TIMEOUT_MS: '15000'
    },
    stdio: 'ignore'
  });

  const dir = mkdtempSync(join(tmpdir(), 'e2e-diff-words-'));
  mkdirSync(join(dir, 'src'));
  // 机器得先上线，否则建项目拿不到 workerId、derive 会报「请求体不合法」
  for (let i = 0; i < 120; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ id?: string; workerId?: string; state: string }>;
    if (workers.find((x) => (x.workerId ?? x.id) === workerId)?.state === 'online') break;
    await page.waitForTimeout(500);
  }
  const projectResponse = await page.request.post('/api/projects', { data: { name: `e2e diff ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers });
  expect(projectResponse.ok(), await projectResponse.text()).toBe(true);
  const project = (await projectResponse.json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: 'diff 渲染' }, headers })).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: 'fakeacp', model: '' }, headers });
  expect(derived.ok(), await derived.text()).toBe(true);
  const session = (await derived.json()) as { id: string };
  const prompted = await page.request.post(`/api/sessions/${session.id}/prompt`, { data: { text: '看看 diff' }, headers });
  expect(prompted.ok(), await prompted.text()).toBe(true);
  await expect.poll(async () => ((await (await page.request.get(`/api/sessions/${session.id}/events`)).json()) as Array<{ event: { kind: string } }>).some(({ event }) => event.kind === 'ended'), { timeout: 30_000 }).toBe(true);

  const calls = [
    { input: { command: 'git diff src/a.ts' }, output: DIFF_SMALL },
    { input: { command: 'git diff src/b.ts' }, output: DIFF_BIG },
    { input: { command: 'git diff src/long.ts' }, output: DIFF_LONG }
  ];
  await page.route(`**/api/sessions/${session.id}/events**`, async (route) => {
    const response = await route.fetch();
    const entries = (await response.json()) as Array<{ seq: number; at?: number; event?: Record<string, unknown> }>;
    const last = entries[entries.length - 1]!;
    const extra = calls.flatMap((call, i) => [
      { ...last, seq: last.seq + 1 + i * 2, event: { kind: 'tool_call', name: 'bash', input: JSON.stringify(call.input) } },
      { ...last, seq: last.seq + 2 + i * 2, event: { kind: 'tool_result', name: 'bash', ok: true, durationMs: 3, output: call.output } }
    ]);
    await route.fulfill({ response, json: [...entries, ...extra] });
  });

  return {
    project,
    session: session.id,
    cleanup: async () => {
      worker.kill();
      await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
      rmSync(state, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** 行号列的宽度是内联的 ch 值：1ch / 3ch 直接读，不用换算像素。 */
const gutter = (locator: Locator) => locator.evaluate((el) => (el as HTMLElement).style.minWidth);

test('会话 diff 词级高亮 + 两栏行号 + 复制不带行号', async ({ page, baseURL }) => {
  test.setTimeout(150_000);
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 860 });
  const { project, session, cleanup } = await setup(page, baseURL!);
  try {
    await page.goto(`/#/p/${project.id}/focus/${session}`);
    const log = page.getByRole('log', { name: '会话记录' });
    await log.getByTestId('work-group-toggle').click();
    await expect(log.getByTestId('tool-card')).toHaveCount(3);
    await log.getByTestId('tool-card').evaluateAll((cards) => cards.forEach((card) => ((card as HTMLDetailsElement).open = true)));

    const diffs = log.getByTestId('tool-diff');
    await expect(diffs).toHaveCount(3);
    const small = diffs.nth(0);
    const big = diffs.nth(1);
    const wide = diffs.nth(2);
    // 5 行（⋯ / 3 行上下文与改动），每行两栏行号
    await expect(small.getByTestId('diff-row')).toHaveCount(5);
    await expect(small.getByTestId('diff-line-no')).toHaveCount(10);

    // 行号：按 hunk 头的起点数，- 只有旧侧、+ 只有新侧
    const removed = small.locator('[data-sign="-"]').first();
    const added = small.locator('[data-sign="+"]').first();
    await expect(removed.locator('[data-side="old"]')).toHaveText('2');
    await expect(removed.locator('[data-side="new"]')).toHaveText('');
    await expect(added.locator('[data-side="old"]')).toHaveText('');
    await expect(added.locator('[data-side="new"]')).toHaveText('2');

    // gutter 宽度按最长行号算：1~3 是 1ch，118~119 是 3ch
    expect(await gutter(small.getByTestId('diff-line-no').first())).toBe('1ch');
    expect(await gutter(big.getByTestId('diff-line-no').first())).toBe('3ch');
    await expect(big.locator('[data-sign="-"]').first().locator('[data-side="old"]')).toHaveText('119');

    // 词级高亮：只把真正变的那几个字上底色
    await expect(small.getByTestId('diff-word')).toHaveCount(2);
    await expect(small.getByTestId('diff-word').nth(0)).toHaveText('2');
    await expect(small.getByTestId('diff-word').nth(1)).toHaveText('4');
    await expect(big.getByTestId('diff-word').nth(1)).toHaveText('6');
    // 没变的正文不在高亮里：正文仍然是完整的
    await expect(added).toContainText(ADDED_BODY);
    await expect(small).toContainText('const a = 1;');
    // 行号与 +/− 标记不进选区
    for (const cell of [small.getByTestId('diff-line-no').first(), added.getByTestId('diff-mark')]) {
      expect(await cell.evaluate((el) => getComputedStyle(el).userSelect)).toBe('none');
    }
    // 12 行预览 + 展开全部：行号跟着走，不因为折叠 / 展开错位
    await expect(wide.getByTestId('diff-row')).toHaveCount(12);
    expect(await gutter(wide.getByTestId('diff-line-no').first())).toBe('2ch');
    await wide.getByRole('button', { name: /展开全部/ }).click();
    await expect(wide.getByTestId('diff-row')).toHaveCount(21);
    await expect(wide.locator('[data-sign=" "]').last().locator('[data-side="old"]')).toHaveText('20');
    await expect(wide.locator('[data-sign=" "]').last().locator('[data-side="new"]')).toHaveText('20');
    await page.screenshot({ path: join(SHOTS, 'diff-1280.png') });

    // 只选中正文复制：行号和 +/− 标记不该跟进来
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL! });
    await added.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+C');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied.replace(/\s+/g, ' ').trim()).toBe(ADDED_BODY);

    // 手机宽度：两栏行号不把页面撑横，diff 仍然可读
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await log.getByTestId('work-group-toggle').click();
    await expect(log.getByTestId('tool-card')).toHaveCount(3);
    await log.getByTestId('tool-card').evaluateAll((cards) => cards.forEach((card) => ((card as HTMLDetailsElement).open = true)));
    await expect(page.getByTestId('diff-word').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: join(SHOTS, 'diff-390.png') });
  } finally {
    await cleanup();
  }
});
