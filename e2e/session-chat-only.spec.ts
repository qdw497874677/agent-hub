import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { currentRun } from './run-id.ts';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, stopFakeWorker } from './fake-worker.ts';

/**
 * 不下载仓库与会话所在目录是两个独立选择。
 *
 * 项目照常绑一个仓库（URL 指向保留域名 .invalid，任何误克隆都立刻失败、不会出网），
 * 选「不下载」和空临时目录后：
 * - 工作目录是真的空临时目录（不是 worktree、没有 .git、没有准备命令）；
 * - 工作目录元数据是 created / isGit=false / branch=null / repoUrl=null；
 * - 会话照常能起、能对话——假 ACP 对含 OK 的消息只回 `OK`。
 *
 * 同时确认这个选项在桌面和手机上都不用展开「更多创建方式」就能看到。
 */

const AGENT_ID = 'fakeacpchat';
const RUN = currentRun();
const NAME = `仅对话-${RUN}`;
const TASK_TITLE = `纯聊天-${RUN}`;
const REPO_URL = 'https://chat-only.invalid/e2e/chat-only.git';

test.afterAll(() => {
  stopFakeWorker();
});

async function openDialog(page: Page, projectId: string): Promise<Locator> {
  await page.goto(`/#/p/${projectId}/canvas`);
  await page
    .locator('.react-flow__node-task')
    .filter({ hasText: TASK_TITLE })
    .getByRole('button', { name: '＋ 会话' })
    .click();
  const dialog = page.getByRole('dialog', { name: '开始会话' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('不下载仓库：空的临时目录，会话照常聊天（桌面 + 手机）', async ({ page, baseURL }) => {
  await loginByApi(page);
  // 只让这个 spec 的假 ACP 机器提供选中的 agent，避免本机 Pi 的探测状态干扰机器列表。
  await ensureFakeWorker(page, baseURL!, AGENT_ID);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };

  const made = await page.request.post('/api/projects', {
    data: {
      name: NAME,
      repos: [{ name: 'chat-only', url: REPO_URL, defaultBranch: 'main' }]
    },
    headers
  });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string };
  const configured = await page.request.patch(`/api/projects/${project.id}`, {
    data: { worktree: { mode: 'isolated', setup: { command: 'touch should-not-run', waitForSetup: true, timeoutSeconds: 30 } } }, headers
  });
  expect(configured.ok(), await configured.text()).toBe(true);
  const taskResponse = await page.request.post('/api/tasks', {
    data: { projectId: project.id, title: TASK_TITLE },
    headers
  });
  expect(taskResponse.ok(), await taskResponse.text()).toBeTruthy();
  const task = (await taskResponse.json()) as { id: string };
  let workspacePath = '';

  await test.step('桌面：直接可见，不用展开「更多创建方式」', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const dialog = await openDialog(page, project.id);
    const empty = dialog.getByTestId('ws-new-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toHaveAttribute('role', 'radio');
    await expect(empty).toHaveAttribute('aria-checked', 'false');
    const download = dialog.getByTestId('ws-download-repo');
    await expect(download).toHaveAccessibleName('下载仓库');
    await expect(download).not.toBeChecked();
    await expect(empty).toContainText('新建空的临时目录');
    await download.check();
    await expect(empty).toHaveCount(0);
    await expect(dialog.getByTestId('ws-new-worktree')).toBeVisible();
    await download.uncheck();
    await expect(empty).toBeVisible();
    await expect(dialog.getByTestId('ws-advanced')).toHaveCount(0);
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toHaveCount(0);
  });

  await test.step('手机：目录和下载分开，复核行明确空临时目录', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const dialog = await openDialog(page, project.id);
    const empty = dialog.getByTestId('ws-new-empty');
    await expect(empty).toBeVisible();
    await expect(dialog.getByTestId('ws-download-repo')).not.toBeChecked();
    // 常用方式不能藏进折叠区：手机上「更多创建方式」默认收起时也看得到。
    await expect(dialog.getByTestId('ws-advanced').getByTestId('ws-new-empty')).toHaveCount(0);
    // 选假 ACP 后，如果已经选了别的机器，需明确切换到提供它的机器。
    if (!(await dialog.locator('#derive-agent').isVisible())) {
      await dialog.getByTestId('derive-agent-section').locator('summary').click();
    }
    await dialog.locator('#derive-agent').selectOption(AGENT_ID);
    const switchMachine = dialog.getByTestId('machine-select-alternative');
    if (await switchMachine.isVisible()) await switchMachine.click();
    await empty.scrollIntoViewIfNeeded();
    await empty.click();
    await expect(empty).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByTestId('derive-review')).toContainText('新建空的临时目录');
    const start = dialog.getByRole('button', { name: '开始', exact: true });
    await expect(start).toBeEnabled();
    await start.click();
    await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  });

  await test.step('建出来的是真的空临时目录，不是仓库检出', async () => {
    type WorkspaceView = {
      workspace: {
        path: string;
        kind: string;
        source: string;
        isGit: boolean | null;
        branch: string | null;
        repoUrl: string | null;
        ownerTaskId: string | null;
        state: string;
        setup: unknown;
      };
    };
    let mine: WorkspaceView | undefined;
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`/api/projects/${project.id}/workspaces`);
          if (!response.ok()) return null;
          const views = (await response.json()) as WorkspaceView[];
          mine = views.find((view) => view.workspace.ownerTaskId === task.id);
          return mine?.workspace.state ?? null;
        },
        { timeout: 30_000, message: '等仅对话的临时工作目录建好' }
      )
      .toBe('ready');
    expect(mine).toBeTruthy();
    const workspace = mine!.workspace;
    workspacePath = workspace.path;
    expect(workspace.kind).toBe('temporary');
    expect(workspace.source, '空目录是新建的，不是 linked / cloned / worktree').toBe('created');
    expect(workspace.isGit, '不是 git 检出').toBe(false);
    expect(workspace.branch, '没有开分支').toBeNull();
    expect(workspace.repoUrl, '没有碰到项目仓库').toBeNull();
    expect(workspace.setup, '没有跑准备命令').toBeNull();
    expect(workspace.path).toContain('/agent-hub-workspaces/.tmp/');
    expect(workspace.path).not.toContain('/.worktrees/');
    expect(existsSync(workspace.path), `目录真的建出来了：${workspace.path}`).toBe(true);
    expect(readdirSync(workspace.path), '目录是空的：没有 .git，也没有仓库文件').toEqual([]);
  });

  await test.step('正常聊天：假 ACP 回 OK', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/#/p/${project.id}/canvas`);
    const card = page.locator('.react-flow__node-session').first();
    await expect(card).toBeVisible();
    const composer = card.getByLabel(/说一句/);
    await composer.fill('只回这段文字，不要用工具：OK');
    await composer.press('Control+Enter');
    await expect(composer).toHaveValue('');
    await expect(card.getByTestId('session-card-log').getByText('OK', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(card.getByTestId('card-status')).toHaveText('已完成');
  });

  await test.step('派生沿用了刚建的目录，没有再建第二个', async () => {
    const views = (await (await page.request.get(`/api/projects/${project.id}/workspaces`)).json()) as Array<{
      workspace: { ownerTaskId: string | null };
    }>;
    expect(views.filter((view) => view.workspace.ownerTaskId === task.id), '只建了一个临时目录').toHaveLength(1);
  });

  const sessions = (await (await page.request.get(`/api/projects/${project.id}/canvas`)).json()) as {
    sessions?: Array<{ id: string }>;
  };
  for (const session of sessions.sessions ?? []) {
    await page.request.post(`/api/sessions/${session.id}/interrupt`, { data: {}, headers });
  }
  await page.request.delete(`/api/projects/${project.id}`, { data: { confirmName: NAME }, headers });
  if (workspacePath !== '' && existsSync(workspacePath)) rmSync(workspacePath, { recursive: true, force: true });
});

