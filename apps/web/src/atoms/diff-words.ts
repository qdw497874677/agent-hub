/**
 * 会话里 diff 的词级高亮、行号、gutter 宽度：纯函数，不碰 DOM（diff-words.test.ts）。
 *
 * 两条硬约束：
 * - **只算一次**：`analyzeDiff` 的入参是解析好的行（渲染层用 `useMemo` 记住结果），
 *   行数超过 `MAX_PAIR_LINES`（2000）就整体退回整行底色——逐字比较是 O(行 × 行长²)，
 *   两千行往上的 diff 再滚一滚就会卡，宁可少一层高亮。
 * - **行号以 hunk 头为准**：`@@ -a,b +c,d @@` 里的起点就是老 / 新文件的行号。
 *   没有 hunk 头的片段（工具参数里的 old / new 文本）从 1 数起，是「片段内的相对行号」，
 *   不是文件里的真实行号；这时不猜文件位置。
 */

import type { DiffLine } from './tool-format.ts';

/** 一行字里的一段：没变的部分照旧，变了的加底色。 */
export interface WordSegment {
  readonly text: string;
  readonly changed: boolean;
}

/**
 * 一行怎么画：
 * - `null`：没参与配对（上下文行、单独的增 / 删块），保持原来那层整行底色；
 * - `'whole'`：配对时多出来的行（`-` 块 3 行、`+` 块 1 行，多出的 2 行），整行加深；
 * - 分段数组：只把真正变化的字加深。
 */
export type LineHighlight = readonly WordSegment[] | 'whole' | null;

/** 一行在旧 / 新文件里的行号；@@ 行、以及对面没有的那一侧是 null。 */
export interface DiffLineNumber {
  readonly old: number | null;
  readonly new: number | null;
}

export interface DiffRowInfo extends DiffLineNumber {
  readonly highlight: LineHighlight;
}

export interface DiffAnalysis {
  readonly rows: readonly DiffRowInfo[];
  /** 行号列的宽度（`3ch`），按最长行号算；没行号时也给 `1ch`，两栏才对得齐。 */
  readonly gutter: string;
}

/** 超过这么多行就不做逐字比较，整行底色兜底（见文件头）。 */
export const MAX_PAIR_LINES = 2000;

/** 单行这么长（压缩过的产物、base64）就不逐字比：比出来的东西没人看得懂，还慢。 */
const MAX_WORD_LINE_CHARS = 2000;

/** 中间那段做 DP 的格子上限；超了就先试剥公共后缀，还超就整段算「变了」。 */
const MAX_WORD_CELLS = 250_000;

const HUNK_START = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** hunk 头里的旧 / 新起点；认不出就 null（工具参数里的 `@@` 分隔线就是这样）。 */
function hunkStart(text: string): { old: number; new: number } | null {
  const match = HUNK_START.exec(text);
  if (!match) return null;
  return { old: Number(match[1]), new: Number(match[2]) };
}

/**
 * 每一行的旧 / 新行号。`-` 只占旧侧、`+` 只占新侧、上下文两边都占；
 * hunk 头把计数拨到它给的起点（多段 hunk 各自数各自的）。
 */
export function lineNumbers(lines: readonly DiffLine[]): DiffLineNumber[] {
  const out: DiffLineNumber[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const line of lines) {
    if (line.sign === '@') {
      const start = hunkStart(line.text);
      if (start) {
        oldNo = start.old;
        newNo = start.new;
      }
      out.push({ old: null, new: null });
      continue;
    }
    if (line.sign === '-') {
      out.push({ old: oldNo, new: null });
      oldNo += 1;
      continue;
    }
    if (line.sign === '+') {
      out.push({ old: null, new: newNo });
      newNo += 1;
      continue;
    }
    out.push({ old: oldNo, new: newNo });
    oldNo += 1;
    newNo += 1;
  }
  return out;
}

/** 加一段字；和上一段同色就接上去，空串丢掉。 */
function push(list: WordSegment[], text: string, changed: boolean): void {
  if (text === '') return;
  const last = list[list.length - 1];
  if (last !== undefined && last.changed === changed) list[list.length - 1] = { text: last.text + text, changed };
  else list.push({ text, changed });
}

/**
 * 两行逐字比较，给出两边各自的分段。
 *
 * 先剥掉公共前缀——前缀一定在最优对齐里，剥了不亏，还能让「改一个数字」这种常见情况
 * 只剩一两个字进 DP。后缀**不先剥**：`2;` → `20;` 这种插入紧贴公共尾巴，
 * 先把 `;` 剥掉就会退化成「删掉分号、加上 0;」，看着像多改了一处。
 * 只有中间长到会拖慢（压缩产物、base64）才连同后缀一起剥，剥完还长就整段算变。
 */
