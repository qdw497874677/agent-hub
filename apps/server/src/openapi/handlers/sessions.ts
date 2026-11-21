// sessions 能力的处理函数（从 app.ts 原样搬出；鉴权/限流/审计仍在 app.ts 的前导里）。
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { V1Runtime } from '../context.ts';
import { openapiOn, valid } from '../context.ts';
import type { Env } from '../context.ts';
import {
  applyStartExtras,
  checkStartExtras
} from '../../session-start-extras.ts';
import { streamSSE } from 'hono/streaming';
import type {
  JournalEntry
} from '@agent-hub/domain';
import {
  asSessionId,
  asTaskId,
  asWorkspaceId,
  authorizeProject,
  authorizeSession,
  authorizeWorker,
  can,
  changeSessionOption,
  switchSessionModel,
  projectOfSession,
  projectOfSessionOrigin,
  defaultWorkspaceFor,
  deriveSessionUseCase,
  forbidden,
  forkSessionUseCase,
  interruptSessionUseCase,
  invalid,
  notFound,
  bootstrapCapabilitiesForSession,
  promptSessionUseCase,
  resolveDefaultAgent
} from '@agent-hub/domain';
import type { z } from 'zod';
import type {
  deriveSessionRequest,
  forkSessionRequest
} from '@agent-hub/contract';
import { fail } from '../../http-error.ts';
import {
  noteProvenance,
  recordSessionAction,
  refreshAuthors,
  sessionActivity
} from '../../session-activity.ts';
import {
  routes
} from '.././routes.ts';
import { workspaceForApiStart } from '../../session-workspace.ts';
import {
  isProjectableEntry,
  lastJournalSeq,
  projectEvents
} from '.././projection.ts';

/** installSessionsStart：注册顺序与拆分前一致（Hono 的路由匹配顺序敏感）。 */
export function installSessionsStart(app: OpenAPIHono<Env>, rt: V1Runtime): void {
  const on = openapiOn(app);
  /** repoId 只用来挑工作目录，不往 derive 里传。 */
  const withoutRepo = <T extends { repoId?: string }>(value: T): Omit<T, 'repoId'> => {
    const { repoId: _repoId, ...rest } = value;
    return rest;
  };
  on(routes.startSession, async (c) => {
    const actor = rt.principal(c);
    const { handle, linkWith, ...input } = valid<z.output<typeof deriveSessionRequest>>(c, 'json');
    if (!can(actor, 'session.create')) return fail(c, forbidden('令牌没有 sessions:write'));
    const extras = { handle, linkWith };
    const linkIds = await checkStartExtras(rt.deps, rt.messaging?.messages, input.taskId, extras, actor);
    if (!linkIds.ok) return fail(c, linkIds.error);
    const placed = await workspaceForApiStart(
      rt.deps,
      { ...input, ...(input.workspaceMode === undefined ? {} : { mode: input.workspaceMode }) },
      actor
    );
    if (!placed.ok) return fail(c, placed.error);
    // model 省略或空串：按默认 Agent 层级解析（任务默认 > 项目默认 > 团队运行时默认）；
    // 显式传的 model 不动。没有可解析的默认就明确 400，不写死某个模型名。
    let model = input.model ?? '';
    const task = input.taskId ? await rt.deps.tasks.byId(asTaskId(input.taskId)) : null;
    if (!model) {
      if (!task) return fail(c, notFound('任务不存在'));
      const project = await rt.deps.projects.byId(task.projectId);
      if (!project) return fail(c, notFound('项目不存在'));
      const resolved = await resolveDefaultAgent(rt.deps, { project, task, explicit: { runtime: input.agentId } });
      model = resolved.effective.model;
      if (!model) {
        // 令牌打本机这类授权拒绝要盖过「没有默认模型」（与 deriveSessionUseCase 里的 authorizeWorker 同一条规则）。
        const workers = await rt.deps.gateway.status();
        const chosen = placed.value ? await rt.deps.workspaces.byId(asWorkspaceId(placed.value)) : await defaultWorkspaceFor(rt.deps, project.id);
        if (chosen) {
          const homeWorker = chosen.workerId ?? workers.find((worker) => worker.origin === 'local')?.workerId ?? null;
          if (homeWorker !== null) {
            const early = await authorizeWorker(rt.deps.access, actor, homeWorker);
            if (!early.ok) return fail(c, early.error);
          }
        }
        return fail(c, invalid('没有可解析的默认模型：先在任务或项目里设置默认 Agent，或显式传 model'));
      }
    }
    const allowed = await rt.providers?.checkModel(actor, model, input.taskId);
    if (allowed && !allowed.ok) return fail(c, allowed.error);
    // 会话声明 requires 时先引导：项目未配置则按能力自动启用配套内置资产；没有就绪机器且没在装，
    // 挑一台能装的发安装任务（尽力而为，不拦派生；派生因缺能力失败时把安装任务写进报错）。
    const bootstrap = await bootstrapCapabilitiesForSession(rt.assetReview, rt.components, actor, {
      projectId: task?.projectId ?? null,
      requires: input.requires
    });
    const result = await deriveSessionUseCase(rt.deps, {
      ...withoutRepo(input),
      model,
      ...(placed.value ? { workspaceId: placed.value } : {}),
      actor,
      ...(allowed?.ok && allowed.value ? { hubProtocol: allowed.value } : {})
    });
    if (result.ok) {
      await recordSessionAction(rt.deps, rt.activity, c, actor, 'session.start', result.value.id, '');
      await noteProvenance(rt.deps, rt.activity, c, actor, result.value, 'api');
      await applyStartExtras(rt.deps, rt.messaging?.bus, result.value, extras, linkIds.value, actor.user.id);
    } else if (bootstrap.install) {
      const { code, message } = result.error;
      return fail(c, { code, message: `${message}；已在 ${bootstrap.install.workerId} 上开始安装组件（任务 ${bootstrap.install.jobId}）：用 capability_status 查进度，装好后重试` });
    }
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });
}

