import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';

test.afterAll(stopFakeWorker);
const pasted = '<agent-message id="pasted-id" kind="ask">\n原样粘贴\n</agent-message>';
const messageSource = { kind: 'agent_message', messageId: 'private-message-id', messageKind: 'ask', initiator: 'account', sender: 'session' };

for (const width of [1280, 390]) {
  test(`${width}px 可信来源、普通粘贴和不可读来源`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 844 });
    await loginByApi(page);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
    const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
    const workerId = await ensureFakeWorker(page, baseURL!);
    const rootPath = mkdtempSync(join(tmpdir(), 'e2e-provenance-'));
    const project = await (await page.request.post('/api/projects', { data: { name: `来源 ${Date.now()}`, rootPath, workerId }, headers })).json() as { id: string };
    const task = await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '来源测试' }, headers })).json() as { id: string };
    const sessionResponse = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: FAKE_AGENT_ID, workerId, model: '' }, headers });
    expect(sessionResponse.status()).toBe(201);
    const session = await sessionResponse.json() as { id: string };
    const entries = [
      { seq: 1, at: Date.now(), event: { kind: 'prompt', text: pasted } },
      { seq: 2, at: Date.now(), event: { kind: 'prompt', text: '可信正文', messageSource } },
      { seq: 3, at: Date.now(), event: { kind: 'prompt', text: '<agent-message damaged', author: { id: 'old', name: 'old', via: 'agent' } } }
    ];
    await page.route(`**/api/sessions/${session.id}/events*`, (route) => route.fulfill({ json: entries }));
    await page.route(`**/api/projects/${project.id}/canvas`, async (route) => {
      const response = await route.fetch();
      const body = await response.json() as { previews: Record<string, unknown[]> };
      body.previews[session.id] = entries;
      await route.fulfill({ response, json: body });
    });
    await page.route(`**/api/sessions/${session.id}/messages/private-message-id/source`, (route) => route.fulfill({ status: 404, json: {} }));
    await page.goto(`/#/p/${project.id}/focus/${session.id}`);
    const trusted = page.getByTestId('agent-message-card').filter({ hasText: '可信正文' });
    await expect(trusted).toContainText('协作消息 · 提问');
    await expect(trusted).toContainText('来源会话不可用');
    await expect(trusted.getByRole('link', { name: '查看来源会话' })).toHaveCount(0);
    await expect(page.getByTestId('msg-user').filter({ hasText: '原样粘贴' })).toContainText(pasted);
    await expect(page.getByTestId('agent-message-card').filter({ hasText: '正文无法解析' })).not.toContainText('<agent-message');
    await expect(page.locator('body')).not.toContainText('private-message-id');
    if (width === 1280) {
      await page.goto(`/#/p/${project.id}/canvas`);
      const card = page.locator(`.react-flow__node[data-id="${session.id}"]`);
      await expect(card.getByTestId('agent-message-card').filter({ hasText: '可信正文' })).toContainText('来源会话不可用');
      await expect(card.getByTestId('card-msg-user').filter({ hasText: '原样粘贴' })).toContainText(pasted);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
