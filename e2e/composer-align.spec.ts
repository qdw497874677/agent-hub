import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, stopFakeWorker, FAKE_AGENT_ID } from './fake-worker.ts';
import { hideSessionOptions, showSessionOptions } from './session-composer-controls.ts';

/**
 * 输入框底栏的主控件垂直对齐；手机把模式与思考强度收入非模态设置，不与模型抢宽度。
 * 两种宿主都可选附件、有草稿才可发送，桌面仍可直接调设置。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'];

async function setup(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  const workerId = await ensureFakeWorker(page, baseURL);
  const dir = mkdtempSync(join(tmpdir(), 'e2e-align-'));
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 对齐 ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '对齐' }, headers })).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: FAKE_AGENT_ID, model: 'fake/m1' }, headers });
  expect(derived.ok(), await derived.text()).toBe(true);
  const { id } = (await derived.json()) as { id: string };
  // e2e 的 agent 不报可调项：在画布投影里给这条会话补上和真实 OpenCode 一样的三项——
  // 候选很多的模型（走可搜索的按钮选择器）+ Agent + 思考强度
  const models = Array.from({ length: 12 }, (_, i) => ({ kind: 'value', value: { value: `zai/glm-5.${i}-flash`, label: `zai-coding-cn/glm-5.${i}-flash` } }));
  const optionSpec = [
    { id: 'model', label: '模型', category: 'model', kind: 'select', current: 'zai/glm-5.3-flash', choices: models },
    { id: 'mode', label: 'Agent', category: 'agent', kind: 'select', current: 'orchestrator', choices: ['orchestrator', 'build', 'plan'].map((v) => ({ kind: 'value', value: { value: v, label: v } })) },
    { id: 'effort', label: '思考强度', category: 'thought_level', kind: 'select', current: 'high', choices: ['low', 'medium', 'high'].map((v) => ({ kind: 'value', value: { value: v, label: v } })) }
  ];
  await page.route(`**/api/projects/${project.id}/canvas`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const s of body.sessions) if (s.id === id) { s.optionSpec = optionSpec; s.options = { model: 'zai/glm-5.3-flash', effort: 'high' }; }
    await route.fulfill({ response, json: body });
  });
  return { projectId: project.id, id, dir };
}

/** 底栏里每个控件的盒子：高度相同、垂直中线相同（容差 1px）。 */
async function expectAligned(row: Locator, label: string, touch: boolean, compact: boolean) {
  const controls = row.locator('button:visible, select:visible');
  const boxes = (await controls.evaluateAll((nodes) => nodes.map((n) => { const r = n.getBoundingClientRect(); return { name: n.getAttribute('aria-label') ?? n.tagName, top: r.top, left: r.left, right: r.right, width: r.width, height: r.height }; })));
  expect(boxes.length, `${label}：底栏控件`).toBeGreaterThanOrEqual(4);
  const options = boxes.filter((b) => b.name !== '添加附件' && b.name !== '拍照' && b.name !== '发送' && b.name !== '中断');
  const tall = Math.max(...boxes.map((b) => b.height));
  for (const b of options) expect(Math.abs(b.height - options[0]!.height), `${label}：${b.name} 和 ${options[0]!.name} 一样高`).toBeLessThanOrEqual(1);
  const mid = (b: { top: number; height: number }) => b.top + b.height / 2;
  for (const b of boxes) expect(Math.abs(mid(b) - mid(boxes[0]!)), `${label}：${b.name} 垂直居中`).toBeLessThanOrEqual(1);
  for (const b of options) expect(Math.abs(b.height - tall), `${label}：${b.name} 和按钮一样高`).toBeLessThanOrEqual(1);
  // 44px 的触屏控件不许把底栏撑出卡片；换行会表现为中线不齐，上面已经拦住。
  const rowBox = await row.evaluate((node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right }; });
  for (const b of boxes) {
    expect(b.left, `${label}：${b.name} 没超出底栏左边`).toBeGreaterThanOrEqual(rowBox.left - 1);
    expect(b.left + b.width, `${label}：${b.name} 没超出底栏右边`).toBeLessThanOrEqual(rowBox.right + 1);
  }
  if (touch) for (const b of options) expect(Math.abs(b.height - 44), `${label}：${b.name} 是 44px 触屏目标`).toBeLessThanOrEqual(0.5);
  const model = boxes.find((b) => b.name.startsWith('模型：'));
  const effort = boxes.find((b) => b.name === '思考强度');
  const agent = boxes.find((b) => b.name === 'Agent');
  expect(model, `${label}：当前会话的模型选择器存在`).toBeDefined();
  if (compact) {
    expect(effort, `${label}：思考强度不会挤占模型宽度`).toBeUndefined();
    expect(model?.width, `${label}：模型名称有足够宽度`).toBeGreaterThanOrEqual(105);
  } else expect(effort, `${label}：思考强度选择器存在`).toBeDefined();
  if (model && effort) {
    expect(model.left, `${label}：模型在思考强度左边`).toBeLessThan(effort.left);
    if (agent) expect(agent.left, `${label}：Agent 在思考强度右边`).toBeGreaterThan(effort.left);
  }
  return boxes;
}

async function exercise(page: Page, scope: Locator, label: string, touch: boolean) {
  const attach = scope.getByRole('button', { name: '添加附件' });
  await expect(attach).toBeVisible({ timeout: 10_000 });
  const row = attach.locator('xpath=ancestor::*[@data-testid="composer-controls"][1]');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${label.replace(/\s+/g, '-')}.png`) });
  const compact = (page.viewportSize()?.width ?? 0) < 768;
  await expectAligned(row, label, touch, compact);
  await expect(row.getByRole('button', { name: /^模型：.+ · .+$/ })).toBeVisible();
  if (compact) {
    await expect(row.getByTestId('session-model-trigger')).toContainText('glm-5.3-flash');
    await expect(row.getByRole('combobox', { name: 'Agent', exact: true })).toHaveCount(0);
    await showSessionOptions(scope);
  }
  await expect(scope.getByRole('combobox', { name: '思考强度' })).toHaveValue('high');
  if (compact) {
    await expect(scope.getByTestId('session-options-panel').getByRole('combobox', { name: 'Agent', exact: true })).toHaveValue('orchestrator');
    await hideSessionOptions(scope);
  }
  const send = scope.getByRole('button', { name: '发送', exact: true });
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

