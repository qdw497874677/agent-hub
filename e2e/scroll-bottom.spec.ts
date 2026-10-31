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
  const ended = async () => {
    const events = (await (await page.request.get(`/api/sessions/${id}/events`)).json()) as Array<{ kind?: string; event?: { kind?: string } }>;
    return events.filter((entry) => (entry.kind ?? entry.event?.kind) === 'ended').length;
  };
  // 一句一句来：等上一句的失败落地再问下一句，免得连发被合并或丢掉
  const say = async (n: number) => {
    const before = await ended();
    await page.request.post(`/api/sessions/${id}/prompt`, { data: { text: `第 ${n} 句：${'很长的一段话，'.repeat(12)}`, attachments: [] }, headers });
    await expect.poll(ended, { message: `第 ${n} 句的失败落地`, timeout: 15_000 }).toBeGreaterThan(before);
  };
  for (let n = 1; n <= 14; n++) await say(n);
  return { project, say };
}

// 卡片只渲染最近一段，数条数不可靠：改成盯 DOM 有没有变
const watchChanges = (loc: Locator) => loc.evaluate((node) => {
  (node as any).__changed = false;
  new MutationObserver(() => ((node as any).__changed = true)).observe(node, { childList: true, subtree: true, characterData: true });
});
const changed = (loc: Locator) => loc.evaluate((node) => Boolean((node as any).__changed));

test('长对话：画布卡片和专注对话默认在最后；翻上去时新消息不拽回', async ({ page, baseURL }) => {
  const { project, say } = await longSession(page, baseURL!);
  await page.goto(`/#/p/${project.id}/canvas`);
  const card = page.locator('.react-flow__node-session');
  await expect(card).toHaveCount(1);
  const cardScroll = card.locator('div.overflow-y-auto').first();
  // 攒够两屏多，翻到顶后离底部才有足够距离可测
  let n = 14;
  while (n < 40 && (await cardScroll.evaluate((node) => node.scrollHeight < node.clientHeight * 2.5))) await say(++n);
  await expect.poll(() => scrollable(cardScroll), { message: '卡片里内容确实超过一屏' }).toBe(true);
  await expect.poll(() => gap(cardScroll), { message: '画布卡片默认停在最后' }).toBeLessThan(4);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/canvas-card-desktop.png` });

  // 往上翻着看历史：来新消息不拽回
  await cardScroll.evaluate((node) => (node.scrollTop = 0));
  await watchChanges(cardScroll);
  await say(++n);
  await expect.poll(() => changed(cardScroll), { message: '卡片收到下一句的新内容' }).toBe(true);
  await page.waitForTimeout(500);
  expect(await gap(cardScroll), '翻上去时不拽回底部').toBeGreaterThan(100);
  // 回到底部附近：新消息跟着走
  await cardScroll.evaluate((node) => (node.scrollTop = node.scrollHeight));
  await watchChanges(cardScroll);
  await say(++n);
  await expect.poll(() => changed(cardScroll), { message: '卡片收到再下一句的新内容' }).toBe(true);
  await expect.poll(() => gap(cardScroll), { message: '在底部时跟着新消息走' }).toBeLessThan(4);

  // 专注对话：打开就在最后
  await card.getByRole('button', { name: '打开' }).click();
  const log = page.getByRole('log', { name: '对话记录' });
  await expect(log).toContainText(`第 ${n} 句`);
  const chatScroll = log.locator('xpath=..');
  await expect.poll(() => gap(chatScroll), { message: '专注对话默认停在最后' }).toBeLessThan(4);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/chat-desktop.png` });

  // 390 手机宽度
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(log).toContainText(`第 ${n} 句`);
  await expect.poll(() => gap(chatScroll), { message: '手机上专注对话也停在最后' }).toBeLessThan(4);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/chat-390.png` });
  await page.goto(`/#/p/${project.id}/canvas`);
  await page.reload();
  await expect.poll(() => scrollable(cardScroll), { message: '手机上卡片有长内容' }).toBe(true);
  await expect.poll(() => gap(cardScroll), { message: '手机上画布卡片也停在最后' }).toBeLessThan(4);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/canvas-card-390.png` });
});

const viewportTransform = (page: Page) => page.locator('.react-flow__viewport').evaluate((node) => (node as HTMLElement).style.transform);

test.describe('画布卡片里的对话', () => {
  // 开触摸：既能用滚轮，又能用 CDP 合成手指滑动
  test.use({ hasTouch: true });
for (const width of [1280, 390]) {
  test(`${width}px：卡片里的对话能滚，滚轮/手指滑动不拖动、不缩放画布；单击只选中，「打开」进对话`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 844 });
    const { project, say } = await longSession(page, baseURL!);
    await page.goto(`/#/p/${project.id}/canvas`);
    const card = page.locator('.react-flow__node-session');
    await expect(card).toHaveCount(1);
    const log = card.getByTestId('session-card-log');
    let n = 14;
    while (n < 40 && (await log.evaluate((node) => node.scrollHeight < node.clientHeight * 2.5))) await say(++n);
    await expect.poll(() => gap(log), { message: '默认停在最后' }).toBeLessThan(4);
    await log.scrollIntoViewIfNeeded();
    // 用户自己说的话也在卡片里（靠右的气泡），不是只有 agent 的输出
    const mine = log.getByTestId('card-msg-user').last();
    await expect(mine).toContainText(`第 ${n} 句`);
    await expect(mine).toBeVisible();
    const [bubble, area] = [(await mine.locator('p').first().boundingBox())!, (await log.boundingBox())!];
    expect(bubble.x + bubble.width, '用户气泡靠右').toBeGreaterThan(area.x + area.width - 24);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/canvas-card-user-${width}.png` });

    // 滚轮：滚的是对话
    const before = await viewportTransform(page);
    const box = (await log.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    await expect.poll(() => gap(log), { message: '滚轮往上翻了对话' }).toBeGreaterThan(100);
    expect(await viewportTransform(page), '画布没被缩放或平移').toBe(before);

    // 手指滑动（CDP 触摸手势）：同样只滚对话
    const cdp = await page.context().newCDPSession(page);
    const top = await log.evaluate((node) => node.scrollTop);
    const x = Math.round(box.x + box.width / 2);
    const y0 = Math.round(box.y + box.height * 0.75);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
    for (let step = 1; step <= 10; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 - step * 15 }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => log.evaluate((node) => node.scrollTop), { message: '手指往下拖，对话继续往底部滚' }).toBeGreaterThan(top);
    expect(await viewportTransform(page), '画布没被拖动').toBe(before);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/canvas-card-scroll-${width}.png` });

    // 单击只选中：卡片描边变色、「打开」按钮露出来，但不进对话
    await card.locator('header').click({ position: { x: 8, y: 8 } });
    await expect(page.getByRole('log', { name: '对话记录' })).toHaveCount(0);
    const open = card.getByRole('button', { name: '打开' });
    await expect(open).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/canvas-card-selected-${width}.png` });
    await open.click();
    await expect(page.getByRole('log', { name: '对话记录' }), '点「打开」进对话').toBeVisible();
  });
}
});
