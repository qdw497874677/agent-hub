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
  'structured_events'
]);

export const capabilityMatrixSchema = z.record(capabilityNameSchema, capabilitySchema);

export const agentSchema = z.object({
  id,
  label: z.string(),
  capabilities: capabilityMatrixSchema,
  models: z.array(z.string()).readonly(),
  defaultModel: z.string()
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

export const layoutSchema = z.object({
  projectId: id,
  positions: z.record(id, pointSchema),
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

/** 归一化事件过网时的形状：与 domain 的 SessionEvent 一一对应。 */
export const sessionEventSchema = z.discriminatedUnion('kind', [
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

export const promptRequest = z.object({ text: z.string().min(1) });

export const saveLayoutRequest = z.object({ positions: z.record(id, pointSchema) });

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

/** `/api/workers` 的响应：UI 靠它区分「它挂了」和「我改坏了配置」（S1.2）。 */
export const workerInfoSchema = z.object({
  workerId: z.string(),
  label: z.string(),
  origin: z.enum(['local', 'remote']),
  state: z.enum(['online', 'offline']),
  reason: z.string().optional()
});

export const workerStatusSchema = z.object({
  type: z.literal('status'),
  sessionId: id,
  status: z.enum(['running', 'stopped', 'done', 'interrupted', 'failed']),
  reason: z.string().optional()
});

export const workerToServerSchema = z.discriminatedUnion('type', [
  workerHelloSchema,
  workerEventSchema,
  workerAgentSessionSchema,
  workerStatusSchema
]);

export const startSessionCommandSchema = z.object({
  kind: z.literal('start_session'),
  sessionId: id,
  taskId: id,
  agentId: id,
  model: z.string(),
  workspaceRoot: z.string(),
  origin: sessionOriginSchema,
  resume: z
    .object({ agentSessionRef: z.string().nullable(), cursor: z.number().int().nonnegative() })
    .nullable()
});

export const serverToWorkerSchema = z.discriminatedUnion('kind', [
  startSessionCommandSchema,
  z.object({ kind: z.literal('prompt'), sessionId: id, text: z.string() }),
  z.object({ kind: z.literal('interrupt'), sessionId: id }),
  z.object({ kind: z.literal('dispose'), sessionId: id })
]);

export type AgentDto = z.infer<typeof agentSchema>;
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
export type CreateProjectRequest = z.infer<typeof createProjectRequest>;
export type CreateTaskRequest = z.infer<typeof createTaskRequest>;
export type DeriveSessionRequest = z.infer<typeof deriveSessionRequest>;
export type ForkSessionRequest = z.infer<typeof forkSessionRequest>;
export type SaveLayoutRequest = z.infer<typeof saveLayoutRequest>;
export type SessionStreamFrame = z.infer<typeof sessionStreamFrameSchema>;
export type WorkerToServer = z.infer<typeof workerToServerSchema>;
export type ServerToWorker = z.infer<typeof serverToWorkerSchema>;
