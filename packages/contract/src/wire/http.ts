import { workerInventorySchema } from './worker.ts';
import { workerResourcesSchema } from './resources.ts';
import { z } from 'zod';
import { id, epochMs } from './common.ts';
import { agentReadinessSchema, runtimeProvisionSchema, attachmentInputSchema, optionValuesSchema, pointSchema, projectSchema, sessionEventSchema, sessionStatusSchema, sizeSchema, taskStatusSchema } from './entities.ts';

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
  workspaceId: z.string().min(1).nullable().optional(),
  /** 要求的能力（ADR 0021 §8）：只落到这些能力可信的机器上。 */
  requires: z.array(z.string().regex(/^[a-z][a-z0-9-]*(:[a-z0-9][a-z0-9._-]*)+$/).max(128)).max(16).optional(),
  /** 用一份 Agent 配置启动；profile 里的 agent/model/options 作为默认。 */
  profileId: z.string().min(1).optional(),
  /** 直接指定启动选项；会覆盖 profile 里的同名选项。 */
  options: optionValuesSchema.optional()
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
/** 团队页新建工作空间（ADR 0026）：在团队里建，可选顺手关联一个项目。 */
export const createTeamWorkspaceRequest = z.object({
  workerId: z.string().min(1).nullable().default(null),
  mode: z.enum(['create', 'link']),
  path: z.string().optional(),
  repoUrl: z.string().max(500).optional(),
  branch: z.string().max(200).optional(),
  name: z.string().max(100).optional(),
  projectId: z.string().optional()
});

/** 项目清理规则（ADR 0027 阶段 3 / D6）。 */
export const cleanupPolicyRequest = z.object({
  prMerged: z.boolean().optional(),
  taskEndedClean: z.boolean().optional(),
  idleDays: z.number().int().nullable().optional()
});

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

/** 会话改名；空串 = 清掉。长度上限和领域层一致（SESSION_TITLE_MAX）。 */
export const renameSessionRequest = z.object({ title: z.string().max(200) });

export const forkSessionRequest = z.object({
  sessionId: id,
  /** 已忽略：服务端一律从来源的最新处分叉。留着只为老客户端不报错。 */
  atSeq: z.number().int().positive().optional(),
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
  .object({
    text: z.string(),
    attachments: z.array(attachmentInputSchema).default([]),
    /** 客户端生成的消息 id：同一条消息重试（超时、断网）时带着它，服务端不会重复落库。 */
    clientMessageId: z.string().min(1).max(80).optional()
  })
  .refine((value) => value.text.trim() !== '' || value.attachments.length > 0, { message: '消息不能为空' });

/** `@` 引用选择器：项目内文件的相对路径。 */
export const projectFilesSchema = z.object({ files: z.array(z.string()), truncated: z.boolean() });

export const saveLayoutRequest = z.object({
  positions: z.record(id, pointSchema).optional(),
  sizes: z.record(id, sizeSchema).optional()
});

/** 画布拖线 / 对话页“连接会话”：两端都是同项目会话。 */
export const createSessionLinkRequest = z.object({ aSessionId: id, bSessionId: id });

// ---- 响应 ----

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() })
});

/**
 * 发送回执（design/message-send-feedback.md §5.1）：202 只表示「已接收」，
 * 不代表 agent 已经跑完；真实送达状态看 /deliveries。
 */
export const promptAckSchema = z.object({
  ok: z.literal(true),
  seq: z.number().int(),
  deliveryId: z.string().nullable(),
  state: z.enum(['queued', 'sending'])
});
export type PromptAckDto = z.infer<typeof promptAckSchema>;

/**
 * 会话环境（资产 / MCP / 启动配置）的状态：
 * revision 是「现在重新托管会用的版本」，appliedRevision 是「上次派发成功时记下的版本」。
 * supported=false 表示这个部署没有环境适配器（单测 / 老部署），此时 pending 恒为 false。
 */
