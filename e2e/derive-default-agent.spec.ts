import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';

type Worker = Record<string, unknown>;
const MODEL = 'fixture/model';

async function setup(page: Page, baseURL: string, initiallyReady: boolean, hubOnly = false, offline = false, splitMachines = false) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  const project = await (await page.request.post('/api/projects', { data: { name: `默认 agent ${Date.now()}` }, headers })).json() as { id: string };
  await page.request.post('/api/tasks', { data: { projectId: project.id, title: '默认 agent 任务' }, headers });
  let base: Worker | undefined;
  await expect.poll(async () => {
    const list = await (await page.request.get('/api/workers')).json() as Worker[];
    base = list.find((worker) => worker.state === 'online');
    return Boolean(base);
  }, { timeout: 60_000 }).toBe(true);
  let ids: string[] = [];
  await expect.poll(async () => {
    const canvas = await (await page.request.get(`/api/projects/${project.id}/canvas`)).json() as { agents: { id: string }[] };
    ids = canvas.agents.map((agent) => agent.id);
    return ids.length;
  }, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
  let ready = initiallyReady;
  let firstReady = false;
  let hubModel = false;
  await page.route('**/api/workers', (route) => route.fulfill({ json: splitMachines ? [
    { ...base, workerId: 'fixture-first', label: '原机器', state: 'online', origin: 'remote', agentIds: [ids[0]],
      agentModels: [{ agentId: ids[0], models: [MODEL], defaultModel: MODEL, readiness: { state: 'ready' } }] },
    { ...base, workerId: 'fixture-second', label: '另一台机器', state: 'online', origin: 'remote', agentIds: [ids[1]],
      agentModels: [{ agentId: ids[1], models: [MODEL], defaultModel: MODEL, readiness: { state: 'ready' } }] }
  ] : [{
    ...base, workerId: 'fixture-machine', label: '测试机器', state: offline ? 'offline' : 'online', origin: 'remote', agentIds: ids,
    agentModels: ids.map((agentId, index) => ({
      agentId, models: [MODEL], defaultModel: MODEL,
      ...(hubOnly ? { providers: ['openai-chat'], models: [], defaultModel: '', readiness: { state: 'unavailable', reason: '未配置模型' } } :
        ready ? { readiness: index === 0 && !firstReady ? { state: 'unavailable', reason: '未安装' } : { state: 'ready' } } : {})
    }))
  }] }));
  if (hubOnly) await page.route('**/api/providers/models?*', (route) => route.fulfill({ json: {
    providers: [{ slug: 'test', name: 'Test', protocol: 'openai-chat', models: hubModel ? [{ id: 'hub-test/model', label: 'model' }] : [] }], hidden: []
  } }));
  await page.route('**/api/agent-profiles', (route) => route.fulfill({ json: [{ id: 'fixture-profile', name: '测试预设', agentId: ids[0], model: 'profile/model', options: {} }] }));
  await page.goto(`/#/p/${project.id}/canvas`);
  await page.locator('.react-flow__node-task').filter({ hasText: '默认 agent 任务' }).getByRole('button', { name: '＋ 会话' }).click();
  const dialog = page.getByRole('dialog', { name: '开始会话' });
  await expect(dialog).toBeVisible();
  return { ids, dialog, probe: () => { ready = true; }, firstAvailable: () => { firstReady = true; }, addHubModel: () => { hubModel = true; } };
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px 默认 agent`, () => {
    test.use({ viewport });

    test('跳过不可用项；后续探测不抢走选择和目录', async ({ page, baseURL }) => {
      const { ids, dialog, firstAvailable } = await setup(page, baseURL!, true);
      const picker = dialog.locator('#derive-agent');
      await expect(picker).toHaveValue(ids[1]!);
      await expect(dialog).toContainText('测试机器');
      const workspace = dialog.getByTestId('ws-new-empty');
      await workspace.click();
      await expect(workspace).toHaveAttribute('aria-checked', 'true');
      await expect(dialog.getByRole('button', { name: '开始', exact: true })).toBeEnabled();
      firstAvailable();
      // worker 列表每五秒刷新；确认数据确实更新后仍保持当前选择。
      await expect.poll(async () => picker.locator(`option[value="${ids[0]}"]`).isDisabled(), { timeout: 15_000 }).toBe(false);
      await expect(picker).toHaveValue(ids[1]!);
      await expect(workspace).toHaveAttribute('aria-checked', 'true');
      if (viewport.width < 768 && (await dialog.getByTestId('derive-agent-section').getAttribute('open')) === null) {
        await dialog.getByTestId('derive-agent-section').locator('summary').click();
      }
      await picker.selectOption(ids[0]!);
      await expect(picker).toHaveValue(ids[0]!);
      await expect(workspace).toHaveAttribute('aria-checked', 'true');
    });

    test('未探测时不假选；晚到结果选可用项，手动和预设不被覆盖', async ({ page, baseURL }) => {
      const { ids, dialog, probe } = await setup(page, baseURL!, false);
      const picker = dialog.locator('#derive-agent');
      await expect(picker).toHaveValue('');
      await expect(dialog.getByTestId('derive-agent-pending')).toBeVisible();
      await expect(dialog.getByRole('button', { name: '开始', exact: true })).toBeDisabled();
      probe();
      await expect(picker).toHaveValue(ids[1]!, { timeout: 15_000 });
      await dialog.locator('#derive-profile').selectOption('fixture-profile');
      await expect(picker).toHaveValue(ids[0]!);
      await expect(dialog.locator('#derive-profile')).toHaveValue('fixture-profile');
      await expect(dialog).toContainText('这个配置的模型「profile/model」在当前机器/运行时不可用');
      await expect(dialog.getByRole('button', { name: '开始', exact: true })).toBeDisabled();
      await page.waitForTimeout(6000);
      await expect(picker).toHaveValue(ids[0]!);
      await expect(dialog.locator('#derive-profile')).toHaveValue('fixture-profile');
    });

    test('检测完成前手动选择不会被晚到结果替换', async ({ page, baseURL }) => {
      const { ids, dialog, probe } = await setup(page, baseURL!, false);
      const picker = dialog.locator('#derive-agent');
      await expect(picker).toHaveValue('');
      await picker.selectOption(ids[0]!);
      probe();
      await expect.poll(async () => picker.locator(`option[value="${ids[0]}"]`).isDisabled(), { timeout: 15_000 }).toBe(true);
      await expect(picker).toHaveValue(ids[0]!);
      await expect(dialog.getByRole('button', { name: '开始', exact: true })).toBeDisabled();
    });

    test('只有兼容的 Hub 模型实际存在时才可默认，仍须选择模型', async ({ page, baseURL }) => {
      const { ids, dialog, addHubModel } = await setup(page, baseURL!, true, true);
      const picker = dialog.locator('#derive-agent');
      await expect(picker).toHaveValue('');
      addHubModel();
      // 模型清单重新打开对话框时刷新；不能把空提供商当作有模型。
      await dialog.getByRole('button', { name: '取消' }).click();
      await page.reload();
      await page.locator('.react-flow__node-task').filter({ hasText: '默认 agent 任务' }).getByRole('button', { name: '＋ 会话' }).click();
      await expect(picker).toHaveValue(ids[0]!);
      await dialog.getByTestId('ws-new-empty').click();
      await expect(dialog.getByTestId('derive-start-hint')).toContainText('先在「模型」里选一个 Hub 模型');
      await expect(dialog.getByRole('button', { name: '开始', exact: true })).toBeDisabled();
    });

    test('全离线且没有默认 agent 时说明机器离线', async ({ page, baseURL }) => {
      const { dialog } = await setup(page, baseURL!, true, false, true);
      await expect(dialog.locator('#derive-agent')).toHaveValue('');
      await expect(dialog.getByTestId('machine-availability')).toHaveAttribute('data-kind', 'all-offline');
      await expect(dialog.getByTestId('machine-availability')).toContainText('现在没有在线的机器');
      await expect(dialog.getByTestId('derive-start-hint')).toContainText('先让一台机器上线');
      await expect(dialog.getByTestId('derive-switch-agent')).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: '开始', exact: true })).toBeDisabled();
    });

    test('换 agent 后保留原机器与目录，明确选择其他机器才切换', async ({ page, baseURL }) => {
      const { ids, dialog } = await setup(page, baseURL!, true, false, false, true);
      const picker = dialog.locator('#derive-agent');
      await expect(picker).toHaveValue(ids[0]!);
      const workspace = dialog.getByTestId('ws-new-empty');
      await workspace.click();
      await expect(workspace).toContainText('原机器');
      await expect(dialog.getByRole('button', { name: '开始', exact: true })).toBeEnabled();
      const section = dialog.getByTestId('derive-agent-section');
      if ((await section.getAttribute('open')) === null) await section.locator('summary').click();
      await picker.selectOption(ids[1]!);
      await expect(dialog.getByTestId('machine-selected-incompatible')).toContainText('原机器');
      await expect(workspace).toContainText('原机器');
      await expect(workspace).toHaveAttribute('aria-checked', 'true');
      await expect(dialog.getByTestId('derive-start-hint')).toContainText('这台机器没有');
      await expect(dialog.getByRole('button', { name: '开始', exact: true })).toBeDisabled();
      await dialog.getByTestId('machine-select-alternative').click();
      await expect(workspace).toContainText('另一台机器');
      await expect(workspace).toHaveAttribute('aria-checked', 'true');
      await expect(dialog.getByRole('button', { name: '开始', exact: true })).toBeEnabled();
    });
  });
}
