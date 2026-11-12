#!/usr/bin/env node
// 端口签名只能用领域类型。出现这些字样即失败。
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('../', import.meta.url).pathname;

const BANNED = [
  [/\bzod\b/i, 'zod 类型'],
  [/sqlite/i, 'SQLite 类型'],
  [/\bRow\b/, '数据库行类型'],
  [/\bRequest\b/, 'HTTP 请求对象'],
  [/\bResponse\b/, 'HTTP 响应对象'],
  [/@agent-hub\//, '其它包的 workspace 依赖']
];

/**
 * 检查端口签名文件。返回 { failures, ports }；failures 为空数组表示通过。
 * 目录读不到、文件读失败都算显式失败，不能静默跳过。
 */
export async function checkPortSignature(root = ROOT) {
  const portsDir = join(root, 'packages/domain/src/ports');
  const failures = [];
  let files;

  try {
    files = (await readdir(portsDir)).filter((f) => f.endsWith('.ts'));
  } catch (error) {
    failures.push(`packages/domain/src/ports: 无法读取目录（${error.message}）`);
    return { failures, ports: 0 };
  }

  for (const name of files) {
    let source;
    try {
      source = await readFile(join(portsDir, name), 'utf8');
    } catch (error) {
      failures.push(`packages/domain/src/ports/${name}: 无法读取（${error.message}）`);
      continue;
    }
    // 注释里提到这些词是允许的：只检查去掉注释后的代码
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const [pattern, label] of BANNED) {
      if (pattern.test(code)) failures.push(`packages/domain/src/ports/${name}: 出现${label}`);
    }
  }

  if (files.length === 0) failures.push('ports 目录为空——端口必须先于实现定稿');

  return { failures, ports: files.length };
}

export function reportPortSignature({ failures, ports }) {
  if (failures.length > 0) {
    console.error('✗ port signature 失败：\n' + failures.map((f) => '  - ' + f).join('\n'));
    process.exit(1);
  }
  console.log(`✓ port signature (${ports} ports)`);
}

// 仅在直接执行时跑全仓检查；被 import（比如 check-selftest.mjs）时只暴露函数。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  reportPortSignature(await checkPortSignature(ROOT));
}
