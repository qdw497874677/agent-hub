// tokens 能力段的路由定义（从 routes.ts 原样搬出；顺序即注册顺序）。
import { z } from '@hono/zod-openapi';
import {
  apiTokenInfoSchema,
  createApiTokenResponse,
  rotateApiTokenResponse
} from '@agent-hub/contract';
import { V1, json, body, route } from './base.ts';
import {
  tokenIdParam,
  createManagedTokenRequest
} from './schemas.ts';

export const tokens = {
  tokenList: route('tokens:manage', {
    method: 'get', path: `${V1}/tokens`, tags: ['tokens'], summary: '列出可管理的访问令牌',
    description:
      '列出当前身份能看见的访问令牌（个人令牌、以及主人能看的服务账号 / 项目 bot 凭据）。响应没有哈希、没有明文。\n' +
      '权限：需要 `tokens:manage`（默认关闭，只能由管理员在界面授予；不能给只限项目的令牌或 bot 凭据）。\n' +
      '错误：403 无 tokens:manage。',
    responses: { 200: json(z.object({ tokens: z.array(apiTokenInfoSchema) })) }
  }, { module: 'tokens', need: 'token.manage', expose: 'token_list' }),
  tokenCreate: route(
    'tokens:manage',
    {
      method: 'post', path: `${V1}/tokens`, tags: ['tokens'], summary: '签发访问令牌（明文只返回一次）',
      description:
        '经已有的管理令牌签发一张新的个人令牌。scopes 必须是调用方令牌的子集，且不能包含 `tokens:manage` 或 `providers:manage`（不能提权）。必须设置 expiresAt，最长 30 天。明文只在这一次响应的 token 字段里出现，之后只能看到前缀。\n' +
        '第一张带 `tokens:manage` 的管理员令牌只能在界面（外部接入 / 访问令牌）签发一次。\n' +
        '审计只记名字、scope 和是否限定项目，不记明文。错误：400 缺过期时间 / 超出 30 天 / 范围非法；403 无权限或试图提权。',
      request: body(createManagedTokenRequest),
      responses: { 201: json(createApiTokenResponse) }
    },
    { module: 'tokens', need: 'token.manage', readOnly: false, destructive: false, expose: 'token_create', idempotent: true }
  ),
  tokenRotate: route(
    'tokens:manage',
    {
      method: 'post', path: `${V1}/tokens/{tokenId}/rotate`, tags: ['tokens'], summary: '轮换访问令牌（明文只返回一次）',
      description:
        '吊销旧令牌并签发一张同名、同权限的新令牌。新明文只返回一次。经令牌轮换时有效期最长 30 天。审计不记明文。\n' +
        '参数：tokenId。错误：403 / 404 / 409 已吊销。',
      request: { params: tokenIdParam },
      responses: { 200: json(rotateApiTokenResponse) }
    },
    { module: 'tokens', need: 'token.manage', readOnly: false, destructive: true, expose: 'token_rotate' }
  ),
  tokenRevoke: route(
    'tokens:manage',
    {
      method: 'post', path: `${V1}/tokens/{tokenId}/revoke`, tags: ['tokens'], summary: '吊销访问令牌',
      description:
        '吊销一张令牌（记录保留，列表里仍能看见）。审计不记明文。参数：tokenId。错误：403 / 404。',
      request: { params: tokenIdParam },
      responses: { 200: json(apiTokenInfoSchema) }
    },
    { module: 'tokens', need: 'token.manage', readOnly: false, destructive: true, expose: 'token_revoke' }
  )
} as const;
