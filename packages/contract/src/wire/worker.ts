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
// v3（#221 步骤 7）：start_session / session 帧的 taskId 允许为 null（容器会话）。
// 旧 Worker 会把这帧判成非法并「未知会话」，会话因此静默不响应——所以必须换版本，
// 让旧 Worker 连不上并在日志里说清「运行 scripts/update-worker.sh」。
// v4（#223）：start_session 的 assetIds 缺省不再表示「机器上装着的全给」，而是一个都不给；
// hub 总是显式下发（可能是空数组）。v3 Worker 仍按旧语义全给，所以必须换版本让它们先升级。
// v5：start_session 可以带 pinned（常驻会话不按空闲回收）；旧 Worker 会忽略它，
// 语义变成「不常驻」，所以换版本让它们先升级，别让界面上的常驻变成谎话。
// v6：新增会话服务（ws.service_* 方法 + service_state / service_log 帧）。旧 Worker 不认识这些方法，
// 会回 unsupported；hub 侧表现为「这台机器的 Worker 太旧」，所以一并换版本。
// v7（#226 P4）：assets.sync 可以带 sessions（会话 → assetId 列表），Worker 在 sessions/<id>/ 下建
// 每会话视图并回报 views；旧 Worker 会直接忽略这个字段、继续只维护兼容链接，会话仍能起来但
// 换钉 / 卸载会影响到运行中的会话，所以换版本让它们先升级。
export const PROTOCOL_VERSION = 7;
export const PROTOCOL_MISMATCH_CLOSE = 4426;
export const WORKER_CAPABILITY_SESSION_START_READY = 'session_start_ready';

/** 一份代码的身份：package 版本 + git 提交（不在 git 仓库里就是 null）+ 协议版本。 */
export const buildInfoSchema = z.object({
  version: z.string().max(64),
  commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  protocol: z.number().int().nonnegative()
});

/** git 完整提交号：更新指令唯一的参数，不接受任何其他形式的输入。 */
export const commitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

export const updateStateSchema = z.enum(['updating', 'trial', 'succeeded', 'failed', 'refused', 'rolled_back']);

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
  capabilities: z.array(z.string().max(64)).max(32).optional(),
  /** Agent ids whose branch start returns exact runtime attestation on this connection. */
  branchAttemptAgents: z.array(id).max(256).optional(),
  /** 上次断线期间 outbox 满了丢掉的帧数（ADR 0030 D1）；hub 记日志并在界面上提示。 */
  dropped: z.number().int().nonnegative().optional(),
  /** releases 布局下刚换上的新版本（ADR 0030 D2）：等 hub 观察后下发 update_commit / update_abort。 */
  update: z
    .object({
      id: z.string().regex(/^[a-z0-9-]{1,64}$/),
      phase: z.literal('trial'),
      /** false = 这台不发 inventory（WORKER_INVENTORY=0），提交条件里不等它。 */
      inventory: z.boolean().default(true)
    })
    .optional()
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

/** ADR 0028：仅带可证实的 deliveryId 才能用于 Hub 原生分叉，旧帧保留解码。 */
export const workerTurnRefSchema = z.object({
  type: z.literal('turn_ref'),
  sessionId: id,
  turnRef: z.string().min(1).max(512),
  deliveryId: z.string().min(1).max(128).optional()
});

/** ADR 0028：带 branch 的 start_session 结果。failed = 原生分叉没成，worker 已改成新开一条空会话，hub 补发摘要交接。 */
export const workerBranchResultSchema = z.object({
  type: z.literal('branch_result'),
  sessionId: id,
  outcome: z.enum(['native', 'failed']),
  reason: z.string().max(2000).optional()
});

