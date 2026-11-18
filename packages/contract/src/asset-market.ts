import { z } from 'zod';
import { assetSourcePolicySchema, assetUploadFileSchema } from './admin.ts';

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
  path: z.string().max(1024),
  policy: assetSourcePolicySchema.optional(),
  /** 私有仓库令牌：只用于这次拉取；track 时服务端存进密钥箱。 */
  credential: z.string().min(1).max(512).optional()
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
  twoReviewers: z.object({ global: z.boolean(), mcpStdio: z.boolean() }),
  /** 团队资产免审（target = team）；不传 = 不改。 */
  teamNoReview: z.boolean().optional(),
  /** hub 管理员改别的团队的免审开关时指定；默认自己的团队。 */
  teamId: z.string().max(64).optional()
});
export const notificationsReadRequest = z.object({ ids: z.array(z.string()).max(200).nullable() });
export const scopedSecretRequest = z.object({ value: z.string().min(1).max(16384) });


/* ── 内置资产（Hub 随代码带的清单，一键启用到项目） ── */

export const builtinEnableRequest = z.object({
  projectId: z.string().min(1),
  /** 这次顺手填的密钥（名字 → 值），存成团队密钥。 */
  secrets: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.string().max(16384)).optional()
});

export const builtinAssetViewSchema = z.object({
  id: z.string(),
  kind: z.enum(['skill', 'instruction', 'mcp']),
  name: z.string(),
  title: z.string(),
  summary: z.string(),
  version: z.string(),
  source: z.object({ label: z.string(), url: z.string(), license: z.string() }),
  secrets: z.array(z.object({ name: z.string(), label: z.string(), hint: z.string(), url: z.string().optional(), set: z.boolean() })),
  requiresBrowser: z.boolean(),
  note: z.string().nullable(),
  pairsWith: z.array(z.string()),
  enabled: z.object({ assetId: z.string(), version: z.string(), on: z.boolean(), update: z.string().nullable() }).nullable(),
  clash: z.string().nullable()
});

export const browserStatusSchema = z.object({
  workerId: z.string(),
  label: z.string(),
  online: z.boolean(),
  ready: z.boolean(),
  installing: z.boolean(),
  blocker: z.string().nullable()
});

export type BuiltinEnableRequest = z.input<typeof builtinEnableRequest>;
export type BuiltinAssetView = z.infer<typeof builtinAssetViewSchema>;
export type BrowserStatusDto = z.infer<typeof browserStatusSchema>;
