// workspaces 能力段的路由定义（从 routes.ts 原样搬出；顺序即注册顺序）。
import {
  createWorkspaceRequest,
  removeWorkspaceRequest,
  syncWorkspaceResultSchema,
  workspaceSchema
} from '@agent-hub/contract';
import { V1, json, body, route } from './base.ts';
import {
  projectId,
  workspaceId,
  groupId,
  createWorkspaceGroupRequest,
  addWorkspaceGroupMemberRequest,
  workspaceGroupSchema,
  sweepReportSchema,
  cleanupRecordsSchema
} from './schemas.ts';

export const workspaces = {
  syncWorkspace: route(
    'projects:write',
    {
      method: 'post', path: `${V1}/workspaces/{workspaceId}/sync`, tags: ['workspaces'], summary: '检查单仓工作空间的远端是否匹配项目',
      description:
        '只检查已登记的工作空间目录，不扫描同级目录，不克隆或拉取。项目绑定多个仓库时请新建组合工作空间。\n' +
        '参数：workspaceId。\n' +
        '返回：workspace（原登记）、present（当前目录的远端匹配）、skipped（不匹配，带原因）；兼容字段 added、failed 保持为空。\n' +
        '限制：只处理单目录工作空间；组合工作空间（groupId 非空）成员由建组 / workspace_retry_setup 管理。\n' +
        '查看工作区改动请用 workspace_changes。\n' +
        '错误：404 / 403 项目没有 project.update / 400 非 Git 工作空间、组合工作空间或多仓项目。',
      request: { params: workspaceId },
      responses: { 200: json(syncWorkspaceResultSchema) }
    },
    { module: 'workspaces', need: 'project.update', readOnly: false, idempotent: true }
  ),
  createWorkspace: route(
    'projects:write',
    {
      method: 'post', path: `${V1}/projects/{projectId}/workspaces`, tags: ['workspaces'], summary: '新建临时或长期工作空间',
      description:
        '为项目建一个工作目录：temporary 要 taskId（mode=isolated 新开 worktree，默认 isolated；mode=shared 复用长期目录；mode=empty 新建空临时目录，不准备仓库）；long_lived 要 mode=create|empty|link（create 沿用项目仓库配置；empty 不下载仓库；link 登记已有目录，须给 path）。\n' +
        '参数：projectId；body 见 createWorkspaceRequest。\n' +
        '返回：workspace。\n' +
        '下一步：开会话时把 workspaceId 传回去；非 git 项目只能建普通目录。\n' +
        '错误：400 参数不对 / 403 权限不够 / 404 项目或任务不存在 / 409 机器上已有同名目录。',
      request: { params: projectId, ...body(createWorkspaceRequest) },
      responses: { 201: json(workspaceSchema, '已创建') }
    },
    { module: 'workspaces', need: 'project.update', readOnly: false }
  ),
  removeWorkspace: route(
    'projects:write',
    {
      method: 'post', path: `${V1}/workspaces/{workspaceId}/remove`, tags: ['workspaces'], summary: '移除工作空间（可连目录一起删）',
      description:
        '移除登记；deleteDirectory=true 时连目录一起删（平台建的才行），force=true 跳过未提交改动保护。\n' +
        '参数：workspaceId；body `{deleteDirectory?: boolean, force?: boolean}`。\n' +
        '返回：workspace（state=removed）。\n' +
        '错误：400 目录有未提交改动又不 force / 403 / 404。',
      request: { params: workspaceId, ...body(removeWorkspaceRequest) },
      responses: { 200: json(workspaceSchema) }
    },
    { module: 'workspaces', need: 'project.update', readOnly: false, idempotent: true }
  ),
  retryWorkspaceSetup: route(
    'projects:write',
    {
      method: 'post', path: `${V1}/workspaces/{workspaceId}/setup/retry`, tags: ['workspaces'], summary: '重跑准备命令',
      description:
        '只对平台为任务建的临时工作空间、且 setup.state=failed 时有效；项目没配准备命令则 409。\n' +
        '需要所属项目的 project.update，以及工作空间所在机器的 worker.use。\n' +
        '参数：workspaceId。\n' +
        '返回：workspace（setup 里是新的状态与输出）。\n' +
        '错误：403 / 404 / 409 不是平台建的临时空间、不需要重试或没配命令。',
      request: { params: workspaceId },
      responses: { 200: json(workspaceSchema) }
    },
    { module: 'workspaces', need: 'project.update', readOnly: false, idempotent: true }
  ),
  workspaceGroupCreate: route(
    'projects:write',
    {
      method: 'post', path: `${V1}/projects/{projectId}/workspace-groups`, tags: ['workspaces'], summary: '新建组合工作空间',
      description:
        '为多仓项目建一个组合组：必须先指定主仓库。cwd 是主仓库 `<groupRoot>/<primary>/`，附加仓在 `../repos/<name>/`。可只选子集（主仓库一定在内）。\n' +
        '参数：projectId；body.taskId、workerId（MCP 必须给已登记的远程机器，本机不可用）、repoIds?（子集）、fromGroupId? / branches?（在目标机器上按已有分支再建一组，用于验证交接）、sessionId?。\n' +
        '返回：组（id、root、members[].workspaceId/name/state、primaryRepoId）。准备命令只在主仓库跑。\n' +
        '下一步：session_start 时把 groupId 传回去；用 workspace_group_add_member 追加仓库。\n' +
        '错误：400 没指定主仓库或参数不合法 / 403 无 projects:write 或本机不可用 / 404 / 409 机器不支持组合工作空间。',
      request: { params: projectId, ...body(createWorkspaceGroupRequest) },
      responses: { 201: json(workspaceGroupSchema, '已创建') }
    },
    { module: 'workspaces', need: 'project.update', readOnly: false, expose: 'workspace_group_create', idempotent: true }
  ),
  workspaceGroupGet: route('projects:read', {
    method: 'get', path: `${V1}/workspace-groups/{groupId}`, tags: ['workspaces'], summary: '看一个组合工作空间',
    description: '返回组的成员、路径、状态和错误。参数：groupId。错误：404 / 403。',
    request: { params: groupId },
    responses: { 200: json(workspaceGroupSchema) }
  }),
  workspaceGroupAddMember: route(
    'projects:write',
    {
      method: 'post', path: `${V1}/workspace-groups/{groupId}/members`, tags: ['workspaces'], summary: '往组合组追加一个仓库',
      description:
        '在已有组合组里添加一个项目仓库（附加仓路径 `../repos/<name>`）。下一轮 session_reply 会注入更新后的成员清单，不必重启会话。\n' +
        '参数：groupId；body.repoId。\n' +
        '错误：400 仓库已在组里或不属于该项目 / 403 / 404 / 409。',
      request: { params: groupId, ...body(addWorkspaceGroupMemberRequest) },
      responses: { 201: json(workspaceGroupSchema) }
    },
    { module: 'workspaces', need: 'project.update', readOnly: false, expose: 'workspace_group_add_member', idempotent: true }
  ),
  workspaceGroupRetry: route(
    'projects:write',
    {
      method: 'post', path: `${V1}/workspace-groups/{groupId}/retry`, tags: ['workspaces'], summary: '重试失败的组合组成员',
      description: '只重试 state=failed 的成员，已就绪的不动。参数：groupId。返回更新后的组。错误：403 / 404 / 409 组已经准备好了。',
      request: { params: groupId },
      responses: { 200: json(workspaceGroupSchema) }
    },
    { module: 'workspaces', need: 'project.update', readOnly: false, expose: 'workspace_group_retry', idempotent: true }
  ),
} as const;

