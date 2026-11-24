import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { e2eWorkerPath, e2eWorkerRoots } from './isolation.ts';

/**
 * 送达状态（ADR 0031 P2）：Worker 断开时发的消息在气泡下显示「未送达 · 第 n 次重试 · 立即重试 · 撤回」，
 * 后面那条显示「排队中 · 等上一条送达」；撤回后标「已撤回」；Worker 回来后送达，气泡下什么都不显示。用假 ACP agent。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'];
const FAKE = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');

test('送达状态：未送达 / 排队中 / 撤回 / 重连后送达', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const code = ((await (await page.request.post('/api/workers/pairing', { data: {}, headers })).json()) as { code: string }).code;
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  const PATH = e2eWorkerPath();
  const label = `e2e 送达机器 ${Date.now().toString(36)}`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], { env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label }, encoding: 'utf8' });
  expect(enrolled.status).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-dlv-'));
  const agents = [{ id: 'fakeacp', label: '假 ACP', command: process.execPath, args: [FAKE], listModelsArgs: [FAKE, '--models'] }];
  const start = (): ChildProcess =>
    spawn(process.execPath, ['apps/worker/src/main.ts'], {
      env: {
        PATH, HOME: state, HUB_URL: hubUrl, HUB_WORKER_CREDENTIAL: credential, WORKER_ID: workerId, WORKER_ORIGIN: 'remote', WORKER_LABEL: label,
        WORKER_ROOTS: e2eWorkerRoots(), WORKER_STATE_DIR: state, WORKER_RUNTIMES_DIR: join(state, 'runtimes'), ACP_AGENTS: JSON.stringify(agents)
      },
      stdio: 'ignore'
    });
  const online = async (want: boolean) => {
    for (let i = 0; i < 120; i++) {
      const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ id?: string; workerId?: string; state: string }>;
      const w = workers.find((x) => (x.workerId ?? x.id) === workerId);
      if ((w?.state === 'online') === want) return;
      await page.waitForTimeout(500);
    }
    throw new Error(`worker 没有${want ? '上线' : '下线'}`);
  };
  let worker: ChildProcess | null = start();
  const dir = mkdtempSync(join(tmpdir(), 'e2e-dlv-'));
  try {
    await online(true);
    const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 送达 ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers })).json()) as { id: string };
    const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '送达任务' }, headers })).json()) as { id: string };
    const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: 'fakeacp', model: '' }, headers });
    expect(derived.ok(), await derived.text()).toBe(true);
    const session = (await derived.json()) as { id: string };
    const say = async (text: string) => expect((await page.request.post(`/api/sessions/${session.id}/prompt`, { data: { text }, headers })).ok()).toBe(true);
    await say('第一句');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/#/p/${project.id}/focus/${session.id}`);
    const log = page.getByRole('log', { name: '会话记录' });
    await expect(log.getByText('第一句')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1_500);
    await expect(log.getByTestId('delivery-note')).toHaveCount(0); // 送达了就安静

    // 发送即时反馈：API 慢时，用户气泡先贴上，journal 回来后再让位给真实事件。
    let delayPrompt = true;
    await page.route('**/api/sessions/*/prompt', async (route) => {
      if (!delayPrompt) return route.continue();
      delayPrompt = false;
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await route.continue();
    });
    const composer = page.getByLabel('发送消息');
    await composer.fill('乐观反馈第四句');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByTestId('pending-prompts')).toContainText('乐观反馈第四句', { timeout: 600 });
    await expect(page.getByTestId('pending-prompts')).toHaveCount(0, { timeout: 15_000 });
    await expect(log.getByText('乐观反馈第四句')).toBeVisible({ timeout: 15_000 });

    worker.kill();
    worker = null;
    await online(false);
    await say('离线时发的第二句');
    await say('离线时发的第三句');
    const notes = page.getByTestId('delivery-note');
    await expect(notes.nth(0)).toContainText(/未送达 · 第 \d+ 次重试 \d+ 秒后/, { timeout: 30_000 });
    await expect(notes.nth(0).getByRole('button', { name: '立即重试' })).toBeVisible();
    await expect(notes.nth(1)).toHaveText('排队中 · 等上一条送达');
    // 排队的消息留在时间线原位（不再有独立排队区），靠状态字认出来
    await expect(log.getByText('离线时发的第二句')).toBeVisible();
    await expect(log.getByText('离线时发的第三句')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/delivery-pending-1280.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    // 窄屏只留一条进度：排在后面的那条不再在气泡下重复，改成对话末尾那一条；
    // 未送达（带「立即重试 / 撤回」）仍然留在气泡下面，那是要人动手的。
    await expect(page.getByTestId('delivery-note')).toHaveCount(1);
    await expect(page.getByTestId('turn-hint')).toContainText('排队中');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/delivery-pending-390.png` });
    await page.setViewportSize({ width: 1280, height: 800 });

    // 「立即重试」：机器还不在，仍然没送到，但不报错
    await notes.nth(0).getByRole('button', { name: '立即重试' }).click();
    await expect(notes.nth(0)).toContainText('未送达');
    // 撤回第二句：标「已撤回」，第三句顶上来
    await notes.nth(0).getByRole('button', { name: '撤回' }).click();
    await expect(notes.nth(0)).toHaveText('已撤回 · 没有发给 agent');
    await expect(notes.nth(1)).toContainText(/未送达|排队中|发送中/);

    // Worker 回来：第三句送达，气泡下只剩「已撤回」
    worker = start();
    await online(true);
    await expect(notes).toHaveCount(1, { timeout: 90_000 });
    await expect(notes.first()).toHaveText('已撤回 · 没有发给 agent');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/delivery-done-1280.png` });
  } finally {
    worker?.kill();
    await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
    rmSync(state, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 排序（#269）：A 还在跑的时候发出的 B 只能排队——包着 A 的运行时不能被第二句话撞开，
 * B 也绝不能先进运行时。A 真的结束后 B 才被放行。
 *
 * 证据都靠文件信号，不靠 sleep 猜时序：
 * - fake agent 的 `--gate-dir`：`please-hold:<key>` 写 `hold-<key>.started` 表示这一轮
 *   真的进了运行时，然后一直等到 `hold-<key>.go` 才回 end_turn；`please-mark:<key>`
 *   写 `mark-<key>.started` 就正常结束。
 * - 送达队列（/deliveries）：A = sending，B = queued（nextAt 仍是 null，说明泵根本没把它
 *   当到期项去派发）。
 * - journal（/events）：B 的第一段文字落在 A 的 ended 之后，B 的 ended 再落在它自己的文字之后，
 *   两条 ended 各带自己的 deliveryId。
 */
