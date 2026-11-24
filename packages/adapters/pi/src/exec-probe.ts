// 探测实现已收敛到 @agent-hub/node-kit；这里保留相对路径与包级 reexport，Pi 内部和测试继续用同一入口。
export { execFailureReason, execProbe } from '@agent-hub/node-kit';
export type { ExecProbe } from '@agent-hub/node-kit';
