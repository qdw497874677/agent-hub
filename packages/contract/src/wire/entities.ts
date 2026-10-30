import { z } from 'zod';
import { id, epochMs } from './common.ts';

/** 实体与事件：项目、任务、会话、画布、附件、会话事件。 */

export const capabilityStateSchema = z.enum(['available', 'limited', 'denied']);

export const capabilitySchema = z.object({
  state: capabilityStateSchema,
  reason: z.string().optional()
});

export const capabilityNameSchema = z.enum([
  'prompt',
  'interrupt',
  'fork',
  'resume',
  'tool_calls',
  'artifacts',
  'structured_events',
  'attachments'
]);

export const capabilityMatrixSchema = z.record(capabilityNameSchema, capabilitySchema);

/**
 * 可调项：形状照 ACP 的 ConfigOption。agent 报什么，界面就渲染什么——
 * 所以这层只负责搬运，不解释哪个选项叫什么名字。
 */
export const optionValueSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional()
});

export const optionChoiceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), value: optionValueSchema }),
  z.object({
    kind: z.literal('group'),
    label: z.string(),
    values: z.array(optionValueSchema).readonly()
  })
]);

export const optionCategorySchema = z.enum(['model', 'mode', 'model_config', 'thought_level', 'custom']);

export const runtimeOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  category: optionCategorySchema,
  kind: z.enum(['select', 'boolean']),
  current: z.union([z.string(), z.boolean()]),
  // readonly：领域里的选项是只读的，这里不加的话每次跨界都要一次无意义的复制
  choices: z.array(optionChoiceSchema).readonly()
});

export const optionValuesSchema = z.record(z.string(), z.union([z.string(), z.boolean()]));

export const agentReadinessSchema = z.discriminatedUnion('state', [
  /** lacks：能用，但缺某个可选部件（如 Pi 的 MCP 适配器）；hub 视资产决定是否降为不可用。 */
  z.object({ state: z.literal('ready'), lacks: z.array(z.string().max(64)).max(16).optional() }),
  z.object({ state: z.literal('unavailable'), reason: z.string(), hint: z.string().max(200).optional() })
]);

/** 运行时从哪来（ADR 0010）：machine = 机器自带，以它为准；hub = hub 装的；missing = 没有。 */
export const runtimeProvisionSchema = z.object({
  source: z.enum(['machine', 'hub', 'missing']),
  version: z.string().max(64).optional(),
  recommended: z.string().max(64).optional(),
  blocker: z.string().max(200).optional()
});

export const agentSchema = z.object({
  id,
  label: z.string(),
  capabilities: capabilityMatrixSchema,
  models: z.array(z.string()).readonly(),
  defaultModel: z.string(),
  options: z.array(runtimeOptionSchema),
  /** worker 探测的就绪状态。老 worker 不报 = 当作 ready。 */
  readiness: agentReadinessSchema.optional(),
  /** 运行时的来源与可否在线安装；老 worker 不报 = 不支持在线安装。 */
  provision: runtimeProvisionSchema.optional()
});

export const projectSchema = z.object({
  id,
  name: z.string(),
  /** 项目的 git 仓库；没有是 null。 */
  repo: z.object({ url: z.string(), defaultBranch: z.string().nullable() }).nullable().default(null),
  /** 项目说明（markdown）。 */
  description: z.string().nullable().default(null),
  createdAt: epochMs
});

/** 工作空间（docs/design/workspaces.md §2）：某台机器上的一个目录，会话在里面干活。 */
export const workspaceSchema = z.object({
  id,
  projectId: id,
  /** null = 和 Server 同机。 */
  workerId: z.string().nullable(),
  path: z.string(),
  kind: z.enum(['long_lived', 'temporary']),
  source: z.enum(['linked', 'created', 'cloned', 'worktree']),
  baseWorkspaceId: z.string().nullable(),
  branch: z.string().nullable(),
  ownerTaskId: z.string().nullable(),
  label: z.string().nullable(),
  isGit: z.boolean().nullable(),
  state: z.enum(['preparing', 'ready', 'failed', 'kept', 'removed']),
  keptReason: z.string().nullable(),
  createdAt: epochMs,
  updatedAt: epochMs
});

/** 运行面板的一行：工作空间 + 正在里面跑会话的任务（并发警告）。 */
export const workspaceViewSchema = z.object({
  workspace: workspaceSchema,
  runningTaskIds: z.array(z.string())
});

export const taskStatusSchema = z.enum(['todo', 'in_progress', 'blocked', 'in_review', 'done', 'abandoned']);

export const taskSchema = z.object({
  id,
  projectId: id,
  title: z.string(),
  goal: z.string().nullable(),
  status: taskStatusSchema,
  ownerId: z.string().nullable(),
  branch: z.string().nullable(),
  summary: z.string().nullable(),
  logSeq: z.number().int().nonnegative(),
  createdAt: epochMs,
  updatedAt: epochMs
});

export const sessionStatusSchema = z.enum([
  'running',
  'stopped',
  'done',
  'interrupted',
  'failed'
]);

