// projects 能力的处理函数（从 app.ts 原样搬出；鉴权/限流/审计仍在 app.ts 的前导里）。
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { V1Runtime } from '../context.ts';
import { openapiOn, valid } from '../context.ts';
import type { Env } from '../context.ts';
import {
  asProjectId,
  asTaskId,
  asWorkspaceId,
  authorizeProject,
  authorizeWorkspace,
  can,
  createProjectUseCase,
  deleteProjectUseCase,
  forbidden,
  listProjects,
  notFound,
  projectReader,
  setProjectChecksUseCase,
  setProjectDescriptionUseCase,
  setProjectDefaultAgentUseCase,
  resolveDefaultAgent,
  viewAgentDefaults,
  setAgentDefaults,
  updateProjectReposUseCase,
  setProjectRepoUseCase,
  unavailable,
  workspaceChangesUseCase
} from '@agent-hub/domain';
import type { z } from 'zod';
import type {
  createProjectRequest,
  setProjectDescriptionRequest,
  setProjectRepoRequest,
  setProjectReposRequest
} from '@agent-hub/contract';
import { fail } from '../../http-error.ts';
import {
  routes
} from '.././routes.ts';
import { projectDto } from '../../project-dto.ts';

/** installProjects：注册顺序与拆分前一致（Hono 的路由匹配顺序敏感）。 */
export function installProjects(app: OpenAPIHono<Env>, rt: V1Runtime): void {
  const on = openapiOn(app);
  on(routes.listProjects, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'project.read')) return fail(c, forbidden('令牌没有 projects:read'));
    const result = await listProjects(rt.deps);
    const readable = await projectReader(rt.deps.access, actor);
    // 同一套投影：仓库只给 hasToken，令牌名 / 明文不出 server
    return result.ok ? c.json(result.value.filter(readable).map(projectDto)) : fail(c, result.error);
  });
  on(routes.getProject, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'project.read')) return fail(c, forbidden('令牌没有 projects:read'));
    const project = await rt.deps.projects.byId(asProjectId(c.req.param('projectId') ?? ''));
    if (!project) return fail(c, notFound('项目不存在'));
    const readable = await projectReader(rt.deps.access, actor);
    if (!readable(project)) return fail(c, notFound('项目不存在'));
    return c.json(projectDto(project));
  });
  on(routes.createProject, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'project.create')) return fail(c, forbidden('令牌不能新建项目（要 projects:write，且账号有建项目的权限）'));
    const result = await createProjectUseCase(rt.deps, { ...valid<z.output<typeof createProjectRequest>>(c, 'json'), actor });
    return result.ok ? c.json(projectDto(result.value), 201) : fail(c, result.error);
  });
  on(routes.updateProject, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const project = await rt.deps.projects.byId(asProjectId(c.req.param('projectId') ?? ''));
    if (!project) return fail(c, notFound('项目不存在'));
    const readable = await projectReader(rt.deps.access, actor);
    if (!readable(project)) return fail(c, notFound('项目不存在'));
    const input = valid<{ description?: string | null; checks?: string[]; defaultAgent?: unknown }>(c, 'json');
    let next = project;
    if (input.description !== undefined) {
      const result = await setProjectDescriptionUseCase(rt.deps, { projectId: next.id, description: input.description });
      if (!result.ok) return fail(c, result.error);
      next = result.value;
    }
    if (input.checks !== undefined) {
      const result = await setProjectChecksUseCase(rt.deps, { projectId: next.id, checks: input.checks });
      if (!result.ok) return fail(c, result.error);
      next = result.value;
    }
    if (input.defaultAgent !== undefined) {
      const result = await setProjectDefaultAgentUseCase(rt.deps, { projectId: next.id, defaultAgent: input.defaultAgent });
      if (!result.ok) return fail(c, result.error);
      next = result.value;
      await rt.auditDefaultAgent(actor, next.id, next.defaultAgent ?? null);
    }
    return c.json(projectDto(next));
  });
  on(routes.resolveDefaultAgent, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'project.read')) return fail(c, forbidden('令牌没有 projects:read'));
    const query = valid<{ projectId: string; taskId?: string; runtime?: string; model?: string }>(c, 'query');
    const project = await rt.deps.projects.byId(asProjectId(query.projectId));
    if (!project) return fail(c, notFound('项目不存在'));
    const readable = await projectReader(rt.deps.access, actor);
    if (!readable(project)) return fail(c, notFound('项目不存在'));
    let task = null;
    if (query.taskId) {
      task = await rt.deps.tasks.byId(asTaskId(query.taskId));
      if (!task || task.projectId !== project.id) return fail(c, notFound('任务不存在'));
    }
    const resolved = await resolveDefaultAgent(rt.deps, {
      project,
      task,
      explicit: { runtime: query.runtime ?? '', model: query.model ?? '', options: {} }
    });
    return c.json(resolved);
  });
  on(routes.getTeamAgentDefaults, async (c) => {
    const actor = rt.principal(c);
    const wired = rt.teamDefaultsDeps();
    if (!wired) return fail(c, unavailable('这个 hub 还没装配默认模型'));
    const result = await viewAgentDefaults(wired, actor);
    return result.ok ? c.json({ defaults: result.value }) : fail(c, result.error);
  });
  on(routes.setTeamAgentDefaults, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    if (rt.projectLimited(actor)) return fail(c, forbidden('项目限定令牌不能改团队默认模型'));
    const teamId = actor.user.teamId;
    const account = { ...actor, via: undefined };
    if (!teamId || !can(account, 'team.manage', { teamId })) {
      return fail(c, forbidden('只有团队 owner / admin 能改默认模型'));
    }
    const wired = rt.teamDefaultsDeps();
    if (!wired) return fail(c, unavailable('这个 hub 还没装配默认模型'));
    const input = valid<{ defaults: Record<string, string> }>(c, 'json');
    const result = await setAgentDefaults(wired, account, { defaults: input.defaults });
    return result.ok ? c.json({ defaults: result.value }) : fail(c, result.error);
  });
  on(routes.setProjectRepos, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const projectId = c.req.param('projectId') ?? '';
    const project = await rt.deps.projects.byId(asProjectId(projectId));
    const allowed = await authorizeProject(rt.deps.access, actor, project, 'project.update');
    if (!allowed.ok) return fail(c, allowed.error);
    const input = valid<z.output<typeof setProjectReposRequest>>(c, 'json');
    const result = await updateProjectReposUseCase(rt.deps, { projectId, repos: input.repos, primaryRepoId: input.primaryRepoId });
    if (!result.ok) return fail(c, result.error);
    // 令牌名不出去：projectDto 只给 hasToken。
    return c.json(projectDto(result.value));
  });
  on(routes.setProjectRepo, async (c) => {
    const result = await setProjectRepoUseCase(rt.deps, { projectId: c.req.param('projectId') ?? '', ...valid<z.output<typeof setProjectRepoRequest>>(c, 'json') });
    return result.ok ? c.json(projectDto(result.value)) : fail(c, result.error);
  });
  on(routes.setProjectDescription, async (c) => {
    const result = await setProjectDescriptionUseCase(rt.deps, { projectId: c.req.param('projectId') ?? '', ...valid<z.output<typeof setProjectDescriptionRequest>>(c, 'json') });
    return result.ok ? c.json(projectDto(result.value)) : fail(c, result.error);
  });
  on(routes.deleteProject, async (c) => {
    if (!rt.projectDeletion) return fail(c, { code: 'not_implemented', message: '没装删除项目' });
    const actor = rt.principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const result = await deleteProjectUseCase({ ...rt.deps, ...rt.projectDeletion }, actor, {
      projectId: asProjectId(c.req.param('projectId') ?? ''),
      confirmName: valid<{ confirmName: string }>(c, 'json').confirmName
    });
    return result.ok ? c.json({ id: result.value.id, deleted: true }) : fail(c, result.error);
  });
  on(routes.workspaceChanges, async (c) => {
    const actor = rt.principal(c);
    const workspaceId = c.req.param('workspaceId') ?? '';
    if (rt.deps.access) {
      const workspace = await rt.deps.workspaces.byId(asWorkspaceId(workspaceId));
      const allowed = await authorizeWorkspace(rt.deps, actor, workspace, 'project.read');
      if (!allowed.ok) return fail(c, allowed.error);
    }
    const result = await workspaceChangesUseCase(rt.deps, workspaceId);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
}
