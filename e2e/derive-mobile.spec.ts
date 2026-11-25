import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';

const SHOTS = process.env['E2E_SCREENSHOTS'];

/**
 * 运行面板（「开始会话」）在手机上的信息层级：
 * - 顶上只说「给哪条任务、哪个项目开」，机器 / agent / 模型不在这儿重复；
 * - 机器行里别的机器不可用只留一行汇总（原因、处理办法、重新检测展开才看）；
 * - 常用工作目录方式直接可见、一行一个；「更多创建方式」折叠；
 * - 底部常驻：正在等什么 / 还缺什么 / 这次会开在哪，一个主按钮。
 *   390×430 这种矮视口（键盘弹出后）也点得到「开始」。
 * 桌面保持原样：两个折叠块默认展开、不出现复核行。
 *
 * 机器用 E2E 服务端自带的本机 worker（playwright.config 的 HUB_SPAWN_WORKER=1），
 * 与 hub-dialog / canvas 一样：只建项目和任务，不去动 worker 生命周期。
 * 多台机器 / 某台未安装的状态只有一个 worker 时造不出来，那两条用网络夹具替换
 * /api/workers 的响应：两台机器的就绪状态与模型都由夹具写明，不读宿主 Pi 的检测结果，
 * 只验「状态怎么摆」，不代表 agent 真能启动。
 */

type WorkerJson = Record<string, unknown>;

/** 登录 + 建项目和任务，先不导航：网络夹具要在页面发请求之前装好。 */
async function preparePanel(page: Page, baseURL: string): Promise<{ projectId: string; name: string }> {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  const name = `运行面板 ${Date.now().toString(36)}`;
  const project = (await (await page.request.post('/api/projects', { data: { name }, headers })).json()) as { id: string };
  await page.request.post('/api/tasks', { data: { projectId: project.id, title: '面板里的任务' }, headers });
  return { projectId: project.id, name };
}

async function openCanvas(page: Page, projectId: string): Promise<void> {
  await page.goto(`/#/p/${projectId}/canvas`);
  await page.locator('.react-flow__node-task').filter({ hasText: '面板里的任务' }).getByRole('button', { name: '＋ 会话' }).click();
  await page.getByRole('dialog', { name: '开始会话' }).waitFor();
}

async function openPanel(page: Page, baseURL: string): Promise<string> {
  const { projectId, name } = await preparePanel(page, baseURL);
  await openCanvas(page, projectId);
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

/** 只借真 worker 的「形状」（主机名、版本、能力、允许目录）：轮询到一台在线的就够。 */
async function waitForOnlineWorker(page: Page): Promise<WorkerJson> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const list = (await (await page.request.get('/api/workers')).json()) as WorkerJson[];
    const online = list.find((worker) => worker['state'] === 'online');
    if (online !== undefined) return online;
    await page.waitForTimeout(500);
  }
  throw new Error('40 秒内没有等到在线 worker，夹具装不起来');
}

const FIXTURE_MODEL = 'fixture/ready-model';
const FIXTURE_HINT = 'PATH 里找不到 opencode，可设 OPENCODE_COMMAND 指定路径';

/**
 * 两台机器：hub 本机那台 agent 未安装，qdw-nas 正常。真服务端只 spawn 一台 worker，
 * 造不出这个状态，所以只替换 /api/workers 的响应（项目 / 任务 / 目录仍是真的）。
 *
 * 两台机器的 readiness 与 models 全部由夹具写明，不复制宿主 worker 的检测结果：
 * 真机上的 Pi 可能「检测超时」，复制过来就是两台都不可用，用例会被环境带着跑。
 * agent 名单取自画布（对话框里能选的就是这些），保证每台机器都把每个 agent 覆盖到。
 */
