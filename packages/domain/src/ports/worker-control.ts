import type { BuildInfo, WorkerStatus } from '../worker.ts';
import type { RuntimeJob } from '../runtime-install.ts';

/** 运营后台对机器的管理面：看、踢、更新。 */
export interface WorkerControl {
  list(): Promise<WorkerStatus[]>;
  /**
   * 断开在线的那台并让它别自动重连；不在线返回 false。
   * `revoked`：凭据已作废（关闭码 4401）；默认是管理员断开（4403）。
   */
  disconnect(workerId: string, why?: 'admin' | 'revoked'): Promise<boolean>;
  /** hub 自己的版本：「过期」的参照，也是更新的目标。 */
  hubBuild(): BuildInfo;
  /** 让在线的那台更新到这个提交；不在线返回 false。 */
  update(workerId: string, commit: string): Promise<boolean>;
  /** 下发一个运行时安装 / 卸载任务（hub 记下它为 running）；不在线返回 false。 */
  runtimeJob(workerId: string, job: RuntimeJob): Promise<boolean>;
}
