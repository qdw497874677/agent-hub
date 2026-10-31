import { z } from 'zod';

/** 开放 API 令牌（ADR 0015）。明文只在创建响应里出现一次。 */
export const apiScopeSchema = z.enum(['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'workers:read', 'assets:submit']);

export const createApiTokenRequest = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['personal', 'service']).default('personal'),
  scopes: z.array(apiScopeSchema).min(1),
  /** 毫秒时间戳；不给 / null = 永不过期。 */
  expiresAt: z.number().int().positive().nullable().optional()
});

export const apiTokenInfoSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  kind: z.enum(['personal', 'service']),
  userId: z.string(),
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
