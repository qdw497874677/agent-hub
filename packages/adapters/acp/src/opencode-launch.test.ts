import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig, opencodeLaunch } from './config.ts';

const assets = {
  root: '/a',
  skillsDir: '/a/skills',
  skills: [{ name: 's', description: 'd', path: '/a/skills/s/SKILL.md' }],
  instructions: [{ name: 'r', path: '/a/instructions/r.md' }]
};
const read = (existing: string | undefined) => JSON.parse(opencodeLaunch(assets, existing).env!['OPENCODE_CONFIG_CONTENT']!);

test('OpenCode 内联配置：没有原值时只放 hub 的技能和指令', () => {
  assert.deepEqual(read(undefined), { skills: { paths: ['/a/skills'] }, instructions: ['/a/instructions/r.md'] });
  assert.deepEqual(read('  '), read(undefined));
});

test('OpenCode 内联配置：与用户已有的值深合并，用户的值全部保留', () => {
  const user = { model: 'x/y', skills: { paths: ['/mine'], other: true }, instructions: ['/mine.md', '/a/instructions/r.md'], mcp: { m: { type: 'local' } } };
  assert.deepEqual(read(JSON.stringify(user)), {
    model: 'x/y',
    skills: { paths: ['/mine', '/a/skills'], other: true },
    instructions: ['/mine.md', '/a/instructions/r.md'],
    mcp: { m: { type: 'local' } }
  });
});

test('OpenCode 内联配置：原值不是 JSON 对象就只用 hub 这一段', () => {
  assert.deepEqual(read('not json'), read(undefined));
  assert.deepEqual(read('[1]'), read(undefined));
});

test('mergeConfig：类型冲突时以用户为准', () => {
  assert.deepEqual(mergeConfig({ skills: 'off', instructions: 'x' }, { skills: { paths: ['/h'] }, instructions: ['/h.md'], n: 1 }), { skills: 'off', instructions: 'x', n: 1 });
});
