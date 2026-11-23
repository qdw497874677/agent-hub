import { newId } from '../ids.ts';
import type { Session } from '../session.ts';
import { forbidden, invalid, notFound, type DomainError } from '../errors.ts';
import { err, type Result } from '../result.ts';
import type { GrantActor } from '../tool.ts';
import { DEFAULT_TOOL_SCOPES, TOOL_GRANT_MAX_LIFETIME_MS, TOOL_GRANT_TTL_MS, TOOL_SCOPES, grantActive, restrictedChildScopes, type ToolGrant, type ToolScope } from '../tool.ts';
import type { ToolDescriptor, ToolProvider } from '../ports/tool-provider.ts';
import type { ToolGrantRepository } from '../ports/tool-grant-repository.ts';
import type { TokenIssuer } from '../ports/token-issuer.ts';
import type { Deps } from './deps.ts';
import type { WorkerCommand } from '../ports/node-gateway.ts';
import { asTaskId } from '../ids.ts';

/**
 * 会话级 scope 上限：每次签发 / 认证 / 调用都重新求值。
 * 返回 null = 不限制；返回数组 = 与该会话令牌自身 scope 取交集。
 *
 * 这是「旧 token 不能绕过当前授权」的落点：受限子会话即使手里还握着策略收紧前签发的令牌，
 * 认证与调用时也会被重新收窄；求值失败按拒绝处理（fail closed）。
 */
export type ToolScopeCap = (
  session: Pick<Session, 'id' | 'taskId' | 'workerId'>,
  actor?: GrantActor
) => Promise<readonly ToolScope[] | null> | readonly ToolScope[] | null;

/** 用会话级上限收窄授权；上限求值失败 → 空 scope（等于没有工具），绝不回落成完整权限。 */
async function capGrantScopes(grant: ToolGrant, cap?: ToolScopeCap): Promise<ToolGrant> {
  if (!cap) return grant;
  let limit: readonly ToolScope[] | null;
  try {
    limit = await cap({ id: grant.sessionId, taskId: grant.taskId, workerId: grant.workerId }, grant.actor);
  } catch {
    limit = [];
  }
  if (limit === null) return grant;
  const allowed = new Set(limit);
  const scopes = grant.scopes.filter((scope) => allowed.has(scope));
  return scopes.length === grant.scopes.length ? grant : { ...grant, scopes };
}

export interface ToolGatewayDeps extends Pick<Deps, 'now'> {
  readonly toolGrants: ToolGrantRepository;
  readonly tokens: TokenIssuer;
  readonly providers: readonly ToolProvider[];
  /** 每个授权每分钟默认上限。 */
  readonly perMinute?: number;
  /** 见 {@link ToolScopeCap}；省略 = 不做会话级收窄。 */
  readonly scopeCap?: ToolScopeCap;
}

export interface IssuedGrant {
  readonly grant: ToolGrant;
  /** 明文令牌：只在这里出现一次，交给 worker 后不再保存。 */
  readonly token: string;
}

export interface ToolGateway {
  /** 给一条会话签新授权，同时作废它旧的授权（每次重新托管换一把）。 */
  issue(session: Pick<Session, 'id' | 'taskId' | 'workerId'>, scopes?: readonly ToolScope[], actor?: GrantActor): Promise<IssuedGrant>;
  revoke(session: Pick<Session, 'id'>): Promise<void>;
  /** 作废所有不属于 `running` 这些会话的授权（hub 启动时、或运维一键全作废时传空）。返回作废条数。 */
  revokeAllExcept(running: readonly Session['id'][]): Promise<number>;
  /** 令牌 → 有效授权；过期、作废、不认识都是 null。 */
  authenticate(token: string): Promise<ToolGrant | null>;
  /** 这个授权能看到的工具（按 scope 过滤）。 */
  list(grant: ToolGrant): readonly ToolDescriptor[];
  call(grant: ToolGrant, name: string, input: unknown): Promise<Result<unknown, DomainError>>;
}

