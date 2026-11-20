// session-work 能力的处理函数（从 app.ts 原样搬出；鉴权/限流/审计仍在 app.ts 的前导里）。
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { V1Runtime } from '../context.ts';
import { openapiOn, valid } from '../context.ts';
import type { Env } from '../context.ts';
import {
  asSessionId,
  can,
  forbidden,
  settleSessionUseCase,
  unavailable
} from '@agent-hub/domain';
import {
  sessionSchema
} from '@agent-hub/contract';
import { fail } from '../../http-error.ts';
import {
  routes
} from '.././routes.ts';

/** installSessionWork：注册顺序与拆分前一致（Hono 的路由匹配顺序敏感）。 */
export function installSessionWork(app: OpenAPIHono<Env>, rt: V1Runtime): void {
  const on = openapiOn(app);
  on(routes.sessionGitState, async (c) => {
    const git = rt.needGit();
    if (!git) return fail(c, unavailable('Git 工作流未就绪'));
    const actor = rt.principal(c);
    if (!can(actor, 'session.read')) return fail(c, forbidden('令牌没有 sessions:read'));
    const member = c.req.query('member') || undefined;
    const result = await git.state(actor, c.req.param('sessionId') ?? '', member);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  on(routes.workspaceDiff, async (c) => {
    const files = rt.files;
    if (!files) return fail(c, unavailable('工作空间文件服务未就绪'));
    const actor = rt.principal(c);
    if (!can(actor, 'session.read')) return fail(c, forbidden('令牌没有 sessions:read'));
    const query = valid<{ member?: string; maxBytes?: number }>(c, 'query');
    const result = await files.worktreeDiff(actor, c.req.param('sessionId') ?? '', {
      ...(query.member ? { member: query.member } : {}),
      ...(query.maxBytes !== undefined ? { maxBytes: query.maxBytes } : {})
    });
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  on(routes.workspaceReadFile, async (c) => {
    const files = rt.files;
    if (!files) return fail(c, unavailable('工作空间文件服务未就绪'));
    const actor = rt.principal(c);
    if (!can(actor, 'session.read')) return fail(c, forbidden('令牌没有 sessions:read'));
    const query = valid<{ path: string; member?: string; confirmed?: '1' | 'true' }>(c, 'query');
    const result = await files.readWorktreeFile(actor, c.req.param('sessionId') ?? '', query.path, {
      confirmed: query.confirmed === '1' || query.confirmed === 'true',
      ...(query.member ? { member: query.member } : {})
    });
    if (!result.ok) return fail(c, result.error);
    const file = result.value;
    return c.json({ path: file.path, size: file.size, modifiedAt: file.modifiedAt, binary: file.binary, content: file.binary ? '' : new TextDecoder().decode(file.bytes) });
  });
  on(routes.sessionGitRun, async (c) => {
    const git = rt.needGit();
    if (!git) return fail(c, unavailable('Git 工作流未就绪'));
    const actor = rt.principal(c);
    if (!can(actor, 'session.prompt')) return fail(c, forbidden('令牌没有 sessions:write'));
    const input = valid<{ action: 'commit' | 'push' | 'pr'; message?: string; title?: string; body?: string; member?: string }>(c, 'json');
    const member = input.member || c.req.query('member') || undefined;
    const result = await git.run(
      actor,
      c.req.param('sessionId') ?? '',
      { action: input.action, message: input.message ?? '', ...(input.title !== undefined ? { title: input.title } : {}), ...(input.body !== undefined ? { body: input.body } : {}) },
      member
    );
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
}

/** installSessionSettle：注册顺序与拆分前一致（Hono 的路由匹配顺序敏感）。 */
export function installSessionSettle(app: OpenAPIHono<Env>, rt: V1Runtime): void {
  const on = openapiOn(app);
  on(routes.sessionSettle, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'session.settle')) return fail(c, forbidden('令牌没有收起会话的权限（sessions:write 已包含 session.settle）'));
    const input = valid<{ settled: boolean }>(c, 'json');
    const result = await settleSessionUseCase(rt.deps, {
      sessionId: asSessionId(c.req.param('sessionId') ?? ''),
      settled: input.settled,
      actor,
      now: rt.deps.now()
    });
    if (!result.ok) return fail(c, result.error);
    const { cleanup, ...session } = result.value;
    return c.json({ ...sessionSchema.parse(session), cleanup: cleanup ?? { items: [] } });
  });
}
