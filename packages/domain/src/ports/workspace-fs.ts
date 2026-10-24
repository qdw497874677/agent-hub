import type { DomainError } from '../errors.ts';
import type { Result } from '../result.ts';

export interface WorkspaceFS {
  /** S2.2：目录不存在时报错，不静默创建。 */
  directoryExists(path: string): Promise<boolean>;
  /** 产出物落盘目录：<workspaceRoot>/.agent-hub/artifacts/<sessionId> */
  artifactDir(workspaceRoot: string, sessionId: string): string;
  writeFile(path: string, content: Uint8Array): Promise<Result<number, DomainError>>;
  stat(path: string): Promise<number | null>;
}
