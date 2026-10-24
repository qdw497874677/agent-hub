#!/usr/bin/env node
// 端口签名只能用领域类型。出现这些字样即失败。
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const PORTS = join(ROOT, 'packages/domain/src/ports');

const BANNED = [
  [/\bzod\b/i, 'zod 类型'],
  [/sqlite/i, 'SQLite 类型'],
  [/\bRow\b/, '数据库行类型'],
  [/\bRequest\b/, 'HTTP 请求对象'],
  [/\bResponse\b/, 'HTTP 响应对象'],
  [/@agent-hub\//, '其它包的 workspace 依赖']
];

const failures = [];
const files = (await readdir(PORTS)).filter((f) => f.endsWith('.ts'));

for (const name of files) {
  const source = await readFile(join(PORTS, name), 'utf8');
  // 注释里提到这些词是允许的：只检查去掉注释后的代码
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const [pattern, label] of BANNED) {
    if (pattern.test(code)) failures.push(`packages/domain/src/ports/${name}: 出现${label}`);
  }
}

if (files.length === 0) failures.push('ports 目录为空——端口必须先于实现定稿');

if (failures.length > 0) {
  console.error('✗ port signature 失败：\n' + failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log(`✓ port signature (${files.length} ports)`);
