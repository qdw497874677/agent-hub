import { existsSync, readdirSync, rmSync } from 'node:fs';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { currentRun } from './run-id.ts';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, stopFakeWorker } from './fake-worker.ts';

/**
 * 「仅对话」：这条任务只聊天，不需要仓库里的代码。
 *
 * 项目照常绑一个仓库（URL 指向保留域名 .invalid，任何误克隆都立刻失败、不会出网），
 * 但选了「仅对话」之后：
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

test('仅对话：空的临时目录，不下载仓库，会话照常聊天（桌面 + 手机都能看到）', async ({ page, baseURL }) => {
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
    await expect(empty).toContainText('仅对话');
    await expect(empty).toContainText('空的临时目录，不下载仓库、不运行准备命令');
    await expect(dialog.getByTestId('ws-advanced')).toHaveCount(0);
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toHaveCount(0);
  });

  await test.step('手机：仍在常用选项里，选中后复核行说清是仅对话', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const dialog = await openDialog(page, project.id);
    const empty = dialog.getByTestId('ws-new-empty');
    await expect(empty).toBeVisible();
    // 常用方式不能藏进折叠区：手机上「更多创建方式」默认收起时也看得到。
    await expect(dialog.getByTestId('ws-advanced').getByTestId('ws-new-empty')).toHaveCount(0);
    // 手机上 agent 区默认折叠；先选 agent，机器才会落到提供它的假 ACP 上。
    if (!(await dialog.locator('#derive-agent').isVisible())) {
      await dialog.getByTestId('derive-agent-section').locator('summary').click();
    }
    await dialog.locator('#derive-agent').selectOption(AGENT_ID);
    await empty.scrollIntoViewIfNeeded();
    await empty.click();
    await expect(empty).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByTestId('derive-review')).toContainText('仅对话 · 空的临时目录');
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
