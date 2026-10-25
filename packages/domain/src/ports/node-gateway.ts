import type { SessionId, TaskId } from '../ids.ts';
import type { SessionOrigin } from '../session.ts';
import type { DomainError } from '../errors.ts';
import type { Result } from '../result.ts';
import type { WorkerStatus } from '../worker.ts';
import type { PromptPart } from '../attachment.ts';
import type { DirectoryEntry } from './workspace-fs.ts';

/**
 * Server → Worker 指令。从第一天就是双向的：只够回传执行事件的通道，
 * 将来做「自动下发安装」时要重构成双向（定位 §5 特别说明）。
 */
export type WorkerCommand =
  | {
      readonly kind: 'start_session';
      readonly sessionId: SessionId;
      /** 落点：交给哪台 Worker。后续 prompt / interrupt 都按会话跟着它走。 */
      readonly workerId: string;
      readonly taskId: TaskId;
      readonly agentId: string;
      readonly workspaceRoot: string;
      readonly origin: SessionOrigin;
      readonly resume: { readonly agentSessionRef: string | null; readonly cursor: number } | null;
      /**
       * 开跑前就定下的可调项（键是 option id）；空对象 = 全用 agent 默认。
       * 模型也在这里（`options.model`）——它就是一个 category 为 model 的可调项，不再单开字段。
       */
      readonly options: Readonly<Record<string, string | boolean>>;
    }
  | {
      readonly kind: 'set_option';
      readonly sessionId: SessionId;
      readonly optionId: string;
      readonly value: string | boolean;
    }
  | {
      readonly kind: 'prompt';
      readonly sessionId: SessionId;
      readonly text: string;
      readonly parts: readonly PromptPart[];
    }
  | { readonly kind: 'interrupt'; readonly sessionId: SessionId }
  | { readonly kind: 'dispose'; readonly sessionId: SessionId };

export interface NodeGateway {
  status(): Promise<WorkerStatus[]>;
  dispatch(command: WorkerCommand): Promise<Result<void, DomainError>>;
  /**
   * 浏览某台 Worker 上的目录（只列子目录）。项目目录在哪台机器上，就得问那台机器——
   * Server 自己的文件系统只对和它同机的 Worker 有意义。
   * 返回的 `path` 是 Worker 解析后的绝对路径（请求空串时就是它的起点）。
   * 目录不存在返回 `exists: false`，而不是错误：那是用户输错了，不是通道坏了。
   */
  listDirectories(
    workerId: string,
    path: string
  ): Promise<
    Result<{ readonly path: string; readonly exists: boolean; readonly entries: readonly DirectoryEntry[] }, DomainError>
  >;
}
