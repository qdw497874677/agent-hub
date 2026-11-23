import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { boxOf, expectNoHorizontalOverflow, expectNoOverlap, expectTouchTarget } from './hitbox.ts';

/**
 * Oil UI 第 1 项：首页待办整条正文（含状态标签）是同一个入口；进入仍待答的会话后，
 * 顶部状态说「等你回答 / 可能在等你」，由「当前待答提示」把人送到现有 composer，
 * 不自动发送、不覆盖草稿。回完这一句，待办从首页和 API 消失；
 * 历史提问卡仍只作记录，不再冒充当前待答。问号结尾的 possible 线索单独表述。
 * 假 ACP agent，无外部模型。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'];

test.afterAll(() => {
  stopFakeWorker();
});

test('待办状态标签即入口：进入会话回复后不再挂着等回答', async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const workerId = await ensureFakeWorker(page, baseURL!);
  const dir = mkdtempSync(join(tmpdir(), 'e2e-att-reply-'));
  try {
    const project = (await (await page.request.post('/api/projects', {
      data: { name: `e2e 待办回复 ${Date.now().toString(36)}`, rootPath: dir, workerId }, headers
    })).json()) as { id: string };
    const run = async (title: string, text: string) => {
      const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title }, headers })).json()) as { id: string };
      const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: FAKE_AGENT_ID, model: '' }, headers });
      expect(derived.ok(), await derived.text()).toBe(true);
      const session = (await derived.json()) as { id: string };
      expect((await page.request.post(`/api/sessions/${session.id}/prompt`, { data: { text }, headers })).ok()).toBe(true);
      return session.id;
    };
    const ids = {
      answer: await run('待办·显式提问', 'please-asktool'),
      maybe: await run('待办·问号结尾', 'please-question')
    };
    type Att = { items: Array<{ sessionId: string; phase: string; possible: boolean; since: number }> };
    const readAttention = async () => (await (await page.request.get('/api/attention')).json()) as Att;
    let att: Att = { items: [] };
    await expect.poll(async () => {
      att = await readAttention();
      return att.items.filter((item) => Object.values(ids).includes(item.sessionId)).length;
    }, { timeout: 60_000 }).toBe(2);
    expect(att.items.find((item) => item.sessionId === ids.answer)).toMatchObject({ phase: 'needs_answer', possible: false });
    expect(att.items.find((item) => item.sessionId === ids.maybe)).toMatchObject({ phase: 'needs_answer', possible: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/home');
    const inbox = page.getByTestId('attention-inbox');
    await expect(inbox).toBeVisible();
    const answerRow = inbox.getByTestId('attention-item').filter({ hasText: '待办·显式提问' });
    const answerOpen = answerRow.getByTestId('attention-open');
    // 状态标签确实在同一个进入目标里；旁边的 ⋯ 仍是独立控件。
    await expect(answerOpen.getByTestId('attention-phase')).toHaveText('等回答');
    await expect(answerOpen).toHaveAttribute('aria-label', /^等回答：/);
    await expect(answerOpen.getByTestId('attention-menu')).toHaveCount(0);
    const menu = await answerRow.getByTestId('attention-menu').boundingBox();
    expect(menu?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(menu?.height ?? 0).toBeGreaterThanOrEqual(44);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/01-inbox-row-390.png` });

    // 正好点状态标签，不是点标题右侧：整条正文都该是同一个入口。
    await answerRow.getByTestId('attention-phase').click();
    await expect(page).toHaveURL(new RegExp(`/p/${project.id}/focus/${ids.answer}`));
    const prompt = page.getByTestId('answer-prompt');
    await expect(prompt).toBeVisible();
    await expect(prompt).toHaveAttribute('data-possible', 'false');
    await expect(prompt).toContainText('Agent 在等你回答');
    await expect(prompt).toContainText('上一轮已结束');
    await expect(prompt).toHaveAttribute('title', /上一轮已结束/);
    await expect(page.getByTestId('answer-reply')).toBeVisible();
    // 顶部主状态说的是「等你回答」，不是裸「完成」；标题说明上一轮已经结束。
    const answerStatus = page.getByTestId('session-attention-status');
    const focusHeader = page.getByTestId('focus-header');
    await expect(answerStatus).toHaveText('等你回答');
    await expect(answerStatus).toHaveAttribute('data-possible', 'false');
    await expect(answerStatus).toHaveAttribute('title', /上一轮已结束/);
    await expect(focusHeader.getByText('完成', { exact: true })).toHaveCount(0);

    // 手机上的主要触控目标按实际盒模型算：返回和发送都至少 44×44，且返回不压住标题。
    const back390 = page.getByRole('button', { name: '返回' });
    const send390 = page.getByRole('button', { name: '发送', exact: true });
    const backBox390 = await expectTouchTarget(back390, '会话返回', 390);
    const sendBox390 = await expectTouchTarget(send390, '发送', 390);
    expectNoOverlap(backBox390, await boxOf(page.getByTestId('session-title'), '会话标题'), '返回与标题');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/02-session-answer-390.png` });

    // 已有草稿不被覆盖；「回复此问题」只把焦点送到输入框，不替人发送。
    const composer = page.getByRole('textbox', { name: '发送消息' });
    await composer.fill('先写一半');
    await composer.evaluate((element) => (element as HTMLTextAreaElement).blur());
    await page.getByTestId('answer-reply').click();
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue('先写一半');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/03-composer-focused-390.png` });

    // 真实发送按钮，不用键盘快捷键替身。
    await composer.fill('就用 A，谢谢');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(composer).toHaveValue('');
    await expect.poll(async () => (await readAttention()).items.some((item) => item.sessionId === ids.answer), {
      timeout: 60_000
    }).toBe(false);
    // 回复后主状态回到真实运行状态，不再挂着「等你回答」。
    await expect(answerStatus).toHaveCount(0, { timeout: 30_000 });
    await expect(focusHeader.getByText('完成', { exact: true })).toBeVisible({ timeout: 30_000 });

    // 回首页：这条待办真的没了，不是只在会话里藏起来。
    await page.getByRole('button', { name: '返回' }).click();
    await expect(inbox).toBeVisible();
    await expect(inbox.getByTestId('attention-item').filter({ hasText: '待办·显式提问' })).toHaveCount(0, { timeout: 30_000 });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/04-home-cleared-390.png` });

    // 重新进入：当前待答提示和顶部「等你回答」都不该再出现；
    // 历史提问卡只留中性短句，且不提供回复按钮。
    await page.goto(`/#/p/${project.id}/focus/${ids.answer}`);
    const history = page.getByTestId('agent-question');
    await expect(history).toBeVisible();
    await expect(history).toContainText('用 A 还是 B');
    await expect(history.getByTestId('agent-question-note')).toHaveText('这是当时的提问');
    await expect(history).not.toContainText('不代表仍在等待回答');
    await expect(history.getByTestId('answer-reply')).toHaveCount(0);
    await expect(page.getByTestId('answer-prompt')).toHaveCount(0);
    await expect(page.getByTestId('answer-reply')).toHaveCount(0);
    await expect(page.getByTestId('session-attention-status')).toHaveCount(0);
    await expect(page.getByTestId('focus-header').getByText('完成', { exact: true })).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/05-session-history-390.png` });

    // 320：更窄也不能横滑，返回/发送的 44×44 仍完整落在视口内。
    await page.setViewportSize({ width: 320, height: 700 });
    const back320 = page.getByRole('button', { name: '返回' });
    const send320 = page.getByRole('button', { name: '发送', exact: true });
    const backBox320 = await expectTouchTarget(back320, '320 会话返回', 320);
    const sendBox320 = await expectTouchTarget(send320, '320 发送', 320);
    expectNoOverlap(backBox320, await boxOf(page.getByTestId('session-title'), '320 会话标题'), '320 返回与标题');
    await expectNoHorizontalOverflow(page);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/08-session-targets-320.png` });
    await page.setViewportSize({ width: 390, height: 844 });

    // possible：末句问号只是线索，文案必须是「可能」，入口仍可把人送到 composer。
    await page.goto('/#/home');
    const maybeRow = page.getByTestId('attention-item').filter({ hasText: '待办·问号结尾' });
    await expect(maybeRow.getByTestId('attention-phase')).toHaveText('可能在等你');
    // 键盘也能进：原生 button 的 Enter 和鼠标点击是同一个目标。
    await maybeRow.getByTestId('attention-open').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/focus/${ids.maybe}`));
    const maybePrompt = page.getByTestId('answer-prompt');
    await expect(maybePrompt).toHaveAttribute('data-possible', 'true');
    await expect(maybePrompt).toContainText('Agent 可能在等你回答');
    await expect(maybePrompt).toContainText('上一轮已结束');
    await expect(maybePrompt).toHaveAttribute('title', /上一轮已结束/);
    const maybeStatus = page.getByTestId('session-attention-status');
    await expect(maybeStatus).toHaveText('可能在等你');
    await expect(maybeStatus).toHaveAttribute('data-possible', 'true');
    await expect(maybeStatus).toHaveAttribute('title', /上一轮已结束/);
    await page.getByTestId('answer-reply').click();
    await expect(page.getByRole('textbox', { name: '发送消息' })).toBeFocused();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/06-session-possible-390.png` });

    // 进入会话不清待办：回来还有这一条。
    await page.getByRole('button', { name: '返回' }).click();
    await expect(page.getByTestId('attention-item').filter({ hasText: '待办·问号结尾' })).toHaveCount(1);

    // 桌面：检查同一行入口在宽屏仍然成立。
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('attention-inbox')).toBeVisible();
    const desktopRow = page.getByTestId('attention-item').filter({ hasText: '待办·问号结尾' });
    await expect(desktopRow.getByTestId('attention-open').getByTestId('attention-phase')).toHaveText('可能在等你');
    const desktopOpen = await desktopRow.getByTestId('attention-open').boundingBox();
    expect(desktopOpen?.width ?? 0).toBeGreaterThan(240);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/07-inbox-row-1280.png` });

    // 桌面回归：同一组控件保持紧凑，不因为手机放大而变笨重。
    await page.goto(`/#/p/${project.id}/focus/${ids.answer}`);
    await expect(page.getByTestId('focus-header')).toBeVisible();
    const desktopBack = await boxOf(page.getByRole('button', { name: '返回' }), '桌面会话返回');
    const desktopSend = await boxOf(page.getByRole('button', { name: '发送', exact: true }), '桌面发送');
    expect(desktopBack.height).toBeLessThanOrEqual(37);
    expect(desktopSend.height).toBeLessThanOrEqual(29);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/09-session-targets-1280.png` });
  } finally {
    // 先停 Worker，再删它可能还在用的项目目录；最后把登记从 Hub 上撤掉。
    stopFakeWorker();
    rmSync(dir, { recursive: true, force: true });
    await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
  }
});
