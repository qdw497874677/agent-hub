import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * 可观测页的 Agent 来源（第一版）。
 *
 * 后端 agent reader 还没合进来，所以这里只把 `/api/observe` 的返回包起来：
 * 登录、项目列表、路由都走真实应用。验证的是界面契约——来源选择、中文状态、
 * 筛选和刷新时不展示旧数据、截断/空/加载、详情树里「缺失」和「未记录」不混为一谈、390px 不裁表。
 */

const LIST = /\/api\/observe(?:\?|$)/;
const DETAIL = /\/api\/observe\/agent\/[^/?]+/;

type Item = {
  id: string; source: string; title: string; projectId: string | null; at: number;
  nativeState: string; nativeStateLabel: string; gap: string | null;
};
type Node = {
  id: string; name: string; kind: string; state: string | null; stateLabel: string | null;
  startedAt: number | null; endedAt: number | null; durationMs: number | null; durationLabel: string | null;
  parentId: string | null; links: { to: string; label: string }[];
  attrs: { key: string; value: string }[];
};

const item = (over: Partial<Item> & Pick<Item, 'id' | 'source' | 'title'>): Item => ({
  projectId: 'p-e2e', at: Date.now(), nativeState: 'queued', nativeStateLabel: '', gap: null, ...over
});

const node = (over: Partial<Node> & Pick<Node, 'id' | 'name' | 'kind'>): Node => ({
  state: null, stateLabel: null, startedAt: null, endedAt: null, durationMs: null, durationLabel: null,
  parentId: null, links: [], attrs: [], ...over
});

const agentItem = item({ id: 'agent:turn-1', source: 'agent', title: '修一下登录页', nativeState: 'queued' });
const connectorItem = item({
  id: 'connector:run-1', source: 'connector', title: '群里回写一次', nativeState: 'delivered',
  nativeStateLabel: '已送达', gap: '回写没有记录'
});

const listPayload = (items: Item[], truncated = false) => ({ enabled: true, truncated, viewer: 'user', scanLimit: 500, items });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function openObserve(page: Page): Promise<void> {
  await loginByApi(page);
  await page.goto('/#/observe');
}

test('默认把所有来源放在一起，状态说中文且不重复原生英文', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route(LIST, (route) => route.fulfill({ json: listPayload([agentItem, connectorItem]) }));
  await openObserve(page);

  await expect(page.getByTestId('observe-source').locator('option')).toHaveText(['全部', 'Agent 回合', '连接器']);
  await expect(page.getByTestId('observe-source')).toHaveValue('');
  await expect(page.getByTestId('observe-row')).toHaveCount(2);

  const agentRow = page.locator('[data-testid="observe-row"][data-source="agent"]');
  await expect(agentRow).toBeVisible();
  await expect(agentRow.locator('td').nth(1)).toHaveText('Agent 回合');
  await expect(agentRow.locator('td').nth(3)).toContainText('排队中');
  // 主列表不重复贴原生状态；data-state 只是给测试和样式用。
  await expect(agentRow).not.toContainText('queued');
  await expect(page.locator('[data-testid="observe-row"][data-source="connector"]').locator('td').nth(3)).toContainText('已送达');

  await expect(page.getByTestId('observe-mixed')).toContainText('Agent 回合 1');
  await expect(page.getByTestId('observe-mixed')).toContainText('连接器 1');
});

test('显式选 Agent 回合时把 source 传给接口，并只画 Agent 记录', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const requested: string[] = [];
  await page.route(LIST, async (route) => {
    const url = route.request().url();
    requested.push(url);
    const source = new URL(url).searchParams.get('source');
    await route.fulfill({ json: listPayload(source === 'agent' ? [agentItem] : [agentItem, connectorItem]) });
  });
  await openObserve(page);
  await expect(page.getByTestId('observe-row')).toHaveCount(2);

  await page.getByTestId('observe-source').selectOption('agent');
  await expect(page.getByTestId('observe-row')).toHaveCount(1);
  await expect(page.getByTestId('observe-row')).toHaveAttribute('data-source', 'agent');
  await expect(page.getByTestId('observe-mixed')).toHaveCount(0);
  await expect.poll(() => requested.some((url) => new URL(url).searchParams.get('source') === 'agent')).toBe(true);
});

