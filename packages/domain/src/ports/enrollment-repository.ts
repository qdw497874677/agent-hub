import type { PairingCode, WorkerConnection, WorkerCredential } from '../enrollment.ts';

export interface EnrollmentRepository {
  savePairing(code: PairingCode): Promise<void>;
  pairingByHash(hash: string): Promise<PairingCode | null>;
  /**
   * 原子地把一个未用过的 Pairing Code 标成已用（并发兑换只有一个能成功）。
   * 已经用过或不存在返回 false。
   */
  consumePairing(hash: string, workerId: string, at: number): Promise<boolean>;
  saveCredential(credential: WorkerCredential): Promise<void>;
  /** 按当前凭据哈希或轮换中的新凭据哈希找。 */
  credentialByHash(hash: string): Promise<WorkerCredential | null>;
  credentialFor(workerId: string): Promise<WorkerCredential | null>;
  listCredentials(): Promise<WorkerCredential[]>;
  revoke(workerId: string, at: number): Promise<void>;
  /** hello 通过后记一笔：何时、从哪、什么版本（ADR 0030 D3）。lastSeenAt 仍是心跳语义，不在这里。 */
  recordConnection(workerId: string, connection: WorkerConnection): Promise<void>;
  /** 改能力上限（只收窄由用例保证）。 */
  setCapabilities(workerId: string, capabilities: readonly string[]): Promise<void>;
  /** 开始轮换：记下新凭据哈希与宽限截止（旧的继续有效）。 */
  beginRotation(workerId: string, pendingHash: string, until: number): Promise<void>;
  /** 新凭据连上了：转正（旧哈希作废）、记 rotated_at。只在 pending_hash 还是它时生效。 */
  completeRotation(workerId: string, pendingHash: string, at: number): Promise<boolean>;
  /** 轮换失败：丢掉新凭据，留旧的，记失败时间。 */
  failRotation(workerId: string, at: number): Promise<void>;
}
