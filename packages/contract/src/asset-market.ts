import { z } from 'zod';
import { assetUploadFileSchema } from './admin.ts';

/** 资产市场 / 审核（ADR 0016）的请求体。响应是领域 DTO 原样 JSON（见 apps/web/src/api.ts 的类型）。 */
export const assetScopeSchema = z.enum(['personal', 'project', 'team', 'global']);
const kind = z.enum(['skill', 'instruction', 'mcp']);

export const marketUploadRequest = z.object({
  kind,
  scope: assetScopeSchema,
  projectId: z.string().nullable().optional(),
  name: z.string().max(64).nullable().optional(),
  files: z.array(assetUploadFileSchema).min(1).max(200)
});
export const marketGitRequest = z.object({
  kind,
  scope: assetScopeSchema,
  projectId: z.string().nullable().optional(),
  name: z.string().max(64).nullable().optional(),
  url: z.string().min(1).max(2048),
  ref: z.string().max(256).nullable().optional(),
  path: z.string().max(1024)
});
export const marketRevisionRequest = z.object({ files: z.array(assetUploadFileSchema).min(1).max(200) });
export const approveRequest = z.object({ acknowledgeHigh: z.boolean().optional(), note: z.string().max(500).optional() });
export const rejectRequest = z.object({ reason: z.string().min(1).max(2000), changesRequested: z.boolean().optional() });
export const reasonRequest = z.object({ reason: z.string().min(1).max(2000) });
export const commentRequest = z.object({
  path: z.string().max(512).nullable().optional(),
  line: z.number().int().positive().nullable().optional(),
  body: z.string().min(1).max(4000)
});
export const installDecisionRequest = z.object({ approve: z.boolean(), reason: z.string().max(2000).optional() });
export const reviewSettingsRequest = z.object({
  target: z.enum(['team', 'hub']),
  reviewers: z.array(z.string()).max(50),
  twoReviewers: z.object({ global: z.boolean(), mcpStdio: z.boolean() })
});
export const notificationsReadRequest = z.object({ ids: z.array(z.string()).max(200).nullable() });
export const scopedSecretRequest = z.object({ value: z.string().min(1).max(16384) });
