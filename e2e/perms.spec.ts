import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { TEST_EMAIL, loginByApi, mailedLink, openRegistration, verifyByApi } from './login.ts';
import { currentRun } from './run-id.ts';

/** ADR 0017 权限模型：角色、自定义角色、viewer 只读、admin 边界、4A 会话说话、5A 临时进入。全部 390px 手机宽度。 */
const SHOTS = '/workspace/shots/perms';
const PASSWORD = 'perms e2e pw 123';
test.use({ viewport: { width: 390, height: 844 } });

const csrfOf = async (context: BrowserContext): Promise<string> => (await context.cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
async function headers(context: BrowserContext, baseURL?: string) {
  return { 'x-hub-csrf': await csrfOf(context), ...(baseURL ? { origin: baseURL } : {}) };
}

/** 测试账号（集群管理员 + 团队主人）邀请一个指定角色的人，返回 TA 已登录的上下文。 */
async function invite(owner: Page, browser: Browser, tag: string, role: string): Promise<{ email: string; id: string; context: BrowserContext; page: Page }> {
  const email = `${tag}-${currentRun()}@example.com`;
  const sent = await owner.request.post('/api/team/invites', { headers: await headers(owner.context()), data: { email, role } });
  expect(sent.status(), await sent.text()).toBe(201);
  const token = new URL((await mailedLink(email, 'invite')).replace('#/invite?', '?')).searchParams.get('token');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  expect((await context.request.post('/api/auth/invite/accept', { data: { token, password: PASSWORD, displayName: tag } })).ok()).toBe(true);
  const team = (await (await owner.request.get('/api/team')).json()) as { members: { id: string; email: string }[] };
  const id = team.members.find((m) => m.email === email)!.id;
  return { email, id, context, page: await context.newPage() };
}

async function openTeam(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '账号' }).click();
  await page.getByRole('button', { name: '我的团队' }).click();
}

