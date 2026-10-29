import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import { randomBytes } from 'node:crypto';
import {
  forgotPasswordRequest,
  loginRequest,
  registerRequest,
  resetPasswordRequest,
  tokenLoginRequest,
  tokenRequest
} from '@agent-hub/contract';
import type { AccountDto, AuthState, LoginDeviceDto } from '@agent-hub/contract';
import type { AccountDeps, DomainError, IssuedLogin, Principal, Result, User } from '@agent-hub/domain';
import {
  asLoginId,
  authenticate,
  isEmailVerified,
  listMyLogins,
  loginAsFirstOwner,
  loginWithPassword,
  logout,
  normalizeEmail,
  registerUser,
  registrationFull,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  revokeMyLogin,
  revokeMyOtherLogins,
  verifyEmail
} from '@agent-hub/domain';
import { sameSecret } from './request-guard.ts';
import { createRateLimiter } from './rate-limit.ts';

/**
 * 账号的 HTTP 外壳（docs/design/accounts.md §8–§10）：
 * - 登录态放 httpOnly cookie；https 下才加 Secure 并用 `__Host-` 前缀，http 测试照样能用。
 * - CSRF 用双提交：非 httpOnly 的 hub_csrf cookie + X-Hub-CSRF 请求头，cookie 认证的写请求必须带。
 * - 旧 HUB_TOKEN 过渡 30 天：期内 Bearer 照常放行（给脚本），也能换一个 Owner 登录。
 */
export interface AuthOptions {
  readonly accounts: AccountDeps;
  /** 旧共享令牌；null = 没配或过渡期已过。 */
  readonly hubToken: { readonly value: string; readonly until: number } | null;
  /** 登录限流：15 分钟内每个来源最多几次，默认 10；e2e 用 HUB_LOGIN_RATE_MAX 放宽。 */
  readonly loginRateMax?: number;
  /** 发信类接口（忘记密码、重发验证）每小时每 IP / 每邮箱最多几次，默认 5（设计 §9）。 */
  readonly mailRateMax?: number;
  /** 真能发信（不是只记日志）。 */
  readonly mailDelivery?: boolean;
}

export const CSRF_HEADER = 'x-hub-csrf';
/** 唯一允许 `?token=` 的路由（EventSource 设不了 Authorization）。 */
export const SSE_PATH = '/api/stream';
const LOGIN = 'hub_login';
const CSRF = 'hub_csrf';
// 不走登录态的入口。新机器兑换接入码不在 HTTP 上：走 /worker 长连接的 enroll 握手。
const OPEN = ['/api/health', '/api/auth/'];


function isHttps(c: Context): boolean {
  return new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';
}
const loginCookieName = (secure: boolean) => (secure ? `__Host-${LOGIN}` : LOGIN);

function readLoginCookie(c: Context): string {
  return getCookie(c, loginCookieName(true)) ?? getCookie(c, LOGIN) ?? '';
}

function clientKey(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown'; // 单测里直接打 app.request，没有 socket
  }
}

const toDto = (user: User): AccountDto => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  role: user.role,
  emailVerified: isEmailVerified(user)
});

function unauthorized(c: Context, message = '请先登录'): Response {
  return c.json({ error: { code: 'unauthorized', message } }, 401);
}

/** 守门中间件认出的身份；Bearer 旧令牌放行的请求没有身份（null）。 */
export type PrincipalOf = (c: Context) => Principal | null;

