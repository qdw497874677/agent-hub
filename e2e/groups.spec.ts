import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';

/** 群聊（ADR 0018 · 群组）：建群、没主持人时的系统行、@ 直达成员、停止暂停全员、限额校验、手机布局。 */
async function world(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  let agentId: string | undefined;
  for (let i = 0; i < 40 && !agentId; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((worker) => worker.state === 'online')?.agentIds[0];
    if (!agentId) await page.waitForTimeout(500);
  }
  const created = await page.request.post('/api/projects', { data: { name: `e2e 群聊 ${Date.now().toString(36)}`, rootPath: mkdtempSync(join(tmpdir(), 'e2e-grp-')) }, headers });
  expect(created.ok(), await created.text()).toBe(true);
  const project = ((await created.json()) as { id: string }).id;
  return { agentId, project, headers };
}

test('建群：限额越界 400；没主持人时贴系统行；停止后成员暂停', async ({ page, baseURL }) => {
  const w = await world(page, baseURL!);
  const roles = await page.request.put(`/api/projects/${w.project}/messaging`, {
    headers: w.headers,
    data: { roles: [{ name: 'writer', agentId: w.agentId ?? 'grok', model: '' }, { name: 'critic', agentId: w.agentId ?? 'grok', model: '' }], limits: {} }
  });
  expect(roles.ok(), await roles.text()).toBe(true);
  const tooMany = await page.request.post(`/api/projects/${w.project}/groups`, { headers: w.headers, data: { name: 'x', members: ['writer'], limits: { maxRounds: 6 } } });
  expect(tooMany.status()).toBe(400);
  const noModelHost = await page.request.post(`/api/projects/${w.project}/groups`, { headers: w.headers, data: { name: 'x', members: ['writer'], hostRole: 'writer' } });
  expect(noModelHost.status()).toBe(400);

  // 界面建群（390px）
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/messages/${w.project}`);
  await page.getByTestId('group-new').click();
  await page.getByTestId('group-name').fill('写作组');
  await page.getByTestId('group-member').nth(0).check();
  await page.getByTestId('group-member').nth(1).check();
  await page.getByTestId('group-save').click();
  await expect(page.getByTestId('chat-title')).toHaveText('写作组');
  await expect(page.getByTestId('group-list')).toBeHidden();

  await page.getByTestId('group-input').fill('大家好');
  await page.getByTestId('group-send').click();
  await expect(page.getByTestId('system-line').filter({ hasText: '没有设置主持人' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.getByTestId('group-stop').click();
  await page.getByTestId('open-members').click();
  await expect(page.getByTestId('group-drawer').getByTestId('member-held')).toHaveCount(2);
  await page.screenshot({ path: 'test-results/groups-mobile.png' });
});

test('@ 成员直达：成员在群里回话，调用链能链到会话', async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const w = await world(page, baseURL!);
  test.skip(!w.agentId, '这台机器上没有可用的 agent');
  await page.request.put(`/api/projects/${w.project}/messaging`, { headers: w.headers, data: { roles: [{ name: 'echo', agentId: w.agentId, model: '' }], limits: {} } });
  const g = await page.request.post(`/api/projects/${w.project}/groups`, { headers: w.headers, data: { name: '回声', members: ['echo'] } });
  expect(g.ok(), await g.text()).toBe(true);
  const group = (await g.json()) as { id: string };
  await page.goto(`/#/messages/${w.project}/${group.id}`);
  await page.getByTestId('group-input').fill('@echo 只回复一个词：pong');
  await page.getByTestId('group-send').click();
  await expect(page.locator('[data-testid="group-post"][data-author="agent"]').first()).toBeVisible({ timeout: 200_000 });
  const chains = (await (await page.request.get(`/api/groups/${group.id}/chains`)).json()) as { chains: { deliveries: { role: string; sessionId: string | null }[] }[] };
  expect(chains.chains[0]?.deliveries.some((d) => d.role === 'echo' && d.sessionId)).toBe(true);
});
