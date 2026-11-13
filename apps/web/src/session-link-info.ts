import type { SessionDto } from '@agent-hub/contract';

/**
 * 输入框上方「已连接会话」芯片点开后，小窗里该说什么话。
 *
 * 纯函数，只做「数据 → 文案」这一件事：会话名怎么取（和芯片上那行一致）、
 * 运行时怎么拼、首句要不要重复显示、分叉自谁。时间只给毫秒数，
 * 相对时间交给界面那一侧算（依赖 now，不该塞进纯逻辑里）。
 */
export interface SessionLinkInfo {
  readonly id: string;
  /** 会话名：起过名用名字，没起名用首句，再没有才「未命名会话」。 */
  readonly name: string;
  readonly status: SessionDto['status'];
  /** 状态位用它区分「运行中」和「就绪」（running + 还没说过话）。 */
  readonly lastSeq: number;
  /** 谁在跑什么：agent 显示名（没有就落回 id）· model。 */
  readonly runtime: string;
  /** 首句摘要；已经拿首句当名字时不再重复。 */
  readonly preview: string | null;
  /** 「分叉自「…」」；不是分叉时为 null。 */
  readonly forkedFrom: string | null;
  readonly updatedAt: number;
}

/** 摘要最多留这么多字，剩下的交给 CSS 单行截断。 */
const PREVIEW_CHARS = 160;

function tidy(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function clip(text: string): string {
  return text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS - 1)}…`;
}

/** 会话名：起过名用名字，没起名用首句，再没有才「未命名会话」。列表、芯片、删除确认共用这一套。 */
export function sessionDisplayName(
  title: string | null | undefined,
  opening: string | null | undefined
): string {
  return tidy(title) || tidy(opening) || '未命名会话';
}

export function sessionLinkInfo(input: {
  readonly session: SessionDto;
  /** canvas.openings[id]：这条会话开口说的第一句。 */
  readonly opening?: string | null;
  /** agent 的显示名；拿不到就传空，落回 agentId。 */
  readonly agentLabel?: string | null;
  /** 分叉来源会话的名字；不是分叉传 null。 */
  readonly forkedFromName?: string | null;
}): SessionLinkInfo {
  const { session } = input;
  const title = tidy(session.title);
  const opening = tidy(input.opening);
  const runtime = [tidy(input.agentLabel) || session.agentId, session.model.trim()].filter(Boolean).join(' · ');
  // 首句已经在当名字用，就不再在下面重复一遍；同名标题同理。
  const preview = title !== '' && opening !== '' && opening !== title ? clip(opening) : null;
  const source = session.origin.kind === 'fork' ? tidy(input.forkedFromName) || '来源会话' : null;
  return {
    id: session.id,
    name: sessionDisplayName(session.title, input.opening),
    status: session.status,
    lastSeq: session.lastSeq,
    runtime,
    preview,
    forkedFrom: source === null ? null : `分叉自「${source}」`,
    updatedAt: session.updatedAt
  };
}
