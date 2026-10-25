#!/usr/bin/env node
// 层间依赖表。apps 之间互不 import；packages 之间按表放行。
// 另外三条：
//   1. 相对路径不得逃出本包（`../../other-pkg/src` 绕过了上面这张表）；
//   2. 每个非 node: 的 import 都得在本包 package.json 里声明（不靠根 node_modules 的提升碰巧能用）；
//   3. 包内文件之间不得有运行时循环 import（`import type` 会被擦除，不算）。
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
console.log('✓ import boundaries（层间表 / 相对路径 / package.json 声明 / 循环）');
