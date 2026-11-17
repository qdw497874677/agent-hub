import { z } from 'zod';
import { accountSchema, roleSchema } from './auth.ts';
import { agentReadinessSchema } from './wire/entities.ts';

/** 运营后台（/api/admin/*，只有主人能调）的请求与响应形状。 */
export const roleRequest = z.object({ role: roleSchema });
export const settingsSchema = z.object({
  openRegistration: z.boolean(),
  membersCanAddMachines: z.boolean()
});
export type SettingsDto = z.infer<typeof settingsSchema>;
export const settingsPatchRequest = settingsSchema.partial();

export const adminUserSchema = accountSchema.extend({
  disabled: z.boolean(),
  createdAt: z.number(),
  lastSeenAt: z.number().nullable(),
  activeLogins: z.number(),
  /** ADR 0011：hub 管理员（bootstrap 用户）；所在团队。老 hub 返回的没有这两项。 */
  clusterAdmin: z.boolean().optional(),
  teamId: z.string().nullable().optional(),
  /** 和 hub 管理员同一个团队（只有这些人能被授权用 hub 本机）。 */
  hubTeam: z.boolean().optional()
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
  /** 连接健康（ADR 0030 D1）；老 hub 没有。 */
  link: z
    .object({ state: z.enum(['connecting', 'syncing', 'live', 'degraded', 'disconnected', 'rejected']), since: z.number(), rttMs: z.number().nullable(), connectedAt: z.number().nullable() })
    .optional(),
  sessionCount: z.number(),
  /** 谁加的这台机器：本机、某人凭接入码加的（邮箱），或凭共享 HUB_TOKEN 接入的老机器。 */
  enrolledBy: z.string(),
  /** 有没有专属凭据（凭接入码加的）。 */
  dedicated: z.boolean().default(false),
  build: z.object({ version: z.string(), commit: z.string().nullable(), protocol: z.number() }).nullable(),
  /** 和 hub 的版本不一致（或没报版本）。 */
  outdated: z.boolean(),
  update: z
    .object({ state: z.string(), message: z.string(), logTail: z.string(), at: z.number(), trialRemainingMs: z.number().optional(), trialDeadlineAt: z.number().optional() })
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
  at: z.number(),
  ip: z.string().nullable(),
  teamId: z.string().nullable()
});
/** 审计过滤（query string）：action 前缀、操作人邮箱子串、IP 前缀、时间范围、团队（只有 hub 管理员能指定）。 */
export const auditQuerySchema = z.object({
  action: z.string().max(64).optional(),
  actor: z.string().max(254).optional(),
  ip: z.string().max(64).optional(),
  since: z.coerce.number().int().nonnegative().optional(),
  until: z.coerce.number().int().nonnegative().optional(),
  teamId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;
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
  /** 在新机器上粘贴运行的一行命令：下载引导脚本、核对 sha256 再执行（ADR 0030 D4）。 */
  command: z.string(),
  /** 简短版（curl … | HUB_PAIR=… bash），不校验；没有 sha256sum 的机器用。 */
  shortCommand: z.string().optional(),
  hubUrl: z.string(),
  /** 签发时选的权限预设（ADR 0030 P4）；老 hub 没有。 */
  preset: z.enum(['full', 'readonly', 'no-remote', 'no-install']).optional()
});
export type PairingDto = z.infer<typeof pairingSchema>;


/* ── 资产中心（docs/design/asset-hub.md）：技能 / 指令，按 Worker 安装 ── */

export const assetKindSchema = z.enum(['skill', 'instruction', 'mcp']);
/** 版本策略：locked（默认）钉在导入时的提交上；track 跟随 ref 检查更新。 */
export const assetSourcePolicySchema = z.enum(['track', 'locked']);
export const assetSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('upload') }),
  z.object({ type: z.literal('git'), url: z.string(), ref: z.string().nullable(), path: z.string(), policy: assetSourcePolicySchema.optional() })
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
  /** null = 全局；否则只属于这个项目（就近优先，盖过同名的全局资产）。 */
  projectId: z.string().nullable().default(null),
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
  projectId: z.string().nullable().optional(),
  files: z.array(assetUploadFileSchema).min(1).max(200)
});
export type AssetUploadRequest = z.infer<typeof assetUploadRequest>;
export const assetRevisionUploadRequest = z.object({ files: z.array(assetUploadFileSchema).min(1).max(200) });

export const gitScanRequest = z.object({
  /** 私有仓库令牌：只用于这次扫描，不落库、不回显。 */
  credential: z.string().min(1).max(512).optional(), url: z.string().min(1).max(2048), ref: z.string().max(256).nullable().optional() });
