import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page, type Route } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * 谁说的话、谁做的事：prompt 记下发送人；同一条会话里只有一个人说过话时不标，
 * 有第二个人时对话页和画布卡片的用户气泡旁都显示头像 + 名字；会话详情里列出「谁开了会话 / 停下」。
 * 测试环境只有一个账号：在事件和画布响应里塞一条别人（已删除的用户）的话，造出「两个人」。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'];
const OTHER = { id: 'ghost-user-e2e', name: '已删除的用户' };

async function setup(page: Page, baseURL: string) {
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
  const dir = mkdtempSync(join(tmpdir(), 'e2e-author-'));
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 作者 ${Date.now().toString(36)}`, rootPath: dir }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '谁说的' }, headers })).json()) as { id: string };
  const session = (await (await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers })).json()) as { id: string };
  expect((await page.request.post(`/api/sessions/${session.id}/prompt`, { data: { text: '我是本人' }, headers })).status()).toBe(200);
  await page.request.post(`/api/sessions/${session.id}/interrupt`, { headers });
  return { project: project.id, session: session.id };
}

/** 在响应里第一条 prompt 后面插一条别人说的话。 */
type Entry = { seq: number; at: number; event: { kind: string; text?: string; author?: { id: string; name: string } } };
function withOther(entries: Entry[]): Entry[] {
  const first = entries.find((entry) => entry.event.kind === 'prompt');
  if (!first) return entries;
  const fake: Entry = { seq: first.seq + 0.5, at: first.at, event: { kind: 'prompt', text: '我是另一个人', author: OTHER } };
  const index = entries.indexOf(first) + 1;
  return [...entries.slice(0, index), fake, ...entries.slice(index)];
}

async function fakeSecondAuthor(page: Page, project: string, session: string) {
  await page.route(`**/api/sessions/${session}/events*`, async (route: Route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: withOther((await response.json()) as Entry[]) });
  });
  await page.route(`**/api/projects/${project}/canvas`, async (route: Route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { previews: Record<string, Entry[]> };
    body.previews[session] = withOther(body.previews[session] ?? []);
    await route.fulfill({ response, json: body });
  });
}

for (const width of [1280, 390]) {
  test(`${width}px：一个人说话不标作者；两个人时对话页和卡片都标；详情里有谁开的会话`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 844 });
    const { project, session } = await setup(page, baseURL!);

    await page.goto(`/#/p/${project}/focus/${session}`);
    await expect(page.getByTestId('msg-user').first()).toContainText('我是本人');
    await expect(page.getByTestId('msg-author'), '只有一个人说过话：不标').toHaveCount(0);

    await page.getByRole('button', { name: '详情' }).click();
    const sheet = page.getByRole('complementary', { name: '会话详情' });
    const rows = sheet.getByTestId('activity-row');
    await expect(rows.filter({ hasText: '开了会话' })).toHaveCount(1);
    await expect(rows.filter({ hasText: '停下' })).toHaveCount(1);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/author-details-${width}.png` });
    await sheet.getByRole('button', { name: '关闭' }).click();

    await fakeSecondAuthor(page, project, session);
    await page.reload();
    const users = page.getByTestId('msg-user');
    await expect(users.filter({ hasText: '我是另一个人' }).getByTestId('msg-author')).toContainText(OTHER.name);
    await expect(users.filter({ hasText: '我是本人' }).getByTestId('msg-author')).toHaveCount(1);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/author-focus-${width}.png` });

    await page.goto(`/#/p/${project}/canvas`);
    const card = page.locator(`.react-flow__node[data-id="${session}"]`);
    await expect(card.getByTestId('card-msg-user').filter({ hasText: '我是另一个人' }).getByTestId('msg-author')).toContainText(OTHER.name);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/author-canvas-${width}.png` });

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
