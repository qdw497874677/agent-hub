import type { PairingCode, WorkerCredential } from '../enrollment.ts';

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
}
