import type { ProjectId, SessionId, TaskId } from '../ids.ts';

/**
 * 一条搜索命中。只描述「在哪儿、为什么命中」，不描述 UI 该怎么画。
 *
 * session 命中时 sessionId 有值、title 是它所属任务的名字；
 * task 命中时 sessionId 为 null。
 */
export interface SearchHit {
  readonly kind: 'task' | 'session';
  readonly taskId: TaskId;
  readonly sessionId: SessionId | null;
  readonly title: string;
  readonly snippet: string;
}

export interface SearchQuery {
  readonly projectId: ProjectId;
  readonly query: string;
  readonly limit: number;
}

/**
 * 读侧查询端口。它不是聚合仓库：搜索跨 Task 与 Session 的文本，不该让
 * 任一仓库长出「顺便搜一下」的方法。
 */
export interface SearchGateway {
  search(query: SearchQuery): Promise<readonly SearchHit[]>;
}