async function fixtureTwoMachines(page: Page, projectId: string): Promise<void> {
  const base = await waitForOnlineWorker(page);
  const canvas = (await (await page.request.get(`/api/projects/${projectId}/canvas`)).json()) as {
    agents?: Array<{ id: string }>;
  };
  const agentIds = (canvas.agents ?? []).map((agent) => agent.id);
  if (agentIds.length === 0) throw new Error('画布里没有 agent，夹具不知道要给哪台机器写状态');

  const ready = agentIds.map((agentId) => ({
    agentId,
    models: [FIXTURE_MODEL],
    defaultModel: FIXTURE_MODEL,
    readiness: { state: 'ready' }
  }));
  const down = agentIds.map((agentId) => ({
    agentId,
    models: [] as string[],
    defaultModel: '',
    readiness: { state: 'unavailable', reason: '未安装', hint: FIXTURE_HINT }
  }));
  // 安装任务 / 卡顿原因 / 版本更新这些属于「那台真机此刻在干嘛」，别带进夹具
  const shape = Object.fromEntries(
    Object.entries(base).filter(([key]) => !['runtimeJob', 'reason', 'drift', 'update'].includes(key))
  );
  const payload: WorkerJson[] = [
    { ...shape, workerId: 'fixture-local', label: 'aliyun-server-本机', origin: 'local', agentIds, agentModels: down },
    { ...shape, workerId: 'fixture-nas', label: 'qdw-nas', origin: 'remote', agentIds, agentModels: ready }
  ];
  await page.route('**/api/workers', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) }));
}

