import type { SessionId, TaskId } from '../ids.ts';
import type { SessionOrigin } from '../session.ts';
import type { DomainError } from '../errors.ts';
import type { Result } from '../result.ts';
import type { WorkerStatus } from '../worker.ts';

/**
 * Server → Worker 指令。从第一天就是双向的：只够回传执行事件的通道，
 * 将来做「自动下发安装」时要重构成双向（定位 §5 特别说明）。
 */
export type WorkerCommand =
  | {
      readonly kind: 'start_session';
      readonly sessionId: SessionId;
      readonly taskId: TaskId;
      readonly agentId: string;
      readonly model: string;
      readonly workspaceRoot: string;
      readonly origin: SessionOrigin;
      readonly resume: { readonly agentSessionRef: string | null; readonly cursor: number } | null;
      /** 开跑前就定下的可调项（键是 option id）；空对象 = 全用 agent 默认。 */
      readonly options: Readonly<Record<string, string | boolean>>;
    }
  | {
      readonly kind: 'set_option';
      readonly sessionId: SessionId;
      readonly optionId: string;
      readonly value: string | boolean;
    }
  | { readonly kind: 'prompt'; readonly sessionId: SessionId; readonly text: string }
  | { readonly kind: 'interrupt'; readonly sessionId: SessionId }
  | { readonly kind: 'dispose'; readonly sessionId: SessionId };

export interface NodeGateway {
  status(): Promise<WorkerStatus[]>;
  dispatch(command: WorkerCommand): Promise<Result<void, DomainError>>;
}
