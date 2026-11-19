import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { piModel } from './hub-model.ts';

/**
 * 输入框上方的上下文用量：一枚 20px 的环 + 点开 / 悬停的一张细条。
 * 真会话很难刚好跑到 42%，所以只在历史接口里补一条 `context_usage`——
 * 页面载入时会用它播种 live.contextUsage（`withFullHistory`）。
 */
const USED = 84_000;
const WINDOW = 200_000;
const PERCENT = 42;

test('上下文用量：环 + 条，aria-valuenow 和文案一致；手机上点按能展开', async ({ page, baseURL }) => {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  let agentId: string | undefined;
  for (let i = 0; i < 40 && !agentId; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((worker) => worker.state === 'online')?.agentIds[0];
    if (!agentId) await page.waitForTimeout(500);
  }
  test.skip(!agentId, '这台机器上没有可用的 agent');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-context-meter-'));
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 上下文环 ${Date.now().toString(36)}`, rootPath: dir }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '上下文环' }, headers })).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: piModel() }, headers });
  expect(derived.status(), await derived.text()).toBe(201);
  const { id } = (await derived.json()) as { id: string };

  await page.route(`**/api/sessions/${id}/events**`, async (route) => {
    const response = await route.fetch();
    const entries = (await response.json()) as Array<{ seq: number; at?: number; event?: Record<string, unknown> }>;
    const last = entries[entries.length - 1];
    const kind = { kind: 'context_usage', usedTokens: USED, windowTokens: WINDOW, percent: PERCENT };
    const usage = last === undefined ? { seq: 1, at: Date.now(), event: kind } : { ...last, seq: last.seq + 1, event: kind };
    await route.fulfill({ response, json: [...entries, usage] });
  });

  await page.goto(`/#/p/${project.id}/focus/${id}`);

  const meter = page.getByTestId('context-meter');
  await expect(meter).toBeVisible({ timeout: 30_000 });
  // 老用例（canvas.spec.ts）还在读 title：别让它丢
  await expect(meter).toHaveAttribute('title', new RegExp(`上下文：.*token（${PERCENT}%）`));

  const ring = page.getByTestId('context-ring');
  await expect(ring).toBeVisible();
  await expect(ring).toHaveAttribute('role', 'meter');
  await expect(ring).toHaveAttribute('aria-valuemin', '0');
  await expect(ring).toHaveAttribute('aria-valuemax', '100');
  await expect(ring).toHaveAttribute('aria-valuenow', String(PERCENT));
  await expect(ring).toHaveAttribute('aria-valuetext', `${PERCENT}%`);
  await expect(ring).toHaveAttribute('aria-label', `上下文已用 ${PERCENT}%，84K / 200K`);
  // 环上的弧：dashoffset 落在 58% 处（42% 画出来）
  const offsetRatio = await ring.evaluate((node) => {
    const circles = node.querySelectorAll('circle');
    const arc = circles[circles.length - 1] as SVGCircleElement;
    return Number(arc.getAttribute('stroke-dashoffset')) / Number(arc.getAttribute('stroke-dasharray'));
  });
  expect(offsetRatio).toBeCloseTo(1 - PERCENT / 100, 2);

  const bar = page.getByTestId('context-bar');
  await expect(bar).toBeHidden();
  await page.getByTestId('context-meter-toggle').click();
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute('data-open', 'true');
  await expect(bar).toContainText(`已用 84K`);
  await expect(bar).toContainText(`上限 200K`);
  await expect(bar).toContainText(`${PERCENT}%`);
  // 细条里已用段占的宽度就是 42%
  const barRatio = await bar.evaluate((node) => {
    const track = node.querySelector('span.block.h-1') as HTMLElement;
    const fill = track.firstElementChild as HTMLElement;
    return fill.getBoundingClientRect().width / track.getBoundingClientRect().width;
  });
  expect(barRatio).toBeCloseTo(PERCENT / 100, 2);

  // 鼠标停着也算 hover：先挪开，才能证明 Escape 真的收起了条
  await page.mouse.move(4, 4);
  await expect(bar).toBeVisible();
  await page.getByTestId('context-meter-toggle').press('Escape');
  await expect(bar).toBeHidden();

  // 手机：没有 hover 也得点得开，而且不越出屏幕
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByTestId('context-ring')).toBeVisible({ timeout: 30_000 });
  const mobileMeter = page.getByTestId('context-meter');
  await expect(mobileMeter).toContainText(`${PERCENT}%`);
  await page.getByTestId('context-meter-toggle').click();
  const mobileBar = page.getByTestId('context-bar');
  await expect(mobileBar).toBeVisible();
  const box = await mobileBar.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390 + 1);
});
