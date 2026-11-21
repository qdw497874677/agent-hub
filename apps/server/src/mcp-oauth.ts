import { createHash } from 'node:crypto';
import type { DomainError, McpOAuth, Result } from '@agent-hub/domain';
import { err, ok, unavailable } from '@agent-hub/domain';
import { checkMcpEgressUrl, defaultMcpEgress, mcpEgressPolicyFromEnv, type McpEgress } from './mcp-egress.ts';

/**
 * 远端 MCP 的 OAuth 客户端凭据（client_credentials）：hub 取 token，放进发往上游的
 * `Authorization` 头；到期前 60 秒刷新，401 时由调用方 `force` 刷新一次。
 *
 * token / secret 只在内存里：错误与日志都不带它们。
 */
export interface McpOAuthClient {
  /** 返回可直接放进请求头的 `Bearer <token>`；`force` 跳过缓存。 */
  authorization(oauth: McpOAuth, opts?: { force?: boolean }): Promise<Result<string, DomainError>>;
}

export interface McpOAuthOptions {
  readonly fetch?: typeof fetch;
  /** 出口策略 / 安全 fetch（relay 传入同一实例）；缺省用 hub 共享的安全出口。 */
  readonly egress?: McpEgress;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

const TIMEOUT_MS = 15_000;
/** token 响应没写 expires_in 时按 5 分钟算。 */
const DEFAULT_EXPIRES_IN = 300;
/** 提前 60 秒视为过期，别卡在边界上。 */
const EXPIRY_MARGIN_SECONDS = 60;

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

export function createMcpOAuth(options: McpOAuthOptions = {}): McpOAuthClient {
  const egress = options.egress;
  const policy = egress?.policy ?? mcpEgressPolicyFromEnv();
  const fetchImpl = options.fetch ?? egress?.fetch ?? defaultMcpEgress().fetch;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => undefined);
  const cache = new Map<string, CachedToken>();

  // secret 轮换后必须换 token；键里只放摘要，绝不留明文。
  const secretDigest = (oauth: McpOAuth): string =>
    createHash('sha256').update(oauth.clientSecret ?? '').digest('hex').slice(0, 12);
  const keyOf = (oauth: McpOAuth): string =>
    [oauth.tokenUrl, oauth.clientId, oauth.scope ?? '', oauth.audience ?? '', secretDigest(oauth)].join('|');

  const sanitize = (text: string, oauth: McpOAuth): string => {
    let out = text;
    for (const secret of [oauth.clientSecret ?? '']) {
      if (secret !== '') out = out.replaceAll(secret, '***');
    }
    return out.replace(/Bearer\s+\S+/gi, 'Bearer ***').slice(0, 200);
  };

  async function fetchToken(oauth: McpOAuth): Promise<Result<CachedToken, DomainError>> {
    // OAuth 凭据只走 HTTPS，且先按出口策略校验展开后的 token URL。
    const checked = checkMcpEgressUrl(oauth.tokenUrl, policy, { requireHttps: true });
    if (!checked.ok) {
      const message = `MCP OAuth：token 地址不合法（${checked.error.message}）`;
      log(message);
      return err(unavailable(message));
    }
    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    if (oauth.scope !== undefined && oauth.scope !== '') body.set('scope', oauth.scope);
    if (oauth.audience !== undefined && oauth.audience !== '') body.set('audience', oauth.audience);
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    };
    if (oauth.authStyle === 'basic') {
      // client_secret_basic：凭据在头里，body 不再重复。
      const pair = `${oauth.clientId}:${oauth.clientSecret ?? ''}`;
      headers['authorization'] = `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
    } else {
      body.set('client_id', oauth.clientId);
      if (oauth.clientSecret !== undefined) body.set('client_secret', oauth.clientSecret);
    }

    let response: Response;
    try {
      response = await fetchImpl(checked.value.href, {
        method: 'POST',
        headers,
        body: body.toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (error) {
      const reason = sanitize(error instanceof Error ? error.message : String(error), oauth);
      const message = `MCP OAuth：取 token 失败（${reason || '网络错误'}）`;
      log(message);
      return err(unavailable(message));
    }

    if (!response.ok) {
      const message = `MCP OAuth：取 token 失败（状态 ${response.status}）`;
      log(message);
      return err(unavailable(message));
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      const message = 'MCP OAuth：token 响应不是合法 JSON';
      log(message);
      return err(unavailable(message));
    }
    if (typeof payload !== 'object' || payload === null) {
      const message = 'MCP OAuth：token 响应不合法';
      log(message);
      return err(unavailable(message));
    }
    const token = (payload as Record<string, unknown>)['access_token'];
    if (typeof token !== 'string' || token === '') {
      const message = 'MCP OAuth：token 响应里没有 access_token';
      log(message);
      return err(unavailable(message));
    }
    const rawExpires = (payload as Record<string, unknown>)['expires_in'];
    const expiresIn =
      typeof rawExpires === 'number' && Number.isFinite(rawExpires) && rawExpires > 0
        ? rawExpires
        : typeof rawExpires === 'string' && Number(rawExpires) > 0
          ? Number(rawExpires)
          : DEFAULT_EXPIRES_IN;
    return ok({ token, expiresAt: now() + Math.max(0, expiresIn - EXPIRY_MARGIN_SECONDS) * 1000 });
  }

  return {
    async authorization(oauth, opts = {}) {
      const key = keyOf(oauth);
      if (!opts.force) {
        const cached = cache.get(key);
        if (cached && now() < cached.expiresAt) return ok(`Bearer ${cached.token}`);
      }
      const fetched = await fetchToken(oauth);
      if (!fetched.ok) return fetched;
      cache.set(key, fetched.value);
      return ok(`Bearer ${fetched.value.token}`);
    }
  };
}
