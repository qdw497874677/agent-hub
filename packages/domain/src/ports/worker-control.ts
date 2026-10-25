import type { WorkerStatus } from '../worker.ts';

/** 运营后台对机器的管理面：看、踢。 */
export interface WorkerControl {
  list(): Promise<WorkerStatus[]>;
  /** 断开在线的那台并让它别自动重连；不在线返回 false。 */
  disconnect(workerId: string): Promise<boolean>;
}
