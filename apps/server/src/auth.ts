import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import { randomBytes } from 'node:crypto';
import { loginRequest, registerRequest, tokenLoginRequest } from '@agent-hub/contract';
import type { AccountDto, AuthState } from '@agent-hub/contract';
import type { AccountDeps, DomainError, IssuedLogin, Principal, Result, User } from '@agent-hub/domain';
import { authenticate, loginAsFirstOwner, loginWithPassword, logout, registerUser } from '@agent-hub/domain';
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
}

export const CSRF_HEADER = 'x-hub-csrf';
const LOGIN = 'hub_login';
const CSRF = 'hub_csrf';
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
  role: user.role
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

  // 守门：除了健康检查和账号接口本身，/api/* 都要有身份。
  app.use('/api/*', async (c, next) => {
    const path = c.req.path;
    const principal = await authenticate(accounts, readLoginCookie(c));
    principals.set(c.req.raw, principal);
    if (OPEN.some((open) => (open.endsWith('/') ? path.startsWith(open) : path === open))) return next();

    if (principal) {
      const method = c.req.method;
      if (method !== 'GET' && method !== 'HEAD') {
        const cookie = getCookie(c, CSRF) ?? '';
        if (cookie === '' || !sameSecret(c.req.header(CSRF_HEADER) ?? '', cookie)) {
          return c.json({ error: { code: 'forbidden', message: 'CSRF 校验失败，刷新页面再试' } }, 403);
        }
      }
      return next();
    }
    // 过渡期：脚本仍可用 Bearer（或 SSE 用 ?token=）带旧 HUB_TOKEN。
    const bearer = (c.req.header('authorization') ?? '').replace(/^Bearer /, '');
    if (tokenValid(bearer) || tokenValid(c.req.query('token') ?? '')) return next();
    return unauthorized(c);
  });

  app.get('/api/auth/state', async (c) => {
    const principal = principals.get(c.req.raw) ?? null;
    const state: AuthState = {
      user: principal ? toDto(principal.user) : null,
      tokenLogin: options.hubToken !== null && accounts.now() < options.hubToken.until,
      // 还没有主人时总能注册（认领第一个账号），否则看开关。
      registration:
        (await accounts.settings.get()).openRegistration || (await accounts.users.firstWithRole('owner')) === null
    };
    return c.json(state);
  });

  app.post('/api/auth/register', async (c) => {
    const limited = throttled(c, `register:${clientKey(c)}`);
    if (limited) return limited;
    const parsed = registerRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'invalid', message: '请求体不合法' } }, 400);
    return respond(c, await registerUser(accounts, { ...parsed.data, userAgent: c.req.header('user-agent') ?? null }));
  });

  app.post('/api/auth/login', async (c) => {
    const parsed = loginRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'invalid', message: '请求体不合法' } }, 400);
    const limited = throttled(c, `login:${clientKey(c)}:${parsed.data.email.trim().toLowerCase()}`);
    if (limited) return limited;
    return respond(c, await loginWithPassword(accounts, { ...parsed.data, userAgent: c.req.header('user-agent') ?? null }));
  });

  app.post('/api/auth/token-login', async (c) => {
    const limited = throttled(c, `token:${clientKey(c)}`);
    if (limited) return limited;
    const parsed = tokenLoginRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || !tokenValid(parsed.data.token)) return unauthorized(c, 'token 不对，或者已经过了 30 天过渡期');
    return respond(c, await loginAsFirstOwner(accounts, c.req.header('user-agent') ?? null));
  });

  app.post('/api/auth/logout', async (c) => {
    const principal = principals.get(c.req.raw) ?? null;
    if (principal) await logout(accounts, principal);
    clearCookies(c);
    return c.json({ ok: true });
  });

  return (c) => principals.get(c.req.raw) ?? null;
}
