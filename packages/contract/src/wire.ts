import type { z } from 'zod';
import type { agentSchema, artifactSchema, attachmentInputSchema, canvasSchema, capabilitySchema, journalEntrySchema, layoutSchema, optionValueSchema, projectSchema, runtimeOptionSchema, searchHitSchema, searchResponseSchema, sessionEventSchema, sessionSchema, storedAttachmentSchema, taskSchema, workspaceSchema, workspaceViewSchema } from './wire/entities.ts';
import type { continueElsewhereRequest, createProjectRequest, createWorkspaceRequest, createTaskRequest, removeWorkspaceRequest, workspaceChangesSchema, deriveSessionRequest, directoryEntrySchema, directoryListingSchema, forkSessionRequest, homeSchema, projectFilesSchema, projectSummarySchema, recentSessionSchema, saveLayoutRequest, sessionStreamFrameSchema, workerInfoSchema } from './wire/http.ts';
import type { resourceSampleSchema, workerMetricsHistorySchema, workerResourcesSchema } from './wire/resources.ts';
import type { serverToWorkerSchema, workerToServerSchema } from './wire/worker.ts';

/**
 * 线上格式。Zod 定义边界，`z.infer` 出类型——只有一份真源。
 * 领域类型是内核的真源；这一层只负责「过网时怎么写」，不含任何业务判断。
 */


// 按领域拆在 wire/ 下；这里汇总导出，外面照旧 `from './wire.ts'`。
export * from './wire/entities.ts';
export * from './wire/http.ts';
export * from './wire/worker.ts';
export * from './wire/resources.ts';

export type CapabilityDto = z.infer<typeof capabilitySchema>;
export type AgentDto = z.infer<typeof agentSchema>;
export type RuntimeOptionDto = z.infer<typeof runtimeOptionSchema>;
export type OptionValueDto = z.infer<typeof optionValueSchema>;
export type ProjectDto = z.infer<typeof projectSchema>;
export type WorkspaceDto = z.infer<typeof workspaceSchema>;
export type WorkspaceViewDto = z.infer<typeof workspaceViewSchema>;
export type CreateWorkspaceRequest = z.input<typeof createWorkspaceRequest>;
export type TaskDto = z.infer<typeof taskSchema>;
export type SessionDto = z.infer<typeof sessionSchema>;
export type ArtifactDto = z.infer<typeof artifactSchema>;
export type LayoutDto = z.infer<typeof layoutSchema>;
export type CanvasDto = z.infer<typeof canvasSchema>;
export type SessionEventDto = z.infer<typeof sessionEventSchema>;
export type JournalEntryDto = z.infer<typeof journalEntrySchema>;
export type SearchHitDto = z.infer<typeof searchHitSchema>;
export type SearchResponseDto = z.infer<typeof searchResponseSchema>;
export type WorkerInfoDto = z.infer<typeof workerInfoSchema>;
export type ResourceSampleDto = z.infer<typeof resourceSampleSchema>;
export type WorkerResourcesDto = z.infer<typeof workerResourcesSchema>;
export type WorkerMetricsHistoryDto = z.infer<typeof workerMetricsHistorySchema>;
export type ProjectSummaryDto = z.infer<typeof projectSummarySchema>;
export type HomeDto = z.infer<typeof homeSchema>;
export type RecentSessionDto = z.infer<typeof recentSessionSchema>;
export type DirectoryEntryDto = z.infer<typeof directoryEntrySchema>;
export type DirectoryListingDto = z.infer<typeof directoryListingSchema>;
export type CreateProjectRequest = z.infer<typeof createProjectRequest>;
export type CreateTaskRequest = z.infer<typeof createTaskRequest>;
export type DeriveSessionRequest = z.infer<typeof deriveSessionRequest>;
export type ForkSessionRequest = z.infer<typeof forkSessionRequest>;
export type ContinueElsewhereRequest = z.infer<typeof continueElsewhereRequest>;
export type SaveLayoutRequest = z.infer<typeof saveLayoutRequest>;
export type AttachmentInputDto = z.infer<typeof attachmentInputSchema>;
export type StoredAttachmentDto = z.infer<typeof storedAttachmentSchema>;
export type ProjectFilesDto = z.infer<typeof projectFilesSchema>;
export type SessionStreamFrame = z.infer<typeof sessionStreamFrameSchema>;
export type WorkerToServer = z.infer<typeof workerToServerSchema>;
export type ServerToWorker = z.infer<typeof serverToWorkerSchema>;

export type RemoveWorkspaceRequest = z.input<typeof removeWorkspaceRequest>;
export type WorkspaceChangesDto = z.infer<typeof workspaceChangesSchema>;
