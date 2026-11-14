import type { Block } from './live-core.ts';

/**
 * 群聊「实时」的纯逻辑：表情反应聚合 / 切换、增量草稿拼装、草稿撤销条件、正在输入文案。
 *
 * 这里不碰 DOM、不碰网络，所以能在 node:test 里直接测（group-live.test.ts）；
 * 组件只负责画（group-reactions.tsx / group-draft.tsx / group-typing.tsx），
 * 接线在 `surfaces/im/messages.tsx`。契约见 docs/design/group-live.md §6。
 */

/** 允许的表情：与后端白名单同一份（docs/design/group-live.md §3），顺序就是面板里的顺序。 */
export const GROUP_EMOJI = ['👍', '👀', '🎉', '✅', '❤️', '😄', '🤔'] as const;

export interface GroupActor {
  readonly kind: 'user' | 'agent';
  readonly name: string;
}

export interface GroupReaction {
  readonly emoji: string;
  readonly actors: readonly GroupActor[];
}

/**
 * 当前用户在反应里的名字。
 *
 * 和帖子作者名同源（`displayName || email`，见 groups.ts:584）：反应 actor 只有 kind + name，
 * 没有 id，所以「我点过没有」只能按名字比。拿不到名字就是 null——不能乐观地加一个无名反应。
 */
export type MyName = string | null;

/** 这个表情我点过没有。 */
export function mineOf(reaction: GroupReaction, me: MyName): boolean {
  return me !== null && reaction.actors.some((actor) => actor.kind === 'user' && actor.name === me);
}

/**
 * 点一下 chip 的意图：我点过就撤，没点过就加。
 * 返回要发的请求动作 + 乐观更新后的列表（界面先动，服务端回来再以它为准）。
 */
export function toggleReaction(
  reactions: readonly GroupReaction[],
  emoji: string,
  me: MyName
): { action: 'add' | 'remove'; reactions: GroupReaction[] } {
  const current = reactions.find((reaction) => reaction.emoji === emoji);
  const mine = current !== undefined && mineOf(current, me);
  const action: 'add' | 'remove' = mine ? 'remove' : 'add';
  if (me === null) return { action, reactions: [...reactions] };
  return { action, reactions: mergeReaction(reactions, emoji, { kind: 'user', name: me }, action === 'add') };
}

/**
 * 把一个人的反应合进聚合列表：on = 加、off = 撤。
 * 同一个 emoji 只出现一次（顺序按首次出现），撤空了就把这个 emoji 整条去掉；
 * 已经是目标状态时返回等值的新数组，调用方照常写缓存也不会出错。
 */
export function mergeReaction(
  reactions: readonly GroupReaction[],
  emoji: string,
  actor: GroupActor,
  on: boolean
): GroupReaction[] {
  const index = reactions.findIndex((reaction) => reaction.emoji === emoji);
  const same = (other: GroupActor): boolean => other.kind === actor.kind && other.name === actor.name;
  if (index < 0) return on ? [...reactions, { emoji, actors: [actor] }] : [...reactions];
  const found = reactions[index]!;
  const has = found.actors.some(same);
  if (has === on) return [...reactions];
  const actors = on ? [...found.actors, actor] : found.actors.filter((other) => !same(other));
  if (actors.length === 0) return reactions.filter((_, i) => i !== index);
  return reactions.map((reaction, i) => (i === index ? { emoji: reaction.emoji, actors } : reaction));
}

/**
 * 草稿正文：最后一条 prompt 之后的 `text` 增量拼起来；思考 / 工具调用不算说话。
 * 还没有 prompt（会话是打开的、这一轮不是从它开始的）或拼出来是空白就是 null。
 */
export function draftText(blocks: readonly Block[]): string | null {
  let start = -1;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i]?.kind === 'prompt') {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const text = blocks
    .slice(start + 1)
    .map((block) => (block.kind === 'text' ? block.text : ''))
    .join('')
    .trim();
  return text === '' ? null : text;
}

/** 判定草稿可见性需要的最小帖子形状（不绑 DTO，单测里造两条就够）。 */
export interface DraftPost {
  readonly round: number;
  readonly author: { readonly kind: 'user' | 'agent' | 'system'; readonly role?: string };
}

/**
 * 草稿还该不该显示：同一个成员在同一轮的正式帖子出现了，就换成正式帖子。
 * 只比 agent 帖子——人说的话不会顶掉成员的草稿。
 */
export function draftVisible({ role, round, posts }: { role: string; round: number; posts: readonly DraftPost[] }): boolean {
  return !posts.some((post) => post.author.kind === 'agent' && post.author.role === role && post.round === round);
}

/** 「正在输入」的成员（`GroupViewDto.typing` 的子集，只取用得到的字段）。 */
export interface TypingMember {
  readonly role: string;
  readonly sessionId: string;
  readonly since: number;
}

/** 一个有内容的草稿：谁在写、写在哪条会话、写到哪了。 */
export interface LiveDraft {
  readonly role: string;
  readonly sessionId: string;
  readonly body: string;
}

/**
 * 从 `typing` + 会话流里挑出此刻能显示的草稿。
 * `blocksOf` 由调用方提供（`live[sessionId]?.blocks ?? []`），这里不认识 LiveMap。
 */
export function liveDrafts({
  typing,
  blocksOf,
  round,
  posts
}: {
  typing: readonly TypingMember[];
  blocksOf: (sessionId: string) => readonly Block[];
  round: number;
  posts: readonly DraftPost[];
}): LiveDraft[] {
  const drafts: LiveDraft[] = [];
  for (const member of typing) {
    if (!draftVisible({ role: member.role, round, posts })) continue;
    const body = draftText(blocksOf(member.sessionId));
    if (body !== null) drafts.push({ role: member.role, sessionId: member.sessionId, body });
  }
  return drafts;
}

/** 还没出草稿的成员：这些只进「正在输入」那一行，不再重复画气泡。 */
export function typingRoles(typing: readonly TypingMember[], drafts: readonly LiveDraft[]): string[] {
  const drafted = new Set(drafts.map((draft) => draft.sessionId));
  return typing.filter((member) => !drafted.has(member.sessionId)).map((member) => member.role);
}

/** 一行「正在输入」：最多列三个名字，再多就写「A、B 等 N 人」。空数组就是 null（不占位）。 */
export function typingLine(roles: readonly string[]): string | null {
  const names = [...new Set(roles.map((role) => role.trim()).filter((role) => role !== ''))];
  if (names.length === 0) return null;
  if (names.length <= 3) return `${names.join('、')} 正在输入…`;
  return `${names.slice(0, 2).join('、')} 等 ${names.length} 人正在输入…`;
}
