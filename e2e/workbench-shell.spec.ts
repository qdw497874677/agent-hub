import { expect, test } from '@playwright/test';
import { loginByApi } from './login.ts';

for (const width of [390, 1280]) {
  test(`全局导航保持唯一，只有打开站内通知才标读（${width}px）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await loginByApi(page);
    const item = { sessionId: 'shell-session', taskId: 'shell-task', taskTitle: '测试任务', projectId: 'shell-project', projectName: '测试项目', agentId: 'agent', phase: 'needs_answer', since: Date.now(), reason: '等待回答', possible: false, expiresAt: null };
    await page.route('**/api/attention', (route) => route.fulfill({ json: { items: [item], working: 0 } }));
    let reads = 0;
    await page.route('**/api/notifications', async (route) => {
      await route.fulfill({ json: { unread: reads ? 0 : 1, items: [{ id: 'shell-test', title: '测试通知', body: '等待处理', link: '#/assets/mine', at: Date.now(), readAt: reads ? Date.now() : null }] } });
    });
    await page.route('**/api/notifications/read', async (route) => {
      reads++;
      await route.fulfill({ json: { ok: true } });
    });
    await page.goto('/#/home');
    await expect(page.getByTestId('workbench-shell')).toHaveCount(1);
    await expect(page.getByTestId('attention-inbox')).toHaveCount(1);
    const trigger = page.getByTestId(width < 1024 ? 'global-menu-button' : 'shell-inbox');
    await expect(trigger).toBeVisible();
    if (width < 1024) {
      await trigger.click();
      await page.getByTestId('shell-panel-more').getByRole('button', { name: /收件箱/ }).click();
    } else await trigger.click();
    const panel = page.getByTestId('shell-panel-inbox');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('attention-inbox')).toHaveCount(1);
    await expect(panel.getByTestId('attention-inbox')).toHaveCount(1);
    await expect(page.getByTestId('home-root').getByTestId('attention-inbox')).toHaveCount(0);
    await expect(panel.getByRole('tab', { name: /站内通知/ })).toContainText('1');
    expect(reads).toBe(0);
    await panel.getByRole('tab', { name: /站内通知/ }).click();
    await expect(panel.getByTestId('notification')).toContainText('测试通知');
    await expect(panel.getByTestId('attention-inbox')).toHaveCount(0);
    await expect(page.getByTestId('home-root').getByTestId('attention-inbox')).toHaveCount(1);
    await expect(page.getByTestId('attention-inbox')).toHaveCount(1);
    await expect.poll(() => reads).toBe(1);
    await panel.getByRole('tab', { name: /等我处理/ }).click();
    await expect(page.getByTestId('attention-inbox')).toHaveCount(1);
    await expect(panel.getByTestId('attention-inbox')).toHaveCount(1);
    await expect(page.getByTestId('home-root').getByTestId('attention-inbox')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.getByTestId('attention-inbox')).toHaveCount(1);
  });
}

test('通知加载较慢时不会当成空列表，抵达后才标读', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await loginByApi(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  await page.route('**/api/notifications', async (route) => {
    await gate;
    await route.fulfill({ json: { unread: reads ? 0 : 1, items: [{ id: 'late', title: '延迟通知', body: '', link: '#/', at: Date.now(), readAt: null }] } });
  });
  await page.route('**/api/notifications/read', async (route) => {
    reads++;
    await route.fulfill({ json: { ok: true } });
  });
  try {
    await page.goto('/#/');
    await page.getByTestId('shell-inbox').click();
    const panel = page.getByTestId('shell-panel-inbox');
    await panel.getByRole('tab', { name: /站内通知/ }).click();
    await expect(panel.getByText('正在加载通知…')).toBeVisible();
    await expect(panel.getByText('没有通知')).toHaveCount(0);
    expect(reads).toBe(0);
    release();
    await expect(panel.getByTestId('notification')).toContainText('延迟通知');
    await expect.poll(() => reads).toBe(1);
  } finally {
    release();
  }
});

test('桌面浮层贴近导航栏，不挤动内容；短视口可滚动、支持焦点约束和外部关闭', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 400 });
  await loginByApi(page);
  await page.goto('/#/home');
  const rail = page.getByTestId('app-rail');
  const content = page.getByTestId('home-root');
  const before = await content.boundingBox();
  for (const [buttonId, panelId] of [['shell-inbox', 'inbox'], ['messages-entry', 'messages'], ['shell-more', 'more']] as const) {
    const trigger = page.getByTestId(buttonId);
    await trigger.click();
    const panel = page.getByTestId(`shell-panel-${panelId}`);
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    await expect(panel).toBeFocused();
    const [anchor, bar, box, after] = await Promise.all([trigger.boundingBox(), rail.boundingBox(), panel.boundingBox(), content.boundingBox()]);
    expect(box!.x - (bar!.x + bar!.width)).toBeGreaterThanOrEqual(0);
    expect(box!.x - (bar!.x + bar!.width)).toBeLessThanOrEqual(12);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(400);
    expect(after).toEqual(before);
    if (panelId === 'more') {
      expect(box!.y + box!.height).toBeGreaterThanOrEqual(anchor!.y + anchor!.height - 16);
      expect(await panel.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    } else expect(box!.y).toBeLessThanOrEqual(anchor!.y + 2);
    await page.keyboard.press('Shift+Tab');
    await expect(panel).toContainText(panelId === 'inbox' ? '收件箱' : panelId === 'messages' ? '群聊' : '更多功能');
    expect(await panel.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    if (panelId === 'more') await page.mouse.click(1200, 20);
    else await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
});

test('手机全局菜单保留稳定名称，并分别说明待处理、通知和群聊未读', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginByApi(page);
  const item = { sessionId: 'test', taskId: 'task', taskTitle: '测试任务', projectId: 'project', projectName: '测试项目', agentId: 'agent', phase: 'needs_answer', since: Date.now(), reason: '等待回答', possible: false, expiresAt: null };
  await page.route('**/api/attention', (route) => route.fulfill({ json: { items: [item, { ...item, sessionId: 'test-2' }], working: 0 } }));
  await page.route('**/api/notifications', (route) => route.fulfill({ json: { items: [], unread: 3 } }));
  await page.route('**/api/groups/unread', (route) => route.fulfill({ json: { total: 4, groups: [] } }));
  await page.goto('/#/home');
  const menu = page.getByTestId('global-menu-button');
  await expect(menu).toHaveAccessibleName('全局菜单');
  await expect(menu).toHaveAccessibleDescription('待处理 2，站内通知未读 3，群聊未读 4');
  await expect(menu.getByTestId('global-menu-updates')).toBeVisible();
  await menu.click();
  const panel = page.getByTestId('shell-panel-more');
  await expect(panel.getByRole('button', { name: /收件箱/ })).toContainText('2 待处理');
  await expect(panel.getByRole('button', { name: /收件箱/ })).toContainText('3 通知未读');
  await expect(panel.getByRole('button', { name: /消息/ })).toContainText('4 未读');
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
});
