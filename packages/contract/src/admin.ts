import { z } from 'zod';
import { accountSchema } from './auth.ts';

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
  /** 谁加的这台机器。目前只区分本机与凭 HUB_TOKEN 接入的远程机器（按人登记在下一期）。 */
  enrolledBy: z.string(),
  build: z.object({ version: z.string(), commit: z.string().nullable(), protocol: z.number() }).nullable(),
  /** 和 hub 的版本不一致（或没报版本）。 */
  outdated: z.boolean(),
  update: z
    .object({ state: z.string(), message: z.string(), logTail: z.string(), at: z.number() })
    .nullable()
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
