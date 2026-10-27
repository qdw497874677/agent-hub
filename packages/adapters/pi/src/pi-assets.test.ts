import { test } from 'node:test';
import assert from 'node:assert/strict';
import { piAssetArgs } from './pi-runtime.ts';

test('Pi 资产参数：每个技能一次 --skill，每条指令一次 --append-system-prompt；没资产不加参数', () => {
  assert.deepEqual(piAssetArgs(undefined), []);
  assert.deepEqual(
    piAssetArgs({
      root: '/h/.agent-hub/assets',
      skillsDir: '/h/.agent-hub/assets/skills',
      skills: [
        { name: 'a', description: '', path: '/h/.agent-hub/assets/skills/a/SKILL.md' },
        { name: 'b', description: '', path: '/h/.agent-hub/assets/skills/b/SKILL.md' }
      ],
      instructions: [{ name: 'r', path: '/h/.agent-hub/assets/instructions/r.md' }]
    }),
    [
      '--skill', '/h/.agent-hub/assets/skills/a',
      '--skill', '/h/.agent-hub/assets/skills/b',
      '--append-system-prompt', '/h/.agent-hub/assets/instructions/r.md'
    ]
  );
});
