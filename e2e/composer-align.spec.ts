import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * 输入框底栏：「+ / 拍照 / 模型 / 思考强度 / 发送」一样高、垂直居中对齐——
 * 画布窗口和会话页、手机（触屏，下拉被抬到 16px）和桌面都是。按钮都能用：附件能选、可调项能改、有字才能发。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'];

async function setup(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  let agentId: string | undefined;
  for (let i = 0; i < 40 && !agentId; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((w) => w.state === 'online')?.agentIds[0];
    if (!agentId) await page.waitForTimeout(500);
  }
  test.skip(!agentId, '这台机器上没有可用的 agent');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-align-'));
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 对齐 ${Date.now().toString(36)}`, rootPath: dir }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '对齐' }, headers })).json()) as { id: string };
  rmSync(dir, { recursive: true, force: true });
  const { id } = (await (await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers })).json()) as { id: string };
  // e2e 的 agent 不报可调项：在画布投影里给这条会话补上和 David 截图一样的两项——
  // 候选很多的模型（走可搜索的按钮选择器）+ 思考强度（原生下拉）
  const models = Array.from({ length: 12 }, (_, i) => ({ kind: 'value', value: { value: `zai/glm-5.${i}-flash`, label: `zai-coding-cn/glm-5.${i}-flash` } }));
  const optionSpec = [
    { id: 'model', label: '模型', category: 'model', kind: 'select', current: 'zai/glm-5.3-flash', choices: models },
    { id: 'effort', label: '思考强度', category: 'thought_level', kind: 'select', current: 'high', choices: ['low', 'medium', 'high'].map((v) => ({ kind: 'value', value: { value: v, label: v } })) }
  ];
  await page.route(`**/api/projects/${project.id}/canvas`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const s of body.sessions) if (s.id === id) { s.optionSpec = optionSpec; s.options = { model: 'zai/glm-5.3-flash', effort: 'high' }; }
    await route.fulfill({ response, json: body });
  });
  return { projectId: project.id, id };
}

/** 底栏里每个控件的盒子：高度相同、垂直中线相同（容差 1px）。 */
async function expectAligned(row: Locator, label: string) {
  const controls = row.locator('button:visible, select:visible');
  const boxes = (await controls.evaluateAll((nodes) => nodes.map((n) => { const r = n.getBoundingClientRect(); return { name: n.getAttribute('aria-label') ?? n.tagName, top: r.top, height: r.height }; })));
  expect(boxes.length, `${label}：底栏控件`).toBeGreaterThanOrEqual(4);
  const options = boxes.filter((b) => b.name !== '添加附件' && b.name !== '拍照' && b.name !== '发送' && b.name !== '中断');
  const tall = Math.max(...boxes.map((b) => b.height));
  for (const b of options) expect(Math.abs(b.height - options[0]!.height), `${label}：${b.name} 和 ${options[0]!.name} 一样高`).toBeLessThanOrEqual(1);
  const mid = (b: { top: number; height: number }) => b.top + b.height / 2;
  for (const b of boxes) expect(Math.abs(mid(b) - mid(boxes[0]!)), `${label}：${b.name} 垂直居中`).toBeLessThanOrEqual(1);
  for (const b of options) expect(Math.abs(b.height - tall), `${label}：${b.name} 和按钮一样高`).toBeLessThanOrEqual(1);
  return boxes;
}

async function exercise(page: Page, scope: Locator, label: string) {
  const attach = scope.getByRole('button', { name: '添加附件' });
  await expect(attach).toBeVisible({ timeout: 10_000 });
  const row = attach.locator('xpath=ancestor::div[contains(@class,"justify-between")][1]');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${label.replace(/\s+/g, '-')}.png`) });
  const boxes = await expectAligned(row, label);
  void boxes;
  await expect(row.getByRole('combobox', { name: '思考强度' })).toHaveValue('high');
  await expect(row.getByRole('button', { name: /^模型：/ })).toBeVisible();
  const send = scope.getByRole('button', { name: '发送' });
  await expect(send).toBeDisabled();
  await scope.getByRole('textbox', { name: '发送消息' }).fill('你好');
  await expect(send).toBeEnabled();
  await scope.getByRole('textbox', { name: '发送消息' }).fill('');
  const chooser = page.waitForEvent('filechooser');
  await attach.click();
  await (await chooser).setFiles({ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
  await expect(scope.getByRole('list', { name: '待发送的附件' })).toContainText('a.txt');
  await expect(send, '有附件就能发').toBeEnabled();
}

for (const mode of [{ name: '390px 触屏', w: 390, h: 844, touch: true }, { name: '1280px', w: 1280, h: 844, touch: false }]) {
  test.describe(mode.name, () => {
    test.use({ hasTouch: mode.touch, viewport: { width: mode.w, height: mode.h } });
    test(`${mode.name}：输入框底栏对齐，会话页和画布窗口一致`, async ({ page, baseURL }) => {
      if (SHOTS) mkdirSync(SHOTS, { recursive: true });
      const { projectId, id } = await setup(page, baseURL!);
      await page.goto(`/#/p/${projectId}/focus/${id}`);
      await exercise(page, page.locator('body'), `${mode.name} 会话页`);
      await page.goto(`/#/p/${projectId}/canvas`);
      const card = page.locator(`.react-flow__node-session[data-id="${id}"]`);
      await card.locator('header').dblclick({ position: { x: 60, y: 8 } });
      const win = page.locator(`[data-testid="canvas-window"][data-session-id="${id}"]`);
      await expect(win).toBeVisible();
      await exercise(page, win, `${mode.name} 画布窗口`);
    });
  });
}
