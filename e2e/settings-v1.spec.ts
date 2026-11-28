import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { loginByApi, mailedLink } from './login.ts';
import { currentRun } from './run-id.ts';

test.afterAll(() => stopFakeWorker());

async function headersFor(page: Page, baseURL: string) {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  return { origin: baseURL, 'x-hub-csrf': csrf };
}

async function post<T>(page: Page, url: string, data: unknown, headers: Record<string, string>): Promise<T> {
  const response = await page.request.post(url, { data, headers });
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as T;
}

async function openSettings(page: Page) {
  const menu = page.getByTestId('global-menu-button');
  if (await menu.isVisible()) await menu.click();
  else await page.getByTestId('shell-more').click();
  await page.getByTestId('shell-panel-more').getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByTestId('settings-surface')).toBeVisible();
  await expect(page).toHaveURL(/#\/settings$/);
}

for (const width of [1280, 390]) {
  test(`设置入口和常用目录在 ${width}px 可见并到达正确页面`, async ({ page, baseURL }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await loginByApi(page);
    const headers = await headersFor(page, baseURL!);
    const project = await post<{ id: string }>(page, '/api/projects', { name: `设置目录 ${width} ${currentRun()}` }, headers);
    const teamResponse = await page.request.get('/api/team');
    expect(teamResponse.ok()).toBe(true);
    const team = await teamResponse.json() as { id: string };
    await page.goto(`/#/p/${project.id}`);
    const shellElement = await page.getByTestId('workbench-shell').elementHandle();
    await openSettings(page);
    const surface = page.getByTestId('settings-surface');
    await expect(surface).toBeVisible();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect.poll(() => shellElement!.evaluate((element) => ({
      mounted: element.isConnected,
      hidden: element.getClientRects().length === 0 || Boolean(element.closest('[inert], [aria-hidden="true"]'))
    }))).toEqual({ mounted: true, hidden: true });
    await expect(surface).toHaveAttribute('aria-modal', 'true');
    await page.screenshot({ path: testInfo.outputPath(`settings-directory-${width}.png`) });

    const links = [
      { label: '项目默认 Agent', hash: `#/settings/project/${project.id}/defaults`, panel: 'project-default-agent' },
      { label: '清理工作目录', hash: `#/settings/project/${project.id}/cleanup`, panel: 'workspace-cleanup' },
      { label: '团队默认模型', hash: `#/settings/team/${team.id}/default-models`, panel: 'agent-defaults' }
    ];
    for (const entry of links) {
      await surface.getByRole('link', { name: entry.label, exact: true }).click();
      await expect(page).toHaveURL(`${baseURL}/${entry.hash}`);
      await expect(surface.getByTestId(entry.panel)).toBeVisible();
      if (entry.label === '项目默认 Agent') {
        await expect(surface.getByRole('heading', { name: '项目默认 Agent', exact: true })).toBeVisible();
        await expect(surface).toHaveAccessibleName('项目默认 Agent');
      }
      await expect(page.getByTestId('settings-scroll')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (entry.label === '项目默认 Agent') {
        await surface.getByRole('link', { name: '查看团队默认模型', exact: true }).click();
        await expect(page).toHaveURL(`${baseURL}/#/settings/team/${team.id}/default-models`);
        await expect(surface.getByTestId('agent-defaults')).toBeVisible();
      }
      if (width === 390) await surface.getByRole('button', { name: '返回设置目录' }).click();
      else await page.goBack();
      await expect(page).toHaveURL(/#\/settings$/);
    }
    await surface.getByRole('link', { name: '会话显示', exact: true }).click();
    await expect(page).toHaveURL(`${baseURL}/#/settings/personal/display`);
    await surface.getByRole('button', { name: '返回应用' }).click();
    await expect(surface).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`#\/p/${project.id}`));
    await expect(page.getByTestId(width === 1280 ? 'shell-more' : 'global-menu-button')).toBeFocused();

    await page.goto('/');
    await openSettings(page);
    await expect(surface.getByRole('link', { name: '会话显示', exact: true })).toBeVisible();
    await surface.getByRole('button', { name: '返回应用' }).click();
    await expect(surface).toBeHidden();
  });
}

