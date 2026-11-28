import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openDocumentNewMenu } from './document-tabs.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { loginByApi } from './login.ts';

type Session = { id: string; taskId: string; workerId: string; workspaceId: string | null; groupId: string | null };

async function setup(page: Page, origin: string, root: string, width: number) {
  await loginByApi(page);
  const workerId = await ensureFakeWorker(page, origin);
  const csrf = (await page.context().cookies(origin)).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin, 'x-hub-csrf': csrf };
  const post = async <T>(url: string, data: unknown, status = 201): Promise<T> => {
    const response = await page.request.post(url, { headers, data });
    expect(response.status(), await response.text()).toBe(status);
    return await response.json() as T;
  };
  const project = await post<{ id: string }>('/api/projects', { name: `标签不改变落点 ${width} ${Date.now()}` });
  const task = await post<{ id: string }>('/api/tasks', { projectId: project.id, title: '独立会话标签' });
  const path = join(root, 'repo');
  mkdirSync(path);
  const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(path, 'file.txt'), 'existing checkout\n');
  git('add', 'file.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');
  const workspace = await post<{ id: string }>(`/api/projects/${project.id}/workspaces`, { workerId, mode: 'link', kind: 'long_lived', path });
  const first = await post<Session>('/api/sessions/derive', { taskId: task.id, workerId, workspaceId: workspace.id, agentId: FAKE_AGENT_ID, model: '' });
  await post(`/api/sessions/${first.id}/prompt`, { text: '仅属于原会话的记录' }, 202);
  const endpoint = `/api/projects/${project.id}/session-tabs`;
  const sessions = async () => {
    const response = await page.request.get(`/api/projects/${project.id}/canvas`);
    expect(response.ok()).toBe(true);
    return (await response.json() as { sessions: Session[] }).sessions;
  };
  return { project, task, workerId, workspace, first, path, git, endpoint, headers, post, sessions };
}

