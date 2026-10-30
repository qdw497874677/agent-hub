import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * 会话页就是对话（参照 OpenCode web）：从画布点卡片直接进对话；
 * 详情（能力、资产、事件流）在抽屉里；分叉、换个地方继续在「更多」和消息菜单里；显示设置按账号记住。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'];

async function openFromCanvas(page: Page, baseURL: string, say?: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
  const agentId = workers.find((worker) => worker.state === 'online')?.agentIds[0];
  test.skip(!agentId, '这台机器上没有可用的 agent');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-chat-'));
  const name = `e2e 对话 ${Date.now().toString(36)}`;
  const project = (await (await page.request.post('/api/projects', { data: { name, rootPath: dir }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '第一个任务，随便聊聊' }, headers })).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers });
  expect(derived.status(), await derived.text()).toBe(201);
  const { id } = (await derived.json()) as { id: string };
  if (say) {
    const sent = await page.request.post(`/api/sessions/${id}/prompt`, { data: { text: say, attachments: [] }, headers });
    expect(sent.ok(), await sent.text()).toBe(true);
  }
  await page.goto(`/#/p/${project.id}/canvas`);
  const node = page.locator('.react-flow__node-session');
  await expect(node).toHaveCount(1);
  await node.locator('header, p').first().click();
  await expect(page.getByRole('log', { name: '对话记录' }), '单击卡片只选中，不进对话').toHaveCount(0);
  await node.getByRole('button', { name: '打开' }).click();
  const log = page.getByRole('log', { name: '对话记录' });
  await expect(log, '点「打开」进对话').toBeVisible();
  return { log, headers, project, sessionId: id };
}

for (const width of [360, 430]) {
  test(`${width}px 手机：单击选中、点「打开」进对话；详情抽屉、更多菜单、底栏一行`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 800 });
    await openFromCanvas(page, baseURL!);
    await expect(page.getByRole('complementary', { name: '会话详情' }), '详情默认不占地方').toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/chat-${width}.png` });

    // 底栏：模型和思考强度在同一行，不换行
    const selects = page.locator('select:visible, [aria-haspopup="listbox"]:visible');
    if ((await selects.count()) >= 2) {
      const [a, b] = [await selects.nth(0).boundingBox(), await selects.nth(1).boundingBox()];
      expect(Math.abs((a?.y ?? 0) - (b?.y ?? 0)), '模型和思考强度同一行').toBeLessThan(8);
    }

    await page.getByRole('button', { name: '更多' }).click();
    await expect(page.getByRole('menuitem', { name: /^分叉/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /从某一步分叉/ })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: /换个地方继续/ })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: '详情' }).click();
    const sheet = page.getByRole('complementary', { name: '会话详情' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('能力', { exact: true })).toBeVisible();
    await sheet.getByRole('button', { name: '查看事件流' }).click();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/chat-details-${width}.png` });
    await sheet.getByRole('button', { name: '关闭' }).click();
    await expect(sheet).toHaveCount(0);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, '没有横向滚动').toBeLessThanOrEqual(0);
  });
}

test('显示设置：每个选项都能切，刷新后还在', async ({ page, baseURL }) => {
  await openFromCanvas(page, baseURL!);
  const open = async () => {
    await page.getByRole('button', { name: '显示设置' }).click();
    return page.getByTestId('display-settings');
  };
  let panel = await open();
  const tools = panel.getByRole('radiogroup', { name: '工具调用' });
  const thinking = panel.getByRole('radiogroup', { name: '思考过程' });
  for (const value of ['展开', '隐藏', '折叠']) {
    await tools.getByRole('radio', { name: value }).click();
    await expect(tools.getByRole('radio', { name: value })).toHaveAttribute('aria-checked', 'true');
  }
  for (const value of ['显示', '折叠', '隐藏']) {
    await thinking.getByRole('radio', { name: value }).click();
    await expect(thinking.getByRole('radio', { name: value })).toHaveAttribute('aria-checked', 'true');
  }
  await panel.getByRole('switch', { name: '命令输出默认展开' }).check();
  await panel.getByRole('switch', { name: '文件改动默认展开' }).uncheck();
  await panel.getByRole('switch', { name: '紧凑模式' }).check();
  await expect(page.getByRole('log', { name: '对话记录' })).toHaveAttribute('data-compact', 'true');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/chat-display-settings.png` });

  await page.reload();
  panel = await open();
  await expect(panel.getByRole('radiogroup', { name: '思考过程' }).getByRole('radio', { name: '隐藏' })).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByRole('radiogroup', { name: '工具调用' }).getByRole('radio', { name: '折叠' })).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByRole('switch', { name: '命令输出默认展开' })).toBeChecked();
  await expect(panel.getByRole('switch', { name: '文件改动默认展开' })).not.toBeChecked();
  await expect(panel.getByRole('switch', { name: '紧凑模式' })).toBeChecked();
  await expect(page.getByRole('log', { name: '对话记录' })).toHaveAttribute('data-compact', 'true');
  // 还原，别影响别的用例
  await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('agent-hub.display.')).forEach((k) => localStorage.removeItem(k)));
});

test('真回复：用户气泡 + markdown 回复；「更多」→分叉进新会话，看到分叉前的对话和分界线', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const { log, project } = await openFromCanvas(page, baseURL!, '只回复两个字：好的');
  await expect(log.getByTestId('msg-user')).toContainText('好的');
  const reply = log.getByTestId('msg-assistant').first();
  await expect(reply).toBeVisible({ timeout: 150_000 });
  const before = page.url();
  if (SHOTS) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('button', { name: '详情', exact: true }).click();
    await expect(page.getByRole('complementary', { name: '会话详情' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/chat-details-desktop.png` });
    await page.keyboard.press('Escape');
  }

  await expect(reply.getByRole('button', { name: '消息操作' }), '不再有逐条消息的分叉').toHaveCount(0);
  await page.getByRole('button', { name: '更多' }).click();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/chat-fork-menu.png` });
  await page.getByRole('menuitem', { name: /^分叉/ }).click();
  await expect.poll(() => page.url(), '分叉后进新会话').not.toBe(before);
  // 新会话先看到来源分叉前的对话（只读、变淡），再是分界线，分界线链回来源
  const inherited = page.getByTestId('fork-inherited');
  await expect(inherited.getByTestId('msg-user')).toContainText('好的');
  await expect(inherited.getByTestId('msg-assistant').first()).toBeVisible();
  const divider = page.getByTestId('fork-divider');
  await expect(divider).toContainText(/从「.+」分叉 · \d+-\d{2} \d{2}:\d{2}/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/chat-forked.png` });
  await divider.getByRole('button').click();
  await expect.poll(() => page.url(), '分界线链回来源').toBe(before);

  // 再从来源分一次（服务端不管传什么 atSeq 都从最新处分）
  await expect(log.getByTestId('msg-assistant').first()).toBeVisible();
  await page.getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: /^分叉/ }).click();
  await expect.poll(() => page.url()).not.toBe(before);

  await page.goto(`/#/p/${project.id}/canvas`);
  await expect(page.locator('.react-flow__node-session')).toHaveCount(3);
});
