import type { ServiceId, SessionId, TaskId } from '../ids.ts';
import type { SessionService } from '../service.ts';

/** 会话服务（docs/design/session-service.md §3）的持久化端口。 */
export interface SessionServiceRepository {
  byId(id: ServiceId): Promise<SessionService | null>;
  listByTask(taskId: TaskId): Promise<readonly SessionService[]>;
  listBySession(sessionId: SessionId): Promise<readonly SessionService[]>;
  listByWorker(workerId: string): Promise<readonly SessionService[]>;
  /** 整行写：创建、停止、删除等低频路径用。高频的状态 / 日志帧不要走这里。 */
  save(service: SessionService): Promise<void>;
  /**
   * 只更新状态列。`service.updatedAt` 同时作为乐观锁：库里 `updated_at` 更大时
   * （旧帧晚到）不覆盖。返回是否真的写进去了。
   */
  updateState(service: SessionService): Promise<boolean>;
  /** 只更新日志尾巴与 updated_at，不碰状态 / env / command。 */
  appendLogTail(id: ServiceId, logTail: string, updatedAt: number): Promise<void>;
  remove(id: ServiceId): Promise<void>;
}
