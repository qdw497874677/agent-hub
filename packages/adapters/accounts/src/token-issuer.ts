import { createHash, randomBytes } from 'node:crypto';
import type { TokenIssuer } from '@agent-hub/domain';

/** 32 字节随机令牌（base64url），落库的是 SHA-256。 */
export function createTokenIssuer(): TokenIssuer {
  const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');
  return {
    issue() {
      const token = randomBytes(32).toString('base64url');
      return { token, hash: hashOf(token) };
    },
    hashOf
  };
}
