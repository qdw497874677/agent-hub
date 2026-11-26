import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, stopFakeWorker } from './fake-worker.ts';

test.afterAll(() => stopFakeWorker());

async function seed(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  const workerId = await ensureFakeWorker(page, baseURL);
  const project = (await (await page.request.post('/api/projects', { data: { name: `快捷打开-${Date.now()}`, rootPath: mkdtempSync(join(tmpdir(), 'quick-open-root-')), workerId }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '快捷任务' }, headers })).json()) as { id: string };
  const sessions: string[] = [];
  for (const title of ['第一条', '第二条', '第三条']) {
    const response = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: 'fakeacp', model: '' }, headers });
    expect(response.ok(), await response.text()).toBe(true);
    const session = (await response.json()) as { id: string };
    expect((await page.request.put(`/api/sessions/${session.id}/title`, { data: { title }, headers })).ok()).toBe(true);
    sessions.push(session.id);
  }
  return { project, task, sessions };
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`快捷打开：${viewport.width} 视口保留顺序并跳到原目标`, async ({ page, baseURL }) => {
    test.setTimeout(70_000);
    await page.setViewportSize(viewport);
    const { project, task, sessions } = await seed(page, baseURL!);
    const [first, second, third] = sessions as [string, string, string];
    let phase = 'needs_approval';
    let showAttention = true;
    let includeLate = false;
    let ackCount = 0;
    page.on('request', (request) => { if (request.method() !== 'GET' && request.url().includes('/api/attention/')) ackCount++; });
    const item = (sessionId: string, projectId = project.id) => ({ sessionId, taskId: task.id, taskTitle: '快捷任务', sessionTitle: sessionId === third ? '第三条' : '其他项目', projectId, projectName: '快捷项目', agentId: 'fakeacp', phase, since: 1, reason: '等待处理', possible: false, expiresAt: null });
    // 在首次进入页面前拦截：focus 页面也会订阅 attention，换 hash 不会清空 Query 缓存。
    await page.route('**/api/attention', (route) => route.fulfill({ json: { items: showAttention ? [item(third), item(first, 'other-project'), ...(includeLate ? [item(second)] : [])] : [], working: 0 } }));
    // 实际进入会话才产生最近记录，时间先后与创建顺序不同。
    for (const id of [second, first]) {
      await page.goto(`/#/p/${project.id}/focus/${id}`);
      await expect(page.getByLabel('发送消息')).toBeVisible();
    }
    // 验证真实浏览器请求命中 fixture，再以 focus 页新建查询缓存后切到列表。
    const attentionResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/attention' && response.request().method() === 'GET');
    await page.reload();
    const payload = await (await attentionResponse).json() as { items: Array<{ sessionId: string }> };
    expect(payload.items.map((entry) => entry.sessionId)).toContain(third);
    await page.goto(`/#/p/${project.id}/list`);
    await expect(page.getByTestId('list-view')).toBeVisible();
    if (viewport.width > 640) await page.keyboard.press('Control+k');
    else await page.getByRole('button', { name: '搜索', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: '命令面板' });
    const attention = dialog.getByTestId('palette-attention');
    const recent = dialog.getByTestId('palette-recent');
    await expect(attention.getByTestId('palette-quick-session')).toHaveCount(1);
    await expect(attention).toContainText('等审批');
    await expect(recent.getByTestId('palette-quick-session')).toHaveCount(2);
    await expect(recent.getByTestId('palette-quick-session')).toHaveText(['第一条快捷任务', '第二条快捷任务']);
    expect((await recent.getByTestId('palette-quick-session').first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // 轮询状态改变和其他标签页的最近顺序改变，都不重排面板。
    phase = 'needs_answer';
    includeLate = true;
    await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('agent-hub:palette-recent:')) localStorage.setItem(key, JSON.stringify([])); });
    await expect(attention).toContainText('等回答', { timeout: 20_000 });
    await expect(attention.getByTestId('palette-quick-session')).toHaveCount(1);
    await expect(recent.getByTestId('palette-quick-session')).toHaveText(['第一条快捷任务', '第二条快捷任务']);
    if (process.env['E2E_SCREENSHOTS']) await page.screenshot({ path: `${process.env['E2E_SCREENSHOTS']}/quick-open-${viewport.width}.png` });
    if (viewport.width > 640) {
      // 显式选中后行消失，Enter 不能误打开排在后面的最近会话。
      await attention.getByTestId('palette-quick-session').hover();
      showAttention = false;
      await expect(attention.getByTestId('palette-quick-session')).toHaveCount(0, { timeout: 20_000 });
      await page.getByLabel('搜索任务或会话').press('Enter');
      await expect(dialog).toBeVisible();
      await expect.poll(() => new URL(page.url()).hash).toContain('/list');
      showAttention = true;
      includeLate = false;
      phase = 'needs_approval';
      // 切到 focus 后重载并确认 fixture 已返回，避免下一次快照与请求竞赛。
      await page.goto(`/#/p/${project.id}/focus/${first}`);
      const restoredResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/attention' && response.request().method() === 'GET');
      await page.reload();
      expect(((await (await restoredResponse).json()) as { items: Array<{ sessionId: string }> }).items.map((entry) => entry.sessionId)).toContain(third);
      await page.goto(`/#/p/${project.id}/list`);
      await expect(page.getByTestId('list-view')).toBeVisible();
      await page.keyboard.press('Control+k');
      await expect(attention.getByTestId('palette-quick-session')).toHaveCount(1);
    }
    phase = 'needs_approval';
    await expect(attention).toContainText('等审批', { timeout: 20_000 });
    if (viewport.width > 640) await page.getByLabel('搜索任务或会话').press('Enter');
    else await attention.getByTestId('palette-quick-session').click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).hash).toContain(`/focus/${third}`);
    await expect(page.getByLabel('发送消息')).toBeVisible();
    await page.waitForTimeout(4_000);
    expect(ackCount).toBe(0);
    // 非空查询仍走原项目搜索。
    if (viewport.width > 640) await page.keyboard.press('Control+k');
    else {
      await page.getByTestId('session-more-trigger').click();
      await page.getByRole('menuitem', { name: '搜索任务与会话', exact: true }).click();
    }
    await page.getByLabel('搜索任务或会话').fill('快捷任务');
    await expect(dialog).toContainText('任务与会话');
    await expect(dialog).toContainText('快捷任务');
    if (viewport.width > 640) {
      await page.getByLabel('搜索任务或会话').press('Enter');
      await expect.poll(() => new URL(page.url()).hash).toBe(`#/p/${project.id}/canvas`);
    }
  });
}
