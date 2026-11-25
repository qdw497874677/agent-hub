import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { e2eWorkerPath, e2eWorkerRoots } from './isolation.ts';

/**
 * 手机专注对话的两件事（390 / 320 CSS px，桌面 1280 回归）：
 *
 * 1. 只留**一条**可信进度：气泡下面 / 输入框上方 / 「⋯」不再各说一句；
 *    送达（服务端事实）和运行时（agent 真的动了）分开说，等太久也不自己变成失败。
 * 2. 输入区收干净：换提供商的提醒进模型选择器，「分支 / 路径 / 添加仓库」收进「工作区」抽屉，
 *    桌面布局一点不动。
 *
 * 用假 ACP agent + `--gate-dir` 把这一轮卡在「已经进了运行时、还没吐第一个块」的位置：
 * 这样「等第一条输出」是可断言的状态，而不是靠 sleep 抢时间。
 */
const FAKE = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');
const SHOTS = process.env['E2E_SCREENSHOTS'];

test('手机专注对话：一条进度 + 工作区入口 + 换提供方提醒在选择器里', async ({ page, baseURL, context }) => {
  test.setTimeout(240_000);
  await loginByApi(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const csrf = (await context.cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };

  const code = ((await (await page.request.post('/api/workers/pairing', { data: {}, headers })).json()) as { code: string }).code;
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  const PATH = e2eWorkerPath();
  const label = `e2e 手机进度机器 ${Date.now().toString(36)}`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], { env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: label }, encoding: 'utf8' });
  expect(enrolled.status).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');

  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-mobile-'));
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
  const online = async () => {
    for (let i = 0; i < 120; i++) {
      const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ id?: string; workerId?: string; state: string }>;
      if (workers.find((x) => (x.workerId ?? x.id) === workerId)?.state === 'online') return;
      await page.waitForTimeout(500);
    }
    throw new Error('worker 没有上线');
  };

  const dir = mkdtempSync(join(tmpdir(), 'e2e-mobile-dir-'));
  try {
    await online();
    const git = (...args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e', 'commit', '-q', '--allow-empty', '-m', 'init');

    const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 手机进度 ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers })).json()) as { id: string };
    // 项目里再登记一个仓库：单仓会话不该长出「添加仓库」——入口在、点了有反应才算数。
    const patched = await page.request.patch(`/api/projects/${project.id}`, {
      data: {
        repos: [
          { name: 'second', url: 'https://example.invalid/acme/second.git', defaultBranch: 'main' },
          { name: 'third', url: 'https://example.invalid/acme/third.git', defaultBranch: 'main' }
        ]
      },
      headers
    });
    expect(patched.ok(), await patched.text()).toBe(true);
    const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '手机进度' }, headers })).json()) as { id: string };
    const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: 'fakeacp', model: '' }, headers });
    expect(derived.ok(), await derived.text()).toBe(true);
    const session = (await derived.json()) as { id: string };

    // 原生模型之间切换不涉及重新托管，不显示跨提供商提醒。
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/#/p/${project.id}/focus/${session.id}`);
    await page.getByRole('button', { name: /^Agent 和模型：/ }).click();
    await expect(page.getByRole('dialog', { name: '选择Agent 和模型' })).not.toContainText('需要重启');
    await page.getByRole('button', { name: '取消' }).click();

    // Hub 模型与本机模型并存时，把不能原地切换的原因留在选择器里。
    const seeded = await page.request.post('/api/providers', {
      data: {
        slug: `e2e-scope-${Date.now().toString(36)}`,
        name: 'E2E 范围提醒',
        protocol: 'openai-chat',
        baseUrl: 'http://127.0.0.1:9/v1',
        models: ['scope1'],
        routing: 'direct',
        scope: 'hub',
        enabled: true,
        apiKey: 'e2e-not-a-real-key'
      },
      headers
    });
    expect(seeded.ok(), await seeded.text()).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    // 单仓会话没有可加的仓库：记一下是否有人偷偷发了请求。
    let addCalls = 0;
    await page.route('**/api/workspace-groups/*/members', async (route) => {
      addCalls += 1;
      await route.continue();
    });
    await page.goto(`/#/p/${project.id}/focus/${session.id}`);
    // 同地址的 hash 导航不会刷新之前的模型缓存；重新载入后读取新建提供商。
    await page.reload();
    const log = page.getByRole('log', { name: '会话记录' });
    const hint = page.getByTestId('turn-hint');

    // —— 发送中：文案只有一条，且在对话末尾（不在输入框上方，也不在气泡下面重复）
    let delayPrompt = true;
    let releaseFirst: (() => void) | undefined;
    const promptIds: string[] = [];
    await page.route('**/api/sessions/*/prompt', async (route) => {
      const payload = route.request().postDataJSON() as { clientMessageId?: string };
      if (payload.clientMessageId) promptIds.push(payload.clientMessageId);
      if (!delayPrompt) return route.continue();
      delayPrompt = false;
      await new Promise<void>((done) => { releaseFirst = done; });
      await route.continue();
    });
    await page.getByLabel('发送消息').fill('please-hold:h1');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(hint).toHaveAttribute('data-stage', 'delivery', { timeout: 2_000 });
    await expect(hint).toContainText('正在发送…');
    await expect(page.getByTestId('pending-prompts')).toHaveCount(1);
    await expect(page.getByTestId('pending-state')).toHaveCount(0); // 窄屏不再在气泡下补一行
    await expect(page.getByTestId('delivery-note')).toHaveCount(0);
    await expect(page.getByTestId('turn-progress')).toHaveCount(0); // 输入框上方不再重复
    for (const width of [1280, 1440, 320, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(hint).toHaveAttribute('data-stage', 'delivery');
      await expect(page.getByTestId('pending-state')).toHaveCount(0);
      await expect(page.getByTestId('turn-progress')).toHaveCount(0);
    }
    await expect(page.getByTestId('pending-unknown')).toBeVisible({ timeout: 12_000 });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(page.getByTestId('pending-unknown')).toContainText('未收到回执');
      await expect(page.getByTestId('pending-unknown')).toContainText('重试会沿用同一消息');
      await expect(page.getByTestId('pending-unknown')).toContainText('不会取消消息');
      await expect(hint).toHaveCount(0);
    }
    await page.getByTestId('pending-retry').click();
    await expect.poll(() => promptIds.length).toBe(2);
    expect(promptIds[1]).toBe(promptIds[0]);
    releaseFirst?.();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'mobile-signal-sending.png') });

    // —— 进了运行时：只说运行时的事实（假 agent 进门控后先吐一句再等放行），
    // 不再挂着「发送中…」，也不再宣称「正在启动」（启动是从没块推断出来的）。
    await expect(hint).toHaveAttribute('data-stage', 'runtime', { timeout: 30_000 });
    await expect(hint).toHaveText('正在输出…');
    await expect(log.getByText('please-hold:h1')).toBeVisible();
    // 进度合并不移除消息菜单；「从这里重来」仍从这里进入。
    await expect(log.getByTestId('msg-menu').last()).toBeVisible();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'mobile-signal-waiting.png') });

    // —— 工作区抽屉：分支、路径、复制、添加仓库、去 git 都在里面
    await expect(page.getByTestId('git-branch')).toHaveCount(0); // 窄屏不再平铺
    await expect(page.getByTestId('composer-status').getByTestId('workspace-entry')).toBeVisible();
    await page.getByTestId('workspace-entry').click();
    const sheet = page.getByTestId('workspace-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('workspace-branch')).toHaveText('main');
    await expect(sheet.getByTestId('workspace-path')).toHaveText(dir);
    await sheet.getByTestId('workspace-copy-path').click();
    await expect(sheet.getByTestId('workspace-copy-path')).toHaveText('已复制');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(dir);
    await expect(sheet.getByTestId('repo-add')).toHaveCount(0); // 单仓会话不再假装能加仓库
    await expect(sheet.getByTestId('workspace-repo-hint')).toBeVisible();
    await expect(sheet.getByTestId('workspace-repo-hint')).toContainText('组合工作目录');
    expect(addCalls, '单仓会话不该发出加仓库请求').toBe(0);
    await expect(sheet.getByTestId('workspace-git')).toBeVisible(); // 分支操作仍然可达
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'mobile-workspace-sheet.png') });
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    // —— 换提供商的提醒：进模型选择器，选之前就能看见；输入区下面不再常驻一行
    await expect(page.getByTestId('hub-switch-note')).toBeHidden();
    await page.getByRole('button', { name: /^Agent 和模型：/ }).click();
    await expect(page.getByTestId('model-scope-note')).toBeVisible();
    await expect(page.getByRole('option', { name: /scope1/ })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('option', { name: /scope1/ })).toContainText('需要重启，暂不支持在此切换');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'mobile-model-note.png') });
    await page.getByRole('button', { name: '取消' }).click();
    await expect(page.getByTestId('model-scope-note')).toHaveCount(0);

    // —— 320：一格也不横向溢出，入口还在
    await page.setViewportSize({ width: 320, height: 720 });
    await expect(hint).toBeVisible();
    await expect(page.getByTestId('workspace-entry')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, '320 宽不该横向滚动').toBeLessThanOrEqual(1);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'mobile-signal-320.png') });

    // —— 桌面回归：进度与手机一致，分支仍平铺，模型提示只在选择器中出现
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('turn-hint')).toHaveAttribute('data-stage', 'runtime');
    await expect(page.getByTestId('turn-hint')).toHaveText('正在输出…');
    await expect(page.getByTestId('turn-progress')).toHaveCount(0);
    await expect(page.getByTestId('delivery-note')).toHaveCount(0);
    await expect(page.getByTestId('git-branch')).toBeVisible();
    await expect(page.getByTestId('workspace-entry')).toHaveCount(0);
    await expect(page.getByTestId('hub-switch-note')).toHaveCount(0);
    await page.getByRole('button', { name: /^Agent 和模型：/ }).click();
    await expect(page.getByRole('option', { name: /scope1/ })).toHaveAttribute('aria-disabled', 'true');
    await page.getByRole('button', { name: '取消' }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(hint).toHaveAttribute('data-stage', 'runtime');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'mobile-signal-1280.png') });

    // —— 放开这一轮：进度自己消失，不残留一行「在等」
    await page.setViewportSize({ width: 390, height: 844 });
    writeFileSync(join(gate, 'hold-h1.go'), '');
    await expect(page.getByTestId('turn-hint')).toHaveCount(0, { timeout: 30_000 });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/#/p/${project.id}/canvas`);
    await expect(page.locator('.react-flow__node-session').first()).toBeVisible();
    await expect(page.getByTestId('hub-switch-note-card')).toHaveCount(0);
    await page.locator('.react-flow__node-session').first().getByRole('button', { name: /^Agent 和模型：/ }).click();
    await expect(page.getByRole('option', { name: /scope1/ })).toHaveAttribute('aria-disabled', 'true');
  } finally {
    worker.kill();
    await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
    rmSync(state, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