for (const mode of [{ name: '320px 触屏', w: 320, h: 700, touch: true }, { name: '390px 触屏', w: 390, h: 844, touch: true }, { name: '1280px', w: 1280, h: 844, touch: false }]) {
  test.describe(mode.name, () => {
    test.use({ hasTouch: mode.touch, viewport: { width: mode.w, height: mode.h } });
    test(`${mode.name}：输入框底栏对齐，会话页和画布窗口一致`, async ({ page, baseURL }) => {
      if (SHOTS) mkdirSync(SHOTS, { recursive: true });
      const { projectId, id, dir } = await setup(page, baseURL!);
      try {
        await page.goto(`/#/p/${projectId}/focus/${id}`);
        const header = page.getByTestId('focus-header');
        await expect(header).toBeVisible();
        await expect(header.getByRole('button', { name: '新建任务', exact: true })).toHaveCount(0);
        if (mode.touch) {
          await expect(page.getByTestId('session-tabs')).toBeHidden();
          await expect(page.getByTestId('workspace-entry')).toHaveCount(0);
          await expect(page.getByTestId('provenance-row')).toBeHidden();
          const headerHeight = (await header.boundingBox())!.height;
          expect(headerHeight, '只有一行会话页头').toBeLessThanOrEqual(52);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
          const more = page.getByTestId('session-more-trigger');
          const moreBox = (await more.boundingBox())!;
          expect(moreBox.width).toBeGreaterThanOrEqual(44);
          expect(moreBox.height).toBeGreaterThanOrEqual(44);
          await more.click();
          const menu = header.getByRole('menu');
          const details = menu.getByTestId('session-more-details');
          const actions = menu.getByTestId('session-more-actions');
          for (const item of ['files', 'changes', 'preview', 'workspace']) {
            await expect(menu.getByTestId(`session-more-${item}`)).toBeVisible();
          }
          await expect(menu.getByRole('menuitem', { name: '搜索任务与会话' })).toBeVisible();
          await expect(menu.getByTestId('session-more-provenance')).toHaveCount(0);
          await expect(menu.getByTestId('agent-handoff-trigger')).toHaveCount(0);
          expect(await menu.evaluate((el) => el.scrollHeight <= el.clientHeight + 1), '手机首层无需滚动').toBe(true);
          if (SHOTS) await page.screenshot({ path: join(SHOTS, `more-${mode.w}.png`) });

          await details.click();
          await expect(menu.getByTestId('session-more-provenance')).toBeVisible();
          await expect(menu.getByTestId('session-more-workspace')).toHaveCount(0);
          await menu.getByTestId('session-more-back').click();
          await expect(details).toBeFocused();

          await actions.click();
          await expect(menu.getByTestId('agent-handoff-trigger')).toBeVisible();
          await page.keyboard.press('Escape');
          await expect(actions).toBeFocused();
          await page.keyboard.press('Escape');
          await expect(menu).toBeHidden();
          await expect(more).toBeFocused();

          await more.click();
          await details.click();
          await page.getByRole('textbox', { name: '发送消息' }).click();
          await expect(menu).toBeHidden();
          await more.click();
          await expect(details).toBeVisible();
          await expect(menu.getByTestId('session-more-back')).toHaveCount(0);
          await page.keyboard.press('Escape');
        } else {
          const more = header.getByTestId('session-more-trigger');
          await more.click();
          await expect(header.getByRole('menuitem', { name: /^分叉/ })).toBeVisible();
          await expect(header.getByTestId('session-more-actions')).toHaveCount(0);
          await page.keyboard.press('Escape');
        }
        await exercise(page, page.locator('body'), `${mode.name} 会话页`, mode.touch);
        await page.goto(`/#/p/${projectId}/canvas`);
        const card = page.locator(`.react-flow__node-session[data-id="${id}"]`);
        await card.locator('header').dblclick({ position: { x: 60, y: 8 } });
        const win = page.locator(`[data-testid="canvas-window"][data-session-id="${id}"]`);
        await expect(win).toBeVisible();
        if (mode.touch) {
          await win.getByTestId('session-more-trigger').click();
          await win.getByTestId('session-more-actions').click();
          await expect(win.getByTestId('session-side-open')).toBeVisible();
          await win.getByTestId('session-more-back').click();
          await expect(win.getByTestId('session-more-workspace')).toBeVisible();
          await page.keyboard.press('Escape');
        }
        await exercise(page, win, `${mode.name} 画布窗口`, mode.touch);
      } finally {
        stopFakeWorker();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
