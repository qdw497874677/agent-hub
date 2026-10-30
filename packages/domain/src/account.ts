import { newId } from './ids.ts';

/**
 * 账号（docs/design/accounts.md）。一个 hub 是一个隐式 Workspace：
 * 账号只回答「你是谁」和「Owner 还是成员」，不做资源隔离（ADR 0008）。
 */
export type UserId = string & { readonly __brand: 'UserId' };
export type TeamId = string & { readonly __brand: 'TeamId' };
export const newTeamId = (): TeamId => newId() as TeamId;
export const asTeamId = (value: string): TeamId => value as TeamId;
export type LoginId = string & { readonly __brand: 'LoginId' };

export const newUserId = (): UserId => newId() as UserId;
export const newLoginId = (): LoginId => newId() as LoginId;
export const asUserId = (value: string): UserId => value as UserId;
export const asLoginId = (value: string): LoginId => value as LoginId;

export type Role = 'owner' | 'member';

export interface User {
  readonly id: UserId;
  /** 规范化后的邮箱（去空白、小写），唯一。 */
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  /** 自带参数的密码哈希串；只有 PasswordHasher 认识它的格式。 */
  readonly passwordHash: string | null;
  readonly emailVerifiedAt: number | null;
  readonly disabledAt: number | null;
  readonly createdAt: number;
  /** 所属团队（ADR 0011）：一人一个团队。老库迁移前可能是 null。 */
  readonly teamId: TeamId | null;
  /** hub 级超级管理员（第一位主人）：管 hub 设置、本机 Worker、全站用户。 */
  readonly hubAdmin: boolean;
  /** 软删除（匿名化）的时间；删了的人不能登录，也不出现在列表里。 */
  readonly deletedAt: number | null;
}

/** 团队 = 租户。自助注册的人建一个自己的团队并成为它的 owner（ADR 0011）。 */
export interface Team {
  readonly id: TeamId;
  readonly name: string;
  readonly ownerId: UserId;
  readonly createdAt: number;
}

/**
 * 一次已认证的登录（登录态）。GLOSSARY 里 Session 是对话，所以这里不叫 Session。
 * 只存令牌的哈希：库泄露了也拿不到能用的令牌。
 */
export interface Login {
  readonly id: LoginId;
  readonly userId: UserId;
  readonly tokenHash: string;
  /** 怎么登进来的：密码，还是过渡期内用旧 HUB_TOKEN 换的。 */
  readonly method: 'password' | 'hub-token';
  readonly userAgent: string | null;
  /** 登录时的来源 IP（设备列表里给人认自己的设备用）；老数据没有。 */
  readonly ip: string | null;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
}

/** 邮箱是否已验证。没验证的人能登录，但只能看到「去验证邮箱」（设计 §6.2）。 */
export const isEmailVerified = (user: User): boolean => user.emailVerifiedAt !== null;

/**
 * 一次性令牌（验证邮箱、重置密码）。库里只存哈希；30 分钟内有效，用一次就作废。
 * 设计 §13 的 one_time_tokens 表。
 */
export type OneTimePurpose = 'verify-email' | 'reset-password';
export interface OneTimeToken {
  readonly tokenHash: string;
  readonly purpose: OneTimePurpose;
  readonly userId: UserId;
  readonly email: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly usedAt: number | null;
}
export const ONE_TIME_TOKEN_TTL_MS = 30 * 60 * 1000;

/** 已认证的调用者。HTTP 层拿它去调用例，不再看 cookie / header。 */
export interface Principal {
  readonly user: User;
  readonly loginId: LoginId;
}

/** 登录态时效：30 天，用着就续（每次续到「最后一次使用 + 30 天」）。 */
export const LOGIN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 续期写库的最小间隔：每个请求都写一次库不值当。 */
export const LOGIN_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function emailProblem(email: string): string | null {
  if (email.length > 254 || !EMAIL.test(email)) return '邮箱格式不对';
  return null;
}

/** 按 NIST 800-63B：只看长度和最常见的弱口令，不强制字符类别。 */
const COMMON = new Set(['password', 'password1', '1234567890', '12345678', 'qwertyuiop', '1111111111', 'iloveyou12']);
export const MIN_PASSWORD = 10;

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD) return `密码至少 ${MIN_PASSWORD} 位`;
  if (password.length > 256) return '密码太长了';
  if (COMMON.has(password.toLowerCase())) return '这个密码太常见了，换一个';
  return null;
}

export function defaultDisplayName(email: string): string {
  return email.slice(0, email.indexOf('@')) || email;
}

/** 登录态是否还有效：没过期、人没被停用。 */
export function loginUsable(login: Login, user: User | null, now: number): user is User {
  return user !== null && user.disabledAt === null && user.deletedAt === null && login.expiresAt > now;
}

/** hub 级开关，运营后台里改（docs/design/accounts.md §16 P2）。 */
export interface HubSettings {
  /** 开放自助注册（默认关；主要靠团队邀请加人）。开着时自助注册的人得到一个自己的空团队。关掉后只有「还没有 hub 管理员」时的首个注册能成功。 */
  readonly openRegistration: boolean;
  /** 成员能否给 hub 加机器；Owner 总是能。 */
  readonly membersCanAddMachines: boolean;
  /** 本机 Worker（hub 所在的机器）的单独授权：hub 管理员团队里的这些人能用。hub 管理员总能用，别的团队永远不能。 */
  readonly localWorkerGrants: readonly string[];
}
export const DEFAULT_SETTINGS: HubSettings = { openRegistration: false, membersCanAddMachines: true, localWorkerGrants: [] };

export const canAddMachines = (user: User, settings: HubSettings): boolean =>
  user.role === 'owner' || settings.membersCanAddMachines;

/** 每个人最近的登录活动，运营后台的用户列表用。 */
export interface LoginActivity {
  readonly userId: UserId;
  readonly lastSeenAt: number;
  /** 未过期的登录态个数（≈ 登着的设备数）。 */
  readonly active: number;
}

export type AuditAction =
  | 'user.disable'
  | 'user.enable'
  | 'user.role'
  | 'user.revoke_logins'
  | 'user.verify'
  | 'settings.update'
  | 'worker.disconnect'
  | 'worker.update'
  | 'worker.pair'
  | 'worker.enroll'
  | 'worker.revoke'
  | 'runtime.install'
  | 'runtime.uninstall'
  | 'project.delete'
  | 'asset.create'
  | 'asset.revision'
  | 'asset.pin'
  | 'asset.delete'
  | 'asset.install'
  | 'asset.uninstall'
  | 'asset.secret.set'
  | 'asset.secret.delete'
  | 'asset.project'
  | 'project.create'
  | 'project.restore'
  | 'project.purge'
  | 'project.share'
  | 'user.delete'
  | 'invite.create'
  | 'invite.revoke'
  | 'auth.register'
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.password_reset'
  | 'auth.password_change'
  | 'auth.profile';

/** 运营后台的每个写操作留一条；只增不改。 */
export interface AuditEntry {
  readonly id: string;
  readonly actorId: UserId;
  readonly actorEmail: string;
  readonly action: AuditAction;
  /** 被操作的对象：用户邮箱、workerId，或 'settings'。 */
  readonly target: string;
  readonly detail: string;
  readonly at: number;
  /** 来源 IP（安全事件才有；老数据没有）。 */
  readonly ip?: string | null;
  /** 发生在哪个团队（团队 owner 只看得到自己团队的）；hub 级事件是 null。 */
  readonly teamId?: string | null;
}