test.describe('390×844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('先看到任务与机器，常用方式直接可见，高级项折叠且选择不丢', async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const projectName = await openPanel(page, baseURL!);
    const run = page.getByRole('dialog', { name: '开始会话' });

    // 1）目标摘要：任务名 + 项目名。机器 / agent / 模型不在这里重复，下面选择区和底部复核行会写。
    const target = page.getByTestId('derive-target');
    await expect(target).toBeVisible();
    await expect(target).toContainText('面板里的任务');
    await expect(target).toContainText(projectName);
    await expect(target).not.toContainText('自动');
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ label: string; state: string; agentIds?: string[] }>;
    const online = workers.find((worker) => worker.state === 'online' && (worker.agentIds?.length ?? 0) > 0);

    // 2）这台机器上默认的 agent 可能暂时用不了（没登录 / 检测超时）：换一个能用的，
    //    再去看工作目录。不然这条用例会被别的机器状态带着跑。
    const agentSection = page.getByTestId('derive-agent-section');
    const agentSelect = page.locator('#derive-agent');
    const wasOpen = (await agentSection.getAttribute('open')) !== null;
    if (!wasOpen) await agentSection.locator('summary').click();
    if ((await agentSelect.locator('option:checked').evaluate((el) => (el as HTMLOptionElement).disabled)) === true) {
      const usable = await agentSelect.locator('option:not([disabled])').first().getAttribute('value');
      if (usable !== null) await agentSelect.selectOption(usable);
    }
    if (!wasOpen) await agentSection.locator('summary').click();

    // 3）机器列表是异步到的：等唯一一台可用机器被选中，再说缺什么（不是只给个灰按钮）。
    //    冷启动时 worker 可能比页面晚十几秒，所以这里轮询，不赌一次渲染。
    await expect
      .poll(async () => (await page.getByTestId('derive-start-hint').innerText()).trim(), { timeout: 60_000 })
      .toContain('工作目录');

    // 4）三种工作目录方式都在明面上，逐个可达（不被折叠藏起来）
    for (const name of [/新建临时工作目录/, /新建隔离目录/, /新建持久工作目录/]) {
      const radio = run.getByRole('radio', { name });
      await radio.scrollIntoViewIfNeeded();
      await expect(radio).toBeVisible();
    }

    // 5）高级方式折进「更多创建方式」；选中项在展开/收起后都不丢
    const advanced = page.getByTestId('ws-advanced');
    await expect(advanced).toBeVisible();
    await expect(advanced.locator('summary')).toContainText('更多创建方式');
    await run.getByRole('radio', { name: /新建临时工作目录/ }).click();
    await expect(run.getByRole('radio', { name: /新建临时工作目录/ })).toHaveAttribute('aria-checked', 'true');
    await advanced.locator('summary').click();
    await expect(page.getByTestId('ws-advanced')).toHaveAttribute('open', '');
    await advanced.locator('summary').click();
    await expect(run.getByRole('radio', { name: /新建临时工作目录/ })).toHaveAttribute('aria-checked', 'true');

    // 6）agent/资产 折叠成摘要，摘要写着当前选择（不用展开就知道会用什么）
    const agent = page.getByTestId('derive-agent-section');
    const assets = page.getByTestId('derive-assets-section');
    await agent.scrollIntoViewIfNeeded();
    await expect(agent.locator('summary')).toContainText('agent 与模型');
    await expect(agent.locator('summary')).toContainText(' · ');
    // 资产默认收起：摘要写着这次带几项
    await expect(assets).not.toHaveAttribute('open', '');
    await expect(assets.locator('summary')).toContainText('资产');

    // 7）选好临时目录后提示消失、按钮可点；底部复核行念出机器 / 目录 / agent / 模型
    await settleSheet(page);
    const start = run.getByRole('button', { name: '开始', exact: true });
    await expect(start).toBeEnabled();
    await expect(page.getByTestId('derive-start-hint')).toHaveCount(0);
    const review = page.getByTestId('derive-review');
    await expect(review).toBeVisible();
    if (online) await expect(review).toContainText(online.label);
    await expect(review).toContainText('新建临时工作目录');
    await expect(review).toContainText(' · ');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/390-ready.png`, fullPage: false });
    const box = await start.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(43.5);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  });
});

test.describe('390×844 · 唯一在线机器但当前 agent 不可用（网络夹具）', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('换 Agent 展开并聚焦原选择器，随后机器、目录和开始都可用', async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const { projectId } = await preparePanel(page, baseURL!);
    const base = await waitForOnlineWorker(page);
    const canvas = (await (await page.request.get(`/api/projects/${projectId}/canvas`)).json()) as {
      agents?: Array<{ id: string; defaultModel?: string }>;
    };
    const agentIds = (canvas.agents ?? []).map((agent) => agent.id);
    // 至少要有两个 agent，才验证得了「换一个」；本机/假 ACP 环境都满足，不满足就明确说夹具缺料
    expect(agentIds.length, '画布里至少要有两个 agent 才能测换 Agent').toBeGreaterThanOrEqual(2);
    const downId = agentIds[0]!;
    const readyId = agentIds[1]!;
    const shape = Object.fromEntries(
      Object.entries(base).filter(([key]) => !['runtimeJob', 'reason', 'drift', 'update'].includes(key))
    );
    const models = agentIds.map((agentId) =>
      agentId === downId
        ? { agentId, models: [] as string[], defaultModel: '', readiness: { state: 'unavailable', reason: '未安装', hint: FIXTURE_HINT } }
        : { agentId, models: [FIXTURE_MODEL], defaultModel: FIXTURE_MODEL, readiness: { state: 'ready' } }
    );
    // 唯一一台在线机器：第一个 Agent 未安装，其余可用。
    // 只替换 /api/workers；项目、任务、目录仍是真服务端，不启动真模型。
    const worker = {
      ...shape,
      workerId: 'fixture-only-online',
      label: '唯一在线机',
      origin: 'remote',
      state: 'online',
      agentIds,
      agentModels: models
    };
    let readinessChanged = false;
    await page.route('**/api/workers', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([readinessChanged ? {
        ...worker,
        agentModels: models.map((model) => model.agentId === readyId
          ? { ...model, models: [], defaultModel: '', readiness: { state: 'unavailable', reason: '未安装', hint: FIXTURE_HINT } }
          : model.agentId === downId ? { ...model, models: [FIXTURE_MODEL], defaultModel: FIXTURE_MODEL, readiness: { state: 'ready' } } : model)
      } : worker])
    }));
    await openCanvas(page, projectId);
    const run = page.getByRole('dialog', { name: '开始会话' });
    await settleSheet(page);

    // 1）默认跳过不可用 Agent。明确选择后，探测变化不应偷偷替换它。
    const section = page.getByTestId('derive-agent-section');
    if ((await section.getAttribute('open')) === null) await section.locator('summary').click();
    const picker = page.locator('#derive-agent');
    await expect(picker).toHaveValue(readyId);
    await picker.dispatchEvent('change');
    readinessChanged = true;
    const message = page.getByTestId('machine-availability');
    await expect(message).toHaveAttribute('data-kind', 'agent-unavailable');
    await expect(picker).toHaveValue(readyId);
    await expect(run.locator('#derive-model')).toBeDisabled();
    await expect(message).toContainText('暂时都用不了');
    await expect(message).not.toContainText('现在没有在线的机器');
    const switchAgent = page.getByTestId('derive-switch-agent');
    await expect(switchAgent).toBeVisible();
    const switchBox = await switchAgent.boundingBox();
    expect(switchBox!.height).toBeGreaterThanOrEqual(43.5);
    const overflow = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const pageOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      return Math.max(pageOverflow, dialog === null ? 0 : dialog.scrollWidth - dialog.clientWidth);
    });
    expect(overflow).toBeLessThanOrEqual(1);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/390-agent-unavailable.png` });

    // 2）先收起手机上的 agent 折叠区，确认「换 Agent」会自己展开并聚焦选择器
    if ((await section.getAttribute('open')) !== null) await section.locator('summary').click();
    await expect(section).not.toHaveAttribute('open', '');
    await switchAgent.click();
    await expect(section).toHaveAttribute('open', '');
    await expect(picker).toBeFocused();
    await expect(picker).toBeVisible();

    // 3）手动换为另一已就绪的 Agent：机器可用，目录可选，开始可用。
    await picker.selectOption(downId);
    await expect(message).toHaveCount(0);
    await expect(run).toContainText('唯一在线机');
    await expect(page.getByTestId('derive-start-hint')).toContainText('工作目录');
    await run.getByRole('radio', { name: /新建临时工作目录/ }).click();
    const start = run.getByRole('button', { name: '开始', exact: true });
    await expect(start).toBeEnabled();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/390-agent-switched.png` });
  });

  test('唯一机器离线：说全离线，不给「换 Agent」', async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    const { projectId } = await preparePanel(page, baseURL!);
    const base = await waitForOnlineWorker(page);
    const canvas = (await (await page.request.get(`/api/projects/${projectId}/canvas`)).json()) as {
      agents?: Array<{ id: string }>;
    };
    const agentIds = (canvas.agents ?? []).map((agent) => agent.id);
    const shape = Object.fromEntries(
      Object.entries(base).filter(([key]) => !['runtimeJob', 'reason', 'drift', 'update'].includes(key))
    );
    const worker = {
      ...shape,
      workerId: 'fixture-offline',
      label: '离线机',
      origin: 'remote',
      state: 'offline',
      agentIds,
      agentModels: agentIds.map((agentId) => ({ agentId, models: [FIXTURE_MODEL], defaultModel: FIXTURE_MODEL, readiness: { state: 'ready' } }))
    };
    await page.route('**/api/workers', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([worker]) })
    );
    await openCanvas(page, projectId);
    await settleSheet(page);

    const message = page.getByTestId('machine-availability');
    await expect(message).toHaveAttribute('data-kind', 'all-offline');
    await expect(message).toContainText('现在没有在线的机器');
    // 全离线是机器问题，不是当前 agent 的问题：不要摆一个换了也没用的「换 Agent」
    await expect(page.getByTestId('derive-switch-agent')).toHaveCount(0);
    await expect(page.getByTestId('derive-start-hint')).toContainText('先让一台机器上线');
    const start = page.getByRole('dialog', { name: '开始会话' }).getByRole('button', { name: '开始', exact: true });
    await expect(start).toBeDisabled();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/390-all-offline.png` });
  });
});