for (const width of [1280, 390]) {
  test.describe(`仓库准备与目录 ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: width < 640, isMobile: width < 640 });
    test('复用已有 Git、创建空持久目录、显式下载后重试不重复创建', async ({ page, baseURL }) => {
      const root = mkdtempSync(join(tmpdir(), 'ah-session-repo-'));
      const existing = join(root, 'existing');
      const empty = join(root, 'empty');
      const source = join(root, 'source');
      const checkout = join(root, 'checkout');
      try {
        for (const dir of [existing, empty, source, checkout]) mkdirSync(dir);
        for (const [dir, text] of [[existing, 'keep old'], [source, 'fresh checkout']] as const) {
          execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
          writeFileSync(join(dir, 'marker.txt'), text);
          execFileSync('git', ['-C', dir, 'add', 'marker.txt']);
          execFileSync('git', ['-C', dir, '-c', 'user.name=E2E', '-c', 'user.email=e2e@example.invalid', 'commit', '-qm', 'seed']);
        }
        await loginByApi(page);
        const workerId = await ensureFakeWorker(page, baseURL!, AGENT_ID);
        const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
        const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
        const post = async <T>(url: string, data: unknown): Promise<T> => {
          const res = await page.request.post(url, { data, headers });
          expect(res.ok(), await res.text()).toBe(true);
          return await res.json() as T;
        };
        const project = await post<{ id: string }>('/api/projects', {
          name: `仓库准备 ${width} ${RUN}`, repos: [{ name: 'source', url: `file://${source}`, defaultBranch: 'main' }]
        });
        const task = await post<{ id: string }>('/api/tasks', { projectId: project.id, title: TASK_TITLE });
        const linked = await post<{ id: string }>(`/api/projects/${project.id}/workspaces`, {
          kind: 'long_lived', mode: 'link', path: existing, workerId
        });
        type Made = { id: string; path: string; isGit: boolean; repoUrl: string | null; setup: unknown };
        const workspaces: Array<{ input: Record<string, unknown>; result: Made }> = [];
        await page.route(`**/api/projects/${project.id}/workspaces`, async (route) => {
          if (route.request().method() !== 'POST') return route.fallback();
          const response = await route.fetch();
          expect(response.status(), await response.text()).toBe(201);
          workspaces.push({ input: route.request().postDataJSON(), result: await response.json() });
          await route.fulfill({ response });
        });
        const starts: Record<string, unknown>[] = [];
        let rejectNext = false;
        await page.route('**/api/sessions/derive', async (route) => {
          starts.push(route.request().postDataJSON());
          if (!rejectNext) return route.fallback();
          rejectNext = false;
          await route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: '测试：启动暂不可用' } } });
        });
        const dialogForMachine = async () => {
          const dialog = await openDialog(page, project.id);
          if (!(await dialog.locator('#derive-agent').isVisible())) {
            await dialog.getByTestId('derive-agent-section').locator('summary').click();
          }
          await dialog.locator('#derive-agent').selectOption(AGENT_ID);
          const alternative = dialog.getByTestId('machine-select-alternative');
          if (await alternative.isVisible()) await alternative.click();
          await expect(dialog.getByTestId('ws-download-repo')).not.toBeChecked();
          return dialog;
        };
        let dialog = await dialogForMachine();
        await dialog.getByRole('radio', { name: /existing/ }).click();
        await dialog.getByRole('button', { name: '开始', exact: true }).click();
        await expect(dialog).toBeHidden();
        expect(starts[0]).toMatchObject({ taskId: task.id, workerId, workspaceId: linked.id });
        expect(workspaces).toHaveLength(0);
        expect(readFileSync(join(existing, 'marker.txt'), 'utf8')).toBe('keep old');

        const pickPath = async (path: string) => {
          await dialog.getByTestId('ws-new-long-lived').click();
          // 手机上的目录选择器可能挂在 dialog 外面。
          await page.getByRole('button', { name: '输入路径', exact: true }).click();
          await page.getByRole('textbox', { name: '路径', exact: true }).fill(path);
          await page.getByRole('button', { name: '前往', exact: true }).click();
          const choose = page.getByRole('button', { name: '选此文件夹', exact: true });
          await expect(choose).toBeEnabled();
          await choose.click();
          await expect(choose).toBeHidden();
        };
        dialog = await dialogForMachine();
        await pickPath(empty);
        await dialog.getByRole('button', { name: '开始', exact: true }).click();
        await expect(dialog).toBeHidden();
        expect(workspaces[0]).toMatchObject({ input: { kind: 'long_lived', mode: 'empty', workerId, path: empty }, result: { path: empty, isGit: false, repoUrl: null, setup: null } });
        expect(starts[1]).toMatchObject({ taskId: task.id, workerId, workspaceId: workspaces[0]!.result.id });
        expect(readdirSync(empty)).toEqual([]);

        dialog = await dialogForMachine();
        await dialog.getByTestId('ws-download-repo').check();
        await expect(dialog.getByRole('radio', { name: /existing/ })).toHaveCount(0);
        await expect(dialog.getByRole('button', { name: '开始', exact: true })).toBeDisabled();
        await pickPath(checkout);
        expect(workspaces).toHaveLength(1); // Selecting a place alone does not download.
        rejectNext = true;
        await dialog.getByRole('button', { name: '开始', exact: true }).click();
        await expect(dialog.getByText('测试：启动暂不可用')).toBeVisible();
        expect(workspaces[1]).toMatchObject({ input: { kind: 'long_lived', mode: 'create', workerId, path: checkout }, result: { path: checkout, isGit: true } });
        expect(readFileSync(join(checkout, 'marker.txt'), 'utf8')).toBe('fresh checkout');
        await dialog.getByRole('button', { name: '重试', exact: true }).click();
        await expect(dialog).toBeHidden();
        expect(workspaces).toHaveLength(2);
        expect(starts.slice(2)).toHaveLength(2);
        for (const start of starts.slice(2)) expect(start).toMatchObject({ taskId: task.id, workerId, workspaceId: workspaces[1]!.result.id });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}