export const branchAttemptIdSchema = z.string().min(1).max(128);
export const startAttemptIdSchema = z.string().min(1).max(128);
export const workerSessionStartResultSchema = z.object({
  type: z.literal('session_start_result'),
  sessionId: id,
  startAttemptId: startAttemptIdSchema,
  state: z.enum(['ready', 'failed', 'ended']),
  reason: z.enum(['runtime', 'configuration']).optional()
});
export const workerPromptStartRefusedSchema = z.object({
  type: z.literal('prompt_start_refused'),
  sessionId: id,
  startAttemptId: startAttemptIdSchema,
  deliveryId: z.string().min(1).max(128)
});
export const branchAgentSessionRefSchema = z.string().refine(
  (ref) => ref.trim().length > 0 && ref.trim().toLowerCase() !== 'pending' && new TextEncoder().encode(ref).length <= 512,
  'invalid attested agent session ref'
);
const attemptResultBase = { type: z.literal('branch_attempt_result'), sessionId: id, attemptId: branchAttemptIdSchema };
export const workerBranchAttemptResultSchema = z.discriminatedUnion('outcome', [
  z.object({ ...attemptResultBase, outcome: z.literal('native'), agentSessionRef: branchAgentSessionRefSchema }).strict(),
  z.object({ ...attemptResultBase, outcome: z.literal('plain'), agentSessionRef: branchAgentSessionRefSchema }).strict(),
  z.object({ ...attemptResultBase, outcome: z.literal('both_failed') }).strict()
]);

/** worker 把 agent 报上来的可调项当前值交回 server，好让重开浏览器时选择器不空着。 */
export const workerOptionsSchema = z.object({
  type: z.literal('options'),
  sessionId: id,
  options: z.array(runtimeOptionSchema)
});

/**
 * worker 关于「这条会话还在不在我这儿」的汇报。
 * `running` / `idle` / `ended` / `gone` 说的是**托管状态**，不是领域状态——领域状态由事件决定。
 *
 * `idle`：这一轮结束了，但 agent 进程还活着、还能接着提问（保活）。
 * 回合结束的事件仍然是 `ended`（那是回合事件）；`status:'ended'` 留给真结束：
 * 进程退出、dispose、worker 关闭、空闲回收。
 */
