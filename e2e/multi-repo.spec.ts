import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { piModel } from './hub-model.ts';

/**
 * 多仓库项目：指定主仓库 → 组合工作目录（cwd=主仓库，附加仓在 ../repos/）→ 派生跟着整组走
 * → 文件与改动按成员仓库查看（docs/design/multi-repo.md）。
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

async function saveRepos(
  page: Page,
  projectId: string,
  repos: Array<{ name: string; url: string; defaultBranch?: string }>,
  headers: Record<string, string>,
  primaryName: string
) {
  const patched = await page.request.patch(`/api/projects/${projectId}`, {
    data: { repos: repos.map((repo) => ({ ...repo, defaultBranch: repo.defaultBranch ?? 'main' })) },
    headers
  });
  if (patched.status() !== 200) return patched;
  const view = (await patched.json()) as { repos: Array<{ id: string; name: string }> };
  const primary = view.repos.find((repo) => repo.name === primaryName);
  if (!primary) return patched;
  return page.request.patch(`/api/projects/${projectId}`, { data: { primaryRepoId: primary.id }, headers });
}

type Group = {
  id: string;
  root: string;
  state: string;
  error: string | null;
  members: Array<{ workspaceId: string; name: string; position: number; state: string; error: string | null }>;
};

test('组合工作目录：两个仓库各开 worktree，派生跟着整组，文件按成员查看', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const headers = await login(page, baseURL ?? '');
  const agentId = await onlineAgent(page);
  test.skip(!agentId, '这台机器上没有可用的 agent');

  const root = mkdtempSync(join(tmpdir(), 'e2e-multi-repo-'));
  // 项目自己的根目录和仓库目录分开：工作目录的「不嵌套」约束不允许把仓库放进项目根里。
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot, { recursive: true });
  const repos = [
    { name: 'web', url: 'https://example.invalid/acme/web.git' },
    { name: 'api', url: 'https://example.invalid/acme/api.git' }
  ];
  const dirs = repos.map((repo) => makeRepo(join(root, 'repos'), repo.name, repo.url));
  writeFileSync(join(dirs[0]!, 'AGENTS.md'), '# web instructions\n');
  execFileSync('git', ['-C', dirs[0]!, '-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e', 'add', 'AGENTS.md'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dirs[0]!, '-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e', 'commit', '-qm', 'agents'], { stdio: 'ignore' });

  const project = (await (
    await page.request.post('/api/projects', {
      data: { name: `e2e multi ${Date.now().toString(36)}`, rootPath: projectRoot },
      headers
    })
  ).json()) as { id: string };

  const patched = await saveRepos(page, project.id, repos, headers, 'web');
  expect(patched.status(), await patched.text()).toBe(200);
  const projectView = (await patched.json()) as { repos: Array<{ id: string; name: string }>; primaryRepoId?: string | null };
  expect(projectView.repos.map((repo) => repo.name)).toEqual(['web', 'api']);
  expect(projectView.primaryRepoId).toBe(projectView.repos[0]!.id);

  // 每个仓库在这台机器上登记一个长期 git 空间，作为组合建组的基座。
  // 用团队工作目录的登记接口（能带 repoUrl），组合建组才找得到基座。
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

  // 文件接口：不选成员时 cwd 是主仓库，能看到 AGENTS.md。
  const listed = await page.request.get(`/api/sessions/${session.id}/files?path=`, { headers });
  expect(listed.status(), await listed.text()).toBe(200);
  const listing = (await listed.json()) as { entries: Array<{ name: string; kind: string }> };
  const names = listing.entries.map((entry) => entry.name);
  expect(names).toContain('AGENTS.md');
  expect(names).not.toContain('api');
  expect(names).not.toContain('.agent-hub');
  expect(existsSync(join(group.root, 'web', 'AGENTS.md'))).toBe(true);
  expect(existsSync(join(group.root, 'repos', 'api'))).toBe(true);

  const cwdContext = await page.request.get(`/api/sessions/${session.id}/files/context`, { headers });
  expect(cwdContext.status(), await cwdContext.text()).toBe(200);
  const cwdBody = (await cwdContext.json()) as { root: string; group?: { root: string; members: unknown[] } };
  expect(cwdBody.root).toBe(join(group.root, 'web'));
  expect(cwdBody.group?.root).toBe(group.root);

  // 选了附加仓就落到 ../repos/<name>。
  const apiMember = group.members.find((member) => member.name === 'api')!;
  const context = await page.request.get(`/api/sessions/${session.id}/files/context?member=${apiMember.workspaceId}`, { headers });
  expect(context.status(), await context.text()).toBe(200);
  const contextBody = (await context.json()) as {
    root: string;
    member: string | null;
    group?: { members: Array<{ workspaceId: string; name: string }> };
  };
  expect(contextBody.member).toBe(apiMember.workspaceId);
  expect(contextBody.root).toBe(join(group.root, 'repos', 'api'));
  expect(contextBody.group?.members.length).toBe(2);

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

function sh(cwd: string, ...args: string[]) {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid' }
  });
}

/** 本地 bare 仓库，带子模块（子模块也是本地 bare，不走网络）。 */
function makeBareWithSubmodule(root: string, name: string) {
  const childSeed = join(root, `${name}-child-seed`);
  mkdirSync(childSeed, { recursive: true });
  sh(childSeed, 'init', '-q', '-b', 'main');
  writeFileSync(join(childSeed, 'lib.txt'), 'lib\n');
  sh(childSeed, 'add', '.');
  sh(childSeed, 'commit', '-qm', 'child');
  sh(root, 'clone', '-q', '--bare', childSeed, `${name}-child.git`);
  const childUrl = join(root, `${name}-child.git`);

  const seed = join(root, `${name}-seed`);
  mkdirSync(seed, { recursive: true });
  sh(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'README.md'), 'hi\n');
  sh(seed, 'add', '.');
  sh(seed, 'commit', '-qm', 'init');
  sh(seed, '-c', 'protocol.file.allow=always', 'submodule', 'add', childUrl, 'vendor');
  sh(seed, 'commit', '-qm', 'add submodule');
  sh(root, 'clone', '-q', '--bare', seed, `${name}.git`);
  return join(root, `${name}.git`);
}

