import { z } from 'zod';
import { rpcFrameSchema } from '../rpc/frames.ts';
import { id } from './common.ts';
import { workerMetricsSchema } from './resources.ts';
import { agentSchema, optionValuesSchema, promptPartSchema, runtimeOptionSchema, sessionEventSchema, sessionOriginSchema } from './entities.ts';

/** hub ↔ worker 长连接协议：握手、上下行帧、更新。 */

/**
 * Worker 通道的协议版本。帧格式有不兼容的改动才加一；hub 只接受同一个协议版本的 Worker，
 * 不一致时用关闭码 4426 拒绝并说明原因（Worker 收到后停止重连，提示手动更新）。
 */
export const PROTOCOL_VERSION = 2;
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
  /** 单台机器接入换来的专属凭据（`ahw_…`）；有它就不需要共享 HUB_TOKEN。 */
  credential: z.string().optional(),
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
  build: buildInfoSchema.optional(),
  /** 这台 Worker 会发哪些可选帧（如 'metrics'）。老 Worker 不报 = 都不会。 */
  capabilities: z.array(z.string().max(64)).max(32).optional()
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
 * worker 关于「这条会话还在不在我这儿」的汇报。
 * `running` / `ended` / `gone` 说的是**托管状态**，不是领域状态——领域状态由事件决定。
 */
export const workerStatusSchema = z.object({
  type: z.literal('status'),
  sessionId: id,
  status: z.enum(['running', 'ended', 'gone']),
  reason: z.string().optional()
});

/** 承载 RPC 通道的信封（见 rpc/）：MCP 中转、目录 / 文件这类请求-回复都走它，不再各自造帧。 */
export const workerRpcSchema = z.object({ type: z.literal('rpc'), frame: rpcFrameSchema });

/**
 * 接入握手：新机器连上 /worker 的第一帧不是 hello 而是 enroll，拿一次性配对码换专属凭据。
 * hub 回 `enrolled` 后关闭这条连接；worker 存好凭据再用 hello 正式连。
 */
export const workerEnrollSchema = z.object({
  type: z.literal('enroll'),
  code: z.string().min(1),
  label: z.string().min(1).max(80),
  host: z.object({ hostname: z.string(), platform: z.string(), arch: z.string() }).optional(),
  protocol: z.number().int().optional()
});

/** 重新探测后 agent 清单（就绪状态 / 模型）变了：整份替换 hello 里报的那份。老 hub 不认，只记一条日志。 */
export const workerAgentsSchema = z.object({
  type: z.literal('agents'),
  agents: z.array(agentSchema)
});

/** 版本号与 agent id 都会进命令参数和路径：只收固定形状（与 domain RUNTIME_VERSION / RUNTIME_AGENT_ID 同）。 */
export const runtimeVersionSchema = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.]{1,32})?$/);
export const runtimeAgentIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export const runtimeActionSchema = z.enum(['install', 'uninstall']);
/** 组件任务（ADR 0021 P2）：复用 runtime_job，多两个 action。只发给清单里报了 componentInstall 的 Worker。 */
export const runtimeJobActionSchema = z.enum(['install', 'uninstall', 'install_component', 'uninstall_component']);
const capabilityEntry = z.object({ capability: z.string().regex(/^[a-z][a-z0-9-]*(:[a-z0-9][a-z0-9._-]*)+$/).max(128), mode: z.string().max(64).optional() });
/** 组件任务的规格：全是固定形状，没有可拼进命令的自由文本。 */
export const componentJobSpecSchema = z.object({
  componentId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  runtime: z.enum(['pi', 'opencode']),
  /** git 来源（P4）：https 地址 + 40 位提交号；没有就是 npm。 */
  git: z
    .object({ url: z.string().regex(/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9._~\/-]{1,300}$/), commit: z.string().regex(/^[0-9a-f]{40}$/) })
    .optional(),
  packageName: z.string().regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,213}$/),
  version: runtimeVersionSchema,
  resolved: z.string().max(500).refine((v) => /^(https?:\/\/|git\+https:\/\/)/.test(v)),
  integrity: z.string().regex(/^(sha512-[A-Za-z0-9+/]{86}==|git:[0-9a-f]{40})$/),
  provides: z.array(capabilityEntry).max(16),
  /** 恒为 true（ADR 0021 决定 8：安装脚本一律不执行）。保留字段是为了让旧版 Worker 也加 --ignore-scripts。 */
  ignoreScripts: z.literal(true),
  expectedCurrent: runtimeVersionSchema.nullable()
});
/** 组件任务结束时的结构化结果：hub 据此写审计（bundle.script_skipped / bundle.integrity_mismatch）。 */
export const componentJobResultSchema = z.object({
  integrity: z.string().max(200).optional(),
  integrityMismatch: z.boolean().optional(),
  ignoredScripts: z.boolean().optional(),
  scripts: z.array(z.object({ package: z.string().max(214), script: z.string().max(32) })).max(200).optional(),
  exitCode: z.number().int().nullable().optional(),
  durationMs: z.number().int().nonnegative().optional()
});
export const runtimeJobStateSchema = z.enum(['running', 'succeeded', 'failed', 'refused']);