test('手机浏览器返回：会话草稿经设置目录和详情往返保留', async ({ page, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const root = mkdtempSync(join(tmpdir(), 'settings-history-'));
  try {
    await loginByApi(page);
    const workerId = await ensureFakeWorker(page, baseURL!, FAKE_AGENT_ID);
    const headers = await headersFor(page, baseURL!);
    const project = await post<{ id: string }>(page, '/api/projects', { name: `设置返回 ${currentRun()}`, rootPath: root, workerId }, headers);
    const task = await post<{ id: string }>(page, '/api/tasks', { projectId: project.id, title: '设置返回任务' }, headers);
    const session = await post<{ id: string }>(page, '/api/sessions/derive', { taskId: task.id, agentId: FAKE_AGENT_ID, model: '' }, headers);
    await page.goto(`/#/p/${project.id}/focus/${session.id}`);
    const composer = page.getByLabel('发送消息');
    await expect(composer).toBeVisible();
    await composer.fill('返回设置前的会话草稿');
    const sourceURL = page.url();
    await page.getByRole('button', { name: '更多' }).click();
    await page.getByTestId('session-more-details').click();
    await page.getByRole('menuitem', { name: /^显示设置/ }).click();
    const localDisplay = page.getByRole('dialog', { name: '显示设置' });
    const compact = localDisplay.getByRole('switch', { name: '紧凑' });
    const initialCompact = await compact.isChecked();
    if (initialCompact) await compact.uncheck();
    else await compact.check();
    await localDisplay.getByRole('button', { name: '关闭' }).click();
    await openSettings(page);
    const surface = page.getByTestId('settings-surface');
    await expect(surface).toBeVisible();
    await expect(page).toHaveURL(/#\/settings$/);
    await surface.getByRole('link', { name: '会话显示', exact: true }).click();
    await expect(surface.getByRole('switch', { name: '紧凑' })).toHaveJSProperty('checked', !initialCompact);
    if (initialCompact) await surface.getByRole('switch', { name: '紧凑' }).check();
    else await surface.getByRole('switch', { name: '紧凑' }).uncheck();
    await surface.getByRole('button', { name: '返回设置目录' }).click();
    await surface.getByRole('link', { name: '项目默认 Agent', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#\/settings/project/${project.id}/defaults$`));
    await page.screenshot({ path: testInfo.outputPath('settings-detail-mobile.png') });
    // 浏览器 history 返回模拟手机系统返回，并不声称覆盖真实硬件返回键。
    await page.goBack();
    await expect(page).toHaveURL(/#\/settings$/);
    await page.goBack();
    await expect(page).toHaveURL(sourceURL);
    await expect(composer).toHaveValue('返回设置前的会话草稿');
  } finally {
    stopFakeWorker();
    rmSync(root, { recursive: true, force: true });
  }
});

test('项目齿轮直达、草稿切换隔离以及无来源深链安全返回', async ({ page, baseURL }) => {
  await loginByApi(page);
  const headers = await headersFor(page, baseURL!);
  const a = await post<{ id: string }>(page, '/api/projects', { name: `设置草稿 A ${currentRun()}` }, headers);
  const b = await post<{ id: string }>(page, '/api/projects', { name: `设置草稿 B ${currentRun()}` }, headers);
  await page.goto(`/#/p/${a.id}`);
  await page.locator('button[title="项目设置"]:visible').first().click();
  await expect(page).toHaveURL(`${baseURL}/#/settings/project/${a.id}/general`);
  const surface = page.getByTestId('settings-surface');
  const description = surface.getByLabel('项目说明');
  await description.fill('只属于项目 A 的未保存草稿');
  await surface.getByRole('link', { name: '项目默认 Agent', exact: true }).click();
  await surface.getByRole('link', { name: '项目信息', exact: true }).click();
  await expect(description).toHaveValue('只属于项目 A 的未保存草稿');
  await surface.getByRole('button', { name: '返回应用' }).click();
  await expect(page).toHaveURL(new RegExp(`#\/p/${a.id}`));
  await page.goto(`/#/settings/project/${a.id}/general`);
  await surface.getByLabel('项目说明').fill('不应出现在项目 B 的草稿');
  await page.evaluate((id) => { location.hash = `#/settings/project/${id}/general`; }, b.id);
  await expect(page).toHaveURL(`${baseURL}/#/settings/project/${b.id}/general`);
  await expect(surface.getByLabel('项目说明')).not.toHaveValue('不应出现在项目 B 的草稿');
  // 新标签页没有来源，不能依赖本标签页之前的项目历史。
  const standalone = await page.context().newPage();
  try {
    await standalone.goto(`/#/settings/project/${b.id}/general`);
    const standaloneSurface = standalone.getByTestId('settings-surface');
    await expect(standaloneSurface.getByLabel('项目说明')).not.toHaveValue('只属于项目 A 的未保存草稿');
    await standaloneSurface.getByRole('button', { name: '返回应用' }).click();
    await expect(standaloneSurface).toBeHidden();
    await expect(standalone).not.toHaveURL(/#\/settings/);
  } finally {
    await standalone.close();
  }
});

test('真实受邀成员：团队默认模型只读，无 Hub 管理和项目资产入口', async ({ page, browser, baseURL }) => {
  await loginByApi(page);
  await ensureFakeWorker(page, baseURL!, FAKE_AGENT_ID);
  const headers = await headersFor(page, baseURL!);
  const project = await post<{ id: string }>(page, '/api/projects', { name: `成员设置 ${currentRun()}` }, headers);
  const teamResponse = await page.request.get('/api/team');
  expect(teamResponse.ok()).toBe(true);
  const team = await teamResponse.json() as { id: string };
  const email = `settings-member-${currentRun()}-${Date.now()}@example.com`;
  const invite = await page.request.post('/api/team/invites', { data: { email, role: 'member' }, headers });
  expect(invite.status(), await invite.text()).toBe(201);
  const token = new URL((await mailedLink(email, 'invite')).replace('#/invite?', '?')).searchParams.get('token');
  const guest = await browser.newContext({ baseURL });
  try {
    const accepted = await guest.request.post('/api/auth/invite/accept', { data: { token, password: 'settings member 12345' } });
    expect(accepted.ok(), await accepted.text()).toBe(true);
    const member = await guest.newPage();
    await member.goto('/');
    await openSettings(member);
    const surface = member.getByTestId('settings-surface');
    await expect(surface.getByRole('link', { name: /Hub 管理/ })).toHaveCount(0);
    await surface.getByRole('link', { name: '团队默认模型', exact: true }).click();
    await expect(member).toHaveURL(`${baseURL}/#/settings/team/${team.id}/default-models`);
    const defaults = surface.getByTestId('agent-defaults');
    await expect(defaults.getByTestId('agent-defaults-readonly')).toBeVisible();
    await expect(defaults.getByTestId('agent-defaults-save')).toHaveCount(0);
    await expect(defaults.getByTestId('agent-defaults-add')).toHaveCount(0);
    for (const input of await defaults.getByTestId('agent-defaults-input').all()) await expect(input).toBeDisabled();
    await member.goto(`/#/settings/project/${project.id}/general`);
    await expect(surface.getByRole('link', { name: '资产', exact: true })).toHaveCount(0);
  } finally {
    await guest.close();
    stopFakeWorker();
  }
});
