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
  /** 目录在哪台 Worker 上；null = 和 Server 同机。 */
  workerId: z.string().nullable().default(null),
  /** 「换台机器继续」登记过的别的 Worker 上的目录：workerId → 绝对路径。 */
  directories: z.record(z.string(), z.string()).default({}),
  createdAt: epochMs
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
  rootPath: z.string().min(1),
  workerId: z.string().min(1).nullable().optional()
});

export const createTaskRequest = z.object({
  projectId: id,
  title: z.string().min(1).max(200),
  goal: z.string().max(2000).optional()
});

export const setTaskSummaryRequest = z.object({ summary: z.string().max(2000) });
export const setTaskStatusRequest = z.object({ status: taskStatusSchema, note: z.string().max(2000).optional() });

// ── 工作日志（tasks-and-capabilities.md §2.2）──────────────────
export const logLinkSchema = z.object({
  kind: z.enum(['session', 'artifact', 'file', 'commit', 'pr', 'url']),
  ref: z.string().min(1).max(2000),
  label: z.string().max(200).optional()
});
export const logAuthorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: z.string().nullable(), name: z.string().nullable() }),
  z.object({ kind: z.literal('agent'), sessionId: z.string(), agentId: z.string(), model: z.string() }),
  z.object({ kind: z.literal('system') })
]);
export const workLogEntrySchema = z.object({
  id,
  taskId: id,
  seq: z.number().int().positive(),
  author: logAuthorSchema,
  body: z.string(),
  links: z.array(logLinkSchema),
  attachments: z.array(z.string()),
  sessionId: z.string().nullable(),
  createdAt: epochMs,
  supersedes: z.string().nullable(),
  supersededBy: z.string().nullable()
});
export const appendLogRequest = z.object({
  // 日志没有种类了：旧客户端带的 kind 会被 zod 默认剥掉
  body: z.string().min(1).max(32 * 1024),
  links: z.array(logLinkSchema).max(20).optional(),
  sessionId: z.string().min(1).optional()
});
export const editLogRequest = z.object({ body: z.string().min(1).max(32 * 1024) });
export const workLogPage = z.object({ entries: z.array(workLogEntrySchema), nextBeforeSeq: z.number().int().nullable() });
export type WorkLogEntryDto = z.infer<typeof workLogEntrySchema>;

export const deriveSessionRequest = z.object({
  taskId: id,
  agentId: id,
  // 空字符串 = 用 agent 自己的默认模型（见 apps/web 的派生对话框）
  model: z.string(),
  /** 点名交给哪台 Worker；不给就按落点规则挑。 */
  workerId: z.string().min(1).nullable().optional()
});

export const forkSessionRequest = z.object({
  sessionId: id,
  atSeq: z.number().int().positive(),
  agentId: id,
  // 空字符串 = 用 agent 自己的默认模型（见 apps/web 的派生对话框）
  model: z.string()
});