/** Worker 回报安装 / 卸载任务的进度：lines 是这一批新增的日志行（增量）。 */
export const workerRuntimeJobStatusSchema = z.object({
  type: z.literal('runtime_job_status'),
  jobId: id,
  state: runtimeJobStateSchema,
  message: z.string().max(500),
  lines: z.array(z.string().max(2000)).max(500).default([]),
  /** 结束时装好的版本（卸载为 null）。 */
  version: z.string().max(64).nullable().optional(),
  component: componentJobResultSchema.optional()
});

/** 运行时套件清单（ADR 0021 §7）：连上时、每个运行时任务结束后、每 6 小时报一次。老 hub 不认，只记一条日志。 */
export const workerInventorySchema = z.object({
  runtimes: z
    .array(z.object({ agentId: z.string().max(64), version: z.string().max(64), source: z.enum(['machine', 'hub']) }))
    .max(32),
  components: z
    .array(
      z.object({
        id: z.string().max(214),
        runtime: z.string().max(64),
        version: z.string().max(64),
        integrity: z.string().max(200),
        enabled: z.boolean(),
        managedBy: z.enum(['hub', 'external']),
        source: z.string().max(300).optional()
      })
    )
    .max(200),
  capabilities: z.array(z.object({ capability: z.string().max(128), mode: z.string().max(64).optional(), via: z.string().max(214) })).max(200),
  collectedAt: z.number().int().nonnegative(),
  /** 这台 Worker 能接组件任务（P2）。P1 的 Worker 不报 = hub 不给它发。 */
  componentInstall: z.boolean().optional(),
  /** 能接整套安装（P3）。 */
  bundleInstall: z.boolean().optional()
});
export const workerInventoryFrameSchema = z.object({ type: z.literal('inventory'), inventory: workerInventorySchema });

export const workerToServerSchema = z.discriminatedUnion('type', [
  workerInventoryFrameSchema,
  workerHelloSchema,
  workerAgentsSchema,
  workerEnrollSchema,
  workerRpcSchema,
  workerEventSchema,
  workerAgentSessionSchema,
  workerOptionsSchema,
  workerStatusSchema,
  workerUpdateStatusSchema,
  workerRuntimeJobStatusSchema,
  workerMetricsSchema
]);

/**
 * relay（唯一传输）：agent 连 worker 本机的 MCP 入口，worker 经 /worker 长连接的 RPC 通道转给 hub，url 由 worker 填。
 */
export const toolAccessSchema = z.object({
  transport: z.literal('relay'),
  url: z.string().default(''),
  token: z.string().min(1)
});

