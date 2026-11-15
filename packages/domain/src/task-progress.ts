import type { TaskId } from './ids.ts';

/**
 * 任务进度（通用调用方反馈）。
 *
 * 任务不再只属于「群聊」：bot 会话、外部 IM、外部 MCP/HTTP 调用方都可能建任务，
 * 他们需要的都是同一件事——**任务现在到哪了，什么时候出结果**。
 *
 * 这里只放平台无关的规则：进度事件的形状、去噪节流、给人看的一行字。
 * 真正投给谁（群帖、送达队列、连接器 sink、HTTP/SSE 订阅）由组合根的适配器决定，
 * 领域不认任何具体渠道。
 */
export type TaskProgressKind = 'started' | 'milestone' | 'finished';

export interface TaskProgress {
  readonly taskId: TaskId;
  readonly sessionId: string | null;
  readonly kind: TaskProgressKind;
  readonly text: string;
  readonly at: number;
}

/** 两次自动进展之间至少隔这么久（agent 每个工具调用都报一次会淹掉群）。 */
export const PROGRESS_MIN_GAP_MS = 90_000;

/** 一个任务最多自动报几条进展；之后只报开始/结束（人工写入的工作日志不受限）。 */
export const PROGRESS_MAX_LINES = 8;

const TOOL_LABEL: Record<string, string> = {
  read: '读文件',
  write: '写文件',
  edit: '改文件',
  bash: '跑命令',
  grep: '搜代码',
  glob: '找文件',
  task: '起子代理'
};

/** 「正在用 bash…」这类一行话；工具名认不出就原样带上。 */
export function milestoneText(tool: string | null): string {
  const name = (tool ?? '').trim();
  if (name === '') return '在执行下一步';
  return `正在${TOOL_LABEL[name] ?? `用 ${name}`}`;
}

export interface ProgressBudget {
  /** 这一次要不要报？kind 为 started/finished 永远放行；milestone 受时间与条数限制。 */
  allow(taskId: string, kind: TaskProgressKind, at: number): boolean;
  /** 任务结束：清掉记账，任务 id 不会复用。 */
  reset(taskId: string): void;
}

export function createProgressBudget(options: { minGapMs?: number; maxLines?: number } = {}): ProgressBudget {
  const minGapMs = options.minGapMs ?? PROGRESS_MIN_GAP_MS;
  const maxLines = options.maxLines ?? PROGRESS_MAX_LINES;
  const state = new Map<string, { at: number; lines: number }>();
  return {
    allow(taskId, kind, at) {
      if (kind !== 'milestone') return true;
      const prev = state.get(taskId);
      if (prev === undefined) {
        state.set(taskId, { at, lines: 1 });
        return true;
      }
      if (prev.lines >= maxLines) return false;
      if (at - prev.at < minGapMs) return false;
      state.set(taskId, { at, lines: prev.lines + 1 });
      return true;
    },
    reset(taskId) {
      state.delete(taskId);
    }
  };
}
