// 路由共用的 zod schema（从 routes.ts 原样搬出，保持单实例：重复定义会让 OpenAPI 组件名分裂）。
import { z } from '@hono/zod-openapi';
import {
  journalEntrySchema,
  sessionSchema,
  apiScopeSchema
} from '@agent-hub/contract';
// ── 会话通信 P1d（docs/design/session-communication.md §5.4 / §10.2）──
export const messagePartSchema = z.record(z.string(), z.unknown()).openapi('MessagePart');
export const agentMessageSchema = z
  .object({
    messageId: z.string(),
    traceId: z.string(),
    kind: z.enum(['send', 'ask', 'reply']),
    from: z.string(),
    fromLabel: z.string().nullable(),
    to: z.string(),
    targetSessionId: z.string().nullable(),
    status: z.string(),
    body: z.string(),
    replyTo: z.string().nullable(),
    failure: z.string().nullable(),
    failureDetail: z.string().nullable(),
    parts: z.array(messagePartSchema),
    replyStatus: z.string().nullable(),
    createdAt: z.number()
  })
  .passthrough()
  .openapi('AgentMessage');
export const peerSchema = z
  .object({ address: z.string(), handle: z.string().optional(), label: z.string(), status: z.string(), workerId: z.string().nullable().optional(), repo: z.string().nullable().optional(), branch: z.string().nullable().optional(), title: z.string().nullable().optional(), connected: z.boolean().optional(), relation: z.enum(['explicit', 'task_tree', 'spawn']).optional() })
  .passthrough()
  .openapi('SessionPeer');
export const sessionLinkSchema = z.object({ projectId: z.string(), aSessionId: z.string(), bSessionId: z.string() }).passthrough().openapi('SessionLink');
export const sendMessageRequest = z
  .object({
    kind: z.enum(['send', 'ask']),
    body: z.string().min(1).max(32768),
    parts: z.array(messagePartSchema).max(8).optional(),
    wake: z.boolean().optional(),
    timeoutSec: z.number().int().min(30).max(14400).optional()
  })
  .openapi('SendMessageRequest');
export const acceptedSchema = z.object({ messageId: z.string(), traceId: z.string(), status: z.string(), targetSessionId: z.string().nullable() }).openapi('MessageAccepted');
export const waitSec = z.coerce.number().int().min(0).max(50).optional();

export const projectId = z.object({ projectId: z.string().openapi({ param: { name: 'projectId', in: 'path' } }) });
export const taskId = z.object({ taskId: z.string().openapi({ param: { name: 'taskId', in: 'path' } }) });
export const sessionId = z.object({ sessionId: z.string().openapi({ param: { name: 'sessionId', in: 'path' } }) });
export const workspaceId = z.object({ workspaceId: z.string().openapi({ param: { name: 'workspaceId', in: 'path' } }) });
export const groupId = z.object({ groupId: z.string().openapi({ param: { name: 'groupId', in: 'path' } }) });
export const providerId = z.object({ providerId: z.string().openapi({ param: { name: 'providerId', in: 'path' } }) });
export const acquisitionView = z.object({
  strategy: z.string(),
  type: z.enum(['detect-system-binary', 'user-space-install', 'lighter-variant', 'requires-root']),
  path: z.string().optional(),
  capability: z.string().optional(),
  componentId: z.string().optional()
});
export const capabilityStatusItem = z.object({
  workerId: z.string(),
  label: z.string(),
  online: z.boolean(),
  ready: z.boolean(),
  installing: z.boolean(),
  blocker: z.string().nullable(),
  capability: z.string(),
  installJob: z.object({
    jobId: z.string(),
    state: z.string(),
    message: z.string(),
    acquisition: acquisitionView.optional()
  }).nullable(),
  acquisition: acquisitionView.nullable()
});
export const workerIdParam = z.object({ workerId: z.string().openapi({ param: { name: 'workerId', in: 'path' } }) });



