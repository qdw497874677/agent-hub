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
  type Bot,
  type BotId,
  type BotInput,
  type BotPatch,
  type DomainError,
  type Principal,
  type ProjectId,
  type Result
} from '@agent-hub/domain';
import type { SubjectOf } from './auth.ts';
import { botRecordDto } from './agent-ref-dto.ts';
import { fail } from './http-error.ts';

/** 路由只认这几个用例函数，装配由 main.ts 决定。 */
export interface BotsApi {
  listBots(actor: Principal | null, projectId: ProjectId): Promise<Result<readonly Bot[], DomainError>>;
  getBot(actor: Principal | null, id: BotId): Promise<Result<Bot, DomainError>>;
  createBot(actor: Principal | null, projectId: ProjectId, input: BotInput): Promise<Result<Bot, DomainError>>;
  updateBot(actor: Principal | null, id: BotId, patch: BotPatch): Promise<Result<Bot, DomainError>>;
  removeBot(actor: Principal | null, id: BotId): Promise<Result<{ removed: true }, DomainError>>;
}

/**
 * 一等 bot 的 HTTP 外壳（C3a）：
 * - GET    /api/bots?projectId=…   列表
 * - POST   /api/bots               新建（name 即 @id，建好不改）
 * - GET    /api/bots/:id           单条
 * - PATCH  /api/bots/:id           改显示名 / 颜色 / 职责 / 运行时 / 模型 / 复用（name 不可改）
 * - DELETE /api/bots/:id           删除（不拦群 / 会话引用；群聊的收尾由 /agents 那条路径负责）
 *
 * 鉴权在用例里做（读 project.read、写 project.share），这里只负责解析、身份与 DTO。
 * 老的 /api/projects/:id/agents 仍在 persistent-agent-routes.ts，内部走同一套用例。
 */
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
const createBody = z.object({ projectId: z.string().min(1), name: z.string().min(1).max(40), ...fields });
const patchBody = z.object({ ...fields, agentId: fields.agentId.optional(), name: z.string().min(1).max(40).optional() });

export function installBotRoutes(app: Hono<any>, bots: BotsApi, subjectOf: SubjectOf): void {
  const me = (c: Parameters<SubjectOf>[0]) => principalOfSubject(subjectOf(c));
  const needUser = { code: 'forbidden' as const, message: '要以账号身份管理 bot' };
  const issue = (e: z.ZodError) => {
    const first = e.issues[0];
    return first ? `${first.path.join('.')}: ${first.message}` : 'bot 格式不对';
  };

  app.get('/api/bots', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const projectId = c.req.query('projectId')?.trim();
    if (!projectId) return fail(c, { code: 'invalid', message: '缺少 projectId' });
    const list = await bots.listBots(actor, asProjectId(projectId));
    if (!list.ok) return fail(c, list.error);
    return c.json({ bots: list.value.map(botRecordDto) });
  });

  app.post('/api/bots', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const parsed = createBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: issue(parsed.error) });
    const { projectId, ...input } = parsed.data;
    const created = await bots.createBot(actor, asProjectId(projectId), input);
    return created.ok ? c.json(botRecordDto(created.value), 201) : fail(c, created.error);
  });

  app.get('/api/bots/:id', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const bot = await bots.getBot(actor, c.req.param('id') as BotId);
    return bot.ok ? c.json(botRecordDto(bot.value)) : fail(c, bot.error);
  });

  app.patch('/api/bots/:id', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const parsed = patchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: issue(parsed.error) });
    const updated = await bots.updateBot(actor, c.req.param('id') as BotId, parsed.data);
    return updated.ok ? c.json(botRecordDto(updated.value)) : fail(c, updated.error);
  });

  app.delete('/api/bots/:id', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const removed = await bots.removeBot(actor, c.req.param('id') as BotId);
    return removed.ok ? c.json({ ok: true }) : fail(c, removed.error);
  });
}
