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
  /** target：拿另一个提交（检查点）当「新」的一边；不给 = 和工作区比（含未跟踪文件）。 */
  changes(root: string, base: string | null, target?: string | null): Promise<Result<readonly ChangedFile[], DomainError>>;
  diff(root: string, path: string, base: string | null, maxBytes: number, target?: string | null): Promise<Result<FileDiff, DomainError>>;
  /**
   * 回合检查点（ADR 0027 D1/D2）：用临时 index 把工作区（含未跟踪、不含忽略）写成一个提交，挂到 ref 上。
   * 不动真 index、不动工作区、不动分支。不是 git 仓库 = null。ref 必须在 refs/agent-hub/checkpoints/ 下。
   */
  checkpoint(root: string, ref: string): Promise<Result<string | null, DomainError>>;
  /** 删掉某个前缀下的所有检查点 ref（保留期到了 / 工作空间删了）。前缀必须在 refs/agent-hub/checkpoints/ 下。 */
  dropRefs(root: string, prefix: string): Promise<Result<number, DomainError>>;
  /**
   * 把工作区恢复成某个检查点（ADR 0027 阶段 4，「连文件一起回滚」）：先把现状拍到 safetyRef（可撤销），
   * 再把和目标不同的文件写回、删掉目标里没有的（这一轮之后新增的）。忽略的文件不动，真 index 不动。
   * 目标之后 HEAD 已经前进且新提交已推送到远端 → conflict。
   */
  restore(root: string, commit: string, safetyRef: string): Promise<Result<RestoreOutcome, DomainError>>;
  /** 当前 HEAD 提交号；不是 git 仓库或还没提交是 null。 */
  head(root: string): Promise<Result<string | null, DomainError>>;
  /** 盯住这些相对路径（目录只看一层、文件看自己）；返回取消订阅。 */
  watch(root: string, paths: readonly string[], onChange: (notice: FileChangeNotice) => void): Promise<Result<() => void, DomainError>>;
}

export interface RestoreOutcome {
  /** 恢复前拍的那张（撤销用）。 */
  readonly safety: string;
  /** 写回的文件数（改过 / 删过的）。 */
  readonly restored: number;
  /** 删掉的文件数（这一轮之后新增的）。 */
  readonly removed: number;
}

/** 会话开始时的 HEAD（ADR 0025 决定 7：diff 默认基准）。 */
export interface SessionBaseStore {
  get(sessionId: string): Promise<string | null>;
  /** 已有就不覆盖。 */
  setIfAbsent(sessionId: string, head: string): Promise<void>;
}

/** 一轮对话的前后两个检查点（ADR 0027 D2）。after 为 null = 这一轮还没结束。 */
export interface TurnCheckpoint {
  readonly sessionId: string;
  readonly turn: number;
  readonly promptSeq: number;
  readonly before: string;
  readonly after: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** 这一轮改了几个文件 / 加减行（结束时算好存下）。 */
  readonly files: number | null;
  readonly additions: number | null;
  readonly deletions: number | null;
}

export interface CheckpointStore {
  list(sessionId: string): Promise<readonly TurnCheckpoint[]>;
  begin(row: { sessionId: string; turn: number; promptSeq: number; before: string; startedAt: number }): Promise<void>;
  end(sessionId: string, turn: number, row: { after: string; endedAt: number; files: number; additions: number; deletions: number }): Promise<void>;
  /** 最后一个检查点早于 cutoff 的会话（保留期清理用）。 */
  staleSessions(cutoff: number): Promise<readonly string[]>;
  remove(sessionId: string): Promise<void>;
}

export const CHECKPOINT_REF_PREFIX = 'refs/agent-hub/checkpoints/';
/** 保留期：会话最后一个检查点之后 30 天（ADR 0027 D1）。 */
export const CHECKPOINT_RETENTION_MS = 30 * 24 * 3600 * 1000;
export function checkpointRef(sessionId: string, n: number): string {
  return `${CHECKPOINT_REF_PREFIX}${sessionId}/${n}`;
}
export function isCheckpointRef(ref: string): boolean {
  return /^refs\/agent-hub\/checkpoints\/[A-Za-z0-9_-]{1,80}\/\d{1,6}$/.test(ref);
}
export function isCheckpointPrefix(prefix: string): boolean {
  return /^refs\/agent-hub\/checkpoints\/[A-Za-z0-9_-]{1,80}\/$/.test(prefix);
}
