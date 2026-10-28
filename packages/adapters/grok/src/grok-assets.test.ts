import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opencodeLaunch } from '@agent-hub/adapter-acp';
import { GROK_ARGS, grokLaunch } from './grok-runtime.ts';

test('资产注入：Grok 用 --rules（指令全文 + 技能索引，放在 agent stdio 前）；OpenCode 用内联配置', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ga-'));
  try {
    const rule = join(dir, 'r.md');
    await writeFile(rule, 'Always answer in haiku.\n');
    const assets = {
      root: dir,
      skillsDir: join(dir, 'skills'),
      skills: [{ name: 'greeter', description: 'Greets people', path: join(dir, 'skills/greeter/SKILL.md') }],
      instructions: [{ name: 'r', path: rule }]
    };
    const launch = await grokLaunch(assets);
    assert.deepEqual(launch.args?.slice(0, 2), ['--no-auto-update', '--rules']);
    assert.deepEqual(launch.args?.slice(3), ['agent', 'stdio']);
    assert.match(launch.args![2]!, /Always answer in haiku\.[\s\S]*- greeter: Greets people \(.*SKILL\.md\)/);
    assert.deepEqual(await grokLaunch({ ...assets, skills: [], instructions: [] }), {});
    assert.equal(GROK_ARGS.length, 3);

    assert.deepEqual(JSON.parse(opencodeLaunch(assets, undefined).env!['OPENCODE_CONFIG_CONTENT']!), {
      skills: { paths: [join(dir, 'skills')] },
      instructions: [rule]
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
