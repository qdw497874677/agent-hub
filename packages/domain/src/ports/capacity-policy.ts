import type { DomainError } from '../errors.ts';
import type { Result } from '../result.ts';

export interface AdmissionRequest {
  readonly workerId: string;
  readonly sessionId: string;
}

/** T2 · 端口在、实现空。资源管理（容量/配额/调度）的位置。 */
export interface CapacityPolicy {
  admit(request: AdmissionRequest): Promise<Result<void, DomainError>>;
  release(sessionId: string): Promise<Result<void, DomainError>>;
}
