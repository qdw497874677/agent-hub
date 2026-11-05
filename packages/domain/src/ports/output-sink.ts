/** 入站的回程（ADR 0032）：任务生命周期 / 会话回复 → 来源侧动作（github 连接器：开工 👀、完成回 PR 链接、失败回原因）。 */
export interface OutputSinkEvent {
  readonly kind: 'task.created' | 'task.finished' | 'task.failed';
  readonly bindingId: string;
  readonly externalId: string;
  readonly detail: string;
  readonly taskId?: string;
  readonly projectId?: string;
}

export interface OutputSink {
  readonly id: string;
  deliver(event: OutputSinkEvent): Promise<void>;
}
