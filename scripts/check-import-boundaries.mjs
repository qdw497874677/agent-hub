#!/usr/bin/env node
// 层间依赖表。apps 之间互不 import；packages 之间按表放行。
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;

// 允许：某包可以 import 的 workspace 包
const ALLOWED = new Map([
  ['@agent-hub/domain', []],
  ['@agent-hub/contract', ['@agent-hub/domain']],
  ['@agent-hub/storage-sqlite', ['@agent-hub/domain']],
  ['@agent-hub/node-gateway', ['@agent-hub/domain', '@agent-hub/contract']],
  ['@agent-hub/adapter-pi', ['@agent-hub/domain', '@agent-hub/contract']],
  ['@agent-hub/adapter-grok', ['@agent-hub/domain', '@agent-hub/contract']],
  ['@agent-hub/adapter-acp', ['@agent-hub/domain', '@agent-hub/contract']],
  ['@agent-hub/server', ['@agent-hub/domain', '@agent-hub/contract', '@agent-hub/storage-sqlite', '@agent-hub/node-gateway']],
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

const SPECIFIER = /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"](@agent-hub\/[^'"]+)['"]/g;

const failures = [];

for (const dir of ['packages', 'apps']) {
  const entries = await readdir(join(ROOT, dir), { withFileTypes: true });
  const dirs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (dir === 'packages' && e.name === 'adapters') {
      for (const a of await readdir(join(ROOT, 'packages/adapters'), { withFileTypes: true })) {
        if (a.isDirectory()) dirs.push(join(ROOT, 'packages/adapters', a.name));
      }
    } else dirs.push(join(ROOT, dir, e.name));
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
    for (const file of await walk(join(pkgDir, 'src'))) {
      const source = await readFile(file, 'utf8');
      for (const m of source.matchAll(SPECIFIER)) {
        const spec = m[1].split('/').slice(0, 2).join('/');
        if (allowed.includes(spec)) continue;
        const isApp = new RegExp(`^(${APP_PREFIX})$`).test(spec);
        failures.push(
          `${relative(ROOT, file)}: ${pkg.name} 不得 import "${spec}"${isApp ? '（apps 之间不可互相依赖）' : ''}`
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error('✗ import boundaries 失败：\n' + failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log('✓ import boundaries');
