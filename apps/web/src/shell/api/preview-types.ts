/** 会话范围内由服务端核实归属的预览目标；映射就绪不代表页面已经响应。 */
export interface PreviewWorkflowTarget {
  readonly port: number;
  readonly label: string | null;
  readonly workerId: string;
  readonly linkId: string | null;
  readonly url: string | null;
  readonly mapping: 'ready' | 'pending' | 'unavailable';
}

export interface PreviewWorkflow {
  readonly available: boolean;
  readonly targets: readonly PreviewWorkflowTarget[];
}

export interface PreviewDiagnostic {
  readonly state: 'worker_offline' | 'channel_unavailable' | 'listener_unavailable' | 'indeterminate' | 'timeout' | 'response' | 'refused';
  readonly status: number | null;
  readonly checkedAt: number;
}
