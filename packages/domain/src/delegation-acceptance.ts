/**
 * 人工验收的追加记录（docs/design/vibex-borrowing.md，第二期「V7 验收精确绑定 SHA」）。
 *
 * 这里只固定**最小记录与存储契约**，不含任务状态、发布或测试证据：
 * - 一条记录只保存派工 ID、请求键、完整提交号、验收人、写入时间与可选备注，没有可更新的字段。
 * - 幂等身份是 `(delegationId, requestKey)` 的精确字节，不做 trim / 大小写归一；
 *   同键且 SHA / 验收人 / 备注逐字节相同 -> 重放原记录，任何一项不同 -> conflict，绝不覆盖。
 * - `createdAt` 只是这次写入的时间标注，不参与冲突判定：重放同一内容不会刷新它。
 * - 历史按追加顺序（旧 -> 新）返回；查询条数有上限，不能一次拉走无限历史。
 * - 该记录**不改任务状态**、不触发发布，也不是「测试通过」的证据；当前性由调用方拿 Worker 的
 *   完整 HEAD 另行核对，这里不缓存分支名或历史发布 SHA 作为替代。
 */

/** 完整 Git 提交号：40 位小写十六进制。短号、大写、分支名都不是验收证据。 */
export function isDelegationAcceptanceSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** 不可变的验收记录。字段全部来自一次人工验收，落库后没有修改入口。 */
export interface DelegationAcceptance {
  readonly delegationId: string;
  /** 人对这次验收给出的稳定请求键，原样保存（不 trim / 不改大小写）。 */
  readonly requestKey: string;
  /** 验收对应的完整小写提交号。 */
  readonly sha: string;
  /** 验收人（当前登录主体）。共享验收 / 协作者语义不在这里猜测。 */
  readonly actorId: string;
  readonly createdAt: number;
  /** 可选备注；省略按 `null` 保存，空字符串是另一条内容，不做归并。 */
  readonly note: string | null;
}

export interface DelegationAcceptanceInput {
  readonly delegationId: string;
  readonly requestKey: string;
  readonly sha: string;
  readonly actorId: string;
  readonly createdAt: number;
  readonly note?: string | null;
}

export type DelegationAcceptanceOutcome = 'created' | 'replayed' | 'conflict';

export interface DelegationAcceptanceResult {
  readonly outcome: DelegationAcceptanceOutcome;
  /** 三种结果都返回库里已有的那条记录（conflict 也如实返回原记录）。 */
  readonly record: DelegationAcceptance;
}

/** 历史查询默认条数。 */
export const DELEGATION_ACCEPTANCE_HISTORY_LIMIT = 50;
/** 历史查询硬上限：调用方给再大也只返回这么多。 */
export const DELEGATION_ACCEPTANCE_HISTORY_MAX = 200;

/**
 * 校验并归一化一次追加输入：
 * - 标识字段必须是非空字符串，原样使用；
 * - `sha` 必须是完整小写 40 位提交号，否则直接拒绝，不落一条无法核对的记录；
 * - `note` 省略即 `null`，其余必须是字符串。
 * 这里抛 `TypeError`，表示调用方编程错误，存储层不会写任何行。
 */
export function normalizeDelegationAcceptanceInput(input: DelegationAcceptanceInput): DelegationAcceptance {
  if (!input || typeof input !== 'object') throw new TypeError('验收记录必须是对象');
  for (const field of ['delegationId', 'requestKey', 'actorId'] as const) {
    const value = input[field];
    if (typeof value !== 'string' || value === '') {
      throw new TypeError(`验收记录缺少 ${field}`);
    }
  }
  if (!isDelegationAcceptanceSha(input.sha)) {
    throw new TypeError('验收记录的 sha 必须是完整小写 40 位提交号');
  }
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new TypeError('验收记录的 createdAt 必须是非负安全整数');
  }
  if (input.note !== undefined && input.note !== null && typeof input.note !== 'string') {
    throw new TypeError('验收记录的 note 必须是字符串或 null');
  }
  return {
    delegationId: input.delegationId,
    requestKey: input.requestKey,
    sha: input.sha,
    actorId: input.actorId,
    createdAt: input.createdAt,
    note: input.note ?? null
  };
}

/**
 * 同键重放的判定只看内容三要素：SHA、验收人、备注，逐字节比较。
 * 不 trim、不改大小写，也不比较 `createdAt`（重放不是重新验收）。
 */
export function delegationAcceptanceMatches(
  stored: DelegationAcceptance,
  input: DelegationAcceptance
): boolean {
  return stored.sha === input.sha && stored.actorId === input.actorId && stored.note === input.note;
}

/** 把调用方给的条数收进 `[1, HISTORY_MAX]`；非正整数是编程错误，直接抛错。 */
export function delegationAcceptanceHistoryLimit(limit: number = DELEGATION_ACCEPTANCE_HISTORY_LIMIT): number {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('验收历史条数必须是正整数');
  return Math.min(limit, DELEGATION_ACCEPTANCE_HISTORY_MAX);
}

export interface DelegationAcceptanceStore {
  /**
   * 追加一条验收记录。同 `(delegationId, requestKey)` 已存在时：
   * 内容三要素相同 -> `replayed`（返回原记录，不刷新 `createdAt`），否则 -> `conflict`（不覆盖）。
   * 插入是单条 SQL，不先读后写；两个连接同时提交时只有一个能建记录，另一个按内容分类。
   */
  append(input: DelegationAcceptanceInput): Promise<DelegationAcceptanceResult>;
  /** 按精确的派工 ID + 请求键取记录；不存在返回 null。 */
  byRequest(delegationId: string, requestKey: string): Promise<DelegationAcceptance | null>;
  /**
   * 某个派工下，精确匹配该完整 SHA 的最近一次验收（按追加顺序取最后一条）。
   *
   * 必须走 `(delegationId, sha)` 索引直接查询，**不能**先取最近 50 条再过滤：否则较早的
   * 验收记录会在历史窗口外丢失，让「当前 HEAD 是否已经验收过」产生假阴性。
   * 没有精确匹配时返回 null，不做前缀 / 分支 / 大小写匹配。
   */
  latestForSha(delegationId: string, sha: string): Promise<DelegationAcceptance | null>;
  /**
   * 最近 `limit` 条，按追加顺序（旧 -> 新）返回。默认 50，硬上限 200；
   * 不提供全量 / 无界读，也不把 `createdAt` 当排序依据（存储顺序才是稳定顺序）。
   */
  history(delegationId: string, limit?: number): Promise<DelegationAcceptance[]>;
}
