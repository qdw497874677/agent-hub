import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { piModel } from './hub-model.ts';

/**
 * 画布卡片的发送反馈：和专注对话是同一份实现（`atoms/prompt-delivery.tsx`），
 * 所以这里只需要证明「卡片上也看得见」——乐观气泡先出来、回显后消失、弱网超时能重试。
 *
 * 卡片在 React Flow 节点里，输入框的 aria-label 是「对 XXXX 说一句」。
 */
async function openCanvas(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  let agentId: string | undefined;
  for (let attempt = 0; attempt < 30 && agentId === undefined; attempt++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((worker) => worker.state === 'online')?.agentIds[0];
    if (agentId === undefined) await page.waitForTimeout(500);
  }
  test.skip(!agentId, '这台机器上没有可用的 agent');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-card-'));
  const project = (await (
    await page.request.post('/api/projects', {
      data: { name: `e2e 卡片反馈 ${Date.now().toString(36)}`, rootPath: dir },
      headers
    })
  ).json()) as { id: string };
  const task = (await (
    await page.request.post('/api/tasks', { data: { projectId: project.id, title: '卡片反馈' }, headers })
  ).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', {
    data: { taskId: task.id, agentId, model: piModel() },
    headers
  });
  expect(derived.status(), await derived.text()).toBe(201);
  const { id } = (await derived.json()) as { id: string };
  await page.goto(`/#/p/${project.id}/canvas`);
  const card = page.locator('.react-flow__node-session').first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  const area = card.getByLabel(/^对 .* 说一句$/);
  await expect(area).toBeVisible();
  return { area, headers, sessionId: id };
}

async function promptCount(page: Page, headers: Record<string, string>, sessionId: string, text: string): Promise<number> {
  const events = (await (await page.request.get(`/api/sessions/${sessionId}/events`, { headers })).json()) as Array<{
    event: { kind: string; text?: string };
  }>;
  return events.filter((entry) => entry.event.kind === 'prompt' && entry.event.text === text).length;
}

test('画布卡片：发出去先有气泡，回显后消失', async ({ page, baseURL }) => {
  const { area } = await openCanvas(page, baseURL ?? '');
  const text = `卡片消息 ${Date.now().toString(36)}`;

  // 本地 worker 的回执与回显都在几十毫秒内完成，气泡一闪就没了；压 600ms 才测得出来。
  await page.route('**/api/sessions/*/prompt', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });

  await area.fill(text);
  await area.press('Enter');

  const pending = page.getByTestId('card-pending-prompts');
  await expect(pending).toBeVisible();
  await expect(pending).toContainText('正在发送…');
  // journal 回显（带同一个 clientMessageId）之后气泡让位给真实消息。
  await expect(pending).toHaveCount(0, { timeout: 20_000 });
});

test('画布卡片：弱网超时变未送达，重试不产生重复消息', async ({ page, baseURL }) => {
  const { area, headers, sessionId } = await openCanvas(page, baseURL ?? '');
  const text = `卡片弱网 ${Date.now().toString(36)}`;

  let first = true;
  await page.route('**/api/sessions/*/prompt', async (route) => {
    if (first) {
      first = false;
      await new Promise((resolve) => setTimeout(resolve, 9_000));
    }
    await route.continue();
  });

  await area.fill(text);
  await area.press('Enter');

  await expect(page.getByTestId('card-pending-prompts')).toBeVisible();
  await expect(page.getByTestId('card-pending-unknown')).toBeVisible({ timeout: 12_000 });
  await page.getByTestId('card-pending-retry').click();

  await expect.poll(async () => promptCount(page, headers, sessionId, text), { timeout: 20_000 }).toBe(1);
  await expect(page.getByTestId('card-pending-prompts')).toHaveCount(0, { timeout: 20_000 });
});
