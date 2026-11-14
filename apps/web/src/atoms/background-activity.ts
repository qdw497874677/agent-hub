import type { SessionDto } from '@agent-hub/contract';
import type { Block } from './live-core.ts';

/**
 * 「这一轮答完了，可后台还有东西在跑」——会话保活之后才有的状态
 *（docs/design/session-keepalive.md §3.3）。
 *
 * 回合结束时 agent 进程不跟着退，`task` 派出去的子代理继续跑，事件照旧写进 journal、
 * 推给前端。会话状态却已经是 done 了：光看状态点，人会以为它已经停手。
 *
 * 这里只做判断，不碰 DOM、不碰网络、不轮询——时间由调用方给（`now`），
 * 块到达的时刻也由调用方打（`at`），所以能在 node:test 里直接测。
 */

/** 多久没有新输出就当「后台任务大概已经结束了」。 */
export const BACKGROUND_QUIET_MS = 60_000;

/**
 * 判定用的块。
 *
 * 真实块只取 `kind`；`ended` 不是画面上会渲染的块，而是「这一轮到这儿就结束了」的标记——
 * 回合结束后还有块，才说明后台还在动。标记由调用方按 seq 顺序插进来
 * （见 use-background-activity.ts）：块序列本身没有时间，也没有 ended 块。
 */
export interface ActivityBlock {
  readonly kind: Block['kind'] | 'ended';
  /** 客户端看见这一块的时间（毫秒）。刷新后从 journal 播种的块没有，不参与计时。 */
  readonly at?: number;
}

export interface BackgroundActivity {
  /** 后台还有活动：状态已经不是 running，但回合结束后又来了块。 */
  readonly active: boolean;
  /** 回合结束之后来的输出块数（文本 / 工具 / 子代理）。 */
  readonly count: number;
  /** 最后一块到达的时间；一块都没有、或都没有时间戳就是 null。 */
  readonly lastAt: number | null;
  /** 超过 quietMs 没有新块：还在 active，但更像是进程没来得及回收。 */
  readonly quiet: boolean;
}

/** 只有这三类算「后台在干活」：提示词、附件、批准卡、思考过程都不算输出。 */
const COUNTED: ReadonlySet<string> = new Set(['text', 'tool', 'subagent']);

const IDLE: BackgroundActivity = { active: false, count: 0, lastAt: null, quiet: false };

export function backgroundActivity(
  blocks: readonly ActivityBlock[],
  status: SessionDto['status'],
  now: number,
  quietMs: number = BACKGROUND_QUIET_MS
): BackgroundActivity {
  // 回合还在跑：状态点自己会说，不用再挂一条。
  if (status === 'running') return IDLE;

  // 最后一条 ended 标记之后才是「回合结束之后」；标记之前的块都属于上一轮。
  let boundary = -1;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]?.kind === 'ended') {
      boundary = index;
      break;
    }
  }
  if (boundary < 0) return IDLE;

  const after = blocks.slice(boundary + 1);
  if (after.length === 0) return IDLE;

  let count = 0;
  for (const block of after) if (COUNTED.has(block.kind)) count += 1;

  const lastAt = lastStamp(blocks);
  // 没有时间戳（刷新后才知道的会话）就按「可能已经结束」说话：不假装刚刚还在动。
  const quiet = lastAt === null || now - lastAt > quietMs;
  return { active: true, count, lastAt, quiet };
}

/** 最后一块的到达时间：标记本身也算——回合刚结束、还没有后续块时，它是新的。 */
function lastStamp(blocks: readonly ActivityBlock[]): number | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const at = blocks[index]?.at;
    if (typeof at === 'number') return at;
  }
  return null;
}

export interface BackgroundActivityText {
  /** 一行字：「后台任务还在跑 · 12 秒前」。 */
  readonly text: string;
  /** 鼠标悬停的补充（桌面）：到底收到多少、多久没动静。不悬停也读得懂。 */
  readonly detail: string;
}

/**
 * 这条状态行该写什么；不该显示时返回 null。
 *
 * 取舍：安静之后不说「跑完了」，只说「可能已结束」——进程还在不在，前端看不见。
 */
export function backgroundActivityText(activity: BackgroundActivity, now: number): BackgroundActivityText | null {
  if (!activity.active) return null;
  const elapsed = activity.lastAt === null ? null : Math.max(0, now - activity.lastAt);
  const ago = elapsed === null ? null : shortAgo(elapsed);
  if (activity.quiet) {
    return {
      text: '后台任务可能已结束',
      detail: ago === null ? '一段时间没有新输出，子代理进程可能已经结束。' : `${ago.replace('前', '')}没有新输出，子代理进程可能已经结束。`
    };
  }
  return {
    text: `后台任务还在跑 · ${ago ?? '刚刚'}`,
    detail: activity.count > 0 ? `回合结束后又收到 ${activity.count} 条输出。` : '回合结束后又来了新事件。'
  };
}

/** 「刚刚 / 12 秒前 / 已 3 分钟」：够读，不用精确到毫秒。 */
function shortAgo(ms: number): string {
  if (ms < 2_000) return '刚刚';
  if (ms < 60_000) return `${Math.min(59, Math.round(ms / 1_000))} 秒前`;
  return `已 ${Math.round(ms / 60_000)} 分钟`;
}
