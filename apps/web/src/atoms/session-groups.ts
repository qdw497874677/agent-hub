// 只读类型：atom 的测试跑在根 tsconfig（没有 DOM），不能顺着 shell/api 拉进浏览器那一层。
import type { CanvasDto, SessionDto } from '@agent-hub/contract';
import { sessionListLabel } from './session-label.ts';

/**
 * 画布会话按「归属任务」分组：列表视图和别处都读这一份，免得两处对「无任务」各说各话。
 *
 * 没有归属任务的会话分两种，别混成一句：
 * - **主会话**：项目登记表里有的常驻会话（人手动开的），组名「主会话」；
 * - **没有任务的会话**：bot / 群角色 / 连接器开的容器会话，组名是中性的那句。
 * 分组只认传进来的 `coordinatorIds`（来自 `/api/coordinators`），不按 `taskId === null` 猜。
 */
export const UNASSIGNED_KEY = 'container';
export const UNASSIGNED_TITLE = '没有任务的会话';
export const COORDINATOR_KEY = 'coordinators';
export const COORDINATOR_TITLE = '主会话';

export type SessionGroupKind = 'task' | 'coordinator' | 'unassigned';

export interface SessionGroup {
  /** 任务的 id；两个无任务桶分别是 `COORDINATOR_KEY` / `UNASSIGNED_KEY`。 */
  readonly taskId: string;
  readonly kind: SessionGroupKind;
  /** 没有归属任务：组名不是任务标题。 */
  readonly taskless: boolean;
  readonly title: string;
  readonly sessions: readonly { readonly session: SessionDto; readonly label: string }[];
}

export function groupSessions(
  canvas: Pick<CanvasDto, 'tasks' | 'sessions' | 'previews' | 'openings'>,
  coordinatorIds: ReadonlySet<string> = new Set()
): readonly SessionGroup[] {
  const byTask = new Map<string, CanvasDto['sessions'][number][]>();
  for (const session of canvas.sessions) {
    const key = session.taskId ?? (coordinatorIds.has(session.id) ? COORDINATOR_KEY : UNASSIGNED_KEY);
    byTask.set(key, [...(byTask.get(key) ?? []), session]);
  }
  const order = [
    ...canvas.tasks.map((task) => task.id),
    // 主会话排在没有任务的会话之前：它是这个项目里人最常回去的那条。
    ...(byTask.has(COORDINATOR_KEY) ? [COORDINATOR_KEY] : []),
    ...[...byTask.keys()].filter(
      (id) => id !== COORDINATOR_KEY && !canvas.tasks.some((task) => task.id === id)
    )
  ];
  return order
    .filter((taskId) => byTask.has(taskId))
    .map((taskId) => {
      const sessions = [...(byTask.get(taskId) ?? [])].sort((a, b) => a.createdAt - b.createdAt);
      const task = canvas.tasks.find((candidate) => candidate.id === taskId);
      const kind: SessionGroupKind =
        task !== undefined ? 'task' : taskId === COORDINATOR_KEY ? 'coordinator' : 'unassigned';
      return {
        taskId,
        kind,
        taskless: kind !== 'task',
        title: task?.title ?? (kind === 'coordinator' ? COORDINATOR_TITLE : UNASSIGNED_TITLE),
        sessions: sessions.map((session, index) => {
          const prompt = (canvas.previews[session.id] ?? []).find((entry) => entry.event.kind === 'prompt');
          const previewText = prompt && prompt.event.kind === 'prompt' ? prompt.event.text : '';
          return {
            session,
            label: sessionListLabel({ title: session.title, previewText, opening: canvas.openings[session.id], index })
          };
        })
      };
    });
}