export const memberBranch = z.object({ repoId: z.string().min(1).max(80), branch: z.string().min(1).max(200) });
export const createWorkspaceGroupRequest = z.object({
  taskId: z.string().min(1).max(80),
  workerId: z.string().min(1).max(120).optional(),
  repoIds: z.array(z.string().min(1).max(80)).max(8).optional(),
  fromGroupId: z.string().min(1).max(80).optional(),
  branches: z.array(memberBranch).max(8).optional(),
  sessionId: z.string().min(1).max(80).optional()
});
export const addWorkspaceGroupMemberRequest = z.object({ repoId: z.string().min(1).max(80) });
export const workspaceGroupMemberSchema = z.object({
  workspaceId: z.string(),
  repoId: z.string(),
  name: z.string(),
  state: z.enum(['ready', 'preparing', 'failed']),
  error: z.string().nullable()
});
export const workspaceGroupSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  workerId: z.string().nullable(),
  root: z.string(),
  members: z.array(workspaceGroupMemberSchema),
  state: z.string(),
  layout: z.string().optional(),
  primaryRepoId: z.string().nullable().optional(),
  ownerTaskId: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  createdAt: z.number(),
  error: z.string().nullable()
});
export const sessionGitRunRequest = z.object({
  action: z.enum(['commit', 'push', 'pr']),
  message: z.string().max(8000).optional(),
  title: z.string().max(300).optional(),
  body: z.string().max(65_536).optional(),
  member: z.string().min(1).max(120).optional()
});
export const pullRequestLinkSchema = z.object({
  id: z.string(),
  url: z.string(),
  number: z.number().optional(),
  title: z.string().optional(),
  state: z.string(),
  workspaceId: z.string().optional(),
  repo: z.string().nullable().optional()
}).passthrough();
export const sessionGitStateSchema = z.object({
  isGit: z.boolean(),
  branch: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  hasOrigin: z.boolean(),
  repo: z.string().nullable(),
  files: z.array(z.unknown()),
  ahead: z.number(),
  upstream: z.string().nullable(),
  canPush: z.boolean(),
  prBlocked: z.string().nullable(),
  prVia: z.string(),
  pullRequests: z.array(pullRequestLinkSchema)
}).passthrough();
export const sessionGitRunResultSchema = z.object({
  sha: z.string().nullable(),
  committed: z.boolean(),
  pushed: z.boolean(),
  branch: z.string().nullable(),
  pullRequest: pullRequestLinkSchema.nullable(),
  compareUrl: z.string().nullable(),
  notes: z.array(z.string())
});
export const workspaceDiffSchema = z.object({
  branch: z.string().nullable(),
  files: z.array(z.object({ path: z.string(), status: z.string() })),
  patch: z.string(),
  truncated: z.boolean(),
  notice: z.string().optional()
});
export const workspaceFileSchema = z.object({
  path: z.string(),
  size: z.number(),
  modifiedAt: z.number(),
  binary: z.boolean(),
  content: z.string()
});
export const sweepItemSchema = z.object({
  runId: z.string(),
  projectId: z.string().nullable(),
  workspaceId: z.string(),
  path: z.string(),
  branch: z.string().nullable(),
  action: z.enum(['removed', 'kept', 'failed']),
  reason: z.string(),
  sizeBytes: z.number().nullable(),
  at: z.number()
});
export const sweepReportSchema = z.object({
  removed: z.array(z.string()),
  kept: z.array(z.string()),
  skipped: z.array(z.string()),
  failed: z.array(z.string()).optional(),
  runId: z.string().nullable().optional(),
  items: z.array(sweepItemSchema).optional(),
  /** 这一轮没有可清项时的说明（常见：干净 worktree 已在收起时拆除）。 */
  message: z.string().optional(),
  alreadyRemoved: z.array(z.string()).optional()
});
export const cleanupRecordsSchema = z.object({
  items: z.array(sweepItemSchema),
  orphans: z.array(z.object({ path: z.string(), workerId: z.string().nullable() }))
});

export const eventListSchema = z.object({
  events: z.array(journalEntrySchema),
  /** 下一次轮询应传的 after：本窗最后一条原始 journal seq（投影为空也要前进）；窗口为空时是入参 after 或 0。 */
  nextAfter: z.number().int().min(0)
});

export const worktreeCleanupItemSchema = z.object({
  workspaceId: z.string(),
  member: z.string().optional(),
  action: z.enum(['removed', 'kept', 'deferred']),
  reason: z.string()
});
export const settleSessionResponse = sessionSchema.extend({
  cleanup: z.object({ items: z.array(worktreeCleanupItemSchema) })
});
/** 对外 start / get 的会话对象：额外带任务内短名；来源与 session_peers 的 handle 一致（同一台消息总线）。 */
export const sessionWithHandleSchema = sessionSchema.extend({ handle: z.string().nullable() });

