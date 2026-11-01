import type { DomainError } from '../errors.ts';
import type { Result } from '../result.ts';

/**
 * 工作空间文件浏览（ADR 0025 · P1，只读）：在工作空间所在的那台机器上列目录、读文件、模糊找文件、
 * 看 git 改动和 diff、盯着展开的目录变化。路径一律是相对工作空间根的 POSIX 路径（'' = 根）；
 * 实现必须用 realpath 把它关在根里（符号链接逃逸也算越界），并且永远不列 .git/。
 */
export type FileGitStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface BrowserEntry {
  readonly name: string;
  /** 相对工作空间根。 */
  readonly path: string;
  readonly type: 'file' | 'dir' | 'symlink';
  readonly size: number;
  readonly modifiedAt: number;
  /** 被 .gitignore 忽略（灰显，仍可展开）。 */
  readonly ignored: boolean;
  /** 敏感文件（.env、私钥……）：默认藏起来。 */
  readonly sensitive: boolean;
  readonly git: FileGitStatus | null;
}

export interface DirectoryPage {
  readonly path: string;
  readonly entries: readonly BrowserEntry[];
  /** 超过单目录上限被截断了。 */
  readonly truncated: boolean;
  /** 不是 git 仓库：没有忽略 / 改动信息。 */
  readonly isGit: boolean;
}

export interface FileContent {
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: number;
  readonly binary: boolean;
  /** 只读了前 maxBytes 字节。 */
  readonly truncated: boolean;
  /** binary 时为空。 */
  readonly bytes: Uint8Array;
}

export interface ChangedFile {
  readonly path: string;
  readonly status: FileGitStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly oldPath?: string;
}

export interface FileDiff {
  readonly path: string;
  /** unified diff 原文；超上限时截断。 */
  readonly patch: string;
  readonly truncated: boolean;
  readonly binary: boolean;
}

/** 变化通知：paths 是变了的目录 / 文件（相对根）；reset = 连接断过，订阅要重开、全部刷新。 */
export interface FileChangeNotice {
  readonly paths: readonly string[];
  readonly reset?: boolean;
}

export interface WorkspaceBrowser {
  list(root: string, path: string, options: { readonly limit: number }): Promise<Result<DirectoryPage, DomainError>>;
  read(root: string, path: string, maxBytes: number): Promise<Result<FileContent, DomainError>>;
  find(root: string, query: string, limit: number): Promise<Result<readonly string[], DomainError>>;
  /** base = 提交号；null = 当前 HEAD。 */
  changes(root: string, base: string | null): Promise<Result<readonly ChangedFile[], DomainError>>;
  diff(root: string, path: string, base: string | null, maxBytes: number): Promise<Result<FileDiff, DomainError>>;
  /** 当前 HEAD 提交号；不是 git 仓库或还没提交是 null。 */
  head(root: string): Promise<Result<string | null, DomainError>>;
  /** 盯住这些相对路径（目录只看一层、文件看自己）；返回取消订阅。 */
  watch(root: string, paths: readonly string[], onChange: (notice: FileChangeNotice) => void): Promise<Result<() => void, DomainError>>;
}

/** 会话开始时的 HEAD（ADR 0025 决定 7：diff 默认基准）。 */
export interface SessionBaseStore {
  get(sessionId: string): Promise<string | null>;
  /** 已有就不覆盖。 */
  setIfAbsent(sessionId: string, head: string): Promise<void>;
}
