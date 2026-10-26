#!/usr/bin/env node
// 层间依赖表。apps 之间互不 import；packages 之间按表放行。
// 另外三条：
//   1. 相对路径不得逃出本包（`../../other-pkg/src` 绕过了上面这张表）；
//   2. 每个非 node: 的 import 都得在本包 package.json 里声明（不靠根 node_modules 的提升碰巧能用）；
//   3. 包内文件之间不得有运行时循环 import（`import type` 会被擦除，不算）；
//   4. 文件级端口 / 适配器规则（FILE_RULES）：RPC 端口与通道核心不碰任何传输，只依赖端口的适配器不得 import 传输库。
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url).pathname;

// 允许：某包可以 import 的 workspace 包
const ALLOWED = new Map([
  ['@agent-hub/domain', []],
  ['@agent-hub/contract', ['@agent-hub/domain']],
  ['@agent-hub/storage-sqlite', ['@agent-hub/domain']],
  ['@agent-hub/node-gateway', ['@agent-hub/domain', '@agent-hub/contract']],
  ['@agent-hub/adapter-pi', ['@agent-hub/domain', '@agent-hub/contract']],
  ['@agent-hub/adapter-grok', ['@agent-hub/domain', '@agent-hub/contract', '@agent-hub/adapter-acp']],
  ['@agent-hub/adapter-acp', ['@agent-hub/domain', '@agent-hub/contract']],
  ['@agent-hub/adapter-accounts', ['@agent-hub/domain']],
  ['@agent-hub/server', ['@agent-hub/domain', '@agent-hub/contract', '@agent-hub/storage-sqlite', '@agent-hub/node-gateway', '@agent-hub/adapter-accounts']],
  ['@agent-hub/worker', ['@agent-hub/domain', '@agent-hub/contract', '@agent-hub/node-gateway', '@agent-hub/adapter-pi', '@agent-hub/adapter-acp', '@agent-hub/adapter-grok']],
  ['@agent-hub/web', ['@agent-hub/contract']]
]);

// 文件级规则：路径（相对仓库根，正则）→ 只许 import 的模块（正则）或禁止 import 的模块。
// RPC 是端口（contract/src/rpc），WebSocket 只是一个适配器（server-gateway / worker-link / worker-enroll）。
const FILE_RULES = [
  {
    files: /^packages\/contract\/src\/rpc\/(?!.*\.test\.ts$)/,
    only: /^(\.|zod$)/,
    why: 'RPC 端口与通道核心与传输无关：只许相对路径和 zod'
  },
  {
    files: /^packages\/node-gateway\/src\/(mcp-endpoint|worker-fs-rpc)\.ts$/,
    forbid: /^(ws|@agent-hub\/node-gateway)$|server-gateway|worker-link/,
    why: '只依赖 RpcPort 的适配器，不得碰 WebSocket'
  },
  {
    files: /^apps\/server\/src\/(mcp-relay|mcp-server|worker-enroll)\.ts$/,
    forbid: /^(ws|hono|@agent-hub\/node-gateway|@agent-hub\/storage-sqlite)$/,
    why: 'hub 侧中转 / 接入只依赖端口和领域用例，不得碰传输或存储'
  },
  {
    files: /^packages\/domain\/src\//,
    forbid: /^(ws|zod|hono|@modelcontextprotocol\/sdk)$/,
    why: '领域与传输无关'
  }
];

const APP_PREFIX = '@agent-hub/worker|@agent-hub/server|@agent-hub/web';

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

// from 形式、纯副作用 import、动态 import()
const SPECIFIER =
  /(?:^|\n)\s*(import\s+type\b|export\s+type\b|import|export)[^'"\n;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function* importsOf(source) {
  for (const m of source.matchAll(SPECIFIER)) {
    const spec = m[2] ?? m[3] ?? m[4];
    const typeOnly = m[1] !== undefined && /type$/.test(m[1]);
    yield { spec, typeOnly };
  }
}

