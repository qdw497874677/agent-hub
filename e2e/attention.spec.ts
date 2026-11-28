import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type Request } from '@playwright/test';
import { loginByApi } from './login.ts';
import { e2eWorkerPath, e2eWorkerRoots } from './isolation.ts';

/**
 * 等我处理（ADR 0031 P4）：显式提问 → 等回答；问号结尾 → 可能在等你；这一轮 commit → 等审查；失败 → 失败了。
 * 首页顶部收件箱 + 角标 + 标题 (N)；「稍后」收起；打开会话停几秒自动看过。用假 ACP agent。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'];
const FAKE = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');

test('等我处理：四种要人的状态上榜，角标和标题带数，稍后 / 打开即收起', async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const code = ((await (await page.request.post('/api/workers/pairing', { data: {}, headers })).json()) as { code: string }).code;
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  const PATH = e2eWorkerPath();
  const label = `e2e 待办机器 ${Date.now().toString(36)}`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], { env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label }, encoding: 'utf8' });
  expect(enrolled.status).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-att-'));
  const agents = [{ id: 'fakeacp', label: '假 ACP', command: process.execPath, args: [FAKE], listModelsArgs: [FAKE, '--models'] }];
  const worker: ChildProcess = spawn(process.execPath, ['apps/worker/src/main.ts'], {
    env: {
      PATH, HOME: state, HUB_URL: hubUrl, HUB_WORKER_CREDENTIAL: credential, WORKER_ID: workerId, WORKER_ORIGIN: 'remote', WORKER_LABEL: label,
      WORKER_ROOTS: e2eWorkerRoots(), WORKER_STATE_DIR: state, WORKER_RUNTIMES_DIR: join(state, 'runtimes'), ACP_AGENTS: JSON.stringify(agents)
    },
    stdio: 'ignore'
  });
  const dir = mkdtempSync(join(tmpdir(), 'e2e-att-'));
  try {
    for (let i = 0; i < 120; i++) {
      const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ id?: string; workerId?: string; state: string }>;
      if (workers.find((x) => (x.workerId ?? x.id) === workerId)?.state === 'online') break;
      await page.waitForTimeout(500);
    }
    const projectName = `e2e 待办 ${Date.now().toString(36)}`;
    const project = (await (await page.request.post('/api/projects', { data: { name: projectName, rootPath: dir, workerId }, headers })).json()) as { id: string };
    const run = async (title: string, text: string) => {
      const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title }, headers })).json()) as { id: string };
      const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: 'fakeacp', model: '' }, headers });
      expect(derived.ok(), await derived.text()).toBe(true);
      const s = (await derived.json()) as { id: string };
      expect((await page.request.post(`/api/sessions/${s.id}/prompt`, { data: { text }, headers })).ok()).toBe(true);
      return s.id;
    };
    const ids = {
      answer: await run('待办·显式提问', 'please-asktool'),
      maybe: await run('待办·问号结尾', 'please-question'),
      review: await run('待办·提交了', 'please-commit'),
      failed: await run('待办·失败', 'please-refuse'),
      quiet: await run('待办·安静', 'OK')
    };
    type Att = { items: Array<{ sessionId: string; phase: string; possible: boolean; since: number }>; working: number };
    let att: Att = { items: [], working: 0 };
    await expect.poll(async () => {
      att = (await (await page.request.get('/api/attention')).json()) as Att;
      return att.items.filter((i) => Object.values(ids).includes(i.sessionId)).length;
    }, { timeout: 60_000 }).toBe(4);
    const phase = (id: string) => att.items.find((i) => i.sessionId === id);
    expect(phase(ids.answer)).toMatchObject({ phase: 'needs_answer', possible: false });
    expect(phase(ids.maybe)).toMatchObject({ phase: 'needs_answer', possible: true });
    expect(phase(ids.review)?.phase).toBe('needs_review');
    expect(phase(ids.failed)?.phase).toBe('failed');
    expect(phase(ids.quiet)).toBeUndefined();

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/#/home');
    const inbox = page.getByTestId('attention-inbox');
    await expect(inbox).toContainText('等我处理');
    await expect(inbox).toContainText('等回答');
    await expect(inbox).toContainText('可能在等你');
    await expect(inbox).toContainText('等审查');
    await expect(inbox).toContainText('失败了');
    const n = att.items.length;
    await expect(page.getByTestId('attention-count')).toContainText(String(n));
    await expect.poll(() => page.title()).toMatch(new RegExp(`^\\(${n}\\) `));

    // 刷新：点一下立刻去拉这一屏的四个接口（首页 / 待办 / 派发 / 连接器提示），
    // 不是等 8–15 秒的下一轮。5 秒窗口内四个都到齐，才说明是这次点击拉起来的。
    const search = page.getByRole('combobox', { name: '搜项目、任务或会话' });
    await search.fill('待办');
    const seen: string[] = [];
    const watch = (req: Request) => seen.push(new URL(req.url()).pathname);
    page.on('request', watch);
    await page.getByTestId('home-refresh').click();
    await expect
      .poll(
        () => ['/api/home', '/api/attention', '/api/dispatch', '/api/connectors/notices'].filter((path) => !seen.includes(path)),
        { timeout: 5_000 }
      )
      .toEqual([]);
    page.off('request', watch);
    // 刷新不碰搜索框里的字
    await expect(search).toHaveValue('待办');
    await search.fill('');

    // 失败要看得见，而且同一个按钮还能再点（恢复网络后重试一次就清掉错误）
    await page.route('**/api/home', (route) => route.abort());
    await page.getByTestId('home-refresh').click();
    await expect(page.getByTestId('home-refresh-error')).toBeVisible();
    await page.unroute('**/api/home');
    await page.getByTestId('home-refresh').click();
    await expect(page.getByTestId('home-refresh-error')).toHaveCount(0);

    if (SHOTS) await page.screenshot({ path: `${SHOTS}/attention-1280.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    // 手机上刷新是 44px 的实心触区，不用去顶栏挤第 6 个动作
    const mobileRefresh = await page.getByTestId('home-refresh').boundingBox();
    expect(mobileRefresh?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(mobileRefresh?.height ?? 0).toBeGreaterThanOrEqual(44);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/attention-390.png` });

    // 稍后：收起这一条
    // 手机首页仅预览前三条；展开后再操作本用例创建的条目。
    const more = inbox.getByTestId('attention-more');
    if (await more.count()) await more.click();
    const laterItem = inbox.getByTestId('attention-item').filter({ hasText: projectName }).filter({ hasText: '待办·问号结尾' });
    await laterItem.getByTestId('attention-menu').click();
    await page.getByTestId('attention-row-menu').getByRole('menuitem', { name: '稍后处理' }).click();
    await expect(laterItem).toHaveCount(0);
    // 打开会话停几秒 = 看过
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/#/p/${project.id}/focus/${ids.review}`);
    await expect(page.getByTestId('attention-count')).toContainText(String(n - 1));
    await expect(page.getByTestId('attention-count')).toContainText(String(n - 2), { timeout: 15_000 });
    // 需要人回答的条目打开后仍然留着：不能靠「看过」替用户把问题吞掉。
    await page.goto(`/#/p/${project.id}/focus/${ids.answer}`);
    await page.waitForTimeout(4_500);
    await expect(page.getByTestId('attention-count')).toContainText(String(n - 2));
    await page.goto('/#/home');
    await expect(page.getByTestId('attention-item').filter({ hasText: projectName }).filter({ hasText: '待办·显式提问' })).toHaveCount(1);
    // 阶段变了重新上榜：失败那条再说一句提问
    await page.request.post(`/api/sessions/${ids.maybe}/prompt`, { data: { text: 'please-asktool' }, headers });
    await expect.poll(async () => {
      const a = (await (await page.request.get('/api/attention')).json()) as Att;
      return a.items.find((i) => i.sessionId === ids.maybe)?.possible;
    }, { timeout: 30_000 }).toBe(false);
  } finally {
    worker.kill();
    await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
    rmSync(state, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
