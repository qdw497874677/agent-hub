import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { tidy, toBase64, unzip } from './asset-files.ts';

const f = (path: string) => ({ path, bytes: strToU8(path) });

test('上传整理：同一个顶层目录剥掉一层、去掉系统垃圾；zip 也一样', () => {
  assert.deepEqual(
    tidy([f('greeter/SKILL.md'), f('greeter/refs/a.md'), f('greeter/.DS_Store'), f('__MACOSX/greeter/x')]).map((x) => x.path),
    ['SKILL.md', 'refs/a.md']
  );
  assert.deepEqual(tidy([f('SKILL.md'), f('refs/a.md')]).map((x) => x.path), ['SKILL.md', 'refs/a.md']);
  const zip = zipSync({ 'pack/SKILL.md': strToU8('hi'), 'pack/scripts/run.md': strToU8('x') });
  assert.deepEqual(tidy(unzip(zip)).map((x) => x.path).sort(), ['SKILL.md', 'scripts/run.md']);
  assert.equal(toBase64(strToU8('你好')), Buffer.from('你好').toString('base64'));
});
