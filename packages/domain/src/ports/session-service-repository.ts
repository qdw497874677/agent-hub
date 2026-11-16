import type { ServiceId, SessionId, TaskId } from '../ids.ts';
import type { SessionService } from '../service.ts';

/** 会话服务（docs/design/session-service.md §3）的持久化端口。 */
export interface SessionServiceRepository {
  byId(id: ServiceId): Promise<SessionService | null>;
  listByTask(taskId: TaskId): Promise<readonly SessionService[]>;
  listBySession(sessionId: SessionId): Promise<readonly SessionService[]>;
  listByWorker(workerId: string): Promise<readonly SessionService[]>;
  save(service: SessionService): Promise<void>;
  remove(id: ServiceId): Promise<void>;
}
