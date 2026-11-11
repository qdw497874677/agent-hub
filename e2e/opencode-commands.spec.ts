import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { currentRun } from './run-id.ts';
import { loginByApi } from './login.ts';

/**
 * 真 OpenCode：会话创建后，运行时应通过 ACP available_commands_update
 * 把自己的斜杠命令报给 Hub，输入 `/` 时与 Hub 自带的 /interrupt、/new、/fork 一起出现。
 *
 * 依赖本机 opencode + my-codex 供应商；本地/真机回归用。
 */
const RUN = currentRun();
const PROJECT_NAME = `e2e-opencode-commands-${RUN}`;
const PROJECT_DIR = `/tmp/agent-hub-opencode-commands-${RUN}`;
const MODEL = 'my-codex/go-deepseek-v4.1-flash';

test.beforeAll(() => {
  mkdirSync(PROJECT_DIR, { recursive: true });
});

test('OpenCode 的运行时斜杠命令透出到 Hub 输入框', async ({ page }) => {
  test.setTimeout(120_000);
  await loginByApi(page);

  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { 'x-hub-csrf': csrf };

  const project = await page.request.post('/api/projects', { headers, data: { name: PROJECT_NAME } });
  expect(project.ok(), await project.text()).toBeTruthy();
  const projectId = (await project.json()).id as string;

  const task = await page.request.post('/api/tasks', { headers, data: { projectId, title: `斜杠命令-${RUN}` } });
  expect(task.ok(), await task.text()).toBeTruthy();
  const taskId = (await task.json()).id as string;

  type Worker = {
    workerId: string;
    origin: string;
    agentModels?: Array<{ agentId: string; models?: string[] }>;
  };
  let local: Worker | undefined;
  await expect
    .poll(
      async () => {
        const workers = await page.request.get('/api/workers');
        if (!workers.ok()) return null;
        const list = (await workers.json()) as Worker[];
        local = list.find((worker) => worker.origin === 'local');
        const opencode = local?.agentModels?.find((entry) => entry.agentId === 'opencode');
        return opencode?.models?.includes(MODEL) ? 'ready' : null;
      },
      { timeout: 60_000, message: `等待本机 Worker 上报 opencode/${MODEL}` }
    )
    .toBe('ready');
  expect(local, '没有本机 Worker').toBeTruthy();

  const workspace = await page.request.post(`/api/projects/${projectId}/workspaces`, {
    headers,
    data: { workerId: local?.workerId, kind: 'long_lived', mode: 'create' }
  });
  expect(workspace.ok(), await workspace.text()).toBeTruthy();
  const workspaceId = (await workspace.json()).id as string;

  const derived = await page.request.post('/api/sessions/derive', {
    headers,
    data: { taskId, agentId: 'opencode', model: MODEL, workspaceId, options: { mode: 'orchestrator' } }
  });
  expect(derived.ok(), await derived.text()).toBeTruthy();
  const sessionId = (await derived.json()).id as string;

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/p/${encodeURIComponent(projectId)}/focus/${encodeURIComponent(sessionId)}`);
  const input = page.getByLabel('发送消息');
  await expect(input).toBeVisible({ timeout: 30_000 });

  // 命令是 session/new 之后异步报上来的；先等事件落库，再打开菜单。
  await expect
    .poll(
      async () => {
        const events = await page.request.get(`/api/sessions/${sessionId}/events?after=0`);
        if (!events.ok()) return 0;
        const journal = (await events.json()) as Array<{ event?: { kind?: string; commands?: unknown[] } }>;
        return journal.find((entry) => entry.event?.kind === 'commands')?.event?.commands?.length ?? 0;
      },
      { timeout: 30_000, message: '等待 OpenCode 上报 available_commands' }
    )
    .toBeGreaterThan(3);

  await input.fill('/');
  const menu = page.getByRole('listbox', { name: '命令' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('option', { name: /^\/interrupt/ })).toBeVisible();
  await expect(menu.getByRole('option', { name: /^\/init/ })).toBeVisible();
  await expect(menu.getByRole('option', { name: /^\/review/ })).toBeVisible();
  await expect(menu.getByRole('option', { name: /^\/compact/ })).toBeVisible();
  // 手机上命令名不能被长说明挤掉；菜单也不能横向溢出。
  expect(await menu.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const clipped = await menu.locator('li > button > span:first-child').evaluateAll((nodes) =>
    nodes.some((node) => node.scrollWidth > node.clientWidth + 1)
  );
  expect(clipped).toBe(false);
});
