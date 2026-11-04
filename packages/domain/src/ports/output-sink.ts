/** 入站的回程（ADR 0032）：任务生命周期 / 会话回复 → 来源侧动作。R1 只有端口，github 连接器在 R4 实现。 */
export interface OutputSink {
  readonly id: string;
  deliver(event: { readonly kind: 'task.created' | 'task.finished' | 'task.failed'; readonly bindingId: string; readonly externalId: string; readonly detail: string }): Promise<void>;
}