/** 换台机器继续：目标 Worker；那台还没登记目录时带上 directory。 */
export const continueElsewhereRequest = z.object({
  workerId: id,
  directory: z.string().nullable().optional()
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

/**
 * Worker 通道的协议版本。帧格式有不兼容的改动才加一；hub 只接受同一个协议版本的 Worker，
 * 不一致时用关闭码 4426 拒绝并说明原因（Worker 收到后停止重连，提示手动更新）。
 */
export const PROTOCOL_VERSION = 1;
export const PROTOCOL_MISMATCH_CLOSE = 4426;

/** 一份代码的身份：package 版本 + git 提交（不在 git 仓库里就是 null）+ 协议版本。 */
export const buildInfoSchema = z.object({
  version: z.string().max(64),
  commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  protocol: z.number().int().nonnegative()
});

/** git 完整提交号：更新指令唯一的参数，不接受任何其他形式的输入。 */
export const commitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

export const updateStateSchema = z.enum(['updating', 'succeeded', 'failed', 'refused']);

/** Worker 执行更新时的进度回报。 */
export const workerUpdateStatusSchema = z.object({
  type: z.literal('update_status'),
  state: updateStateSchema,
  message: z.string().max(500),
  /** 最后一段命令输出（git / npm），失败时给人排查用。 */
  logTail: z.string().max(4000).default('')
});

export const workerHelloSchema = z.object({
  type: z.literal('hello'),
  workerId: id,
  label: z.string(),
  origin: z.enum(['local', 'remote']),
  token: z.string().optional(),
  /** 只有 server 自己拉起的本机 worker 知道：证明「我真是本机」。 */
  localSecret: z.string().optional(),
  /** worker 报上它装了哪些 agent——server 从不自己猜 agent 列表。 */
  agents: z.array(agentSchema),
  /** 机器信息：管理视图里让人认出「这是哪台」。 */
  host: z.object({ hostname: z.string(), platform: z.string(), arch: z.string() }).optional(),
  /** 目录选择器的起点（通常是 $HOME 和 WORKER_ROOTS 里配的目录）。 */
  roots: z.array(z.string()).default([]),
  /** 断线重连时：我手上还活着的会话。server 据此重新登记托管，而不是再 resume 一遍。 */
  sessions: z.array(id).default([]),
  /** 这台 Worker 跑的代码版本；老 Worker 不报，按「过期」显示。 */
  build: buildInfoSchema.optional()
});

/** 目录浏览的回复：按 requestId 对上 server 的那次请求。 */
export const workerDirectoriesSchema = z.object({
  type: z.literal('directories'),
  requestId: z.string(),
  path: z.string(),
  exists: z.boolean(),
  entries: z.array(
    z.object({ name: z.string(), path: z.string(), isGit: z.boolean().optional(), modifiedAt: z.number().optional() })
  ),
  error: z.string().optional()
});

/** 新建文件夹的回复：成功给新目录的绝对路径，失败给 error。 */
export const workerMadeDirectorySchema = z.object({
  type: z.literal('made_directory'),
  requestId: z.string(),
  path: z.string(),
  error: z.string().optional()
});

/** `@` 引用选择器要的文件清单（相对项目根），由项目所在的那台 Worker 扫。 */
export const workerFilesSchema = z.object({
  type: z.literal('files'),
  requestId: z.string(),
  files: z.array(z.string()).default([]),
  truncated: z.boolean().default(false),
  error: z.string().optional()
});

/** 读一个文件的回复（附件缩略图）。`data` 为 null = 文件不存在。 */
export const workerFileSchema = z.object({
  type: z.literal('file'),
  requestId: z.string(),
  data: z.string().nullable().default(null),
  error: z.string().optional()
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
export const directoryEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  isGit: z.boolean().default(false),
  modifiedAt: z.number().default(0)
});
export const directoryListingSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  entries: z.array(directoryEntrySchema),
  /** 在哪台 Worker 上浏览的；null = Server 本机。 */
  workerId: z.string().nullable().default(null),
  /** 这台机器允许浏览的根：面包屑从这里开始，不能再往上。 */
  roots: z.array(z.string()).default([]),
  /** 项目托管目录 `<roots[0]>/agent-hub/<slug>`（请求带了项目名才有，不一定已存在）。 */
  managed: z.string().nullable().default(null)
});

export const makeDirectoryRequest = z.object({
  workerId: z.string().nullable().default(null),
  parent: z.string().min(1),
  name: z.string().min(1).max(255)
});

/** `/api/workers` 的响应：UI 靠它区分「它挂了」和「我改坏了配置」（S1.2）。 */
export const workerInfoSchema = z.object({
  workerId: z.string(),
  label: z.string(),
  origin: z.enum(['local', 'remote']),
  state: z.enum(['online', 'offline']),
  reason: z.string().optional(),
  agentIds: z.array(z.string()).optional(),
  hostname: z.string().optional(),
  platform: z.string().optional(),
  roots: z.array(z.string()).optional(),
  lastSeenAt: epochMs.optional(),
  sessionCount: z.number().int().nonnegative().optional()
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

/**
 * 工具调用经 worker 链路转发（stdio-shim 模式，P4）：agent 连不到 hub 的 HTTP 时，
 * 它调 worker 本地的 MCP 入口，worker 把调用塞进这条已有的 WebSocket 发给 hub。
 * 令牌随帧走（hub 按令牌认人），两边都不打日志。工具名是线上名（task_get）。
 */
export const workerToolRequestSchema = z.object({
  type: z.literal('tool_request'),
  requestId: z.string().min(1),
  token: z.string().min(1),
  op: z.enum(['list', 'call']),
  name: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional()
});

export const workerToServerSchema = z.discriminatedUnion('type', [
  workerToolRequestSchema,
  workerHelloSchema,
  workerEventSchema,
  workerAgentSessionSchema,
  workerOptionsSchema,
  workerStatusSchema,
  workerDirectoriesSchema,
  workerMadeDirectorySchema,
  workerFilesSchema,
  workerFileSchema,
  workerUpdateStatusSchema
]);

export const toolAccessSchema = z.object({
  transport: z.enum(['http', 'stdio-shim']),
  url: z.string().min(1),
  token: z.string().min(1)
});

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
  options: optionValuesSchema,
  /** 能力层（可选）：旧 worker 收不到就当没有工具。token 不许进日志。 */
  tools: toolAccessSchema.optional()
});

