import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';

/** 顶栏常驻「消息」入口：有未读时红点，点进群看过就清掉；手机 390 和桌面 1280 都要在。 */
const SHOTS = process.env['SHOTS_DIR'] ?? '/workspace/shots/messages-entry';

async function setup(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  const created = await page.request.post('/api/projects', { data: { name: `e2e 消息入口 ${Date.now().toString(36)}`, rootPath: mkdtempSync(join(tmpdir(), 'e2e-msg-')) }, headers });
  expect(created.ok(), await created.text()).toBe(true);
  const project = ((await created.json()) as { id: string }).id;
  const roles = await page.request.put(`/api/projects/${project}/messaging`, { headers, data: { roles: [{ name: 'writer', agentId: 'grok', model: '' }], limits: {} } });
  expect(roles.ok(), await roles.text()).toBe(true);
  // 先把之前用例留下的未读全部标掉，红点从 0 起算
  const before = (await (await page.request.get('/api/groups/unread')).json()) as { groups: { groupId: string }[] };
  for (const g of before.groups) expect((await page.request.post(`/api/groups/${g.groupId}/read`, { headers, data: {} })).ok()).toBe(true);
  return { project, headers };
}

for (const vp of [{ name: 'mobile', width: 390, height: 844 }, { name: 'desktop', width: 1280, height: 800 }]) {
  test(`消息入口红点：出现 → 看过清零（${vp.name} ${vp.width}）`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const w = await setup(page, baseURL!);
    await page.goto(`/#/p/${w.project}`);
    const entry = page.getByTestId('messages-entry');
    await expect(entry).toBeVisible();
    await expect(page.getByTestId('messages-unread')).toHaveCount(0);
    const box = await entry.boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(vp.width);

    // 建群会贴一条系统消息——对我来说就是一条别人发的未读
    const g = await page.request.post(`/api/projects/${w.project}/groups`, { headers: w.headers, data: { name: `入口 ${vp.name}`, members: ['writer'] } });
    expect(g.ok(), await g.text()).toBe(true);
    const group = ((await g.json()) as { id: string }).id;
    // 轮询兜底 10s；切回页面也会刷，这里直接等
    await expect(page.getByTestId('messages-unread')).toBeVisible({ timeout: 20_000 });
    await expect(entry).toHaveAttribute('aria-label', /未读/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(vp.width);
    await page.screenshot({ path: `${SHOTS}/${vp.name}-unread.png` });

    // 首页也有入口
    await page.goto('/#/');
    await expect(page.getByTestId('messages-unread')).toBeVisible();

    await entry.click();
    await expect(page).toHaveURL(/#\/messages/);
    await page.goto(`/#/messages/${w.project}`);
    if (vp.width >= 768) await expect(page.getByTestId('group-unread')).toBeVisible();
    await page.getByTestId('group-item').filter({ hasText: `入口 ${vp.name}` }).click();
    await expect(page.getByTestId('chat-title')).toHaveText(`入口 ${vp.name}`);
    await expect(page.getByTestId('messages-unread')).toHaveCount(0, { timeout: 10_000 });
    await page.screenshot({ path: `${SHOTS}/${vp.name}-read.png` });

    // 账号菜单里的「消息」还在
    await page.goto(`/#/p/${w.project}`);
    await expect(page.getByTestId('messages-unread')).toHaveCount(0);
    await page.getByRole('button', { name: '账号' }).click();
    await expect(page.getByTestId('menu-messages')).toBeVisible();
    const read = (await (await page.request.get('/api/groups/unread')).json()) as { total: number; groups: { groupId: string }[] };
    expect(read.groups.find((x) => x.groupId === group)).toBeUndefined();
  });
}
