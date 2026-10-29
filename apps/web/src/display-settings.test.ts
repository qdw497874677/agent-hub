import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_DISPLAY, displayKey, parseDisplay, toolOpenByDefault } from './display-settings.ts';

test('按账号分键', () => {
  assert.equal(displayKey('u1'), 'agent-hub.display.u1');
  assert.equal(displayKey(null), 'agent-hub.display.anon');
});

test('坏数据退回默认；部分字段合法就留下', () => {
  assert.deepEqual(parseDisplay(null), DEFAULT_DISPLAY);
  assert.deepEqual(parseDisplay('{oops'), DEFAULT_DISPLAY);
  assert.deepEqual(parseDisplay('{"tools":"hidden","thinking":"nope","compact":true}'), {
    ...DEFAULT_DISPLAY,
    tools: 'hidden',
    compact: true
  });
});

test('折叠模式下命令 / 改动可以单独默认展开', () => {
  const s = { ...DEFAULT_DISPLAY, tools: 'collapsed' as const, shellExpanded: true, editExpanded: false };
  assert.equal(toolOpenByDefault(s, 'shell'), true);
  assert.equal(toolOpenByDefault(s, 'edit'), false);
  assert.equal(toolOpenByDefault(s, 'other'), false);
  assert.equal(toolOpenByDefault({ ...s, tools: 'expanded' }, 'other'), true);
});
