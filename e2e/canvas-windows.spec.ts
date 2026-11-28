import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';

/**
 * 画布中展开会话（docs/design/canvas-expanded-sessions.md）：
 * 双击 / ⤢ / 右键展开成窗口，自动平铺不重叠；标题栏拖窗口（变自由）、对话区只滚动、「重新平铺」恢复；
 * 最小化到窗口条；刷新后还在；手机上一次一个全屏、顶条左右滑切换。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'];
type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
const viewport = (page: Page) => page.locator('.react-flow__viewport').evaluate((n) => (n as HTMLElement).style.transform);
const windows = (page: Page) => page.getByTestId('canvas-window');
const win = (page: Page, id: string) => page.locator(`[data-testid="canvas-window"][data-session-id="${id}"]`);
const card = (page: Page, id: string) => page.locator(`.react-flow__node-session[data-id="${id}"]`);
const dirs = new Set<string>();

test.afterAll(() => {
  stopFakeWorker();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function setup(page: Page, baseURL: string, count: number) {
  await loginByApi(page);
  const workerId = await ensureFakeWorker(page, baseURL);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  const post = async <T>(url: string, data: unknown, status = 201): Promise<T> => {
    const response = await page.request.post(url, { headers, data });
    expect(response.status(), await response.text()).toBe(status);
    return await response.json() as T;
  };
  const dir = mkdtempSync(join(tmpdir(), 'e2e-windows-'));
  dirs.add(dir);
  const project = await post<{ id: string }>('/api/projects', { name: `e2e 窗口 ${Date.now().toString(36)}`, rootPath: dir, workerId });
  const task = await post<{ id: string }>('/api/tasks', { projectId: project.id, title: '多窗口' });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push((await post<{ id: string }>('/api/sessions/derive', { taskId: task.id, workerId, agentId: FAKE_AGENT_ID, model: '' })).id);
  const long = Array.from({ length: 40 }, (_, i) => `窗口第 ${i + 1} 行：${'很长的一段话，'.repeat(6)}`).join('\n');
  await post(`/api/sessions/${ids[0]}/prompt`, { text: long }, 202);
  await page.goto(`/#/p/${project.id}/canvas`);
  await expect(page.locator('.react-flow__node-session')).toHaveCount(count);
  return { ids, projectId: project.id };
}

test.describe('画布中展开会话', () => {
  test.beforeAll(() => {
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  });

  test('1280px：双击 / ⤢ / 右键展开，平铺不重叠，拖动、平铺、最小化、刷新恢复', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 844 });
    const { ids } = await setup(page, baseURL!, 3);
    const [a, b, c] = ids as [string, string, string];

    // 双击会话卡 = 在画布中展开（不再进会话页）
    const url = page.url();
    await card(page, a).locator('header').dblclick({ position: { x: 60, y: 8 } });
    await expect(win(page, a)).toBeVisible();
    expect(page.url(), '双击不离开画布').toBe(url);
    await expect(card(page, a).getByTestId('card-expanded')).toBeVisible();
    await expect(win(page, a).getByRole('log', { name: '会话记录' })).toContainText('窗口第 40 行', { timeout: 30000 });
    // 再双击同一张 = 聚焦，不重复开
    await card(page, a).locator('header').dblclick({ position: { x: 60, y: 8 } });
    await expect(windows(page)).toHaveCount(1);

    // ⤢ 按钮
    await card(page, b).locator('header').click({ position: { x: 60, y: 8 } });
    await card(page, b).getByRole('button', { name: '在画布中展开' }).click();
    // 右键菜单（第三张卡可能被窗口挡住：用 dispatchEvent 发 contextmenu，再点菜单）
    await card(page, c).locator('header').dispatchEvent('contextmenu', { clientX: 10, clientY: 10 });
    await page.getByRole('menuitem', { name: '在画布中展开' }).click();
    await expect(windows(page)).toHaveCount(3);

    const boxes = await Promise.all(ids.map(async (id) => (await win(page, id).boundingBox())!));
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(overlaps(boxes[i]!, boxes[j]!), `窗口 ${i}/${j} 不重叠`).toBe(false);
    for (const box of boxes) expect(box.width, '窗口够大').toBeGreaterThanOrEqual(360);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-3-windows.png` });

    // 对话区：滚轮只滚对话，不缩放、不平移画布
    {
      const log = win(page, a).getByRole('log', { name: '会话记录' });
      const scroller = log.locator('xpath=..');
      const vp = await viewport(page);
      const geom = (n: Element) => {
        const e = n as HTMLElement;
        return { sh: e.scrollHeight, ch: e.clientHeight, st: e.scrollTop };
      };
      await scroller.evaluate((n) => (n.scrollTop = 0));
      const before = await scroller.evaluate(geom);
      // issue #215：桌面窗口里滚动容器的父级 <section> 是 display:block（h-full overflow-hidden），
      // FocusView 根节点的 min-h-0 flex-1 在 block 父级里不生效 → 滚动容器高度等于内容高度（sh === ch），
      // 多出来的内容被 section 的 overflow-hidden 裁掉，滚轮无处可滚。这里把「没得滚」和「滚了没」分开报。
      expect(before.sh, `对话区没有可滚空间（容器高度没被窗口约束）before=${JSON.stringify(before)}`).toBeGreaterThan(before.ch);
      await log.hover();
      await page.mouse.wheel(0, 300);
      let after = await scroller.evaluate(geom);
      for (let k = 0; k < 10 && after.st === 0; k++) {
        await page.waitForTimeout(100);
        after = await scroller.evaluate(geom);
      }
      expect(after.st, `滚轮滚动窗口对话 before=${JSON.stringify(before)} after=${JSON.stringify(after)}`).toBeGreaterThan(0);
      expect(await viewport(page), '窗口里滚轮不动画布').toBe(vp);
    }

    // 窗口里的输入框正常打字
    {
      const input = win(page, b).getByLabel('发送消息');
      await input.click();
      await page.keyboard.type('窗口输入正常');
      await expect(input).toHaveValue('窗口输入正常');
      await input.fill('');
    }

    // 标题栏拖窗口：窗口动、画布不动，变成自由窗口
    {
      const vp = await viewport(page);
      const title = win(page, a).getByTestId('window-titlebar');
      await expect(title).toBeVisible();
      const before = (await win(page, a).boundingBox())!;
      const t = (await title.boundingBox())!;
      // The session name is a button; drag from the title bar's inert top padding instead.
      const [x, y] = [t.x + 7, t.y + 5];
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let k = 1; k <= 10; k++) await page.mouse.move(x + 4 * k, y + 3 * k);
      await page.mouse.up();
      await expect(win(page, a)).toHaveAttribute('data-mode', 'free');
      const after = (await win(page, a).boundingBox())!;
      expect(Math.round(after.x - before.x), '窗口跟着拖').toBeGreaterThan(20);
      expect(await viewport(page), '拖窗口不动画布').toBe(vp);
    }

    // 右下角改大小：也变自由
    {
      // 自由窗口不占平铺位，可能盖着别的窗口：先点一下标题栏把 b 提到最前
      await win(page, b).getByTestId('window-titlebar').click({ position: { x: 16, y: 12 } });
      await expect(win(page, b)).toHaveAttribute('data-focused', 'true');
      const handle = win(page, b).locator('xpath=..').getByTestId('window-resize');
      const h = (await handle.boundingBox())!;
      const before = (await win(page, b).boundingBox())!;
      await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
      await page.mouse.down();
      for (let k = 1; k <= 10; k++) await page.mouse.move(h.x + h.width / 2 - 4 * k, h.y + h.height / 2 - 3 * k);
      await page.mouse.up();
      await expect(win(page, b)).toHaveAttribute('data-mode', 'free');
      expect((await win(page, b).boundingBox())!.width).toBeLessThan(before.width);
    }

    // 「重新平铺」：回到平铺，互不重叠
    await page.getByRole('button', { name: '重新平铺窗口' }).click();
    for (const id of ids) await expect(win(page, id)).toHaveAttribute('data-mode', 'tiled');

    // 最小化到窗口条，点一下恢复
    await win(page, c).getByRole('button', { name: '最小化' }).click();
    await expect(windows(page)).toHaveCount(2);
    const bar = page.getByTestId('window-bar');
    await expect(bar).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-minimized-bar.png` });
    await bar.getByRole('button', { name: /多窗口/ }).first().click();
    await expect(windows(page)).toHaveCount(3);

    // 最大化 / 还原
    await win(page, a).getByRole('button', { name: '最大化' }).click();
    await expect(win(page, a)).toHaveAttribute('data-mode', 'max');
    await win(page, a).getByRole('button', { name: '还原' }).click();
    await expect(win(page, a)).toHaveAttribute('data-mode', 'tiled');

    // 刷新：窗口还在（存在本机浏览器）
    await page.reload();
    await expect(windows(page)).toHaveCount(3);

    // 关闭只关窗口
    await win(page, c).getByRole('button', { name: '关闭窗口' }).click();
    await expect(windows(page)).toHaveCount(2);
    await expect(page.locator('.react-flow__node-session')).toHaveCount(3);

    // ↗ 进会话页
    const before = page.url();
    await win(page, b).getByRole('button', { name: '打开会话页' }).click();
    await expect.poll(() => page.url()).not.toBe(before);
    await expect(page.getByTestId('canvas-window')).toHaveCount(0);
  });

  test('1280px：超过 4 个平铺不下的收进窗口条', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 844 });
    const { ids } = await setup(page, baseURL!, 5);
    for (const id of ids) {
      await card(page, id).locator('header').dispatchEvent('contextmenu', { clientX: 10, clientY: 10 });
      await page.getByRole('menuitem', { name: '在画布中展开' }).click();
    }
    await expect(windows(page)).toHaveCount(4);
    await expect(page.getByTestId('window-bar').getByRole('button', { name: /^关闭 / })).toHaveCount(1);
    await expect(win(page, ids[0]!)).toHaveCount(0); // 最久没聚焦的那个被收起
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-4-tiled-plus-bar.png` });
  });

  test('390px：一次一个全屏，顶条左右滑切换，‹ 画布 回去', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { ids } = await setup(page, baseURL!, 2);
    const [a, b] = ids as [string, string];
    await card(page, a).getByRole('button', { name: '在画布中展开' }).click();
    const shown = page.getByTestId('canvas-window');
    await expect(shown).toHaveCount(1);
    await expect(shown).toHaveAttribute('data-mobile', 'true');
    const box = (await shown.boundingBox())!;
    expect(box.width, '手机上全屏').toBeGreaterThanOrEqual(389);
    await expect(page.getByTestId('window-count')).toHaveText('1/1');
    await expect(shown.getByRole('log', { name: '会话记录' })).toContainText('窗口第 40 行', { timeout: 30000 });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/mobile-window.png` });

    await page.getByRole('button', { name: '‹ 画布' }).click();
    await expect(shown).toHaveCount(0);
    await expect(page.getByTestId('window-bar')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/mobile-canvas-bar.png` });

    await card(page, b).locator('header').dispatchEvent('contextmenu', { clientX: 10, clientY: 10 });
    await page.getByRole('menuitem', { name: '在画布中展开' }).click();
    await expect(shown).toHaveAttribute('data-session-id', b);
    await expect(page.getByTestId('window-count')).toHaveText('2/2');

    // 在顶条上横滑：切到另一个
    const strip = (await page.getByTestId('window-swipe-strip').boundingBox())!;
    const y = strip.y + strip.height / 2;
    await page.mouse.move(strip.x + 300, y);
    await page.mouse.down();
    for (let k = 1; k <= 10; k++) await page.mouse.move(strip.x + 300 - 20 * k, y);
    await page.mouse.up();
    await expect(shown).toHaveAttribute('data-session-id', a);
    await expect(page.getByTestId('window-count')).toHaveText('1/2');

    // 刷新后还在
    await page.reload();
    await expect(page.getByTestId('canvas-window')).toHaveAttribute('data-session-id', a);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/mobile-window-2.png` });
  });
});
