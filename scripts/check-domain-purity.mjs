#!/usr/bin/env node
// 依赖方向唯一：domain 不认识任何东西。
// 规则：domain/package.json 无 dependencies；domain/** 的 import 只允许相对路径或白名单 node: 模块。
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const DOMAIN = join(ROOT, 'packages/domain');

const ALLOWED_NODE = new Set(['node:crypto', 'node:path']);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const failures = [];

const pkg = JSON.parse(await readFile(join(DOMAIN, 'package.json'), 'utf8'));
for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
  for (const name of Object.keys(pkg[field] ?? {})) {
    failures.push(`packages/domain/package.json: ${field} 必须为空，但发现 "${name}"`);
  }
}

const SPECIFIER = /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]/g;

for (const file of await walk(DOMAIN)) {
  // 测试文件不是产品依赖：它们只在 node --test 下加载，不进入任何构建产物。
  if (file.endsWith('.test.ts')) continue;
  const source = await readFile(file, 'utf8');
  const where = relative(ROOT, file);
  for (const match of source.matchAll(SPECIFIER)) {
    const spec = match[1];
    if (spec.startsWith('.')) continue;
    if (ALLOWED_NODE.has(spec)) continue;
    failures.push(`${where}: 领域层不得 import "${spec}"（只允许相对路径或 node:{crypto,path}）`);
  }
}

if (failures.length > 0) {
  console.error('✗ domain purity 失败：\n' + failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log('✓ domain purity');