const summarize = (input: unknown): string => {
  if (input === null || typeof input !== 'object') return '';
  // 只记键和短值：正文与派工指令只记长度，别把内容写进审计。
  const parts = Object.entries(input as Record<string, unknown>).map(([key, value]) =>
    typeof value === 'string'
      ? key === 'body' || key === 'instructions' || key === 'goal' || key === 'title'
        ? `${key}=<${value.length} 字>`
        : value.length > 40
          ? `${key}=<${value.length} 字>`
          : `${key}=${value}`
      : `${key}=${JSON.stringify(value)}`
  );
  return parts.join(' ').slice(0, 200);
};

/**
 * ToolGateway（§4.1）：鉴权 → 授权(scope) → 限流 → 调用 → 审计。
 * 传输无关：MCP、stdio shim、REST 都调它。
 */
export function createToolGateway(deps: ToolGatewayDeps): ToolGateway {
  const defaultPerMinute = deps.perMinute ?? 60;
  // 限流窗口只在内存里：hub 重启会清零。可以接受——授权本身是短期的、重启时只保留运行中会话的授权，
  // 最坏情况是一条运行中的会话在重启那一分钟里多拿一个窗口的配额（见 tasks-and-capabilities.md）。
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
    async issue(session, scopes = DEFAULT_TOOL_SCOPES, actor) {
      const now = deps.now();
      await deps.toolGrants.revokeSession(session.id, now);
      const { token, hash } = deps.tokens.issue();
      const grant: ToolGrant = {
        id: newId(),
        tokenHash: hash,
        taskId: session.taskId,
        sessionId: session.id,
        workerId: session.workerId,
        scopes: [...scopes],
        createdAt: now,
        expiresAt: now + TOOL_GRANT_TTL_MS,
        revokedAt: null,
        ...(actor ? { actor } : {})
      };
      const capped = await capGrantScopes(grant, deps.scopeCap);
      await deps.toolGrants.save(capped);
      return { grant: capped, token };
    },

    async revoke(session) {
      await deps.toolGrants.revokeSession(session.id, deps.now());
    },

    async revokeAllExcept(running) {
      return deps.toolGrants.revokeAllExcept(running, deps.now());
    },

    async authenticate(token) {
      if (token === '') return null;
      const grant = await deps.toolGrants.byTokenHash(deps.tokens.hashOf(token));
      const now = deps.now();
      if (!grant || !grantActive(grant, now)) return null;
      // 滑动续期：用过一半有效期就续到 now + TTL，但不超过签发后的最长寿命
      const renewed = Math.min(now + TOOL_GRANT_TTL_MS, grant.createdAt + TOOL_GRANT_MAX_LIFETIME_MS);
      const current = renewed - grant.expiresAt > TOOL_GRANT_TTL_MS / 2 ? { ...grant, expiresAt: renewed } : grant;
      if (current !== grant) await deps.toolGrants.save(current);
      // scope 收窄只在本次派生授权上生效，不落库：授权记录保留签发时的 scope，
      // 策略恢复后重新托管会签发新令牌；旧令牌也不会因临时收窄被永久截断。
      return capGrantScopes(current, deps.scopeCap);
    },

    list(grant) {
      return [...byName.values()].map((entry) => entry.tool).filter((tool) => !tool.hidden && grant.scopes.includes(tool.scope));
    },

    async call(grant, name, input) {
      const started = deps.now();
      // 认证到调用之间策略可能又变了（撤销 / 子会话指派 / 项目漂移）：这里必须再收窄一次。
      const effective = await capGrantScopes(grant, deps.scopeCap);
      const entry = byName.get(name);
      let result: Result<unknown, DomainError>;
      if (!entry) result = err(notFound(`没有这个工具：${name}`));
      else if (!grantActive(effective, started)) result = err(forbidden('授权已过期或已作废'));
      else if (!effective.scopes.includes(entry.tool.scope)) result = err(forbidden(`这个会话没有 ${entry.tool.scope} 权限`));
      else if ((!entry.tool.hidden && !allow(effective.id, defaultPerMinute, started)) || !allow(`${effective.id}:${name}`, entry.tool.perMinute ?? defaultPerMinute, started)) {
        result = err(invalid('调用太频繁了，过一分钟再试'));
      } else {
        try {
          result = await entry.provider.call(name, input ?? {}, { grant: effective, now: started });
        } catch (cause) {
          result = err(invalid(`工具执行失败：${cause instanceof Error ? cause.message : String(cause)}`));
        }
      }
      const detail = entry?.tool.omitAuditPayload
        ? (result.ok ? 'ok' : result.error.code)
        : (result.ok ? summarize(input) : result.error.message.slice(0, 200));
      await deps.toolGrants
        .recordCall({
          id: newId(),
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
 * `start_session` 签发授权时的扩展点。
 *
 * - `extraScopes`：在默认 scope 之外**追加**（旧行为）；抛错只丢额外项。
 * - `scopes`：**替换**整份 scope 集，用于受限子会话。返回 `null` = 这次不算受限，退回默认 +
 *   extraScopes；抛错按受限子会话处理（fail closed），不会回落到完整默认权限。
 *
 * 两者都没有时保持普通会话的现有默认行为。
 */
export interface ToolAccessOptions {
  readonly extraScopes?: (input: {
    readonly session: Pick<Session, 'id' | 'taskId' | 'workerId'>;
    readonly actor?: GrantActor;
  }) => Promise<readonly ToolScope[]> | readonly ToolScope[];
  readonly scopes?: (input: {
    readonly session: Pick<Session, 'id' | 'taskId' | 'workerId'>;
    readonly actor?: GrantActor;
  }) => Promise<readonly ToolScope[] | null> | readonly ToolScope[] | null;
}

/**
 * 发给 worker 之前给 start_session 配上工具：新开/重新托管时换一把新令牌，旧的作废。
 * 授权不随单轮结束回收：ACP 进程只在 session/new|load 时拿到 MCP Authorization，
 * 后续 prompt 无法热换 token。dispose 时作废；签发失败不拦会话——没有工具也能干活。
 */
export async function withToolAccess(
  gateway: ToolGateway,
  endpoint: { readonly url: string; readonly transport: 'relay' } | null,
  command: WorkerCommand,
  actor?: GrantActor,
  options: ToolAccessOptions = {}
): Promise<WorkerCommand> {
  if (endpoint === null) return command;
  try {
    if (command.kind === 'start_session') {
      const session = {
        id: command.sessionId,
        taskId: command.taskId === null ? null : asTaskId(command.taskId),
        workerId: command.workerId
      };
      let scopes: readonly ToolScope[];
      let replacement: readonly ToolScope[] | null = null;
      if (options.scopes) {
        try {
          replacement = await options.scopes({ session, actor });
        } catch {
          // 受限策略求值失败必须收紧，不能借异常退回默认写权限。
          replacement = restrictedChildScopes();
        }
      }
      if (replacement !== null) {
        const known = new Set(TOOL_SCOPES);
        scopes = [...new Set(replacement)].filter((scope) => known.has(scope));
      } else {
        let extraScopes: readonly ToolScope[] = [];
        if (options.extraScopes) {
          try {
            extraScopes = await options.extraScopes({ session, actor });
          } catch {
            // 额外能力失败只丢额外项；默认工具照发。
            extraScopes = [];
          }
        }
        scopes = [...new Set([...DEFAULT_TOOL_SCOPES, ...extraScopes])];
      }
      const { token } = await gateway.issue(
        // 这里在构造 grant 的会话描述（不是 Session 对象），null 即容器会话。
        session,
        scopes,
        actor
      );
      return { ...command, tools: { transport: endpoint.transport, url: endpoint.url, token } };
    }
    if (command.kind === 'dispose') await gateway.revoke({ id: command.sessionId });
  } catch {
    // 能力层是附加的：失败就当这次没有工具
  }
  return command;
}