test('自定义角色：主人在矩阵里看内置角色、新建「评审员」、分给成员；成员按新角色生效', async ({ page, browser }) => {
  await loginByApi(page);
  const member = await invite(page, browser, 'reviewer', 'member');
  await openTeam(page);
  await page.getByTestId('team-roles').getByText('角色与权限', { exact: true }).click();
  await expect(page.getByTestId('role-matrix')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/role-matrix.png`, fullPage: true });

  const name = `评审员${currentRun().slice(-4)}`;
  await page.getByTestId('new-role').click();
  const editor = page.getByTestId('role-editor');
  await editor.getByLabel('角色名').fill(name);
  for (const perm of ['project.read', 'task.read', 'session.read']) await editor.locator(`[data-perm="${perm}"][data-option="team"]`).click();
  await page.screenshot({ path: `${SHOTS}/role-editor.png`, fullPage: true });
  await editor.getByRole('button', { name: '保存角色' }).click();
  const custom = page.getByTestId('custom-role').filter({ hasText: name });
  await expect(custom).toBeVisible();

  const roles = (await (await page.request.get('/api/team/roles')).json()) as { key: string; name: string }[];
  const key = roles.find((r) => r.name === name)!.key;
  const select = page.getByTestId('team-member').filter({ hasText: member.email }).getByTestId('member-role');
  await select.selectOption(key);
  await expect(page.getByTestId('team-member').filter({ hasText: member.email })).toContainText(name);
  await page.screenshot({ path: `${SHOTS}/member-custom-role.png`, fullPage: true });

  // 角色变更进审计；成员能看项目，不能建项目
  const audit = (await (await page.request.get('/api/team/audit')).json()) as { action: string; target: string }[];
  expect(audit.some((a) => a.action === 'role.create')).toBe(true);
  expect((await member.page.request.get('/api/projects')).status()).toBe(200);
  const create = await member.page.request.post('/api/projects', { headers: await headers(member.context), data: { name: 'nope' } });
  expect(create.status()).toBe(403);

  // 再改回普通成员：内置角色切换
  await select.selectOption('member');
  await expect(page.getByTestId('team-member').filter({ hasText: member.email })).toContainText('成员');
  await member.context.close();
});

test('viewer 只读：能看项目和团队，不能建 / 改 / 删，也看不到管理入口', async ({ page, browser }) => {
  await loginByApi(page);
  const viewer = await invite(page, browser, 'viewer', 'viewer');
  const h = await headers(viewer.context);
  expect((await viewer.page.request.get('/api/projects')).status()).toBe(200);
  expect((await viewer.page.request.get('/api/team')).status()).toBe(200);
  expect((await viewer.page.request.post('/api/projects', { headers: h, data: { name: 'x' } })).status()).toBe(403);
  expect((await viewer.page.request.post('/api/team/invites', { headers: h, data: { email: `x-${currentRun()}@example.com`, role: 'member' } })).status()).toBe(403);
  expect((await viewer.page.request.get('/api/admin/settings')).status()).toBe(403);
  expect((await viewer.page.request.get('/api/fs/directories?path=/')).status()).toBe(403);
  await viewer.page.goto('/');
  await viewer.page.getByRole('button', { name: '账号' }).click();
  await expect(viewer.page.getByText('只读', { exact: true }).first()).toBeVisible();
  await viewer.page.screenshot({ path: `${SHOTS}/viewer-menu.png`, fullPage: true });
  await viewer.page.getByRole('button', { name: '我的团队' }).click();
  await expect(viewer.page.getByTestId('member-role')).toHaveCount(0);
  await viewer.page.screenshot({ path: `${SHOTS}/viewer-team.png`, fullPage: true });
  await viewer.context.close();
});

test('admin 边界：能管成员，不能升人为 owner / admin、不能定义角色、碰不到 hub 设置和本机', async ({ page, browser }) => {
  await loginByApi(page);
  const admin = await invite(page, browser, 'admin', 'admin');
  const member = await invite(page, browser, 'plain', 'member');
  const h = await headers(admin.context);
  const role = (id: string, value: string) => admin.page.request.put(`/api/team/members/${id}/role`, { headers: h, data: { role: value } });
  expect((await role(member.id, 'viewer')).status()).toBe(200);
  expect((await role(member.id, 'admin')).status()).toBe(403);
  expect((await role(member.id, 'owner')).status()).toBe(403);
  expect((await admin.page.request.post('/api/team/roles', { headers: h, data: { name: 'x', permissions: {} } })).status()).toBe(403);
  expect((await admin.page.request.get('/api/admin/settings')).status()).toBe(403);
  expect((await admin.page.request.get('/api/fs/directories?path=/')).status()).toBe(403);
  await openTeam(admin.page);
  const row = admin.page.getByTestId('team-member').filter({ hasText: member.email });
  const options = await row.getByTestId('member-role').locator('option').allTextContents();
  expect(options.join(',')).not.toMatch(/管理员|主人/);
  await admin.page.screenshot({ path: `${SHOTS}/admin-team.png`, fullPage: true });
  await admin.context.close();
  await member.context.close();
});

test('4A + 1A：同团队成员不能在别人的会话里说话 / 打断（会话在本机 Worker 上时连看都看不到）', async ({ page, browser, baseURL }) => {
  await loginByApi(page);
  const h = await headers(page.context(), baseURL);
  let agentId: string | undefined;
  for (let i = 0; i < 40 && !agentId; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((w) => w.state === 'online')?.agentIds[0];
    if (!agentId) await page.waitForTimeout(500);
  }
  test.skip(!agentId, '这台机器上没有可用的 agent');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-perms-'));
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 权限 ${currentRun()}`, rootPath: dir }, headers: h })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '共享项目' }, headers: h })).json()) as { id: string };
  const session = (await (await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers: h })).json()) as { id: string };
  expect((await page.request.post(`/api/sessions/${session.id}/prompt`, { data: { text: '我是创建者' }, headers: h })).status()).toBe(200);

  const member = await invite(page, browser, 'peer', 'member');
  const mh = await headers(member.context, baseURL);
  // e2e 只有 hub 自带的本机 Worker：落在本机上的会话对非集群管理员整体不可见（404，不泄露存在），说话 / 打断同样拒绝。
  // 远端 Worker 上「能看不能说」的 4A 细节由 apps/server/src/session-activity.test.ts 覆盖。
  expect((await member.page.request.get(`/api/sessions/${session.id}/events`)).status()).toBe(404);
  const prompt = await member.page.request.post(`/api/sessions/${session.id}/prompt`, { data: { text: '插一句' }, headers: mh });
  expect([403, 404]).toContain(prompt.status());
  expect([403, 404]).toContain((await member.page.request.post(`/api/sessions/${session.id}/interrupt`, { headers: mh })).status());
  const events = (await (await page.request.get(`/api/sessions/${session.id}/events`)).json()) as { event: { kind: string; text?: string } }[];
  expect(events.some((e) => e.event.kind === 'prompt' && e.event.text === '插一句')).toBe(false);
  await member.page.goto(`/#/projects/${project.id}`);
  await member.page.waitForTimeout(800);
  await member.page.screenshot({ path: `${SHOTS}/peer-session-readonly.png` });
  await page.request.post(`/api/sessions/${session.id}/interrupt`, { headers: h });
  await member.context.close();
});