test('换筛选时隐藏旧结果直到新结果到达', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  let hold = false;
  let payload = listPayload([item({ id: 'connector:run-1', source: 'connector', title: '第一次的结果' })]);
  const waiting: (() => void)[] = [];
  await page.route(LIST, async (route) => {
    if (hold) await new Promise<void>((release) => waiting.push(release));
    await route.fulfill({ json: payload });
  });
  await openObserve(page);
  await expect(page.getByTestId('observe-row')).toContainText('第一次的结果');

  hold = true;
  payload = listPayload([item({ id: 'agent:turn-1', source: 'agent', title: 'Agent 的新结果' })]);
  await page.getByTestId('observe-source').selectOption('agent');

  await expect(page.getByTestId('observe-loading')).toBeVisible();
  await expect(page.getByTestId('observe-row')).toHaveCount(0);
  await expect(page.getByTestId('observe-empty')).toHaveCount(0);

  hold = false;
  waiting.splice(0).forEach((release) => release());
  await expect(page.getByTestId('observe-loading')).toHaveCount(0);
  await expect(page.getByTestId('observe-row')).toContainText('Agent 的新结果');
  await expect(page.getByTestId('observe-row')).toHaveCount(1);
});

test('Agent 详情沿用现有树：父级缺失、未记录和无时间各说各的', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const turn = node({
    id: 'turn-1', name: 'Agent 回合', kind: 'turn', state: 'done', stateLabel: '完成',
    startedAt: Date.now() - 60_000, endedAt: Date.now() - 30_000, durationMs: 30_000, durationLabel: '记录跨度',
    attrs: [{ key: '会话', value: 's-e2e' }]
  });
  const reply = node({ id: 'reply-1', name: '等待回复', kind: 'reply', parentId: 'turn-1' });
  const legacyResult = node({ id: 'result-1', name: '回合结果', kind: 'sink', parentId: 'turn-1' });
  const missing = node({ id: 'trigger-1', name: '触发', kind: 'trigger', state: 'queued', stateLabel: '排队中', parentId: 'gone' });
  await page.route(LIST, (route) => route.fulfill({ json: listPayload([agentItem]) }));
  await page.route(DETAIL, (route) => route.fulfill({
    json: {
      enabled: true,
      trace: {
        id: 'turn-1', source: 'agent', headId: 'turn-1', title: '修一下登录页', projectId: 'p-e2e',
        externalUrl: null, nodes: [turn, reply, legacyResult, missing]
      },
      tree: {
        roots: [{ node: turn, children: [{ node: reply, children: [], links: [] }, { node: legacyResult, children: [], links: [] }], links: [] }],
        missingParent: [missing], unlinked: [], unrecorded: []
      }
    }
  }));
  await openObserve(page);

  await page.getByTestId('observe-row').getByRole('link', { name: '打开树' }).click();
  await expect(page).toHaveURL(/#\/observe\/agent\/turn-1/);
  await expect(page.getByTestId('observe-tree')).toBeVisible();
  await expect(page.getByTestId('observe-detail-source')).toHaveText('Agent 回合 · 只读');

  // 没有状态证据的待办节点写「未记录」，不是失败，也不是「缺失」。
  const pendingNode = page.getByTestId('observe-node').filter({ hasText: '等待回复' });
  await expect(pendingNode).toContainText('未记录');
  await expect(page.getByText('父级不在本页')).toBeVisible();
  await expect(page.getByTestId('observe-node').filter({ hasText: '触发' })).toContainText('排队中');

  await page.getByTestId('observe-node').filter({ hasText: '回合结果' }).click();
  await expect(page.getByTestId('observe-node-detail')).toContainText('回合结果');
  await expect(page.getByTestId('observe-node-detail')).not.toContainText('回写');

  await page.getByTestId('observe-node').filter({ hasText: '触发' }).click();
  const detail = page.getByTestId('observe-node-detail');
  await expect(detail).toContainText('排队中');
  await expect(detail).toContainText('触发');
  // 没有记录时间就画「—」，不拿当前时间凑时间线。
  await expect(detail).toContainText('开始 / 结束');
  await expect(detail).toContainText('— → —');
});

