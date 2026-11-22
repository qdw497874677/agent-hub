// projects 能力段的路由定义（从 routes.ts 原样搬出；顺序即注册顺序）。
import { z } from '@hono/zod-openapi';
import {
  createProjectRequest,
  deleteProjectRequest,
  projectSchema,
  setProjectDescriptionRequest,
  updateProjectRequest,
  setProjectRepoRequest,
  setProjectReposRequest,
  setAgentDefaultsRequest,
  resolvedDefaultAgentSchema,
  teamAgentDefaultsSchema,
  workspaceChangesSchema
} from '@agent-hub/contract';
import { V1, json, body, errors, route } from './base.ts';
import {
  projectId
} from './schemas.ts';

export const projects = {
  listProjects: route('projects:read', {
    method: 'get', path: `${V1}/projects`, tags: ['projects'], summary: '我可见的项目',
    description:
      '列出令牌账号能看见的项目（不含回收站）。\n' +
      '参数：无。\n' +
      '返回：项目数组（id、name、description、repo/repos、previewPort…）。\n' +
      '下一步：用 list_tasks 传 projectId 看任务；用 get_session 看某条会话。\n' +
      '错误：401 令牌无效。',
    responses: { 200: json(z.array(projectSchema)) }
  }),
  createProject: route('projects:write', {
    method: 'post', path: `${V1}/projects`, tags: ['projects'], summary: '新建项目',
    description:
      '新建一个项目（代码与任务的边界）。\n' +
      '参数：name（1–80，必填）；其余都可选：rootPath（不给或空串 = 先不选目录，开始任务时再选机器和工作空间；给了则须是 hub 机器上已存在的绝对路径）、workerId、repoUrl、defaultBranch、repos、primaryRepoId、description。\n' +
      'repoUrl/defaultBranch 是单仓库老写法；repos 是多仓库清单（每项 id/name/url/defaultBranch/credential，最多 8 个），两者不能同时给。primaryRepoId 必须是 repos 里的 id。私用仓库用 credential 传令牌（不会回显），地址里不要带用户名或密码。\n' +
      '返回：项目对象（id、name、rootPath、repos）。仓库 hasToken=false 时带 tokenHint / gitTokenHint：用 project_repos 写入 credential（只写不回）再推送或开 PR。\n' +
      '下一步：用 task_create 在项目里建任务，再 session_start 派一台机器。\n' +
      '错误：401 令牌无效；403 无 projects:write；409 同名；400 目录不合法（仅在给了 rootPath 时）。',
    request: body(createProjectRequest),
    responses: { 201: json(projectSchema, '已创建') }
  }, { module: 'projects', need: 'project.create', readOnly: false, expose: 'project_create', idempotent: true }),
  getProject: route('projects:read', {
    method: 'get', path: `${V1}/projects/{projectId}`, tags: ['projects'], summary: '看一个项目',
    description:
      '按 id 看项目详情。\n' +
      '参数：projectId（路径）。\n' +
      '返回：项目对象（description、repo/repos、checks、previewPort…）。\n' +
      '下一步：用 list_tasks 看任务，或用 project_update 改说明/检查命令。\n' +
      '错误：401 令牌无效；404 项目不存在或你看不见。',
    request: { params: projectId },
    responses: { 200: json(projectSchema) }
  }),
  updateProject: route('projects:write', {
    method: 'patch', path: `${V1}/projects/{projectId}`, tags: ['projects'], summary: '改项目说明、检查命令或默认 Agent',
    description:
      '改项目的说明（description）、检查命令（checks，最多 5 条、每条 ≤300 字、不能换行；空数组=清掉）和/或默认 Agent（defaultAgent；null=清掉）。\n' +
      '默认 Agent 是 { runtime, model?, options? }：新会话没显式点名时，按 任务默认 > 项目默认 > 团队运行时默认模型 生效。\n' +
      '参数：projectId（路径）；body 至少给 description、checks 或 defaultAgent 之一。\n' +
      '返回：更新后的项目对象（含 defaultAgent）。\n' +
      '下一步：用 get_project 或 resolve_default_agent 复核；检查命令由 agent 的 run_checks 执行。\n' +
      '错误：400 参数不合法（含换行、超长、runtime 不合法）；403 无 projects:write 或不是项目管理员；404 项目不存在或你看不见。项目限定令牌只能改它范围内的项目。',
    request: { params: projectId, ...body(updateProjectRequest) },
    responses: { 200: json(projectSchema) }
  }, { module: 'projects', need: 'project.update', readOnly: false, expose: 'project_update', idempotent: true }),
  resolveDefaultAgent: route('projects:read', {
    method: 'get', path: `${V1}/defaults/resolve`, tags: ['projects'], summary: '解析新会话会用的默认 Agent',
    description:
      '算出一条新会话在不显式点名模型时会用的 runtime + 模型 + 选项。层级从低到高：团队按运行时的默认模型 < 项目 defaultAgent < 任务 defaultAgent < 本次传入的 runtime/model。\n' +
      '参数：projectId（必填）；taskId?（可选，带上任务默认）；runtime?、model?（可选，模拟显式选择）。\n' +
      '返回：effective（可能 runtime/model 为空串，表示层层都没配）、layers（项目/任务/团队原值）、sources（runtime 与 model 分别来自哪一层）。\n' +
      '权限：projects:read；项目限定令牌只能查它范围内的项目。不要求该 runtime 当前在线。\n' +
      '下一步：session_start 时省略 model（或传空串）就会用这里的 effective。\n' +
      '错误：401 令牌无效；404 项目/任务不存在或你看不见。',
    request: { query: z.object({
      projectId: z.string().min(1),
      taskId: z.string().min(1).optional(),
      runtime: z.string().max(64).optional(),
      model: z.string().max(200).optional()
    }) },
    responses: { 200: json(resolvedDefaultAgentSchema) }
  }, { module: 'projects', need: 'project.read', expose: 'resolve_default_agent' }),
  getTeamAgentDefaults: route('projects:read', {
    method: 'get', path: `${V1}/team/agent-defaults`, tags: ['projects'], summary: '读团队运行时默认模型',
    description:
      '读本团队给各运行时配的默认模型（界面：团队页 → 默认模型）。新会话没点名模型、且项目/任务默认也没给出模型时，按会话用的 runtime 来取。\n' +
      '参数：无。\n' +
      '返回：{ defaults }，key 是运行时 id（如 opencode），value 是模型名（可写 hub-<slug>/<modelId>）。空对象 = 还没配。\n' +
      '权限：团队成员均可读（要能进开放 API 的令牌）。项目限定令牌也可以读（这是团队约定，不是项目机密）。\n' +
      '下一步：要改用 team_agent_defaults_set（要团队 admin，且令牌不能只限项目）；查某次开会话会用什么，用 resolve_default_agent。\n' +
      '错误：401 令牌无效；404 账号还没有团队；503 这个 hub 还没装配默认模型。',
    responses: { 200: json(teamAgentDefaultsSchema) }
  }, { module: 'projects', need: 'project.read', expose: 'team_agent_defaults' }),
  setTeamAgentDefaults: route('projects:write', {
    method: 'put', path: `${V1}/team/agent-defaults`, tags: ['projects'], summary: '设置团队运行时默认模型',
    description:
      '设置本团队给各运行时配的默认模型。空对象 = 全部清掉。只改传入的整张表，不会和旧值合并。\n' +
      '参数：body.defaults，key 是运行时 id，value 是模型名（可写 hub-<slug>/<modelId>；空串会丢掉这一条）。最多 16 个运行时。\n' +
      '权限：账号必须是团队 owner / admin（或集群管理员），令牌要有 projects:write，且不能是只限项目的令牌。普通成员即使有 projects:write 也会 403。\n' +
      '返回：{ defaults }（归一后的表）。\n' +
      '下一步：用 resolve_default_agent 确认新会话会用它；项目/任务 defaultAgent 仍优先于团队默认。\n' +
      '错误：400 参数不合法；403 不是团队 admin 或令牌只限项目；404 账号还没有团队；503 这个 hub 还没装配默认模型。',
    request: body(setAgentDefaultsRequest),
    responses: { 200: json(teamAgentDefaultsSchema) }
  }, { module: 'projects', need: 'project.update', readOnly: false, expose: 'team_agent_defaults_set', idempotent: true }),
  setProjectRepos: route('projects:write', {
    method: 'put', path: `${V1}/projects/{projectId}/repos`, tags: ['projects'], summary: '设置项目仓库清单（可带私有仓库令牌）',
    description:
      '整体替换项目的仓库清单（最多 8 个）：空数组 = 解除全部绑定。\n' +
      '参数：projectId（路径）；repos[].url、name（可选，小写字母数字与连字符）、defaultBranch（可选，null=远端默认）；primaryRepoId（可选，指定组合会话的主仓库；不指定则不能开组合会话）。\n' +
      'credential：私有 HTTPS 仓库的令牌，只写不读——非空存进密钥箱、空串清掉、省略不动；响应里只有 hasToken，永远不回显。\n' +
      '返回：更新后的项目对象（repos[].hasToken 表明有没有令牌）。\n' +
      '下一步：用 get_project 复核；之后新建的会话/工作空间克隆与推送都会自动用这个令牌。\n' +
      '错误：400 仓库超过 8 个或字段不合法；403 无 projects:write 或不是项目管理员；404 项目不存在。',
    request: { params: projectId, ...body(setProjectReposRequest) },
    responses: { 200: json(projectSchema), ...errors }
  }, { module: 'projects', need: 'project.update', readOnly: false, expose: 'project_repos', idempotent: true }),
  setProjectRepo: route('projects:write', {
    method: 'put', path: `${V1}/projects/{projectId}/repo`, tags: ['projects'], summary: '绑定 / 解除项目仓库',
    request: { params: projectId, ...body(setProjectRepoRequest) },
    responses: { 200: json(projectSchema) }
  }, { skip: '单个仓库绑定是网页的老路径；对外用 project_repos 整体替换清单' }),
  setProjectDescription: route('projects:write', {
    method: 'put', path: `${V1}/projects/{projectId}/description`, tags: ['projects'], summary: '改项目说明',
    request: { params: projectId, ...body(setProjectDescriptionRequest) },
    responses: { 200: json(projectSchema) }
  }, { skip: '改说明用 project_update（PATCH /projects/{projectId}）；这条是网页专用' }),
  deleteProject: route('projects:write', {
    method: 'delete', path: `${V1}/projects/{projectId}`, tags: ['projects'], summary: '把项目放进回收站',
    description:
      '把项目放进回收站（磁盘目录保留，可恢复）。\n' +
      '参数：projectId（路径）、confirmName（必须等于项目名，防误删）。\n' +
      '返回：{ id, deleted: true }。\n' +
      '下一步：任务与会话不再出现在列表里；恢复要回工作台。\n' +
      '错误：400 名字对不上；403 不是团队主人或建项目的人；404 项目不存在。',
    request: { params: projectId, ...body(deleteProjectRequest) },
    responses: { 200: json(z.object({ id: z.string(), deleted: z.literal(true) })) }
  }, { module: 'projects', need: 'project.delete', readOnly: false, expose: 'project_archive' }),
  workspaceChanges: route('projects:read', {
    method: 'get', path: `${V1}/workspaces/{workspaceId}/changes`, tags: ['projects'], summary: '工作空间里未提交的改动',
    request: { params: z.object({ workspaceId: z.string().openapi({ param: { name: 'workspaceId', in: 'path' } }) }) },
    responses: { 200: json(workspaceChangesSchema) }
  }),
} as const;