test('排序：A 还在跑时 B 只排队，A 真的结束后 B 才进运行时', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const code = ((await (await page.request.post('/api/workers/pairing', { data: {}, headers })).json()) as { code: string }).code;
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  const PATH = e2eWorkerPath();
  const label = `e2e 排序机器 ${Date.now().toString(36)}`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], { env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label }, encoding: 'utf8' });
  expect(enrolled.status).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-order-'));
  const gate = join(state, 'gate');
  mkdirSync(gate, { recursive: true });
  const agents = [{ id: 'fakeacp', label: '假 ACP', command: process.execPath, args: [FAKE, '--gate-dir', gate], listModelsArgs: [FAKE, '--models'] }];
  const worker: ChildProcess = spawn(process.execPath, ['apps/worker/src/main.ts'], {
    env: {
      PATH, HOME: state, HUB_URL: hubUrl, HUB_WORKER_CREDENTIAL: credential, WORKER_ID: workerId, WORKER_ORIGIN: 'remote', WORKER_LABEL: label,
      WORKER_ROOTS: e2eWorkerRoots(), WORKER_STATE_DIR: state, WORKER_RUNTIMES_DIR: join(state, 'runtimes'), ACP_AGENTS: JSON.stringify(agents)
    },
    stdio: 'ignore'
  });
  const dir = mkdtempSync(join(tmpdir(), 'e2e-order-'));
  const gateFile = (name: string) => join(gate, `${name}.started`);
  const starts = (name: string) => (existsSync(gateFile(name)) ? readFileSync(gateFile(name), 'utf8').trim().split('\n').length : 0);
  try {
    let online = false;
    for (let i = 0; i < 120; i++) {
      const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ id?: string; workerId?: string; state: string }>;
      if (workers.find((x) => (x.workerId ?? x.id) === workerId)?.state === 'online') {
        online = true;
        break;
      }
      await page.waitForTimeout(500);
    }
    expect(online, 'worker 没有上线').toBe(true);
    const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 排序 ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers })).json()) as { id: string };
    const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '排序任务' }, headers })).json()) as { id: string };
    const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: 'fakeacp', model: '' }, headers });
    expect(derived.ok(), await derived.text()).toBe(true);
    const session = (await derived.json()) as { id: string };
    const say = async (text: string) => {
      const res = await page.request.post(`/api/sessions/${session.id}/prompt`, { data: { text }, headers });
      expect(res.ok(), await res.text()).toBe(true);
      return (await res.json()) as { seq: number; deliveryId: string; state: string };
    };

    // A 卡在运行时里（只在 .started 落盘后才继续），B 这才发出去。
    const a = await say('第一轮 A please-hold:a');
    expect(a.state).toBe('sending');
    await expect.poll(() => starts('hold-a'), { timeout: 60_000, message: 'A 没有进运行时' }).toBe(1);
    const b = await say('第二轮 B please-mark:b');
    expect(b.state, 'A 还在跑，B 只能排队').toBe('queued');

    // 界面上：A 发送中，B 排队等上一条。
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/#/p/${project.id}/focus/${session.id}`);
    const log = page.getByRole('log', { name: '会话记录' });
    await expect(log.getByText('hold:a 开始')).toBeVisible({ timeout: 30_000 });
    await expect(log.getByText('第二轮 B please-mark:b')).toBeVisible();
    const notes = page.getByTestId('delivery-note');
    await expect(notes).toHaveCount(2);
    await expect(notes.nth(0)).toHaveText('发送中…');
    await expect(notes.nth(1)).toHaveText('排队中 · 等上一条送达');

    // 队列事实：A sending、B queued；B 的 nextAt 还是 null（泵没把它当到期项）。
    type Dto = { id: string; seq: number; state: string; nextAt: number | null };
    const rows = async () => (await (await page.request.get(`/api/sessions/${session.id}/deliveries`)).json()) as Dto[];
    const mine = (list: Dto[]) => ({
      a: list.find((d) => d.id === a.deliveryId),
      b: list.find((d) => d.id === b.deliveryId)
    });
    await expect.poll(async () => {
      const { a: rowA, b: rowB } = mine(await rows());
      return `${rowA?.state}/${rowB?.state}/${rowB?.nextAt}`;
    }, { timeout: 30_000 }).toBe('sending/queued/null');

    // 给定时泵（1 秒一次）几轮机会：B 仍然没有进运行时，A 也没有被重新起一轮。
    await page.waitForTimeout(3_000);
    expect(starts('mark-b'), 'B 在 A 结束前就进了运行时').toBe(0);
    expect(starts('hold-a'), 'A 被重复派发').toBe(1);
    await expect(notes.nth(1)).toHaveText('排队中 · 等上一条送达');

    // 让 A 真的结束：此后 B 才能进入运行时。
    writeFileSync(join(gate, 'hold-a.go'), 'go\n');
    await expect.poll(() => starts('mark-b'), { timeout: 90_000, message: 'A 结束后 B 没有进运行时' }).toBe(1);

    // journal 证据：A 的 ended 在 B 的文字之前，B 的 ended 在 B 的文字之后，各带自己的 deliveryId。
    type Entry = { seq: number; event: { kind: string; delta?: string; deliveryId?: string; outcome?: string } };
    const events = async () => (await (await page.request.get(`/api/sessions/${session.id}/events`)).json()) as Entry[];
    const isEndedB = (e: Entry) => e.event.kind === 'ended' && e.event.deliveryId === b.deliveryId;
    await expect.poll(async () => (await events()).some(isEndedB), { timeout: 30_000 }).toBe(true);
    const journal = await events();
    const at = (predicate: (e: Entry) => boolean) => journal.findIndex(predicate);
    const endedA = at((e) => e.event.kind === 'ended' && e.event.deliveryId === a.deliveryId);
    const bText = at((e) => e.event.kind === 'text' && (e.event.delta ?? '').includes('marked:b'));
    const endedB = at(isEndedB);
    expect(endedA, 'A 的 ended 没落盘').toBeGreaterThan(-1);
    expect(bText, 'B 的文字没落盘').toBeGreaterThan(endedA);
    expect(endedB, 'B 的 ended 没落盘').toBeGreaterThan(bText);
    expect(journal[endedA]!.event.outcome).toBe('done');

    // 两条都送达后气泡下恢复安静。
    await expect(log.getByText('marked:b 开跑')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('delivery-note')).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(async () => {
      const { a: rowA, b: rowB } = mine(await rows());
      return `${rowA?.state}/${rowB?.state}`;
    }, { timeout: 30_000 }).toBe('delivered/delivered');
  } finally {
    worker.kill();
    await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
    rmSync(state, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
