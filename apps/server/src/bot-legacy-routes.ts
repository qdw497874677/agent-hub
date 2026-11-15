import type { Hono } from 'hono';
import { z } from 'zod';
import {
  AGENT_REF_MODEL_MAX,
  AGENT_REF_OPTION_KEY,
  AGENT_REF_OPTIONS_MAX,
  AGENT_REF_OPTION_VALUE_MAX,
  asProjectId,
  PERSISTENT_AGENT_COLORS,
  PERSISTENT_AGENT_DESCRIPTION_MAX,
  PERSISTENT_AGENT_DISPLAY_NAME_MAX,
  principalOfSubject,
  type ApiToken,
  type PersistentAgents
} from '@agent-hub/domain';
import type { SubjectOf } from './auth.ts';
import { botDto } from './agent-ref-dto.ts';
import type { BotTokenSource } from './bot-routes.ts';
import { fail } from './http-error.ts';

const tokenDto = (token: ApiToken | undefined): { id: string; prefix: string; createdAt: number; lastUsedAt: number | null } | null =>
  token ? { id: token.id, prefix: token.prefix, createdAt: token.createdAt, lastUsedAt: token.lastUsedAt } : null;

/**
 * 旧路径别名，逐步下线（ADR 0037）：
 * - GET    /api/projects/:id/agents          列表（带所在的群）
 * - POST   /api/projects/:id/agents          新建（name 即 @id，建好不改）
 * - PUT    /api/projects/:id/agents/:name    改显示名 / 颜色 / 职责 / 运行时 / 模型 / 复用
 * - DELETE /api/projects/:id/agents/:name    删除，同时从所有群移出
 * 一等实体是 `Bot`，新调用方用 `/api/bots`（`bot-routes.ts`）；这里路径保持不变避免破坏调用方，
 * 内部走同一套 `PersistentAgents` 用例。旧的整表接口 /api/projects/:id/messaging 也保留。
 */
// 键名 / 条数 / 值长度的正则与上限从 domain 导出，别在这里再写一份。
const optionsBody = z
  .record(
    z.string().regex(AGENT_REF_OPTION_KEY, '选项键要小写字母开头，只含 a-z 0-9 _ . -'),
    z.union([z.string().max(AGENT_REF_OPTION_VALUE_MAX), z.boolean()])
  )
  .refine((value) => Object.keys(value).length <= AGENT_REF_OPTIONS_MAX, `启动选项最多 ${AGENT_REF_OPTIONS_MAX} 个`);

const fields = {
  displayName: z.string().max(PERSISTENT_AGENT_DISPLAY_NAME_MAX).optional(),
  color: z.enum(PERSISTENT_AGENT_COLORS).optional(),
  description: z.string().max(PERSISTENT_AGENT_DESCRIPTION_MAX).optional(),
  agentId: z.string().min(1).max(80),
  model: z.string().max(AGENT_REF_MODEL_MAX).optional(),
  reuse: z.enum(['sticky', 'per-trace', 'always-new']).optional(),
  options: optionsBody.optional()
};
const createBody = z.object({ name: z.string().min(1).max(40), ...fields });
const patchBody = z.object({ ...fields, agentId: fields.agentId.optional() });

export function installLegacyBotRoutes(app: Hono<any>, agents: PersistentAgents, subjectOf: SubjectOf, botTokens?: BotTokenSource): void {
  const me = (c: Parameters<SubjectOf>[0]) => principalOfSubject(subjectOf(c));
  const needUser = { code: 'forbidden' as const, message: '要以账号身份管理 bot' };
  const issue = (e: z.ZodError) => {
    const first = e.issues[0];
    return first ? `${first.path.join('.')}: ${first.message}` : 'bot 格式不对';
  };

  app.get('/api/projects/:id/agents', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const projectId = asProjectId(c.req.param('id'));
    const list = await agents.list(actor, projectId);
    if (!list.ok) return fail(c, list.error);
    // 一次查完这个项目的 bot 令牌，再按 bot 名匹配（C1：BotDto.token）。
    const tokens = botTokens ? await botTokens.listBotsByProject(projectId) : [];
    return c.json({ agents: list.value.map((agent) => ({ ...botDto(agent), token: tokenDto(tokens.find((token) => token.revokedAt === null && token.bot?.name === agent.name)) })) });
  });

  app.post('/api/projects/:id/agents', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const parsed = createBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: issue(parsed.error) });
    const created = await agents.create(actor, asProjectId(c.req.param('id')), parsed.data);
    return created.ok ? c.json(botDto(created.value), 201) : fail(c, created.error);
  });

  app.put('/api/projects/:id/agents/:name', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const parsed = patchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: issue(parsed.error) });
    const updated = await agents.update(actor, asProjectId(c.req.param('id')), c.req.param('name'), parsed.data);
    return updated.ok ? c.json(botDto(updated.value)) : fail(c, updated.error);
  });

  app.delete('/api/projects/:id/agents/:name', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const removed = await agents.remove(actor, asProjectId(c.req.param('id')), c.req.param('name'));
    return removed.ok ? c.json(removed.value) : fail(c, removed.error);
  });
}
