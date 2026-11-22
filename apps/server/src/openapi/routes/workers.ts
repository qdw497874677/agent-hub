// workers 能力段的路由定义（从 routes.ts 原样搬出；顺序即注册顺序）。
import { z } from '@hono/zod-openapi';
import {
  publicWorkerInfoSchema
} from '@agent-hub/contract';
import { V1, json, body, route } from './base.ts';
import {
  capabilityStatusItem,
  workerIdParam
} from './schemas.ts';

export const workers = {
  listWorkers: route('workers:read', {
    method: 'get', path: `${V1}/workers`, tags: ['workers'], summary: '能用的机器',
    description:
      '列出令牌能看见的机器。agentModels 里会把调用方能用的 hub 托管模型（hub-<slug>/<modelId>）放在每台 agent 清单前面，再跟机器本地模型。\n' +
      '更完整的模型目录（含提供商 / 路由信息）用 list_models。\n' +
      '错误：401 令牌无效；403 没有 workers:read。',
    responses: { 200: json(z.array(publicWorkerInfoSchema)) }
  }, { module: 'workers', need: 'worker.read', expose: 'list_workers' }),
  listModels: route('workers:read', {
    method: 'get', path: `${V1}/models`, tags: ['workers'], summary: '开会话能用的模型',
    description:
      '列出这条令牌开会话或 session_model 能选的模型：先是调用方可见且可用的 hub 托管模型（id 为 hub-<slug>/<modelId>，带提供商与路由），再是各可见机器上报的本地模型。\n' +
      '参数：workerId?、agentId?（可选，只看某一台机器 / 某一个 agent 能用的；hub 模型仍按该 agent 申报的协议过滤）。\n' +
      '权限：workers:read。看不到或没有密钥的提供商不会出现。本机 Worker 上的模型仍会列出，但开放 API 不能在 origin=local 的机器上开会话。\n' +
      '下一步：要知道「不显式点名模型时会用哪个」，用 resolve_default_agent（按项目/任务/团队默认解析），不要假设 list_models 的第一项就是默认。\n' +
      '错误：401 令牌无效；403 没有 workers:read。',
    request: { query: z.object({ workerId: z.string().min(1).optional(), agentId: z.string().min(1).optional() }) },
    responses: {
      200: json(z.object({
        models: z.array(z.object({
          id: z.string(),
          source: z.enum(['hub', 'worker']),
          provider: z.object({
            id: z.string(),
            slug: z.string(),
            name: z.string(),
            routing: z.string(),
            scope: z.string(),
            protocol: z.string(),
            enabled: z.boolean()
          }).optional(),
          workerId: z.string().optional(),
          workerLabel: z.string().optional(),
          agentId: z.string().optional()
        }))
      }))
    }
  }, { module: 'workers', need: 'worker.read', expose: 'list_models' }),
  workerBrowserStatus: route('workers:read', {
    method: 'get', path: `${V1}/workers/browser-status`, tags: ['workers'], summary: '各机器的 browser:chromium 就绪状态（capability_status 的别名）',
    description:
      'capability_status 在 capability=browser:chromium 上的薄别名。逐台机器看 ready / installing / blocker、已选定的 acquisition（strategy / type / path），以及最近一次安装任务 installJob。\n' +
      'Chromium 的获取策略写在组件目录里（不必 root）：系统 Chrome/Chromium → 用户缓存 Playwright Chromium → chrome-headless-shell；都失败才提示要 root 跑 npx playwright install-deps chromium。\n' +
      '权限：workers:read（可见性同 list_workers）。\n' +
      '下一步：没有就绪机器且也没在装，用 component_install 或 install_builtin_browser 发安装任务；会话 requires 该能力时也会自动挑能装的机器装。\n' +
      '错误：401 令牌无效；403 无 workers:read。',
    responses: { 200: json(z.array(capabilityStatusItem)) }
  }, { module: 'workers', need: 'worker.read', expose: 'worker_component_status' }),
  capabilityStatus: route('workers:read', {
    method: 'get', path: `${V1}/workers/capability-status`, tags: ['workers'], summary: '各机器某项能力的就绪状态',
    description:
      '逐台机器看某个能力（query.capability，默认 browser:chromium）是否就绪：ready / installing / blocker、已选定的 acquisition（strategy / type / path），以及最近一次相关安装任务。\n' +
      '权限：workers:read（可见性同 list_workers）。可选 query.workerId 只看一台。\n' +
      '下一步：没有就绪机器且也没在装，用 component_install 发安装任务；会话 requires 该能力时也会自动挑能装的机器装。\n' +
      '错误：401 令牌无效；403 无 workers:read。',
    request: { query: z.object({ capability: z.string().min(1).max(128).optional(), workerId: z.string().min(1).optional() }) },
    responses: { 200: json(z.array(capabilityStatusItem)) }
  }, { module: 'workers', need: 'worker.read', expose: 'capability_status' }),
  installBuiltinBrowser: route('workers:read', {
    method: 'post', path: `${V1}/workers/{workerId}/builtin-browser`, tags: ['workers'], summary: '给机器安装内置浏览器（component_install 的别名）',
    description:
      'component_install({ capability: "browser:chromium" }) 的薄别名。在一台在线 Worker 上发起安装任务（走内置组件目录：目录里没有时由集群管理员提交并批准，再按目录声明的获取策略选定可执行文件）。返回 202 和任务。\n' +
      '权限：集群管理员账号（界面），或「集群管理员 / 这台机器的登记人」的个人令牌；本机（origin=local）永远不让开放 API 碰。\n' +
      '返回：202 { job }（jobId、state、message…）。\n' +
      '下一步：用 capability_status 或 worker_component_status 查进度和 acquisition；装好后会话 requires browser:chromium 就能用。\n' +
      '错误：401 令牌无效；403 权限不够（点名谁能装）；404 机器不存在；409 组件目录待双人审核 / 哈希不符；501 这个 hub 没开组件安装。',
    request: { params: workerIdParam },
    responses: { 202: json(z.object({ jobId: z.string(), agentId: z.string(), action: z.string(), state: z.string(), message: z.string() })) }
  }, { module: 'workers', need: 'worker.read', readOnly: false, expose: 'install_builtin_browser', idempotent: true }),
  installWorkerComponent: route('workers:read', {
    method: 'post', path: `${V1}/workers/{workerId}/components`, tags: ['workers'], summary: '给机器安装组件（按 componentId 或 capability）',
    description:
      '在一台在线 Worker 上发起组件安装任务。body 给 componentId（可选 version）或 capability（解析到提供该能力的内置/目录组件）。目录里没有时由集群管理员提交并批准；登记人令牌只能装已批准的。返回 202 和任务。\n' +
      '获取策略由目录项声明，Worker 只执行泛型策略（探测系统二进制、用户空间安装、轻量退路、要 root 的失败说明）。\n' +
      '权限：集群管理员账号（界面），或「集群管理员 / 这台机器的登记人」的个人令牌；本机（origin=local）永远不让开放 API 碰。\n' +
      '返回：202 { job }（jobId、state、message…）。\n' +
      '下一步：用 capability_status 查进度和 acquisition。\n' +
      '错误：401 令牌无效；400 未指定 componentId 或 capability；403 权限不够；404 机器或组件不存在；409 待双人审核 / 哈希不符 / 已是这个版本；501 这个 hub 没开组件安装。',
    request: {
      params: workerIdParam,
      ...body(z.object({
        componentId: z.string().min(1).max(64).optional(),
        version: z.string().min(1).max(64).optional(),
        capability: z.string().min(1).max(128).optional()
      }))
    },
    responses: { 202: json(z.object({ jobId: z.string(), agentId: z.string(), action: z.string(), state: z.string(), message: z.string() })) }
  }, { module: 'workers', need: 'worker.read', readOnly: false, expose: 'component_install', idempotent: true }),
} as const;
