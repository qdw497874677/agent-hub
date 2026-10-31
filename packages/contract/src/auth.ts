import { z } from 'zod';

/** 账号接口（/api/auth/*）的请求与响应形状。长度上限防止拿超长输入耗 scrypt。 */
/** 内置四个角色 + 团队自定义角色（custom:<id>，ADR 0017）。 */
export const roleSchema = z.union([
  z.enum(['owner', 'admin', 'member', 'viewer']),
  z.custom<`custom:${string}`>((v) => typeof v === 'string' && /^custom:[A-Za-z0-9_-]{1,64}$/.test(v), '角色不对')
]);

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
  role: roleSchema,
  /** 没验证邮箱的人只能看到「去验证邮箱」（设计 §6.2）。 */
  emailVerified: z.boolean(),
  /** ADR 0011：hub 管理员（bootstrap 用户），只有他能进运营后台。老 hub 不返回。 */
  clusterAdmin: z.boolean().optional()
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

/** 个人设置（ADR 0011）。 */
export const changePasswordRequest = z.object({ oldPassword: z.string().max(256), newPassword: z.string().max(256) });
export const profileRequest = z.object({ displayName: z.string().max(60) });

/** 团队与邀请（ADR 0011）。 */

export const inviteRequest = z.object({ email: z.string().max(254), role: roleSchema, allowOverLimit: z.boolean().optional() });
export const memberRoleRequest = z.object({ role: roleSchema });
export const acceptInviteRequest = z.object({ token: z.string().max(512), password: z.string().max(256), displayName: z.string().max(60).optional() });

export const teamMemberSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: roleSchema,
  teamOwner: z.boolean(),
  disabled: z.boolean(),
  emailVerified: z.boolean(),
  lastSeenAt: z.number().nullable()
});
export type TeamMemberDto = z.infer<typeof teamMemberSchema>;
export const inviteSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: roleSchema,
  createdAt: z.number(),
  expiresAt: z.number(),
  allowOverLimit: z.boolean()
});
export type InviteDto = z.infer<typeof inviteSchema>;
export const teamSchema = z.object({
  id: z.string(),
  name: z.string(),
  members: z.array(teamMemberSchema),
  invites: z.array(inviteSchema),
  seatsLeft: z.number().nullable(),
  canManage: z.boolean(),
  /** 当前这个人是不是团队 owner（只有他能「超出名额也邀请」）。 */
  isTeamOwner: z.boolean()
});
export type TeamDto = z.infer<typeof teamSchema>;
export const invitePreviewSchema = z.object({ email: z.string(), teamName: z.string(), inviterName: z.string(), role: roleSchema });
export type InvitePreviewDto = z.infer<typeof invitePreviewSchema>;
