import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { piModel } from './hub-model.ts';

/**
 * 多仓库项目：项目挂多个仓库 → 组合工作空间（容器根 + 每仓一个 worktree）→ 派生跟着整组走
 * → 文件与改动按成员仓库查看（docs/design/multi-repo.md §4 §6 §7）。
 */
async function login(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  return { origin: baseURL, 'x-hub-csrf': csrf };
}

async function onlineAgent(page: Page): Promise<string | undefined> {
  let agentId: string | undefined;
  for (let attempt = 0; attempt < 30 && agentId === undefined; attempt++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((worker) => worker.state === 'online')?.agentIds[0];
    if (agentId === undefined) await page.waitForTimeout(500);
  }
  return agentId;
}

/** 造一个本地 git 仓库：有 main 分支、一次提交、origin 指向 url（组合建组按 repoUrl 找基座）。 */
function makeRepo(root: string, name: string, url: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e', 'commit', '-q', '--allow-empty', '-m', 'init');
  git('remote', 'add', 'origin', url);
  return dir;
}

type Group = {
  id: string;
  root: string;
  state: string;
  error: string | null;
  members: Array<{ workspaceId: string; name: string; position: number; state: string; error: string | null }>;
};

test('组合工作空间：两个仓库各开 worktree，派生跟着整组，文件按成员查看', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const headers = await login(page, baseURL ?? '');
  const agentId = await onlineAgent(page);
  test.skip(!agentId, '这台机器上没有可用的 agent');

  const root = mkdtempSync(join(tmpdir(), 'e2e-multi-repo-'));
  // 项目自己的根目录和仓库目录分开：工作空间的「不嵌套」约束不允许把仓库放进项目根里。
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot, { recursive: true });
  const repos = [
    { name: 'web', url: 'https://example.invalid/acme/web.git' },
    { name: 'api', url: 'https://example.invalid/acme/api.git' }
  ];
  const dirs = repos.map((repo) => makeRepo(join(root, 'repos'), repo.name, repo.url));

  const project = (await (
    await page.request.post('/api/projects', {
      data: { name: `e2e multi ${Date.now().toString(36)}`, rootPath: projectRoot },
      headers
    })
  ).json()) as { id: string };

  const patched = await page.request.patch(`/api/projects/${project.id}`, {
    data: { repos: repos.map((repo) => ({ ...repo, defaultBranch: 'main' })) },
    headers
  });
  expect(patched.status(), await patched.text()).toBe(200);
  const projectView = (await patched.json()) as { repos: Array<{ id: string; name: string }> };
  expect(projectView.repos.map((repo) => repo.name)).toEqual(['web', 'api']);

  // 每个仓库在这台机器上登记一个长期 git 空间，作为组合建组的基座。
  // 用团队工作空间的登记接口（能带 repoUrl），组合建组才找得到基座。
  for (const [index, repo] of repos.entries()) {
    const linked = await page.request.post('/api/workspaces', {
      data: {
        workerId: null,
        mode: 'link',
        path: dirs[index],
        repoUrl: repo.url,
        branch: 'main',
        name: repo.name,
        projectId: project.id
      },
      headers
    });
    expect(linked.status(), await linked.text()).toBe(201);
  }

  const task = (await (
    await page.request.post('/api/tasks', { data: { projectId: project.id, title: '跨仓库改动' }, headers })
  ).json()) as { id: string };

  const built = await page.request.post(`/api/projects/${project.id}/workspace-groups`, {
    data: { taskId: task.id, workerId: null },
    headers
  });
  expect(built.status(), await built.text()).toBe(201);
  const group = (await built.json()) as Group;
  expect(group.state, group.error ?? '').toBe('ready');
  expect(group.members.map((member) => member.name)).toEqual(['web', 'api']);
  // 容器根是 hub 管的目录，成员目录是容器里以仓库名命名的一层。
  expect(group.root).toContain('agent-hub-groups');
  for (const member of group.members) expect(member.state).toBe('ready');

  const read = await page.request.get(`/api/workspace-groups/${group.id}`, { headers });
  expect(read.status()).toBe(200);
  expect(((await read.json()) as Group).members.length).toBe(2);

  const derived = await page.request.post('/api/sessions/derive', {
    data: { taskId: task.id, agentId, model: piModel(), groupId: group.id },
    headers
  });
  expect(derived.status(), await derived.text()).toBe(201);
  const session = (await derived.json()) as { id: string; groupId: string | null; workspaceId: string | null };
  expect(session.groupId).toBe(group.id);
  // 组覆盖 workspaceId：落在 primary 成员上。
  expect(session.workspaceId).toBe(group.members[0]!.workspaceId);

  // 文件接口：不选成员时落在容器根，能看到成员目录、看不到容器标记。
  const listed = await page.request.get(`/api/sessions/${session.id}/files?path=`, { headers });
  expect(listed.status(), await listed.text()).toBe(200);
  const listing = (await listed.json()) as { entries: Array<{ name: string; kind: string }> };
  const names = listing.entries.map((entry) => entry.name);
  expect(names).toContain('web');
  expect(names).toContain('api');
  expect(names).not.toContain('.agent-hub');

  // 选了成员就落到那个仓库里。
  const apiMember = group.members.find((member) => member.name === 'api')!;
  const context = await page.request.get(`/api/sessions/${session.id}/files/context?member=${apiMember.workspaceId}`, { headers });
  expect(context.status(), await context.text()).toBe(200);
  const contextBody = (await context.json()) as {
    root: string;
    member: string | null;
    group?: { members: Array<{ workspaceId: string; name: string }> };
  };
  expect(contextBody.member).toBe(apiMember.workspaceId);
  expect(contextBody.root.endsWith('/api')).toBe(true);
  expect(contextBody.group?.members.length).toBe(2);

  // 容器不是 git 仓库：不选成员时改动为空，选了才看那个仓库。
  const containerChanges = await page.request.get(`/api/sessions/${session.id}/git/changes`, { headers });
  expect(containerChanges.status(), await containerChanges.text()).toBe(200);
  expect(((await containerChanges.json()) as { files: unknown[] }).files.length).toBe(0);

  const memberChanges = await page.request.get(
    `/api/sessions/${session.id}/git/changes?member=${apiMember.workspaceId}`,
    { headers }
  );
  expect(memberChanges.status(), await memberChanges.text()).toBe(200);

  // 组合会话不支持整体回滚。
  const rewind = await page.request.post(`/api/sessions/${session.id}/rewind/preview`, {
    data: { seq: 1 },
    headers
  });
  expect(rewind.status()).not.toBe(200);

  await page.request.post(`/api/sessions/${session.id}/interrupt`, { headers });
  const removed = await page.request.delete(`/api/workspace-groups/${group.id}`, { headers });
  expect(removed.status(), await removed.text()).toBe(200);
});
