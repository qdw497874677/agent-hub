import type { UserId } from './account.ts';

/**
 * 单台机器接入（docs/design/worker-enrollment.md）。
 *
 * - Pairing Code：「添加机器」时签发，一次性、15 分钟，只存哈希。
 * - Worker Credential：拿 Pairing Code 换来的长期凭据，只存哈希，绑定一个 workerId；
 *   之后这台机器每次连 hub 都带它。吊销 = 作废凭据 + 立刻断开。
 */
export const PAIRING_TTL_MS = 15 * 60 * 1000;
export const PAIRING_PREFIX = 'ahw_pair_';
export const CREDENTIAL_PREFIX = 'ahw_';

export interface PairingCode {
  readonly hash: string;
  readonly createdBy: UserId;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly usedAt: number | null;
  /** 兑换出的那台机器。 */
  readonly workerId: string | null;
  /** 签发时选的能力预设展开后的能力集（ADR 0030 P4）；null = 老码，按 full。 */
  readonly capabilities?: readonly string[] | null;
}

/** 轮换的宽限期：新凭据 5 分钟内连上才算换成功，否则作废新的、留旧的（ADR 0030 D3）。 */
export const ROTATION_GRACE_MS = 5 * 60 * 1000;

export interface WorkerCredential {
  readonly workerId: string;
  readonly tokenHash: string;
  readonly enrolledBy: UserId;
  readonly label: string;
  readonly createdAt: number;
  readonly revokedAt: number | null;
  /** 能力上限（ADR 0030 D3）；null = 老凭据，按 full。 */
  readonly capabilities?: readonly string[] | null;
  /** 最近一次连上（hello 通过）的时间、来源地址、报的版本（ADR 0030 D3）。 */
  readonly lastConnectedAt?: number | null;
  readonly lastAddress?: string | null;
  readonly lastUserAgent?: string | null;
  readonly rotatedAt?: number | null;
  /** 轮换中的新凭据哈希与宽限截止；新凭据连上即转正（token_hash 换成它），过期作废。 */
  readonly pendingHash?: string | null;
  readonly pendingUntil?: number | null;
  /** 最近一次轮换失败的时间（下发失败或宽限期内没换上）。 */
  readonly rotationFailedAt?: number | null;
}

export type RotationState = 'none' | 'pending' | 'failed' | 'rotated';

/** 凭据的轮换状态（UI 显示用）。 */
export function rotationState(credential: WorkerCredential, now: number): RotationState {
  if (credential.pendingHash && credential.pendingUntil != null) return credential.pendingUntil > now ? 'pending' : 'failed';
  if (credential.rotationFailedAt != null && credential.rotationFailedAt >= (credential.rotatedAt ?? 0)) return 'failed';
  return credential.rotatedAt != null ? 'rotated' : 'none';
}

export interface WorkerConnection {
  readonly at: number;
  readonly address: string | null;
  readonly userAgent: string | null;
}
