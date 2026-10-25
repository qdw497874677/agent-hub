import { z } from 'zod';

/** 账号接口（/api/auth/*）的请求与响应形状。长度上限防止拿超长输入耗 scrypt。 */
export const registerRequest = z.object({
  email: z.string().max(254),
  password: z.string().max(256),
  displayName: z.string().max(60).optional()
});
export const loginRequest = z.object({ email: z.string().max(254), password: z.string().max(256) });
export const tokenLoginRequest = z.object({ token: z.string().max(512) });

export const accountSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: z.enum(['owner', 'member'])
});
export type AccountDto = z.infer<typeof accountSchema>;

export const authStateSchema = z.object({
  user: accountSchema.nullable(),
  /** 旧 HUB_TOKEN 还能不能换登录（30 天过渡期内且配了才是 true）。 */
  tokenLogin: z.boolean(),
  registration: z.boolean()
});
export type AuthState = z.infer<typeof authStateSchema>;