export const workerStatusSchema = z.object({
  type: z.literal('status'),
  sessionId: id,
  status: z.enum(['running', 'idle', 'ended', 'gone']),
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
export const runtimeVersionSchema = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z][0-9A-Za-z.-]{0,39})?$/);
export const runtimeAgentIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export const runtimeActionSchema = z.enum(['install', 'uninstall', 'switch']);
/** 组件任务（ADR 0021 P2）：复用 runtime_job，多两个 action。只发给清单里报了 componentInstall 的 Worker。 */
export const runtimeJobActionSchema = z.enum(['install', 'uninstall', 'switch', 'install_component', 'uninstall_component']);
const capabilityEntry = z.object({
  capability: z.string().regex(/^[a-z][a-z0-9-]*(:[a-z0-9][a-z0-9._-]*)+$/).max(128),
  mode: z.string().max(64).optional(),
  mcp: z.object({ name: z.string().max(64), executableArg: z.string().max(64) }).optional()
});
const strategyId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const strategyArg = z.string().min(1).max(256);
const binaryLocateSchema = z.object({
  envRoot: z.string().max(128).optional(),
  homeSubdir: z.string().max(256).optional(),
  directoryPrefixes: z.array(z.string().min(1).max(256)).min(1).max(16).readonly(),
  excludeDirectoryPrefixes: z.array(z.string().min(1).max(256)).max(16).readonly().optional(),
  binaries: z.array(z.string().min(1).max(256)).min(1).max(16).readonly()
});
export const acquisitionStrategySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('detect-system-binary'),
    id: strategyId,
    names: z.array(z.string().min(1).max(128)).max(32).readonly().optional(),
    paths: z.array(z.string().min(1).max(512)).max(32).readonly().optional(),
    verify: z.object({ args: z.array(strategyArg).max(16).readonly() }).optional()
  }),
  z.object({
    type: z.literal('user-space-install'),
    id: strategyId,
    args: z.array(strategyArg).min(1).max(16).readonly(),
    locate: binaryLocateSchema,
    checkLibs: z.boolean().optional()
  }),
  z.object({
    type: z.literal('lighter-variant'),
    id: strategyId,
    args: z.array(strategyArg).min(1).max(16).readonly(),
    fallbackArgs: z.array(strategyArg).max(16).readonly().optional(),
    locate: binaryLocateSchema,
    checkLibs: z.boolean().optional()
  }),
  z.object({
    type: z.literal('requires-root'),
    id: strategyId,
    command: z.string().min(1).max(128),
    args: z.array(strategyArg).max(16).readonly().optional()
  })
]);
export const acquisitionResolutionSchema = z.object({
  strategy: z.string().min(1).max(64),
  type: z.enum(['detect-system-binary', 'user-space-install', 'lighter-variant', 'requires-root']),
  path: z.string().min(1).max(512).optional(),
  capability: z.string().max(128).optional(),
  componentId: z.string().max(64).optional()
});
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
  expectedCurrent: runtimeVersionSchema.nullable(),
  strategies: z.array(acquisitionStrategySchema).max(8).readonly().optional()
});
/** 组件任务结束时的结构化结果：hub 据此写审计（bundle.script_skipped / bundle.integrity_mismatch）。 */
export const componentJobResultSchema = z.object({
  integrity: z.string().max(200).optional(),
  integrityMismatch: z.boolean().optional(),
  ignoredScripts: z.boolean().optional(),
  scripts: z.array(z.object({ package: z.string().max(214), script: z.string().max(32) })).max(200).optional(),
  missingDeps: z.array(z.string().max(128)).max(64).optional(),
  acquisition: acquisitionResolutionSchema.optional(),
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
  capabilities: z.array(z.object({ capability: z.string().max(128), mode: z.string().max(64).optional(), via: z.string().max(214), mcp: z.object({ name: z.string().max(64), executableArg: z.string().max(64) }).optional() })).max(200),
  collectedAt: z.number().int().nonnegative(),
  /** 这台 Worker 能接组件任务（P2）。P1 的 Worker 不报 = hub 不给它发。 */
  componentInstall: z.boolean().optional(),
  /** 能接整套安装（P3）。 */
  bundleInstall: z.boolean().optional(),
  /** 已选定的能力获取结果。 */
  acquisitions: z.array(acquisitionResolutionSchema).max(32).optional()
});
export const workerInventoryFrameSchema = z.object({ type: z.literal('inventory'), inventory: workerInventorySchema });

/**
 * 终端输出（docs/design/terminal.md）：worker 主动推、没有回复，所以不走 RPC。
 * data 为 base64，单帧 ≤64 KB 原始数据；老 hub 不认只记日志。
 */
const terminalId = z.string().min(1).max(120);

export const workerTerminalDataSchema = z.object({
  type: z.literal('terminal_data'),
  terminalId,
  data: z.string().max(131_072)
});

export const workerTerminalExitSchema = z.object({
  type: z.literal('terminal_exit'),
  terminalId,
  code: z.number().int(),
  signal: z.number().int().optional()
});

/** 会话服务（docs/design/session-service.md §4）：状态与日志都主动推，不走 RPC。 */
const serviceId = z.string().regex(/^svc_[0-9a-f]{8}$/);

export const workerServiceStateSchema = z.object({
  type: z.literal('service_state'),
  serviceId,
  state: z.enum(['starting', 'running', 'failed', 'stopped']),
  pid: z.number().int().positive().nullable().optional(),
  detail: z.string().max(500).nullable().optional(),
  port: z.number().int().min(1024).max(65535).nullable().optional()
});

export const workerServiceLogSchema = z.object({
  type: z.literal('service_log'),
  serviceId,
  chunk: z.string().max(16_384)
});

