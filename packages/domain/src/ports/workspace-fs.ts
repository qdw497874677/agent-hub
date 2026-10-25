import type { DomainError } from '../errors.ts';
import type { Result } from '../result.ts';

/** 目录选择器要显示的一项。`path` 是绝对路径——用户选完它就直接写进 Project。 */
export interface DirectoryEntry {
  readonly name: string;
  readonly path: string;
  /** 里面有 `.git`：选择器上标出来，绑仓库的项目一眼能认出。 */
  readonly isGit?: boolean;
  /** 最后修改时间（毫秒）：选择器按它把最近用过的排前面。 */
  readonly modifiedAt?: number;
}

export interface WorkspaceFS {
  /** S2.2：目录不存在时报错，不静默创建。 */
  directoryExists(path: string): Promise<boolean>;
  /** S2.1：让人从真实目录里挑，而不是手打一个可能会错的路径。只列子目录。 */
  listDirectories(path: string): Promise<readonly DirectoryEntry[]>;
  /**
   * 在 parent 下建一层文件夹 `name`（已存在的目录算成功）。
   * 适配器负责：parent 和结果都用 realpath 校验仍在 roots 里（软链接逃逸算外面）。
   * 返回新目录的绝对路径。
   */
  makeDirectory(parent: string, name: string, roots: readonly string[]): Promise<Result<string, DomainError>>;
  /** 产出物落盘目录：<workspaceRoot>/.agent-hub/artifacts/<sessionId> */
  artifactDir(workspaceRoot: string, sessionId: string): string;
  writeFile(path: string, content: Uint8Array): Promise<Result<number, DomainError>>;
  stat(path: string): Promise<number | null>;
  /** 读一个文件；不存在或读不了返回 null。 */
  readFile(path: string): Promise<Uint8Array | null>;
  /**
   * 项目里的文件（相对 root 的路径），给 `@` 引用选择器用。
   * 跳过点目录、node_modules 之类的大目录；最多 limit 条，多了标 truncated。
   */
  listFiles(root: string, limit: number): Promise<{ readonly files: readonly string[]; readonly truncated: boolean }>;
}