test.describe('390×844 · 多台机器（网络夹具）', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('别的机器不可用只留一行汇总，展开才看原因', async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const { projectId } = await preparePanel(page, baseURL!);
    await fixtureTwoMachines(page, projectId);
    await openCanvas(page, projectId);
    const run = page.getByRole('dialog', { name: '开始会话' });
    await settleSheet(page);

    // 不可用的那台灰掉并带原因；能用的那台自动选中
    await expect(run.getByRole('radio', { name: /aliyun-server-本机/ })).toBeDisabled();
    await expect(run.getByRole('radio', { name: /qdw-nas/ })).toHaveAttribute('aria-checked', 'true');

    // 诊断收成一行入口：灰掉的格子已经写着原因，这里不再把同一句话念一遍；详情默认收着
    const status = run.getByTestId('harness-unavailable');
    await expect(status).toBeVisible();
    const summary = status.locator('summary');
    await expect(summary).toContainText('为什么用不了');
    await expect(summary).toContainText('aliyun-server-本机');
    await expect(summary).not.toContainText('未安装');
    await expect(status).not.toHaveAttribute('open', '');
    await expect(status.getByTestId('harness-unavailable-item')).toBeHidden();
    await expect(status.getByTestId('harness-recheck')).toBeHidden();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/390-two-machines.png` });

    // 选中机器的工作目录区就在这一行下面，不被警告挤走
    await expect(run.getByTestId('ws-none-linked')).toContainText('这台机器上还没有');
    await expect(run.getByRole('radio', { name: /新建临时工作目录/ })).toBeVisible();

    // 展开才看处理办法与「重新检测」
    await summary.click();
    await expect(status).toHaveAttribute('open', '');
    await expect(status.getByTestId('harness-unavailable-item')).toBeVisible();
    await expect(status.getByTestId('harness-unavailable-item')).toContainText('未安装');
    await expect(status).toContainText('OPENCODE_COMMAND');
    await expect(status.getByTestId('harness-recheck')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/390-two-machines-expanded.png` });

    // 收起后不挡路；主按钮始终在屏内
    await summary.click();
    await expect(status).not.toHaveAttribute('open', '');
    const start = run.getByRole('button', { name: '开始', exact: true });
    await expect(start).toBeVisible();
    await expect(page.getByTestId('derive-start-hint')).toContainText('工作目录');
  });
});

