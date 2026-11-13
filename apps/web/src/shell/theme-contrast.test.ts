import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * 主题色不是“看起来差不多”就行：元信息、错误、状态文字都是 11px，
 * 在深色背景上必须过 WCAG AA 的 4.5:1。把这个约束写进测试，
 * 以后改 styles.css 的令牌不会悄悄把对比度降回去。
 */
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function token(name: string): string {
  const match = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(match, `styles.css 缺少 --color-${name}`);
  return match[1]!;
}

function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('主题文字色在 canvas/panel/card 上都达到 WCAG AA', () => {
  const backgrounds = ['canvas', 'panel', 'card', 'card-raised'] as const;
  const foregrounds = ['primary', 'secondary', 'tertiary', 'accent', 'accent-dim', 'sage', 'rust'] as const;
  for (const background of backgrounds) {
    for (const foreground of foregrounds) {
      const ratio = contrast(token(foreground), token(background));
      assert.ok(
        ratio >= 4.5,
        `--color-${foreground} on --color-${background} = ${ratio.toFixed(2)}:1，低于 4.5:1`
      );
    }
  }
});

test('强调色上的深色文字也达到 AA', () => {
  const ratio = contrast(token('canvas'), token('accent'));
  assert.ok(ratio >= 4.5, `--color-canvas on --color-accent = ${ratio.toFixed(2)}:1`);
});
