/**
 * 工具调用「一行」的纯逻辑：这一类算哪一类、这一行露哪些参数、连续几行算不算一堆。
 * 不碰 DOM，也不认识 React —— 组件只负责把这里的结论画出来，
 * 所以聚合规则能在 node:test 里测（tool-rows.test.ts）。
 *
 * 为什么单独一个文件：怎么把一个调用认成「命令 / 改动 / 读文件」已经在 tool-format.ts；
 * 这里只回答三个新问题：单行标题叫什么、副标题露多少参数、相邻两行要不要并成一组。
 */

import type { ToolView } from './tool-format.ts';

/**
 * 聚合用的类。按「这次调用在干什么」分，不按工具名分——
 * 同一个 agent 可能叫 read_file、另一个叫 read，它们该并在一起。
 * 名字里保留英文（shell / grep / read …）：术语不翻译，和「显示设置」里的说法一致。
 */
export type ToolRowKind = 'read' | 'grep' | 'list' | 'shell' | 'edit' | 'fetch' | 'agent' | 'plan' | 'other';

/** 单行最多露几个参数；更多的写成 +N，完整参数在 title 里。 */
export const MAX_PARAMS = 3;
/** 一个参数值在行内最多留几个字符（超过就省略号）。 */
export const MAX_PARAM_VALUE = 64;
/** 没有 key 的自由文本（认不出的 input、shell 命令）最长留多少。 */
export const MAX_TEXT = 160;

export function toolRowKind(name: string, view: ToolView): ToolRowKind {
  switch (view.kind) {
    case 'shell':
      return 'shell';
    case 'edit':
      return 'edit';
    case 'read':
      return 'read';
    case 'fetch':
      return 'fetch';
    case 'subagent':
      return 'agent';
    case 'plan':
      return 'plan';
    case 'search':
      // glob / list / ls 是「列目录」；其余按 grep 算，两者不该并成一组。
      return /glob|list|ls\b|find/i.test(name) ? 'list' : 'grep';
    case 'worktree':
    case 'file':
    case 'raw':
      return 'other';
  }
}

export interface ToolParam {
  /** shell 命令没有 key（空串）：那一行本身就是命令，不用写 command=。 */
  readonly key: string;
  /** 行内显示用：单行、已截断。 */
  readonly value: string;
  /** hover 看全文用：不截断、保留换行。 */
  readonly title: string;
}

export interface ToolRowLine {
  /** 行内露出来的参数（含 shell 的命令行），最多 `limit` 个 key=value。 */
  readonly pairs: readonly ToolParam[];
  /** 被截掉的参数个数，行内写成 `+N`。 */
  readonly hidden: number;
  /** 全部参数的全文，挂在 title 上——参数再长也不能只留在看不见的地方。 */
  readonly title: string;
}

function parseArgs(input: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(input);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

const SHELL_COMMAND_KEYS = ['command', 'cmd', 'script'];

/**
 * 把调用参数折成「一行里能读的副标题」：
 * - shell：命令本身放第一位（不带 key），其它参数跟在后面；
 * - 其余：按参数原顺序最多 `limit` 个 `key=value`，多的算 +N。
 * 值在里面只留单行、按字数截断；`title` 永远是全文。
 */
export function toolRowLine(view: ToolView, input: string, limit = MAX_PARAMS): ToolRowLine {
  const args = parseArgs(input);
  if (args === null) {
    // 认不出的就原样露一行：宁可难看，不能把参数吞掉。
    return { pairs: [{ key: '', value: clip(collapse(input), MAX_TEXT), title: input }], hidden: 0, title: input };
  }
  const all: ToolParam[] = [];
  for (const [key, value] of Object.entries(args)) {
    const full = valueText(value);
    if (full === '') continue;
    all.push({ key, value: clip(collapse(full), MAX_PARAM_VALUE), title: `${key}=${full}` });
  }
  if (view.kind === 'shell') {
    const command: ToolParam = { key: '', value: clip(collapse(view.command), MAX_TEXT), title: view.command };
    const rest = all.filter((param) => !SHELL_COMMAND_KEYS.includes(param.key));
    return {
      pairs: [command, ...rest.slice(0, limit)],
      hidden: Math.max(0, rest.length - limit),
      title: [view.command, ...rest.map((param) => param.title)].join(' ')
    };
  }
  return {
    pairs: all.slice(0, limit),
    hidden: Math.max(0, all.length - limit),
    title: all.map((param) => param.title).join(' ')
  };
}

/** 一行的完整说明（读屏 / hover 用）：工具名 + 全部参数。 */
export function toolRowTitle(name: string, line: ToolRowLine): string {
  return line.title === '' ? name : `${name} ${line.title}`;
}

/** 聚合组头：「read ×4」。count ≤ 1 时没有组，返回空串。 */
export function toolRunChip(kind: ToolRowKind, count: number): string {
  return count > 1 ? `${kind} ×${count}` : '';
}

/** 判断「相邻两行算不算同一堆」用的最小信息。 */
export interface ToolRowProbe {
  readonly kind: ToolRowKind;
  /** null = 还在跑（不知道成不成）。 */
  readonly ok: boolean | null;
}

/**
 * 聚合规则（三条，缺一不可）：
 * 1. 同类才聚（read 后面跟 read）；换类就断，read 后面跟 grep 是两组。
 * 2. 失败的不聚：自己失败就单开一行，前一行失败也不接。
 * 3. 还在跑的（ok === null）按没失败算——它多半会和前面并到一起。
 */
export function continuesRun(prev: ToolRowProbe | null, next: ToolRowProbe): boolean {
  if (prev === null) return false;
  if (prev.ok === false || next.ok === false) return false;
  return prev.kind === next.kind;
}

/** 这一行是不是一组的开头。 */
export function startsRun(prev: ToolRowProbe | null, self: ToolRowProbe): boolean {
  return !continuesRun(prev, self);
}

/**
 * 从自己往后数这一组有几行（含自己）。`following` 是后面每一行的探针，
 * 不是工具行（文字、子代理、问话）就是 null —— 它同样会打断这一组。
 * 传生成器就只读到断点为止，不会把整个时间线扫完。
 */
export function runLength(self: ToolRowProbe, following: Iterable<ToolRowProbe | null>): number {
  let count = 1;
  let chain = self;
  for (const probe of following) {
    if (probe === null || !continuesRun(chain, probe)) break;
    count += 1;
    chain = probe;
  }
  return count;
}