export const workspacesCleanup = {
  workspaceSweep: route(
    'projects:write',
    {
      method: 'post', path: `${V1}/projects/{projectId}/cleanup/sweep`, tags: ['workspaces'], summary: '按项目规则清理临时工作空间',
      description:
        '按项目规则跑一轮清理。组合组原子处理。脏工作区整组留下，items[].reason / action=kept 写明原因。\n' +
        '若刚刚 session_settle 已经拆掉了干净的临时 worktree，这一轮可能是空的：返回 message（以及 alreadyRemoved）说明原因，不要当成失败。\n' +
        '参数：projectId。返回：removed/kept/skipped/failed、runId、items、message?、alreadyRemoved?。\n' +
        '下一步：用 workspace_sweep_records 核对记录和孤儿目录。错误：403 无 projects:write / 404。',
      request: { params: projectId },
      responses: { 200: json(sweepReportSchema) }
    },
    { module: 'workspaces', need: 'project.update', readOnly: false, expose: 'workspace_sweep', idempotent: true }
  ),
  workspaceSweepRecords: route('projects:read', {
    method: 'get', path: `${V1}/projects/{projectId}/cleanup/records`, tags: ['workspaces'], summary: '查看项目的清理记录',
    description:
      '返回最近的清理记录（含 kept 原因）以及登记对不上的孤儿目录。参数：projectId。错误：403 / 404。',
    request: { params: projectId },
    responses: { 200: json(cleanupRecordsSchema) }
  }, { module: 'workspaces', need: 'project.read', expose: 'workspace_sweep_records' }),
} as const;
