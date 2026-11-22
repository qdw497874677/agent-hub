import type { CanvasDto, TaskDto } from '@agent-hub/contract';

/**
 * 已归档任务只从“日常视图”里退场，不从画布数据里消失：
 * - 列表、画布、侧栏共用这一份裁剪结果，免得三处对“还在不在”各说各话；
 * - 直接链接、任务详情和搜索仍读原始 canvas，归档任务还能打开、恢复；
 * - 没有归属任务的会话照常保留，不能因为过滤任务把它们一起扫掉。
 */
export interface TaskDisplay {
  readonly canvas: CanvasDto;
  readonly archived: readonly TaskDto[];
}

export function splitArchivedTasks(canvas: CanvasDto): TaskDisplay {
  const archived = canvas.tasks.filter((task) => task.archivedAt != null);
  if (archived.length === 0) return { canvas, archived };
  const archivedIds = new Set(archived.map((task) => task.id));
  return {
    archived,
    canvas: {
      ...canvas,
      tasks: canvas.tasks.filter((task) => !archivedIds.has(task.id)),
      sessions: canvas.sessions.filter((session) => session.taskId === null || !archivedIds.has(session.taskId))
    }
  };
}