export const gitCandidateSchema = z.object({ kind: assetKindSchema, path: z.string(), name: z.string(), description: z.string() });
export const gitScanSchema = z.object({ commit: z.string(), candidates: z.array(gitCandidateSchema) });
export type GitScanDto = z.infer<typeof gitScanSchema>;
export type GitCandidateDto = z.infer<typeof gitCandidateSchema>;
export const gitImportRequest = gitScanRequest.extend({
  kind: assetKindSchema,
  path: z.string().max(1024),
  name: z.string().max(64).nullable().optional(),
  projectId: z.string().nullable().optional(),
  /** 默认 locked：钉在导入时的提交上。 */
  policy: assetSourcePolicySchema.optional(),
  /** 私有仓库的一次性令牌；只用于拉取，不落库、不回显（track 时服务端存进密钥箱）。 */
  credential: z.string().min(1).max(512).optional()
});

/** #226 批量导入：一次最多 20 项，逐项复用单条导入；一项失败不影响其它项。 */
export const gitBatchItemSchema = z.object({
  url: z.string().min(1).max(2048),
  ref: z.string().max(256).nullable().optional(),
  path: z.string().max(1024).optional(),
  policy: assetSourcePolicySchema.optional(),
  credential: z.string().min(1).max(512).optional(),
  scope: z.enum(['personal', 'project', 'team', 'global']).optional(),
  name: z.string().max(64).nullable().optional(),
  /** scope=project 时指定项目；其它作用域忽略。 */
  projectId: z.string().nullable().optional()
});
export const gitBatchImportRequest = z.object({ items: z.array(gitBatchItemSchema).min(1).max(20) });
export type GitBatchItem = z.infer<typeof gitBatchItemSchema>;
export const gitBatchImportResultSchema = z.object({
  ok: z.boolean(),
  id: z.string().optional(),
  name: z.string().optional(),
  error: z.string().optional()
});
export type GitBatchImportResult = z.infer<typeof gitBatchImportResultSchema>;

/* ── 项目级作用域：项目设置里的资产开关 ── */
export const projectAssetsSchema = z.object({
  projectId: z.string(),
  choices: z.array(
    z.object({
      assetId: z.string(),
      scope: z.enum(['personal', 'project', 'team', 'global']),
      enabled: z.boolean(),
      shadowedBy: z.string().nullable(),
      overridden: z.boolean()
    })
  )
});
export type ProjectAssetsDto = z.infer<typeof projectAssetsSchema>;
export const projectAssetRequest = z.object({ enabled: z.boolean().nullable() });

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

/** 机器凭据的轮换状态（ADR 0030 D3）。 */
export const credentialStatusSchema = z.object({
  workerId: z.string(),
  rotation: z.enum(['none', 'pending', 'failed', 'rotated']),
  rotatedAt: z.number().nullable(),
  pendingUntil: z.number().nullable(),
  rotationFailedAt: z.number().nullable()
});
export type CredentialStatusDto = z.infer<typeof credentialStatusSchema>;

/* ── 派生前预览：这台机器上这个项目实际会带上哪些资产 ── */
export const projectAssetPlanSchema = z.object({
  projectId: z.string(),
  workerId: z.string(),
  assetIds: z.array(z.string()),
  entries: z.array(
    z.object({
      assetId: z.string(),
      kind: assetKindSchema,
      name: z.string(),
      digest: z.string(),
      scope: z.enum(['personal', 'project', 'team', 'global'])
    })
  )
});
export type ProjectAssetPlanDto = z.infer<typeof projectAssetPlanSchema>;

/* ── 资产组合（AssetSet）：把常用资产打包，项目默认引用，派生时显式选择 ── */
export const assetSetItemSchema = z.object({ assetId: z.string().min(1) });
export type AssetSetItemDto = z.infer<typeof assetSetItemSchema>;
export const assetSetSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  items: z.array(assetSetItemSchema),
  assetIds: z.array(z.string()),
  createdBy: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
});
export type AssetSetDto = z.infer<typeof assetSetSchema>;
export const assetSetInput = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(300).nullable().optional(),
  items: z.array(assetSetItemSchema).max(50)
});
export type AssetSetInputDto = z.infer<typeof assetSetInput>;
export const projectAssetSetsRequest = z.object({ assetSetIds: z.array(z.string().min(1)).max(8) });
export type ProjectAssetSetsRequestDto = z.infer<typeof projectAssetSetsRequest>;
