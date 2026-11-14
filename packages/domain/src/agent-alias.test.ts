import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_ALIAS_MAX, agentAliasProblem, agentAliasesProblem, normalizeAgentAliases } from './agent-alias.ts';

const ok = { id: 'claude-code', label: 'Claude Code', command: 'claude-code-acp', args: ['--acp'] };

test('别名：合法的单条，可选字段可有可无', () => {
  assert.equal(agentAliasProblem(ok), null);
  assert.equal(agentAliasProblem({ ...ok, models: ['m1'], defaultModel: 'm1' }), null);
  assert.equal(agentAliasesProblem([ok, { id: 'second', label: '第二个', command: 's', args: [] }]), null);
  assert.equal(agentAliasesProblem([]), null);
});

test('别名：id 形状（小写字母开头，只含 a-z 0-9 -，≤41 字符）', () => {
  assert.match(agentAliasProblem({ ...ok, id: 'Claude' }) ?? '', /id 要小写字母开头/);
  assert.match(agentAliasProblem({ ...ok, id: '1st' }) ?? '', /id 要小写字母开头/);
  assert.match(agentAliasProblem({ ...ok, id: 'has_underscore' }) ?? '', /id 要小写字母开头/);
  assert.match(agentAliasProblem({ ...ok, id: 'a'.repeat(42) }) ?? '', /id 要小写字母开头/);
  assert.equal(agentAliasProblem({ ...ok, id: 'a'.repeat(41) }), null);
});

test('别名：内置运行时的 id 不能占用', () => {
  for (const id of ['pi', 'opencode', 'grok', 'hermes', 'codex']) {
    assert.match(agentAliasProblem({ ...ok, id }) ?? '', /内置运行时的名字/);
  }
});

test('别名：id 重复', () => {
  assert.equal(agentAliasesProblem([ok, { ...ok, label: '重复的' }]), '别名 id「claude-code」重复了');
});

test('别名：超过上限', () => {
  const many = Array.from({ length: AGENT_ALIAS_MAX + 1 }, (_, index) => ({ ...ok, id: `alias-${index}` }));
  assert.equal(agentAliasesProblem(many), `运行时别名最多 ${AGENT_ALIAS_MAX} 个`);
  assert.equal(agentAliasesProblem(many.slice(0, AGENT_ALIAS_MAX)), null);
});

test('别名：command / label 不能为空', () => {
  assert.match(agentAliasProblem({ ...ok, command: '  ' }) ?? '', /command 不能为空/);
  assert.match(agentAliasProblem({ ...ok, label: '' }) ?? '', /label 不能为空/);
  assert.match(agentAliasProblem({ ...ok, command: 42 }) ?? '', /command 不能为空/);
});

test('别名：args / models 必须是字符串数组', () => {
  assert.match(agentAliasProblem({ ...ok, args: 'x' }) ?? '', /args 只能是字符串数组/);
  assert.match(agentAliasProblem({ ...ok, args: ['ok', 2] }) ?? '', /args 只能是字符串数组/);
  assert.match(agentAliasProblem({ ...ok, models: [1] }) ?? '', /models 只能是字符串数组/);
  assert.match(agentAliasProblem({ ...ok, defaultModel: 7 }) ?? '', /defaultModel 只能是字符串/);
});

test('别名：整表不是数组 / 某条不是对象，文案指出是第几个', () => {
  assert.match(agentAliasesProblem({}) ?? '', /aliases 必须是数组/);
  assert.equal(agentAliasesProblem([ok, 'nope']), '第 2 个：别名必须是对象（要 id / label / command）');
  assert.equal(agentAliasesProblem([ok, { ...ok, id: 'Bad' }]), '第 2 个：id 要小写字母开头，只含 a-z 0-9 -，最长 41 个字符');
});

test('normalizeAgentAliases：补 args、保留可选字段', () => {
  assert.deepEqual(normalizeAgentAliases([{ id: 'x', label: 'X', command: 'x', args: [] }]), [{ id: 'x', label: 'X', command: 'x', args: [] }]);
  assert.deepEqual(normalizeAgentAliases([{ id: 'x', label: 'X', command: 'x', args: ['a'], models: ['m'], defaultModel: 'm' }]), [
    { id: 'x', label: 'X', command: 'x', args: ['a'], models: ['m'], defaultModel: 'm' }
  ]);
});
