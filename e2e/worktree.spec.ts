import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { piModel } from './hub-model.ts';

/**
 * 隔离 worktree + 准备命令（docs/design/worktree.md §3 §4）。
 *
 * - 配了 `mode: isolated` 时，开会话会现建一个临时空间并跑准备命令；
 * - 准备命令跑完才起 agent（waitForSetup），状态写进 workspace.setup；
 * - 准备失败时 derive 直接拒绝并说清原因，修好后可以在会话页重试，不必删空间。
 * - 显式选了工作空间的会话不受档位影响（workspaceId 优先）。
 */
type Setup = { state: string; exitCode: number | null; message: string | null; output: string | null };
type Workspace = { id: string; kind: string; source: string; setup: Setup | null; path: string };

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

async function makeProject(page: Page, headers: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-worktree-'));
  const project = (await (
    await page.request.post('/api/projects', {
      data: { name: `e2e worktree ${Date.now().toString(36)}`, rootPath: dir },
      headers
    })
  ).json()) as { id: string };
  return project;
}

function worktreeBody(command: string) {
  return {
    worktree: {
      mode: 'isolated' as const,
      setup: { command, waitForSetup: true, timeoutSeconds: 60 }
    }
  };
}

async function configure(page: Page, headers: Record<string, string>, projectId: string, command: string) {
  const res = await page.request.patch(`/api/projects/${projectId}`, { data: worktreeBody(command), headers });
  expect(res.status(), await res.text()).toBe(200);
}

async function temporaryWorkspaces(page: Page, headers: Record<string, string>, projectId: string) {
  const rows = (await (await page.request.get(`/api/projects/${projectId}/workspaces`, { headers })).json()) as Array<{
    workspace: Workspace;
  }>;
  return rows.map((row) => row.workspace).filter((workspace) => workspace.kind === 'temporary');
}

async function makeTask(page: Page, headers: Record<string, string>, projectId: string) {
  return (await (
    await page.request.post('/api/tasks', { data: { projectId, title: 'worktree' }, headers })
  ).json()) as { id: string };
}

test('隔离 worktree：准备命令跑完才起 agent，状态落在空间上', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const headers = await login(page, baseURL ?? '');
  const agentId = await onlineAgent(page);
  test.skip(!agentId, '这台机器上没有可用的 agent');

  const project = await makeProject(page, headers);
  await configure(page, headers, project.id, `node -e "console.log('setup-ok-$((1+1))')"`);
  const task = await makeTask(page, headers, project.id);

  const derived = await page.request.post('/api/sessions/derive', {
    data: { taskId: task.id, agentId, model: piModel(), workspaceMode: 'isolated' },
    headers
  });
  expect(derived.status(), await derived.text()).toBe(201);
  const session = (await derived.json()) as { id: string; workspaceId: string | null };
  expect(session.workspaceId).not.toBeNull();

  // 空间是现建的临时空间，准备命令留下结果。
  await expect
    .poll(
      async () => {
        const found = (await temporaryWorkspaces(page, headers, project.id)).find((item) => item.id === session.workspaceId);
        return found?.setup?.state ?? 'missing';
      },
      { timeout: 30_000 }
    )
    .toBe('ready');

  const workspace = (await temporaryWorkspaces(page, headers, project.id)).find((item) => item.id === session.workspaceId);
  expect(workspace?.setup?.exitCode).toBe(0);
  expect(workspace?.setup?.output).toContain('setup-ok-2');

  // 会话页上看得见「准备完成 / 准备日志」，不只是一行数据库状态。
  await page.goto(`/#/p/${project.id}/focus/${session.id}`);
  const status = page.getByTestId('worktree-status');
  await expect(status).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('worktree-output-toggle')).toBeVisible();
});

test('准备失败：derive 被拒并说清原因，修好后重试即就绪', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const headers = await login(page, baseURL ?? '');
  const agentId = await onlineAgent(page);
  test.skip(!agentId, '这台机器上没有可用的 agent');

  const project = await makeProject(page, headers);
  await configure(page, headers, project.id, `node -e "process.exit(7)"`);
  const task = await makeTask(page, headers, project.id);

  const rejected = await page.request.post('/api/sessions/derive', {
    data: { taskId: task.id, agentId, model: piModel(), workspaceMode: 'isolated' },
    headers
  });
  expect(rejected.status()).toBe(409);
  expect(await rejected.text()).toContain('准备');

  // 空间留着（不是删掉重来），失败原因写在 setup 上。
  const failed = (await temporaryWorkspaces(page, headers, project.id)).find((item) => item.setup?.state === 'failed');
  expect(failed, '失败的空间应该保留下来等重试').toBeTruthy();
  expect(failed?.setup?.exitCode).toBe(7);

  await configure(page, headers, project.id, `node -e "console.log('retry-ok')"`);
  const retried = await page.request.post(`/api/workspaces/${failed?.id}/setup/retry`, { headers });
  expect(retried.status(), await retried.text()).toBe(200);
  const after = (await retried.json()) as Workspace;
  expect(after.setup?.state).toBe('ready');
  expect(after.setup?.output).toContain('retry-ok');

  // 修好后同一个空间可以用了。
  const derived = await page.request.post('/api/sessions/derive', {
    data: { taskId: task.id, agentId, model: piModel(), workspaceMode: 'isolated' },
    headers
  });
  expect(derived.status(), await derived.text()).toBe(201);
});

test('显式选定的工作空间优先于档位', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const headers = await login(page, baseURL ?? '');
  const agentId = await onlineAgent(page);
  test.skip(!agentId, '这台机器上没有可用的 agent');

  const project = await makeProject(page, headers);
  await configure(page, headers, project.id, `node -e "console.log('shared-setup')"`);

  // 先建一个长期空间，再带着它开会话：哪怕项目默认隔离，也不应该另开一个。
  const longLived = await page.request.post(`/api/projects/${project.id}/workspaces`, {
    data: { workerId: null, kind: 'long_lived', mode: 'create', path: mkdtempSync(join(tmpdir(), 'e2e-worktree-shared-')) },
    headers
  });
  expect(longLived.status(), await longLived.text()).toBe(201);
  const shared = (await longLived.json()) as { id: string };

  const task = await makeTask(page, headers, project.id);
  const derived = await page.request.post('/api/sessions/derive', {
    data: { taskId: task.id, agentId, model: piModel(), workspaceId: shared.id, workspaceMode: 'isolated' },
    headers
  });
  expect(derived.status(), await derived.text()).toBe(201);
  const session = (await derived.json()) as { workspaceId: string | null };
  expect(session.workspaceId).toBe(shared.id);
  expect(await temporaryWorkspaces(page, headers, project.id)).toHaveLength(0);
});
