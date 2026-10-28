import { z } from 'zod';
import { rpcFrameSchema } from '../rpc/frames.ts';
import { id } from './common.ts';
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
  build: buildInfoSchema.optional()
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

export const workerToServerSchema = z.discriminatedUnion('type', [
  workerHelloSchema,
  workerAgentsSchema,
  workerEnrollSchema,
  workerRpcSchema,
  workerEventSchema,
  workerAgentSessionSchema,
  workerOptionsSchema,
  workerStatusSchema,
  workerUpdateStatusSchema
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
  mcp: z.array(mcpLaunchSchema).max(50).optional()
});

export const serverToWorkerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rpc'), frame: rpcFrameSchema }),
  /** 配对码换到的专属凭据：只出现在 enroll 握手的那条连接上，发完就关。 */
  z.object({ kind: z.literal('enrolled'), workerId: id, credential: z.string().min(1) }),
  /** hello 被接受了。worker 等到它才补发积压的帧：在这之前发的帧 server 一律不认（见 server-gateway）。 */
  z.object({ kind: z.literal('welcome') }),
  startSessionCommandSchema,
  z.object({ kind: z.literal('prompt'), sessionId: id, text: z.string(), parts: z.array(promptPartSchema).default([]) }),
  z.object({ kind: z.literal('interrupt'), sessionId: id }),
  /** 让 Worker 把自己更新到 hub 的这个提交。只有提交号，没有任何可拼进命令的自由文本。 */
  z.object({ kind: z.literal('update'), commit: commitShaSchema }),
  z.object({ kind: z.literal('dispose'), sessionId: id }),
  /** 「重新检测」：让 worker 立刻重新探测各 harness 是否可用。老 worker 不认，只记一条日志。 */
  z.object({ kind: z.literal('probe') }),
  z.object({
    kind: z.literal('set_option'),
    sessionId: id,
    optionId: z.string(),
    value: z.union([z.string(), z.boolean()])
  })
]);
