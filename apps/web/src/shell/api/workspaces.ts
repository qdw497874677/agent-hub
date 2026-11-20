export type {
  CreateTeamWorkspaceRequest,
  CreateWorkspaceRequest,
  TeamWorkspaceViewDto,
  WorkspaceChangesDto,
  WorkspaceDto,
  WorkspaceViewDto
} from '@agent-hub/contract';
export type { WorkspaceGroupMemberView, WorkspaceGroupView } from '../../surfaces/workbench/workspace-group.ts';

export interface CleanupPolicyDto {
  prMerged: boolean;
  taskEndedClean: boolean;
  idleDays: number | null;
  deleteWorktreeOnSessionDelete?: boolean;
}
export interface CleanupRecordsDto {
  items: { runId: string; workspaceId: string; path: string; branch: string | null; action: 'removed' | 'kept' | 'failed'; reason: string; sizeBytes: number | null; at: number }[];
  orphans: { path: string; workerId: string | null }[];
}