export const mcpLaunchSchema = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('stdio'),
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string())
  }),
  z.object({ transport: z.literal('http'), name: z.string().min(1), url: z.string().default('') })
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
  options: optionValuesSchema,
  /** 能力层（可选）：旧 worker 收不到就当没有工具。token 不许进日志。 */
  tools: toolAccessSchema.optional(),
  /** MCP 资产（旧 worker 忽略）。stdio 的 env 含密钥明文：只进 agent 进程，不落盘、不进日志。 */
  mcp: z.array(mcpLaunchSchema).max(50).optional(),
  /** 这次会话生效的资产（项目作用域算好的）；没有 = 旧 hub，机器上装着的全给。 */
  assetIds: z.array(z.string()).max(500).optional(),
  /** hub 模型提供商（旧 worker 忽略）。apiKey 只交给 worker 本机中继：不进 agent、不落盘、不进日志。 */
  provider: z
    .object({
      slug: z.string().min(1).max(31),
      name: z.string().max(80),
      protocol: z.enum(['openai-chat', 'openai-responses', 'anthropic']),
      baseUrl: z.string().min(1).max(2000),
      apiKey: z.string().min(1).max(4096),
      models: z.array(z.object({ id: z.string(), name: z.string().optional(), contextWindow: z.number().optional(), maxTokens: z.number().optional() })).max(100),
      via: z.enum(['direct', 'hub'])
    })
    .optional()
});

export const serverToWorkerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rpc'), frame: rpcFrameSchema }),
  /** 配对码换到的专属凭据：只出现在 enroll 握手的那条连接上，发完就关。 */
  z.object({ kind: z.literal('enrolled'), workerId: id, credential: z.string().min(1) }),
  /** hello 被接受了。worker 等到它才补发积压的帧：在这之前发的帧 server 一律不认（见 server-gateway）。 */
  z.object({
    kind: z.literal('welcome'),
    /** hub 愿意收的可选帧；老 hub 不带 = 都别发（不升协议版本，见 ADR 0014）。 */
    accepts: z.array(z.string().max(64)).max(32).optional()
  }),
  startSessionCommandSchema,
  z.object({ kind: z.literal('prompt'), sessionId: id, text: z.string(), parts: z.array(promptPartSchema).default([]) }),
  z.object({ kind: z.literal('interrupt'), sessionId: id }),
  /** 手动压缩上下文（ADR 0020）。老 worker 不认，只记一条日志。 */
  z.object({ kind: z.literal('compact'), sessionId: id, instructions: z.string().max(2000).optional() }),
  /** 让 Worker 把自己更新到 hub 的这个提交。只有提交号，没有任何可拼进命令的自由文本。 */
  z.object({ kind: z.literal('update'), commit: commitShaSchema }),
  /** 装 / 卸一个 agent 运行时（ADR 0010）。安装器是 Worker 上的白名单适配器，这里只有 id 和版本号。老 worker 不认，只记一条日志。 */
  z.object({
    kind: z.literal('runtime_job'),
    jobId: id,
    agentId: runtimeAgentIdSchema,
    action: runtimeJobActionSchema,
    version: runtimeVersionSchema.nullable(),
    component: componentJobSpecSchema.optional(),
    /** 整套安装（P3）：全部装进暂存并核对通过才一起切换。只发给报了 bundleInstall 的 Worker。 */
    components: z.array(componentJobSpecSchema).min(1).max(16).optional()
  }),
  z.object({ kind: z.literal('dispose'), sessionId: id }),
  /** 回答运行时的批准请求（ADR 0023）。老 worker 不认，只记一条日志。 */
  z.object({
    kind: z.literal('approval'),
    sessionId: id,
    approvalId: z.string().min(1).max(256),
    decision: z.enum(['allow', 'deny']),
    author: z.object({ id: z.string().max(200), name: z.string().max(200) }).optional()
  }),
  /** 「重新检测」：让 worker 立刻重新探测各 harness 是否可用。老 worker 不认，只记一条日志。 */
  z.object({ kind: z.literal('probe') }),
  z.object({
    kind: z.literal('set_option'),
    sessionId: id,
    optionId: z.string(),
    value: z.union([z.string(), z.boolean()])
  })
]);
