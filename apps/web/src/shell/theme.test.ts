import assert from 'node:assert/strict';
import test from 'node:test';
import { parseThemePref, resolveTheme } from './theme.ts';

test('主题偏好：认不出的值当「跟随系统」', () => {
  assert.equal(parseThemePref(null), 'auto');
  assert.equal(parseThemePref('purple'), 'auto');
  assert.equal(parseThemePref('light'), 'light');
});

test('跟随系统时看 prefers-color-scheme；手选时以手选为准', () => {
  assert.equal(resolveTheme('auto', true), 'light');
  assert.equal(resolveTheme('auto', false), 'dark');
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('light', false), 'light');
});
