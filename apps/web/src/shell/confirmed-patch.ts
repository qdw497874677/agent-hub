import type { CanvasDto, SessionDto, TaskDto } from '@agent-hub/contract';

/**
 * 服务端已确认的配置快照：只取「这次请求负责的字段」。
 *
 * 不能整条 SessionDto 盖进画布：请求在飞的时候 SSE 可能已经推来更新的状态、序号或正文，
 * 整条替换会把新数据退回去。模型、可调项和候选清单是这条请求的结果，其它字段留给画布。
 */
export function patchSessionConfig(session: SessionDto, confirmed: SessionDto): SessionDto {
  return {
    ...session,
    model: confirmed.model,
    options: confirmed.options,
    optionSpec: confirmed.optionSpec
  };
}

/** 把一条已确认的会话配置并进画布；会话不在画布（侧聊）时原样返回。 */
export function patchCanvasSessionConfig(canvas: CanvasDto, confirmed: SessionDto): CanvasDto {
  let found = false;
  const sessions = canvas.sessions.map((session) => {
    if (session.id !== confirmed.id) return session;
    found = true;
    return patchSessionConfig(session, confirmed);
  });
  return found ? { ...canvas, sessions } : canvas;
}

/**
 * 归档 / 恢复的回执只负责「归档时间」，别的字段可能比画布里的旧：
 * 请求在飞的时候 SSE 可能已经推来新的状态、摘要或日志序号，整条替换会把它们退回去。
 * updatedAt 只前进不后退；任务不在画布里时补进去（恢复时原始任务可能已被拆分掉）。
 */
export function patchCanvasTask(canvas: CanvasDto, confirmed: TaskDto): CanvasDto {
  const current = canvas.tasks.find((task) => task.id === confirmed.id);
  if (!current) return { ...canvas, tasks: [...canvas.tasks, confirmed] };
  const updatedAt = Math.max(current.updatedAt, confirmed.updatedAt);
  return {
    ...canvas,
    tasks: canvas.tasks.map((task) =>
      task.id === confirmed.id ? { ...task, archivedAt: confirmed.archivedAt, updatedAt } : task
    )
  };
}