export const sessionEnvironmentSchema = z.object({
  revision: z.string().nullable(),
  appliedRevision: z.string().nullable(),
  pending: z.boolean(),
  supported: z.boolean()
});
export type SessionEnvironmentDto = z.infer<typeof sessionEnvironmentSchema>;

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
  modifiedAt: z.number().default(0),
  hidden: z.boolean().default(false)
});
export const directoryListingSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  entries: z.array(directoryEntrySchema),
  /** 在哪台 Worker 上浏览的；null = Server 本机。 */
  workerId: z.string().nullable().default(null),
  /** 这台机器允许浏览的根：面包屑从这里开始，不能再往上。 */
  roots: z.array(z.string()).default([]),
  /** 项目托管目录 `<roots[0]>/agent-hub-workspaces/<slug>`（请求带了项目名才有，不一定已存在）。 */
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
  agentModels: z
    .array(
      z.object({
        agentId: z.string(),
        models: z.array(z.string()),
        defaultModel: z.string(),
        readiness: agentReadinessSchema.optional(),
        provision: runtimeProvisionSchema.optional(),
        providers: z.array(z.enum(['openai-chat', 'openai-responses', 'anthropic'])).optional()
      })
    )
    .optional(),
  hostname: z.string().optional(),
  platform: z.string().optional(),
  roots: z.array(z.string()).optional(),
  lastSeenAt: epochMs.optional(),
  /** 连接健康（ADR 0030 D1）；老 hub 没有。 */
  link: z
    .object({ state: z.enum(['connecting', 'syncing', 'live', 'degraded', 'disconnected', 'rejected']), since: z.number(), rttMs: z.number().nullable(), connectedAt: z.number().nullable() })
    .optional(),
  /** 这次连接的来历（ADR 0030 D3）。 */
  connection: z.object({ connectedAt: z.number(), address: z.string().nullable(), version: z.string().nullable() }).optional(),
  /** 凭据允许的能力；不给 = 不限。 */
  capabilities: z.array(z.string()).optional(),
  /** 最近一次远程更新（含 ADR 0030 D2 的试运行）；日志只给管理员看，这里不带。 */
  update: z
    .object({ state: z.string(), message: z.string(), at: z.number(), trialRemainingMs: z.number().optional() })
    .optional(),
  sessionCount: z.number().int().nonnegative().optional(),
  /** 最近一次运行时安装 / 卸载任务。 */
  runtimeJob: z
    .object({
      jobId: z.string(),
      agentId: z.string(),
      action: z.enum(['install', 'uninstall', 'switch', 'install_component', 'uninstall_component']),
      version: z.string().nullable(),
      componentId: z.string().optional(),
      state: z.enum(['running', 'succeeded', 'failed', 'refused']),
      message: z.string(),
      log: z.string(),
      startedAt: epochMs,
      endedAt: epochMs.nullable(),
      actorEmail: z.string()
    })
    .optional(),
  /** 机器资源（ADR 0014）；老 Worker 不报就没有。 */
  resources: workerResourcesSchema.optional(),
  /** 运行时套件清单（ADR 0021）；老 Worker 不报就没有。 */
  inventory: workerInventorySchema.optional(),
  /** 漂移检测结果：外部组件只列出；missing / mismatch 的能力不可信。 */
  drift: z
    .object({
      items: z.array(
        z.object({
          kind: z.enum(['missing', 'mismatch', 'external', 'unexpected']),
          componentId: z.string(),
          runtime: z.string(),
          expected: z.string().optional(),
          actual: z.string().optional()
        })
      ),
      trusted: z.array(z.object({ capability: z.string(), mode: z.string().optional(), via: z.string() })),
      untrusted: z.array(z.object({ capability: z.string(), mode: z.string().optional(), via: z.string() }))
    })
    .optional()
});

/** 在一台机器上装 / 卸 / 切换 agent 运行时；version 不填 = 推荐版本，switch 要指明 source。 */
export const runtimeJobRequest = z
  .object({
    action: z.enum(['install', 'uninstall', 'switch']),
    version: z
      .string()
      .regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.]{1,32})?$/)
      .optional(),
    /** switch 时必填，其余动作忽略。 */
    source: z.enum(['machine', 'hub']).optional()
  })
  .refine((value) => value.action !== 'switch' || value.source !== undefined, {
    message: 'switch 要指明 source（machine 或 hub）'
  });

/** 组件目录（ADR 0021 P2）：cluster_admin 提交一个确切版本的 npm 包，hub 去 registry 钉死制品。 */
export const componentSubmitRequest = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  packageName: z.string().regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,213}$/),
  version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.]{1,32})?$/),
  provides: z
    .array(z.object({ capability: z.string().regex(/^[a-z][a-z0-9-]*(:[a-z0-9][a-z0-9._-]*)+$/).max(128), mode: z.string().max(64).optional() }))
    .max(16)
    .default([]),
  /** 组件给哪个运行时（P3 起有 opencode 插件）；默认 pi。 */
  runtime: z.enum(['pi', 'opencode']).default('pi'),
  /** git 来源（P4）：https 地址 + 40 位提交号；有它就不查 npm registry。 */
  git: z
    .object({ url: z.string().regex(/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9._~\/-]{1,300}$/), commit: z.string().regex(/^[0-9a-f]{40}$/) })
    .optional()
});
/** 整套安装（P3）：一组目录组件，全有或全无。 */
export const bundleInstallRequest = z.object({
  components: z
    .array(z.object({ componentId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/), version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.]{1,32})?$/) }))
    .min(1)
    .max(16)
});
export const componentReviewRequest = z.object({ approve: z.boolean(), note: z.string().max(500).optional() });
export const componentJobRequest = z.object({
  action: z.enum(['install', 'uninstall']),
  version: z
    .string()
    .regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.]{1,32})?$/)
    .optional()
});
export const catalogComponentSchema = z.object({
  id: z.string(),
  runtime: z.enum(['pi', 'opencode']),
  source: z.enum(['npm', 'git']).optional(),
  gitUrl: z.string().optional(),
  commit: z.string().optional(),
  approvals: z.array(z.object({ by: z.string(), at: epochMs, note: z.string().nullable() })).optional(),
  requiredApprovals: z.number().int().positive().optional(),
  packageName: z.string(),
  version: z.string(),
  resolved: z.string(),
  integrity: z.string(),
  provides: z.array(z.object({ capability: z.string(), mode: z.string().optional() })),
  scripts: z.record(z.string(), z.string()),
  dependencyCount: z.number().int().nonnegative(),
  status: z.enum(['pending', 'approved', 'rejected']),
  submittedBy: z.string(),
  submittedAt: epochMs,
  reviewedBy: z.string().nullable(),
  reviewedAt: epochMs.nullable(),
  reviewNote: z.string().nullable()
});

/** 改一项可调项：值可以是模型串、也可以是思考强度的档位名。 */
export const changeOptionRequest = z.object({
  optionId: z.string().min(1),
  value: z.union([z.string(), z.boolean()])
});