function cloneFromBare(parent: string, name: string, url: string, recurse: boolean): string {
  const dir = join(parent, name);
  const args = ['clone', '-q', ...(recurse ? ['--recurse-submodules'] : []), url, dir];
  execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], { stdio: 'ignore' });
  sh(dir, 'remote', 'set-url', 'origin', url);
  return dir;
}

test('组合会话界面：仓库切换、按仓提交、cwd 是主仓库', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const headers = await login(page, baseURL ?? '');
  const agentId = await onlineAgent(page);
  test.skip(!agentId, '这台机器上没有可用的 agent');

  const root = mkdtempSync(join(tmpdir(), 'e2e-combo-ui-'));
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot, { recursive: true });
  const repos = [
    { name: 'web', url: 'https://example.invalid/acme/web.git' },
    { name: 'api', url: 'https://example.invalid/acme/api.git' },
    { name: 'one', url: 'https://example.invalid/acme/one.git' }
  ];
  const dirs = repos.map((repo) => makeRepo(join(root, 'repos'), repo.name, repo.url));

  const project = (await (
    await page.request.post('/api/projects', {
      data: { name: `e2e combo ui ${Date.now().toString(36)}`, rootPath: projectRoot },
      headers
    })
  ).json()) as { id: string };
  const patched = await saveRepos(page, project.id, repos, headers, 'web');
  expect(patched.status(), await patched.text()).toBe(200);

  for (const [index, repo] of repos.entries()) {
    const linked = await page.request.post('/api/workspaces', {
      data: { workerId: null, mode: 'link', path: dirs[index], repoUrl: repo.url, branch: 'main', name: repo.name, projectId: project.id },
      headers
    });
    expect(linked.status(), await linked.text()).toBe(201);
  }

  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '组合界面' }, headers })).json()) as { id: string };
  const built = await page.request.post(`/api/projects/${project.id}/workspace-groups`, { data: { taskId: task.id, workerId: null }, headers });
  expect(built.status(), await built.text()).toBe(201);
  const group = (await built.json()) as Group;
  expect(group.state, group.error ?? '').toBe('ready');

  const derived = await page.request.post('/api/sessions/derive', {
    data: { taskId: task.id, agentId, model: piModel(), groupId: group.id },
    headers
  });
  expect(derived.status(), await derived.text()).toBe(201);
  const session = (await derived.json()) as { id: string; groupId: string | null; workspaceId: string | null };
  expect(session.groupId).toBe(group.id);

  // cwd / 文件上下文：不选成员时落在主仓库。
  const context = await page.request.get(`/api/sessions/${session.id}/files/context`, { headers });
  expect(context.status(), await context.text()).toBe(200);
  const contextBody = (await context.json()) as { root: string; group?: { root: string; members: unknown[] } };
  expect(contextBody.root).toBe(join(group.root, 'web'));
  expect(contextBody.group?.root).toBe(group.root);

  const web = group.members.find((member) => member.name === 'web')!;
  const api = group.members.find((member) => member.name === 'api')!;
  writeFileSync(join(group.root, 'web', 'note-web.txt'), 'web change\n');
  writeFileSync(join(group.root, 'repos', 'api', 'note-api.txt'), 'api change\n');

  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`/#/p/${project.id}/focus/${session.id}`);
  const switcher = page.getByTestId('composer-status').getByTestId('repo-switcher');
  await expect(switcher).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('session-tab-changes').click();
  await expect(page.getByTestId('changes-list')).toBeVisible();
  await expect(page.getByTestId('changes-group-web')).toBeVisible();
  await expect(page.getByTestId('changes-group-api')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('combo-changes.png') });
  await page.getByTestId('session-back-to-chat').click();
  await expect(switcher.getByTestId('repo-switcher-web')).toBeVisible();
  await expect(switcher.getByTestId('repo-switcher-api')).toBeVisible();
  await expect(switcher.getByTestId('repo-switcher-one')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('combo-switcher.png') });

  await switcher.getByTestId('repo-switcher-api').click();
  await page.getByTestId('session-tab-files').click();
  await expect(page.getByTestId('files-panel-files').getByTestId('repo-switcher')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('combo-files-api.png') });

  // 分支药丸在会话页的输入框状态行里，文件页会把输入框藏起来。
  await page.getByTestId('session-back-to-chat').click();
  await expect(page.getByTestId('composer-status').getByTestId('git-branch')).toBeVisible();
  await page.getByTestId('composer-status').getByTestId('git-branch').click();
  const dialog = page.getByTestId('git-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('repo-switcher')).toBeVisible();
  await dialog.getByTestId('repo-switcher-web').click();
  await expect(dialog.getByTestId('git-files')).toContainText('note-web.txt');
  await expect(dialog.getByTestId('git-files')).not.toContainText('note-api.txt');
  await expect(dialog.getByTestId('git-message')).toBeVisible();
  await dialog.getByTestId('git-message').fill('chore: web note');
  await dialog.getByTestId('git-commit').click();
  await expect(dialog.getByTestId('git-result')).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: testInfo.outputPath('combo-commit-web.png') });

  // API：只提交了 web，api 仍有未提交改动。
  const webState = await page.request.get(`/api/sessions/${session.id}/git/state?member=${web.workspaceId}`, { headers });
  expect(webState.status()).toBe(200);
  const webBody = (await webState.json()) as { files: Array<{ path: string }> };
  expect(webBody.files.some((file) => file.path.includes('note-web.txt'))).toBe(false);
  const apiState = await page.request.get(`/api/sessions/${session.id}/git/state?member=${api.workspaceId}`, { headers });
  const apiBody = (await apiState.json()) as { files: Array<{ path: string }> };
  expect(apiBody.files.some((file) => file.path.includes('note-api.txt'))).toBe(true);

  // 再按仓提交 api
  const committed = await page.request.post(`/api/sessions/${session.id}/git/run?member=${api.workspaceId}`, {
    data: { action: 'commit', message: 'chore: api note' },
    headers
  });
  expect(committed.status(), await committed.text()).toBe(200);

  await page.request.post(`/api/sessions/${session.id}/interrupt`, { headers });
  // 有未推送的提交时整组留下，不能只拆掉部分成员。
  const removed = await page.request.delete(`/api/workspace-groups/${group.id}`, { headers });
  expect(removed.status(), await removed.text()).toBe(409);
});

