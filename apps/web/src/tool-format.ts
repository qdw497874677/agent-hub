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

export interface FileTarget {
  /** 相对工作空间根的路径（不以 / 开头、不含 ..）。 */
  readonly path: string;
  /** 1 起的行号；不知道就是 null。 */
  readonly line: number | null;
}

const PATH_KEYS = ['path', 'file_path', 'filePath', 'file', 'filename'];
const LINE_KEYS = ['line', 'offset', 'start_line', 'startLine', 'line_number', 'lineNumber'];

/** 规范化成相对根的路径；越出根（..）就返回 null。 */
function inside(relative: string): string | null {
  const parts: string[] = [];
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length === 0 ? null : parts.join('/');
}

/**
 * 工具调用参数里的文件路径 → 「文件」页能打开的目标。只认参数里的路径字段（不扫消息正文）。
 * 相对路径按工作空间根解析；绝对路径必须落在 root 下（root 不知道就不认绝对路径）；
 * 越出工作空间、~、带协议的一律不可点。
 */
export function toolFileTarget(input: string, root: string | null): FileTarget | null {
  const args = parse(input);
  if (args === null) return null;
  const raw = str(args, ...PATH_KEYS);
  if (raw === null || raw.includes('\0') || raw.startsWith('~') || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.includes('\\')) return null;
  let relative: string;
  if (raw.startsWith('/')) {
    if (root === null || root === '') return null;
    const base = root.replace(/\/+$/, '');
    if (base === '' || !(raw === base || raw.startsWith(`${base}/`))) return null;
    relative = raw.slice(base.length);
  } else relative = raw;
  const path = inside(relative);
  if (path === null) return null;
  let line: number | null = null;
  for (const key of LINE_KEYS) {
    const value = args[key];
    const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
    if (Number.isInteger(n) && n >= 1) {
      line = n;
      break;
    }
  }
  return { path, line };
}