export const sessionOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('derive') }),
  z.object({ kind: z.literal('fork'), fromSessionId: id, atSeq: z.number().int().positive() })
]);

export const sessionSchema = z.object({
  id,
  taskId: id,
  agentId: id,
  model: z.string(),
  origin: sessionOriginSchema,
  status: sessionStatusSchema,
  lastSeq: z.number().int().nonnegative(),
  agentSessionRef: z.string().nullable(),
  options: optionValuesSchema,
  optionSpec: z.array(runtimeOptionSchema),
  /** 落点：会话绑在哪台 Worker 上。null = 多机之前的老会话。 */
  workerId: z.string().nullable().default(null),
  /** 在哪个工作空间里干活；null = 迁移前的老会话。 */
  workspaceId: z.string().nullable().default(null),
  createdAt: epochMs,
  updatedAt: epochMs
});

export const artifactSchema = z.object({
  id,
  sessionId: id,
  taskId: id,
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  label: z.string(),
  createdAt: epochMs
});

export const pointSchema = z.object({ x: z.number(), y: z.number() });

export const sizeSchema = z.object({ width: z.number().positive(), height: z.number().positive() });

export const layoutSchema = z.object({
  projectId: id,
  positions: z.record(id, pointSchema),
  sizes: z.record(id, sizeSchema),
  updatedAt: epochMs
});

export const lineageEdgeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('derive'), taskId: id, sessionId: id }),
  z.object({
    kind: z.literal('fork'),
    fromSessionId: id,
    toSessionId: id,
    atSeq: z.number().int().positive()
  })
]);

export const canvasSchema = z.object({
  project: projectSchema,
  /** 项目名下还在的工作空间：卡片上显示「机器 · 工作空间 · 分支」。 */
  workspaces: z.array(workspaceSchema).default([]),
  tasks: z.array(taskSchema),
  sessions: z.array(sessionSchema),
  artifacts: z.array(artifactSchema),
  edges: z.array(lineageEdgeSchema),
  layout: layoutSchema,
  agents: z.array(agentSchema),
  // 用 lazy 引用：canvasSchema 在 journalEntrySchema 之前定义，直接引会撞 TDZ
  previews: z.record(z.string(), z.array(z.lazy(() => journalEntrySchema)))
});

/** journal 里的附件元数据（没有字节）。 */
export const storedAttachmentSchema = z.object({
  kind: z.enum(['image', 'file', 'mention']),
  name: z.string(),
  path: z.string(),
  mimeType: z.string().optional(),
  bytes: z.number().int().nonnegative().optional()
});

/** 浏览器发来的附件：上传的带 base64，引用的只带项目内相对路径。大小在 domain 校验。 */
export const attachmentInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), name: z.string().min(1), mimeType: z.string().min(1), data: z.string().min(1) }),
  z.object({ kind: z.literal('file'), name: z.string().min(1), mimeType: z.string(), data: z.string().min(1) }),
  z.object({ kind: z.literal('mention'), path: z.string().min(1) })
]);

/** server → worker 的内容块。 */
export const promptPartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), name: z.string(), mimeType: z.string(), data: z.string(), path: z.string() }),
  z.object({ kind: z.literal('file'), name: z.string(), mimeType: z.string(), data: z.string(), path: z.string() }),
  z.object({ kind: z.literal('mention'), name: z.string(), path: z.string() })
]);

/** 归一化事件过网时的形状：与 domain 的 SessionEvent 一一对应。 */
export const sessionEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('prompt'),
    text: z.string(),
    attachments: z.array(storedAttachmentSchema).optional(),
    /** 谁说的（登录态下才有；老事件没有 = 不知道）。name 读出时按当前账号刷新，删掉的用户显示匿名名。 */
    author: z.object({ id: z.string(), name: z.string() }).optional()
  }),
  z.object({ kind: z.literal('text'), delta: z.string() }),
  z.object({ kind: z.literal('thinking'), delta: z.string() }),
  z.object({ kind: z.literal('tool_call'), name: z.string(), input: z.string() }),
  z.object({
    kind: z.literal('tool_result'),
    name: z.string(),
    ok: z.boolean(),
    durationMs: z.number().int().nonnegative(),
    output: z.string().optional()
  }),
  z.object({ kind: z.literal('artifact'), path: z.string(), bytes: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal('ended'),
    outcome: z.enum(['done', 'stopped', 'interrupted', 'failed']),
    reason: z.string().optional()
  }),
  z.object({
    kind: z.literal('diagnostic'),
    level: z.enum(['info', 'warn', 'error']),
    text: z.string()
  })
]);

export const searchHitSchema = z.object({
  kind: z.enum(['task', 'session']),
  taskId: z.string(),
  sessionId: z.string().nullable(),
  title: z.string(),
  snippet: z.string()
});

export const searchResponseSchema = z.object({ hits: z.array(searchHitSchema) });

export const journalEntrySchema = z.object({
  seq: z.number().int().positive(),
  event: sessionEventSchema,
  at: epochMs
});
