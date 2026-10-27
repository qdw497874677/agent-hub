import type { DomainError } from '../errors.ts';
import type { Result } from '../result.ts';
import type { AssetKind, IncomingFile } from '../asset.ts';

export interface AssetMetadata {
  /** skill 取自 SKILL.md 的 frontmatter；instruction 没有内置名字（null，由调用方给）。 */
  readonly name: string | null;
  readonly description: string;
}

export interface GitCandidate {
  readonly kind: AssetKind;
  /** 仓库里的路径：技能目录，或指令文件。 */
  readonly path: string;
  readonly name: string;
  readonly description: string;
}

export interface GitCheckout {
  readonly commit: string;
  readonly files: readonly IncomingFile[];
}

/**
 * 资产格式与来源的适配器：解析 SKILL.md frontmatter、从 git 检出、生成文本 diff。
 * 领域只管规则（名字、路径、大小、版本），不认识 YAML、git 和 diff 算法。
 */
export interface AssetReader {
  describe(kind: AssetKind, files: readonly IncomingFile[]): Result<AssetMetadata, DomainError>;
  /** 浅克隆一次，列出仓库里能导入的技能（含 SKILL.md 的目录）和指令（AGENTS.md 等）。 */
  scanGit(url: string, ref: string | null): Promise<Result<{ commit: string; candidates: GitCandidate[] }, DomainError>>;
  /** 检出仓库里某个路径下的文件（技能目录，或单个指令文件）。 */
  readGit(url: string, ref: string | null, path: string, kind: AssetKind): Promise<Result<GitCheckout, DomainError>>;
  /** 一个文本文件前后两版的统一 diff。 */
  diffText(path: string, before: string, after: string): string;
}
