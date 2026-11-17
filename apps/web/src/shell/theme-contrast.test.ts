import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * 主题色不是“看起来差不多”就行：元信息、错误、状态文字都是 11px，
 * 在深色背景上必须过 WCAG AA 的 4.5:1。把这个约束写进测试，
 * 以后改 styles.css 的令牌不会悄悄把对比度降回去。
 */
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

/** 读 @theme 里的令牌；旧名是 `var(--color-语义名)` 别名，顺着解到十六进制。 */
function token(name: string, depth = 0): string {
  const match = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6}|var\\(--color-([a-z0-9-]+)\\))`));
  assert.ok(match, `styles.css 缺少 --color-${name}`);
  if (match[2] !== undefined) {
    assert.ok(depth < 4, `--color-${name} 别名绕圈了`);
    return token(match[2], depth + 1);
  }
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

test('危险色上的深色文字也达到 AA（失败徽标、确认删除按钮）', () => {
  const ratio = contrast(token('canvas'), token('rust'));
  assert.ok(ratio >= 4.5, `--color-canvas on --color-rust = ${ratio.toFixed(2)}:1`);
});

function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

test('失败（rust）和在跑（accent）色相拉开，小圆点上也分得清', () => {
  const gap = Math.abs(hue(token('accent')) - hue(token('rust')));
  assert.ok(gap >= 25, `accent 与 rust 色相只差 ${gap.toFixed(0)}°`);
});

test('强调色上的深色文字也达到 AA', () => {
  const ratio = contrast(token('canvas'), token('accent'));
  assert.ok(ratio >= 4.5, `--color-canvas on --color-accent = ${ratio.toFixed(2)}:1`);
});

test('令牌 v2：语义层的文字和状态色在各层表面上都达到 AA', () => {
  const surfaces = ['bg', 'surface-1', 'surface-2', 'surface-3', 'overlay'] as const;
  const foregrounds = ['fg', 'fg-muted', 'fg-faint', 'live', 'success', 'warning', 'danger', 'info', 'link', 'diff-add', 'diff-del'] as const;
  for (const surface of surfaces) {
    for (const foreground of foregrounds) {
      const ratio = contrast(token(foreground), token(surface));
      assert.ok(ratio >= 4.5, `--color-${foreground} on --color-${surface} = ${ratio.toFixed(2)}:1`);
    }
  }
});

test('令牌 v2：主按钮是中性高对比，焦点框在底色上看得见', () => {
  assert.ok(contrast(token('action-fg'), token('action')) >= 7, '主按钮文字对比度不足 7:1');
  for (const surface of ['bg', 'surface-1', 'surface-2', 'surface-3'] as const) {
    assert.ok(contrast(token('ring'), token(surface)) >= 3, `焦点框在 ${surface} 上不足 3:1`);
  }
});

test('令牌 v2：警告和「在跑」的琥珀分开（不同色相，警告另配图标）', () => {
  const gap = Math.abs(hue(token('live')) - hue(token('warning')));
  assert.ok(gap >= 10, `live 与 warning 色相只差 ${gap.toFixed(0)}°`);
  assert.notEqual(token('action'), token('live'), '主按钮不能再用琥珀');
  assert.notEqual(token('ring'), token('live'), '焦点框不能再用琥珀');
});

test('旧名都还在，并且指回语义层', () => {
  const aliases: Record<string, string> = {
    canvas: 'bg', panel: 'surface-1', card: 'surface-2', 'card-raised': 'surface-3', hair: 'border', strong: 'border-strong',
    primary: 'fg', secondary: 'fg-muted', tertiary: 'fg-faint', accent: 'live', sage: 'success', rust: 'danger', ochre: 'warning'
  };
  for (const [old, semantic] of Object.entries(aliases)) {
    assert.match(css, new RegExp(`--color-${old}:\\s*var\\(--color-${semantic}\\)`), `--color-${old} 不是 ${semantic} 的别名`);
  }
});

/** 浅色主题：[data-theme='light'] 块里覆盖了语义层；没覆盖的照旧读 @theme。 */
function lightToken(name: string): string {
  const block = css.match(/\[data-theme='light'\]\s*\{([^}]*)\}/);
  assert.ok(block, 'styles.css 缺少 [data-theme=\'light\'] 块');
  const match = block[1]!.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  return match ? match[1]! : token(name);
}

test('浅色主题：语义层文字和状态色在各层表面上都达到 AA', () => {
  const surfaces = ['bg', 'surface-1', 'surface-2', 'surface-3', 'overlay'] as const;
  const foregrounds = ['fg', 'fg-muted', 'fg-faint', 'live', 'success', 'warning', 'danger', 'info', 'link', 'diff-add', 'diff-del'] as const;
  for (const surface of surfaces) {
    for (const foreground of foregrounds) {
      const ratio = contrast(lightToken(foreground), lightToken(surface));
      assert.ok(ratio >= 4.5, `浅色：--color-${foreground} on --color-${surface} = ${ratio.toFixed(2)}:1`);
    }
  }
  const action = contrast(lightToken('action-fg'), lightToken('action'));
  assert.ok(action >= 4.5, `浅色主按钮 = ${action.toFixed(2)}:1`);
  const gap = Math.abs(hue(lightToken('live')) - hue(lightToken('danger')));
  assert.ok(gap >= 20, `浅色：live 与 danger 色相只差 ${gap.toFixed(0)}°`);
});
