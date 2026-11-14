import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composerKeyAction } from './composer-keys.ts';

const event = (key: string, modifiers: Partial<{ meta: boolean; ctrl: boolean; shift: boolean }> = {}) => ({
  key,
  metaKey: modifiers.meta ?? false,
  ctrlKey: modifiers.ctrl ?? false,
  shiftKey: modifiers.shift ?? false
});

test('⌘/Ctrl + Enter 是发送', () => {
  assert.equal(composerKeyAction(event('Enter', { meta: true })), 'send');
  assert.equal(composerKeyAction(event('Enter', { ctrl: true })), 'send');
});

test('再加 Shift 是发送并新建', () => {
  assert.equal(composerKeyAction(event('Enter', { meta: true, shift: true })), 'send-and-new');
  assert.equal(composerKeyAction(event('Enter', { ctrl: true, shift: true })), 'send-and-new');
});

test('没有修饰键的回车不归这里管（换行还是发送由输入框决定）', () => {
  assert.equal(composerKeyAction(event('Enter')), null);
  assert.equal(composerKeyAction(event('Enter', { shift: true })), null);
});

test('其他键一律不认，哪怕带着修饰键', () => {
  assert.equal(composerKeyAction(event('a', { meta: true })), null);
  assert.equal(composerKeyAction(event('Escape', { ctrl: true, shift: true })), null);
  assert.equal(composerKeyAction(event('Enter', {})), null);
});
