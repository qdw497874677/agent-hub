/**
 * 批量 Git 导入的界面侧纯逻辑（后端见 `/api/assets/git/batch`，一次 1..20 条）。
 *
 * 输入框里一行一条：`仓库地址`，或者 `仓库地址 路径`（比如 `https://github.com/o/r.git skills/foo`）。
 * 空行跳过；行号按输入框里的实际行算，报错才能对得上人看到的第几行。
 * 拆出来是为了能单测：这里不做网络、不碰 React。
 */

/** 和后端 `gitBatchImportRequest.items.max(20)` 对齐。 */
export const MAX_BATCH_ITEMS = 20;

export interface BatchLine {
  /** 输入框里这一行的原文（去掉首尾空白），失败重试时原样放回去。 */
  readonly raw: string;
  readonly url: string;
  /** 仓库里的路径；空串表示交给服务端按网址 / 仓库根目录认。 */
  readonly path: string;
  /** 输入框里的行号，从 1 开始（含被跳过的空行）。 */
  readonly line: number;
}

export type BatchParseResult =
  | { readonly ok: true; readonly items: BatchLine[] }
  | { readonly ok: false; readonly errors: string[] };

/** 逐行拆。空行跳过，超过两段（地址 + 路径）算错——路径里带空格就分不清了。 */
export function parseGitBatch(text: string): BatchParseResult {
  const items: BatchLine[] = [];
  const errors: string[] = [];
  text.split('\n').forEach((source, index) => {
    const raw = source.trim();
    if (raw === '') return;
    const line = index + 1;
    const parts = raw.split(/\s+/);
    if (parts.length > 2) {
      errors.push(`第 ${line} 行：一行只写「仓库地址 路径」，路径里不能有空格`);
      return;
    }
    const url = parts[0] ?? '';
    if (url === '') {
      errors.push(`第 ${line} 行：没写仓库地址`);
      return;
    }
    items.push({ raw, url, path: parts[1] ?? '', line });
  });
  if (items.length > MAX_BATCH_ITEMS) {
    errors.push(`最多 ${MAX_BATCH_ITEMS} 条，现在有 ${items.length} 条`);
  }
  if (errors.length) return { ok: false, errors };
  if (items.length === 0) return { ok: false, errors: ['至少填一行仓库地址'] };
  return { ok: true, items };
}

/** 服务端逐项的返回（顺序和提交的 items 一致）。 */
export interface BatchItemResult {
  readonly ok: boolean;
  readonly id?: string;
  readonly name?: string;
  readonly error?: string;
}

export interface BatchOutcome {
  readonly ok: boolean;
  readonly url: string;
  readonly path: string;
  /** 成功时是资产名；失败是 null。 */
  readonly name: string | null;
  /** 失败原因（服务端原话）；成功是 null。 */
  readonly error: string | null;
}

export interface BatchCombined {
  readonly outcomes: BatchOutcome[];
  readonly succeeded: number;
  readonly failed: number;
  /** 失败的原始行：放回输入框，用户改一下就能再导一次。 */
  readonly retryText: string;
}

/**
 * 把「提交的行」和「服务端的数组」配对。少一条也当失败（别静默吞掉），
 * 保证结果区的行数和用户提交的一致。
 */
export function combineGitBatch(items: readonly BatchLine[], results: readonly BatchItemResult[]): BatchCombined {
  const outcomes = items.map((item, index): BatchOutcome => {
    const result = results[index];
    if (!result) {
      return { ok: false, url: item.url, path: item.path, name: null, error: '服务端没有返回这一条，再试一次' };
    }
    if (!result.ok) {
      return { ok: false, url: item.url, path: item.path, name: null, error: result.error ?? '导入失败' };
    }
    return { ok: true, url: item.url, path: item.path, name: result.name ?? null, error: null };
  });
  const failed = outcomes.filter((outcome) => !outcome.ok).length;
  return {
    outcomes,
    succeeded: outcomes.length - failed,
    failed,
    retryText: items
      .filter((_, index) => outcomes[index]?.ok === false)
      .map((item) => item.raw)
      .join('\n')
  };
}
