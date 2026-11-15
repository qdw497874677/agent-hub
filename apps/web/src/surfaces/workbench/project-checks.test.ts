import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_COMMANDS_MAX,
  CHECK_COMMAND_MAX,
  checksDirty,
  checksDraft,
  checksDraftProblem,
  parseChecks,
  storedChecks
} from './project-checks.ts';

test('parseChecks：一行一条，trim，空行和前后空行都丢掉', () => {
  assert.deepEqual(parseChecks('\n  npm run typecheck  \n\n npm test\n\n'), ['npm run typecheck', 'npm test']);
  assert.deepEqual(parseChecks(''), []);
  assert.deepEqual(parseChecks('   \n\t\n'), []);
});

test('parseChecks：从外面粘进来的 CRLF 也按行切，单条里不留换行', () => {
  const checks = parseChecks('npm test\r\nnpm run build\r\n');
  assert.deepEqual(checks, ['npm test', 'npm run build']);
  assert.equal(checks.every((command) => !command.includes('\n') && !command.includes('\r')), true);
});

test('checksDraftProblem：超过 5 条直接说清楚现在是几条', () => {
  const six = Array.from({ length: CHECK_COMMANDS_MAX + 1 }, (_, index) => `cmd-${index}`).join('\n');
  assert.equal(checksDraftProblem(six), `最多 ${CHECK_COMMANDS_MAX} 条检查命令，现在有 ${CHECK_COMMANDS_MAX + 1} 条。`);
  // 刚好 5 条是合法的
  assert.equal(checksDraftProblem(Array.from({ length: CHECK_COMMANDS_MAX }, (_, index) => `cmd-${index}`).join('\n')), null);
});

test('checksDraftProblem：单条超过 300 字拦下来，长度按 trim 后算', () => {
  const exact = 'x'.repeat(CHECK_COMMAND_MAX);
  assert.equal(checksDraftProblem(exact), null);
  assert.equal(checksDraftProblem(`  ${exact}  `), null);
  assert.equal(
    checksDraftProblem(`${exact}x`),
    `单条命令最多 ${CHECK_COMMAND_MAX} 字，有一条 ${CHECK_COMMAND_MAX + 1} 字了。`
  );
});

test('storedChecks / checksDraft：老项目没有 checks 字段 → 空；读得到就原样拼成多行', () => {
  assert.deepEqual(storedChecks({ id: 'p1', name: 'x' }), []);
  assert.deepEqual(storedChecks({ checks: null }), []);
  assert.deepEqual(storedChecks({ checks: 'npm test' }), []);
  assert.deepEqual(storedChecks({ checks: ['npm test', 42, 'npm run build'] }), ['npm test', 'npm run build']);
  assert.equal(checksDraft({ checks: ['npm test', 'npm run build'] }), 'npm test\nnpm run build');
  assert.equal(checksDraft({}), '');
});

test('checksDirty：空白差异不算改动，条目变化才算', () => {
  const project = { checks: ['npm test', 'npm run build'] };
  assert.equal(checksDirty(project, 'npm test\nnpm run build\n'), false);
  assert.equal(checksDirty(project, '  npm test \n\n npm run build  \n'), false);
  assert.equal(checksDirty(project, 'npm test'), true);
  assert.equal(checksDirty(project, ''), true);
  assert.equal(checksDirty({ checks: [] }, ''), false);
});
