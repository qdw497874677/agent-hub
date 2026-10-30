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
  role: z.enum(['owner', 'member']),
  /** 没验证邮箱的人只能看到「去验证邮箱」（设计 §6.2）。 */
  emailVerified: z.boolean(),
  /** ADR 0011：hub 管理员（bootstrap 用户），只有他能进运营后台。老 hub 不返回。 */
  hubAdmin: z.boolean().optional()
});
export type AccountDto = z.infer<typeof accountSchema>;

export const authStateSchema = z.object({
  user: accountSchema.nullable(),
  /** 旧 HUB_TOKEN 还能不能换登录（30 天过渡期内且配了才是 true）。 */
  tokenLogin: z.boolean(),
  registration: z.boolean(),
  /** 这台 hub 真能发信吗（false = 只记日志）：验证页据此提示「找主人手动标记」。 */
  mailDelivery: z.boolean()
});
export type AuthState = z.infer<typeof authStateSchema>;

export const tokenRequest = z.object({ token: z.string().max(512) });
export const forgotPasswordRequest = z.object({ email: z.string().max(254) });
export const resetPasswordRequest = z.object({ token: z.string().max(512), password: z.string().max(256) });

/** 「我的登录设备」一行。 */
export const loginDeviceSchema = z.object({
  id: z.string(),
  method: z.enum(['password', 'hub-token']),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: z.number(),
  lastSeenAt: z.number(),
  current: z.boolean()
});
export type LoginDeviceDto = z.infer<typeof loginDeviceSchema>;
