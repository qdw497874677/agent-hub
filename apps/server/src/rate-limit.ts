/** 固定窗口计数：防撞库/刷注册够用，单进程内存即可（多实例时再换）。 */
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
