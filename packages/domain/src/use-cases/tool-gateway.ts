import { randomUUID } from 'node:crypto';
import type { Session } from '../session.ts';
import { forbidden, invalid, notFound, type DomainError } from '../errors.ts';
import { err, type Result } from '../result.ts';
import { DEFAULT_TOOL_SCOPES, TOOL_GRANT_TTL_MS, grantActive, type ToolGrant, type ToolScope } from '../tool.ts';
import type { ToolDescriptor, ToolProvider } from '../ports/tool-provider.ts';
import type { ToolGrantRepository } from '../ports/tool-grant-repository.ts';
import type { TokenIssuer } from '../ports/token-issuer.ts';
import type { Deps } from './deps.ts';
import type { WorkerCommand } from '../ports/node-gateway.ts';
import { asTaskId } from '../ids.ts';

export interface ToolGatewayDeps extends Pick<Deps, 'now'> {
  readonly toolGrants: ToolGrantRepository;
  readonly tokens: TokenIssuer;
  readonly providers: readonly ToolProvider[];
  /** 每个授权每分钟默认上限。 */
  readonly perMinute?: number;
}

export interface IssuedGrant {
  readonly grant: ToolGrant;
  /** 明文令牌：只在这里出现一次，交给 worker 后不再保存。 */
  readonly token: string;
}

export interface ToolGateway {
  /** 给一条会话签新授权，同时作废它旧的授权（每次重新托管换一把）。 */
  issue(session: Pick<Session, 'id' | 'taskId' | 'workerId'>, scopes?: readonly ToolScope[]): Promise<IssuedGrant>;
  revoke(session: Pick<Session, 'id'>): Promise<void>;
  /** 令牌 → 有效授权；过期、作废、不认识都是 null。 */
  authenticate(token: string): Promise<ToolGrant | null>;
  /** 这个授权能看到的工具（按 scope 过滤）。 */
  list(grant: ToolGrant): readonly ToolDescriptor[];
  call(grant: ToolGrant, name: string, input: unknown): Promise<Result<unknown, DomainError>>;
}

const summarize = (input: unknown): string => {
  if (input === null || typeof input !== 'object') return '';
  // 只记键和短值：body 这类正文只记长度
  const parts = Object.entries(input as Record<string, unknown>).map(([key, value]) =>
    typeof value === 'string' ? (key === 'body' || value.length > 40 ? `${key}=<${value.length} 字>` : `${key}=${value}`) : `${key}=${JSON.stringify(value)}`
  );
  return parts.join(' ').slice(0, 200);
};

/**
 * ToolGateway（§4.1）：鉴权 → 授权(scope) → 限流 → 调用 → 审计。
 * 传输无关：MCP、stdio shim、REST 都调它。
 */
export function createToolGateway(deps: ToolGatewayDeps): ToolGateway {
  const defaultPerMinute = deps.perMinute ?? 60;
  const windows = new Map<string, number[]>();
  const byName = new Map<string, { provider: ToolProvider; tool: ToolDescriptor }>();
  for (const provider of deps.providers) {
    for (const tool of provider.tools()) byName.set(tool.name, { provider, tool });
  }

  /** 滑动窗口：总量一个桶、单个工具一个桶。 */
  const allow = (key: string, limit: number, now: number): boolean => {
    const hits = (windows.get(key) ?? []).filter((at) => now - at < 60_000);
    if (hits.length >= limit) {
      windows.set(key, hits);
      return false;
    }
    hits.push(now);
    windows.set(key, hits);
    return true;
  };

  return {
    async issue(session, scopes = DEFAULT_TOOL_SCOPES) {
      const now = deps.now();
      await deps.toolGrants.revokeSession(session.id, now);
      const { token, hash } = deps.tokens.issue();
      const grant: ToolGrant = {
        id: randomUUID(),
        tokenHash: hash,
        taskId: session.taskId,
        sessionId: session.id,
        workerId: session.workerId,
        scopes: [...scopes],
        createdAt: now,
        expiresAt: now + TOOL_GRANT_TTL_MS,
        revokedAt: null
      };
      await deps.toolGrants.save(grant);
      return { grant, token };
    },

    async revoke(session) {
      await deps.toolGrants.revokeSession(session.id, deps.now());
    },

    async authenticate(token) {
      if (token === '') return null;
      const grant = await deps.toolGrants.byTokenHash(deps.tokens.hashOf(token));
      return grant && grantActive(grant, deps.now()) ? grant : null;
    },

    list(grant) {
      return [...byName.values()].map((entry) => entry.tool).filter((tool) => grant.scopes.includes(tool.scope));
    },

    async call(grant, name, input) {
      const started = deps.now();
      const entry = byName.get(name);
      let result: Result<unknown, DomainError>;
      if (!entry) result = err(notFound(`没有这个工具：${name}`));
      else if (!grantActive(grant, started)) result = err(forbidden('授权已过期或已作废'));
      else if (!grant.scopes.includes(entry.tool.scope)) result = err(forbidden(`这个会话没有 ${entry.tool.scope} 权限`));
      else if (!allow(grant.id, defaultPerMinute, started) || !allow(`${grant.id}:${name}`, entry.tool.perMinute ?? defaultPerMinute, started)) {
        result = err(invalid('调用太频繁了，过一分钟再试'));
      } else {
        try {
          result = await entry.provider.call(name, input ?? {}, { grant, now: started });
        } catch (cause) {
          result = err(invalid(`工具执行失败：${cause instanceof Error ? cause.message : String(cause)}`));
        }
      }
      const detail = result.ok ? summarize(input) : result.error.message.slice(0, 200);
      await deps.toolGrants
        .recordCall({
          id: randomUUID(),
          grantId: grant.id,
          taskId: grant.taskId,
          sessionId: grant.sessionId,
          tool: name,
          version: entry?.tool.version ?? 0,
          ok: result.ok,
          detail,
          latencyMs: Math.max(0, deps.now() - started),
          at: started
        })
        .catch(() => undefined);
      return result;
    }
  };
}

/**
 * 发给 worker 之前给 start_session 配上工具：每次（新开、续跑、重新托管）都换一把新令牌，旧的作废；
 * dispose 时作废。签发失败不拦会话——没有工具也能干活。
 */
export async function withToolAccess(
  gateway: ToolGateway,
  endpoint: { readonly url: string; readonly transport?: 'http' | 'stdio-shim' } | null,
  command: WorkerCommand
): Promise<WorkerCommand> {
  if (endpoint === null) return command;
  try {
    if (command.kind === 'start_session') {
      const { token } = await gateway.issue({ id: command.sessionId, taskId: asTaskId(command.taskId), workerId: command.workerId });
      return { ...command, tools: { transport: endpoint.transport ?? 'http', url: endpoint.url, token } };
    }
    if (command.kind === 'dispose') await gateway.revoke({ id: command.sessionId });
  } catch {
    // 能力层是附加的：失败就当这次没有工具
  }
  return command;
}