test('5A：集群管理员临时进入别的团队：写原因、只读、两边审计、可结束', async ({ page, browser, baseURL }) => {
  await openRegistration(baseURL);
  const email = `otherteam-${currentRun()}@example.com`;
  const outsider = await browser.newContext();
  expect((await outsider.request.post('/api/auth/register', { data: { email, password: PASSWORD } })).ok()).toBe(true);
  await verifyByApi(outsider.request, email);
  expect((await outsider.request.post('/api/auth/login', { data: { email, password: PASSWORD } })).ok()).toBe(true);
  const oh = await headers(outsider);
  const created = await outsider.request.post('/api/projects', { headers: oh, data: { name: '别人的项目' } });
  expect(created.status()).toBe(201);
  const theirs = (await created.json()) as { id: string };

  await loginByApi(page);
  expect((await page.request.get(`/api/projects/${theirs.id}/canvas`)).status()).not.toBe(200);
  const team = (await (await outsider.request.get("/api/team")).json()) as { id: string; name: string };
  await page.goto('/#/admin/users');
  const panel = page.getByTestId('visit-panel');
  await panel.getByLabel('要进入的团队').selectOption(team.id);
  await panel.getByLabel('原因').fill('e2e 排查权限');
  await page.screenshot({ path: `${SHOTS}/visit-form.png`, fullPage: true });
  await panel.getByRole('button', { name: '进入' }).click();
  await expect(panel.getByTestId('active-visit')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/visit-active.png`, fullPage: true });

  expect((await page.request.get(`/api/projects/${theirs.id}/canvas`)).status()).toBe(200);
  const h = await headers(page.context());
  expect((await page.request.post('/api/tasks', { headers: h, data: { projectId: theirs.id, title: '不该能写' } })).status()).toBe(403);
  const hubAudit = (await (await page.request.get('/api/admin/audit?action=team.visit')).json()) as { target: string; actorEmail?: string }[];
  expect(hubAudit.some((a) => a.target === team.id)).toBe(true);
  const theirAudit = (await (await outsider.request.get('/api/team/audit')).json()) as { action: string }[];
  expect(theirAudit.some((a) => a.action === 'team.visit')).toBe(true);

  await panel.getByRole('button', { name: '结束' }).click();
  await expect(panel.getByTestId('active-visit')).toHaveCount(0);
  expect((await page.request.get(`/api/projects/${theirs.id}/canvas`)).status()).not.toBe(200);
  expect(TEST_EMAIL).toBeTruthy();
  await outsider.close();
});
