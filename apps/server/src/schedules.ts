/** 定时器登记处：装配阶段把 setInterval / setTimeout 都记在这里，关停时一次清干净。 */
export interface Schedules {
  every(ms: number, run: () => void): void;
  after(ms: number, run: () => void): void;
  clear(): void;
}

export function createSchedules(): Schedules {
  const timers = new Set<ReturnType<typeof setInterval>>();
  return {
    every(ms, run) {
      const timer = setInterval(run, ms);
      timer.unref();
      timers.add(timer);
    },
    after(ms, run) {
      const timer = setTimeout(() => { timers.delete(timer); run(); }, ms);
      timer.unref();
      timers.add(timer);
    },
    clear() {
      for (const timer of timers) { clearInterval(timer); clearTimeout(timer); }
      timers.clear();
    }
  };
}