export const workerToServerSchema = z.union([
  workerInventoryFrameSchema,
  workerTerminalDataSchema,
  workerTerminalExitSchema,
  workerServiceStateSchema,
  workerServiceLogSchema,
  workerHelloSchema,
  workerAgentsSchema,
  workerEnrollSchema,
  workerRpcSchema,
  workerEventSchema,
  workerAgentSessionSchema,
  workerTurnRefSchema,
  workerBranchResultSchema,
  workerBranchAttemptResultSchema,
  workerSessionStartResultSchema,
  workerPromptStartRefusedSchema,
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

/**
 * hub 模型定义（provider 帧与 provider_update 帧共用；worker 帧里只有模型本身，不带密钥和地址）。
 * extra 是合并进上游请求体的额外参数（即时生效）；contextWindow / maxTokens 只在下次启动时写进 agent 配置。
 */
export const providerModelsSchema = z
  .array(z.object({ id: z.string(), name: z.string().optional(), contextWindow: z.number().optional(), maxTokens: z.number().optional(), extra: z.record(z.string(), z.unknown()).optional() }))
  .max(100);

export const startSessionCommandSchema = z.object({
  kind: z.literal('start_session'),
  sessionId: id,
  /** 容器会话（#221 步骤 7）不属于任何任务；运行时不读这个字段。 */
  taskId: id.nullable(),
  agentId: id,
  workspaceRoot: z.string(),
  origin: sessionOriginSchema,
  resume: z
    .object({ agentSessionRef: z.string().nullable(), cursor: z.number().int().nonnegative() })
    .nullable(),
  /** 开跑前就定下的可调项；空对象表示全用 agent 默认。 */
  options: optionValuesSchema,
  /**
   * ADR 0028 原生分叉：从来源 agent 会话的某一轮之前分出一条新 agent 会话（resume 为 null 时才有）。
   * hub 只在 agent 报了 branch_at_turn（新 worker）时才给，老 worker 不会收到。
   */
  branch: z
    .object({
      fromAgentSessionRef: z.string().min(1).max(512),
      turnRef: z.string().min(1).max(512).nullable(),
      previousTurnRef: z.string().min(1).max(512).nullable()
    })
    .optional(),
  branchAttemptId: branchAttemptIdSchema.optional(),
  startAttemptId: startAttemptIdSchema.optional(),
  /** 能力层（可选）：旧 worker 收不到就当没有工具。token 不许进日志。 */
  tools: toolAccessSchema.optional(),
  /** MCP 资产（旧 worker 忽略）。stdio 的 env 含密钥明文：只进 agent 进程，不落盘、不进日志。 */
  mcp: z.array(mcpLaunchSchema).max(50).optional(),
  /** 这次会话生效的资产（项目作用域算好的）。v4 起缺省 = 一个都不给；旧 hub 不带就按空集处理。 */
  assetIds: z.array(z.string()).max(500).optional(),
  /** #226 E4c：assetId → digest。给了就按这一版加载，不许漂到新版本。 */
  assetDigests: z.record(z.string(), z.string()).optional(),
  /** 常驻：不按空闲回收、不占保活上限（任务里长期用的那条会话）。 */
  pinned: z.boolean().optional(),
  /** hub 模型提供商（旧 worker 忽略）。apiKey 只交给 worker 本机中继：不进 agent、不落盘、不进日志。 */
  provider: z
    .object({
      slug: z.string().min(1).max(31),
      name: z.string().max(80),
      protocol: z.enum(['openai-chat', 'openai-responses', 'anthropic']),
      baseUrl: z.string().min(1).max(2000),
      apiKey: z.string().min(1).max(4096),
      models: providerModelsSchema,
      via: z.enum(['direct', 'hub'])
    })
    .optional()
});

/** 自定义运行时别名（CAP-1）的 wire 结构：和领域里的 AgentAlias 同形，五个字段。不带 env。 */
export const agentAliasSchema = z.object({
  id: z.string().min(1).max(41),
  label: z.string().min(1).max(80),
  command: z.string().min(1).max(512),
  args: z.array(z.string().max(512)).max(64),
  models: z.array(z.string().max(200)).max(128).optional(),
  defaultModel: z.string().max(200).optional()
});

export const serverToWorkerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rpc'), frame: rpcFrameSchema }),
  /** 配对码换到的专属凭据：只出现在 enroll 握手的那条连接上，发完就关。 */
  z.object({ kind: z.literal('enrolled'), workerId: id, credential: z.string().min(1) }),
  /** 轮换凭据（ADR 0030 D3）：Worker 写进 worker.env 后用它重连；旧凭据宽限 5 分钟。明文只在这一帧里。老 worker 不认，只记一条日志（轮换会超时失败、旧凭据保留）。 */
  z.object({ kind: z.literal('credential_rotate'), credential: z.string().min(1).max(256) }),
  /** 试运行通过：Worker 把 update.json 记为 committed（ADR 0030 D2）。 */
  z.object({ kind: z.literal('update_commit'), id: z.string().regex(/^[a-z0-9-]{1,64}$/) }),
  /** 试运行没通过：Worker 切回 previous 后重启。 */
  z.object({ kind: z.literal('update_abort'), id: z.string().regex(/^[a-z0-9-]{1,64}$/), reason: z.string().max(300) }),
  /** hello 被接受了。worker 等到它才补发积压的帧：在这之前发的帧 server 一律不认（见 server-gateway）。 */
  z.object({
    kind: z.literal('welcome'),
    /** hub 愿意收的可选帧；老 hub 不带 = 都别发（不升协议版本，见 ADR 0014）。 */
    accepts: z.array(z.string().max(64)).max(32).optional(),
    /** 心跳参数（ADR 0030 D1）：Worker 据此设看门狗。老 hub 不带 = 用 Worker 自己的默认。 */
    heartbeat: z
      .object({ intervalMs: z.number().int().min(1_000).max(300_000), missLimit: z.number().int().min(1).max(10), echoMs: z.number().int().min(1_000).max(600_000) })
      .optional(),
    /** 这台机器凭据允许的能力（ADR 0030 D3）。Worker 据此拒绝越权请求；老 hub 不带 = 不限。 */
    capabilities: z.array(z.string().max(32)).max(16).optional()
  }),
  startSessionCommandSchema,
  z.object({ kind: z.literal('prompt'), sessionId: id, text: z.string(), parts: z.array(promptPartSchema).default([]), deliveryId: z.string().max(128).optional(), startAttemptId: startAttemptIdSchema.optional() }),
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
    /** switch 的目标（machine / hub）；只对 switch 有意义，老 Worker 不认就忽略。 */
    source: z.enum(['machine', 'hub']).optional(),
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
  /**
   * 自定义运行时别名（CAP-1）：worker 用它重建 harness 注册表，新建会话生效、正在跑的会话不动。
   * 空数组 = 回到 ACP_AGENTS 环境变量。老 worker 不认，只记一条日志（现有逻辑）。
   */
  z.object({ kind: z.literal('agent_config'), aliases: z.array(agentAliasSchema).max(16) }),
  z.object({
    kind: z.literal('set_option'),
    sessionId: id,
    optionId: z.string(),
    value: z.union([z.string(), z.boolean()])
  }),
  /**
   * 会话进行中热更新模型定义（只换 extra 这类请求参数，不重启 agent）。
   * 不带 apiKey / baseUrl：密钥不二次下发。老 worker 不认，只记一条日志（hub 尽力而为，不影响会话）。
   */
  z.object({ kind: z.literal('provider_update'), sessionId: id, models: providerModelsSchema }),
  /** 终端键盘输入（base64）。老 worker 不认，只记一条日志。 */
  z.object({ kind: z.literal('terminal_input'), terminalId, data: z.string().max(131_072) })
]);
