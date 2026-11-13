import type { BotTriggerDto, BotTriggerSourceDto } from '@agent-hub/contract';
import { stampText } from './bot-credential.ts';

/**
 * bot 编辑页的「触发器」区块（只读）：文案和相对时间的纯函数都放这里，好配单测。
 * 创建 / 暂停仍在连接器页，这里只负责把 `GET /api/bots/:id/triggers` 讲成人话。
 */

export const BOT_TRIGGERS_EMPTY = '还没有触发器';
export const BOT_TRIGGERS_EMPTY_HINT = '触发器在连接器页里挂到 bot 上。';

/** run 状态的中文说法（和连接器页同一套）。 */
export const TRIGGER_RUN_LABEL: Record<BotTriggerDto['runs'][number]['state'], string> = {
  waiting: '等待中',
  delivered: '已投递',
  done: '完成',
  failed: '失败',
  timeout: '超时',
  skipped: '跳过'
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 相对时间：未来「3 分钟后」，刚过去「3 分钟前」，跨一天说「明天 / 昨天」。
 * 超过一周直接给日期（`stampText`），免得出现「41 天后」这种没法核对的数。
 */
export function relativeDay(at: number, now: number): string {
  const gap = at - now;
  const ahead = gap >= 0;
  const abs = Math.abs(gap);
  if (abs < MINUTE) return ahead ? '马上' : '刚刚';
  if (abs < HOUR) return `${Math.floor(abs / MINUTE)} 分钟${ahead ? '后' : '前'}`;
  if (abs < DAY) return `${Math.floor(abs / HOUR)} 小时${ahead ? '后' : '前'}`;
  if (abs < 7 * DAY) {
    const days = Math.floor(abs / DAY);
    if (days === 1) return ahead ? '明天' : '昨天';
    return `${days} 天${ahead ? '后' : '前'}`;
  }
  return stampText(at);
}

export type TriggerStateTone = 'on' | 'paused' | 'off';

/** 状态徽标：暂停优先（暂停的绑定 enabled 可能还是 true）。 */
export function triggerStateView(t: Pick<BotTriggerDto, 'enabled' | 'pausedReason'>): {
  readonly label: string;
  readonly tone: TriggerStateTone;
} {
  if (t.pausedReason) return { label: '已暂停', tone: 'paused' };
  if (t.enabled) return { label: '启用', tone: 'on' };
  return { label: '已停用', tone: 'off' };
}

export type TriggerNextTone = 'scheduled' | 'overdue' | 'paused' | 'idle';

export interface TriggerNextView {
  /** 句首用词：「下次 3 分钟后」/「该跑了 3 分钟前」。暂停 / 没排期时为空。 */
  readonly prefix: string;
  /** 相对时间，或「暂停期间不再唤醒」「还没排期」「已停用」。 */
  readonly text: string;
  readonly tone: TriggerNextTone;
}

/** 下次运行：说人话而不是给时间戳；过了点也照样给相对时间。 */
export function nextRunView(t: Pick<BotTriggerDto, 'enabled' | 'pausedReason' | 'nextRunAt'>, now: number): TriggerNextView {
  if (t.pausedReason) return { prefix: '', text: '暂停期间不再唤醒', tone: 'paused' };
  if (!t.enabled) return { prefix: '', text: '已停用', tone: 'idle' };
  if (t.nextRunAt === null) return { prefix: '', text: '还没排期', tone: 'idle' };
  const overdue = t.nextRunAt < now;
  return {
    prefix: overdue ? '该跑了' : '下次',
    text: relativeDay(t.nextRunAt, now),
    tone: overdue ? 'overdue' : 'scheduled'
  };
}

/** 来源：`connector · kind`，例如 `github · issue`；窄屏靠 break-words 断行。 */
export function sourceText(
  t: Pick<BotTriggerDto, 'connector' | 'kind'>,
  sources: readonly BotTriggerSourceDto[] = []
): string {
  const label = sources.find((source) => source.id === t.connector)?.label;
  return `${label ?? t.connector} · ${t.kind}`;
}

/** 最近一次 run：按 created 取最大，不假设后端已排好序。 */
export function latestRun(runs: readonly BotTriggerDto['runs'][number][]): BotTriggerDto['runs'][number] | null {
  return runs.reduce<BotTriggerDto['runs'][number] | null>(
    (best, run) => (best === null || run.createdAt >= best.createdAt ? run : best),
    null
  );
}

/** 一条 run 的一句话结果：「完成 · 3 分钟前」，原因由调用方另起一段。 */
export function runView(run: BotTriggerDto['runs'][number], now: number): string {
  return `${TRIGGER_RUN_LABEL[run.state]} · ${relativeDay(run.plannedAt ?? run.createdAt, now)}`;
}
