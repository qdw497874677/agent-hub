/** Worker 的对外状态。Server / Worker 是适配器，但它得有地方被看见（S1.2）。 */
export type WorkerState = 'online' | 'offline';

export interface WorkerStatus {
  readonly workerId: string;
  readonly label: string;
  readonly origin: 'local' | 'remote';
  readonly state: WorkerState;
  /** offline 时的原因文案：区分「它挂了」和「我改坏了配置」。 */
  readonly reason?: string;
}
