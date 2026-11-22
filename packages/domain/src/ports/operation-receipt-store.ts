import type { ProjectId, SessionId } from '../ids.ts';

/**
 * 中立操作回执：给「可能产生副作用、需要先占位再确认」的写操作用的持久
 * reserve / complete 协议（阶段 2 的候选导入、阶段 3 的资产写入）。
 *
 * 与 `TaskCreationStore` 的区别：
 * - `TaskCreationStore` 是「创建 + 回执」同事务，成功结果一次落库；
 * - 这里多了一个显式的 pending 占位：副作用发生在事务之外（文件、远端、blob），
 *   所以必须先原子地抢到执行权，再在副作用成功后 CAS 落结果。
 *
 * 不变式：
 * 1. 键沿用 `requestReplayKey`（人 + 来源会话 + 项目 + 操作 + 调用方请求键），
 *    指纹沿用 `requestFingerprint`；同键同参是同一个逻辑请求，同键异参是冲突。
 * 2. pending 永不因时间而失效：可能已经产生副作用，任何 TTL 接管都可能让两个
 *    执行者同时“拥有”同一个请求。只有明确的 release（确认没有副作用）才放行重试。
 * 3. complete / release 都带 per-reservation token 的 CAS：只有抢到占位的那个
 *    执行者能改这一行；后来者拿旧 token 什么也改不了。
 * 4. 回执载荷由调用方定义。存储层只做 JSON 往返，不解释字段；读回后调用方必须
 *    自己做运行时校验，不能把 `unknown` 直接当成业务对象。
 */

/**
 * 回执载荷：一个普通 JSON 对象，结构由调用方决定。
 *
 * 禁止放原始指令 / prompt / 凭据 / 密钥或任何秘密：回执会持久化，并在同键重放时
 * 原样返回给调用方。只放「重建结果所需的最小标识与元数据」。
 */
export type OperationReceiptPayload = Readonly<Record<string, unknown>>;

export interface OperationReserveIntent {
  /** `requestReplayKey(scope, requestKey)` 的结果。 */
  readonly key: string;
  /** `requestFingerprint([...])` 的结果。 */
  readonly fingerprint: string;
  /** 发起人（账号 id），只用于审计，不参与授权。 */
  readonly actorId: string;
  readonly sourceSessionId: SessionId | null;
  readonly projectId: ProjectId;
  readonly operation: string;
}

/**
 * 抢执行权的结果：
 * - `reserved`：首次抢到，可以开始副作用，完成后用返回的 token `complete`；
 * - `pending`：同一请求已经被别人占着，且没有完成；**不要执行**，也不要接管，
 *   稍后再次 `reserve` 观察它是否完成（pending 不会过期）；
 * - `completed`：同键同参已经完成，原样返回第一次的结果；
 * - `conflict`：同键但参数不同（或存储状态与请求不一致），不执行、不覆盖。
 */
export type OperationReserveOutcome =
  | { readonly status: 'reserved'; readonly reservationId: string }
  | { readonly status: 'pending' }
  | { readonly status: 'completed'; readonly payload: OperationReceiptPayload }
  | { readonly status: 'conflict' };

/**
 * 落完成结果的结果：
 * - `completed`：本次 CAS 成功，把占位改成完成；
 * - `replayed`：同键同参已经完成（例如重试的 complete），返回原结果；
 * - `conflict`：token 不匹配、指纹不同、或没有 pending 占位；不写任何东西。
 */
export type OperationCompleteOutcome =
  | { readonly status: 'completed' }
  | { readonly status: 'replayed'; readonly payload: OperationReceiptPayload }
  | { readonly status: 'conflict' };

/**
 * 释放占位的结果：
 * - `released`：CAS 命中并删除占位，之后同键同参可以重新 reserve；
 * - `conflict`：token / 指纹不匹配，或已经不是 pending（例如已完成）。
 */
export type OperationReleaseOutcome =
  | { readonly status: 'released' }
  | { readonly status: 'conflict' };

export interface OperationCompleteInput {
  readonly key: string;
  readonly fingerprint: string;
  readonly reservationId: string;
  readonly payload: OperationReceiptPayload;
}

export interface OperationReleaseInput {
  readonly key: string;
  readonly fingerprint: string;
  readonly reservationId: string;
}

export interface OperationReceiptStore {
  /**
   * 原子地查看 + 抢占。首次调用写入 pending 占位并返回 token；
   * 同键同参重复调用返回 `pending`（不接管）或已完成的原结果。
   */
  reserve(intent: OperationReserveIntent): Promise<OperationReserveOutcome>;

  /**
   * 副作用成功后落结果。只有 `key + pending + fingerprint + reservationId`
   * 全部匹配才从 pending 改成 completed（完成 CAS）；已完成且同指纹时幂等回放。
   */
  complete(input: OperationCompleteInput): Promise<OperationCompleteOutcome>;

  /**
   * 副作用确定没有发生（参数校验失败、远端明确拒绝等）时释放占位，
   * 让同一请求可以重试。只有匹配的 reservation 能释放；已完成的行不可释放。
   */
  release(input: OperationReleaseInput): Promise<OperationReleaseOutcome>;
}
