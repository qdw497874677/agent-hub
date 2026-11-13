import { z } from 'zod';

/** 开放 API 令牌（ADR 0015）。明文只在创建响应里出现一次。 */
export const apiScopeSchema = z.enum([
  'projects:read',
  'projects:write',
  'sessions:read',
  'sessions:write',
  'workers:read',
  'assets:submit',
  'providers:use',
  'groups:write',
  'files:read',
  'memory:read',
  'memory:write'
]);

export const createApiTokenRequest = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['personal', 'service', 'bot']).default('personal'),
  scopes: z.array(apiScopeSchema).min(1),
  /** kind = 'bot' 必填：凭据绑定的项目（bot 只能在这个项目里做事）。 */
  projectId: z.string().trim().min(1).optional(),
  /** kind = 'bot' 可选：bot 的 @id；不给就用令牌名。 */
  botName: z.string().trim().min(1).max(60).optional(),
  /** 毫秒时间戳；不给 / null = 永不过期。 */
  expiresAt: z.number().int().positive().nullable().optional()
});

export const apiTokenInfoSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  kind: z.enum(['personal', 'service', 'bot']),
  userId: z.string(),
  /** 只有 kind === 'bot' 才有：项目归属 + bot 的 @id。 */
  bot: z.object({ projectId: z.string(), name: z.string() }).optional(),
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

export type ApiTokenInfo = z.infer<typeof apiTokenInfoSchema>;
export type CreateApiTokenRequest = z.input<typeof createApiTokenRequest>;