test.describe('320×568 · 多台机器（网络夹具）', () => {
  test.use({ viewport: { width: 320, height: 568 } });

  test('窄屏不横向溢出，状态一行，工作目录区和主按钮都在', async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const { projectId } = await preparePanel(page, baseURL!);
    await fixtureTwoMachines(page, projectId);
    await openCanvas(page, projectId);
    const run = page.getByRole('dialog', { name: '开始会话' });
    await settleSheet(page);

    const summary = run.getByTestId('harness-unavailable').locator('summary');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('为什么用不了');
    await expect(summary).toContainText('aliyun-server-本机');
    // 摘要是一行，不是一小段：单行高度（含内边距）不该超过两行
    const summaryBox = await summary.boundingBox();
    expect(summaryBox!.height).toBeLessThan(56);

    // 抽屉里的内容不横向溢出（长机器名截断，不撑破）
    const overflow = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return dialog === null ? 0 : dialog.scrollWidth - dialog.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(run.getByTestId('ws-none-linked')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/320-two-machines.png` });
    const start = run.getByRole('button', { name: '开始', exact: true });
    const box = await start.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(568);
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
    // 桌面没有手机上的复核行（机器 / agent 就在下面的选择区里）
    await expect(page.getByTestId('derive-review')).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-1440.png` });
  });
});
