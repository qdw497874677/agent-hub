import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 六边形约束：领域层（测试和 testing/ 除外）不 import 任何 `node:` 模块，平台能力经端口注入。 */
test('domain 源码不依赖 node: 模块', () => {
  const root = import.meta.dirname;
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'testing') walk(path);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        if (/from ['"]node:/.test(readFileSync(path, 'utf8'))) offenders.push(path.slice(root.length + 1));
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});
