import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { PasswordHasher } from '@agent-hub/domain';

/**
 * scrypt（node:crypto 自带，零原生依赖）。哈希串自带参数：
 * `scrypt$N$r$p$salt$hash`（base64url），以后调参旧串仍能校验。
 * N=2^17、r=8 是 OWASP 推荐的下限，每次约 100–200ms、128MB。
 */
const N = 2 ** 17;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N: n, r, p, maxmem: 256 * n * r }, (error, key) =>
      error ? reject(error) : resolve(key)
    );
  });
}

export function createScryptHasher(cost: { n?: number; r?: number; p?: number } = {}): PasswordHasher {
  const n = cost.n ?? N;
  const r = cost.r ?? R;
  const p = cost.p ?? P;
  return {
    async hash(password) {
      const salt = randomBytes(16);
      const key = await derive(password, salt, n, r, p);
      return ['scrypt', n, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
    },
    async verify(password, encoded) {
      const [scheme, ns, rs, ps, salt, hash] = encoded.split('$');
      if (scheme !== 'scrypt' || !salt || !hash) return false;
      const expected = Buffer.from(hash, 'base64url');
      const key = await derive(password, Buffer.from(salt, 'base64url'), Number(ns), Number(rs), Number(ps));
      return key.length === expected.length && timingSafeEqual(key, expected);
    }
  };
}