/** `@scope/name/sub` → `@scope/name`，`name/sub` → `name`。 */
const packageOf = (spec) => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');

function resolveRelative(file, spec) {
  const base = resolve(dirname(file), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && candidate.match(/\.tsx?$/)) return candidate;
  }
  return null;
}

/** 找一条循环（DFS 三色），返回环上的文件；没有就 null。 */
function findCycle(graph) {
  const color = new Map();
  const stack = [];
  const visit = (node) => {
    color.set(node, 'grey');
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (color.get(next) === 'grey') return [...stack.slice(stack.indexOf(next)), next];
      if (!color.has(next)) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    color.set(node, 'black');
    return null;
  };
  for (const node of graph.keys()) {
    if (color.has(node)) continue;
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

const failures = [];

const dirs = [];
for (const dir of ['packages', 'apps']) {
  for (const e of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (dir === 'packages' && e.name === 'adapters') {
      for (const a of await readdir(join(ROOT, 'packages/adapters'), { withFileTypes: true })) {
        if (a.isDirectory()) dirs.push(join(ROOT, 'packages/adapters', a.name));
      }
    } else dirs.push(join(ROOT, dir, e.name));
  }
}

for (const pkgDir of dirs) {
  let pkg;
  try {
    pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  const allowed = ALLOWED.get(pkg.name);
  if (!allowed) {
    failures.push(`${relative(ROOT, pkgDir)}: 包名 "${pkg.name}" 不在层间依赖表里，先把它加进 scripts/check-import-boundaries.mjs`);
    continue;
  }
  const declared = new Set(
    ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((field) => Object.keys(pkg[field] ?? {}))
  );
  const graph = new Map();

  for (const file of await walk(join(pkgDir, 'src'))) {
    const source = await readFile(file, 'utf8');
    const where = relative(ROOT, file);
    const edges = [];
    graph.set(file, edges);

    for (const { spec, typeOnly } of importsOf(source)) {
      for (const rule of FILE_RULES) {
        if (!rule.files.test(where)) continue;
        const bare = spec.startsWith('.') ? spec : packageOf(spec);
        if ((rule.only && !rule.only.test(bare)) || (rule.forbid && (rule.forbid.test(bare) || rule.forbid.test(spec)))) {
          failures.push(`${where}: 不得 import "${spec}"（${rule.why}）`);
        }
      }
      if (spec.startsWith('node:')) continue;

      if (spec.startsWith('.')) {
        const target = resolve(dirname(file), spec);
        if (target !== pkgDir && !target.startsWith(pkgDir + sep)) {
          failures.push(`${where}: 相对路径 "${spec}" 逃出了 ${pkg.name}，跨包请用包名 import`);
          continue;
        }
        const resolved = resolveRelative(file, spec);
        if (resolved && !typeOnly) edges.push(resolved);
        continue;
      }

      const name = packageOf(spec);
      if (name === pkg.name) continue;
      if (name.startsWith('@agent-hub/') && !allowed.includes(name)) {
        const isApp = new RegExp(`^(${APP_PREFIX})$`).test(name);
        failures.push(`${where}: ${pkg.name} 不得 import "${name}"${isApp ? '（apps 之间不可互相依赖）' : ''}`);
        continue;
      }
      if (!declared.has(name)) {
        failures.push(`${where}: import 了 "${name}"，但 ${relative(ROOT, pkgDir)}/package.json 没有声明它`);
      }
    }
  }

  const cycle = findCycle(graph);
  if (cycle) failures.push(`${pkg.name}: 运行时循环 import：${cycle.map((f) => relative(pkgDir, f)).join(' → ')}`);
}

if (failures.length > 0) {
  console.error('✗ import boundaries 失败：\n' + failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log('✓ import boundaries（层间表 / 相对路径 / package.json 声明 / 循环 / 端口-适配器文件规则）');
