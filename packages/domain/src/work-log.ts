import type { SessionId, TaskId } from './ids.ts';
import { invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/**
 * 工作日志（tasks-and-capabilities.md §2.2）：任务的进度记忆，**只追加**。
 * 「编辑」= 追加一条新版本并让旧版 supersededBy 指向它；agent 只能追加，不能编辑。
 */
export type LogAuthor =
  | { readonly kind: 'user'; readonly userId: string | null; readonly name: string | null }
  | { readonly kind: 'agent'; readonly sessionId: string; readonly agentId: string; readonly model: string }
  | { readonly kind: 'system' };

/**
 * 日志没有「种类」：一条 = 谁写的 + 什么时候 + 一段自由 markdown（+ 可选链接）。
 * 是人、是哪个 agent（运行时 + 模型 + 会话）、还是系统（状态变更、会话开始/结束），全看 author。
 */
export const isSystemEntry = (entry: Pick<WorkLogEntry, 'author'>): boolean => entry.author.kind === 'system';

export type LogLinkKind = 'session' | 'artifact' | 'file' | 'commit' | 'pr' | 'url';
export interface LogLink {
  readonly kind: LogLinkKind;
  readonly ref: string;
  readonly label?: string;
}

export interface WorkLogEntry {
  readonly id: string;
  readonly taskId: TaskId;
  /** 任务内单调递增；分页游标。 */
  readonly seq: number;
  readonly author: LogAuthor;
  /** markdown，内容不限。 */
  readonly body: string;
  readonly links: readonly LogLink[];
  readonly attachments: readonly string[];
  readonly sessionId: SessionId | null;
  readonly createdAt: number;
  /** 这一条是对哪条的修订（编辑历史）。 */
  readonly supersedes: string | null;
  readonly supersededBy: string | null;
}

/** 追加前的草稿：seq 由仓储原子分配。 */
export type WorkLogDraft = Omit<WorkLogEntry, 'seq' | 'supersededBy'>;

export const MAX_LOG_BODY = 32 * 1024;
export const MAX_LOG_LINKS = 20;

export interface DraftInput {
  readonly id: string;
  readonly taskId: TaskId;
  readonly author: LogAuthor;
  readonly body: string;
  readonly links?: readonly LogLink[];
  readonly attachments?: readonly string[];
  readonly sessionId?: SessionId | null;
  readonly supersedes?: string | null;
  readonly now: number;
}

export function draftLogEntry(input: DraftInput): Result<WorkLogDraft, DomainError> {
  const body = input.body.trim();
  if (!body) return err(invalid('日志内容不能为空'));
  if (new TextEncoder().encode(body).length > MAX_LOG_BODY) return err(invalid('日志单条不能超过 32 KB'));
  const links = input.links ?? [];
  if (links.length > MAX_LOG_LINKS) return err(invalid('链接太多'));
  return ok({
    id: input.id,
    taskId: input.taskId,
    author: input.author,
    body,
    links,
    attachments: input.attachments ?? [],
    sessionId: input.sessionId ?? null,
    createdAt: input.now,
    supersedes: input.supersedes ?? null
  });
}

/** 最新一条人/agent 写的日志的第一行有意义文字作为任务「当前进展」（去掉 markdown 标题符号，截到 200 字）。 */
export function summaryFromBody(body: string): string {
  const lines = body.split('\n').map((line) => line.replace(/^[#>*\-\s]+/, '').trim()).filter(Boolean);
  const meaningful = lines.find((line) => !/^(已完成|进行中|下一步|风险\/?待决|关键文件|done|next)\s*[:：]?$/i.test(line)) ?? lines[0] ?? '';
  return meaningful.length > 200 ? `${meaningful.slice(0, 199)}…` : meaningful;
}

/** 可选的交接模板：UI 的「插入交接模板」与给 agent 的提示词共用。不是一种日志类型。 */
export const HANDOFF_TEMPLATE = '## 已完成\n- \n\n## 进行中\n- \n\n## 下一步\n- \n\n## 风险/待决\n- \n\n## 关键文件\n- ';