export function wordSegments(before: string, after: string): { readonly removed: readonly WordSegment[]; readonly added: readonly WordSegment[] } {
  const shorter = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shorter && before[prefix] === after[prefix]) prefix += 1;

  const headBefore = before.slice(prefix);
  const headAfter = after.slice(prefix);
  let suffix = 0;
  if (headBefore.length * headAfter.length > MAX_WORD_CELLS) {
    const limit = Math.min(headBefore.length, headAfter.length);
    while (suffix < limit && headBefore[headBefore.length - 1 - suffix] === headAfter[headAfter.length - 1 - suffix]) suffix += 1;
    if ((headBefore.length - suffix) * (headAfter.length - suffix) > MAX_WORD_CELLS) suffix = 0;
  }
  const midBefore = headBefore.slice(0, headBefore.length - suffix);
  const midAfter = headAfter.slice(0, headAfter.length - suffix);

  const removed: WordSegment[] = [];
  const added: WordSegment[] = [];
  push(removed, before.slice(0, prefix), false);
  push(added, after.slice(0, prefix), false);

  if (midBefore === '' || midAfter === '' || midBefore.length * midAfter.length > MAX_WORD_CELLS) {
    push(removed, midBefore, true);
    push(added, midAfter, true);
  } else {
    const n = midBefore.length;
    const m = midAfter.length;
    const width = m + 1;
    // dp[i * width + j] = midBefore[i..] 与 midAfter[j..] 的 LCS 长度
    const dp = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i * width + j] =
          midBefore[i] === midAfter[j] ? dp[(i + 1) * width + j + 1]! + 1 : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midBefore[i] === midAfter[j]) {
        push(removed, midBefore[i]!, false);
        push(added, midAfter[j]!, false);
        i += 1;
        j += 1;
      } else if (j >= m || (i < n && dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!)) {
        push(removed, midBefore[i]!, true);
        i += 1;
      } else {
        push(added, midAfter[j]!, true);
        j += 1;
      }
    }
  }

  push(removed, before.slice(before.length - suffix), false);
  push(added, after.slice(after.length - suffix), false);
  return { removed, added };
}

/**
 * 相邻的 `-` 块与 `+` 块按行数取最小配对，逐对做词级比较。
 * 多出来的行标 `'whole'`（整行加深）；没有配对对象的块（纯新增 / 纯删除）留 `null`，
 * 保持原来那层淡底色——否则整份新文件的 diff 会变成一整片深绿。
 */
export function pairLines(lines: readonly DiffLine[]): LineHighlight[] {
  const out: LineHighlight[] = lines.map(() => null);
  // 见文件头：超过 2000 行直接整行底色兜底
  if (lines.length > MAX_PAIR_LINES) return out;

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.sign !== '-') continue;
    let removedEnd = index;
    while (lines[removedEnd]?.sign === '-') removedEnd += 1;
    if (lines[removedEnd]?.sign !== '+') {
      // 删掉一块、后面不是增：没有配对对象
      index = removedEnd - 1;
      continue;
    }
    let addedEnd = removedEnd;
    while (lines[addedEnd]?.sign === '+') addedEnd += 1;

    const pairs = Math.min(removedEnd - index, addedEnd - removedEnd);
    for (let k = 0; k < pairs; k += 1) {
      const before = lines[index + k]!.text;
      const after = lines[removedEnd + k]!.text;
      if (before.length > MAX_WORD_LINE_CHARS || after.length > MAX_WORD_LINE_CHARS) {
        out[index + k] = 'whole';
        out[removedEnd + k] = 'whole';
        continue;
      }
      const segments = wordSegments(before, after);
      out[index + k] = segments.removed;
      out[removedEnd + k] = segments.added;
    }
    // 行数不等：多出来的整行加深
    for (let k = pairs; k < removedEnd - index; k += 1) out[index + k] = 'whole';
    for (let k = pairs; k < addedEnd - removedEnd; k += 1) out[removedEnd + k] = 'whole';
    index = addedEnd - 1;
  }
  return out;
}

/** 行号列宽：按最长行号算（`9` → `1ch`、`1200` → `4ch`）；没有行号也要 `1ch`。 */
export function gutterWidth(widest: number): string {
  const digits = String(Math.max(1, Math.trunc(widest))).length;
  return `${digits}ch`;
}

/** 渲染层要的全部东西：每行的行号 + 词级分段 + 行号列宽。一次算完。 */
export function analyzeDiff(lines: readonly DiffLine[]): DiffAnalysis {
  const numbers = lineNumbers(lines);
  const highlights = pairLines(lines);
  let widest = 0;
  for (const number of numbers) {
    if (number.old !== null && number.old > widest) widest = number.old;
    if (number.new !== null && number.new > widest) widest = number.new;
  }
  return { rows: numbers.map((number, index) => ({ ...number, highlight: highlights[index] ?? null })), gutter: gutterWidth(widest) };
}

/** shiki 的 token：只有正文和颜色，坐标全靠 content 依次拼起来。 */
export interface DiffToken {
  readonly content: string;
  readonly color?: string | undefined;
}

/** 切好的 token：颜色不变，位置对齐到词级分段的字符坐标。 */
export interface DiffTokenSlice {
  readonly content: string;
  readonly color?: string | undefined;
  readonly changed: boolean;
}

/**
 * 把 shiki 的 token 按词级分段的字符边界切开。
 *
 * 着色是拿整份代码一次性换来的 token，和「哪几个字变了」是两套坐标；
 * 按字符数依次消费 token 才不会错位——一节错了后面全行串色（回归过一次）。
 */
export function sliceTokens(tokens: readonly DiffToken[], segments: readonly WordSegment[]): readonly DiffTokenSlice[] {
  const out: DiffTokenSlice[] = [];
  let tokenIndex = 0;
  let offset = 0;
  for (const segment of segments) {
    let left = segment.text.length;
    while (left > 0) {
      const token = tokens[tokenIndex];
      if (token === undefined) {
        // 分段比 token 长（不该发生）：剩下的原样补上，别吞字
        out.push({ content: segment.text.slice(segment.text.length - left), changed: segment.changed });
        break;
      }
      const take = Math.min(left, token.content.length - offset);
      if (take > 0) {
        out.push({ content: token.content.slice(offset, offset + take), ...(token.color === undefined ? {} : { color: token.color }), changed: segment.changed });
        offset += take;
        left -= take;
      }
      if (offset >= token.content.length) {
        tokenIndex += 1;
        offset = 0;
      }
    }
  }
  return out;
}
