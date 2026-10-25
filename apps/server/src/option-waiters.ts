/**
 * 等某条会话的下一次可调项回报（用户改完模型/档位的那一次）。
 *
 * agent 不回就等 `timeoutMs`：宁可让界面显示「没变」，也不要挂住一个请求。
 */
export function createOptionWaiters(timeoutMs = 8000) {
  const waiters = new Map<string, () => void>();
  return {
    wait(sessionId: string): Promise<void> {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(sessionId);
          resolve();
        }, timeoutMs);
        waiters.set(sessionId, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    resolve(sessionId: string): void {
      waiters.get(sessionId)?.();
      waiters.delete(sessionId);
    }
  };
}