export const tokenIdParam = z.object({ tokenId: z.string().openapi({ param: { name: 'tokenId', in: 'path' } }) });
/** 经 MCP / 开放 API 签发：必须设过期时间，最长 30 天；不能带管理类 scope。 */
export const createManagedTokenRequest = z.object({
  name: z.string().trim().min(1).max(60),
  scopes: z.array(apiScopeSchema).min(1),
  /** 毫秒时间戳，必填，且不超过现在 + 30 天。 */
  expiresAt: z.number().int().positive(),
  projectIds: z.array(z.string().trim().min(1)).min(1).max(50).nullable().optional()
});


export const providerModelInput = z.union([
  z.string().min(1).max(120),
  z.object({
    id: z.string().min(1).max(120),
    name: z.string().max(80).optional(),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    extra: z.record(z.string(), z.unknown()).optional()
  })
]);
export const providerProtocol = z.enum(['openai-chat', 'openai-responses', 'anthropic']);
export const providerRouting = z.enum(['direct', 'hub']);
export const providerInputFields = {
  slug: z.string().min(1).max(31),
  name: z.string().min(1).max(80),
  protocol: providerProtocol,
  baseUrl: z.string().min(1).max(500),
  models: z.array(providerModelInput).min(1).max(100),
  routing: providerRouting,
  enabled: z.boolean().optional()
};
export const providerCreateRequest = z.object({
  ...providerInputFields,
  scope: z.enum(['personal', 'team', 'hub']).default('personal'),
  apiKey: z.string().min(1).max(4096).optional()
}).openapi('ProviderCreateRequest');
export const providerUpdateRequest = z.object(providerInputFields).openapi('ProviderUpdateRequest');
export const providerKeyRequest = z.object({ apiKey: z.string().min(1).max(4096) }).openapi('ProviderKeyRequest');
export const providerProbeRequest = z.object({
  providerId: z.string().min(1).optional(),
  protocol: providerProtocol.optional(),
  baseUrl: z.string().min(1).max(500).optional(),
  apiKey: z.string().max(4096).optional(),
  workerId: z.string().min(1).max(120).optional()
}).openapi('ProviderProbeRequest');
export const providerTestRequest = z.object({ workerId: z.string().min(1).max(120) }).openapi('ProviderTestRequest');
export const providerConfirmRequest = z.object({ confirm: z.boolean().optional() }).openapi('ProviderConfirmRequest');
export const providerRoutingRequest = z.object({
  routing: providerRouting.nullable(),
  confirm: z.boolean().optional()
}).openapi('ProviderRoutingRequest');
export const providerUsageSchema = z.object({
  requests: z.number(),
  errors: z.number(),
  bytesIn: z.number(),
  bytesOut: z.number(),
  sessions: z.number(),
  lastUsedAt: z.number().nullable()
});
export const providerViewSchema = z.object({
  id: z.string(),
  scope: z.enum(['personal', 'team', 'hub']),
  ownerId: z.string().nullable(),
  slug: z.string(),
  name: z.string(),
  protocol: providerProtocol,
  baseUrl: z.string(),
  models: z.array(z.object({ id: z.string(), name: z.string().optional(), contextWindow: z.number().optional(), maxTokens: z.number().optional(), extra: z.record(z.string(), z.unknown()).optional() })),
  routing: providerRouting,
  enabled: z.boolean(),
  hasKey: z.boolean(),
  lastCheck: z.unknown().nullable(),
  createdBy: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  canManage: z.boolean().optional(),
  usage: providerUsageSchema.optional()
}).passthrough().openapi('Provider');
export const providerListSchema = z.object({
  providers: z.array(providerViewSchema),
  // LOW6：没有 workers:read 的令牌拿不到机器路由覆盖——字段整个省略。
  workerRouting: z.record(z.string(), providerRouting).optional()
}).openapi('ProviderList');
export const providerProbeResultSchema = z.object({
  ok: z.boolean(),
  status: z.number().optional(),
  message: z.string(),
  via: z.string().optional(),
  models: z.array(z.unknown())
}).passthrough().openapi('ProviderProbeResult');
export const providerImpactSchema = z.object({
  confirmRequired: z.boolean().optional(),
  confirmed: z.boolean().optional(),
  action: z.string(),
  message: z.string(),
  provider: z.unknown().optional(),
  models: z.array(z.string()).optional(),
  usage: z.unknown().optional(),
  workerId: z.string().optional(),
  routing: z.string().nullable().optional()
}).passthrough().openapi('ProviderImpact');
