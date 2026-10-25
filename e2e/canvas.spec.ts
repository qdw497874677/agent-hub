import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { currentRun } from './run-id.ts';
import { loginByApi } from './login.ts';

/**
 * 闭环的那条线：一个干净的浏览器，从零到「会话在卡片里真的跑起来了」。
 * 这是 docs/plan/mvp-plan.md §4 M6 的验收，也是定位 §8 成功判据的机器版。
 *
 * 用例不假设库里是空的：每次跑用带时间戳的项目名，断言只落在自己造出来的节点上。
 */
const RUN = currentRun();
const PROJECT_NAME = `e2e-${RUN}`;
const PROJECT_DIR = `/tmp/agent-hub-e2e-project-${RUN}`;
const TASK_TITLE = `第一条任务-${RUN}`;
const ECHO = `E2E-OK-${RUN}`;

const sessionNode = (page: Page) => page.locator('.react-flow__node-session');
const taskNode = (page: Page, title: string) => page.locator('.react-flow__node-task').filter({ hasText: title });

test.beforeAll(() => {
  mkdirSync(PROJECT_DIR, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await loginByApi(page);
});

test('从建项目到会话跑出第一段文字', async ({ page }) => {
  await page.goto('/');

  // 首页是门厅：左栏是「在哪儿干」，右栏是「接着干哪条」
  const nav = page.getByRole('navigation');
  await expect(nav.getByText('agent-hub')).toBeVisible();
  await expect(nav.getByText('项目', { exact: true })).toBeVisible();

  // M1：指一个本地目录（打字也行，点选也行——点选见下一条用例）
  await nav.getByTitle('新建项目').click();
  const panel = page.getByLabel('新建项目');
  await panel.getByLabel('目录', { exact: true }).fill(PROJECT_DIR);
  await panel.getByLabel('项目名').fill(PROJECT_NAME);
  await panel.getByRole('button', { name: '开始' }).click();

  // M1：画布出现
  await expect(page.getByRole('button', { name: '新建任务' })).toBeVisible();

  // M1：建任务
  await page.getByRole('button', { name: '新建任务' }).click();
  await page.getByRole('dialog', { name: '新建任务' }).getByLabel('标题').fill(TASK_TITLE);
  await page.getByRole('button', { name: '创建任务' }).click();
  await expect(taskNode(page, TASK_TITLE)).toContainText('0 个会话');

  // M2：从任务派生会话（任务卡上的「＋ 会话」；双击在自动化的零间隔点击下会落到重渲染的空档里）
  await taskNode(page, TASK_TITLE).getByRole('button', { name: '＋ 会话' }).click();
  await expect(page.getByText('会话从任务派生', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '开一条会话' }).click();

  // M2：卡片出现，并且就地就能说话——不必先打开专注对话
  await expect(sessionNode(page)).toHaveCount(1);
  const cardInput = sessionNode(page).getByLabel(/说一句/);
  // 用 fill 而不是逐字敲：卡片在 React Flow 节点里，0 延迟的合成按键会跑在画布重渲染前面而丢字
  // （人在键盘上打不到那个速度；粘贴或正常输入都走一个 input 事件）
  await cardInput.fill(`只回这段文字，不要用工具：${ECHO}`);
  // 冷启动时卡片会在「填好」和「按回车」之间被画布重新挂载一次：回车落在已卸下的旧输入框上就丢了，
  // 新输入框又按草稿把原话填回来（这就是偶发的「一直没输出」）。发出去的标志是输入框清空，没清空就再按一次。
  await expect(async () => {
    await cardInput.press('Enter');
    await expect(cardInput).toHaveValue('', { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });

  // 这里**不**断言「■ 出现过」：那一轮可能几百毫秒就跑完，而 toBeVisible 的轮询会正好错过它。
  // 圆点的两种身份由下面这条覆盖：跑完必须回到 ↑（停在 ■ 上才是真 bug）。
  // 只认模型真的吐出来的那个词，而且要落在卡片里（输入框里也有这个词，会假通过）
  await expect(sessionNode(page).getByText(ECHO)).toBeVisible({ timeout: 120_000 });
  await expect(sessionNode(page)).toContainText('完成');
  await expect(sessionNode(page).getByRole('button', { name: '发送' })).toBeVisible({ timeout: 120_000 });

  // 专注对话：进去看整屏，问与答同屏。
  // 这里点「对话」而不是双击：卡片中段的输入框会把双击当成选词，
  // 而双击卡片本体又依赖「两次点击落在同一个元素上」，在自动化的快速点击下不稳定。
  await sessionNode(page).getByRole('button', { name: '对话' }).click();
  // 收窄到对话记录里：输入框的「文本内容」就是它的 value，直接 getByText 会假通过
  await expect(page.getByRole('log', { name: '对话记录' })).toContainText(`只回这段文字，不要用工具：${ECHO}`);
  await expect(page.getByRole('button', { name: '← 返回' })).toBeVisible();
  // 专注对话里画布不在了：整屏只有这一条会话
  await expect(page.locator('.react-flow__node-session')).toHaveCount(0);
  await page.getByRole('button', { name: '← 返回' }).click();
  await expect(sessionNode(page)).toHaveCount(1);
});

test('目录可以点选，不必手打路径', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation').getByTitle('新建项目').click();

  // 打开就在这台机器的 root 里，面包屑在顶上
  const picker = page.getByLabel('目录选择器');
  await expect(picker.getByLabel('路径').getByRole('button').first()).toBeVisible();
  // 收窄到选择器里点：首页的项目行按钮，可访问名字里也带着这个路径字符串
  await picker.getByRole('button', { name: '输入路径' }).click();
  await picker.getByLabel('当前目录').fill('/tmp');
  await picker.getByLabel('当前目录').press('Enter');
  await picker.getByRole('button', { name: `agent-hub-e2e-project-${RUN}` }).click();

  await picker.getByRole('button', { name: '使用', exact: true }).click();
  const panel = page.getByLabel('新建项目');
  await expect(panel.getByLabel('目录', { exact: true })).toHaveValue(PROJECT_DIR);
  // 选完目录，项目名自动取最后一段
  await expect(panel.getByLabel('项目名')).toHaveValue(`agent-hub-e2e-project-${RUN}`);
  await panel.getByRole('button', { name: '取消' }).click();
});

test('刷新之后画布还在，布局被记住', async ({ page }) => {
  await page.goto('/');
  // 新浏览器没有 localStorage：从左栏回到自己刚建的那个项目
  await page.getByRole('navigation').getByRole('button', { name: new RegExp(PROJECT_NAME) }).click();
  await expect(sessionNode(page)).toHaveCount(1);
  await expect(taskNode(page, TASK_TITLE)).toContainText('1 个会话');

  const before = await sessionNode(page).boundingBox();
  await page.mouse.move(0, 0);
  await page.goto('/');
  const after = await sessionNode(page).boundingBox();
  expect(after?.x).toBeCloseTo(before?.x ?? -1, 0);
  expect(after?.y).toBeCloseTo(before?.y ?? -1, 0);
});

test('搜索能搜到会话里说过的话，列表能给画布降级', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation').getByText('项目', { exact: true })).toBeVisible();
  // 首页右栏直接列最近会话：点一条就进那条会话说话（「接着干」不是「先看画布」）
  await page.getByRole('button', { name: new RegExp(TASK_TITLE) }).first().click();
  const composer = page.getByLabel('发送消息');
  await expect(composer).toBeVisible();

  // S6.4 的前半截：切视图不丢草稿
  // 专注对话里也有一个「← 返回」，所以按精确名收窄到顶栏那个
  await page.getByRole('button', { name: '画布', exact: true }).click();
  await expect(sessionNode(page)).toHaveCount(1);
  await sessionNode(page).click();
  await expect(composer).toBeVisible();
  await composer.fill('这段草稿要活过视图切换');
  await page.getByRole('button', { name: '列表' }).click();
  await expect(page.getByRole('columnheader', { name: '任务' })).toBeVisible();
  // 专注对话里也有一个「← 返回」，所以按精确名收窄到顶栏那个
  await page.getByRole('button', { name: '画布', exact: true }).click();
  await expect(composer).toHaveValue('这段草稿要活过视图切换');

  // 搜索：用会话正文里的词命中，回车跳到那个节点
  await page.getByRole('button', { name: /搜索/ }).click();
  const palette = page.getByPlaceholder('搜任务标题，或者你记得的那句话');
  await palette.fill(ECHO);
  await expect(page.getByRole('button', { name: new RegExp(ECHO) }).first()).toBeVisible();
  await palette.press('Enter');
  await expect(sessionNode(page)).toHaveCount(1);
  await expect(page.locator('.react-flow__node-session').getByText(ECHO)).toBeVisible();

  // 列表视图：一行一个会话，点一行进那条会话
  await page.getByRole('button', { name: '列表' }).click();
  await page.getByRole('cell', { name: TASK_TITLE }).click();
  await expect(page.getByLabel('发送消息')).toBeVisible();
});

test('节点在线状态可见，任务的收尾与放弃是两个动作', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation').getByText('项目', { exact: true })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: new RegExp(PROJECT_NAME) }).click();
  await expect(sessionNode(page)).toHaveCount(1);

  // S1.2：「它挂了」和「我改坏了配置」要能分辨，所以节点状态是常驻可查的
  const badge = page.getByRole('button', { name: /^Worker：/ }).first();
  await badge.click();
  await expect(page.getByText(/\d+ 在线/)).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: '本机' }).first()).toBeVisible();
  await badge.click();

  // S4.2：收尾不是放弃。先收尾，卡片改口，再重开回到进行中
  await taskNode(page, TASK_TITLE).hover();
  await taskNode(page, TASK_TITLE).getByRole('button', { name: '收尾' }).click();
  await expect(taskNode(page, TASK_TITLE)).toContainText('已收尾');

  await taskNode(page, TASK_TITLE).hover();
  await taskNode(page, TASK_TITLE).getByRole('button', { name: '重开' }).click();
  await expect(taskNode(page, TASK_TITLE)).toContainText('进行中');
});

