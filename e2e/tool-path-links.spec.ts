import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * 对话里工具调用参数的文件路径可点：点了切到会话「文件」页并打开那个文件，知道行号就滚到那一行。
 * 只认工具参数（不扫正文）；工作空间外的路径不可点。390 手机 + 1280 桌面各走一遍。
 * 真 worker（假 agent）不会调工具：跑一轮真的，再往历史接口里插几条 tool_call。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'] ?? '/workspace/shots/tool-path-links';

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
  const root = mkdtempSync(join(tmpdir(), 'e2e-toolpath-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/app.ts'), Array.from({ length: 120 }, (_, i) => `export const v${i + 1} = ${i + 1};`).join('\n') + '\n');
  writeFileSync(join(root, 'README.md'), '# 说明\n');
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 工具路径 ${Date.now().toString(36)}`, rootPath: root }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '工具路径' }, headers })).json()) as { id: string };
  const { id } = (await (await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers })).json()) as { id: string };
  await page.request.post(`/api/sessions/${id}/prompt`, { data: { text: '你好 src/app.ts', attachments: [] }, headers });
  await expect
    .poll(async () => ((await (await page.request.get(`/api/sessions/${id}/events`)).json()) as unknown[]).length > 0, { timeout: 30_000 })
    .toBe(true);
  const calls = [
    { name: 'read', input: JSON.stringify({ path: 'src/app.ts', offset: 80, limit: 10 }) },
    { name: 'read', input: JSON.stringify({ file_path: join(root, 'README.md') }) },
    { name: 'read', input: JSON.stringify({ path: '/etc/hosts' }) },
    { name: 'read', input: JSON.stringify({ path: '../outside.txt' }) }
  ];
  await page.route(`**/api/sessions/${id}/events**`, async (route) => {
    const response = await route.fetch();
    const entries = (await response.json()) as Array<{ seq: number; at?: number; event?: Record<string, unknown> }>;
    const last = entries[entries.length - 1]!;
    const extra = calls.flatMap((call, i) => [
      { ...last, seq: last.seq + 1 + i * 2, event: { kind: 'tool_call', ...call } },
      { ...last, seq: last.seq + 2 + i * 2, event: { kind: 'tool_result', name: call.name, ok: true, durationMs: 3, output: 'ok' } }
    ]);
    await route.fulfill({ response, json: [...entries, ...extra] });
  });
  return { project, id, root };
}

for (const viewport of [{ width: 390, height: 844, tag: 'mobile-390' }, { width: 1280, height: 860, tag: 'desktop-1280' }]) {
  test(`工具参数路径可点（${viewport.tag}）：跳到文件页对应行；工作空间外不可点`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const { project, id } = await setup(page, baseURL!);
    await page.goto(`/#/p/${project.id}/focus/${id}`);
    const log = page.getByRole('log', { name: '对话记录' });
    await expect(log.getByTestId('tool-card')).toHaveCount(4);
    await log.getByTestId('tool-card').evaluateAll((cards) => cards.forEach((card) => ((card as HTMLDetailsElement).open = true)));
    const links = log.getByTestId('tool-path-link');
    await expect(links).toHaveCount(2);
    await expect(links.nth(0)).toHaveAttribute('data-path', 'src/app.ts');
    await expect(links.nth(0)).toHaveAttribute('data-line', '80');
    await expect(links.nth(1)).toHaveAttribute('data-path', 'README.md');
    // 工作空间外：照样显示，但不是按钮
    await expect(log.getByTestId('tool-input').filter({ hasText: '/etc/hosts' })).toBeVisible();
    await expect(log.getByTestId('tool-input').filter({ hasText: '../outside.txt' })).toBeVisible();
    // 正文里的路径不可点
    await expect(log.getByTestId('msg-user').getByTestId('tool-path-link')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: `${SHOTS}/${viewport.tag}-chat.png` });

    await links.nth(0).click();
    await expect(page.getByTestId('session-tab-files')).toHaveAttribute('aria-selected', 'true');
    const panel = page.getByTestId('files-panel-files');
    await expect(panel.getByTestId('file-content')).toContainText('v80 = 80');
    const target = panel.locator('[data-target-line="80"]');
    await expect(target).toContainText('v80 = 80');
    await expect(target).toBeInViewport();
    if (viewport.width >= 768) await expect(panel.locator('[data-path="src/app.ts"]')).toBeVisible();
    else await expect(panel.getByTestId('files-back')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/${viewport.tag}-file.png` });

    // 回到对话点第二个（绝对路径、在工作空间内，没有行号）
    await page.getByTestId('session-tab-chat').click();
    await links.nth(1).click();
    await expect(page.getByTestId('session-tab-files')).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByTestId('file-content')).toContainText('说明');
  });
}