test('390px 下列表不横向裁切，桌面才显示的列在手机上让位', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(LIST, (route) => route.fulfill({ json: listPayload([agentItem, connectorItem]) }));
  await page.route(DETAIL, (route) => route.fulfill({
    json: {
      enabled: true,
      trace: {
        id: 'turn-1', source: 'agent', headId: 'turn-1', title: '修一下登录页', projectId: 'p-e2e',
        externalUrl: null, nodes: [node({ id: 'turn-1', name: 'Agent 回合', kind: 'turn', state: 'done', stateLabel: '完成' })]
      },
      tree: {
        roots: [{ node: node({ id: 'turn-1', name: 'Agent 回合', kind: 'turn', state: 'done', stateLabel: '完成' }), children: [], links: [] }],
        missingParent: [], unlinked: [], unrecorded: []
      }
    }
  }));
  await openObserve(page);

  await expect(page.getByTestId('observe-row')).toHaveCount(2);
  await expect(page.getByRole('columnheader', { name: '来源' })).toBeHidden();
  await expect(page.getByRole('columnheader', { name: '缺口' })).toBeHidden();
  // 手机上的来源信息落在标题下面，不丢。
  await expect(page.locator('[data-testid="observe-row"][data-source="agent"]').locator('td').nth(2)).toContainText('Agent 回合');

  const boxes = await page.getByTestId('observe-row').evaluateAll((rows) => rows.map((row) => {
    const rect = row.getBoundingClientRect();
    return { left: rect.left, right: rect.right };
  }));
  expect(boxes).toHaveLength(2);
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(390.5);
  }

  await page.getByTestId('observe-row').first().getByRole('link', { name: '打开树' }).click();
  await expect(page.getByTestId('observe-tree')).toBeVisible();
});

test('真被截断才提示，空结果按来源单独说', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  let payload = listPayload([agentItem], true);
  await page.route(LIST, (route) => route.fulfill({ json: payload }));
  await openObserve(page);

  await expect(page.getByTestId('observe-scan')).toHaveAttribute('data-truncated', '1');
  await expect(page.getByTestId('observe-scan')).toContainText('结果可能不完整');

  payload = listPayload([]);
  await page.getByTestId('observe-source').selectOption('agent');
  await expect(page.getByTestId('observe-empty')).toContainText('没有 Agent 回合记录。');
  await expect(page.getByTestId('observe-empty').getByRole('link', { name: '查看 Bot' })).toHaveCount(0);
  await expect(page.getByTestId('observe-scan')).toHaveCount(0);

  await page.getByTestId('observe-source').selectOption('connector');
  await expect(page.getByTestId('observe-empty').getByRole('link', { name: '查看 Bot' })).toBeVisible();
});

test('扫描截断且没有匹配时不声称没有记录', async ({ page }) => {
  await page.route(LIST, (route) => route.fulfill({ json: listPayload([], true) }));
  await openObserve(page);
  await expect(page.getByTestId('observe-empty')).toHaveText('已扫描的范围内没有匹配记录。');
  await expect(page.getByTestId('observe-scan')).toContainText('部分记录未被扫描或未显示');
  await expect(page.getByTestId('observe-scan')).not.toContainText('50');
});