test('项目子模块开关：默认关闭不拉；打开后新建 worktree 会递归初始化', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const headers = await login(page, baseURL ?? '');

  const root = mkdtempSync(join(tmpdir(), 'e2e-submodules-'));
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot, { recursive: true });
  const bare = makeBareWithSubmodule(root, 'core');
  const url = bare;
  // 作为建组基座：先按「关」克隆一份（不拉子模块），origin 保持本地 bare，子模块才能走 file 协议。
  const baseOff = cloneFromBare(join(root, 'bases'), 'core-off', bare, false);

  const project = (await (
    await page.request.post('/api/projects', {
      data: { name: `e2e sub ${Date.now().toString(36)}`, rootPath: projectRoot, repoUrl: url, defaultBranch: 'main' },
      headers
    })
  ).json()) as { id: string; submodules?: string };

  // 默认关
  expect(project.submodules === 'recursive').toBe(false);
  const offPatch = await page.request.patch(`/api/projects/${project.id}`, { data: { submodules: 'off' }, headers });
  expect(offPatch.status(), await offPatch.text()).toBe(200);
  const coreView = (await offPatch.json()) as { repos: Array<{ id: string; name: string }> };
  const coreRepo = coreView.repos[0];
  expect(coreRepo).toBeTruthy();
  const primaryPatch = await page.request.patch(`/api/projects/${project.id}`, { data: { primaryRepoId: coreRepo!.id }, headers });
  expect(primaryPatch.status(), await primaryPatch.text()).toBe(200);

  const linkedOff = await page.request.post('/api/workspaces', {
    data: { workerId: null, mode: 'link', path: baseOff, repoUrl: url, branch: 'main', name: 'core', projectId: project.id },
    headers
  });
  expect(linkedOff.status(), await linkedOff.text()).toBe(201);

  const taskOff = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: 'sub off' }, headers })).json()) as { id: string };
  const builtOff = await page.request.post(`/api/projects/${project.id}/workspace-groups`, { data: { taskId: taskOff.id, workerId: null }, headers });
  expect(builtOff.status(), await builtOff.text()).toBe(201);
  const groupOff = (await builtOff.json()) as Group;
  expect(groupOff.state, groupOff.error ?? '').toBe('ready');
  expect(existsSync(join(groupOff.root, 'core', 'vendor', 'lib.txt'))).toBe(false);
  await page.request.delete(`/api/workspace-groups/${groupOff.id}`, { headers });

  // 打开开关后再建一组：新 worktree 应拉到子模块。
  const onPatch = await page.request.patch(`/api/projects/${project.id}`, { data: { submodules: 'recursive' }, headers });
  expect(onPatch.status(), await onPatch.text()).toBe(200);
  const saved = (await onPatch.json()) as { submodules?: string };
  expect(saved.submodules).toBe('recursive');

  const taskOn = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: 'sub on' }, headers })).json()) as { id: string };
  const builtOn = await page.request.post(`/api/projects/${project.id}/workspace-groups`, { data: { taskId: taskOn.id, workerId: null }, headers });
  expect(builtOn.status(), await builtOn.text()).toBe(201);
  const groupOn = (await builtOn.json()) as Group;
  expect(groupOn.state, groupOn.error ?? '').toBe('ready');
  expect(existsSync(join(groupOn.root, 'core', 'vendor', 'lib.txt'))).toBe(true);
  await page.request.delete(`/api/workspace-groups/${groupOn.id}`, { headers });
});

