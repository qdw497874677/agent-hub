import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';

/** Bot（持久智能体）页 + 建群只选成员 + 成员增删；390 / 1280 两种宽度都走一遍并截图。 */
const SHOTS = process.env['BOTS_SHOTS_DIR'] ?? 'test-results/bots';
mkdirSync(SHOTS, { recursive: true });

async function world(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  const created = await page.request.post('/api/projects', { data: { name: `e2e bot ${Date.now().toString(36)}`, rootPath: mkdtempSync(join(tmpdir(), 'e2e-bot-')) }, headers });
  expect(created.ok(), await created.text()).toBe(true);
  return { project: ((await created.json()) as { id: string }).id, headers };
}

for (const width of [390, 1280]) {
  test(`bot：空状态 → 新建 bot → 建群只勾成员 → 加 / 移成员 → 删 bot 先列出群（${width}px）`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    const w = await world(page, baseURL!);
    const shot = (name: string) => page.screenshot({ path: `${SHOTS}/${width}-${name}.png`, fullPage: true });

    // 空状态：没 bot 也没群
    await page.goto(`/#/messages/${w.project}`);
    await expect(page.getByTestId('messages-empty')).toBeVisible();
    await shot('01-empty');
    await page.getByTestId('empty-new-bot').click();
    await expect(page.getByTestId('bot-form')).toBeVisible();

    // 新建两个 bot（界面），再用 API 加一个
    await page.getByTestId('bot-display-name').fill('写手');
    await page.getByTestId('bot-name').fill('writer');
    await page.locator('[data-testid="bot-color"][data-color="sage"]').click();
    await page.locator('[data-testid="bot-runtime"][data-runtime="grok"]').click();
    await page.getByTestId('bot-model').fill('m-writer');
    await page.getByTestId('bot-description').fill('你负责写初稿。');
    await expect(page.getByTestId('bot-description-count')).toHaveText('7 / 4000');
    await shot('02-bot-new');
    await page.getByTestId('bot-save').click();
    await expect(page.locator('[data-testid="bot-item"][data-name="writer"]')).toBeVisible();
    for (const [name, displayName, color] of [['critic', '挑刺', 'rose'], ['editor', '编辑', 'sky']]) {
      const r = await page.request.post(`/api/projects/${w.project}/agents`, { headers: w.headers, data: { name, displayName, color, agentId: 'pi', description: '' } });
      expect(r.ok(), await r.text()).toBe(true);
    }
    // @id 重复 / 职责过长 会被拒
    expect((await page.request.post(`/api/projects/${w.project}/agents`, { headers: w.headers, data: { name: 'writer', agentId: 'pi' } })).status()).toBe(400);
    expect((await page.request.post(`/api/projects/${w.project}/agents`, { headers: w.headers, data: { name: 'long', agentId: 'pi', description: 'x'.repeat(4001) } })).status()).toBe(400);
    await page.reload();
    await expect(page.getByTestId('bot-item')).toHaveCount(3);
    await shot('03-bots');

    // 编辑：@id 不能改
    await page.locator('[data-testid="bot-item"][data-name="critic"]').getByTestId('bot-edit').click();
    await expect(page.getByTestId('bot-name')).toBeDisabled();
    await page.getByTestId('bot-display-name').fill('挑刺的');
    await page.getByTestId('bot-save').click();
    await expect(page.locator('[data-testid="bot-item"][data-name="critic"]')).toContainText('挑刺的');

    // 建群：只勾成员，高级设置收起
    await page.getByTestId('tab-messages').click();
    await page.getByTestId('group-new').click();
    await page.getByTestId('group-name').fill('写作组');
    await expect(page.getByTestId('group-advanced-panel')).toHaveCount(0);
    await page.getByTestId('group-member').nth(0).check();
    await page.getByTestId('group-member').nth(1).check();
    await expect(page.getByTestId('group-chip')).toHaveCount(2);
    await shot('04-group-new');
    await page.getByTestId('group-advanced').click();
    await expect(page.getByTestId('group-host')).toBeVisible();
    await shot('05-group-new-advanced');
    await page.getByTestId('group-save').click();
    await expect(page.getByTestId('chat-title')).toHaveText('写作组');

    // 成员：添加 editor，再移出 critic
    if (width === 390) await page.getByTestId('open-members').click();
    const panel = width === 390 ? page.getByTestId('group-drawer') : page.locator('aside').last();
    await panel.getByTestId('member-add').click();
    await panel.getByTestId('member-add-option').first().check();
    await shot('06-members-add');
    await panel.getByTestId('member-add-confirm').click();
    await expect(panel.getByTestId('group-member-row')).toHaveCount(3);
    page.once('dialog', (d) => void d.accept());
    await panel.locator('[data-testid="member-remove"][data-role="critic"]').click();
    await expect(panel.getByTestId('group-member-row')).toHaveCount(2);
    await shot('07-members');
    if (width === 390) await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

    // 删除 bot：确认框列出所在的群，删完自动出群
    await page.goto(`/#/bots/${w.project}`);
    await page.locator('[data-testid="bot-item"][data-name="writer"]').getByTestId('bot-delete').click();
    await expect(page.getByTestId('bot-delete-groups')).toContainText('写作组');
    await shot('08-bot-delete');
    await page.getByTestId('bot-delete-confirm').click();
    await expect(page.locator('[data-testid="bot-item"][data-name="writer"]')).toHaveCount(0);
    const groups = (await (await page.request.get(`/api/projects/${w.project}/groups`)).json()) as { groups: { members: string[] }[] };
    expect(groups.groups[0]?.members).toEqual(['editor']);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}
