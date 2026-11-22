import type { TaskGate, TaskId } from '@agent-hub/domain';

export function createTaskGate(): TaskGate {
  const holders = new Map<TaskId, number>();

  function acquire(taskId: TaskId, exclusive: boolean): (() => void) | null {
    const count = holders.get(taskId) ?? 0;
    if (count < 0 || (exclusive && count !== 0)) return null;
    holders.set(taskId, exclusive ? -1 : count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (holders.get(taskId) ?? 1) - 1;
      if (exclusive || remaining === 0) holders.delete(taskId);
      else holders.set(taskId, remaining);
    };
  }

  return { enter: (id) => acquire(id, false), exclusive: (id) => acquire(id, true) };
}
