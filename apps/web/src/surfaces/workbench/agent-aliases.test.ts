import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ALIASES,
  aliasRowProblem,
  aliasRowsFrom,
  aliasRowsValue,
  aliasesProblem,
  emptyAgentAlias,
  parseAliasList,
  type AgentAliasRow
} from './agent-aliases.ts';

const row = (patch: Partial<AgentAliasRow> = {}): AgentAliasRow => ({ ...emptyAgentAlias(), id: 'claude', label: 'Claude', command: 'claude-code-acp', ...patch });

test('合法的一行没有原因，整表也没有', () => {
  const rows = [row(), row({ id: 'gemini', label: 'Gemini', command: 'gemini', args: '--acp --verbose' })];
  assert.equal(aliasRowProblem(rows[0]!), null);
  assert.equal(aliasesProblem(rows), null);
});

test('id 形状：必须小写字母开头，只允许小写字母 / 数字 / -，最长 41 位', () => {
  assert.equal(aliasRowProblem(row({ id: 'Claude' })), 'id 用小写字母开头，只能有小写字母、数字和 -，最长 41 位');
  assert.equal(aliasRowProblem(row({ id: '1claude' })), 'id 用小写字母开头，只能有小写字母、数字和 -，最长 41 位');
  assert.equal(aliasRowProblem(row({ id: 'claude_code' })), 'id 用小写字母开头，只能有小写字母、数字和 -，最长 41 位');
  assert.equal(aliasRowProblem(row({ id: 'claude code' })), 'id 用小写字母开头，只能有小写字母、数字和 -，最长 41 位');
  // 41 位可以，42 位不行（首字母 + 40）
  assert.equal(aliasRowProblem(row({ id: `a${'b'.repeat(40)}` })), null);
  assert.equal(aliasRowProblem(row({ id: `a${'b'.repeat(41)}` })), 'id 用小写字母开头，只能有小写字母、数字和 -，最长 41 位');
  assert.equal(aliasRowProblem(row({ id: '' })), 'id 不能为空');
});

test('保留 id：内置四个运行时不能拿来当别名', () => {
  for (const id of ['pi', 'opencode', 'grok', 'hermes']) {
    assert.equal(aliasRowProblem(row({ id })), 'pi / opencode / grok / hermes 是内置的');
  }
  // 只是前缀相同不受影响
  assert.equal(aliasRowProblem(row({ id: 'pi-pro' })), null);
});

test('重复 id：整表拒绝，并指出是哪个', () => {
  assert.equal(aliasesProblem([row(), row({ label: '另一个' })]), 'id 不能重复：claude');
  // 空行不参与重复判断
  assert.equal(aliasesProblem([row(), emptyAgentAlias()]), null);
});

test('超过 16 个别名：整表拒绝', () => {
  const rows = Array.from({ length: MAX_ALIASES + 1 }, (_, index) => row({ id: `agent-${index}`, label: `A${index}` }));
  assert.equal(aliasesProblem(rows), `最多 ${MAX_ALIASES} 个别名`);
  assert.equal(aliasesProblem(rows.slice(0, MAX_ALIASES)), null);
});

test('command 不能空；名称、参数、模型的长度和条数都有上限', () => {
  assert.equal(aliasRowProblem(row({ command: '   ' })), '命令不能为空');
  assert.equal(aliasRowProblem(row({ command: 'c'.repeat(501) })), '命令最多 500 个字');
  assert.equal(aliasRowProblem(row({ label: 'l'.repeat(81) })), '名称最多 80 个字');
  assert.equal(aliasRowProblem(row({ args: Array.from({ length: 21 }, (_, i) => `--a${i}`).join(',') })), '参数最多 20 条');
  assert.equal(aliasRowProblem(row({ args: 'a'.repeat(201) })), '每条参数最多 200 个字');
  assert.equal(aliasRowProblem(row({ models: Array.from({ length: 101 }, (_, i) => `m${i}`).join(',') })), '模型最多 100 个');
  assert.equal(aliasRowProblem(row({ models: 'm'.repeat(201) })), '每个模型最多 200 个字');
  assert.equal(aliasRowProblem(row({ defaultModel: 'm'.repeat(201) })), '默认模型最多 200 个字');
});

test('逗号 / 空格分隔的列表解析成数组，多余的空白和空项丢掉', () => {
  assert.deepEqual(parseAliasList('--acp, --verbose  --model=x'), ['--acp', '--verbose', '--model=x']);
  assert.deepEqual(parseAliasList('  '), []);
  const [value] = aliasRowsValue([row({ args: 'a,b', models: ' gpt-5 , claude-sonnet-4 ' })]);
  assert.deepEqual(value?.args, ['a', 'b']);
  assert.deepEqual(value?.models, ['gpt-5', 'claude-sonnet-4']);
});

test('空串的 args / models / defaultModel 保存时整个字段省略，空行不提交', () => {
  const [value] = aliasRowsValue([row(), emptyAgentAlias()]);
  assert.deepEqual(value, { id: 'claude', label: 'Claude', command: 'claude-code-acp' });
  assert.equal('args' in value!, false);
  assert.equal('models' in value!, false);
  assert.equal('defaultModel' in value!, false);
  assert.equal(aliasRowsValue([emptyAgentAlias()]).length, 0);
});

test('名称没填就用 id 顶上（服务端不接受空 label）', () => {
  const [value] = aliasRowsValue([row({ label: '   ' })]);
  assert.equal(value?.label, 'claude');
});

test('接口值转表单行：数组拼成逗号串，缺字段给空串', () => {
  const rows = aliasRowsFrom([
    { id: 'claude', label: 'Claude', command: 'claude', args: ['--acp', '--verbose'], models: ['gpt-5'], defaultModel: 'gpt-5' },
    { id: 'gemini', label: 'Gemini', command: 'gemini' }
  ]);
  assert.deepEqual(rows[0], { id: 'claude', label: 'Claude', command: 'claude', args: '--acp, --verbose', models: 'gpt-5', defaultModel: 'gpt-5' });
  assert.deepEqual(rows[1], { id: 'gemini', label: 'Gemini', command: 'gemini', args: '', models: '', defaultModel: '' });
});

test('表单 → 接口 → 表单 走一圈不变（空白被规范化）', () => {
  const input = [row({ args: ' --acp ,  --verbose ', models: 'gpt-5', defaultModel: ' gpt-5 ' })];
  const once = aliasRowsValue(input);
  assert.deepEqual(aliasRowsFrom(once)[0], { ...input[0]!, args: '--acp, --verbose', models: 'gpt-5', defaultModel: 'gpt-5' });
  assert.deepEqual(aliasRowsValue(aliasRowsFrom(once)), once);
});
