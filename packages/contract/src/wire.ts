import { z } from 'zod';

/**
 * 线上格式。Zod 定义边界，`z.infer` 出类型——只有一份真源。
 * 领域类型是内核的真源；这一层只负责「过网时怎么写」，不含任何业务判断。
 */

const id = z.string().min(1);
const epochMs = z.number().int().nonnegative();

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

export const agentSchema = z.object({
  id,
  label: z.string(),
  capabilities: capabilityMatrixSchema,
  models: z.array(z.string()).readonly(),
  defaultModel: z.string(),
  options: z.array(runtimeOptionSchema)
});

export const projectSchema = z.object({
  id,
  name: z.string(),
  rootPath: z.string(),
  createdAt: epochMs
});

export const taskStatusSchema = z.enum(['open', 'done', 'abandoned']);

export const taskSchema = z.object({
  id,
  projectId: id,
  title: z.string(),
  goal: z.string().nullable(),
  status: taskStatusSchema,
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
  z.object({ kind: z.literal('prompt'), text: z.string(), attachments: z.array(storedAttachmentSchema).optional() }),
  z.object({ kind: z.literal('text'), delta: z.string() }),
  z.object({ kind: z.literal('tool_call'), name: z.string(), input: z.string() }),
  z.object({
    kind: z.literal('tool_result'),
    name: z.string(),
    ok: z.boolean(),
    durationMs: z.number().int().nonnegative()
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

// ---- 请求 ----

export const createProjectRequest = z.object({
  name: z.string().min(1).max(80),
  rootPath: z.string().min(1)
});

export const createTaskRequest = z.object({
  projectId: id,
  title: z.string().min(1).max(200),
  goal: z.string().max(2000).optional()
});

export const setTaskStatusRequest = z.object({ status: taskStatusSchema });

export const deriveSessionRequest = z.object({
  taskId: id,
  agentId: id,
  // 空字符串 = 用 agent 自己的默认模型（见 apps/web 的派生对话框）
  model: z.string()
});

export const forkSessionRequest = z.object({
  sessionId: id,
  atSeq: z.number().int().positive(),
  agentId: id,
  // 空字符串 = 用 agent 自己的默认模型（见 apps/web 的派生对话框）
  model: z.string()
});

export const promptRequest = z
  .object({ text: z.string(), attachments: z.array(attachmentInputSchema).default([]) })
  .refine((value) => value.text.trim() !== '' || value.attachments.length > 0, { message: '消息不能为空' });

/** `@` 引用选择器：项目内文件的相对路径。 */
export const projectFilesSchema = z.object({ files: z.array(z.string()), truncated: z.boolean() });

export const saveLayoutRequest = z.object({
  positions: z.record(id, pointSchema).optional(),
  sizes: z.record(id, sizeSchema).optional()
});

// ---- 响应 ----

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() })
});

export const sessionStreamFrameSchema = z.object({
  type: z.literal('event'),
  sessionId: id,
  seq: z.number().int().positive(),
  event: sessionEventSchema,
  status: sessionStatusSchema
});

export const workerHelloSchema = z.object({
  type: z.literal('hello'),
  workerId: id,
  label: z.string(),
  origin: z.enum(['local', 'remote']),
  token: z.string().optional(),
  /** worker 报上它装了哪些 agent——server 从不自己猜 agent 列表。 */
  agents: z.array(agentSchema)
});

export const workerEventSchema = z.object({
  type: z.literal('event'),
  sessionId: id,
  event: sessionEventSchema
});

export const workerAgentSessionSchema = z.object({
  type: z.literal('agent_session'),
  sessionId: id,
  agentSessionRef: id
});

/** worker 把 agent 报上来的可调项当前值交回 server，好让重开浏览器时选择器不空着。 */
export const workerOptionsSchema = z.object({
  type: z.literal('options'),
  sessionId: id,
  options: z.array(runtimeOptionSchema)
});

/**
 * 首页要的东西：项目 + 有多少活在里面。
 * 单独的 DTO 而不是让前端逐个项目拉 canvas：首页不该为了显示「3 个任务」去解 30 个会话。
 */
export const projectSummarySchema = projectSchema.extend({
  taskCount: z.number().int().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
  lastActivityAt: epochMs.nullable()
});
/**
 * 首页第二栏：最近的会话，跨项目。
 *
 * 重度用户回到工作台时想的是「昨天那条跑到哪了」，不是「我有几个项目」。
 * 所以首页得能直接列出会话，点一下回到它所在的画布。
 */
export const recentSessionSchema = z.object({
  sessionId: id,
  taskId: id,
  taskTitle: z.string(),
  projectId: id,
  projectName: z.string(),
  agentId: id,
  status: sessionStatusSchema,
  lastSeq: z.number().int().nonnegative(),
  updatedAt: epochMs
});

