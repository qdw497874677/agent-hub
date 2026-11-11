import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { currentRun } from './run-id.ts';
import { loginByApi } from './login.ts';

/**
 * 真 OpenCode：通过 hub 派生一个 orchestrator 会话，让 OpenCode 自己开 explorer 子代理，
 * 并在专注对话里看到子代理卡。
 *
 * 这个用例依赖本机装了 opencode、并且 OpenCode 里配置了 my-codex 供应商。
 * 不适合在没装 OpenCode 的 CI 上跑；本地/真机回归用。
 */
const RUN = currentRun();
const PROJECT_NAME = `e2e-opencode-subagent-${RUN}`;
const PROJECT_DIR = `/tmp/agent-hub-opencode-subagent-${RUN}`;
const MODEL = 'my-codex/go-deepseek-v4.1-flash';

test.beforeAll(() => {
  mkdirSync(PROJECT_DIR, { recursive: true });
});

test('OpenCode 子代理通过 hub 触发并在会话里显示', async ({ page }) => {
  test.setTimeout(240_000);
  await loginByApi(page);

  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { 'x-hub-csrf': csrf };

  const project = await page.request.post('/api/projects', { headers, data: { name: PROJECT_NAME } });
  expect(project.ok(), await project.text()).toBeTruthy();
  const projectId = (await project.json()).id as string;

  const task = await page.request.post('/api/tasks', { headers, data: { projectId, title: `子代理任务-${RUN}` } });
  expect(task.ok(), await task.text()).toBeTruthy();
  const taskId = (await task.json()).id as string;

  type Worker = {
    workerId: string;
    origin: string;
    agentModels?: Array<{ agentId: string; models?: string[]; defaultModel?: string }>;
  };
  let local: Worker | undefined;
  let opencode: NonNullable<Worker['agentModels']>[number] | undefined;
  await expect
    .poll(
      async () => {
        const workers = await page.request.get('/api/workers');
        if (!workers.ok()) return null;
        const list = (await workers.json()) as Worker[];
        local = list.find((worker) => worker.origin === 'local');
        opencode = local?.agentModels?.find((entry) => entry.agentId === 'opencode');
        return opencode?.models?.includes(MODEL) ? 'ready' : null;
      },
      { timeout: 60_000, message: `等待本机 Worker 上报 opencode/${MODEL}` }
    )
    .toBe('ready');
  expect(local, '没有本机 Worker').toBeTruthy();
  expect(opencode, 'Worker 没有上报 opencode runtime').toBeTruthy();

  const workspace = await page.request.post(`/api/projects/${projectId}/workspaces`, {
    headers,
    data: { workerId: local?.workerId, kind: 'long_lived', mode: 'create' }
  });
  expect(workspace.ok(), await workspace.text()).toBeTruthy();
  const workspaceId = (await workspace.json()).id as string;

  const derived = await page.request.post('/api/sessions/derive', {
    headers,
    data: {
      taskId,
      agentId: 'opencode',
      model: MODEL,
      workspaceId,
      // orchestrator 的职责就是派给 specialist；build 不一定会用 task。
      options: { mode: 'orchestrator' }
    }
  });
  expect(derived.ok(), await derived.text()).toBeTruthy();
  const sessionId = (await derived.json()).id as string;

  await page.goto(`/#/p/${encodeURIComponent(projectId)}/focus/${encodeURIComponent(sessionId)}`);
  const input = page.getByLabel('发送消息');
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill('用 task 工具开一个 explorer 子代理，让它查看 /tmp 下有哪些文件，然后汇总告诉我。只做这一件事。');
  await page.getByRole('button', { name: '发送' }).click();

  const card = page.getByTestId('subagent-card').first();
  await expect(card).toBeVisible({ timeout: 180_000 });
  await expect(card).toContainText(/explorer/i);
  await expect(card).toHaveAttribute('data-status', /running|completed/);

  // 展开后应能看到子代理自己的工具/文本，而不是只有父会话一条 tool 卡。
  await card.locator('summary').first().click();
  await expect(card).toContainText(/run|ls|tmp|explorer/i, { timeout: 30_000 });

  // 事件里也要有结构化 subagent 生命周期，证明不是前端伪造。
  const events = await page.request.get(`/api/sessions/${sessionId}/events?after=0`);
  expect(events.ok()).toBeTruthy();
  const journal = (await events.json()) as Array<{ event?: { kind?: string; agent?: string; phase?: string } }>;
  expect(journal.some((entry) => entry.event?.kind === 'subagent')).toBeTruthy();
});
