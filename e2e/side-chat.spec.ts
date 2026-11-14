import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { piModel } from './hub-model.ts';

/**
 * I4 侧聊（docs/design/interaction-borrowing.md §5）：用主会话的工作空间单独问一轮，
 * 不进画布，页面上从「⋯ → 开一条侧聊…」进，顶部有一条能返回主会话的横幅。
 */
async function setup(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  let agentId: string | undefined;
  for (let attempt = 0; attempt < 30 && agentId === undefined; attempt++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((worker) => worker.state === 'online')?.agentIds?.[0];
    if (agentId === undefined) await page.waitForTimeout(500);
  }
  test.skip(!agentId, '这台机器上没有可用的 agent');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-side-'));
  const project = (await (
    await page.request.post('/api/projects', {
      data: { name: `e2e 侧聊 ${Date.now().toString(36)}`, rootPath: dir },
      headers
    })
  ).json()) as { id: string };
  const task = (await (
    await page.request.post('/api/tasks', { data: { projectId: project.id, title: '侧聊' }, headers })
  ).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', {
    data: { taskId: task.id, agentId, model: piModel() },
    headers
  });
  expect(derived.status(), await derived.text()).toBe(201);
  const { id } = (await derived.json()) as { id: string };
  return { projectId: project.id, sessionId: id, headers };
}

test('侧聊：从会话菜单开一条，不进画布，能返回主会话', async ({ page, baseURL }) => {
  const { projectId, sessionId } = await setup(page, baseURL ?? 'http://127.0.0.1:7896');

  await page.goto(`/#/p/${projectId}/focus/${sessionId}`);
  await expect(page.getByRole('log', { name: '会话记录' })).toBeVisible();

  await page.getByRole('button', { name: '更多' }).click();
  await page.getByTestId('session-side-open').click();

  // 侧聊会话自己有横幅；「返回主会话」回到原来那条
  await expect(page.getByTestId('side-session-banner')).toBeVisible({ timeout: 15_000 });

  const canvas = (await (await page.request.get(`/api/projects/${projectId}/canvas`)).json()) as {
    sessions: { id: string; kind?: string }[];
  };
  expect(canvas.sessions.every((session) => session.kind !== 'side')).toBe(true);

  await page.getByTestId('side-session-banner').click();
  await expect(page.getByTestId('side-session-banner')).toHaveCount(0);
});