/** installSessions：注册顺序与拆分前一致（Hono 的路由匹配顺序敏感）。 */
export function installSessions(app: OpenAPIHono<Env>, rt: V1Runtime): void {
  const on = openapiOn(app);
  on(routes.forkSession, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'session.create')) return fail(c, forbidden('令牌没有 sessions:write'));
    const input = valid<z.output<typeof forkSessionRequest>>(c, 'json');
    const result = await forkSessionUseCase(rt.deps, { ...input, actor });
    if (result.ok) {
      await recordSessionAction(rt.deps, rt.activity, c, actor, 'session.fork', result.value.id, `从 ${input.sessionId} 分叉`);
      await recordSessionAction(rt.deps, rt.activity, c, actor, 'session.fork', input.sessionId, `分叉出 ${result.value.id}`);
      await noteProvenance(rt.deps, rt.activity, c, actor, result.value, 'fork');
    }
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });
  on(routes.getSession, async (c) => {
    const id = asSessionId(c.req.param('sessionId') ?? '');
    const session = await rt.deps.sessions.byId(id);
    if (!session) return fail(c, notFound('会话不存在'));
    const query = valid<{ waitSec?: number }>(c, 'query');
    if (session.status === 'running') {
      const limited = await rt.waitUntil(c, query.waitSec, async () => (await rt.deps.sessions.byId(id))?.status !== 'running');
      if (limited) return limited;
    }
    return c.json((await rt.deps.sessions.byId(id)) ?? session);
  });
  on(routes.prompt, async (c) => {
    const actor = rt.principal(c);
    const input = valid<{ text: string; attachments?: never; clientMessageId?: string }>(c, 'json');
    const result = await promptSessionUseCase(rt.deps, {
      sessionId: c.req.param('sessionId') ?? '',
      text: input.text,
      attachments: input.attachments,
      ...(input.clientMessageId === undefined ? {} : { clientMessageId: input.clientMessageId }),
      author: { id: actor.user.id, name: actor.user.displayName, via: actor.via?.name }
    });
    return result.ok
      ? c.json({ ok: true, ...result.value }, 202)
      : fail(c, result.error);
  });
  on(routes.setSessionModel, async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const input = valid<{ model: string }>(c, 'json');
    const current = await rt.deps.sessions.byId(asSessionId(sessionId));
    if (!current) return fail(c, notFound('会话不存在'));
    // 与界面同一条路：跨提供商要停进程重起（switchSessionModel），同提供商只改选项。
    if (rt.providers?.crossesProviders(current.model, input.model) === true) {
      const teamId = (await projectOfSession(rt.deps, current))?.teamId ?? null;
      const allowed = await rt.providers.modelSwitchable(rt.principal(c), input.model, teamId);
      if (!allowed.ok) return fail(c, allowed.error);
      const switched = await switchSessionModel(rt.deps, { sessionId, model: input.model });
      if (!switched.ok) return fail(c, switched.error);
      await rt.waitOptions?.(sessionId);
      return c.json(switched.value);
    }
    if (rt.providers) {
      const allowed = rt.providers.optionAllowed(current.model, 'model', input.model);
      if (!allowed.ok) return fail(c, allowed.error);
    }
    const changed = await changeSessionOption(rt.deps, { sessionId, id: 'model', value: input.model });
    if (!changed.ok) return fail(c, changed.error);
    await rt.waitOptions?.(sessionId);
    return c.json((await rt.deps.sessions.byId(asSessionId(sessionId))) ?? changed.value);
  });
  on(routes.interrupt, async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const result = await interruptSessionUseCase(rt.deps, sessionId);
    if (result.ok) await recordSessionAction(rt.deps, rt.activity, c, rt.principal(c), 'session.interrupt', sessionId, '');
    return result.ok ? c.json({ ok: true }) : fail(c, result.error);
  });
  on(routes.changeOption, async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const input = valid<{ optionId: string; value: string }>(c, 'json');
    const current = await rt.deps.sessions.byId(asSessionId(sessionId));
    if (
      current !== null &&
      input.optionId === 'model' &&
      rt.providers?.crossesProviders(current.model, input.value) === true
    ) {
      const teamId = (await projectOfSession(rt.deps, current))?.teamId ?? null;
      const allowed = await rt.providers.modelSwitchable(rt.principal(c), input.value, teamId);
      if (!allowed.ok) return fail(c, allowed.error);
      const switched = await switchSessionModel(rt.deps, { sessionId, model: input.value });
      if (!switched.ok) return fail(c, switched.error);
      await rt.waitOptions?.(sessionId);
      return c.json(switched.value);
    }
    if (rt.providers) {
      const allowed = rt.providers.optionAllowed(current?.model ?? '', input.optionId, input.value);
      if (!allowed.ok) return fail(c, allowed.error);
    }
    const changed = await changeSessionOption(rt.deps, { sessionId, id: input.optionId, value: input.value });
    if (!changed.ok) return fail(c, changed.error);
    await rt.waitOptions?.(sessionId);
    return c.json((await rt.deps.sessions.byId(asSessionId(sessionId))) ?? changed.value);
  });
  const keepEvents = (entries: Awaited<ReturnType<typeof rt.deps.sessions.eventsAfter>>, sinceTurn: number | undefined) =>
    sinceTurn === undefined ? entries : entries.filter((entry) => entry.turn !== undefined && entry.turn >= sinceTurn);
  on(routes.events, async (c) => {
    const actor = rt.principal(c);
    const sessionId = asSessionId(c.req.param('sessionId') ?? '');
    const target = await rt.deps.sessions.byId(sessionId);
    if (!target) return fail(c, notFound('会话不存在'));
    // #243：容器会话没有任务，按不可变来源项目判 session.read。
    const project = await projectOfSessionOrigin(rt.deps, target);
    const allowed = await authorizeProject(rt.deps.access, actor, project, 'session.read');
    if (!allowed.ok) return fail(c, allowed.error);
    const query = valid<{ after?: number; sinceTurn?: number; waitSec?: number }>(c, 'query');
    const after = query.after ?? 0;
    let scanned = await rt.deps.sessions.eventsAfter(sessionId, after);
    let entries = keepEvents(scanned, query.sinceTurn);
    // 长轮询等「可投影」的事件：prompt/thinking 等不会被投影的条目不能结束等待，也不能把 nextAfter 卡住。
    if (!entries.some(isProjectableEntry) && query.waitSec) {
      const limited = await rt.waitUntil(c, query.waitSec, async () => {
        scanned = await rt.deps.sessions.eventsAfter(sessionId, after);
        return keepEvents(scanned, query.sinceTurn).some(isProjectableEntry);
      });
      if (limited) return limited;
      // LOW5：客户端已断开就不再打库收尾——连接都关了，这次扫描没人读。
      if (!c.req.raw.signal.aborted) {
        scanned = await rt.deps.sessions.eventsAfter(sessionId, after);
        entries = keepEvents(scanned, query.sinceTurn);
      }
    }
    const kept = await refreshAuthors(rt.activity, entries);
    const payload = projectEvents(kept, after, lastJournalSeq(scanned, after));
    return c.json(payload);
  });
}

