import { z } from 'zod';
import { id, epochMs } from './common.ts';
import { attachmentInputSchema, pointSchema, projectSchema, sessionEventSchema, sessionStatusSchema, sizeSchema, taskStatusSchema } from './entities.ts';

/** HTTP API 的请求与响应。 */

// ---- 请求 ----

/** 删除项目：项目名得一字不差地再输一遍。 */
export const deleteProjectRequest = z.object({ confirmName: z.string().min(1).max(500) });

export const createProjectRequest = z.object({
  name: z.string().min(1).max(80),
  /** 不给 / 空串 = 先不选目录：开始任务时再选机器和工作空间。 */
  rootPath: z.string().optional(),
  workerId: z.string().min(1).nullable().optional(),
  /** 可选的 git 仓库：以后新建工作空间时 clone 它。 */
  repoUrl: z.string().max(500).nullable().optional(),
  defaultBranch: z.string().max(200).nullable().optional(),
  /** 可选的项目说明（markdown），会交给 agent。 */
  description: z.string().max(8000).nullable().optional()
});

/** 改项目说明：null 或空串 = 清掉。 */
export const setProjectDescriptionRequest = z.object({ description: z.string().max(8000).nullable() });

/** 绑定 / 改 / 解除项目仓库：repoUrl 为 null 或空串 = 解除。 */
export const setProjectRepoRequest = z.object({
  repoUrl: z.string().max(500).nullable(),
  defaultBranch: z.string().max(200).nullable().optional()
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
  workerId: z.string().min(1).nullable().optional(),
  /** 运行面板里选的工作空间；会话跟着它落到那台机器、那个目录。 */
  workspaceId: z.string().min(1).nullable().optional()
});

/** 新建工作空间：持久的（新建托管目录 / 关联已有目录）或临时的（为某个任务开 worktree / 临时目录）。 */
export const createWorkspaceRequest = z.discriminatedUnion('kind', [
  z.object({
    workerId: z.string().min(1).nullable().default(null),
    kind: z.literal('long_lived'),
    mode: z.enum(['create', 'link']),
    path: z.string().optional()
  }),
  z.object({
    workerId: z.string().min(1).nullable().default(null),
    kind: z.literal('temporary'),
    taskId: id
  })
]);

/** 移除工作空间：只移除登记，或连目录一起删（force = 二次确认过，有改动也删）。 */
export const removeWorkspaceRequest = z.object({
  deleteDirectory: z.boolean().default(false),
  force: z.boolean().default(false)
});

export const workspaceChangesSchema = z.object({
  status: z.object({
    dirty: z.boolean().nullable(),
    untracked: z.number(),
    unpushed: z.number(),
    branch: z.string().nullable(),
    upstream: z.string().nullable()
  }),
  reason: z.string().nullable()
});

export const forkSessionRequest = z.object({
  sessionId: id,
  atSeq: z.number().int().positive(),
  agentId: id,
  // 空字符串 = 用 agent 自己的默认模型（见 apps/web 的派生对话框）
  model: z.string()
});

/** 换个地方继续：已有工作空间，或在某台机器上新开临时工作空间；可选先提交 WIP 并推送分支。 */
export const continueElsewhereRequest = z.object({
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('workspace'), workspaceId: id }),
    z.object({ kind: z.literal('temporary'), workerId: z.string().min(1).nullable().default(null) })
  ]),
  saveWip: z.boolean().default(false)
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
  /** 每个 agent 在这台机器上的模型清单：派生对话框按选中的机器列模型。 */
  agentModels: z.array(z.object({ agentId: z.string(), models: z.array(z.string()), defaultModel: z.string() })).optional(),
  hostname: z.string().optional(),
  platform: z.string().optional(),
  roots: z.array(z.string()).optional(),
  lastSeenAt: epochMs.optional(),
  sessionCount: z.number().int().nonnegative().optional()
});

/** 改一项可调项：值可以是模型串、也可以是思考强度的档位名。 */
export const changeOptionRequest = z.object({
  optionId: z.string().min(1),
  value: z.union([z.string(), z.boolean()])
});
