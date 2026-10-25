import type { DomainError } from '../errors.ts';
import type { Result } from '../result.ts';

/** 目录选择器要显示的一项。`path` 是绝对路径——用户选完它就直接写进 Project。 */
export interface DirectoryEntry {
  readonly name: string;
  readonly path: string;
}

export interface WorkspaceFS {
  /** S2.2：目录不存在时报错，不静默创建。 */
  directoryExists(path: string): Promise<boolean>;
  /** S2.1：让人从真实目录里挑，而不是手打一个可能会错的路径。只列子目录。 */
  listDirectories(path: string): Promise<readonly DirectoryEntry[]>;
  /** 产出物落盘目录：<workspaceRoot>/.agent-hub/artifacts/<sessionId> */
  artifactDir(workspaceRoot: string, sessionId: string): string;
  writeFile(path: string, content: Uint8Array): Promise<Result<number, DomainError>>;
  stat(path: string): Promise<number | null>;
}
