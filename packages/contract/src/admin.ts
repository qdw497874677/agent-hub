import { z } from 'zod';
import { accountSchema } from './auth.ts';
import { agentReadinessSchema } from './wire/entities.ts';

/** 运营后台（/api/admin/*，只有主人能调）的请求与响应形状。 */
export const roleRequest = z.object({ role: z.enum(['owner', 'member']) });
export const settingsSchema = z.object({ openRegistration: z.boolean(), membersCanAddMachines: z.boolean() });
export type SettingsDto = z.infer<typeof settingsSchema>;
export const settingsPatchRequest = settingsSchema.partial();

export const adminUserSchema = accountSchema.extend({
  disabled: z.boolean(),
  createdAt: z.number(),
  lastSeenAt: z.number().nullable(),
  activeLogins: z.number()
});
export type AdminUserDto = z.infer<typeof adminUserSchema>;

export const adminWorkerSchema = z.object({
  workerId: z.string(),
  label: z.string(),
  origin: z.enum(['local', 'remote']),
  state: z.string(),
  reason: z.string().nullable(),
  hostname: z.string().nullable(),
  platform: z.string().nullable(),
  lastSeenAt: z.number().nullable(),
  sessionCount: z.number(),
  /** 谁加的这台机器：本机、某人凭接入码加的（邮箱），或凭共享 HUB_TOKEN 接入的老机器。 */
  enrolledBy: z.string(),
  /** 有没有专属凭据（凭接入码加的）。 */
  dedicated: z.boolean().default(false),
  build: z.object({ version: z.string(), commit: z.string().nullable(), protocol: z.number() }).nullable(),
  /** 和 hub 的版本不一致（或没报版本）。 */
  outdated: z.boolean(),
  update: z
    .object({ state: z.string(), message: z.string(), logTail: z.string(), at: z.number() })
    .nullable(),
  /** 各 harness 在这台上能不能用（Worker 探测的）；readiness 缺省 = 老 Worker 没报，当作能用。 */
  harnesses: z.array(z.object({ agentId: z.string(), readiness: agentReadinessSchema.optional() })).default([])
});
export type AdminWorkerDto = z.infer<typeof adminWorkerSchema>;

export const adminWorkersSchema = z.object({
  hub: z.object({ version: z.string(), commit: z.string().nullable(), protocol: z.number() }),
  workers: z.array(adminWorkerSchema)
});
export type AdminWorkersDto = z.infer<typeof adminWorkersSchema>;

export const auditEntrySchema = z.object({
  id: z.string(),
  actorEmail: z.string(),
  action: z.string(),
  target: z.string(),
  detail: z.string(),
  at: z.number()
});
export type AuditEntryDto = z.infer<typeof auditEntrySchema>;

export const adminOverviewSchema = z.object({
  users: z.number(),
  disabledUsers: z.number(),
  onlineWorkers: z.number(),
  workers: z.number(),
  runningSessions: z.number(),
  recentUsers: z.array(z.object({ email: z.string(), displayName: z.string(), role: z.string(), createdAt: z.number() })),
  recentLogins: z.array(z.object({ email: z.string(), method: z.string(), userAgent: z.string().nullable(), at: z.number() }))
});
export type AdminOverviewDto = z.infer<typeof adminOverviewSchema>;

/** 「加一台机器」：成员能不能加由设置决定；只给说明，不给 token。 */
export const enrollInfoSchema = z.object({ allowed: z.boolean(), hubUrl: z.string() });
export type EnrollInfoDto = z.infer<typeof enrollInfoSchema>;

/** 「添加机器」签发的一次性接入码与一行安装命令。码只在这次响应里出现。 */
export const pairingSchema = z.object({
  code: z.string(),
  expiresAt: z.number(),
  /** 在新机器上粘贴运行的一行命令（curl 安装脚本 | HUB_PAIR=… bash）。 */
  command: z.string(),
  hubUrl: z.string()
});
export type PairingDto = z.infer<typeof pairingSchema>;


/* ── 资产中心（docs/design/asset-hub.md）：技能 / 指令，按 Worker 安装 ── */

