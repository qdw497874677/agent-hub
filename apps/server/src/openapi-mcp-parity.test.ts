/**
 * MCP 路由元数据的奇偶校验（parity）：工具的**唯一来源**是 routes.ts 每条路由上的第三参。
 * 这里守住四件事——没有漏登记的路由、工具名唯一、暴露面数量不悄悄变化、REST 文档与工具说明互相认得出。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveMcp, routes, type McpRouteExposure } from './openapi/routes.ts';
import { mcpTools, mcpToolsFor } from './openapi/mcp.ts';

type Entry = { method: string; tags?: readonly string[]; path: string; description?: string; mcp: McpRouteExposure };

const entries = Object.entries(routes) as unknown as [string, Entry][];

/** 期望暴露面：改接口 / 改登记时这组数字必须一起改（提醒别顺手扩大对外面积）。 */
const EXPECTED = {
  routes: 52,
  tools: 45,
  readOnly: 16,
  writes: 29,
  skips: ['health', 'me', 'setProjectDescription', 'setProjectRepo', 'stream', 'submitAssetRevision', 'workbenchSkill']
};

const TOOL_NAMES = [
  'activity',
  'append_task_log',
  'asset_assign',
  'asset_create',
  'asset_import',
  'asset_publish',
  'change_option',
  'create_workspace',
  'edit_task_log',
  'events',
  'fork_session',
  'get_asset',
  'get_project',
  'get_session',
  'get_task',
  'list_assets',
  'list_projects',
  'list_task_log',
  'list_tasks',
  'list_workers',
  'project_archive',
  'project_create',
  'project_repos',
  'project_update',
  'remove_workspace',
  'retry_workspace_setup',
  'session_cancel',
  'session_git_run',
  'session_git_state',
  'session_model',
  'session_reply',
  'session_settle',
  'session_start',
  'set_task_status',
  'set_task_summary',
  'sync_workspace',
  'task_create',
  'task_pull_requests',
  'workspace_changes',
  'workspace_group_add_member',
  'workspace_group_create',
  'workspace_group_get',
  'workspace_group_retry',
  'workspace_sweep',
  'workspace_sweep_records'
];

test('MCP 元数据：每条路由都有归属（meta / auto / 非空 skip），auto 只给 GET', () => {
  assert.equal(entries.length, EXPECTED.routes, '路由条数变了：同步改本节期望值');
  for (const [key, route] of entries) {
    const mcp = route.mcp;
    if (mcp === 'auto') {
      assert.equal(route.method, 'get', `${key}: 写操作必须显式声明 mcp 元数据，不能用 'auto'`);
      assert.ok(resolveMcp(key, route) !== null, `${key}: 'auto' 依赖 tags[0] 映射模块，这个 tag 没有对应模块`);
      continue;
    }
    if ('skip' in mcp) {
      assert.ok(typeof mcp.skip === 'string' && mcp.skip.trim() !== '', `${key}: 不暴露必须写原因`);
      assert.equal(resolveMcp(key, route), null, `${key}: skip 的路由不该产出工具`);
      continue;
    }
    assert.ok(['tasks', 'projects', 'sessions', 'assets', 'workers', 'workspaces'].includes(mcp.module), `${key}: module 不合法`);
    assert.ok(typeof mcp.need === 'string' && mcp.need.includes('.'), `${key}: 缺 need 权限点`);
    assert.ok(mcp.readOnly !== true || route.method === 'get', `${key}: GET 之外不该标只读`);
  }
});

test('MCP 元数据：skip 的条数与列表（不暴露要有据可查）', () => {
  const skips = entries.filter(([, route]) => route.mcp !== 'auto' && 'skip' in route.mcp).map(([key]) => key).sort();
  assert.deepEqual(skips, EXPECTED.skips);
});

test('MCP 工具：数量、唯一性、名字全表', () => {
  const tools = mcpToolsFor(undefined, { writes: true });
  assert.equal(tools.length, EXPECTED.tools);
  assert.equal(new Set(tools.map((t) => t.name)).size, EXPECTED.tools, '工具名必须唯一');
  assert.deepEqual(tools.map((t) => t.name).sort(), TOOL_NAMES);
  assert.equal(tools.filter((t) => t.readOnly).length, EXPECTED.readOnly);
  assert.equal(tools.filter((t) => !t.readOnly).length, EXPECTED.writes);
  // 只读闸门关掉时只剩只读工具
  assert.equal(mcpTools({ readOnly: true }).length, EXPECTED.readOnly);
});

test('skill 文档：references/tools.md 覆盖全部工具（改了工具要跑 npm run skill:tools）', () => {
  const doc = readFileSync(fileURLToPath(new URL('../../../skills/agent-hub-workbench/references/tools.md', import.meta.url)), 'utf8');
  const tools = mcpToolsFor(undefined, { writes: true });
  const missing = tools.filter((tool) => !doc.includes(`\`${tool.name}\``)).map((tool) => tool.name);
  assert.deepEqual(missing, [], '这些工具没写进 skill 文档，跑 npm run skill:tools 重新生成');
});

test('MCP 元数据：每个暴露的模块都能按模块筛出来', () => {
  const all = mcpToolsFor(undefined, { writes: true });
  for (const module of ['tasks', 'projects', 'sessions', 'assets', 'workers', 'workspaces'] as const) {
    const subset = mcpToolsFor(undefined, { writes: true, modules: new Set([module]) });
    assert.ok(subset.length > 0, `${module}: 一个工具都没有`);
    assert.ok(subset.every((t) => t.module === module));
    assert.equal(subset.length, all.filter((t) => t.module === module).length);
  }
});

test('双向可发现：工具说明点名 REST 路径，REST 描述点名工具名', () => {
  for (const [key, route] of entries) {
    const meta = resolveMcp(key, route);
    const tool = mcpToolsFor(undefined, { writes: true }).find((t) => t.name === (meta?.name ?? ''));
    if (meta === null) {
      assert.ok(!route.description?.includes('MCP 工具：'), `${key}: skip 的路由不该写工具名`);
      continue;
    }
    const rest = `${route.method.toUpperCase()} ${route.path}`;
    assert.ok(route.description?.includes(`MCP 工具：\`${meta.name}\``), `${key}: REST 描述里缺「MCP 工具：\`${meta.name}\`」`);
    assert.ok(tool, `${key}: ${meta.name} 没出现在工具清单里`);
    assert.match(tool.description, new RegExp(`（${rest}）`), `${key}: 工具说明里缺「（${rest}）」`);
    assert.ok(tool.description.includes(`对应 REST：${rest}`), `${key}: 工具说明里缺「对应 REST：${rest}」`);
    assert.ok(!tool.description.includes('MCP 工具：'), `${key}: 工具说明里不该自指「MCP 工具：…」`);
  }
});
