import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page, type Route } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';

/**
 * 写和读这两处最容易在真实内容下塌掉的地方：
 *
 * 1. 输入框跟着内容长高，但长到 200px 就停住自己滚——草稿写长了不能把对话区顶走；
 * 2. 思考过程比答案长，所以是一个固定高度的窗口：超过窗口才出现上下渐隐和内部滚动，
 *    而外层会话照样能滚（手指 / 滚轮不该被里面那块截走）。
 */

const SHOTS = process.env['E2E_SCREENSHOTS'];
const LINES = 60;
test.afterAll(stopFakeWorker);

type Entry = { seq: number; at: number; event: { kind: string; text?: string; delta?: string } };

async function setup(page: Page, baseURL: string) {
  await loginByApi(page);
  const workerId = await ensureFakeWorker(page, baseURL);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  const dir = mkdtempSync(join(tmpdir(), 'e2e-stream-ui-'));
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 流 ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '写和读' }, headers })).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: FAKE_AGENT_ID, model: '' }, headers });
  expect(derived.status(), await derived.text()).toBe(201);
  const session = (await derived.json()) as { id: string };
  expect((await page.request.post(`/api/sessions/${session.id}/prompt`, { data: { text: '先问一句' }, headers })).status()).toBe(202);
  await expect.poll(async () => ((await (await page.request.get(`/api/sessions/${session.id}/events`)).json()) as Entry[])
    .some((entry) => entry.event.kind === 'ended'), { timeout: 30_000 }).toBe(true);
  return { project: project.id, session: session.id };
}

/**
 * 在第一条 prompt 后面塞一段很长的思考 + 一段很长的回答：
 * 思考要高过窗口（208px），回答要高到让外层会话也滚起来。
 */
function withLongThinking(entries: Entry[]): Entry[] {
  const first = entries.find((entry) => entry.event.kind === 'prompt');
  if (!first) return entries;
  const thinking = Array.from({ length: LINES }, (_, i) => `第 ${i + 1} 步：先把这件事想清楚，再决定要不要动手。`).join('\n');
  const reply = Array.from({ length: LINES }, (_, i) => `回答第 ${i + 1} 行：这是用来把外层会话撑到需要滚动的正文。`).join('\n\n');
  const injected: Entry[] = [
    { seq: first.seq + 1, at: first.at, event: { kind: 'thinking', delta: thinking } },
    { seq: first.seq + 2, at: first.at, event: { kind: 'text', delta: reply } }
  ];
  const index = entries.indexOf(first) + 1;
  return [...entries.slice(0, index), ...injected, ...entries.slice(index).map((entry) => ({ ...entry, seq: entry.seq + injected.length }))];
}

async function seedLongThinking(page: Page, session: string) {
  await page.route(`**/api/sessions/${session}/events*`, async (route: Route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: withLongThinking((await response.json()) as Entry[]) });
  });
}

test.describe('桌面', () => {
  test.use({ viewport: { width: 1280, height: 844 } });

  test('输入框按行长高、到 200px 停住自己滚；思考块超过窗口才渐隐 + 内部滚，外层照样能滚', async ({ page, baseURL }) => {
    const { project, session } = await setup(page, baseURL!);
    await seedLongThinking(page, session);
    await page.goto(`/#/p/${project}/focus/${session}`);

    // ① 输入框：三行比一行高，四十行停在上限。
    const area = page.getByLabel('发送消息');
    await expect(area).toBeVisible();
    const oneLine = (await area.boundingBox())!.height;
    await area.fill('第一行\n第二行\n第三行');
    await expect.poll(async () => (await area.boundingBox())!.height).toBeGreaterThan(oneLine + 10);
    const threeLines = (await area.boundingBox())!.height;
    expect(threeLines, '三行还不该碰到上限').toBeLessThan(200);

    await area.fill(Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行`).join('\n'));
    const capped = (await area.boundingBox())!.height;
    expect(capped, '写到 40 行也不能超过 200px').toBeLessThanOrEqual(200.5);
    expect(capped, '但确实长到了上限附近，而不是停在 3 行').toBeGreaterThan(threeLines);
    const field = await area.evaluate((element) => {
      const style = getComputedStyle(element);
      return { overflowY: style.overflowY, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
    });
    expect(field.overflowY, '超上限才出滚动条').toBe('auto');
    expect(field.scrollHeight).toBeGreaterThan(field.clientHeight);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/composer-grown.png` });

    // 清掉草稿：下面的断言不该受它影响，也别把它留在会话里。
    await area.fill('');

    // ② 展开工作过程后，思考内容超过窗口 → 有窗口、有遮罩、能内部滚。
    await page.getByTestId('work-group-toggle').first().click();
    const thinking = page.getByTestId('thinking').first();
    await expect(thinking).toHaveAttribute('open', '');
    const windowNode = thinking.getByTestId('thinking-window');
    await expect(windowNode, '内容高过窗口才切成窗口形态').toHaveAttribute('data-windowed', 'true');

    const box = await windowNode.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
        mask: style.maskImage || style.getPropertyValue('-webkit-mask-image'),
        maxHeight: element.style.maxHeight
      };
    });
    expect(box.maxHeight).toBe('208px');
    expect(box.clientHeight).toBeLessThanOrEqual(209);
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight + 100);
    expect(box.mask, '底部还藏着内容：下边要渐隐').toContain('linear-gradient');

    // 滚到底：下面没东西了，渐隐该挪到上面去（两侧各自算，不是一刀切）。
    await windowNode.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(async () => windowNode.evaluate((element) => getComputedStyle(element).maskImage))
      .not.toBe(box.mask);
    const atBottom = await windowNode.evaluate((element) => ({ mask: getComputedStyle(element).maskImage, top: element.scrollTop }));
    expect(atBottom.top).toBeGreaterThan(0);
    expect(atBottom.mask).toContain('linear-gradient');

    // ③ 外层会话：仍然是它自己在滚，里面的窗口不接管滚轮。
    const outer = page.locator('[role="log"]').locator('..');
    const outerGeo = await outer.evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
    expect(outerGeo.scrollHeight, '注入的正文应该把外层撑高').toBeGreaterThan(outerGeo.clientHeight);
    const before = await outer.evaluate((element) => (element.scrollTop = 0, element.scrollTop));
    await outer.evaluate((element) => {
      element.scrollTop = 240;
    });
    const after = await outer.evaluate((element) => element.scrollTop);
    expect(after).toBeGreaterThan(before);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/thinking-window.png` });
  });
});

test.describe('手机', () => {
  // 手指 + 窄屏：思考块保持整段展开，不做内部窗口（手势要留给外层会话）。
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('手机上没有内部滚动窗口：思考过程整段铺开', async ({ page, baseURL }) => {
    const { project, session } = await setup(page, baseURL!);
    await seedLongThinking(page, session);
    await page.goto(`/#/p/${project}/focus/${session}`);

    await page.getByTestId('work-group-toggle').first().click();
    const thinking = page.getByTestId('thinking').first();
    await expect(thinking).toHaveAttribute('open', '');
    const windowNode = thinking.getByTestId('thinking-window');
    await expect(windowNode).toHaveAttribute('data-windowed', 'false');

    const box = await windowNode.evaluate((element) => ({
      maxHeight: getComputedStyle(element).maxHeight,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight
    }));
    expect(box.maxHeight, '手机上不封顶').toBe('none');
    expect(box.clientHeight, '整段铺开，不藏着内容').toBe(box.scrollHeight);
    expect(box.clientHeight).toBeGreaterThan(300);
  });
});