export const assetKindSchema = z.enum(['skill', 'instruction', 'mcp']);
export const assetSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('upload') }),
  z.object({ type: z.literal('git'), url: z.string(), ref: z.string().nullable(), path: z.string() })
]);
export const assetFileSchema = z.object({ path: z.string(), sha256: z.string(), size: z.number() });

export const assetSchema = z.object({
  id: z.string(),
  kind: assetKindSchema,
  name: z.string(),
  description: z.string(),
  source: assetSourceSchema,
  pinned: z.string(),
  latest: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  workerIds: z.array(z.string()),
  files: z.number(),
  bytes: z.number()
});
export type AssetDto = z.infer<typeof assetSchema>;

export const workerAssetSyncSchema = z.object({
  workerId: z.string(),
  state: z.enum(['pending', 'syncing', 'synced', 'failed']),
  root: z.string().nullable(),
  installed: z.record(z.string(), z.string()),
  error: z.string().nullable(),
  at: z.number()
});
export type WorkerAssetSyncDto = z.infer<typeof workerAssetSyncSchema>;

export const assetsOverviewSchema = z.object({
  assets: z.array(assetSchema),
  workers: z.array(
    z.object({
      workerId: z.string(),
      label: z.string(),
      state: z.string(),
      assetIds: z.array(z.string()),
      sync: workerAssetSyncSchema.nullable()
    })
  )
});
export type AssetsOverviewDto = z.infer<typeof assetsOverviewSchema>;

export const assetRevisionSchema = z.object({
  assetId: z.string(),
  digest: z.string(),
  name: z.string(),
  description: z.string(),
  files: z.array(assetFileSchema),
  commit: z.string().nullable(),
  createdAt: z.number()
});
export type AssetRevisionDto = z.infer<typeof assetRevisionSchema>;

/** 上传：文件内容 base64。总量上限见 domain ASSET_LIMITS。 */
export const assetUploadFileSchema = z.object({ path: z.string().min(1).max(512), data: z.string() });
export const assetUploadRequest = z.object({
  kind: assetKindSchema,
  name: z.string().max(64).nullable().optional(),
  files: z.array(assetUploadFileSchema).min(1).max(200)
});
export type AssetUploadRequest = z.infer<typeof assetUploadRequest>;
export const assetRevisionUploadRequest = z.object({ files: z.array(assetUploadFileSchema).min(1).max(200) });

export const gitScanRequest = z.object({ url: z.string().min(1).max(2048), ref: z.string().max(256).nullable().optional() });
export const gitCandidateSchema = z.object({ kind: assetKindSchema, path: z.string(), name: z.string(), description: z.string() });
export const gitScanSchema = z.object({ commit: z.string(), candidates: z.array(gitCandidateSchema) });
export type GitScanDto = z.infer<typeof gitScanSchema>;
export type GitCandidateDto = z.infer<typeof gitCandidateSchema>;
export const gitImportRequest = gitScanRequest.extend({
  kind: assetKindSchema,
  path: z.string().max(1024),
  name: z.string().max(64).nullable().optional()
});

export const assetDiffSchema = z.object({
  files: z.array(z.object({ path: z.string(), change: z.enum(['added', 'removed', 'modified', 'unchanged']), patch: z.string().nullable() }))
});
export type AssetDiffDto = z.infer<typeof assetDiffSchema>;
export const assetPinRequest = z.object({ digest: z.string().regex(/^[0-9a-f]{64}$/) });
export const assetInstallRequest = z.object({ installed: z.boolean() });

/* ── MCP 资产的密钥：界面只见名字、时间、谁在用，从不回显值 ── */
const secretViewSchema = z.object({ name: z.string(), updatedAt: z.number(), usedBy: z.array(z.string()) });
export const secretsOverviewSchema = z.object({ secrets: z.array(secretViewSchema), missing: z.array(secretViewSchema) });
export type SecretsOverviewDto = z.infer<typeof secretsOverviewSchema>;
export const secretPutRequest = z.object({ value: z.string().min(1).max(16 * 1024) });
