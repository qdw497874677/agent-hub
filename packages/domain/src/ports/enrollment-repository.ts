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
  credentialByHash(hash: string): Promise<WorkerCredential | null>;
  credentialFor(workerId: string): Promise<WorkerCredential | null>;
  listCredentials(): Promise<WorkerCredential[]>;
  revoke(workerId: string, at: number): Promise<void>;
  /** hello 通过后记一笔：何时、从哪、什么版本（ADR 0030 D3）。lastSeenAt 仍是心跳语义，不在这里。 */
  recordConnection(workerId: string, connection: WorkerConnection): Promise<void>;
  /** 改能力上限（只收窄由用例保证）。 */
  setCapabilities(workerId: string, capabilities: readonly string[]): Promise<void>;
}
