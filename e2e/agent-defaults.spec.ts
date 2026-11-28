import { expect, test, type Page } from '@playwright/test';
import { loginByApi, mailedLink, openRegistration } from './login.ts';
import { currentRun } from './run-id.ts';

/**
 * 团队设置 · 默认模型。
 *
 * 区块本身要「这台 hub 上出现过的运行时」才有内容，而 e2e 里本机 Worker 上报哪些运行时不稳，
 * 所以行内容一律用 `page.route` 顶掉 `/api/workers`（照 `e2e/session-mcp.spec.ts` 的做法），
 * 保存 / 刷新后仍在 这些真正要验的事走真实 PUT / GET。
 */

const FAKE_WORKERS = [
  {
    workerId: 'fake-worker-a',
    label: '假机器 A',
    origin: 'remote',
    state: 'online',
    agentIds: ['opencode', 'codex'],
    agentModels: [
      { agentId: 'opencode', models: ['go-deepseek-v4.1-flash', 'opencode-go/glm-5.3'], defaultModel: '' },
      // 离线机器：运行时照样算「出现过」，模型并集也要并进来
      { agentId: 'codex', models: [], defaultModel: '' }
    ]
  },
  {
    workerId: 'fake-worker-b',
    label: '假机器 B',
    origin: 'remote',
    state: 'offline',
    agentIds: ['pi'],
    agentModels: [{ agentId: 'pi', models: ['pi-default'], defaultModel: '' }]
  }
];

test.beforeAll(async ({ baseURL }) => openRegistration(baseURL));

