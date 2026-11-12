#!/usr/bin/env node
// 依赖方向唯一：domain 不认识任何东西。
// 规则：domain/package.json 无 dependencies；domain/** 的 import 只允许相对路径或白名单 node: 模块。
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('../', import.meta.url).pathname;

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

const SPECIFIER = /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]/g;

/**
 * 检查 domain 包的依赖纯净性。返回失败信息数组；空数组表示通过。
 * package.json 读不出来或遍历/读文件失败都算显式失败，不能静默跳过。
 */
export async function checkDomainPurity(root = ROOT) {
  const domain = join(root, 'packages/domain');
  const failures = [];

  let pkg = {};
  try {
    pkg = JSON.parse(await readFile(join(domain, 'package.json'), 'utf8'));
  } catch (error) {
    failures.push(`packages/domain/package.json: 无法读取或解析（${error.message}）`);
  }
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      failures.push(`packages/domain/package.json: ${field} 必须为空，但发现 "${name}"`);
    }
  }

  let files;
  try {
    files = await walk(join(domain, 'src'));
  } catch (error) {
    failures.push(`packages/domain/src: 无法遍历（${error.message}）`);
    files = [];
  }

  for (const file of files) {
    // 测试文件不是产品依赖：它们只在 node --test 下加载，不进入任何构建产物。
    if (file.endsWith('.test.ts')) continue;
    let source;
    try {
      source = await readFile(file, 'utf8');
    } catch (error) {
      failures.push(`${relative(root, file)}: 无法读取（${error.message}）`);
      continue;
    }
    const where = relative(root, file);
    for (const match of source.matchAll(SPECIFIER)) {
      const spec = match[1];
      if (spec.startsWith('.')) continue;
      if (ALLOWED_NODE.has(spec)) continue;
      failures.push(`${where}: 领域层不得 import "${spec}"（只允许相对路径或 node:{crypto,path}）`);
    }
  }

  return failures;
}

export function reportDomainPurity(failures) {
  if (failures.length > 0) {
    console.error('✗ domain purity 失败：\n' + failures.map((f) => '  - ' + f).join('\n'));
    process.exit(1);
  }
  console.log('✓ domain purity');
}

// 仅在直接执行时跑全仓检查；被 import（比如 check-selftest.mjs）时只暴露函数。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  reportDomainPurity(await checkDomainPurity(ROOT));
}
