import {
  asSessionId,
  asTaskId,
  createProgressBudget,
  milestoneText,
  newId,
  type TaskDispatch,
  type TaskProgressKind,
  type WorkLogRepository
} from '@agent-hub/domain';

/**
 * 任务进展的「谁在听」（组合根适配器）。
 *
 * 统一出口只有两个地方，和调用方是谁无关：
 * 1. 任务工作日志（`task_log_entries`）：外部 MCP / HTTP 调用方按 seq 轮询或订阅，代理也读得到；
 * 2. 来源会话所在的群：系统帖。
 *
 * bot 私聊来源不在这里刷屏：它的完成通知本来就由调度器的送达队列负责。
 * 连接器来源的 task.finished 由 `OutputSink` 负责；以后要补 task.progress 也接在这里。
 */
export interface TaskProgressDeps {
  readonly now: () => number;
  readonly workLog: WorkLogRepository;
  /** 来源会话在哪个群（不是群来源就返回 null）。 */
  readonly groupOfSession: (sessionId: string) => Promise<{ readonly groupId: string } | null>;
  readonly postToGroup: (groupId: string, body: string) => Promise<void>;
  readonly log?: (line: string) => void;
}

export interface TaskProgressReporter {
  emit(dispatch: TaskDispatch | null, kind: TaskProgressKind, detail?: string): Promise<void>;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function createTaskProgress(deps: TaskProgressDeps): TaskProgressReporter {
  const budget = createProgressBudget();

  const lineOf = (dispatch: TaskDispatch, kind: TaskProgressKind, detail: string | undefined): string => {
    const title = clip(dispatch.title || '任务', 60);
    if (kind === 'started') return `⏳ 开始处理「${title}」（任务 ${dispatch.taskId}）`;
    if (kind === 'finished') {
      const head = dispatch.state === 'done' ? '✅ 完成' : dispatch.state === 'failed' ? '❌ 失败' : '任务结束';
      return `${head}：「${title}」（任务 ${dispatch.taskId}）${detail ? `\n${clip(detail, 400)}` : ''}`;
    }
    return `… 「${title}」${milestoneText(detail ?? null)}`;
  };

  return {
    async emit(dispatch, kind, detail) {
      if (!dispatch) return;
      const at = deps.now();
      if (!budget.allow(dispatch.taskId, kind, at)) return;
      const body = lineOf(dispatch, kind, detail);
      await deps.workLog
        .append({
          id: newId(),
          taskId: asTaskId(dispatch.taskId),
          author: { kind: 'system' },
          body,
          links: [],
          attachments: [],
          sessionId: dispatch.sessionId === null ? null : asSessionId(dispatch.sessionId),
          createdAt: at,
          supersedes: null
        })
        .catch((failure: unknown) => deps.log?.(`任务进展写日志失败：${(failure as Error).message}`));
      const group = dispatch.notifySessionId === null ? null : await deps.groupOfSession(dispatch.notifySessionId);
      if (group) {
        await deps.postToGroup(group.groupId, body).catch((failure: unknown) =>
          deps.log?.(`任务进展发到群里失败：${(failure as Error).message}`)
        );
      }
      if (kind === 'finished') budget.reset(dispatch.taskId);
    }
  };
}
