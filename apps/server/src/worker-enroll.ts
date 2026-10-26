import type { EnrollmentDeps } from '@agent-hub/domain';
import { enrollWorker } from '@agent-hub/domain';
import { createRateLimiter } from './rate-limit.ts';

/**
 * 接入握手的组合：worker 网关收到 enroll 帧 → 这里限流 → 领域 enrollWorker 用例。
 * 与传输无关的规则（配对码一次性、过期、签发人没被停用）都在领域里。
 */
export function createWorkerEnroll(deps: EnrollmentDeps, options: { readonly rateMax?: number } = {}) {
  const limiter = createRateLimiter({ max: options.rateMax ?? 10, windowMs: 10 * 60 * 1000, now: deps.now });
  return async (request: { readonly code: string; readonly label: string; readonly address?: string | undefined }) => {
    if (!limiter.hit(`enroll:${request.address ?? 'unknown'}`)) return { ok: false as const, reason: '尝试太频繁了，过一会儿再试' };
    const result = await enrollWorker(deps, { code: request.code, label: request.label });
    return result.ok
      ? { ok: true as const, workerId: result.value.workerId, credential: result.value.credential }
      : { ok: false as const, reason: result.error.message };
  };
}