/** installSessionsLive：注册顺序与拆分前一致（Hono 的路由匹配顺序敏感）。 */
export function installSessionsLive(app: OpenAPIHono<Env>, rt: V1Runtime): void {
  const on = openapiOn(app);
  on(routes.activity, async (c) => {
    const actor = rt.principal(c);
    const sessionId = asSessionId(c.req.param('sessionId') ?? '');
    const session = await rt.deps.sessions.byId(sessionId);
    if (!session) return fail(c, notFound('会话不存在'));
    if (rt.deps.access) {
      const allowed = await authorizeSession(rt.deps.access, actor, await projectOfSessionOrigin(rt.deps, session), session, 'session.read');
      if (!allowed.ok) return fail(c, allowed.error);
    }
    return c.json(rt.activity ? await sessionActivity(rt.activity, sessionId) : []);
  });
  on(routes.stream, async (c) => {
    const actor = rt.principal(c);
    const sessionId = asSessionId(c.req.param('sessionId') ?? '');
    if (!(await rt.deps.sessions.byId(sessionId))) return fail(c, notFound('会话不存在'));
    const key = actor.via!.tokenId;
    const open = rt.openStreams.get(key) ?? 0;
    if (open >= rt.maxStreams) return rt.tooMany(c, 5, `每个令牌最多同时开 ${rt.maxStreams} 条事件流`);
    rt.openStreams.set(key, open + 1);
    const fromHeader = Number(c.req.header('last-event-id') ?? NaN);
    const after = Number.isFinite(fromHeader) ? fromHeader : (valid<{ after?: number }>(c, 'query').after ?? 0);
    return streamSSE(
      c,
      async (stream) => {
        // 先订阅再补发，补发完再放出缓冲里更新的：不漏也不重。
        let sent = after;
        let replaying = true;
        const buffered: JournalEntry[] = [];
        const send = async (entry: JournalEntry) => {
          if (entry.seq <= sent) return;
          sent = entry.seq;
          await stream.writeSSE({ event: 'event', id: String(entry.seq), data: JSON.stringify(entry) });
        };
        const unsubscribe = rt.hub.subscribe((frame) => {
          if (frame.sessionId !== sessionId) return;
          if (frame.event === null) {
            void stream.writeSSE({ event: 'status', data: JSON.stringify({ status: frame.status }) });
            return;
          }
          const entry: JournalEntry = { seq: frame.seq, event: frame.event, at: rt.now() } as JournalEntry;
          if (replaying) buffered.push(entry);
          else void send(entry);
        });
        const ping = setInterval(() => void stream.write(': ping\n\n'), 15_000);
        try {
          for (const entry of await refreshAuthors(rt.activity, await rt.deps.sessions.eventsAfter(sessionId, after))) await send(entry);
          replaying = false;
          for (const entry of buffered.splice(0)) await send(entry);
          await new Promise<void>((resolve) => {
            if (c.req.raw.signal.aborted) resolve();
            c.req.raw.signal.addEventListener('abort', () => resolve());
            stream.onAbort(() => resolve());
          });
        } finally {
          clearInterval(ping);
          unsubscribe();
          rt.openStreams.set(key, Math.max(0, (rt.openStreams.get(key) ?? 1) - 1));
        }
      },
      async () => undefined
    );
  });
}
