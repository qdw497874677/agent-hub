import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultRows,
  defaultsFromRows,
  knownRuntimes,
  remainingRuntimes,
  runtimeLabel,
  sameDefaults
} from './agent-defaults.ts';

test('运行时并集：多台机器同名运行时合并模型，去重保序；离线机器也算', () => {
  const known = knownRuntimes([
    { agentModels: [{ agentId: 'opencode', models: ['go-deepseek-v4.1-flash', 'opencode-go/x'] }] },
    // 离线机器同样会上报 agentModels：没有 state 字段也照算
    { agentModels: [{ agentId: 'codex', models: ['gpt-5.5'] }, { agentId: 'opencode', models: ['opencode-go/x', 'glm-5.3'] }] },
    { agentModels: [{ agentId: 'codex', models: [] }] },
    {}
  ]);
  assert.deepEqual(known, [
    { runtimeId: 'opencode', models: ['go-deepseek-v4.1-flash', 'opencode-go/x', 'glm-5.3'] },
    { runtimeId: 'codex', models: ['gpt-5.5'] }
  ]);
});

test('运行时并集：空白与重复的 agentId 不产生空行', () => {
  const known = knownRuntimes([
    { agentModels: [{ agentId: '  ', models: ['m'] }, { agentId: ' pi ', models: [' ', 'pi-default'] }] }
  ]);
  assert.deepEqual(known, [{ runtimeId: 'pi', models: ['pi-default'] }]);
});

test('行：只列配过默认的运行时，已知的按上报顺序、只存在于默认值里的按字母序补在后面', () => {
  const rows = defaultRows({ opencode: 'go-deepseek-v4.1-flash', pi: 'pi-default', grok: 'grok-4' }, [
    { runtimeId: 'opencode', models: [] },
    { runtimeId: 'codex', models: [] }
  ]);
  assert.deepEqual(rows, [
    { runtime: 'opencode', model: 'go-deepseek-v4.1-flash' },
    { runtime: 'grok', model: 'grok-4' },
    { runtime: 'pi', model: 'pi-default' }
  ]);
});

test('行：没配过的运行时（含模型为空串的脏数据）不进列表，交给「添加运行时」', () => {
  assert.deepEqual(defaultRows({}, [{ runtimeId: 'opencode', models: [] }]), []);
  assert.deepEqual(defaultRows({ opencode: '', codex: '  ' }, [{ runtimeId: 'opencode', models: [] }]), []);
});

test('行 → 请求体：空值丢弃、值去首尾空白', () => {
  assert.deepEqual(
    defaultsFromRows([
      { runtime: 'opencode', model: '  go-deepseek-v4.1-flash  ' },
      { runtime: 'codex', model: '   ' },
      { runtime: 'pi', model: '' }
    ]),
    { opencode: 'go-deepseek-v4.1-flash' }
  );
  assert.deepEqual(defaultsFromRows([]), {});
});

test('是否相等：key 顺序无关，空对象等于清空', () => {
  assert.equal(sameDefaults({ a: 'x', b: 'y' }, { b: 'y', a: 'x' }), true);
  assert.equal(sameDefaults({ a: 'x' }, { a: 'x', b: 'y' }), false);
  assert.equal(sameDefaults({ a: 'x' }, { a: 'x ' }), false);
  assert.equal(sameDefaults({}, {}), true);
});

test('可添加的运行时：已经出现在行里（哪怕模型为空）就不再列一遍', () => {
  const known = [
    { runtimeId: 'opencode', models: [] },
    { runtimeId: 'codex', models: [] },
    { runtimeId: 'pi', models: [] }
  ];
  assert.deepEqual(
    remainingRuntimes(known, [
      { runtime: 'opencode', model: 'x' },
      { runtime: 'pi', model: '' }
    ]).map((runtime) => runtime.runtimeId),
    ['codex']
  );
});

test('名字：认识的运行时给中文界面用的专名，不认识的回落成 id', () => {
  assert.equal(runtimeLabel('opencode'), 'OpenCode');
  assert.equal(runtimeLabel('acme-agent'), 'acme-agent');
});
