import type { ProjectId, TaskId } from '../ids.ts';
import type { Session } from '../session.ts';
import type { Task } from '../task.ts';

/**
 * 会话通信的任务树范围（docs/design/session-communication.md）。
 *
 * 「同一棵顶层任务树」= 同一个项目里沿着 parentTaskId 往上走能到同一个根任务。
 * 这里只做纯结构推导，不读策略、不写库：
 * - 缺失 / 跨项目 / 成环 / 超过深度上限一律返回 null（失败关闭，不放宽成全局可达）；
 * - 任务列表索引按一次操作建一次，避免目录里每个会话都重新走一遍父链。
 */
export const MAX_LINEAGE_DEPTH = 64;

export interface TaskTreeIndex {
  /** 任务在本项目里的顶层根；任务不在索引、父链跨项目或成环 → null。 */
  rootOf(taskId: TaskId | null | undefined): TaskId | null;
}

interface LineageMemo {
  readonly root: TaskId;
  /** 到根的边数；根本身是 0。 */
  readonly distance: number;
}

/** 从项目任务列表建一次性索引。不在本项目里的任务不会进索引。 */
export function taskTreeIndex(tasks: readonly Task[], projectId: ProjectId): TaskTreeIndex {
  const byId = new Map<TaskId, Task>();
  for (const task of tasks) if (task.projectId === projectId) byId.set(task.id, task);
  // 只缓存完整确定的结果：根 + 距离。超过深度上限的查询不写负缓存，
  // 避免「从深节点先问」把仍能正确解析的浅祖先一起污染成 null。
  const memo = new Map<TaskId, LineageMemo | null>();

  const rootOf = (taskId: TaskId | null | undefined): TaskId | null => {
    if (!taskId) return null;
    const cached = memo.get(taskId);
    if (cached !== undefined) return cached === null ? null : cached.root;

    const path: TaskId[] = [];
    const seen = new Set<TaskId>();
    let current: TaskId | null = taskId;
    let root: TaskId | null = null;
    let fromMemo: LineageMemo | null = null;
    let tooDeep = false;
    while (current) {
      if (seen.has(current)) {
        root = null;
        break;
      }
      const memoized = memo.get(current);
      if (memoized !== undefined) {
        if (memoized === null) {
          root = null;
          break;
        }
        // 起点到根的距离 = 已走过的节点数 + 缓存祖先到根的距离。
        if (path.length + memoized.distance >= MAX_LINEAGE_DEPTH) {
          root = null;
          tooDeep = true;
          break;
        }
        root = memoized.root;
        fromMemo = memoized;
        break;
      }
      if (path.length >= MAX_LINEAGE_DEPTH) {
        root = null;
        tooDeep = true;
        break;
      }
      const task = byId.get(current);
      if (!task) {
        root = null;
        break;
      }
      seen.add(current);
      path.push(current);
      current = task.parentTaskId ?? null;
      if (!current) root = task.id;
    }

    if (root === null) {
      // 缺失 / 跨项目 / 环是绝对失败，可以安全地负缓存整条路径；
      // 深度溢出只对这次调用成立，不写缓存。
      if (!tooDeep) for (const id of path) memo.set(id, null);
      return null;
    }

    if (fromMemo) {
      for (let i = 0; i < path.length; i += 1) {
        const distance = path.length - i + fromMemo.distance;
        memo.set(path[i]!, { root, distance });
      }
    } else {
      // path 末尾就是根：path[i] 到根的距离是 path.length - 1 - i。
      for (let i = 0; i < path.length; i += 1) memo.set(path[i]!, { root, distance: path.length - 1 - i });
    }
    return root;
  };

  return { rootOf };
}

/**
 * 单个任务的根（发送时只有两端，不必扫整个项目）。
 * loadTask 返回别的项目 / null 都算不可确认，直接 null。
 */
export async function taskTreeRoot(
  taskId: TaskId,
  projectId: ProjectId,
  loadTask: (id: TaskId) => Promise<Task | null>
): Promise<TaskId | null> {
  const seen = new Set<TaskId>();
  let current: TaskId | null = taskId;
  let depth = 0;
  while (current) {
    if (seen.has(current) || depth >= MAX_LINEAGE_DEPTH) return null;
    seen.add(current);
    depth += 1;
    const task = await loadTask(current);
    if (!task || task.projectId !== projectId) return null;
    if (!task.parentTaskId) return task.id;
    current = task.parentTaskId;
  }
  return null;
}

export function sameTaskTreeRoot(a: TaskId | null, b: TaskId | null): boolean {
  return a !== null && b !== null && a === b;
}

export function inSameTaskTree(index: TaskTreeIndex, a: TaskId | null, b: TaskId | null): boolean {
  if (!a || !b) return false;
  const root = index.rootOf(a);
  return root !== null && root === index.rootOf(b);
}

/**
 * 会话参与任务树推导时用的任务 id。
 * 没有任务、或不可变来源明确指向别的项目 → null（不按放置/工作空间反推）。
 */
export function lineageTaskId(session: Pick<Session, 'taskId' | 'originProjectId'>, projectId: ProjectId): TaskId | null {
  if (!session.taskId) return null;
  if (session.originProjectId != null && session.originProjectId !== projectId) return null;
  return session.taskId;
}