for (const status of [403, 404]) {
  test(`详情刷新返回 ${status} 时隐藏之前的树与标题`, async ({ page }) => {
    const turn = node({ id: 'turn-1', name: '私有节点', kind: 'turn', state: 'delivered', stateLabel: '已送达' });
    let responseStatus = 200;
    await page.clock.install();
    await page.route(DETAIL, (route) => responseStatus !== 200
      ? route.fulfill({ status: responseStatus, json: { error: { code: 'unavailable', message: 'unavailable' } } })
      : route.fulfill({ json: {
        enabled: true,
        trace: { id: 'turn-1', source: 'agent', headId: 'turn-1', title: '私有标题', projectId: null, externalUrl: null, nodes: [turn] },
        tree: { roots: [{ node: turn, children: [], links: [] }], missingParent: [], unlinked: [], unrecorded: [] }
      } }));
    await loginByApi(page);
    await page.goto('/#/observe/agent/turn-1');
    await expect(page.getByTestId('observe-tree')).toContainText('私有节点');
    responseStatus = status;
    await page.clock.fastForward(11_000);
    await expect(page.getByTestId('observe-error')).toContainText('没有可查看的这条记录');
    await expect(page.getByTestId('observe-tree')).toHaveCount(0);
    await expect(page.getByTestId('observe-detail')).not.toContainText('私有标题');
    await expect(page.getByTestId('observe-detail')).not.toContainText('私有节点');
    responseStatus = 503;
    await page.getByTestId('observe-error').getByRole('button', { name: '重试' }).click();
    await expect(page.getByTestId('observe-error')).toContainText('加载失败');
    await expect(page.getByTestId('observe-tree')).toHaveCount(0);
    await expect(page.getByTestId('observe-detail')).not.toContainText('私有标题');
    await expect(page.getByTestId('observe-detail')).not.toContainText('私有节点');
    await page.goto('/#/observe');
    await page.goto('/#/observe/agent/turn-1');
    await expect(page.getByTestId('observe-error')).toContainText('加载失败');
    await expect(page.getByTestId('observe-detail')).not.toContainText('私有标题');
    await expect(page.getByTestId('observe-tree')).toHaveCount(0);
  });
}

test('列表刷新权限丢失时隐藏缓存行', async ({ page }) => {
  let status = 200;
  await page.clock.install();
  await page.route(LIST, (route) => status !== 200
    ? route.fulfill({ status, json: { error: { code: 'unavailable', message: 'unavailable' } } })
    : route.fulfill({ json: listPayload([agentItem]) }));
  await openObserve(page);
  await expect(page.getByTestId('observe-row')).toHaveCount(1);
  status = 403;
  await page.clock.fastForward(11_000);
  await expect(page.getByTestId('observe-error')).toContainText('无法查看运行记录');
  await expect(page.getByTestId('observe-row')).toHaveCount(0);
  await expect(page.getByTestId('observe-empty')).toHaveCount(0);
  status = 503;
  await page.getByTestId('observe-error').getByRole('button', { name: '重试' }).click();
  await expect(page.getByTestId('observe-error')).toContainText('刷新失败');
  await expect(page.getByTestId('observe-page')).not.toContainText(agentItem.title);
  await expect(page.getByTestId('observe-row')).toHaveCount(0);
  await page.getByTestId('observe-source').selectOption('agent');
  await expect(page.getByTestId('observe-error')).toContainText('刷新失败');
  await expect(page.getByTestId('observe-page')).not.toContainText(agentItem.title);
  await expect(page.getByRole('link', { name: '打开树' })).toHaveCount(0);
});

test('第一次加载显示加载态，不当成空结果', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const gate = deferred();
  await page.route(LIST, async (route) => {
    await gate.promise;
    await route.fulfill({ json: listPayload([agentItem]) });
  });
  await loginByApi(page);
  const navigated = page.goto('/#/observe');

  await expect(page.getByTestId('observe-loading')).toBeVisible();
  await expect(page.getByTestId('observe-empty')).toHaveCount(0);
  gate.resolve();
  await navigated;
  await expect(page.getByTestId('observe-row')).toHaveCount(1);
  await expect(page.getByTestId('observe-loading')).toHaveCount(0);
});
