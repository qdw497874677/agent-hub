import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { loginByApi } from './login.ts';

type Plan = { id: string; revision: number; state: string; source: string; workerId: string; workspaceId: string | null; groupId: string | null; primaryId: string; members: Array<{ id: string; oid: string; targetPath: string; branch: string; sourcePath: string; baseAction: string }> };
const enabled = process.env['HUB_WORKTREE_PLANS'] === '1';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } }).trim();
}

test('重新打开计划后来源提交变化，确认被拒绝且不会回退检出', async ({ page, baseURL }) => {
  test.skip(!enabled, 'HUB_WORKTREE_PLANS opt-in');
  const root = mkdtempSync(join(tmpdir(), 'wt-stale-'));
  try {
    const { workerId, project, task, first, workspaces } = await setup(page, baseURL!, root);
    const creation = await openFromDirectory(page, baseURL!, project.id, workspaces[0]!.id);
    const planRoot = `/api/projects/${project.id}/tasks/${task.id}/worktree-plans`;
    await creation.getByLabel('起点（可选；留空使用默认起点）').fill('missing-explicit-branch');
    const invalidResponse = page.waitForResponse((response) => response.url().endsWith(planRoot) && response.request().method() === 'POST');
    await creation.getByTestId('worktree-preview').click();
    expect((await invalidResponse).status()).toBe(400);
    await expect(creation.getByRole('alert')).toBeVisible();
    expect(git(first.path, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(1);
    await creation.getByLabel('起点（可选；留空使用默认起点）').fill('');
    const previewResponse = page.waitForResponse((response) => response.url().endsWith(planRoot) && response.request().method() === 'POST');
    await creation.getByTestId('worktree-preview').click();
    const preview = await previewResponse;
    expect(preview.status(), await preview.text()).toBe(201);
    const draft = await preview.json() as Plan;
    expect(draft.workerId).toBe(workerId);
    await creation.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByTestId('worktree-open').click();
    await creation.getByText('查看这台机器的近期计划和进度').click();
    await creation.getByTestId('worktree-recent-plan').filter({ hasText: draft.id }).click();
    await expect(creation.getByTestId('worktree-plan-member')).toContainText(first.oid);
    git(first.path, '-c', 'user.name=E2E', '-c', 'user.email=e2e@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'changed');
    const responsePromise = page.waitForResponse((response) => response.url().endsWith(`${planRoot}/${draft.id}/execute`) && response.request().method() === 'POST');
    await creation.getByTestId('worktree-confirm').click();
    const response = await responsePromise;
    expect(response.status(), await response.text()).toBe(409);
    await expect(creation.getByRole('alert')).toBeVisible();
    expect(existsSync(draft.members[0]!.targetPath)).toBe(false);
    expect(git(first.path, 'worktree', 'list', '--porcelain')).not.toContain(draft.members[0]!.targetPath);
    expect(git(first.path, 'branch', '--list', draft.members[0]!.branch)).toBe('');
  } finally {
    stopFakeWorker();
    rmSync(root, { recursive: true, force: true });
  }
});

function repo(root: string, name: string) {
  const path = join(root, name);
  mkdirSync(path);
  git(path, 'init', '-q', '-b', 'main');
  writeFileSync(join(path, 'tracked.txt'), `${name}\n`);
  git(path, 'add', 'tracked.txt');
  git(path, '-c', 'user.name=E2E', '-c', 'user.email=e2e@example.invalid', 'commit', '-qm', 'initial');
  return { path, oid: git(path, 'rev-parse', 'HEAD') };
}

async function setup(page: Page, origin: string, root: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies(origin)).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin, 'x-hub-csrf': csrf };
  const api = async <T>(path: string, data?: unknown, status = data === undefined ? 200 : 201): Promise<T> => {
    const response = data === undefined ? await page.request.get(`${origin}${path}`) : await page.request.post(`${origin}${path}`, { headers, data });
    expect(response.status(), `${path}: ${await response.text()}`).toBe(status);
    return await response.json() as T;
  };
  const workerId = await ensureFakeWorker(page, origin, FAKE_AGENT_ID, { env: { WORKER_ROOTS: root, TMPDIR: root } });
  const first = repo(root, 'alpha');
  const second = repo(root, 'beta');
  const project = await api<{ id: string }>('/api/projects', { name: `Local worktree ${Date.now()}` });
  const task = await api<{ id: string }>('/api/tasks', { projectId: project.id, title: '本地计划测试任务' });
  const workspaces = [];
  for (const source of [first, second]) {
    workspaces.push(await api<{ id: string }>('/api/workspaces', { projectId: project.id, workerId, mode: 'link', path: source.path, name: source.path.split('/').at(-1) }));
  }
  return { api, headers, workerId, project, task, first, second, workspaces };
}

async function openFromDirectory(page: Page, origin: string, projectId: string, workspaceId: string) {
  await page.goto(`${origin}/#/p/${projectId}/workdir/${workspaceId}`);
  await page.getByTestId('workdir-add').click();
  await page.getByTestId('workdir-create-worktree').click();
  await page.getByTestId('workdir-task-picker').getByRole('button', { name: '本地计划测试任务' }).click();
  const creation = page.getByTestId('worktree-creation');
  await expect(creation).toBeVisible();
  await expect(creation.getByLabel('从已有工作目录')).toBeChecked();
  return creation;
}

test('默认关闭计划：API 不缓存 404，既有会话入口保留', async ({ page, baseURL }) => {
  test.skip(enabled, 'only when HUB_WORKTREE_PLANS is off');
  const root = mkdtempSync(join(tmpdir(), 'wt-off-'));
  try {
    const { project, task, workspaces, headers, first, second } = await setup(page, baseURL!, root);
    const repos = [first, second].map((source, i) => ({ name: i === 0 ? 'alpha' : 'beta', url: `https://example.invalid/legacy/${i}.git`, defaultBranch: 'main' }));
    for (const [i, source] of [first, second].entries()) git(source.path, 'remote', 'add', 'origin', repos[i]!.url);
    const projectUpdate = await page.request.patch(`${baseURL}/api/projects/${project.id}`, { headers, data: { repos } });
    expect(projectUpdate.status(), await projectUpdate.text()).toBe(200);
    const updated = await projectUpdate.json() as { repos: Array<{ id: string; name: string }> };
    const primary = updated.repos.find((repo) => repo.name === 'alpha')!.id;
    const setPrimary = await page.request.patch(`${baseURL}/api/projects/${project.id}`, { headers, data: { primaryRepoId: primary } });
    expect(setPrimary.status(), await setPrimary.text()).toBe(200);
    const home = await page.request.get(`${baseURL}/api/home`);
    expect(home.status()).toBe(200);
    expect((await home.json() as { worktreePlansAvailable?: boolean }).worktreePlansAvailable ?? false).toBe(false);
    const planRoot = `${baseURL}/api/projects/${project.id}/tasks/${task.id}/worktree-plans`;
    for (const path of [planRoot, `${planRoot}/missing`]) {
      const response = await page.request.get(path);
      expect.soft(response.status(), `${path} status`).toBe(404);
      expect.soft(response.headers()['cache-control'], `${path} cache`).toContain('no-store');
      expect.soft(response.headers()['content-type'], `${path} content type`).toContain('application/json');
      if (response.headers()['content-type']?.includes('application/json')) expect.soft(await response.json()).toMatchObject({ error: { code: 'not_found' } });
    }
    const post = await page.request.post(planRoot, { headers, data: {} });
    expect.soft(post.status(), 'POST plan status').toBe(404);
    expect.soft(post.headers()['cache-control'], 'POST plan cache').toContain('no-store');
    expect.soft(post.headers()['content-type'], 'POST plan content type').toContain('application/json');
    if (post.headers()['content-type']?.includes('application/json')) expect.soft(await post.json()).toMatchObject({ error: { code: 'not_found' } });
    const execute = await page.request.post(`${planRoot}/missing/execute`, { headers, data: { revision: 0 } });
    expect.soft(execute.status(), 'POST execute status').toBe(404);
    expect.soft(execute.headers()['cache-control'], 'POST execute cache').toContain('no-store');
    expect.soft(execute.headers()['content-type'], 'POST execute content type').toContain('application/json');
    if (execute.headers()['content-type']?.includes('application/json')) expect.soft(await execute.json()).toMatchObject({ error: { code: 'not_found' } });
    const homeResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/home');
    await page.goto(`${baseURL}/#/p/${project.id}/workdir/${workspaces[0]!.id}`);
    expect((await homeResponse).status()).toBe(200);
    await page.getByTestId('workdir-add').click();
    await expect(page.getByTestId('workdir-new-session')).toBeEnabled();
    await expect(page.getByTestId('workdir-create-worktree')).toHaveCount(0);
    await page.getByTestId('workdir-new-session').click();
    await page.getByTestId('workdir-task-picker').getByRole('button', { name: '本地计划测试任务' }).click();
    const dialog = page.getByRole('dialog', { name: '开始会话' });
    await expect(dialog.getByRole('button', { name: '开始', exact: true })).toBeEnabled();
    await expect(dialog.getByTestId('worktree-open')).toHaveCount(0);
    await dialog.getByTestId('ws-download-repo').check();
    const worktree = dialog.getByTestId('ws-new-worktree');
    await expect(worktree).toBeVisible();
    await worktree.click();
    await expect(worktree).toHaveAttribute('aria-checked', 'true');
    const group = dialog.getByTestId('ws-new-group');
    await expect(group).toBeVisible();
    await group.click();
    await expect(group).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByTestId('ws-group-repo-alpha').locator('input')).toBeChecked();
    await expect(dialog.getByTestId('ws-group-repo-alpha').locator('input')).toBeDisabled();
    await expect(dialog.getByTestId('ws-group-repo-beta').locator('input')).toBeChecked();
  } finally {
    stopFakeWorker();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const width of [1280, 390]) {
  test.describe(`本地 Worktree ${width}px`, () => {
    test.use({ viewport: { width, height: width < 640 ? 720 : 900 }, isMobile: width < 640, hasTouch: width < 640 });
    test('真实 Git 单仓与组合计划：预览无检出，精确提交及会话 cwd', async ({ page, baseURL }) => {
      test.skip(!enabled, 'HUB_WORKTREE_PLANS opt-in');
      test.setTimeout(180_000);
      const root = mkdtempSync(join(tmpdir(), 'wt-create-'));
      try {
        const { api, workerId, project, task, first, second, workspaces } = await setup(page, baseURL!, root);
        const planRoot = `/api/projects/${project.id}/tasks/${task.id}/worktree-plans`;
        for (const group of [false, true]) {
          const creation = await openFromDirectory(page, baseURL!, project.id, workspaces[0]!.id);
          if (group) await creation.getByTestId('worktree-add-member').selectOption(workspaces[1]!.id);
          const sources = group ? [first, second] : [first];
          // Dirty content must not be copied; the sources have no origin or project repo binding.
          writeFileSync(join(first.path, 'uncommitted.txt'), 'must not copy');
          const before = sources.map((source) => ({ worktrees: git(source.path, 'worktree', 'list', '--porcelain'), branches: git(source.path, 'branch', '--list') }));
          const previewResponse = page.waitForResponse((response) => response.url().endsWith(planRoot) && response.request().method() === 'POST');
          await creation.getByTestId('worktree-preview').click();
          const preview = await previewResponse;
          expect(preview.status(), await preview.text()).toBe(201);
          const draft = await preview.json() as Plan;
          expect(draft).toMatchObject({ state: 'draft', source: 'local', workerId, primaryId: workspaces[0]!.id });
          expect(draft.members.map((m) => m.oid)).toEqual(sources.map((source) => source.oid));
          for (const [i, member] of draft.members.entries()) {
            await expect(creation.getByTestId('worktree-plan-member').nth(i)).toContainText(member.oid);
            expect(member.sourcePath).toBe(sources[i]!.path);
            expect(existsSync(member.targetPath)).toBe(false);
            expect(git(sources[i]!.path, 'worktree', 'list', '--porcelain')).toBe(before[i]!.worktrees);
            expect(git(sources[i]!.path, 'branch', '--list')).toBe(before[i]!.branches);
          }
          const executeResponse = page.waitForResponse((response) => response.url().endsWith(`${planRoot}/${draft.id}/execute`) && response.request().method() === 'POST');
          await creation.getByTestId('worktree-confirm').click();
          const executed = await executeResponse;
          expect(executed.status(), await executed.text()).toBe(200);
          const plan = await executed.json() as Plan;
          expect(plan.state).toBe('ready-unused');
          await expect(creation.getByTestId('worktree-use')).toBeVisible();
          for (const [i, member] of plan.members.entries()) {
            expect(git(member.targetPath, 'rev-parse', 'HEAD')).toBe(sources[i]!.oid);
            expect(git(member.targetPath, 'branch', '--show-current')).toBe(member.branch);
            expect(resolve(member.targetPath, git(member.targetPath, 'rev-parse', '--git-common-dir'))).toBe(resolve(sources[i]!.path, git(sources[i]!.path, 'rev-parse', '--git-common-dir')));
            expect(git(member.targetPath, 'remote')).toBe('');
          }
          expect(existsSync(join(plan.members[0]!.targetPath, 'uncommitted.txt'))).toBe(false);
          await creation.getByTestId('worktree-use').click();
          const derive = page.waitForResponse((response) => response.url().endsWith('/api/sessions/derive') && response.request().method() === 'POST', { timeout: 30_000 });
          await page.getByRole('dialog', { name: '开始会话' }).getByRole('button', { name: '开始', exact: true }).click();
          const derived = await derive;
          expect(derived.status(), await derived.text()).toBe(201);
          const session = await derived.json() as { id: string; workspaceId: string | null; groupId: string | null };
          if (group) expect(session.groupId).toBe(plan.groupId);
          else expect(session.workspaceId).toBe(plan.workspaceId);
          await api(`/api/sessions/${session.id}/prompt`, { text: `please-write:cwd-proof-${group ? 'group' : 'single'}=ok` }, 202);
          const proof = join(plan.members[0]!.targetPath, `cwd-proof-${group ? 'group' : 'single'}`);
          await expect.poll(() => existsSync(proof)).toBe(true);
          expect(readFileSync(proof, 'utf8').trim()).toBe('ok');
          if (group) {
            expect(plan.groupId).toBeTruthy();
            expect(plan.members[1]!.targetPath).toContain('/repos/');
            expect(existsSync(join(plan.members[1]!.targetPath, 'cwd-proof-group'))).toBe(false);
          } else expect(plan.workspaceId).toBeTruthy();
        }
      } finally {
        stopFakeWorker();
        rmSync(root, { recursive: true, force: true });
      }
    });

    test('项目仓库复用已验证本地底座，不克隆', async ({ page, baseURL }) => {
      test.skip(!enabled, 'HUB_WORKTREE_PLANS opt-in');
      const root = mkdtempSync(join(tmpdir(), 'wt-project-'));
      try {
        const { api, headers, workerId, project, task, first, second, workspaces } = await setup(page, baseURL!, root);
        const sources = [first, second];
        const repos = sources.map((source, i) => ({ name: i === 0 ? 'alpha' : 'beta', url: `https://example.invalid/e2e/${i}.git`, defaultBranch: 'main' }));
        for (const [i, source] of sources.entries()) git(source.path, 'remote', 'add', 'origin', repos[i]!.url);
        const patch = await page.request.patch(`${baseURL}/api/projects/${project.id}`, { headers, data: { repos } });
        expect(patch.status(), await patch.text()).toBe(200);
        const updated = await patch.json() as { repos: Array<{ id: string; name: string }> };
        const ids = repos.map((repo) => updated.repos.find((item) => item.name === repo.name)!.id);
        const primary = await page.request.patch(`${baseURL}/api/projects/${project.id}`, { headers, data: { primaryRepoId: ids[0] } });
        expect(primary.status(), await primary.text()).toBe(200);
        const creation = await openFromDirectory(page, baseURL!, project.id, workspaces[0]!.id);
        await creation.getByLabel('按项目仓库').check();
        await expect(creation.getByTestId('worktree-member')).toHaveCount(1);
        await creation.getByTestId('worktree-add-member').selectOption(ids[1]!);
        const planRoot = `/api/projects/${project.id}/tasks/${task.id}/worktree-plans`;
        const responsePromise = page.waitForResponse((response) => response.url().endsWith(planRoot) && response.request().method() === 'POST');
        await creation.getByTestId('worktree-preview').click();
        const response = await responsePromise;
        expect(response.status(), await response.text()).toBe(201);
        const draft = await response.json() as Plan;
        expect(draft).toMatchObject({ state: 'draft', source: 'project', workerId, primaryId: ids[0] });
        expect(draft.members.map((m) => m.id)).toEqual(ids);
        expect(draft.members.map((m) => m.baseAction)).toEqual(['reuse', 'reuse']);
        for (const [i, member] of draft.members.entries()) {
          expect(member.sourcePath).toBe(sources[i]!.path);
          expect(member.oid).toBe(sources[i]!.oid);
          expect(existsSync(member.targetPath)).toBe(false);
          await expect(creation.getByTestId('worktree-plan-member').nth(i)).toContainText('复用底座');
        }
        await expect(creation.getByTestId('worktree-confirm')).not.toContainText('将克隆');
        const executedPromise = page.waitForResponse((r) => r.url().endsWith(`${planRoot}/${draft.id}/execute`) && r.request().method() === 'POST');
        await creation.getByTestId('worktree-confirm').click();
        const executed = await executedPromise;
        expect(executed.status(), await executed.text()).toBe(200);
        const plan = await executed.json() as Plan;
        expect(plan.state).toBe('ready-unused');
        expect(plan.groupId).toBeTruthy();
        for (const [i, member] of plan.members.entries()) {
          expect(git(member.targetPath, 'rev-parse', 'HEAD')).toBe(sources[i]!.oid);
          expect(resolve(member.targetPath, git(member.targetPath, 'rev-parse', '--git-common-dir'))).toBe(resolve(sources[i]!.path, git(sources[i]!.path, 'rev-parse', '--git-common-dir')));
          expect(git(member.targetPath, 'remote', 'get-url', 'origin')).toBe(repos[i]!.url);
        }
        const group = await api<{ members: Array<{ workspaceId: string }> }>(`/api/workspace-groups/${plan.groupId}`);
        const direct = await page.request.post(`${baseURL}/api/sessions/derive`, { headers, data: { taskId: task.id, workerId, agentId: FAKE_AGENT_ID, model: '', workspaceId: group.members[1]!.workspaceId } });
        expect(direct.status(), await direct.text()).toBe(409);
      } finally {
        stopFakeWorker();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}
