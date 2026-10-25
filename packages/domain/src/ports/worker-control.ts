import type { BuildInfo, WorkerStatus } from '../worker.ts';

/** 运营后台对机器的管理面：看、踢、更新。 */
export interface WorkerControl {
  list(): Promise<WorkerStatus[]>;
  /** 断开在线的那台并让它别自动重连；不在线返回 false。 */
  disconnect(workerId: string): Promise<boolean>;
  /** hub 自己的版本：「过期」的参照，也是更新的目标。 */
  hubBuild(): BuildInfo;
  /** 让在线的那台更新到这个提交；不在线返回 false。 */
  update(workerId: string, commit: string): Promise<boolean>;
}
