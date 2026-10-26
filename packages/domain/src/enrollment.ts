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
}

export interface WorkerCredential {
  readonly workerId: string;
  readonly tokenHash: string;
  readonly enrolledBy: UserId;
  readonly label: string;
  readonly createdAt: number;
  readonly revokedAt: number | null;
}
