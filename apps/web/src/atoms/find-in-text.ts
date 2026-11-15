/**
 * 会话内搜索的纯逻辑：切片段、算命中位置、数命中。
 *
 * 这里不碰 DOM——怎么在页面上高亮、怎么滚到命中处，都在 `find-in-session.tsx`。
 * 单独放一份是因为「大小写不敏感」「空查询不算命中」这类规则最容易在改渲染时被悄悄改坏，
 * 而它们只靠人眼看是看不出来的：一串中文里藏一个大小写不同的英文词，谁也发现不了。
 */

export interface TextMatch {
  readonly start: number;
  /** 不含：`text.slice(start, end)` 就是命中的那几个字。 */
  readonly end: number;
}

export interface TextSegment {
  readonly text: string;
  /** 这一段是不是命中。相邻片段一定一真一假地交替。 */
  readonly hit: boolean;
}

export interface FindResult {
  readonly segments: readonly TextSegment[];
  readonly count: number;
}

/**
 * 逐字符小写化，保证和原文等长。
 *
 * `'İ'.toLowerCase()` 会变成两个码元，直接拿小写串去 `indexOf` 会让后面的偏移全部错位，
 * 切出来的片段就会歪。真的碰上这种字符就退回区分大小写——宁可少一处命中，也别高亮错位置。
 */
function lowerSameLength(text: string): string {
  const lowered = text.toLowerCase();
  return lowered.length === text.length ? lowered : text;
}

/**
 * 大小写不敏感、互不重叠地找出 query 在 text 里出现的每一处。
 * 空查询没有任何命中（不是「命中全部」）——搜索框刚打开时不该把整段对话都刷亮。
 */
export function findMatches(text: string, query: string): TextMatch[] {
  if (query === '') return [];
  const haystack = lowerSameLength(text);
  const needle = lowerSameLength(query);
  // 小写化没能保持等长（见上）：偏移不可信，就按原样比一次。
  if (needle.length !== query.length || haystack.length !== text.length) {
    const exact: TextMatch[] = [];
    let from = 0;
    while (from <= text.length - query.length) {
      const at = text.indexOf(query, from);
      if (at < 0) break;
      exact.push({ start: at, end: at + query.length });
      from = at + query.length;
    }
    return exact;
  }
  const matches: TextMatch[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    matches.push({ start: at, end: at + needle.length });
    from = at + needle.length;
  }
  return matches;
}

/**
 * 把一段纯文本切成「命中 / 非命中」交替的片段，顺带报命中数。
 * 原文的大小写和标点原封不动地留在片段里——片段是拿去渲染的，不是拿去做匹配的。
 */
export function findInText(text: string, query: string): FindResult {
  const matches = findMatches(text, query);
  if (matches.length === 0) {
    return { segments: text === '' ? [] : [{ text, hit: false }], count: 0 };
  }
  const segments: TextSegment[] = [];
  let at = 0;
  for (const match of matches) {
    if (match.start > at) segments.push({ text: text.slice(at, match.start), hit: false });
    segments.push({ text: text.slice(match.start, match.end), hit: true });
    at = match.end;
  }
  if (at < text.length) segments.push({ text: text.slice(at), hit: false });
  return { segments, count: matches.length };
}

/** 多条文本（一页里的每个文本节点）共命中多少处。 */
export function countHits(texts: readonly string[], query: string): number {
  if (query === '') return 0;
  let total = 0;
  for (const text of texts) total += findMatches(text, query).length;
  return total;
}

/**
 * 在第 count 个命中里前后挪一格，到头绕回另一端。
 * `current` 为 -1 表示「还没选中任何一条」：往后从第一条开始，往前从最后一条开始。
 */
export function stepMatch(current: number, count: number, delta: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta >= 0 ? 0 : count - 1;
  return ((current + delta) % count + count) % count;
}

export interface TypingTargetLike {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
}

/**
 * 焦点是不是在能打字的地方。⌘F 在输入框里要留给浏览器自己——
 * 用户可能正在 composer 里改一句话，半路被搜索条抢走焦点会很恼人。
 */
export function isTypingTarget(target: unknown): boolean {
  if (target === null || typeof target !== 'object') return false;
  const node = target as TypingTargetLike;
  if (node.isContentEditable === true) return true;
  const tag = node.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
