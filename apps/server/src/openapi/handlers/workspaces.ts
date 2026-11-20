// workspaces 能力的处理函数（从 app.ts 原样搬出；鉴权/限流/审计仍在 app.ts 的前导里）。
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { V1Runtime } from '../context.ts';
import { openapiOn, valid } from '../context.ts';
import type { Env } from '../context.ts';
import { homedir } from 'node:os';
import {
  asProjectId,
  authorizeProject,
  can,
  forbidden,
  notFound,
  syncWorkspaceReposUseCase,
  deleteWorkspaceUseCase,
  retryWorkspaceSetupUseCase,
  addWorkspaceGroupMemberUseCase,
  buildWorkspaceGroupUseCase,
  retryWorkspaceGroupUseCase,
  sweepProjectUseCase,
  cleanupRecordsUseCase,
  asWorkspaceGroupId,
  prepareTemporaryWorkspaceUseCase,
  prepareLongLivedWorkspaceUseCase
} from '@agent-hub/domain';
import {
  workspaceSchema
} from '@agent-hub/contract';
import { fail } from '../../http-error.ts';
import {
  routes
} from '.././routes.ts';

/** installWorkspaces：注册顺序与拆分前一致（Hono 的路由匹配顺序敏感）。 */
export function installWorkspaces(app: OpenAPIHono<Env>, rt: V1Runtime): void {
  const on = openapiOn(app);
  on(routes.syncWorkspace, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const result = await syncWorkspaceReposUseCase(rt.deps, { workspaceId: c.req.param('workspaceId') ?? '', actor });
    if (!result.ok) return fail(c, result.error);
    return c.json({
      workspace: workspaceSchema.parse(result.value.workspace),
      added: result.value.added,
      present: result.value.present,
      skipped: result.value.skipped,
      failed: result.value.failed
    });
  });
  on(routes.createWorkspace, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const projectId = c.req.param('projectId') ?? '';
    const project = await rt.deps.projects.byId(asProjectId(projectId));
    if (!project) return fail(c, notFound('项目不存在'));
    const allowed = await authorizeProject(rt.deps.access, actor, project, 'project.update');
    if (!allowed.ok) return fail(c, allowed.error);
    const input = valid<{ kind: 'long_lived' | 'temporary'; mode?: string; taskId?: string; workerId?: string | null; path?: string }>(c, 'json');
    const result =
      input.kind === 'temporary'
        ? await prepareTemporaryWorkspaceUseCase(rt.deps, {
            projectId,
            taskId: input.taskId ?? '',
            workerId: input.workerId ?? null,
            home: homedir(),
            mode: input.mode === 'shared' ? 'shared' : 'isolated',
            actor
          })
        : await prepareLongLivedWorkspaceUseCase(rt.deps, {
            projectId,
            workerId: input.workerId ?? null,
            plan: input.mode === 'link' ? { mode: 'link', path: input.path ?? '' } : { mode: 'create' },
            home: homedir(),
            actor
          });
    if (!result.ok) return fail(c, result.error);
    return c.json(workspaceSchema.parse(result.value), 201);
  });
  on(routes.removeWorkspace, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const input = valid<{ deleteDirectory?: boolean; force?: boolean }>(c, 'json');
    const workspaceId = c.req.param('workspaceId') ?? '';
    const result = await deleteWorkspaceUseCase(rt.deps, {
      workspaceId,
      deleteDirectory: input.deleteDirectory === true,
      force: input.force === true,
      actor
    });
    if (!result.ok) return fail(c, result.error);
    return c.json(workspaceSchema.parse(result.value));
  });
  on(routes.retryWorkspaceSetup, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const workspaceId = c.req.param('workspaceId') ?? '';
    const result = await retryWorkspaceSetupUseCase(rt.deps, { workspaceId, actor });
    if (!result.ok) return fail(c, result.error);
    return c.json(workspaceSchema.parse(result.value));
  });
  on(routes.workspaceGroupCreate, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const projectId = c.req.param('projectId') ?? '';
    const project = await rt.deps.projects.byId(asProjectId(projectId));
    if (!project) return fail(c, notFound('项目不存在'));
    const allowed = await authorizeProject(rt.deps.access, actor, project, 'project.update');
    if (!allowed.ok) return fail(c, allowed.error);
    const input = valid<{
      taskId: string;
      workerId?: string;
      repoIds?: string[];
      fromGroupId?: string;
      branches?: { repoId: string; branch: string }[];
      sessionId?: string;
    }>(c, 'json');
    const result = await buildWorkspaceGroupUseCase(rt.deps, {
      projectId,
      taskId: input.taskId,
      workerId: input.workerId ?? null,
      home: homedir(),
      actor,
      repoIds: input.repoIds,
      fromGroupId: input.fromGroupId,
      branches: input.branches,
      sessionId: input.sessionId
    });
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });
  on(routes.workspaceGroupGet, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'project.read')) return fail(c, forbidden('令牌没有 projects:read'));
    const group = await rt.deps.workspaceGroups?.byId(asWorkspaceGroupId(c.req.param('groupId') ?? ''));
    if (!group) return fail(c, notFound('组合工作空间不存在'));
    const project = await rt.deps.projects.byId(asProjectId(group.projectId));
    const allowed = await authorizeProject(rt.deps.access, actor, project, 'project.read');
    if (!allowed.ok) return fail(c, allowed.error);
    return c.json(group);
  });
  on(routes.workspaceGroupAddMember, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const groupId = c.req.param('groupId') ?? '';
    const group = await rt.deps.workspaceGroups?.byId(asWorkspaceGroupId(groupId));
    if (!group) return fail(c, notFound('组合工作空间不存在'));
    const project = await rt.deps.projects.byId(asProjectId(group.projectId));
    const allowed = await authorizeProject(rt.deps.access, actor, project, 'project.update');
    if (!allowed.ok) return fail(c, allowed.error);
    const input = valid<{ repoId: string }>(c, 'json');
    const result = await addWorkspaceGroupMemberUseCase(rt.deps, { groupId, repoId: input.repoId, home: homedir(), actor });
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });
  on(routes.workspaceGroupRetry, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const groupId = c.req.param('groupId') ?? '';
    const group = await rt.deps.workspaceGroups?.byId(asWorkspaceGroupId(groupId));
    if (!group) return fail(c, notFound('组合工作空间不存在'));
    const project = await rt.deps.projects.byId(asProjectId(group.projectId));
    const allowed = await authorizeProject(rt.deps.access, actor, project, 'project.update');
    if (!allowed.ok) return fail(c, allowed.error);
    const result = await retryWorkspaceGroupUseCase(rt.deps, { groupId, home: homedir(), actor });
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
}

/** installWorkspacesSweep：注册顺序与拆分前一致（Hono 的路由匹配顺序敏感）。 */
export function installWorkspacesSweep(app: OpenAPIHono<Env>, rt: V1Runtime): void {
  const on = openapiOn(app);
  on(routes.workspaceSweep, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const projectId = c.req.param('projectId') ?? '';
    const result = await sweepProjectUseCase(rt.deps, actor, projectId);
    if (!result.ok) return fail(c, result.error);
    const records = await cleanupRecordsUseCase(rt.deps, actor, projectId);
    const items = records.ok ? records.value.items.filter((item) => !result.value.runId || item.runId === result.value.runId) : [];
    return c.json({ ...result.value, items });
  });
  on(routes.workspaceSweepRecords, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'project.read')) return fail(c, forbidden('令牌没有 projects:read'));
    const result = await cleanupRecordsUseCase(rt.deps, actor, c.req.param('projectId') ?? '');
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
}
