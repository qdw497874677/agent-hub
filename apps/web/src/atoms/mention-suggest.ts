/**
 * 群聊输入框的 @ 补全：只放纯逻辑（光标前的 token、候选、插入结果），
 * messages.tsx 只管渲染和键盘。
 *
 * 触发规则跟后端 `packages/domain/src/groups.ts` 解析 @ 的口径对齐：
 * @ 前必须是行首或非 [\w@.] 的字符（所以 `a@b` 这种邮箱不会弹），
 * 名字只收 [A-Za-z0-9_-]，和 bot 的 @id 一样最长 40。
 *
 * 注意：这份逻辑只管群聊里的「点名」，工作台 composer 的文件 @（attachments.ts）不走这里。
 */
export const MENTION_MAX = 40;
export const SUGGEST_LIMIT = 8;
const WORD = /[A-Za-z0-9_-]/;
const BLOCKS_AT = /[\w@.]/;

/** 光标前的 `@xxx`：start 是 `@` 的位置，end 是这段名字之后（插入时整段替换）。 */
export interface MentionRange {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

/** 群成员：name 是 @ 的 handle，label 是给人看的显示名。 */
export interface MentionMember {
  readonly name: string;
  readonly label?: string;
  readonly host?: boolean;
  readonly held?: boolean;
}

export type MentionKind = 'member' | 'all' | 'user';

export interface MentionItem {
  readonly kind: MentionKind;
  readonly token: string;
  readonly label: string;
  /** 「主持人」「已暂停」这类角标；没有就不显示。 */
  readonly note?: string;
}

/** 特殊项排在成员后面：@all 全体，@user 指人（自己）。 */
const SPECIALS: readonly MentionItem[] = [
  { kind: 'all', token: 'all', label: '全体' },
  { kind: 'user', token: 'user', label: '我' }
];

/** 光标前最后一段 `@xxx`；不满足触发条件就是 null。 */
export function mentionRange(text: string, caret: number): MentionRange | null {
  const pos = Math.max(0, Math.min(caret, text.length));
  let wordStart = pos;
  while (wordStart > 0 && WORD.test(text[wordStart - 1]!)) wordStart -= 1;
  if (text[wordStart - 1] !== '@') return null;
  const at = wordStart - 1;
  // 名字里的字符之前还要再往前一格：`a@b`、`x.@y` 都不算点名
  if (at > 0 && BLOCKS_AT.test(text[at - 1]!)) return null;
  let wordEnd = pos;
  while (wordEnd < text.length && WORD.test(text[wordEnd]!)) wordEnd += 1;
  const query = text.slice(wordStart, pos);
  if (query.length > MENTION_MAX) return null;
  return { start: at, end: wordEnd, query };
}

/**
 * 候选：成员先按前缀匹（名字或显示名），再按包含匹；特殊项放最后。
 * query 为空就是刚打完 `@`，成员按群里顺序全排。
 */
export function mentionItems(members: readonly MentionMember[], query: string, limit = SUGGEST_LIMIT): MentionItem[] {
  const q = query.toLowerCase();
  const ranked: { rank: number; order: number; item: MentionItem }[] = [];
  members.forEach((m, order) => {
    const name = m.name.toLowerCase();
    const label = (m.label ?? m.name).toLowerCase();
    const prefix = name.startsWith(q) || label.startsWith(q);
    if (!prefix && !(name.includes(q) || label.includes(q))) return;
    const notes = [m.host ? '主持人' : '', m.held ? '已暂停' : ''].filter((x) => x !== '');
    ranked.push({
      rank: prefix ? 0 : 1,
      order,
      item: { kind: 'member', token: m.name, label: m.label ?? m.name, ...(notes.length ? { note: notes.join(' · ') } : {}) }
    });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
  const specials = SPECIALS.filter((s) => q === '' || s.token.startsWith(q) || s.label.includes(q));
  return [...ranked.map((x) => x.item), ...specials].slice(0, Math.max(0, limit));
}

/**
 * 把 `@xxx` 换成选中的名字，后面补一个空格，光标停在空格之后。
 * 名字后面本来就有空格就不再补第二个。
 */
export function insertMention(text: string, range: MentionRange, token: string): { text: string; caret: number } {
  const rest = text.slice(range.end);
  const pad = rest === '' || !/^[ \t\n]/.test(rest) ? ' ' : '';
  const head = `${text.slice(0, range.start)}@${token}${pad}`;
  // 名字后面总是停在空格之后：自己补的那个，或者本来就有的那个
  return { text: `${head}${rest}`, caret: range.start + token.length + 2 };
}

/** 上下键：到头绕回去。 */
export function stepMention(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}
