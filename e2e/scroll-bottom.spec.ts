import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * 长对话默认停在最新一条：画布卡片和专注对话都是。往上翻着看历史时，新消息不把人拽回底部。
 * 不依赖真模型：会话目录建完就删掉，每问一句都会落「问话 + 失败原因」两条，攒出一段长对话。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'];

const gap = (el: Locator) => el.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
const scrollable = (el: Locator) => el.evaluate((node) => node.scrollHeight > node.clientHeight + 10);

async function longSession(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  let agentId: string | undefined;
  for (let i = 0; i < 40 && !agentId; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((worker) => worker.state === 'online')?.agentIds[0];
    if (!agentId) await page.waitForTimeout(500);
  }
  test.skip(!agentId, '这台机器上没有可用的 agent');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-scroll-'));
  const name = `e2e 长对话 ${Date.now().toString(36)}`;
  const project = (await (await page.request.post('/api/projects', { data: { name, rootPath: dir }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '长对话' }, headers })).json()) as { id: string };
  rmSync(dir, { recursive: true, force: true });
  const { id } = (await (await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers })).json()) as { id: string };
  const say = (n: number) => page.request.post(`/api/sessions/${id}/prompt`, { data: { text: `第 ${n} 句：${'很长的一段话，'.repeat(12)}`, attachments: [] }, headers });
  for (let n = 1; n <= 14; n++) await say(n);
  return { project, say };
}

test('长对话：画布卡片和专注对话默认在最后；翻上去时新消息不拽回', async ({ page, baseURL }) => {
  const { project, say } = await longSession(page, baseURL!);
  await page.goto(`/#/p/${project.id}/canvas`);
  const card = page.locator('.react-flow__node-session');
  await expect(card).toHaveCount(1);
  const cardScroll = card.locator('div.overflow-y-auto').first();
  await expect.poll(async () => ((await cardScroll.innerText()).match(/发送失败/g) ?? []).length, { message: '卡片里攒到第 14 条失败' }).toBeGreaterThanOrEqual(14);
  expect(await scrollable(cardScroll), '卡片里内容确实超过一屏').toBe(true);
  await expect.poll(() => gap(cardScroll), { message: '画布卡片默认停在最后' }).toBeLessThan(4);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/canvas-card-desktop.png` });

  // 往上翻着看历史：来新消息不拽回
  await cardScroll.evaluate((node) => (node.scrollTop = 0));
  await say(15);
  await expect.poll(async () => ((await cardScroll.innerText()).match(/发送失败/g) ?? []).length, { message: '卡片里攒到第 15 条失败' }).toBeGreaterThanOrEqual(15);
  await page.waitForTimeout(500);
  expect(await cardScroll.evaluate((node) => node.scrollTop), '翻上去时不拽回底部').toBeLessThan(10);
  // 回到底部附近：新消息跟着走
  await cardScroll.evaluate((node) => (node.scrollTop = node.scrollHeight));
  await say(16);
  await expect.poll(async () => ((await cardScroll.innerText()).match(/发送失败/g) ?? []).length, { message: '卡片里攒到第 16 条失败' }).toBeGreaterThanOrEqual(16);
  await expect.poll(() => gap(cardScroll), { message: '在底部时跟着新消息走' }).toBeLessThan(4);

  // 专注对话：打开就在最后
  await card.locator('header, p').first().click();
  const log = page.getByRole('log', { name: '对话记录' });
  await expect(log).toContainText('第 16 句');
  const chatScroll = log.locator('xpath=..');
  await expect.poll(() => gap(chatScroll), { message: '专注对话默认停在最后' }).toBeLessThan(4);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/chat-desktop.png` });

  // 390 手机宽度
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(log).toContainText('第 16 句');
  await expect.poll(() => gap(chatScroll), { message: '手机上专注对话也停在最后' }).toBeLessThan(4);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/chat-390.png` });
  await page.goto(`/#/p/${project.id}/canvas`);
  await page.reload();
  await expect.poll(async () => ((await cardScroll.innerText()).match(/发送失败/g) ?? []).length, { message: '手机上卡片有长内容' }).toBeGreaterThanOrEqual(8);
  await expect.poll(() => gap(cardScroll), { message: '手机上画布卡片也停在最后' }).toBeLessThan(4);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/canvas-card-390.png` });
});