/** 不属于任何会话的请求（目录浏览）。和会话指令分开，免得 worker 把它当成「未知会话」。 */
export const listDirectoriesCommandSchema = z.object({
  kind: z.literal('list_directories'),
  requestId: z.string(),
  /** 空串 = 这台机器的默认起点（roots[0]）。 */
  path: z.string()
});

/** 在 parent 下建一层文件夹 name（目录选择器里的「新建文件夹」）。Worker 用 realpath 校验仍在 WORKER_ROOTS 里。 */
export const makeDirectoryCommandSchema = z.object({
  kind: z.literal('make_directory'),
  requestId: z.string(),
  parent: z.string(),
  name: z.string()
});

/** 列项目里的文件（`@` 引用）。`root` 是那台机器上的项目目录。 */
export const listFilesCommandSchema = z.object({
  kind: z.literal('list_files'),
  requestId: z.string(),
  root: z.string(),
  limit: z.number().int().positive()
});

/** 读一个文件（只用于这条会话自己的附件），超过 maxBytes 由 Worker 拒。 */
export const readFileCommandSchema = z.object({
  kind: z.literal('read_file'),
  requestId: z.string(),
  path: z.string(),
  maxBytes: z.number().int().positive()
});

/** hub 对 tool_request 的答复：list 给 tools，call 给 value（JSON），失败给 error。 */
export const toolResponseCommandSchema = z.object({
  kind: z.literal('tool_response'),
  requestId: z.string(),
  ok: z.boolean(),
  tools: z
    .array(z.object({ name: z.string(), description: z.string(), inputSchema: z.record(z.string(), z.unknown()) }))
    .optional(),
  value: z.unknown().optional(),
  error: z.string().optional()
});

export const serverToWorkerSchema = z.discriminatedUnion('kind', [
  toolResponseCommandSchema,
  listDirectoriesCommandSchema,
  makeDirectoryCommandSchema,
  listFilesCommandSchema,
  readFileCommandSchema,
  startSessionCommandSchema,
  z.object({ kind: z.literal('prompt'), sessionId: id, text: z.string(), parts: z.array(promptPartSchema).default([]) }),
  z.object({ kind: z.literal('interrupt'), sessionId: id }),
  /** 让 Worker 把自己更新到 hub 的这个提交。只有提交号，没有任何可拼进命令的自由文本。 */
  z.object({ kind: z.literal('update'), commit: commitShaSchema }),
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
export type ContinueElsewhereRequest = z.infer<typeof continueElsewhereRequest>;
export type SaveLayoutRequest = z.infer<typeof saveLayoutRequest>;
export type AttachmentInputDto = z.infer<typeof attachmentInputSchema>;
export type StoredAttachmentDto = z.infer<typeof storedAttachmentSchema>;
export type ProjectFilesDto = z.infer<typeof projectFilesSchema>;
export type SessionStreamFrame = z.infer<typeof sessionStreamFrameSchema>;
export type WorkerToServer = z.infer<typeof workerToServerSchema>;
export type ServerToWorker = z.infer<typeof serverToWorkerSchema>;

export type ToolRequestFrame = z.infer<typeof workerToolRequestSchema>;
export type ToolResponseCommand = z.infer<typeof toolResponseCommandSchema>;
