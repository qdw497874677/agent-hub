// misc 能力段的路由定义（从 routes.ts 原样搬出；顺序即注册顺序）。
import { z } from '@hono/zod-openapi';
import { V1, json, route } from './base.ts';

export const misc = {
  health: route(null, {
    method: 'get', path: `${V1}/health`, tags: ['meta'], summary: '健康检查',
    responses: { 200: json(z.object({ ok: z.boolean() })) }
  }, { skip: '健康检查没有可执行的动作；探活直接打 REST /openapi/v1/health' }),
  workbenchSkill: route(null, {
    method: 'get', path: `${V1}/skills/agent-hub-workbench`, tags: ['meta'], summary: '下载 agent-hub-workbench skill',
    description:
      '给外部 agent 用的工作台操作说明（Agent Skills 格式：一份 SKILL.md 加 references/）。\n' +
      '参数：format=zip（默认，附件 agent-hub-workbench.zip）或 format=json（{ name, description, files[] }）。\n' +
      '本路径无需令牌。已连接 MCP 的客户端也可以 resources/list、resources/read（uri 形如 skill://agent-hub-workbench/SKILL.md）。',
    request: { query: z.object({ format: z.enum(['zip', 'json']).optional() }) },
    responses: {
      200: {
        description: 'zip 附件或 JSON 清单',
        content: {
          'application/zip': { schema: z.string() },
          'application/json': { schema: z.object({
            name: z.string(),
            description: z.string(),
            files: z.array(z.object({ path: z.string(), content: z.string() }))
          }) }
        }
      }
    }
  }, { skip: '给外部 agent 下载的文件，不是可执行工具；用 MCP resources/read 或本 GET' }),
  me: route(null, {
    method: 'get', path: `${V1}/me`, tags: ['meta'], summary: '当前令牌是谁',
    description: '返回令牌所属的账号与令牌的权限范围。任何有效令牌都能调。',
    responses: { 200: json(z.object({ user: z.object({ id: z.string(), name: z.string(), service: z.boolean() }), token: z.object({ id: z.string(), name: z.string(), kind: z.enum(['personal', 'service']) }) })) }
  }, { skip: '令牌自己的身份在 /me 里；工具清单不需要一个「查我自己」的工具' }),
} as const;
