import type { Seq } from './ids.ts';
import type { StoredAttachment } from './attachment.ts';

/**
 * 归一化事件。加变体要改这份文件并过 ADR：
 * 变体数就是新 agent 的映射成本，它直接决定「新增 agent 零内核改动」的成本。
 *
 * 十一个变体（ADR 0020 加了两个旁路的 context_usage / compaction，ADR 0023 加了旁路的 approval），其中九个来自 agent（adapter 负责映射），`prompt` 来自平台自己——
 * 用户说了什么必须留在 journal 里，否则重开浏览器后一半对话是空的。
 * 见 ADR 0006。
 */
export const SESSION_EVENT_KINDS = [
  'prompt',
  'text',
  'thinking',
  'tool_call',
  'tool_result',
  'artifact',
  'ended',
  'diagnostic',
  'context_usage',
  'compaction',
  'approval'
] as const;

export type SessionEvent =
  | {
      readonly kind: 'prompt';
      readonly text: string;
      /** 附件只留元数据；没带附件的老事件没有这个字段。 */
      readonly attachments?: readonly StoredAttachment[];
      /** 谁说的（登录态下才有；老事件没有 = 不知道）。 */
      readonly author?: { readonly id: string; readonly name: string; /** 经开放 API 令牌发的：令牌名（ADR 0015）。 */ readonly via?: string };
    }
  | { readonly kind: 'text'; readonly delta: string }
  /** 模型的思考过程（推理文字）。只进专注对话，默认折叠；卡片不渲染。 */
  | { readonly kind: 'thinking'; readonly delta: string }
  | { readonly kind: 'tool_call'; readonly name: string; readonly input: string }
  | {
      readonly kind: 'tool_result';
      readonly name: string;
      readonly ok: boolean;
      readonly durationMs: number;
      /** 工具的输出（截断到 TOOL_OUTPUT_LIMIT）。老事件和不报输出的 agent 没有这个字段。 */
      readonly output?: string;
    }
  | { readonly kind: 'artifact'; readonly path: string; readonly bytes: number }
  | {
      readonly kind: 'ended';
      readonly outcome: 'done' | 'stopped' | 'interrupted' | 'failed';
      readonly reason?: string;
    }
  | { readonly kind: 'diagnostic'; readonly level: 'info' | 'warn' | 'error'; readonly text: string }
  /**
   * 运行时报上来的上下文用量（ADR 0020 L1）。旁路状态：不进卡片、不改会话状态。
   * `usedTokens` / `percent` 为 null = 刚压缩完、运行时还没有新数。
   */
  | { readonly kind: 'context_usage'; readonly usedTokens: number | null; readonly windowTokens: number; readonly percent: number | null }
  /** 运行时原生压缩（ADR 0020 StrategyEvent.compacted 的落地形状）。start / end 各一条；失败时 ok=false。 */
  | {
      readonly kind: 'compaction';
      readonly phase: 'start' | 'end';
      readonly reason: 'manual' | 'threshold' | 'overflow';
      readonly ok?: boolean;
      readonly tokensBefore?: number;
      readonly tokensAfter?: number;
      readonly summary?: string;
      readonly error?: string;
    }
  /**
   * 运行时要人批准一个动作（ADR 0023）。request 推一张「允许 / 拒绝」卡；resolved 收掉它。
   * 超时 = 拒绝（运行时侧的 ApprovalGate 计时，hub 和网页都不在线也照样收尾）。旁路：不改会话状态。
   */
  | {
      readonly kind: 'approval';
      readonly phase: 'request' | 'resolved';
      /** 这次请求的 id（运行时内唯一）；回答时原样带回。 */
      readonly id: string;
      /** request：一句话说要干什么（命令、动作）。 */
      readonly title?: string;
      readonly detail?: string;
      /** request：过了这个时间点（epoch ms）还没回答就当拒绝。 */
      readonly expiresAt?: number;
      /** resolved：结论。 */
      readonly decision?: 'allow' | 'deny';
      /** resolved：谁定的——人点的、超时、运行时自己撤了。 */
      readonly by?: 'user' | 'timeout' | 'runtime';
      readonly author?: { readonly id: string; readonly name: string };
    };

/** 旁路事件：只记账，不算对话内容，也不算「有动静」。 */
export function isSideChannel(event: SessionEvent): boolean {
  return event.kind === 'diagnostic' || event.kind === 'context_usage' || event.kind === 'compaction' || event.kind === 'approval';
}

/** 画布卡片默认渲染的事件。diagnostic 只进事件流抽屉，prompt 只在专注对话里露脸。 */
export const CARD_EVENT_KINDS = ['text', 'tool_call', 'tool_result', 'artifact'] as const;

export function showsOnCard(event: SessionEvent): boolean {
  return !isSideChannel(event) && event.kind !== 'ended' && event.kind !== 'prompt';
}

export interface JournalEntry {
  readonly seq: Seq;
  readonly event: SessionEvent;
  readonly at: number;
}

/** 工具输出进 journal 前截到这么长（字符）：看个究竟够了，不让一次 cat 大文件撑爆数据库。 */
export const TOOL_OUTPUT_LIMIT = 16_000;

export function clipToolOutput(text: string): string {
  return text.length <= TOOL_OUTPUT_LIMIT ? text : `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n…（还有 ${text.length - TOOL_OUTPUT_LIMIT} 个字符没有保存）`;
}
