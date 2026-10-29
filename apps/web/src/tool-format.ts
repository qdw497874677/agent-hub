/**
 * 工具卡片的纯逻辑：把 agent 报来的 input（通常是 JSON 字符串）认成「命令 / 文件 / 改动」，
 * 输出按长度截断。不碰 DOM，能在 node:test 里测（tool-format.test.ts）。
 *
 * 认不出来的就原样当 JSON 显示——宁可难看，也不能吞掉信息。
 */

export interface DiffLine {
  readonly sign: '+' | '-' | ' ' | '@';
  readonly text: string;
}

export type ToolView =
  | { readonly kind: 'shell'; readonly command: string }
  | { readonly kind: 'edit'; readonly path: string; readonly diff: readonly DiffLine[] }
  | { readonly kind: 'file'; readonly path: string; readonly detail: string }
  | { readonly kind: 'raw'; readonly text: string };

/** 改文件的工具（OpenCode 设置里「Expand edit tool parts」那一类）。 */
export type ToolFamily = 'shell' | 'edit' | 'other';

function parse(input: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(input);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

function lines(text: string, sign: '+' | '-'): DiffLine[] {
  if (text === '') return [];
  return text.replace(/\n$/, '').split('\n').map((line) => ({ sign, text: line }));
}

/** 统一 diff 文本（ACP 的 diff 块被 adapter 写成这样）→ 着色用的行。 */
export function parseUnifiedDiff(text: string): readonly DiffLine[] | null {
  const all = text.split('\n');
  if (!all.some((line) => line.startsWith('+++ ') || line.startsWith('@@'))) return null;
  return all
    .filter((line) => !line.startsWith('--- ') && !line.startsWith('+++ '))
    .map((line): DiffLine => {
      const head = line[0];
      if (head === '+' || head === '-') return { sign: head, text: line.slice(1) };
      if (line.startsWith('@@')) return { sign: '@', text: line };
      return { sign: ' ', text: line.startsWith(' ') ? line.slice(1) : line };
    });
}

export function toolView(name: string, input: string): ToolView {
  const args = parse(input);
  if (args === null) return { kind: 'raw', text: input };
  const command = str(args, 'command', 'cmd', 'script');
  if (command !== null) return { kind: 'shell', command };
  const path = str(args, 'path', 'file_path', 'filePath', 'file', 'filename') ?? '';
  const edits = Array.isArray(args['edits']) ? (args['edits'] as unknown[]) : null;
  if (edits !== null) {
    const diff: DiffLine[] = [];
    for (const [index, item] of edits.entries()) {
      if (typeof item !== 'object' || item === null) continue;
      const edit = item as Record<string, unknown>;
      if (index > 0) diff.push({ sign: '@', text: '@@' });
      diff.push(...lines(str(edit, 'oldText', 'old_string', 'oldString') ?? '', '-'));
      diff.push(...lines(str(edit, 'newText', 'new_string', 'newString') ?? '', '+'));
    }
    return { kind: 'edit', path, diff };
  }
  const oldText = str(args, 'oldText', 'old_string', 'oldString');
  const newText = str(args, 'newText', 'new_string', 'newString');
  if (oldText !== null || newText !== null) {
    return { kind: 'edit', path, diff: [...lines(oldText ?? '', '-'), ...lines(newText ?? '', '+')] };
  }
  const content = str(args, 'content', 'text');
  if (content !== null && /write|create/i.test(name)) return { kind: 'edit', path, diff: lines(content, '+') };
  if (path !== '') {
    const rest = Object.entries(args)
      .filter(([key]) => !['path', 'file_path', 'filePath', 'file', 'filename'].includes(key))
      .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(' · ');
    return { kind: 'file', path, detail: rest };
  }
  return { kind: 'raw', text: JSON.stringify(args, null, 2) };
}

export function toolFamily(name: string, view: ToolView): ToolFamily {
  if (view.kind === 'shell' || /^(bash|shell|sh|exec|run|terminal)/i.test(name)) return 'shell';
  if (view.kind === 'edit' || /edit|write|patch/i.test(name)) return 'edit';
  return 'other';
}

/** 一行摘要：折叠时 summary 上能看出「干了什么」。 */
export function toolSummary(view: ToolView): string {
  switch (view.kind) {
    case 'shell':
      return view.command.split('\n')[0] ?? '';
    case 'edit': {
      const plus = view.diff.filter((line) => line.sign === '+').length;
      const minus = view.diff.filter((line) => line.sign === '-').length;
      return `${view.path} +${plus} -${minus}`;
    }
    case 'file':
      return view.detail === '' ? view.path : `${view.path} · ${view.detail}`;
    case 'raw':
      return view.text.replace(/\s+/g, ' ').slice(0, 160);
  }
}

/** 默认只露这么多行；更多的点「展开全部」。 */
export const OUTPUT_PREVIEW_LINES = 12;

export function clipLines(text: string, max = OUTPUT_PREVIEW_LINES): { readonly shown: string; readonly hidden: number } {
  const all = text.replace(/\n$/, '').split('\n');
  if (all.length <= max) return { shown: all.join('\n'), hidden: 0 };
  return { shown: all.slice(0, max).join('\n'), hidden: all.length - max };
}
