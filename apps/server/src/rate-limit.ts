/** 固定窗口计数：防撞库/刷注册够用。只放内存是有意的（单实例；取舍见 docs/design/accounts.md §9）。 */
export function createRateLimiter(options: { max: number; windowMs: number; now: () => number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    /** 记一次；超限返回 false。 */
    hit(key: string): boolean {
      const now = options.now();
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + options.windowMs });
        return true;
      }
      entry.count += 1;
      return entry.count <= options.max;
    }
  };
}