test('仅对话必须显式选择机器和空目录，即使项目已绑定仓库也不克隆', async ({ page, baseURL }) => {
  const root = mkdtempSync(join(tmpdir(), 'session-tab-empty-'));
  try {
    const { workerId, project, task, workspace, endpoint, headers, post, git } = await setup(page, baseURL!, root, 0);
    const repoUrl = 'https://example.invalid/must-not-clone.git';
    const update = await page.request.put(`/api/projects/${project.id}/repo`, { headers, data: { repoUrl, defaultBranch: 'main' } });
    expect(update.status(), await update.text()).toBe(200);
    expect((await update.json()).repos).toEqual([expect.objectContaining({ url: repoUrl })]);
    const before = git('worktree', 'list', '--porcelain');
    const session = await post<Session>(endpoint, { taskId: task.id, workerId, agentId: FAKE_AGENT_ID, placement: { kind: 'chat-only' } });
    expect(session).toMatchObject({ taskId: task.id, workerId, groupId: null });
    expect(session.workspaceId).toBeTruthy();
    expect(session.workspaceId).not.toBe(workspace.id);
    const canvas = await page.request.get(`/api/projects/${project.id}/canvas`);
    expect(canvas.status()).toBe(200);
    const data = await canvas.json() as { workspaces: { id: string; path: string; kind: string; source: string }[] };
    const scratch = data.workspaces.find((item) => item.id === session.workspaceId);
    expect(scratch).toMatchObject({ kind: 'temporary', source: 'created' });
    expect(existsSync(join(scratch!.path, '.git'))).toBe(false);
    await post(`/api/sessions/${session.id}/prompt`, { text: 'please-write:empty-cwd-proof=ok' }, 202);
    const proof = join(scratch!.path, 'empty-cwd-proof');
    await expect.poll(() => existsSync(proof)).toBe(true);
    expect(readFileSync(proof, 'utf8').trim()).toBe('ok');
    expect(git('worktree', 'list', '--porcelain')).toBe(before);
  } finally {
    stopFakeWorker();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const width of [1280, 390]) {
  const touch = width < 640;
  test.describe(`新标签 ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, isMobile: touch, hasTouch: touch });

    test('从画布当前窗口新建同目录会话，不新建 Worktree；关闭标签保留会话和原草稿', async ({ page, baseURL }, testInfo) => {
      const root = mkdtempSync(join(tmpdir(), 'session-tabs-'));
      try {
        const world = await setup(page, baseURL!, root, width);
        const { project, task, workspace, first, workerId, git, endpoint, path, post, sessions } = world;
        const before = git('worktree', 'list', '--porcelain');
        const branch = git('branch', '--list');
        await page.goto(`/#/p/${project.id}/canvas`);
        await page.locator(`.react-flow__node-session[data-id="${first.id}"]`).getByRole('button', { name: '在画布中展开' }).click();
        const active = page.getByTestId('canvas-window');
        const composer = active.getByRole('textbox', { name: '发送消息' });
        const transcript = active.getByRole('log', { name: '会话记录' });
        await expect(transcript).toContainText('仅属于原会话的记录');
        await composer.fill('只属于原会话的草稿');
        await expect(active).toHaveAttribute('data-window-id', /.+/);
        const windowId = await active.getAttribute('data-window-id');
        await openDocumentNewMenu(page, active, { touch, compact: touch });
        // 旧 Worker 的终端资格不改变新建会话的机器或目录。
        await expect(page.getByTestId('session-tab-new-terminal')).toBeEnabled();
        await expect(page.getByTestId('workdir-create-worktree')).toHaveCount(0);
        await page.getByTestId('session-tab-new-session').click();
        const create = page.getByTestId('session-tab-create');
        await expect(create).toBeVisible();
        const response = page.waitForResponse((reply) => new URL(reply.url()).pathname === endpoint && reply.request().method() === 'POST');
        await create.getByTestId('session-tab-create-confirm').click();
        const reply = await response;
        expect(reply.request().postDataJSON()).toMatchObject({ taskId: task.id, workerId, agentId: FAKE_AGENT_ID, placement: { kind: 'workspace', workspaceId: workspace.id } });
        expect(reply.status(), await reply.text()).toBe(201);
        const newSession = await reply.json() as Session;
        expect(newSession.id).not.toBe(first.id);
        expect(newSession).toMatchObject({ taskId: task.id, workerId, workspaceId: workspace.id, groupId: null });
        await expect(active).toHaveCount(1);
        await expect(active).toHaveAttribute('data-window-id', windowId!);
        await expect(active).toHaveAttribute('data-session-id', newSession.id);
        await expect(composer).toHaveValue('');
        await expect(transcript).not.toContainText('仅属于原会话的记录');
        expect(git('worktree', 'list', '--porcelain')).toBe(before);
        expect(git('branch', '--list')).toBe(branch);
        await post(`/api/sessions/${newSession.id}/prompt`, { text: 'please-write:tab-cwd-proof=ok' }, 202);
        await expect.poll(() => existsSync(join(path, 'tab-cwd-proof'))).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`mixed-tabs-${width}.png`) });
        await active.getByTestId('session-tab-trigger').click({ timeout: 10_000 });
        const picker = page.getByTestId('session-tab-picker');
        await picker.locator(`[data-testid="session-tab-close"][data-session-id="${newSession.id}"]`).click({ timeout: 10_000 });
        await expect(active).toHaveAttribute('data-window-id', windowId!);
        await expect(active).toHaveAttribute('data-session-id', first.id);
        await expect(composer).toHaveValue('只属于原会话的草稿');
        expect((await sessions()).map((row) => row.id)).toContain(newSession.id);
      } finally {
        stopFakeWorker();
        rmSync(root, { recursive: true, force: true });
      }
    });

    test('独立页创建回执丢失，不自动重发，也不切走已有草稿', async ({ page, baseURL }) => {
      const root = mkdtempSync(join(tmpdir(), 'session-tab-ack-'));
      try {
        const { project, first, endpoint, sessions } = await setup(page, baseURL!, root, width);
        const draft = '回执丢失不能覆盖这个草稿';
        await page.goto(`/#/p/${project.id}/focus/${first.id}`);
        const composer = page.getByRole('textbox', { name: '发送消息' });
        await composer.fill(draft);
        let writes = 0;
        let status = 0;
        await page.route(`**${endpoint}`, async (route) => {
          if (route.request().method() !== 'POST') return route.continue();
          writes++;
          const response = await route.fetch({ maxRetries: 0 });
          status = response.status();
          await route.abort('connectionreset');
        });
        await openDocumentNewMenu(page, page.getByTestId('session-document-tabs'), { touch, compact: touch });
        await page.getByTestId('session-tab-new-session').click();
        const dialog = page.getByTestId('session-tab-create');
        await dialog.getByTestId('session-tab-create-confirm').click();
        await expect(dialog).toContainText('创建结果待确认');
        await expect(dialog.getByTestId('session-tab-create-confirm')).toBeDisabled();
        await expect(page).toHaveURL(new RegExp(`/focus/${first.id}$`));
        await expect(composer).toHaveValue(draft);
        expect(status).toBe(201);
        expect(writes).toBe(1);
        expect(await sessions()).toHaveLength(2);
      } finally {
        stopFakeWorker();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}
