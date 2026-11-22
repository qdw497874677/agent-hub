import { asTaskId, type Task } from '@agent-hub/domain';
import { toTask } from './mappers.ts';

/**
 * 任务行映射的任务专属扩展：在既有 `toTask` 之上补 `parentTaskId`。
 *
 * 放在独立文件里，`store.ts` 只需把读取路径换成本函数（签名兼容），
 * 不必改动其它实体的映射；没有父任务时与领域构造统一为 null，保证保存读回一致。
 */
export function toTaskWithParent(row: Record<string, unknown>): Task {
  const task = toTask(row);
  const parent = row.parent_task_id;
  return { ...task, parentTaskId: typeof parent === 'string' && parent !== '' ? asTaskId(parent) : null };
}
