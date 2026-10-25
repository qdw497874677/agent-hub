import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { DomainError } from '@agent-hub/domain';

const STATUS_OF: Record<DomainError['code'], ContentfulStatusCode> = {
  invalid: 400,
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  unavailable: 503,
  not_implemented: 501
};

/** 所有错误响应都长一个样：{ error: { code, message } }。 */
export function fail(c: Context, error: DomainError): Response {
  return c.json({ error: { code: error.code, message: error.message } }, STATUS_OF[error.code]);
}