export const homeSchema = z.object({
  projects: z.array(projectSummarySchema),
  recentSessions: z.array(recentSessionSchema)
});

/** 目录选择器：只列子目录。`parent` 为 null 表示已经在根。 */
export const directoryEntrySchema = z.object({ name: z.string(), path: z.string() });
export const directoryListingSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  entries: z.array(directoryEntrySchema)
});

/** `/api/workers` 的响应：UI 靠它区分「它挂了」和「我改坏了配置」（S1.2）。 */
export const workerInfoSchema = z.object({
  workerId: z.string(),
  label: z.string(),
  origin: z.enum(['local', 'remote']),
  state: z.enum(['online', 'offline']),
  reason: z.string().optional()
});

/**
 * worker 关于「这条会话还在不在我这儿」的汇报。
 * `running` / `ended` / `gone` 说的是**托管状态**，不是领域状态——领域状态由事件决定。
 */
export const workerStatusSchema = z.object({
  type: z.literal('status'),
  sessionId: id,
  status: z.enum(['running', 'ended', 'gone']),
  reason: z.string().optional()
});

export const workerToServerSchema = z.discriminatedUnion('type', [
  workerHelloSchema,
  workerEventSchema,
  workerAgentSessionSchema,
  workerOptionsSchema,
  workerStatusSchema
]);

export const startSessionCommandSchema = z.object({
  kind: z.literal('start_session'),
  sessionId: id,
  taskId: id,
  agentId: id,
  workspaceRoot: z.string(),
  origin: sessionOriginSchema,
  resume: z
    .object({ agentSessionRef: z.string().nullable(), cursor: z.number().int().nonnegative() })
    .nullable(),
  /** 开跑前就定下的可调项；空对象表示全用 agent 默认。 */
  options: optionValuesSchema
});

export const serverToWorkerSchema = z.discriminatedUnion('kind', [
  startSessionCommandSchema,
  z.object({ kind: z.literal('prompt'), sessionId: id, text: z.string(), parts: z.array(promptPartSchema).default([]) }),
  z.object({ kind: z.literal('interrupt'), sessionId: id }),
  z.object({ kind: z.literal('dispose'), sessionId: id }),
  z.object({
    kind: z.literal('set_option'),
    sessionId: id,
    optionId: z.string(),
    value: z.union([z.string(), z.boolean()])
  })
]);

/** 改一项可调项：值可以是模型串、也可以是思考强度的档位名。 */
export const changeOptionRequest = z.object({
  optionId: z.string().min(1),
  value: z.union([z.string(), z.boolean()])
});

export type CapabilityDto = z.infer<typeof capabilitySchema>;
export type AgentDto = z.infer<typeof agentSchema>;
export type RuntimeOptionDto = z.infer<typeof runtimeOptionSchema>;
export type OptionValueDto = z.infer<typeof optionValueSchema>;
export type ProjectDto = z.infer<typeof projectSchema>;
export type TaskDto = z.infer<typeof taskSchema>;
export type SessionDto = z.infer<typeof sessionSchema>;
export type ArtifactDto = z.infer<typeof artifactSchema>;
export type LayoutDto = z.infer<typeof layoutSchema>;
export type CanvasDto = z.infer<typeof canvasSchema>;
export type SessionEventDto = z.infer<typeof sessionEventSchema>;
export type JournalEntryDto = z.infer<typeof journalEntrySchema>;
export type SearchHitDto = z.infer<typeof searchHitSchema>;
export type SearchResponseDto = z.infer<typeof searchResponseSchema>;
export type WorkerInfoDto = z.infer<typeof workerInfoSchema>;
export type ProjectSummaryDto = z.infer<typeof projectSummarySchema>;
export type HomeDto = z.infer<typeof homeSchema>;
export type RecentSessionDto = z.infer<typeof recentSessionSchema>;
export type DirectoryEntryDto = z.infer<typeof directoryEntrySchema>;
export type DirectoryListingDto = z.infer<typeof directoryListingSchema>;
export type CreateProjectRequest = z.infer<typeof createProjectRequest>;
export type CreateTaskRequest = z.infer<typeof createTaskRequest>;
export type DeriveSessionRequest = z.infer<typeof deriveSessionRequest>;
export type ForkSessionRequest = z.infer<typeof forkSessionRequest>;
export type SaveLayoutRequest = z.infer<typeof saveLayoutRequest>;
export type AttachmentInputDto = z.infer<typeof attachmentInputSchema>;
export type StoredAttachmentDto = z.infer<typeof storedAttachmentSchema>;
export type ProjectFilesDto = z.infer<typeof projectFilesSchema>;
export type SessionStreamFrame = z.infer<typeof sessionStreamFrameSchema>;
export type WorkerToServer = z.infer<typeof workerToServerSchema>;
export type ServerToWorker = z.infer<typeof serverToWorkerSchema>;