/**
 * 可调项：模型与思考强度都来自 agent 自己的回报（ADR 0007）。
 * 这条只验证「卡片上真的有得选，且改完不会回弹」——
 * 具体有哪些模型是 Pi 那边的事，测试不该写死一个模型名。
 */
test('会话卡片能改模型与思考强度，改完不回弹', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation').getByText('项目', { exact: true })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: new RegExp(PROJECT_NAME) }).click();
  await expect(sessionNode(page)).toHaveCount(1);

  const card = sessionNode(page);
  const model = card.getByLabel('模型');
  await expect(model).toBeVisible();
  // 清单是 agent 报的，所以它必须至少有一个候选
  expect(await model.locator('option').count()).toBeGreaterThan(0);

  const thinking = card.getByLabel('思考强度');
  if (await thinking.count()) {
    const before = await thinking.inputValue();
    const choices = await thinking.locator('option').evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value));
    const next = choices.find((value) => value !== before);
    if (next !== undefined) {
      await thinking.selectOption(next);
      // 回弹是这个功能最容易出的毛病：界面上写着新值，库里还是旧值
      await expect(thinking).toHaveValue(next as string, { timeout: 20_000 });
      await page.waitForTimeout(1500);
      await expect(thinking).toHaveValue(next as string);
    }
  }
});
