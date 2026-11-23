import { test, expect, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { currentRun } from './run-id.ts';
import { loginByApi } from './login.ts';
import { chooseHubModel } from './hub-model.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';

test.afterAll(() => stopFakeWorker());

const RUN = currentRun();
const NAME = `picker-${RUN}`;
const MANAGED = `/tmp/agent-hub-workspaces/${NAME}`;
const SCRATCH = `/tmp/agent-hub-e2e-pick-${RUN}`;
const SLOW = `${SCRATCH}/slow`;
const SHOTS = process.env['SHOTS_DIR'] ?? '/tmp/opencode/shots';
const TASK = `选目录-${RUN}`;

// 目录选择器的宿主：开始任务时的「新建持久工作目录」。项目 / 任务走 API 建一次，
// 之后每段重新打开对话框（reload 是为了清掉上一段的对话框和选择器内部状态）。
const projects = new Map<string, { id: string; task: string }>();

async function openPickerFor(page: Page, width = 1280, height = 900, name = NAME, task = TASK) {
  await page.setViewportSize({ width, height });
  let project = projects.get(name);
  if (!project) {
    await page.goto('/');
    const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
    const headers = { origin: new URL(page.url()).origin, 'x-hub-csrf': csrf };
    const made = await page.request.post('/api/projects', { data: { name }, headers });
    expect(made.status(), await made.text()).toBe(201);
    const id = ((await made.json()) as { id: string }).id;
    const created = await page.request.post('/api/tasks', { data: { projectId: id, title: task }, headers });
    expect(created.ok(), await created.text()).toBe(true);
    project = { id, task };
    projects.set(name, project);
  }
  // 每次从首页重新进来（整页加载会把上一段的对话框和选择器状态都清掉）
  await page.goto('/');
  // 先让假 ACP 的 Worker 上线、把 agent 发布给 hub：画布里没有这个 agent 时，
  // 开始对话框的 agent 下拉里就没有 fakeacp，机器也选不出来。
  // 必须在取画布之前做——画布是先取数据再渲染，事后再起 Worker 不会补进已经拿到的快照。
  const fakeWorker = await ensureFakeWorker(page, new URL(page.url()).origin);
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/projects/${project.id}/canvas`);
        if (!response.ok()) return false;
        const canvas = (await response.json()) as { agents?: Array<{ id: string }> };
        return (canvas.agents ?? []).some((agent) => agent.id === FAKE_AGENT_ID);
      },
      { message: '画布里还没有假的 ACP agent', timeout: 20_000 }
    )
    .toBe(true);
  await page.goto(`/#/p/${project.id}/canvas`);
  await page.locator('.react-flow__node-task').filter({ hasText: project.task }).getByRole('button', { name: '＋ 会话' }).click();
  const panel = page.getByRole('dialog', { name: '开始会话' });
  await expect(panel).toBeVisible();
  const agentSection = panel.getByTestId('derive-agent-section');
  await expect(agentSection).toBeVisible();
  if (!(await panel.locator('#derive-agent').isVisible())) await agentSection.locator('summary').click();
  const agent = panel.getByRole('combobox', { name: 'agent' });
  await expect(agent.locator(`option[value="${FAKE_AGENT_ID}"]`)).toHaveCount(1);
  await agent.selectOption(FAKE_AGENT_ID);
  const workMode = panel.getByRole('radio', { name: /新建持久工作目录/ });
  await expect(workMode.first()).toBeVisible();
  const fakeLabel =
    ((await (await page.request.get('/api/workers')).json()) as Array<{ workerId: string; label: string }>).find(
      (worker) => worker.workerId === fakeWorker
    )?.label ?? '';
  const machineGroup = panel.getByRole('radiogroup', { name: '机器' });
  if ((await machineGroup.count()) > 0) {
    await expect(machineGroup.getByRole('radio', { checked: true })).toContainText(fakeLabel);
  }
  await workMode.first().click();
  const picker = page.getByLabel('目录选择器');
  await expect(picker).toBeVisible();
  await expect(picker.getByTestId('picker-machine')).toContainText(fakeLabel);
  return { panel, picker, label: fakeLabel };
}

const shownPath = (picker: Locator) => picker.getByTestId('picker-path');
/** 文件夹行按磁盘上的名字定位（git 标记会进可访问名，不用 role name 做精确匹配）。 */
const pickRow = (picker: Locator, name: string) =>
  picker.locator(`[data-picker-row][data-picker-name="${name}"]`);

/** 打开显式的「输入路径」——不打开时页面上没有路径输入框。 */
async function openPathEditor(picker: Locator) {
  await picker.getByRole('button', { name: '输入路径' }).click();
  const box = picker.getByRole('textbox', { name: '路径' });
  await expect(box).toBeVisible();
  await expect(box).toBeFocused();
  return box;
}

async function submitPath(picker: Locator, path: string) {
  const box = await openPathEditor(picker);
  await box.fill(path);
  await box.press('Enter');
}

async function goTo(picker: Locator, path: string) {
  await submitPath(picker, path);
  await expect(shownPath(picker)).toHaveText(path);
}

test('目录选择器：位置浏览、筛选、新建、显式路径、选定、手机安全区', async ({ page }) => {
  await loginByApi(page);
  mkdirSync(`${SCRATCH}/repo/.git`, { recursive: true });
  mkdirSync(`${SCRATCH}/plain`, { recursive: true });
  mkdirSync(`${SCRATCH}/empty`, { recursive: true });
  mkdirSync(`${SCRATCH}/.cache`, { recursive: true });
  mkdirSync(`${SLOW}/child`, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });

  const { panel, picker } = await openPickerFor(page);

  await test.step('桌面：机器上下文、显式路径输入、根边界与面包屑', async () => {
    // 桌面是一个独立的居中窗口，不再是塞在对话框里的 24rem 小面板
    const box = await picker.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThan(400);
    expect(box!.height).toBeLessThan(900 - 40);
    expect(box!.width).toBeGreaterThan(560);
    expect(box!.width).toBeLessThan(1280);
    expect(box!.x).toBeGreaterThan(0);
    expect(box!.y).toBeGreaterThan(0);

    await expect(picker.getByTestId('picker-machine')).toHaveText(/这台机器上|在 .+ 上/);
    // 打开时不把焦点塞进输入框（桌面放列表，手机什么都不聚焦）
    await expect(picker.locator('[aria-label="文件夹"]')).toBeFocused();

    // 旧的融合框（combobox + option 列表）不再存在
    await expect(picker.getByRole('combobox')).toHaveCount(0);
    await expect(picker.getByRole('option')).toHaveCount(0);

    // 直接输入 /tmp：到这台机器允许的根就停住
    const input = await openPathEditor(picker);
    await expect(picker.getByLabel('筛选当前文件夹')).not.toBeFocused();
    await input.fill('/tmp');
    await input.press('Enter');
    const nav = picker.getByRole('navigation', { name: '当前位置' });
    await expect(nav.getByRole('button')).toHaveCount(1);
    await expect(nav.getByRole('button', { name: 'tmp' })).toHaveAttribute('aria-current', 'page');
    const up = picker.getByRole('button', { name: '上一级' });
    await expect(up).toBeDisabled();
    await expect(up).toHaveAttribute('title', '已经到这台机器允许浏览的最上层');
    // 点「上一级」也不会走出 root
    await up.click({ force: true });
    await expect(shownPath(picker)).toHaveText('/tmp');

    // 输入完整路径进入任意一层；面包屑可以点回去
    await goTo(picker, SCRATCH);
    await expect(nav.getByRole('button')).toHaveCount(2);
    await expect(nav.getByRole('button').last()).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('button', { name: 'tmp' })).toBeVisible();
    await nav.getByRole('button', { name: 'tmp' }).click();
    await expect(shownPath(picker)).toHaveText('/tmp');
    await expect(up).toBeDisabled();
  });

  await test.step('一层层浏览：点行才进入、筛选不移动位置、隐藏项与 git 标记', async () => {
    await goTo(picker, SCRATCH);
    const rows = picker.locator('[data-picker-row]');
    await expect(pickRow(picker, 'repo')).toBeVisible();
    await expect(pickRow(picker, 'plain')).toBeVisible();
    await expect(pickRow(picker, 'empty')).toBeVisible();
    await expect(pickRow(picker, '.cache')).toHaveCount(0);
    await expect(picker.getByText('隐藏了 1 个点开头的文件夹')).toBeVisible();
    await expect(pickRow(picker, 'repo')).toContainText('⎇');
    await expect(pickRow(picker, 'plain')).not.toContainText('⎇');

    // 筛选只筛这一层：位置不变、也不替用户跳转
    const filter = picker.getByLabel('筛选当前文件夹');
    await filter.fill('pln');
    await expect(pickRow(picker, 'plain')).toBeVisible();
    await expect(pickRow(picker, 'repo')).toHaveCount(0);
    await expect(shownPath(picker)).toHaveText(SCRATCH);
    await expect(picker.getByRole('navigation', { name: '当前位置' }).getByRole('button').last()).toHaveText(
      SCRATCH.slice(SCRATCH.lastIndexOf('/') + 1)
    );
    await filter.press('Escape');
    await expect(filter).toHaveValue('');
    await expect(pickRow(picker, 'repo')).toBeVisible();

    // 点开头默认收起；点「显示」才出来；打「.」也能直接筛到
    const reveal = picker.getByRole('button', { name: '显示' });
    await expect(reveal).toHaveAttribute('aria-pressed', 'false');
    await reveal.click();
    await expect(pickRow(picker, '.cache')).toBeVisible();
    await expect(picker.getByRole('button', { name: '收起' })).toHaveAttribute('aria-pressed', 'true');
    await picker.getByRole('button', { name: '收起' }).click();
    await expect(pickRow(picker, '.cache')).toHaveCount(0);
    await filter.fill('.ca');
    await expect(pickRow(picker, '.cache')).toBeVisible();
    await filter.fill('');

    // 键盘只在有人用时才接管：列表里 ↑↓ 在行之间走
    await picker.locator('[aria-label="文件夹"]').focus();
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-picker-row') === true)).toBe(true);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-picker-row') === true)).toBe(true);
    await expect(rows).toHaveCount(4);

    await page.screenshot({ path: `${SHOTS}/picker-browse-desktop.png`, fullPage: false });

    // 点一行就是进去，不是选定
    await pickRow(picker, 'plain').click();
    await expect(shownPath(picker)).toHaveText(`${SCRATCH}/plain`);
    await expect(picker.getByText('这个文件夹里没有子文件夹。')).toBeVisible();
    await picker.getByRole('button', { name: '上一级' }).click();
    await expect(shownPath(picker)).toHaveText(SCRATCH);
  });

  await test.step('一层目录太多时只画前 200 行，筛选仍然搜得到全部', async () => {
    for (let index = 1; index <= 201; index++) {
      mkdirSync(`${SCRATCH}/many/d-${String(index).padStart(3, '0')}`, { recursive: true });
    }
    await goTo(picker, `${SCRATCH}/many`);
    await expect(picker.getByTestId('picker-truncated')).toHaveText('还有 1 个文件夹没显示，用上面的筛选找。');
    await expect(picker.locator('[data-picker-row]')).toHaveCount(200);
    // 只画 200 行，但筛选是在整层上做的：最老的那个被挤掉了也能筛出来
    await picker.getByLabel('筛选当前文件夹').fill('d-001');
    await expect(pickRow(picker, 'd-001')).toBeVisible();
    await picker.getByLabel('筛选当前文件夹').fill('');
    await picker.getByRole('button', { name: '上一级' }).click();
    await expect(shownPath(picker)).toHaveText(SCRATCH);
  });

  await test.step('新建：托管目录、名字校验、筛选里就地新建（服务端确认才进去）', async () => {
    await goTo(picker, '/tmp');
    const managedButton = picker.getByRole('button', {
      name: `创建项目文件夹 agent-hub-workspaces/${NAME}`
    });
    await expect(picker.getByTestId('picker-managed')).toBeVisible();
    await expect(managedButton).toBeVisible();
    await managedButton.click();
    // 机器上真的建目录再回列表，共享机器满载时这一趟会慢一些
    await expect(shownPath(picker)).toHaveText(MANAGED, { timeout: 15_000 });
    expect(existsSync(MANAGED)).toBe(true);
    await expect(picker.getByTestId('picker-managed')).toHaveCount(0, { timeout: 15_000 });

    mkdirSync(`${MANAGED}/sub`, { recursive: true });
    // 列表是上一次取数的快照：绕一圈让服务端确认 sub 已经在，同名校验才有依据
    await goTo(picker, '/tmp');
    await goTo(picker, MANAGED);
    await expect(pickRow(picker, 'sub')).toBeVisible({ timeout: 15_000 });
    const newFolder = picker.getByRole('button', { name: '新建文件夹', exact: true });
    const nameBox = picker.getByLabel('新文件夹名');

    // Esc 只关掉新建，不关选择器
    await newFolder.click();
    await expect(nameBox).toBeFocused();
    await nameBox.press('Escape');
    await expect(nameBox).toHaveCount(0);
    await expect(picker).toBeVisible();

    // 空名 / 斜杠 / 同名：就地报错，不写盘、不跳转
    await newFolder.click();
    await nameBox.fill('');
    await nameBox.press('Enter');
    await expect(picker.getByRole('alert')).toHaveText('名字不能为空');
    await nameBox.fill('a/b');
    await nameBox.press('Enter');
    await expect(picker.getByRole('alert')).toHaveText('名字里不能有斜杠');
    await nameBox.fill('sub');
    await nameBox.press('Enter');
    await expect(picker.getByRole('alert')).toHaveText('这里已经有同名文件夹');
    await expect(shownPath(picker)).toHaveText(MANAGED);
    await nameBox.press('Escape');

    // 建好之后用服务端返回的路径进去
    const made = `made-${RUN}`;
    await newFolder.click();
    await nameBox.fill(made);
    await nameBox.press('Enter');
    await expect(shownPath(picker)).toHaveText(`${MANAGED}/${made}`);
    expect(existsSync(`${MANAGED}/${made}`)).toBe(true);
    await picker.getByRole('button', { name: '上一级' }).click();

    // 筛到一个不存在的名字：列表里直接给「新建文件夹 “…”」，不误导成已存在
    const filter = picker.getByLabel('筛选当前文件夹');
    await filter.fill('from-filter');
    await expect(picker.getByText('没有匹配的文件夹。')).toBeVisible();
    const fromFilter = picker.getByRole('button', { name: '新建文件夹 “from-filter”' });
    await expect(fromFilter).toHaveCount(1);
    await fromFilter.click();
    await expect(nameBox).toHaveValue('from-filter');
    await expect(nameBox).toBeFocused();
    await nameBox.press('Enter');
    await expect(shownPath(picker)).toHaveText(`${MANAGED}/from-filter`);
    expect(existsSync(`${MANAGED}/from-filter`)).toBe(true);

    await page.screenshot({ path: `${SHOTS}/picker-created-desktop.png` });
  });

  await test.step('浏览/新建都不等于选定；底栏「选此文件夹」才写入并解锁「开始」', async () => {
    const start = panel.getByRole('button', { name: '开始' });
    await chooseHubModel(panel);
    await expect(start).toBeDisabled();
    await expect(panel.getByText('选一个空文件夹')).toBeVisible();
    await picker.getByRole('button', { name: '选此文件夹' }).click();
    await expect(picker).toHaveCount(0);
    await expect(start).toBeEnabled();
    await expect(panel).toContainText('from-filter');
  });

  await test.step('窄屏与桌面：目录窗口先给真实文件夹，选完回到表单不启动', async () => {
    const flow = `picker-flow-${RUN}`;
    const flowTask = `选目录2-${RUN}`;
    mkdirSync('/tmp/agent-hub-workspaces', { recursive: true });
    for (let index = 1; index <= 8; index++) {
      mkdirSync(`/tmp/agent-hub-workspaces/flow-${RUN}-${String(index).padStart(2, '0')}`, { recursive: true });
    }

    // 手机：390×680 的对话框里，目录选择是独立的全屏窗口，不再挤在表单的滚动区里
    const phone = await openPickerFor(page, 390, 680, flow, flowTask);
    const box = (await phone.picker.boundingBox())!;
    expect(Math.round(box.width)).toBe(390);
    expect(Math.round(box.height)).toBe(680);
    // 这个项目还没有托管文件夹，提示可以创建，但不挡在文件夹前面
    await expect(phone.picker.getByTestId('picker-managed')).toBeVisible();
    await expect(shownPath(phone.picker)).toHaveText('/tmp/agent-hub-workspaces');

    const rows = phone.picker.locator('[data-picker-row]');
    const list = phone.picker.locator('[aria-label="文件夹"]');
    const listBox = (await list.boundingBox())!;
    expect(listBox.height).toBeGreaterThan(300);

    const rowsInList = await rows.evaluateAll((elements) => {
      const container = elements[0]?.closest('[aria-label="文件夹"]');
      if (!container) return 0;
      const bounds = container.getBoundingClientRect();
      return elements.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
      }).length;
    });
    expect(rowsInList).toBeGreaterThanOrEqual(4);

    // 第一行完整露出（以前会被底栏切掉半行）
    const firstBox = (await rows.first().boundingBox())!;
    expect(firstBox.y).toBeGreaterThanOrEqual(listBox.y - 1);
    expect(firstBox.y + firstBox.height).toBeLessThanOrEqual(listBox.y + listBox.height + 1);

    // 最后一行滚得到
    const last = rows.last();
    await last.scrollIntoViewIfNeeded();
    const lastBox = (await last.boundingBox())!;
    expect(lastBox.y).toBeGreaterThanOrEqual(listBox.y - 1);
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(listBox.y + listBox.height + 1);

    // 当前位置完整可读（可触达地看得到，不靠 hover）
    const pathLine = shownPath(phone.picker);
    await expect(pathLine).toBeInViewport();
    await expect(pathLine).toHaveText('/tmp/agent-hub-workspaces');
    await expect(pathLine).toHaveAttribute('title', '/tmp/agent-hub-workspaces');

    await page.screenshot({ path: `${SHOTS}/picker-flow-390.png` });

    await chooseHubModel(phone.panel);
    const start = phone.panel.getByRole('button', { name: '开始', exact: true });
    await expect(start).toBeDisabled();
    await phone.picker.getByRole('button', { name: '选此文件夹' }).click();
    await expect(phone.picker).toHaveCount(0);
    await expect(start).toBeEnabled();
    await expect(phone.panel).toBeVisible();
    await expect(page).toHaveURL(/\/canvas$/);

    // 桌面：同一个独立窗口，居中而不是铺满；真实文件夹立刻占满列表
    const wide = await openPickerFor(page, 1280, 800, flow, flowTask);
    const wideBox = (await wide.picker.boundingBox())!;
    expect(wideBox.height).toBeGreaterThan(400);
    expect(wideBox.height).toBeLessThan(800 - 24);
    expect(wideBox.x).toBeGreaterThan(0);
    expect(wideBox.y).toBeGreaterThan(0);

    const wideRows = wide.picker.locator('[data-picker-row]');
    const wideList = (await wide.picker.locator('[aria-label="文件夹"]').boundingBox())!;
    expect(wideList.height).toBeGreaterThan(200);
    const wideVisible = await wideRows.evaluateAll((elements) => {
      const container = elements[0]?.closest('[aria-label="文件夹"]');
      if (!container) return 0;
      const bounds = container.getBoundingClientRect();
      return elements.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
      }).length;
    });
    expect(wideVisible).toBeGreaterThanOrEqual(5);
    await expect(shownPath(wide.picker)).toHaveText('/tmp/agent-hub-workspaces');
    await page.screenshot({ path: `${SHOTS}/picker-flow-desktop.png` });

    await wide.picker.getByRole('button', { name: '选此文件夹' }).click();
    await expect(wide.picker).toHaveCount(0);
    await expect(wide.panel.getByRole('button', { name: '开始' })).toBeVisible();
  });

  await test.step('机器上的 agent 探测失败/离线：机器和目录都留着，只是开始不了', async () => {
    const probeName = `picker-probe-${RUN}`;
    const probeTask = `选目录3-${RUN}`;
    const probeDir = `/tmp/agent-hub-workspaces/probe-${RUN}`;
    mkdirSync(probeDir, { recursive: true });

    const { panel, picker, label: fakeLabel } = await openPickerFor(page, 1280, 900, probeName, probeTask);
    await goTo(picker, probeDir);
    await picker.getByRole('button', { name: '选此文件夹' }).click();
    await expect(picker).toHaveCount(0);
    const start = panel.getByRole('button', { name: '开始', exact: true });
    const hint = panel.getByTestId('derive-start-hint');
    const machineBlocked = panel.getByTestId('machine-blocked');
    await expect(start).toBeEnabled({ timeout: 15_000 });
    await expect(panel).toContainText(probeDir);

    // 再把目录窗口打开，把「正在浏览的位置」也放在这条路径上，然后只改探测结果（目录仍从 Worker 取）
    await panel.getByRole('button', { name: '换一个' }).click();
    await expect(picker).toBeVisible();
    await goTo(picker, probeDir);

    await page.route('**/api/workers', async (route) => {
      const response = await route.fetch();
      const workers = (await response.json()) as Array<{
        state?: string;
        agentModels?: Array<{ agentId: string; readiness?: { state: string; reason?: string } }>;
      }>;
      for (const worker of workers) {
        for (const model of worker.agentModels ?? []) {
          if (model.agentId !== FAKE_AGENT_ID) continue;
          model.readiness = { state: 'unavailable', reason: '检测超时' };
        }
      }
      await route.fulfill({ response, json: workers });
    });

    // 5 秒一轮的机器状态：不可用时机器不清空、目录不丢，只是「开始」变灰并说原因
    await expect(hint).toContainText('用不了', { timeout: 20_000 });
    await expect(start).toBeDisabled();
    await expect(machineBlocked).toContainText('选好的机器和目录都保留');
    await expect(picker).toBeVisible();
    await expect(picker.getByTestId('picker-machine')).toContainText(fakeLabel);
    await expect(shownPath(picker)).toHaveText(probeDir);
    const machineGroup = panel.getByRole('radiogroup', { name: '机器' });
    if ((await machineGroup.count()) > 0) {
      await expect(machineGroup.getByRole('radio', { checked: true })).toContainText(fakeLabel);
    }

    // 恢复：机器没换、窗口还在原地，开始重新可用
    await page.unroute('**/api/workers');
    await expect(hint).toHaveCount(0, { timeout: 20_000 });
    await expect(start).toBeEnabled();
    await expect(machineBlocked).toHaveCount(0);
    await expect(shownPath(picker)).toHaveText(probeDir);

    // 真离线：目录也打不开了——旧列表顶不上去，也不允许对着旧目录按选定
    await page.route('**/api/workers', async (route) => {
      const response = await route.fetch();
      const workers = (await response.json()) as Array<{
        state?: string;
        agentModels?: Array<{ agentId: string; readiness?: { state: string; reason?: string } }>;
      }>;
      for (const worker of workers) {
        worker.state = 'offline';
        for (const model of worker.agentModels ?? []) {
          if (model.agentId !== FAKE_AGENT_ID) continue;
          model.readiness = { state: 'unavailable', reason: '检测超时' };
        }
      }
      await route.fulfill({ response, json: workers });
    });
    await expect(hint).toHaveText('这台机器不在线', { timeout: 20_000 });
    await expect(start).toBeDisabled();
    await expect(machineBlocked).toContainText('这台机器现在不在线');
    // 已经选好的目录留在表单里（不偷偷改成别的），只是不能开始
    await expect(panel).toContainText(probeDir);

    await picker.getByRole('button', { name: '关闭' }).click();
    await expect(picker).toHaveCount(0);
    await page.route('**/api/fs/directories*', (route) =>
      route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: '连接不到这台机器' } } })
    );
    await panel.getByRole('button', { name: '换一个' }).click();
    await expect(picker.getByText('打不开这个文件夹', { exact: false })).toBeVisible();
    await expect(picker.locator('[data-picker-row]')).toHaveCount(0);
    await expect(shownPath(picker)).toHaveText('');
    await expect(picker.getByRole('button', { name: '选此文件夹' })).toBeDisabled();
    await expect(picker.getByRole('button', { name: '新建文件夹', exact: true })).toBeDisabled();

    // 离线期间重试也不该把旧列表带回来
    await picker.getByRole('button', { name: '重试' }).click();
    await expect(picker.locator('[data-picker-row]')).toHaveCount(0);
    await expect(shownPath(picker)).toHaveText('');

    await page.unroute('**/api/workers');
    await page.unroute('**/api/fs/directories*');
    await expect(hint).toHaveCount(0, { timeout: 20_000 });
    await expect(start).toBeEnabled();
    await picker.getByRole('button', { name: '重试' }).click();
    await expect(picker.locator('[data-picker-row]').first()).toBeVisible();
  });

  await test.step('换路径时挂起请求：不沿用上一份列表，选定按钮保持禁用', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/fs/directories*', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('path') === SLOW) await held;
      await route.continue();
    });
    try {
      const reopened = await openPickerFor(page);
      await goTo(reopened.picker, SCRATCH);
      await expect(pickRow(reopened.picker, 'plain')).toBeVisible();

      await submitPath(reopened.picker, SLOW);
      // 请求还挂着：旧目录的行一条都不能剩，选按钮也不能拿旧位置充数
      await expect(reopened.picker.getByText('读取中…')).toBeVisible();
      await expect(reopened.picker.locator('[data-picker-row]')).toHaveCount(0);
      await expect(shownPath(reopened.picker)).toHaveText('');
      await expect(reopened.picker.getByRole('button', { name: '选此文件夹' })).toBeDisabled();

      release();
      await expect(pickRow(reopened.picker, 'child')).toBeVisible();
      await expect(shownPath(reopened.picker)).toHaveText(SLOW);
      await expect(pickRow(reopened.picker, 'plain')).toHaveCount(0);

      // Escape 关掉选择器（不吞键），不是悄悄选中
      await reopened.picker.getByRole('button', { name: '选此文件夹' }).focus();
      await page.keyboard.press('Escape');
      await expect(reopened.picker).toHaveCount(0);
      // Esc 只关这一层：底下的开始表单还在
      await expect(reopened.panel).toBeVisible();
    } finally {
      release();
      await page.unroute('**/api/fs/directories*');
    }
  });

  await test.step('同一路径缓存过、重新取数失败：旧列表立刻不可操作', async () => {
    const { picker: cached } = await openPickerFor(page);
    await goTo(cached, SCRATCH);
    await goTo(cached, '/tmp');

    await page.route('**/api/fs/directories*', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('path') === SCRATCH) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'unavailable', message: '列表暂时不可用' } })
        });
        return;
      }
      await route.continue();
    });
    try {
      await submitPath(cached, SCRATCH);
      await expect(cached.getByText(/打不开这个文件夹/)).toBeVisible();
      // 缓存里的旧行不能还留着让人点
      await expect(cached.locator('[data-picker-row]')).toHaveCount(0);
      await expect(cached.getByText('隐藏了 1 个点开头的文件夹')).toHaveCount(0);
      await expect(cached.getByRole('button', { name: '选此文件夹' })).toBeDisabled();
      await expect(cached.getByRole('button', { name: '新建文件夹' })).toBeDisabled();
    } finally {
      await page.unroute('**/api/fs/directories*');
    }
  });

  await test.step('打不开的路径：就地报错、重试、回到起点', async () => {
    const reopened = await openPickerFor(page);
    const missing = `${SCRATCH}/late`;
    const box = await openPathEditor(reopened.picker);
    await box.fill(missing);
    await box.press('Enter');
    await expect(reopened.picker.getByText(/打不开这个文件夹/)).toBeVisible();

    mkdirSync(`${missing}/inner`, { recursive: true });
    await reopened.picker.getByRole('button', { name: '重试' }).click();
    await expect(pickRow(reopened.picker, 'inner')).toBeVisible();

    const again = await openPathEditor(reopened.picker);
    await again.fill(`${SCRATCH}/also-missing`);
    await again.press('Enter');
    await expect(reopened.picker.getByText(/打不开这个文件夹/)).toBeVisible();
    await reopened.picker.getByTestId('picker-reset').click();
    await expect(reopened.picker.getByText(/打不开这个文件夹/)).toHaveCount(0);
    await expect(reopened.picker.getByRole('navigation', { name: '当前位置' })).toBeVisible();

    // 相对路径不当作位置提交
    const relative = await openPathEditor(reopened.picker);
    await relative.fill('tmp/not-absolute');
    await relative.press('Enter');
    await expect(reopened.picker.getByRole('alert')).toHaveText('要输入完整路径（以 / 开头）');
    await relative.fill('');
    await relative.press('Enter');
    await expect(reopened.picker.getByRole('alert')).toHaveText('请输入完整路径');
  });

  await test.step('手机 390：全屏、不自动弹键盘、44px、单滚动区、底栏在安全区里', async () => {
    const { picker: phone, panel: phonePanel } = await openPickerFor(page, 390, 844);
    const box = await phone.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.width)).toBe(390);
    expect(Math.round(box!.height)).toBe(844);

    // 没有自动聚焦输入框（不弹键盘），路径框也要显式打开才有
    expect(await page.evaluate(() => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? ''))).toBe(false);
    await expect(phone.getByRole('textbox', { name: '路径' })).toHaveCount(0);
    await expect(phone.getByLabel('筛选当前文件夹')).not.toBeFocused();

    // 手指能点：行和底栏按钮都至少 44px
    await goTo(phone, SCRATCH);
    const firstRow = await phone.locator('[data-picker-row]').first().boundingBox();
    expect(firstRow!.height).toBeGreaterThanOrEqual(44);
    const select = phone.getByRole('button', { name: '选此文件夹' });
    const newFolder = phone.getByRole('button', { name: '新建文件夹', exact: true });
    await expect(select).toBeInViewport();
    await expect(newFolder).toBeInViewport();
    expect((await select.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await newFolder.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    // 整个选择器只有一个纵向滚动区（列表自身），外壳不滚
    const shell = await phone.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight
    }));
    expect(shell.scrollHeight).toBeLessThanOrEqual(shell.clientHeight + 1);
    expect(await phone.locator('[aria-label="文件夹"]').evaluate((element) => getComputedStyle(element).overflowY)).toBe(
      'auto'
    );

    // 底部留出安全区，内容不被 Home 条压住
    const footer = phone.locator('footer');
    // 0.5rem 的兜底（13px 根字号 = 6.5px），有安全区时取更大值
    expect(parseFloat(await footer.evaluate((element) => getComputedStyle(element).paddingBottom))).toBeGreaterThanOrEqual(6);
    const footerBox = await footer.boundingBox();
    expect(Math.round(footerBox!.y + footerBox!.height)).toBeLessThanOrEqual(844);

    await page.screenshot({ path: `${SHOTS}/picker-mobile-390.png` });

    // 手机上点一行就进去（行按磁盘名字定位：git 标记会进可访问名），路径输入是显式动作
    await goTo(phone, SCRATCH);
    await pickRow(phone, 'repo').click();
    await expect(shownPath(phone)).toHaveText(`${SCRATCH}/repo`);
    await expect(phone.getByRole('button', { name: '上一级' })).toBeEnabled();
    await phone.getByRole('button', { name: '上一级' }).click();
    await expect(shownPath(phone)).toHaveText(SCRATCH);

    const box390 = await openPathEditor(phone);
    await box390.press('Escape');
    await expect(phone.getByRole('textbox', { name: '路径' })).toHaveCount(0);
    await expect(phone).toBeVisible();

    await phone.getByRole('button', { name: '关闭' }).click();
    await expect(phone).toHaveCount(0);
    await expect(phonePanel).toBeVisible();
  });

  await test.step('手机 320：底栏不溢出、按钮仍可点', async () => {
    const { picker: tiny } = await openPickerFor(page, 320, 700);
    const box = await tiny.boundingBox();
    expect(Math.round(box!.width)).toBe(320);
    expect(Math.round(box!.height)).toBe(700);
    expect(
      await tiny.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
    ).toBe(true);
    const select = tiny.getByRole('button', { name: '选此文件夹' });
    await expect(select).toBeInViewport();
    expect((await select.boundingBox())!.x + (await select.boundingBox())!.width).toBeLessThanOrEqual(320);
    await page.screenshot({ path: `${SHOTS}/picker-mobile-320.png` });
    await tiny.getByRole('button', { name: '关闭' }).click();
    await expect(tiny).toHaveCount(0);
  });

  await test.step('Tab 只在窗口里走；Esc 关掉后焦点回到原来的表单', async () => {
    const { picker: modal, panel: launcher } = await openPickerFor(page, 1280, 900);
    const inside = () => modal.evaluate((element) => element.contains(document.activeElement));

    await modal.getByLabel('筛选当前文件夹').focus();
    for (let i = 0; i < 24; i += 1) {
      await page.keyboard.press('Tab');
      expect(await inside(), `Tab #${i + 1} 跑到窗口外了`).toBe(true);
    }
    for (let i = 0; i < 24; i += 1) {
      await page.keyboard.press('Shift+Tab');
      expect(await inside(), `Shift+Tab #${i + 1} 跑到窗口外了`).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(launcher).toBeVisible();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
    expect(await launcher.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  });
});
