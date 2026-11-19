import { z } from 'zod';

/** 开放 API 令牌（ADR 0015）。明文只在创建响应里出现一次。 */
export const apiScopeSchema = z.enum([
  'projects:read',
  'projects:write',
  'sessions:read',
  'sessions:write',
  'workers:read',
  'assets:submit',
  'assets:read',
  'assets:write',
  'assets:publish',
  'providers:read',
  'providers:use',
  'providers:manage',
  'groups:write',
  'files:read',
  'memory:read',
  'memory:write',
  'tokens:manage'
]);

export const createApiTokenRequest = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['personal', 'service', 'bot']).default('personal'),
  scopes: z.array(apiScopeSchema).min(1),
  /** kind = 'bot' 必填：凭据绑定的项目（bot 只能在这个项目里做事）。 */
  projectId: z.string().trim().min(1).optional(),
  /** kind = 'bot' 可选：bot 的 @id；不给就用令牌名。 */
  botName: z.string().trim().min(1).max(60).optional(),
  /** 毫秒时间戳；不给 = 30 天（bot 凭据不给 = 不过期）；null = 永不过期。 */
  expiresAt: z.number().int().positive().nullable().optional(),
  /** 个人 / 服务账号令牌只给这几个项目；不给 / null = 不限项目。 */
  projectIds: z.array(z.string().trim().min(1)).min(1).max(50).nullable().optional()
});

export const apiTokenInfoSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  kind: z.enum(['personal', 'service', 'bot']),
  userId: z.string(),
  /** 只有 kind === 'bot' 才有：项目归属 + bot 的 @id。 */
  bot: z.object({ projectId: z.string(), name: z.string() }).optional(),
  /** 限定的项目；没有 = 不限。 */
  projectIds: z.array(z.string()).nullable().optional(),
  name: z.string(),
  scopes: z.array(apiScopeSchema),
  prefix: z.string(),
  createdBy: z.string(),
  createdAt: z.number(),
  expiresAt: z.number().nullable(),
  lastUsedAt: z.number().nullable(),
  revokedAt: z.number().nullable(),
  usable: z.boolean()
});

export const createApiTokenResponse = z.object({ token: z.string(), info: apiTokenInfoSchema });
/** 轮换：新令牌明文（只此一次）+ 新旧两条记录。 */
export const rotateApiTokenResponse = z.object({ token: z.string(), info: apiTokenInfoSchema, replaced: apiTokenInfoSchema });

/** 一个令牌的最近活动：创建 / 轮换 / 吊销 / MCP 调用。 */
export const apiTokenActivitySchema = z.array(z.object({ action: z.string(), detail: z.string(), at: z.number() }));

/** 这个令牌接上 MCP 后能看到的工具（按令牌权限和写工具开关算）。 */
export const apiTokenToolsSchema = z.object({
  tools: z.array(z.object({ name: z.string(), readOnly: z.boolean() })),
  writes: z.boolean()
});

/** 外部接入（MCP）的 hub 级设置：写工具开关。null = 没在页面上设过，沿用环境变量 MCP_WRITE。 */
export const mcpAccessSettingsSchema = z.object({
  readOnly: z.boolean(),
  /** 当前值从哪来：页面设置 / 环境变量默认。 */
  source: z.enum(['setting', 'env']),
  canManage: z.boolean()
});
export const mcpAccessPatchRequest = z.object({ readOnly: z.boolean().nullable() });

export type ApiTokenInfo = z.infer<typeof apiTokenInfoSchema>;
export type CreateApiTokenRequest = z.input<typeof createApiTokenRequest>;
export type ApiTokenActivity = z.infer<typeof apiTokenActivitySchema>;
export type ApiTokenTools = z.infer<typeof apiTokenToolsSchema>;
export type McpAccessSettings = z.infer<typeof mcpAccessSettingsSchema>;
