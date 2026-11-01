import type { Hono } from 'hono';
import { z } from 'zod';
import { asProjectId, principalOfSubject, MAX_GROUP_LIMITS, MAX_POST_CHARS, type GroupChat, type PersistentAgents } from '@agent-hub/domain';
import type { SubjectOf } from './auth.ts';
import { fail } from './http-error.ts';
import { installPersistentAgentRoutes } from './persistent-agent-routes.ts';

/**
 * 群聊的 HTTP 外壳（ADR 0018 · 群组）：
 * - GET/POST /api/projects/:id/groups      项目里的群 / 建群（group.manage）
 * - GET  /api/groups/:id                   群设置 + 成员会话 + 进行中的对话
 * - PUT  /api/groups/:id                   改设置（group.manage）
 * - GET  /api/groups/:id/posts?after=&limit=
 * - POST /api/groups/:id/posts             人发言（group.post）
 * - POST /api/groups/:id/stop              停止：取消排队，成员暂停到人再次发言
 * - POST /api/groups/:id/members           把 bot 加进群：{ role } 或 { roles: [] }（group.manage），不重放消息
 * - DELETE /api/groups/:id/members/:role   把 bot 移出群（group.manage）；主持人要先换人
 * - GET  /api/groups/unread              我看得到的群里的未读（顶栏红点）
 * - POST /api/groups/:id/read             标已读（body 可给 seq，不给读到最新）
 * - GET  /api/groups/:id/chains            调用链：每段对话的投递（谁、哪条会话、结果）
 * 权限都在用例里按群所在的项目判。
 */
const groupBody = z.object({
  name: z.string().min(1).max(60),
  members: z.array(z.string().max(40)).min(1).max(12),
  hostRole: z.string().max(40).nullable().default(null),
  speakingStrategy: z.enum(['host', 'volunteer']).default('host'),
  limits: z
    .object({ maxRounds: z.number().int().min(1).max(MAX_GROUP_LIMITS.maxRounds), maxMessages: z.number().int().min(1).max(MAX_GROUP_LIMITS.maxMessages) })
    .partial()
    .default({})
});
const postBody = z.object({ body: z.string().min(1).max(MAX_POST_CHARS) });

export interface GroupRouteDeps {
  readonly groups: GroupChat;
  readonly agents?: PersistentAgents;
}

export function installGroupRoutes(app: Hono<any>, options: GroupRouteDeps, subjectOf: SubjectOf): void {
  const { groups } = options;
  if (options.agents) installPersistentAgentRoutes(app, options.agents, subjectOf);
  const me = (c: Parameters<SubjectOf>[0]) => principalOfSubject(subjectOf(c));
  const needUser = { code: 'forbidden' as const, message: '要以账号身份使用群聊' };
  const parseGroup = (raw: unknown) => {
    const parsed = groupBody.safeParse(raw);
    if (parsed.success) return { ok: true as const, value: parsed.data };
    const issue = parsed.error.issues[0];
    return { ok: false as const, message: issue ? `${issue.path.join('.')}: ${issue.message}` : '群设置格式不对' };
  };

  app.get('/api/projects/:id/groups', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const list = await groups.list(actor, asProjectId(c.req.param('id')));
    return list.ok ? c.json({ groups: list.value }) : fail(c, list.error);
  });

  app.post('/api/projects/:id/groups', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const parsed = parseGroup(await c.req.json().catch(() => null));
    if (!parsed.ok) return fail(c, { code: 'invalid', message: parsed.message });
    const created = await groups.create(actor, asProjectId(c.req.param('id')), parsed.value);
    return created.ok ? c.json(created.value, 201) : fail(c, created.error);
  });

  app.get('/api/groups/unread', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const unread = await groups.unread(actor);
    return unread.ok ? c.json(unread.value) : fail(c, unread.error);
  });

  app.post('/api/groups/:id/read', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const body = z.object({ seq: z.number().int().min(0).optional() }).safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!body.success) return fail(c, { code: 'invalid', message: 'seq 要是非负整数' });
    const read = await groups.markRead(actor, c.req.param('id'), body.data.seq);
    return read.ok ? c.json(read.value) : fail(c, read.error);
  });

  app.get('/api/groups/:id', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const view = await groups.view(actor, c.req.param('id'));
    return view.ok ? c.json(view.value) : fail(c, view.error);
  });

  app.put('/api/groups/:id', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const parsed = parseGroup(await c.req.json().catch(() => null));
    if (!parsed.ok) return fail(c, { code: 'invalid', message: parsed.message });
    const updated = await groups.update(actor, c.req.param('id'), parsed.value);
    return updated.ok ? c.json(updated.value) : fail(c, updated.error);
  });

  app.get('/api/groups/:id/posts', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const after = c.req.query('after');
    const limit = Number(c.req.query('limit') ?? 100);
    const posts = await groups.posts(actor, c.req.param('id'), after === undefined || after === '' ? null : Number(after) || 0, Number.isFinite(limit) ? limit : 100);
    return posts.ok ? c.json({ posts: posts.value }) : fail(c, posts.error);
  });

  app.post('/api/groups/:id/posts', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const parsed = postBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: `要给 body（1–${MAX_POST_CHARS} 字符）` });
    const posted = await groups.post(actor, c.req.param('id'), parsed.data.body);
    return posted.ok ? c.json(posted.value, 201) : fail(c, posted.error);
  });

  app.post('/api/groups/:id/stop', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const stopped = await groups.stop(actor, c.req.param('id'));
    return stopped.ok ? c.json(stopped.value) : fail(c, stopped.error);
  });

  app.post('/api/groups/:id/members', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const body = z
      .object({ role: z.string().min(1).max(40).optional(), roles: z.array(z.string().min(1).max(40)).min(1).max(12).optional() })
      .refine((b) => b.role !== undefined || b.roles !== undefined)
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(c, { code: 'invalid', message: '要给 role 或 roles' });
    const names = body.data.roles ?? [body.data.role!];
    const group = await groups.addMembers(actor, c.req.param('id'), names);
    return group.ok ? c.json(group.value) : fail(c, group.error);
  });

  app.delete('/api/groups/:id/members/:role', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const group = await groups.removeMember(actor, c.req.param('id'), c.req.param('role'));
    return group.ok ? c.json(group.value) : fail(c, group.error);
  });

  app.get('/api/groups/:id/chains', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const chains = await groups.chains(actor, c.req.param('id'), Number(c.req.query('limit') ?? 20) || 20);
    // 投进会话的原文可能很长，调用链只给摘要
    return chains.ok
      ? c.json({ chains: chains.value.map((ch) => ({ thread: ch.thread, deliveries: ch.deliveries.map(({ prompt, ...d }) => ({ ...d, result: d.result ? d.result.slice(0, 400) : null, promptChars: prompt.length })) })) })
      : fail(c, chains.error);
  });
}
