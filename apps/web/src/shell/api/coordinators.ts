import type { SessionDto } from '@agent-hub/contract';
import { call, post } from './http.ts';

/**
 * 项目主会话（`apps/server/src/workspace-coordinator.ts`）。
 *
 * 「没有任务的会话」不止主会话：bot、群角色、连接器也会开无任务会话。唯一能区分的是这份登记表——
 * 只认登记过的，别按 `taskId === null` 猜，否则界面会把别人的会话喊成「主会话」。
 */
export interface CoordinatorDto {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly createdBy: string | null;
  readonly createdAt: number;
}

export interface CoordinatorsDto {
  readonly coordinators: readonly CoordinatorDto[];
}

export interface StartCoordinatorDto {
  readonly coordinator: CoordinatorDto;
  readonly session: SessionDto;
  /** false = 这条工作目录本来就有主会话，服务端原样复用。 */
  readonly created: boolean;
}

/** 开主会话只认人（cookie 身份），所以这几个字段和派生对话框的语义分开写。 */
export interface StartCoordinatorInput {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly model?: string;
  readonly profileId?: string;
  readonly options?: Readonly<Record<string, string | boolean>>;
}

export const coordinatorsApi = {
  list: (projectId: string) =>
    call<CoordinatorsDto>(`/api/coordinators?projectId=${encodeURIComponent(projectId)}`),
  at: (projectId: string, workspaceId: string) =>
    call<{ coordinator: CoordinatorDto; session: SessionDto }>(
      `/api/coordinators?projectId=${encodeURIComponent(projectId)}&workspaceId=${encodeURIComponent(workspaceId)}`
    ),
  start: (input: StartCoordinatorInput) =>
    post<StartCoordinatorDto>('/api/coordinators', {
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      ...(input.model ? { model: input.model } : {}),
      ...(input.profileId ? { profileId: input.profileId } : {}),
      ...(input.options && Object.keys(input.options).length > 0 ? { options: input.options } : {})
    })
};
