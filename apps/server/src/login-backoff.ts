/**
 * 按邮箱的登录退避（ADR 0011）：同一个邮箱连错 5 次以后，每次再试前要等
 * 1 秒、2 秒、4 秒……最多 15 分钟；登录成功清零。从不永久锁号（不然谁都能把别人锁在门外）。
 * 只放内存（单实例，hub 重启清零），与 rate-limit.ts 同样的取舍。
 */
export const FREE_ATTEMPTS = 5;
export const BASE_DELAY_MS = 1000;
export const MAX_DELAY_MS = 15 * 60 * 1000;

/** 第 n 次失败（从 1 数）之后要等多久。 */
export function delayAfter(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (failures - FREE_ATTEMPTS));
}

export function createLoginBackoff(now: () => number) {
  const state = new Map<string, { failures: number; lastAt: number }>();
  return {
    /** 现在还要等多少毫秒才能再试；0 = 可以试。 */
    wait(key: string): number {
      const entry = state.get(key);
      if (!entry) return 0;
      return Math.max(0, entry.lastAt + delayAfter(entry.failures) - now());
    },
    fail(key: string): void {
      const at = now();
      if (state.size > 10_000) for (const [k, v] of state) if (at - v.lastAt > MAX_DELAY_MS * 2) state.delete(k);
      const entry = state.get(key);
      state.set(key, { failures: (entry?.failures ?? 0) + 1, lastAt: at });
    },
    succeed(key: string): void {
      state.delete(key);
    }
  };
}
