import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * 刷新之后画布卡片和画布窗口里是整段历史，不只是投影带的最后 24 条事件：
 * 最早的提问还在、能往上翻到，默认停在最后。
 * 不依赖真模型：会话目录建完就删掉，每问一句都会落「问话 + 失败原因」，攒出远超 24 条事件的多轮对话。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'];

const gap = (el: Locator) => el.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
const scrollable = (el: Locator) => el.evaluate((node) => node.scrollHeight > node.clientHeight + 10);

async function longSession(page: Page, baseURL: string) {
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
  const dir = mkdtempSync(join(tmpdir(), 'e2e-history-'));
  const name = `e2e 历史 ${Date.now().toString(36)}`;
  const project = (await (await page.request.post('/api/projects', { data: { name, rootPath: dir }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '长对话' }, headers })).json()) as { id: string };
  rmSync(dir, { recursive: true, force: true });
  const { id } = (await (await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers })).json()) as { id: string };
  const ended = async () => {
    const events = (await (await page.request.get(`/api/sessions/${id}/events`)).json()) as Array<{ kind?: string; event?: { kind?: string } }>;
    return events.filter((entry) => (entry.kind ?? entry.event?.kind) === 'ended').length;
  };
  // 一句一句来：等上一句的失败落地再问下一句，免得连发被合并或丢掉
  const say = async (n: number) => {
    const before = await ended();
    await page.request.post(`/api/sessions/${id}/prompt`, { data: { text: `第 ${n} 句：${'很长的一段话，'.repeat(12)}`, attachments: [] }, headers });
    await expect.poll(ended, { message: `第 ${n} 句的失败落地`, timeout: 15_000 }).toBeGreaterThan(before);
  };
  for (let n = 1; n <= 16; n++) await say(n);
  return { project, say };
}


test('刷新后画布卡片和展开窗口都有完整历史（最早的提问也在）', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  const { project } = await longSession(page, baseURL!);
  await page.goto(`/#/p/${project.id}/canvas`);
  await page.reload();
  const card = page.locator('.react-flow__node-session').first();
  const log = card.getByTestId('session-card-log');
  await expect(card.getByText('第 1 句：').first()).toBeAttached({ timeout: 10_000 });
  await expect(card.getByText('第 16 句：').first()).toBeAttached({ timeout: 10_000 });
  await expect.poll(() => gap(log)).toBeLessThan(4);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'card-full-history.png') });
  await card.locator('header').dblclick({ position: { x: 60, y: 8 } });
  const win = page.getByTestId('canvas-window').first();
  await expect(win).toBeVisible();
  await expect(win.getByText('第 1 句：').first()).toBeAttached({ timeout: 10_000 });
  await expect(win.getByText('第 16 句：').first()).toBeAttached({ timeout: 10_000 });
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'window-full-history.png') });
});
