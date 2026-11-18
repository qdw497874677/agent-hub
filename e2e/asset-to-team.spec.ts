import { test, expect, type BrowserContext } from '@playwright/test';
import { loginByApi, mailedLink } from './login.ts';
import { currentRun } from './run-id.ts';

/**
 * 个人资产「上架到团队」：作者点按钮 → 待审 → 团队负责人通过 → 变成团队资产（同一个资产，版本不变）；
 * 团队里已有同名 → 409，文案说清楚。
 */
const SHOTS = '/tmp/opencode/shots/asset-to-team';
const PASSWORD = 'to team pw 12345';
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, '-');
const skill = (name: string, body: string) => Buffer.from(`---\nname: ${name}\ndescription: 上架到团队 e2e ${name}\n---\n\n${body}\n`);
const b64 = (s: Buffer) => s.toString('base64');
const csrfOf = async (context: BrowserContext) => (await context.cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';

test('个人资产上架到团队：待审 → 负责人通过 → 团队资产；团队重名 409', async ({ page, browser }) => {
  const name = slug(`tt-${currentRun()}`);
  await loginByApi(page);
  const email = `tt-${currentRun()}@example.com`;
  const invited = await page.request.post('/api/team/invites', { headers: { 'x-hub-csrf': await csrfOf(page.context()) }, data: { email, role: 'member' } });
  expect(invited.status()).toBe(201);
  const token = new URL((await mailedLink(email, 'invite')).replace('#/invite?', '?')).searchParams.get('token');
  const context = await browser.newContext();
  try {
    expect((await context.request.post('/api/auth/invite/accept', { data: { token, password: PASSWORD, displayName: 'tt' } })).ok()).toBe(true);
    const member = await context.newPage();
    const headers = { 'x-hub-csrf': await csrfOf(context) };
    const made = await context.request.post('/api/assets/upload', { headers, data: { kind: 'skill', scope: 'personal', files: [{ path: 'SKILL.md', data: b64(skill(name, 'v1')) }] } });
    expect(made.status()).toBe(201);
    const { assetId } = (await made.json()) as { assetId: string };
    const pinned = ((await (await context.request.get(`/api/assets/items/${assetId}`)).json()) as { item: { asset: { pinned: string } } }).item.asset.pinned;

    await member.goto('/#/assets/mine');
    const card = member.getByTestId('market-asset').filter({ hasText: name });
    await expect(card).toContainText('个人');
    await card.getByRole('button', { name: '上架到团队' }).click();
    await expect(card).toContainText('已提交团队审核');
    await member.reload();
    await expect(card).toContainText('上架到团队：待审核');
    await expect(card).toContainText('申请上架到团队');
    await expect(card.getByRole('button', { name: '上架到团队' })).toHaveCount(0);
    await member.screenshot({ path: `${SHOTS}/pending.png`, fullPage: true });

    // 团队负责人：待审里有它，通过
    await page.goto('/#/assets/pending');
    await page.getByTestId('review-item').filter({ hasText: name }).click();
    await expect(page.getByTestId('review-page')).toContainText('申请上架到团队');
    await page.getByTestId('review-approve').click();
    await expect(page.getByTestId('review-status')).toHaveText('已通过');

    const after = ((await (await context.request.get(`/api/assets/items/${assetId}`)).json()) as { item: { asset: { scope: string; pinned: string } } }).item.asset;
    expect(after.scope).toBe('team');
    expect(after.pinned).toBe(pinned);
    await member.goto('/#/assets/mine');
    await expect(card).toContainText('团队');
    await expect(card.getByRole('button', { name: '上架到团队' })).toHaveCount(0);
    await member.screenshot({ path: `${SHOTS}/moved.png`, fullPage: true });

    // 同名的另一个个人资产：团队里已经有了 → 409
    const dup = await page.request.post('/api/assets/upload', { headers: { 'x-hub-csrf': await csrfOf(page.context()) }, data: { kind: 'skill', scope: 'personal', files: [{ path: 'SKILL.md', data: b64(skill(name, 'dup')) }] } });
    expect(dup.status()).toBe(201);
    const dupId = ((await dup.json()) as { assetId: string }).assetId;
    const clash = await page.request.post(`/api/assets/items/${dupId}/to-team`, { headers: { 'x-hub-csrf': await csrfOf(page.context()) }, data: {} });
    expect(clash.status()).toBe(409);
    expect(JSON.stringify(await clash.json())).toContain('团队里已经有叫');
    // 别人的个人资产：看不见 → 404
    const foreign = await context.request.post(`/api/assets/items/${dupId}/to-team`, { headers, data: {} });
    expect(foreign.status()).toBe(404);

    const audit = (await (await page.request.get('/api/admin/audit')).json()) as { action: string; detail: string }[];
    expect(audit.some((e) => e.action === 'asset.submit' && e.detail.includes('申请上架到团队'))).toBe(true);
    expect(audit.some((e) => e.action === 'asset.publish' && e.detail.includes('个人资产已上架到团队'))).toBe(true);
  } finally {
    await context.close();
  }
});
