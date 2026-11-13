import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { piModel } from './hub-model.ts';

/**
 * 弱网 / 离线：发送出去之后的每一段都要有落点。
 *
 * - 请求慢（弱网）：气泡先出来，超过回执超时变成「未送达 · 重试」，点重试用同一个 clientMessageId，
 *   服务端幂等，不会出现两条一样的消息。
 * - 机器离线：输入区说清原因并禁用发送，别让人写完一屏才发现在等一台不在的机器。
 */
async function openSession(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  // Worker 连上来要一两秒：等它上线，别把「慢」当成「没有 agent」。
  let agentId: string | undefined;
  for (let attempt = 0; attempt < 30 && agentId === undefined; attempt++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((worker) => worker.state === 'online')?.agentIds[0];
    if (agentId === undefined) await page.waitForTimeout(500);
  }
  test.skip(!agentId, '这台机器上没有可用的 agent');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-offline-'));
  const project = (await (
    await page.request.post('/api/projects', {
      data: { name: `e2e 弱网 ${Date.now().toString(36)}`, rootPath: dir },
      headers
    })
  ).json()) as { id: string };
  const task = (await (
    await page.request.post('/api/tasks', { data: { projectId: project.id, title: '弱网' }, headers })
  ).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', {
    data: { taskId: task.id, agentId, model: piModel() },
    headers
  });
  expect(derived.status(), await derived.text()).toBe(201);
  const { id } = (await derived.json()) as { id: string };
  await page.goto(`/#/p/${project.id}/focus/${id}`);
  const area = page.getByLabel('发送消息');
  await expect(area).toBeVisible();
  return { area, headers, project, sessionId: id };
}

/** 已经进 journal 的 prompt 条数（按文本数，够用了）。 */
async function promptCount(page: Page, headers: Record<string, string>, sessionId: string, text: string): Promise<number> {
  const events = (await (await page.request.get(`/api/sessions/${sessionId}/events`, { headers })).json()) as Array<{
    event: { kind: string; text?: string };
  }>;
  return events.filter((entry) => entry.event.kind === 'prompt' && entry.event.text === text).length;
}

test('弱网：回执超时后气泡变未送达，重试不会产生重复消息', async ({ page, baseURL }) => {
  const { area, headers, sessionId } = await openSession(page, baseURL ?? '');
  const text = `弱网消息 ${Date.now().toString(36)}`;

  // 第一次请求卡住 9 秒（超过 8 秒回执超时），之后放行。
  let first = true;
  await page.route('**/api/sessions/*/prompt', async (route) => {
    if (first) {
      first = false;
      await new Promise((resolve) => setTimeout(resolve, 9_000));
    }
    await route.continue();
  });

  await area.fill(text);
  await area.press('Control+Enter');

  const pending = page.getByTestId('pending-prompts');
  await expect(pending).toBeVisible();
  await expect(pending).toContainText('正在发送…');

  // 8 秒超时后：同一颗气泡原地变成「未送达」，给出重试/放弃。
  await expect(page.getByTestId('pending-unknown')).toBeVisible({ timeout: 12_000 });
  await expect(page.getByTestId('pending-retry')).toBeVisible();

  await page.getByTestId('pending-retry').click();

  // 重试用的是同一个 clientMessageId：journal 里只有一条。
  await expect
    .poll(async () => promptCount(page, headers, sessionId, text), { timeout: 15_000 })
    .toBe(1);
  await expect(page.getByTestId('pending-prompts')).toHaveCount(0);
});

test('机器离线：输入区说明原因并禁用发送', async ({ page, baseURL }) => {
  const { area } = await openSession(page, baseURL ?? '');

  // 把机器列表改成离线：composer 应当就地提示，而不是等发送失败。
  await page.route('**/api/workers', async (route) => {
    const response = await route.fetch();
    const workers = (await response.json()) as Array<Record<string, unknown>>;
    await route.fulfill({
      response,
      json: workers.map((worker) => ({ ...worker, state: 'offline', reason: '网络断了' }))
    });
  });
  await page.reload();

  await expect(page.getByRole('status').filter({ hasText: '离线' }).first()).toBeVisible({ timeout: 15_000 });
  await area.fill('写点东西');
  await expect(page.getByRole('button', { name: '发送' })).toBeDisabled();
});
