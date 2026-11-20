// providers 能力段的路由定义（从 routes.ts 原样搬出；顺序即注册顺序）。
import { V1, json, body, okSchema, route } from './base.ts';
import {
  providerId,
  workerIdParam,
  providerCreateRequest,
  providerUpdateRequest,
  providerKeyRequest,
  providerProbeRequest,
  providerTestRequest,
  providerConfirmRequest,
  providerRoutingRequest,
  providerViewSchema,
  providerListSchema,
  providerProbeResultSchema,
  providerImpactSchema
} from './schemas.ts';

export const providers = {
  providerList: route('providers:read', {
    method: 'get', path: `${V1}/providers`, tags: ['providers'], summary: '列出模型提供商、模型和机器路由',
    description:
      '返回当前令牌能看见的提供商（含模型、用量、是否可管理）以及机器级路由覆盖。响应和日志里永远不含 API 密钥。\n' +
      '权限：`providers:read` / `providers:use` / `providers:manage` 均可（都带 provider.read）。\n' +
      '错误：403 无 providers:read。',
    responses: { 200: json(providerListSchema) }
  }, { module: 'providers', need: 'provider.read', expose: 'provider_list' }),
  providerCreate: route(
    'providers:manage',
    {
      method: 'post', path: `${V1}/providers`, tags: ['providers'], summary: '新建模型提供商',
      description:
        '新建个人 / 团队 / 全站提供商。apiKey 只写不回；不传则 hasKey=false，稍后用 provider_set_key。\n' +
        '全站（scope=hub）和团队提供商还要账号本身是集群管理员 / 团队管理员。密钥不会出现在响应、日志或审计里。\n' +
        '参数：slug、name、protocol、baseUrl、models、routing、enabled?、scope?、apiKey?。\n' +
        '错误：400 / 403 无 providers:manage，或只限项目的令牌 / 409 标识占用。',
      request: body(providerCreateRequest),
      responses: { 201: json(providerViewSchema) }
    },
    { module: 'providers', need: 'provider.manage', readOnly: false, destructive: false, expose: 'provider_create', idempotent: true }
  ),
  providerUpdate: route(
    'providers:manage',
    {
      method: 'put', path: `${V1}/providers/{providerId}`, tags: ['providers'], summary: '更新模型提供商',
      description:
        '改名称、地址、模型、路由或启停。不能用这个接口改密钥（用 provider_set_key）。响应不含密钥。\n' +
        '参数：providerId；body 同新建（无 scope / apiKey）。错误：400 / 403 / 404 / 409。',
      request: { params: providerId, ...body(providerUpdateRequest) },
      responses: { 200: json(providerViewSchema) }
    },
    { module: 'providers', need: 'provider.manage', readOnly: false, destructive: false, expose: 'provider_update', idempotent: true }
  ),
  providerSetKey: route(
    'providers:manage',
    {
      method: 'put', path: `${V1}/providers/{providerId}/key`, tags: ['providers'], summary: '设置或轮换提供商密钥',
      description:
        '写入新的 API 密钥。密钥只写不回，审计只记「已更新」。\n' +
        '参数：providerId；body.apiKey。返回 { ok: true }。错误：400 空密钥 / 403 / 404。',
      request: { params: providerId, ...body(providerKeyRequest) },
      responses: { 200: json(okSchema) }
    },
    { module: 'providers', need: 'provider.manage', readOnly: false, destructive: false, expose: 'provider_set_key', idempotent: true }
  ),
  providerProbe: route(
    'providers:manage',
    {
      method: 'post', path: `${V1}/providers/probe`, tags: ['providers'], summary: '探测上游模型列表',
      description:
        '给 providerId 就用已存密钥（要能管理它）；否则传临时 baseUrl / apiKey（明文只用于这次探测，不会回显、不会入库，除非随后新建）。\n' +
        '指定在线 worker 时从那台机器发起；否则 hub 直连。上游 4xx/5xx 也返回 200 + ok:false。\n' +
        '参数：providerId?、protocol?、baseUrl?、apiKey?、workerId?。错误：400 / 403 / 404。',
      request: body(providerProbeRequest),
      responses: { 200: json(providerProbeResultSchema) }
    },
    { module: 'providers', need: 'provider.manage', readOnly: false, destructive: false, expose: 'provider_probe' }
  ),
  providerTest: route(
    'providers:manage',
    {
      method: 'post', path: `${V1}/providers/{providerId}/test`, tags: ['providers'], summary: '从机器测试提供商连通',
      description:
        '选一台 worker，按生效路由实测：直连是 worker→提供商，经 hub 是 worker→hub→提供商。真密钥不返回。\n' +
        '参数：providerId；body.workerId。返回 ok、message、via、models。错误：400 没选机器或没密钥 / 403 / 404。',
      request: { params: providerId, ...body(providerTestRequest) },
      responses: { 200: json(providerProbeResultSchema) }
    },
    { module: 'providers', need: 'provider.manage', readOnly: false, destructive: false, expose: 'provider_test' }
  ),
  providerDelete: route(
    'providers:manage',
    {
      method: 'delete', path: `${V1}/providers/{providerId}`, tags: ['providers'], summary: '删除模型提供商',
      description:
        '破坏性操作：不带 confirm=true 时不删除，只返回将受影响的模型和会话用量。确认后再删。\n' +
        '参数：providerId；body.confirm。错误：403 / 404。',
      request: { params: providerId, ...body(providerConfirmRequest) },
      responses: { 200: json(providerImpactSchema) }
    },
    { module: 'providers', need: 'provider.manage', readOnly: false, destructive: true, expose: 'provider_delete' }
  ),
  providerRoutingSet: route(
    'providers:manage',
    {
      method: 'put', path: `${V1}/providers/routing/{workerId}`, tags: ['providers'], summary: '设置机器的提供商路由',
      description:
        '给一台机器覆盖路由（direct / hub），或 routing=null 取消覆盖、跟随提供商。只有集群管理员的管理令牌能改。\n' +
        '破坏性操作：不带 confirm=true 时只返回影响说明。已有会话保持当前路径，直到重启。\n' +
        '参数：workerId；body.routing、confirm?。错误：403 / 404。',
      request: { params: workerIdParam, ...body(providerRoutingRequest) },
      responses: { 200: json(providerImpactSchema) }
    },
    { module: 'providers', need: 'provider.manage', readOnly: false, destructive: true, expose: 'provider_routing_set' }
  ),
} as const;
