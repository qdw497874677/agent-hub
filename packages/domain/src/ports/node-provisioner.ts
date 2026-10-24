import type { DomainError } from '../errors.ts';
import type { Result } from '../result.ts';

/** T2 · 端口在、实现空。调用返回「未实现」，没有代码路径假装能用。 */
export interface NodeProvisioner {
  install(workerLabel: string): Promise<Result<void, DomainError>>;
  upgrade(workerId: string): Promise<Result<void, DomainError>>;
  revoke(workerId: string): Promise<Result<void, DomainError>>;
}
