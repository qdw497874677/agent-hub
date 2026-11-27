import { call, post } from './http.ts';

export interface WorktreePlanRequest {
  workerId: string;
  source: 'local' | 'project';
  members: { id: string; startRef?: string; baseWorkspaceId?: string }[];
  primaryId?: string;
  runSetup?: boolean;
}

export interface WorktreePlan {
  id: string;
  revision: number;
  state: 'draft' | 'pending' | 'unknown' | 'ready-unused' | 'closed' | 'failed';
  source: 'local' | 'project';
  workerId: string;
  members: { id: string; name: string; sourcePath: string | null; targetPath: string; branch: string; startRef: string | null; oid: string; baseAction: 'reuse' | 'clone'; state: 'pending' | 'ready' | 'failed' | 'unknown'; problem?: string }[];
  primaryId: string;
  setupCommand: string | null;
  setupState: 'skipped' | 'pending' | 'running' | 'failed' | 'unknown' | 'ready';
  workspaceId: string | null;
  groupId: string | null;
  problem?: string;
}

const plansPath = (projectId: string, taskId: string) => `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/worktree-plans`;
export const worktreePlansApi = {
  list: (projectId: string, taskId: string) => call<{ plans: WorktreePlan[] }>(plansPath(projectId, taskId)),
  preview: (projectId: string, taskId: string, request: WorktreePlanRequest) => post<WorktreePlan>(plansPath(projectId, taskId), request),
  get: (projectId: string, taskId: string, planId: string) => call<WorktreePlan>(`${plansPath(projectId, taskId)}/${encodeURIComponent(planId)}`),
  execute: (projectId: string, taskId: string, planId: string, revision: number) => post<WorktreePlan>(`${plansPath(projectId, taskId)}/${encodeURIComponent(planId)}/execute`, { revision })
};
