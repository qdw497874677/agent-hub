// tokens 能力的处理函数（从 app.ts 原样搬出；鉴权/限流/审计仍在 app.ts 的前导里）。
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { V1Runtime } from '../context.ts';
import { openapiOn, valid } from '../context.ts';
import type { Env } from '../context.ts';
import {
  can,
  forbidden,
  listApiTokens,
  createApiToken,
  rotateApiToken,
  revokeApiToken
} from '@agent-hub/domain';
import { fail } from '../../http-error.ts';
import {
  routes
} from '.././routes.ts';

/** installTokens：注册顺序与拆分前一致（Hono 的路由匹配顺序敏感）。 */
export function installTokens(app: OpenAPIHono<Env>, rt: V1Runtime): void {
  const on = openapiOn(app);
  const tokenManageDeps = {
    apiTokens: rt.options.tokens.apiTokens,
    users: rt.options.tokens.users,
    tokens: rt.options.tokens.tokens,
    now: rt.options.tokens.now,
    projects: rt.options.tokens.projects ?? rt.deps.projects,
    // OpenApiOptions.audit 只保证 append；创建/轮换/吊销只用 append。
    audit: rt.options.audit as import('@agent-hub/domain').ApiTokenDeps['audit']
  };
  on(routes.tokenList, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'token.manage')) return fail(c, forbidden('令牌没有 tokens:manage'));
    return c.json({ tokens: await listApiTokens(tokenManageDeps, actor) });
  });
  on(routes.tokenCreate, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'token.manage')) return fail(c, forbidden('令牌没有 tokens:manage'));
    const input = valid<{ name: string; scopes: import('@agent-hub/domain').ApiScope[]; expiresAt: number; projectIds?: string[] | null }>(c, 'json');
    const result = await createApiToken(tokenManageDeps, actor, {
      name: input.name,
      kind: 'personal',
      scopes: input.scopes,
      expiresAt: input.expiresAt,
      projectIds: input.projectIds
    });
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });
  on(routes.tokenRotate, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'token.manage')) return fail(c, forbidden('令牌没有 tokens:manage'));
    const result = await rotateApiToken(tokenManageDeps, actor, c.req.param('tokenId') ?? '');
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  on(routes.tokenRevoke, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'token.manage')) return fail(c, forbidden('令牌没有 tokens:manage'));
    const result = await revokeApiToken(tokenManageDeps, actor, c.req.param('tokenId') ?? '');
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
}
