import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * 运行面板（「开始会话」）在手机上的信息层级：
 * - 先看清「给哪条任务、在哪台机器上开」，常用工作目录方式和预设直接可见；
 * - 「更多创建方式」「agent 与模型」「资产」折叠成一行摘要，展开/收起时已选项不丢；
 * - 底部操作区常驻，390×430 这种矮视口（键盘弹出后）也点得到「开始」，缺什么就写在那儿。
 * 桌面保持原样：两个折叠块默认展开、不出现摘要行。
 *
 * 机器用 E2E 服务端自带的本机 worker（playwright.config 的 HUB_SPAWN_WORKER=1），
 * 与 hub-dialog / canvas 一样：只建项目和任务，不去动 worker 生命周期。
 */

async function openPanel(page: Page, baseURL: string): Promise<string> {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  const name = `运行面板 ${Date.now().toString(36)}`;
  const project = (await (await page.request.post('/api/projects', { data: { name }, headers })).json()) as { id: string };
  await page.request.post('/api/tasks', { data: { projectId: project.id, title: '面板里的任务' }, headers });
  await page.goto(`/#/p/${project.id}/canvas`);
  await page.locator('.react-flow__node-task').filter({ hasText: '面板里的任务' }).getByRole('button', { name: '＋ 会话' }).click();
  await page.getByRole('dialog', { name: '开始会话' }).waitFor();
  return name;
}

/** 抽屉是弹簧上来的：等它停稳再量位置，否则量到的是动画中间帧。 */
async function settleSheet(page: Page): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const sheet = document.querySelector('[data-testid="dialog-sheet"]');
        if (sheet === null) return true;
        const transform = getComputedStyle(sheet).transform;
        return transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)';
      })
    )
    .toBe(true);
}

test.describe('390×844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('先看到任务与机器，常用方式直接可见，高级项折叠且选择不丢', async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const projectName = await openPanel(page, baseURL!);
    const run = page.getByRole('dialog', { name: '开始会话' });

    // 1）目标摘要：任务名 + 项目/机器/agent，一眼看出这条会话为谁而开
    const target = page.getByTestId('derive-target');
    await expect(target).toBeVisible();
    await expect(target).toContainText('面板里的任务');
    await expect(target).toContainText(projectName);
    // 机器不是一句「自动」：写清在线 worker 的真实名字（这台是唯一可用机器）。
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ label: string; state: string; agentIds?: string[] }>;
    const online = workers.find((worker) => worker.state === 'online' && (worker.agentIds?.length ?? 0) > 0);
    if (online) await expect(target).toContainText(online.label);
    await expect(target).not.toContainText('自动');

    // 2）还没选目录时，缺什么就写在开始按钮边上（不是只给个灰按钮）
    await settleSheet(page);
    await expect(page.getByTestId('derive-start-hint')).toContainText('工作目录');

    // 3）三种工作目录方式都在明面上，逐个可达（不被折叠藏起来）
    for (const name of [/新建临时工作目录/, /新建隔离目录/, /新建持久工作目录/]) {
      const radio = run.getByRole('radio', { name });
      await radio.scrollIntoViewIfNeeded();
      await expect(radio).toBeVisible();
    }

    // 4）高级方式折进「更多创建方式」；选中项在展开/收起后都不丢
    const advanced = page.getByTestId('ws-advanced');
    await expect(advanced).toBeVisible();
    await expect(advanced.locator('summary')).toContainText('更多创建方式');
    await run.getByRole('radio', { name: /新建临时工作目录/ }).click();
    await expect(run.getByRole('radio', { name: /新建临时工作目录/ })).toHaveAttribute('aria-checked', 'true');
    await advanced.locator('summary').click();
    await expect(page.getByTestId('ws-advanced')).toHaveAttribute('open', '');
    await advanced.locator('summary').click();
    await expect(run.getByRole('radio', { name: /新建临时工作目录/ })).toHaveAttribute('aria-checked', 'true');

    // 5）agent/资产 折叠成摘要，摘要写着当前选择（不用展开就知道会用什么）
    const agent = page.getByTestId('derive-agent-section');
    const assets = page.getByTestId('derive-assets-section');
    await agent.scrollIntoViewIfNeeded();
    await expect(agent.locator('summary')).toContainText('agent 与模型');
    await expect(agent.locator('summary')).toContainText(' · ');
    // 资产默认收起：摘要写着这次带几项
    await expect(assets).not.toHaveAttribute('open', '');
    await expect(assets.locator('summary')).toContainText('资产');

    // 5）选好临时目录后提示消失、按钮可点，尺寸与位置都在屏内
    await settleSheet(page);
    const start = run.getByRole('button', { name: '开始', exact: true });
    await expect(start).toBeEnabled();
    await expect(page.getByTestId('derive-start-hint')).toHaveCount(0);
    const box = await start.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(43.5);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  });
});

test.describe('390×430（键盘弹出后的高度）', () => {
  test.use({ viewport: { width: 390, height: 430 } });

  test('底部操作区与禁用原因始终在视口里', async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    await openPanel(page, baseURL!);
    const run = page.getByRole('dialog', { name: '开始会话' });
    const hint = page.getByTestId('derive-start-hint');
    const start = run.getByRole('button', { name: '开始', exact: true });
    await settleSheet(page);
    await expect(hint).toBeVisible();
    await expect(start).toBeVisible();
    const box = await start.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(43.5);
    expect(box!.y + box!.height).toBeLessThanOrEqual(430);
    // 内容区是真在滚的，不是被底部挡死
    const scrollable = await page.evaluate(() => {
      const panel = document.querySelector('[role="dialog"]');
      const scroller = [...(panel?.querySelectorAll('div') ?? [])].find((el) => el.scrollHeight > el.clientHeight + 8);
      return scroller === undefined ? 0 : scroller.scrollHeight - scroller.clientHeight;
    });
    expect(scrollable).toBeGreaterThan(0);
  });
});

test.describe('1440×900', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('桌面不折叠：agent 与资产直接展开，没有摘要行', async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    await openPanel(page, baseURL!);
    const run = page.getByRole('dialog', { name: '开始会话' });
    await expect(page.getByTestId('derive-target')).toBeHidden();
    await expect(page.getByTestId('ws-advanced')).toHaveCount(0);
    const agent = page.getByTestId('derive-agent-section');
    await expect(agent).toHaveAttribute('open', '');
    await expect(run.locator('#derive-agent')).toBeVisible();
    await expect(run.locator('#derive-model')).toBeVisible();
    await expect(page.getByTestId('derive-assets-section')).toHaveAttribute('open', '');
    await expect(run.getByRole('button', { name: '开始', exact: true })).toBeVisible();
  });
});