/** 注册一个全新的账号（自建团队的主人），走真实的注册 → 验证 → 登录。 */
async function registerOwner(page: Page): Promise<string> {
  const email = `defaults-${currentRun()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const password = 'e2e defaults 123';
  await page.goto('/');
  await page.getByRole('tab', { name: '注册' }).click();
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码（至少 10 位）').fill(password);
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await expect(page.getByText('去邮箱看看')).toBeVisible();
  await page.goto(await mailedLink(email));
  await expect(page.getByText('邮箱已验证')).toBeVisible();
  await page.getByRole('button', { name: '进入 agent-hub' }).click();
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByText('还没有项目')).toBeVisible();
  return email;
}

/** 顶掉机器列表，保证区块里一定有那几个运行时。 */
async function fakeWorkers(page: Page, workers: unknown[] = FAKE_WORKERS): Promise<void> {
  await page.route('**/api/workers', (route) => route.fulfill({ json: workers }));
}

async function openTeam(page: Page): Promise<void> {
  if (await page.getByTestId('settings-surface').isVisible()) await page.getByTestId('settings-surface').getByRole('button', { name: '返回应用' }).click();
  const wide = await page.evaluate(() => window.matchMedia('(min-width: 1024px)').matches);
  const menu = page.getByTestId(wide ? 'shell-more' : 'global-menu-button');
  await expect(menu).toBeVisible();
  await menu.click();
  await page.getByTestId('shell-panel-more').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByTestId('settings-surface').getByRole('link', { name: '团队默认模型', exact: true }).click();
}

const row = (page: Page, runtime: string) => page.locator(`[data-testid="agent-defaults-row"][data-runtime="${runtime}"]`);

test('团队设置 · 默认模型：加一个运行时并存值 → 刷新后仍在 → 删掉 → 清空', async ({ page }) => {
  test.setTimeout(120_000);
  await fakeWorkers(page);
  await registerOwner(page);
  await openTeam(page);

  const section = page.getByTestId('agent-defaults');
  await expect(section).toBeVisible();
  await expect(section).toContainText('新会话没选模型时，按运行时用这里的默认；已有会话不受影响。');

  // 全新团队：还没有任何默认，只有「添加运行时」里那三个上报过的运行时
  await expect(page.getByTestId('agent-defaults-row')).toHaveCount(0);
  const add = page.getByTestId('agent-defaults-add');
  await expect(add).toBeVisible();
  await expect(add.locator('option')).toHaveCount(4); // 占位 + opencode / codex / pi
  await expect(add).toContainText('OpenCode');

  const save = page.getByTestId('agent-defaults-save');
  await expect(save).toBeDisabled();

  await add.selectOption('opencode');
  const opencode = row(page, 'opencode');
  await expect(opencode).toContainText('OpenCode');
  await expect(opencode.getByTestId('agent-defaults-input')).toHaveValue('');
  // 候选来自这台 hub 上报的模型并集：输入框仍可自由输入（hub 提供商模型可能没上报）
  await expect(opencode.locator('datalist option')).toHaveCount(2);
  await expect(opencode.getByTestId('agent-defaults-input')).toHaveAttribute('list', 'agent-defaults-models-opencode');
  // 加了行但还没填：不算脏，存不了
  await expect(save).toBeDisabled();

  await opencode.getByTestId('agent-defaults-input').fill('go-deepseek-v4.1-flash');
  await expect(save).toBeEnabled();
  await page.screenshot({ path: '/tmp/opencode/shots/team/agent-defaults-dirty.png' });
  await save.click();
  await expect(page.getByTestId('agent-defaults-note')).toHaveText('已保存');
  await expect(save).toBeDisabled();

  // 刷新后仍在（真的落到服务端了，不是本地 state）
  await page.reload();
  await openTeam(page);
  await expect(row(page, 'opencode').getByTestId('agent-defaults-input')).toHaveValue('go-deepseek-v4.1-flash');
  // 已配过的运行时不再出现在「添加运行时」里
  await expect(page.getByTestId('agent-defaults-add').locator('option[value="opencode"]')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/opencode/shots/team/agent-defaults-saved.png' });

  // 再加一个（离线机器上报的 Pi 也在候选里）
  await page.getByTestId('agent-defaults-add').selectOption('pi');
  await expect(row(page, 'pi')).toContainText('Pi');
  await row(page, 'pi').getByTestId('agent-defaults-input').fill('pi-default');
  await page.getByTestId('agent-defaults-save').click();
  await expect(page.getByTestId('agent-defaults-note')).toHaveText('已保存');
  await page.reload();
  await openTeam(page);
  await expect(row(page, 'pi').getByTestId('agent-defaults-input')).toHaveValue('pi-default');
  await expect(row(page, 'opencode').getByTestId('agent-defaults-input')).toHaveValue('go-deepseek-v4.1-flash');

  // 删掉一行：只留 opencode
  await row(page, 'pi').getByTestId('agent-defaults-remove').click();
  await expect(row(page, 'pi')).toHaveCount(0);
  await page.getByTestId('agent-defaults-save').click();
  await expect(page.getByTestId('agent-defaults-note')).toHaveText('已保存');
  await page.reload();
  await openTeam(page);
  await expect(row(page, 'pi')).toHaveCount(0);
  await expect(page.getByTestId('agent-defaults-add').locator('option[value="pi"]')).toHaveCount(1);

  // 清空：把最后一行的模型抹掉再存，行随之消失
  await row(page, 'opencode').getByTestId('agent-defaults-input').fill('');
  await expect(page.getByTestId('agent-defaults-save')).toBeEnabled();
  await page.getByTestId('agent-defaults-save').click();
  await expect(page.getByTestId('agent-defaults-note')).toHaveText('已保存');
  await page.reload();
  await openTeam(page);
  await expect(page.getByTestId('agent-defaults-row')).toHaveCount(0);

  // 走 API 再确认一次服务端确实是空的
  const read = await page.request.get('/api/team/agent-defaults');
  expect(read.status()).toBe(200);
  expect(((await read.json()) as { defaults: Record<string, string> }).defaults).toEqual({});
});

test('团队设置 · 默认模型：390px 上每行都不横向溢出', async ({ page }) => {
  test.setTimeout(120_000);
  await fakeWorkers(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await loginByApi(page);
  await page.goto('/');
  await openTeam(page);

  const section = page.getByTestId('agent-defaults');
  await expect(section).toBeVisible();
  await expect(section).toContainText('默认模型');

  // 已经配过就沿用，没配过就先加一行：只量布局，不改数据
  if ((await row(page, 'opencode').count()) === 0) await page.getByTestId('agent-defaults-add').selectOption('opencode');
  const opencode = row(page, 'opencode');
  await expect(opencode).toBeVisible();

  const sectionBox = await section.boundingBox();
  expect(sectionBox).not.toBeNull();
  expect(sectionBox!.x + sectionBox!.width).toBeLessThanOrEqual(390);
  const rowBox = await opencode.boundingBox();
  expect(rowBox).not.toBeNull();
  expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(390);
  const inputBox = await opencode.getByTestId('agent-defaults-input').boundingBox();
  expect(inputBox).not.toBeNull();
  expect(inputBox!.width).toBeGreaterThan(100);
  expect(inputBox!.x + inputBox!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '/tmp/opencode/shots/team/agent-defaults-390.png' });
});

test('团队设置 · 默认模型：一台机器都没上报时给出空状态', async ({ page }) => {
  test.setTimeout(120_000);
  await fakeWorkers(page, []);
  await registerOwner(page);
  await openTeam(page);
  await expect(page.getByTestId('agent-defaults')).toBeVisible();
  await expect(page.getByTestId('agent-defaults-empty')).toHaveText(
    '这台 hub 还没上报运行时；先在机器上装一个，再回来配默认模型。'
  );
  await expect(page.getByTestId('agent-defaults-row')).toHaveCount(0);
});