test('组合会话：只选主仓库建组，之后再添加仓库；cwd 仍是主仓库', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const headers = await login(page, baseURL ?? '');
  const agentId = await onlineAgent(page);
  test.skip(!agentId, '这台机器上没有可用的 agent');

  const root = mkdtempSync(join(tmpdir(), 'e2e-subset-add-'));
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot, { recursive: true });
  const repos = [
    { name: 'web', url: 'https://example.invalid/acme/web.git' },
    { name: 'api', url: 'https://example.invalid/acme/api.git' }
  ];
  const dirs = repos.map((repo) => makeRepo(join(root, 'repos'), repo.name, repo.url));

  const project = (await (
    await page.request.post('/api/projects', {
      data: { name: `e2e subset ${Date.now().toString(36)}`, rootPath: projectRoot },
      headers
    })
  ).json()) as { id: string };
  const patched = await saveRepos(page, project.id, repos, headers, 'web');
  expect(patched.status(), await patched.text()).toBe(200);
  const projectView = (await patched.json()) as { repos: Array<{ id: string; name: string }>; primaryRepoId?: string | null };
  const webId = projectView.repos.find((repo) => repo.name === 'web')!.id;
  const apiId = projectView.repos.find((repo) => repo.name === 'api')!.id;

  for (const [index, repo] of repos.entries()) {
    const linked = await page.request.post('/api/workspaces', {
      data: { workerId: null, mode: 'link', path: dirs[index], repoUrl: repo.url, branch: 'main', name: repo.name, projectId: project.id },
      headers
    });
    expect(linked.status(), await linked.text()).toBe(201);
  }

  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '先主仓再加仓' }, headers })).json()) as { id: string };
  const built = await page.request.post(`/api/projects/${project.id}/workspace-groups`, {
    data: { taskId: task.id, workerId: null, repoIds: [webId] },
    headers
  });
  expect(built.status(), await built.text()).toBe(201);
  const group = (await built.json()) as Group & { layout?: string; primaryRepoId?: string };
  expect(group.state, group.error ?? '').toBe('ready');
  expect(group.members.map((member) => member.name)).toEqual(['web']);
  expect(existsSync(join(group.root, 'web'))).toBe(true);
  expect(existsSync(join(group.root, 'repos', 'api'))).toBe(false);

  const derived = await page.request.post('/api/sessions/derive', {
    data: { taskId: task.id, agentId, model: piModel(), groupId: group.id },
    headers
  });
  expect(derived.status(), await derived.text()).toBe(201);
  const session = (await derived.json()) as { id: string; groupId: string | null };
  const cwd = await page.request.get(`/api/sessions/${session.id}/files/context`, { headers });
  expect(((await cwd.json()) as { root: string }).root).toBe(join(group.root, 'web'));

  const added = await page.request.post(`/api/workspace-groups/${group.id}/members`, { data: { repoId: apiId }, headers });
  expect(added.status(), await added.text()).toBe(201);
  const next = (await added.json()) as Group;
  expect(next.members.map((member) => member.name).sort()).toEqual(['api', 'web']);
  expect(existsSync(join(group.root, 'repos', 'api'))).toBe(true);

  const after = await page.request.get(`/api/sessions/${session.id}/files/context`, { headers });
  const afterBody = (await after.json()) as { root: string; group?: { members: Array<{ name: string }> } };
  expect(afterBody.root).toBe(join(group.root, 'web'));
  expect(afterBody.group?.members.map((member) => member.name).sort()).toEqual(['api', 'web']);

  await page.request.post(`/api/sessions/${session.id}/interrupt`, { headers });
  const removed = await page.request.delete(`/api/workspace-groups/${group.id}`, { headers });
  expect(removed.status(), await removed.text()).toBe(200);
});