export function installAuth(app: Hono, options: AuthOptions): PrincipalOf {
  const { accounts } = options;
  // 守门中间件认出的身份，路由里直接取，不再查一遍库。
  const principals = new WeakMap<Request, Principal | null>();
  const limiter = createRateLimiter({ max: options.loginRateMax ?? 10, windowMs: 15 * 60 * 1000, now: accounts.now });
  const mailLimiter = createRateLimiter({ max: options.mailRateMax ?? 5, windowMs: 60 * 60 * 1000, now: accounts.now });
  const client = (c: Context) => ({ userAgent: c.req.header('user-agent') ?? null, ip: clientKey(c) === 'unknown' ? null : clientKey(c) });

  const tokenValid = (offered: string): boolean => {
    const hub = options.hubToken;
    return hub !== null && accounts.now() < hub.until && offered !== '' && sameSecret(offered, hub.value);
  };

  const issueCookies = (c: Context, issued: IssuedLogin) => {
    const secure = isHttps(c);
    const maxAge = Math.max(0, Math.floor((issued.expiresAt - accounts.now()) / 1000));
    setCookie(c, loginCookieName(secure), issued.token, { httpOnly: true, sameSite: 'Lax', secure, path: '/', maxAge });
    setCookie(c, CSRF, randomBytes(18).toString('base64url'), { httpOnly: false, sameSite: 'Lax', secure, path: '/', maxAge });
  };

  const clearCookies = (c: Context) => {
    deleteCookie(c, loginCookieName(true), { path: '/', secure: true });
    deleteCookie(c, LOGIN, { path: '/' });
    deleteCookie(c, CSRF, { path: '/' });
  };

  const respond = (c: Context, result: Result<IssuedLogin, DomainError>): Response => {
    if (!result.ok) {
      const status = result.error.code === 'conflict' ? 409 : 400;
      return c.json({ error: { code: result.error.code, message: result.error.message } }, status);
    }
    issueCookies(c, result.value);
    return c.json({ user: toDto(result.value.user) });
  };

  const throttled = (c: Context, key: string): Response | null =>
    limiter.hit(key) ? null : c.json({ error: { code: 'rate_limited', message: '尝试太频繁了，过一会儿再试' } }, 429);
  /** 每个 key 都记一次（不短路），任何一个超了就 429。 */
  const mailThrottled = (c: Context, keys: string[]): Response | null => {
    const results = keys.map((key) => mailLimiter.hit(key));
    return results.every(Boolean) ? null : c.json({ error: { code: 'rate_limited', message: '发得太频繁了，过一会儿再试' } }, 429);
  };

  const csrfOk = (c: Context): boolean => {
    const cookie = getCookie(c, CSRF) ?? '';
    return cookie !== '' && sameSecret(c.req.header(CSRF_HEADER) ?? '', cookie);
  };
  const csrfFailed = (c: Context) => c.json({ error: { code: 'forbidden', message: 'CSRF 校验失败，刷新页面再试' } }, 403);
  /** /api/auth/* 是开放前缀，要身份的那几个路由自己查身份和 CSRF。 */
  const signedIn = (c: Context): Principal | Response => {
    const principal = principals.get(c.req.raw) ?? null;
    if (!principal) return unauthorized(c);
    if (c.req.method !== 'GET' && !csrfOk(c)) return csrfFailed(c);
    return principal;
  };
  const deviceDto = (row: Awaited<ReturnType<typeof listMyLogins>>[number]): LoginDeviceDto => ({
    id: row.login.id,
    method: row.login.method,
    userAgent: row.login.userAgent,
    ip: row.login.ip,
    createdAt: row.login.createdAt,
    lastSeenAt: row.login.lastSeenAt,
    current: row.current
  });

  // 守门：除了健康检查和账号接口本身，/api/* 都要有身份。
  app.use('/api/*', async (c, next) => {
    const path = c.req.path;
    const principal = await authenticate(accounts, readLoginCookie(c));
    principals.set(c.req.raw, principal);
    if (OPEN.some((open) => (open.endsWith('/') ? path.startsWith(open) : path === open))) return next();

    if (principal) {
      const method = c.req.method;
      if (method !== 'GET' && method !== 'HEAD' && !csrfOk(c)) return csrfFailed(c);
      // 没验证邮箱：能登录，但除了账号接口什么都不给（设计 §6.2）。
      if (!isEmailVerified(principal.user)) {
        return c.json({ error: { code: 'email_unverified', message: '先去邮箱点验证链接' } }, 403);
      }
      return next();
    }
    // 过渡期：脚本仍可用 Bearer（或 SSE 用 ?token=）带旧 HUB_TOKEN。
    const bearer = (c.req.header('authorization') ?? '').replace(/^Bearer /, '');
    // 查询串里的令牌会进访问日志、浏览器历史和 Referer，只给设不了请求头的 SSE 用。
    if (tokenValid(bearer) || (path === SSE_PATH && tokenValid(c.req.query('token') ?? ''))) return next();
    return unauthorized(c);
  });

  app.get('/api/auth/state', async (c) => {
    const principal = principals.get(c.req.raw) ?? null;
    const state: AuthState = {
      user: principal ? toDto(principal.user) : null,
      tokenLogin: options.hubToken !== null && accounts.now() < options.hubToken.until,
      // 还没有主人时总能注册（认领第一个账号），否则看开关。
      registration:
        (await accounts.users.firstWithRole('owner')) === null ||
        ((await accounts.settings.get()).openRegistration && !(await registrationFull(accounts))),
      mailDelivery: options.mailDelivery ?? false
    };
    return c.json(state);
  });

  app.post('/api/auth/register', async (c) => {
    const limited = throttled(c, `register:${clientKey(c)}`);
    if (limited) return limited;
    const parsed = registerRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'invalid', message: '请求体不合法' } }, 400);
    return respond(c, await registerUser(accounts, { ...parsed.data, ...client(c) }));
  });

  app.post('/api/auth/login', async (c) => {
    const parsed = loginRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'invalid', message: '请求体不合法' } }, 400);
    const limited = throttled(c, `login:${clientKey(c)}:${parsed.data.email.trim().toLowerCase()}`);
    if (limited) return limited;
    return respond(c, await loginWithPassword(accounts, { ...parsed.data, ...client(c) }));
  });

  app.post('/api/auth/token-login', async (c) => {
    const limited = throttled(c, `token:${clientKey(c)}`);
    if (limited) return limited;
    const parsed = tokenLoginRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || !tokenValid(parsed.data.token)) return unauthorized(c, 'token 不对，或者已经过了 30 天过渡期');
    return respond(c, await loginAsFirstOwner(accounts, client(c)));
  });

  app.post('/api/auth/logout', async (c) => {
    const principal = principals.get(c.req.raw) ?? null;
    if (principal) await logout(accounts, principal);
    clearCookies(c);
    return c.json({ ok: true });
  });

  // —— 验证邮箱 ——
  app.post('/api/auth/verify-email', async (c) => {
    const limited = throttled(c, `verify:${clientKey(c)}`);
    if (limited) return limited;
    const parsed = tokenRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'invalid', message: '请求体不合法' } }, 400);
    const result = await verifyEmail(accounts, parsed.data.token);
    if (!result.ok) return c.json({ error: { code: result.error.code, message: result.error.message } }, 400);
    return c.json({ user: toDto(result.value) });
  });

  app.post('/api/auth/resend-verification', async (c) => {
    const who = signedIn(c);
    if (who instanceof Response) return who;
    const limited = mailThrottled(c, [`resend-ip:${clientKey(c)}`, `resend-user:${who.user.id}`]);
    if (limited) return limited;
    const result = await resendVerification(accounts, who);
    if (!result.ok) return c.json({ error: { code: result.error.code, message: result.error.message } }, 404);
    return c.json(result.value);
  });

  // —— 找回密码 ——
  // 不管邮箱存不存在都回 204（防枚举）；限流按 IP 和邮箱各算，跟邮箱存不存在无关。
  app.post('/api/auth/password/forgot', async (c) => {
    const parsed = forgotPasswordRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'invalid', message: '请求体不合法' } }, 400);
    const limited = mailThrottled(c, [`forgot-ip:${clientKey(c)}`, `forgot-email:${normalizeEmail(parsed.data.email)}`]);
    if (limited) return limited;
    await requestPasswordReset(accounts, parsed.data.email);
    return c.body(null, 204);
  });

  app.post('/api/auth/password/reset', async (c) => {
    const limited = throttled(c, `reset:${clientKey(c)}`);
    if (limited) return limited;
    const parsed = resetPasswordRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'invalid', message: '请求体不合法' } }, 400);
    return respond(c, await resetPassword(accounts, { ...parsed.data, ...client(c) }));
  });

  // —— 我的登录设备 ——
  app.get('/api/auth/logins', async (c) => {
    const who = signedIn(c);
    if (who instanceof Response) return who;
    return c.json((await listMyLogins(accounts, who)).map(deviceDto));
  });

  app.delete('/api/auth/logins/:id', async (c) => {
    const who = signedIn(c);
    if (who instanceof Response) return who;
    const result = await revokeMyLogin(accounts, who, asLoginId(c.req.param('id')));
    if (!result.ok) return c.json({ error: { code: result.error.code, message: result.error.message } }, 404);
    if (result.value.current) clearCookies(c);
    return c.json(result.value);
  });

  app.post('/api/auth/logins/revoke-others', async (c) => {
    const who = signedIn(c);
    if (who instanceof Response) return who;
    await revokeMyOtherLogins(accounts, who);
    return c.json({ ok: true });
  });

  return (c) => principals.get(c.req.raw) ?? null;
}
