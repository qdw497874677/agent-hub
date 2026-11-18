/**
 * 生成外部 agent 用的 skill 工具参考：skills/agent-hub-workbench/references/tools.md
 *
 * 工具清单直接来自 `apps/server/src/openapi/routes.ts` 的 MCP 元数据（和 `/openapi/v1/mcp`
 * 的 tools/list 同源），所以加了路由忘了写文档不会发生：跑 `npm run skill:tools` 即可。
 * parity 测试（apps/server/src/openapi-mcp-parity.test.ts）会检查这个文件覆盖了全部工具名。
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveMcp, routes } from '../apps/server/src/openapi/routes.ts';

const out = fileURLToPath(new URL('../skills/agent-hub-workbench/references/tools.md', import.meta.url));

interface Field {
  readonly name: string;
  readonly optional: boolean;
}

const shapeOf = (value: unknown): Record<string, unknown> | null => {
  const json = (value as { content?: Record<string, { schema?: unknown }> } | null)?.content?.['application/json'];
  const inner = json?.schema ?? (value as { schema?: unknown } | null)?.schema ?? value;
  const raw = (inner as { shape?: unknown; _def?: { shape?: unknown } } | null);
  const shape = raw?.shape ?? raw?._def?.shape;
  if (typeof shape === 'function') return (shape as () => Record<string, unknown>)();
  return (shape as Record<string, unknown> | undefined) ?? null;
};

const fieldsOf = (schema: unknown): Field[] => {
  const shape = shapeOf(schema);
  if (shape === null) return [];
  return Object.entries(shape).map(([name, value]) => ({
    name,
    optional: (value as { isOptional?: () => boolean } | null)?.isOptional?.() === true
  }));
};

interface Row {
  readonly tool: string;
  readonly kind: '读' | '写';
  readonly scope: string;
  readonly rest: string;
  readonly fields: readonly string[];
  readonly summary: string;
  readonly idempotent: boolean;
}

const rows: Row[] = [];
for (const [key, route] of Object.entries(routes)) {
  const meta = resolveMcp(key, route as never);
  if (meta === null) continue;
  const request = (route as { request?: Record<string, unknown> }).request ?? {};
  const fields: string[] = [];
  for (const part of ['params', 'query', 'body'] as const) {
    for (const field of fieldsOf(request[part])) {
      const label = part === 'body' ? field.name : `${field.name}`;
      fields.push(field.optional ? `${label}?` : label);
    }
  }
  rows.push({
    tool: meta.name,
    kind: meta.readOnly ? '读' : '写',
    scope: meta.scope ?? meta.need,
    rest: route.path.replace('/openapi/v1', ''),
    fields,
    summary: route.summary ?? '',
    idempotent: meta.idempotent
  });
}

const cell = (value: string) => value.replaceAll('|', '\\|');
const readCount = rows.filter((row) => row.kind === '读').length;
const lines = [
  '# 工具清单（自动生成）',
  '',
  '由 `npm run skill:tools` 从 `apps/server/src/openapi/routes.ts` 的 MCP 元数据生成，等于 `tools/list` 的结果。',
  `当前 ${rows.length} 个：只读 ${readCount}，写 ${rows.length - readCount}。`,
  '',
  '「参数」只列名字，`?` 表示可选；具体类型和必填组合见 `SKILL.md` 与 `<hub>/openapi/v1/openapi.json`。',
  '',
  '| 工具 | 读/写 | 需要 scope | REST 路由 | 参数 | 说明 |',
  '| --- | --- | --- | --- | --- | --- |',
  ...rows.map((row) =>
    `| \`${row.tool}\` | ${row.kind} | \`${row.scope}\` | \`${row.rest}\` | ${cell(row.fields.join(', ')) || '—'} | ${cell(row.summary)}${row.idempotent ? '（写工具，要 `clientRequestId`）' : ''} |`
  ),
  '',
  '## 写工具的重试约定',
  '',
  '带 `（要 clientRequestId）` 的工具，每次**逻辑上的**调用都必须带一个稳定的 `clientRequestId`；',
  '超时重试要复用同一个值，24 小时内返回第一次的结果。不要每次重试生成新的 id —— 那等于重复下单。',
  ''
];
writeFileSync(out, lines.join('\n'));
console.log(`skills/agent-hub-workbench/references/tools.md：${rows.length} 个工具（读 ${readCount}）`);
