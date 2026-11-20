// session-comms 能力的处理函数（从 app.ts 原样搬出；鉴权/限流/审计仍在 app.ts 的前导里）。
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { V1Runtime } from '../context.ts';
import { openapiOn, valid } from '../context.ts';
import type { Env } from '../context.ts';
import type {
  Context
} from 'hono';
import type {
  Principal
} from '@agent-hub/domain';
import {
  asSessionId,
  authorizeProject,
  authorizeSession,
  authorizeWorker,
  projectOfSession,
  notFound
} from '@agent-hub/domain';
import {
  linkSessionsUseCase,
  unlinkSessionsUseCase,
  messageView
} from '@agent-hub/domain';
import { fail } from '../../http-error.ts';
import {
  routes
} from '.././routes.ts';

/** installSessionComms：注册顺序与拆分前一致（Hono 的路由匹配顺序敏感）。 */
export function installSessionComms(app: OpenAPIHono<Env>, rt: V1Runtime): void {
  const on = openapiOn(app);
  // ── 会话通信 P1d：连线、同伴、外部消息、收件箱 ──
  const noMessaging = (c: Context) => fail(c, { code: 'not_implemented', message: '这台 hub 没装消息总线' });
  /** 另一条会话也要能 session.prompt（路径上那条由 installAccess 查过）。 */
  const otherSession = async (actor: Principal, otherId: string, projectId: string): Promise<{ ok: true; id: string } | { ok: false; error: import('@agent-hub/domain').DomainError }> => {
    const other = await rt.deps.sessions.byId(asSessionId(otherId));
    const project = other ? await projectOfSession(rt.deps, other) : null;
    if (!other || !project || project.id !== projectId) return { ok: false, error: notFound('两条会话不在同一个项目里') };
    if (rt.deps.access) {
      const allowed = await authorizeSession(rt.deps.access, actor, project, other, 'session.prompt');
      if (!allowed.ok) return { ok: false, error: allowed.error };
    }
    return { ok: true, id: other.id };
  };
  const pathSession = async (c: Context) => {
    const session = await rt.deps.sessions.byId(asSessionId(c.req.param('sessionId') ?? ''));
    const project = session ? await projectOfSession(rt.deps, session) : null;
    return session && project ? { session, project } : null;
  };
  on(routes.linkSession, async (c) => {
    const actor = rt.principal(c);
    const here = await pathSession(c);
    if (!here) return fail(c, notFound('会话不存在'));
    const input = valid<{ otherSessionId: string }>(c, 'json');
    const checked = await otherSession(actor, input.otherSessionId, here.project.id);
    if (!checked.ok) return fail(c, checked.error);
    const linked = await linkSessionsUseCase(rt.deps, here.project.id, here.session.id, checked.id, actor.user.id);
    return linked.ok ? c.json(linked.value, 201) : fail(c, linked.error);
  });
  on(routes.unlinkSession, async (c) => {
    const actor = rt.principal(c);
    const here = await pathSession(c);
    if (!here) return fail(c, notFound('会话不存在'));
    const input = valid<{ otherSessionId: string }>(c, 'json');
    const checked = await otherSession(actor, input.otherSessionId, here.project.id);
    if (!checked.ok) return fail(c, checked.error);
    const removed = await unlinkSessionsUseCase(rt.deps, here.project.id, here.session.id, checked.id);
    return removed.ok ? c.json({ ok: true }) : fail(c, removed.error);
  });
  on(routes.sessionPeers, async (c) => {
    if (!rt.messaging) return noMessaging(c);
    const actor = rt.principal(c);
    const target = await rt.deps.sessions.byId(asSessionId(c.req.param('sessionId') ?? ''));
    if (!target) return fail(c, notFound('会话不存在'));
    // #243：容器会话按归属反推项目，再过 project.read（installAccess 对无任务会话放行）。
    const project = await projectOfSession(rt.deps, target);
    const allowed = await authorizeProject(rt.deps.access, actor, project, 'session.read');
    if (!allowed.ok) return fail(c, allowed.error);
    const peers = await rt.messaging.bus.peers(target.id);
    return peers.ok ? c.json({ peers: peers.value }) : fail(c, peers.error);
  });
  on(routes.sessionMessage, async (c) => {
    if (!rt.messaging) return noMessaging(c);
    const actor = rt.principal(c);
    const target = await rt.deps.sessions.byId(asSessionId(c.req.param('sessionId') ?? ''));
    if (!target) return fail(c, notFound('会话不存在'));
    // #243：容器会话没有任务，installAccess 会放行；先按归属反推项目、按 session.prompt 判（和普通会话一致），再查机器。
    const project = await projectOfSession(rt.deps, target);
    const allowed = await authorizeSession(rt.deps.access, actor, project, target, 'session.prompt');
    if (!allowed.ok) return fail(c, allowed.error);
    // 消息会让目标会话开新一轮：和 session_reply 一样，所在机器要过 authorizeWorker（本机 Worker 永远不对令牌开放）。
    const worker = await authorizeWorker(rt.deps.access, actor, target.workerId);
    if (!worker.ok) return fail(c, worker.error);
    const input = valid<{ kind: 'send' | 'ask'; body: string; parts?: unknown[]; wake?: boolean; timeoutSec?: number }>(c, 'json');
    const accepted = await rt.messaging.bus.acceptExternal({
      inboxId: actor.via!.tokenId,
      label: `外部 · ${actor.via!.name}`,
      onBehalfOf: actor.user.id,
      targetSessionId: asSessionId(c.req.param('sessionId') ?? ''),
      kind: input.kind,
      body: input.body,
      ...(input.parts !== undefined ? { parts: input.parts } : {}),
      ...(input.wake !== undefined ? { wake: input.wake } : {}),
      ...(input.timeoutSec !== undefined ? { timeoutSec: input.timeoutSec } : {})
    });
    return accepted.ok ? c.json(accepted.value, 201) : fail(c, accepted.error);
  });
  on(routes.getMessage, async (c) => {
    if (!rt.messaging) return noMessaging(c);
    const bus = rt.messaging.bus;
    const inboxId = rt.principal(c).via!.tokenId;
    const messageId = c.req.param('messageId') ?? '';
    const first = await bus.externalMessage(inboxId, messageId);
    if (!first.ok) return fail(c, first.error);
    const settled = (got: { message: { kind: string; status: string }; reply: unknown }) =>
      got.reply !== null || got.message.kind === 'reply' || (got.message.kind === 'send' && got.message.status !== 'queued' && got.message.status !== 'held');
    if (!settled(first.value)) {
      const limited = await rt.waitUntil(c, valid<{ waitSec?: number }>(c, 'query').waitSec, async () => {
        const again = await bus.externalMessage(inboxId, messageId);
        return again.ok && settled(again.value);
      });
      if (limited) return limited;
    }
    const got = await bus.externalMessage(inboxId, messageId);
    if (!got.ok) return fail(c, got.error);
    return c.json({ message: messageView(got.value.message), reply: got.value.reply ? messageView(got.value.reply) : null });
  });
  on(routes.messageInbox, async (c) => {
    if (!rt.messaging) return noMessaging(c);
    const query = valid<{ after?: number; limit?: number }>(c, 'query');
    const after = query.after ?? 0;
    const list = await rt.messaging.bus.externalInbox(rt.principal(c).via!.tokenId, after, query.limit ?? 50);
    return c.json({ messages: list.map(messageView), next: list.at(-1)?.createdAt ?? after });
  });
}
