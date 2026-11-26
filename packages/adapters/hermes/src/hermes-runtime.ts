import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { AsyncQueue } from '@agent-hub/contract';
import {
  conflict,
  createApprovalGate,
  invalid,
  type ApprovalGate,
  err,
  forbidden,
  ok,
  PROVIDER_BASE_URL_ENV,
  PROVIDER_TOKEN_ENV,
  unavailable,
  type AgentRuntime,
  type DomainError,
  type PromptInput,
  type Result,
  type RuntimeSession,
  type SessionAssets,
  type SessionEvent,
  type SessionId,
  type StartSpec
} from '@agent-hub/domain';
import { HermesHttpError, hermesJson, streamRun, submitRun, type HermesEndpoint } from './client.ts';
import { hermesDescriptor } from './descriptor.ts';
import { hermesSessionKey, prepareSessionDir, prepareWorkerHome } from './home.ts';
import { routedModel, startProviderMux, type ProviderMux } from './provider-mux.ts';
import { createHermesEventMapper, type HermesControl } from './map-event.ts';

/** Runs API 里 P1 离不开的几项（/v1/capabilities）。缺一项就不开会话，不猜。 */
export const REQUIRED_FEATURES = ['run_submission', 'run_status', 'run_events_sse', 'run_stop'] as const;

/** 澄清问题的固定回答：hub 里没有人在线答 Hermes 的追问（设计文档 §14.1，保守选择）。 */
/** 旧 Hub 依靠此文字展示未归属的结果未知；新 Hub 使用 outcomeUnknown。 */
export const UNKNOWN_OUTCOME_REASON = 'Hermes 这一轮的结果未知（outcome_unknown）';
const UNKNOWN_OUTCOME_WARNING = '暂未确认这一轮的结果';

/** Hermes 明确报出的终态：只有这些能证明远端这一轮停了。 */
const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled', 'interrupted'] as const;

export const CLARIFY_ANSWER = 'The user is not available to answer right now. Use your best judgment, state your assumption, and continue.';

/**
 * worker 进程环境里像密钥的变量不传给 Hermes：它会顺手认 OPENAI_API_KEY 之类，绕过 hub 中继（D6）。
 * 留下的是 PATH/HOME/LANG 这类；hub 要给的令牌另外显式加。
 */
export function hermesBaseEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/KEY|TOKEN|SECRET|PASS|CREDENTIAL|AUTH/i.test(name)) continue;
    if (/^(API_SERVER_|HERMES_|HUB_|AGENT_HUB_)/.test(name)) continue;
    out[name] = value;
  }
  return out;
}

/** Hermes 装完 Python 依赖会以 75 退出，要求父进程再拉起。只再试一次，避免安装失败时转圈。 */
export function hermesShouldRestart(exitCode: number | null, stderr: string, restarts: number): boolean {
  return exitCode === 75 && restarts < 1 && stderr.includes('Installing Python dependencies');
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

async function instructionsFor(assets: SessionAssets | undefined): Promise<string> {
  if (!assets) return '';
  const parts: string[] = [];
  for (const instruction of assets.instructions) {
    const text = await readFile(instruction.path, 'utf8').catch(() => '');
    if (text.trim()) parts.push(text.trim());
  }
  if (assets.skills.length > 0) {
    parts.push(
      [
        '## Skills',
        'The following skills are available. When a task matches a skill, read its SKILL.md with your file tools first and follow it.',
        ...assets.skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.path})`)
      ].join('\n')
    );
  }
  return parts.join('\n\n');
}

/** Runs API 只收文本：附件写成路径清单附在消息后面（文件已经落在项目目录里）。 */
export function hermesInput(input: PromptInput): string {
  if (input.parts.length === 0) return input.text;
  const lines = input.parts.map((part) => `- ${part.kind === 'image' ? 'image' : 'file'}: ${part.path}`);
  return `${input.text}\n\nAttached files (read them from disk):\n${lines.join('\n')}`;
}

/** 模型选项可能是 `hub-<slug>/<id>`（和 Pi 一样的写法），Hermes 只要后半截。 */
export function hermesModel(spec: StartSpec): string {
  const option = spec.options['model'];
  const models = spec.provider?.models ?? [];
  if (typeof option === 'string' && option !== '') {
    const slash = option.indexOf('/');
    const id = slash > 0 && option.startsWith('hub-') ? option.slice(slash + 1) : option;
    if (models.length === 0 || models.some((model) => model.id === id)) return id;
  }
  return models[0]?.id ?? '';
}

export interface HermesRuntimeOptions {
  readonly command?: string;
  /** hub 管的 Hermes 根目录（见 home.ts）：worker/home 是共用的 HERMES_HOME。 */
  readonly root: string;
  /** 保留给以后：共用网关下暂不配 hub 工具（§17.4）。 */
  readonly toolShim?: { readonly command: string; readonly args: readonly string[] };
  readonly onAgentSessionRef?: (sessionId: string, ref: string) => void;
  readonly log?: (message: string) => void;
  /** 等 API Server 起来的上限。 */
  readonly bootTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/** 一个会话看到的网关：共用的进程 + 带自己 session key 的地址；release 是「我不用了」（最后一个走的关网关）。 */
export interface Gateway {
  readonly child: ChildProcess;
  readonly endpoint: HermesEndpoint;
  /** 每轮 model 前面加的分流路由（provider-mux.ts）；没有就原样发。 */
  readonly route?: string;
  readonly release?: () => Promise<void>;
}

async function waitHealthy(child: ChildProcess, baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Hermes 网关退出了（${child.exitCode ?? child.signalCode}）`);
    const healthy = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) }).then(
      (response) => response.ok,
      () => false
    );
    if (healthy) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Hermes 网关没在时限内起来');
}

interface SharedGateway {
  readonly child: ChildProcess;
  readonly baseUrl: string;
  readonly key: string;
  readonly mux: ProviderMux;
  refs: number;
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  return new Promise<void>((resolve) =>
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    })
  );
}

/**
 * 一个 worker = 一个 Hermes 网关（ADR 0022 D2-A）：一个 HERMES_HOME、127.0.0.1 上的随机端口、随机 API 密钥。
 * 会话之间用 Hermes 自己的会话隔开（每个 hub 会话一个 `ahub-<id>`，每个请求带它的 X-Hermes-Session-Key）。
 * 按会话的中继凭据走 worker 内的分流器（provider-mux.ts）；网关在第一个会话来时起，最后一个会话走时关。
 */
export function createHermesRuntime(options: HermesRuntimeOptions): AgentRuntime {
  const command = options.command ?? 'hermes';
  const log = options.log ?? (() => undefined);
  let shared: Promise<SharedGateway> | null = null;

  async function boot(): Promise<SharedGateway> {
    const { home, cwd } = await prepareWorkerHome(options.root);
    const mux = await startProviderMux();
    const port = await freePort();
    const key = randomBytes(24).toString('hex');
    const env: Record<string, string> = {
      ...hermesBaseEnv(options.env ?? process.env),
      HERMES_HOME: home,
      API_SERVER_ENABLED: 'true',
      API_SERVER_HOST: '127.0.0.1',
      API_SERVER_PORT: String(port),
      API_SERVER_KEY: key,
      [PROVIDER_BASE_URL_ENV]: mux.baseUrl,
      [PROVIDER_TOKEN_ENV]: mux.key
    };
    let child: ChildProcess | null = null;
    let stderrTail = '';
    const baseUrl = `http://127.0.0.1:${port}`;
    let restarts = 0;
    try {
      for (;;) {
        stderrTail = '';
        try {
          child = spawn(command, ['gateway', 'run'], { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
        } catch (error) {
          throw new Error(`无法启动 Hermes：${(error as Error).message}`);
        }
        child.on('error', () => undefined);
        child.setMaxListeners(0); // 每个会话听一次 exit
        child.stderr?.on('data', (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
        });
        try {
          await waitHealthy(child, baseUrl, options.bootTimeoutMs ?? 60_000);
          const caps = await hermesJson<{ features?: Record<string, unknown> }>({ baseUrl, key, sessionKey: 'ahub-probe' }, 'GET', '/v1/capabilities');
          const missing = REQUIRED_FEATURES.filter((feature) => !caps?.features?.[feature]);
          if (missing.length > 0) throw new Error(`这个 Hermes 版本缺 Runs API 能力：${missing.join(', ')}`);
          break;
        } catch (error) {
          const exitCode = child.exitCode;
          await stopChild(child);
          if (hermesShouldRestart(exitCode, stderrTail, restarts)) {
            restarts += 1;
            log('Hermes 装完依赖后退出 75，再启动一次');
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      if (child) await stopChild(child);
      await mux.close();
      log(`Hermes 起不来：${(error as Error).message}${stderrTail ? `\n${stderrTail.split('\n').slice(-5).join('\n')}` : ''}`);
      throw error;
    }
    if (!child) throw new Error('Hermes 没有进程');
    const gateway: SharedGateway = { child, baseUrl, key, mux, refs: 0 };
    child.once('exit', () => {
      // 网关死了：已开的会话各自收尾（HermesSession 听 exit），下一个会话来时重起
      void mux.close();
      if (shared && gatewayOf === gateway) {
        shared = null;
        gatewayOf = null;
      }
    });
    gatewayOf = gateway;
    return gateway;
  }
  let gatewayOf: SharedGateway | null = null;

  async function acquire(): Promise<SharedGateway> {
    if (!shared) {
      shared = boot();
      shared.catch(() => {
        shared = null;
      });
    }
    const gateway = await shared;
    gateway.refs++;
    return gateway;
  }

  async function release(gateway: SharedGateway): Promise<void> {
    gateway.refs--;
    if (gateway.refs > 0) return;
    if (gatewayOf === gateway) {
      shared = null;
      gatewayOf = null;
    }
    await stopChild(gateway.child);
    await gateway.mux.close();
  }

  return {
    descriptor: hermesDescriptor(),
    async start(spec: StartSpec): Promise<Result<RuntimeSession, DomainError>> {
      if (!spec.provider) return err(unavailable('Hermes 只能用 hub 模型提供商：请先在会话里选一个 hub 模型'));
      const model = hermesModel(spec);
      if (!model) return err(unavailable('选的 hub 模型提供商没有模型'));
      let dir: string;
      let gateway: SharedGateway;
      try {
        dir = await prepareSessionDir(options.root, spec.sessionId);
      } catch (error) {
        return err(unavailable(`建不了 Hermes 目录：${(error as Error).message}`));
      }
      try {
        gateway = await acquire();
      } catch (error) {
        return err(unavailable(`Hermes 起不来：${(error as Error).message}`));
      }
      const sessionKey = spec.resume?.agentSessionRef ?? hermesSessionKey(spec.sessionId);
      const endpoint: HermesEndpoint = { baseUrl: gateway.baseUrl, key: gateway.key, sessionKey };
      try {
        await hermesJson(endpoint, 'POST', '/api/sessions', { id: sessionKey }).catch((error: unknown) => {
          // 已经有了 = resume；被别的主人占着 = 拒绝（不接管别人的 Hermes 会话）
          if (error instanceof HermesHttpError && error.status === 409) {
            if (error.code === 'permission_denied') throw new Error('foreign_session');
            return;
          }
          throw error;
        });
      } catch (error) {
        await release(gateway);
        const message = (error as Error).message;
        if (message === 'foreign_session') return err(forbidden('这个 Hermes 会话属于别的主人，hub 不接管'));
        return err(unavailable(`Hermes 开不了会话：${message}`));
      }
      const route = gateway.mux.add({ baseUrl: spec.provider.baseUrl, token: spec.provider.token, models: spec.provider.models });
      if (!spec.resume?.agentSessionRef) options.onAgentSessionRef?.(spec.sessionId, sessionKey);
      const instructions = [workspaceInstructions(spec.workspaceRoot), await instructionsFor(spec.assets)].filter(Boolean).join('\n\n');
      let released = false;
      const session = new HermesSession(
        spec.sessionId,
        {
          child: gateway.child,
          endpoint,
          route,
          release: async () => {
            if (released) return;
            released = true;
            gateway.mux.remove(route);
            await release(gateway);
          }
        },
        model,
        instructions,
        log,
        dir
      );
      await session.reconcile();
      return ok(session);
    }
  };
}

/** 共用网关没有每会话 cwd（§17.3）：把工作区写进每轮的 instructions。 */
export function workspaceInstructions(workspaceRoot: string): string {
  return [
    '## Workspace',
    `Your workspace for this conversation is ${workspaceRoot}.`,
    'Always work inside it: use absolute paths under it for file tools, and start every terminal command with `cd` into it.',
    'Never read or modify files outside it unless the user explicitly asks.'
  ].join('\n');
}

/**
 * 正在提交 / 进行中的一轮记在会话的 HERMES_HOME 里（worker 重启也还在）：
 * - 幂等键：同一条输入在确认收到之前重发，用同一个键（Hermes 只会跑一次）；
 * - 对账：worker 重启后开会话时，按记下的 run_id 查 Hermes，说清上一轮的结局。
 */
export interface PendingTurn {
  readonly key: string;
  readonly inputHash: string;
  readonly runId: string | null;
  readonly at: number;
  /** 这一轮是从哪条送达来的：恢复后收到确认终态时，ended 要带回去才能精确收掉它。老记录没有。 */
  readonly deliveryId?: string;
}
export const PENDING_FILE = 'ahub-pending.json';
const hashInput = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);

export async function readPending(home: string): Promise<PendingTurn | null> {
  try {
    const value = JSON.parse(await readFile(join(home, PENDING_FILE), 'utf8')) as Partial<PendingTurn>;
    if (typeof value.key !== 'string' || typeof value.inputHash !== 'string') return null;
    return {
      key: value.key,
      inputHash: value.inputHash,
      runId: typeof value.runId === 'string' ? value.runId : null,
      at: typeof value.at === 'number' ? value.at : 0,
      ...(typeof value.deliveryId === 'string' && value.deliveryId ? { deliveryId: value.deliveryId } : {})
    };
  } catch {
    return null;
  }
}
async function writePending(home: string, pending: PendingTurn | null): Promise<void> {
  const path = join(home, PENDING_FILE);
  if (!pending) return rm(path, { force: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(pending), { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * 只有**确认的终态**才能把这一轮的 deliveryId 挂到 ended 上。
 * 结果未知 / 事件流耗尽 / 网关进程退出都不证明远端那一轮停了；挂上 id 会让队首的
 * `sending` 被提前放掉，下一句就可能和还在跑的 run 重叠。
 */
function tagEnded(event: SessionEvent, deliveryId: string | undefined): SessionEvent {
  return deliveryId && event.kind === 'ended' ? { ...event, deliveryId } : event;
}

export class HermesSession implements RuntimeSession {
  readonly sessionId: SessionId;
  private readonly gateway: Gateway;
  private readonly model: string;
  private readonly instructions: string;
  private readonly log: (message: string) => void;
  private readonly queue = new AsyncQueue<SessionEvent>();
  private seq = 0;
  /** 这一轮的事件流跟着；`following` 为 false 表示只剩本地闸门（对账结果未知时挡住下一句）。 */
  private run: { id: string; abort: AbortController; following: boolean } | null = null;
  /** 提交窗口的占位：`this.run` 要等 Hermes 回了 run_id 才能设，中间的 await 不能放第二句进来。 */
  private submission: { key: string; inputHash: string; deliveryId?: string } | null = null;
  private submitting = false;
  /** pending 文件的读改写串行化：收尾清记录和新一轮落盘不能互相抢。 */
  private pendingTail: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly home: string | null;
  /** 批准卡（ADR 0023）：人点了才回 Hermes；超时 / 会话关了一律拒绝。id → 这一轮的 run 和 Hermes 的请求号。 */
  private readonly approvals = new Map<string, { runId: string; requestId: string; generation: number }>();
  private readonly gate: ApprovalGate = createApprovalGate({
    push: (event) => this.queue.push(event),
    send: async (id, decision) => {
      const target = this.approvals.get(id);
      this.approvals.delete(id);
      if (!target) return;
      // 只给 once / deny：从不给 session / always，不在 Hermes 里留永久授权
      await hermesJson(this.gateway.endpoint, 'POST', `/v1/runs/${encodeURIComponent(target.runId)}/approval`, {
        request_id: target.requestId,
        execution_generation: target.generation,
        choice: decision === 'allow' ? 'once' : 'deny'
      }).catch((error: unknown) => {
        this.queue.push({ kind: 'diagnostic', level: 'warn', text: `回 Hermes 的批准失败：${(error as Error).message}` });
      });
    }
  });

  constructor(sessionId: SessionId, gateway: Gateway, model: string, instructions: string, log: (message: string) => void, home: string | null = null) {
    this.sessionId = sessionId;
    this.home = home;
    this.gateway = gateway;
    this.model = model;
    this.instructions = instructions;
    this.log = log;
    gateway.child.once('exit', (code, signal) => {
      if (this.disposed) return;
      // 网关进程退出不等于远端那一轮已经停了（Hermes 可能重启后继续跑）：这条 ended 不带
      // deliveryId，hub 那边继续保持 sending、不会放行下一句。
      if (this.run) this.queue.push({ kind: 'ended', outcome: 'interrupted', reason: `Hermes 网关退出了（${code ?? signal}）` });
      // 进程没了就别再对着死端点重连；pending 还在，下次开会话由 reconcile 去查真实状态。
      this.run?.abort.abort();
      this.run = null;
      this.queue.close();
    });
  }

  pid(): number | null {
    return this.gateway.child.pid ?? null;
  }

  events(): AsyncIterable<SessionEvent> {
    return this.queue;
  }

  options() {
    return [];
  }

  async changeOption(): Promise<Result<never, DomainError>> {
    return err(unavailable('Hermes 会话开起来后不能改模型'));
  }

  async prompt(input: PromptInput): Promise<Result<void, DomainError>> {
    if (this.run) return err(conflict('上一轮还没结束'));
    if (this.submitting) return err(conflict('上一轮还在提交'));
    // 幂等键：会话 + 轮次 + 随机数；重试只用同一个（§14：还要带同一个 X-Hermes-Session-Key）。
    // 记在 HERMES_HOME：上次同一条输入没确认收到（worker 中途重启），这次沿用那个键，不会多跑一轮。
    const text = hermesInput(input);
    const inputHash = hashInput(text);
    // 提交结果未知时只允许原样重发（同一个幂等键、同一条送达）：换内容可能和远端还在跑的
    // 那轮叠上，换 deliveryId 会把结局记到别人的账上。
    const held = this.submission;
    if (held && held.inputHash !== inputHash) return err(conflict('上一次提交的结果还没确认，只能重发同一条'));
    if (held?.deliveryId !== undefined && held.deliveryId !== input.deliveryId) {
      return err(conflict('上一次提交对应的是另一条送达，只能用原来那条重发'));
    }
    this.submitting = true;
    try {
      let key: string;
      let freshSubmission = false;
      let deliveryId = held?.deliveryId ?? input.deliveryId;
      if (held) {
        key = held.key;
      } else {
        const previous = this.home ? await readPending(this.home) : null;
        if (previous && previous.runId === null) {
          // 上次只落盘、还没拿到 run_id：结果不确定，不能换一条把它覆盖掉。
          if (previous.inputHash !== inputHash) {
            this.submission = { key: previous.key, inputHash: previous.inputHash, ...(previous.deliveryId ? { deliveryId: previous.deliveryId } : {}) };
            return err(conflict('上一次提交的结果还没确认，只能重发同一条'));
          }
          if (previous.deliveryId !== undefined && previous.deliveryId !== input.deliveryId) {
            this.submission = { key: previous.key, inputHash, deliveryId: previous.deliveryId };
            return err(conflict('上一次提交对应的是另一条送达，只能用原来那条重发'));
          }
          key = previous.key;
          deliveryId = previous.deliveryId ?? input.deliveryId;
        } else {
          key = `ahub:${this.sessionId}:${++this.seq}:${randomBytes(6).toString('hex')}`;
          freshSubmission = true;
        }
      }
      // 预约记住这一轮归属的送达：之后重发既不能换内容，也不能换 deliveryId。
      this.submission = { key, inputHash, ...(deliveryId ? { deliveryId } : {}) };
      // deliveryId 跟着这一轮落盘：worker 重启后还能把确认终态归属回同一条送达。
      const pending = { key, inputHash, ...(deliveryId ? { deliveryId } : {}) };
      await this.savePending({ ...pending, runId: null, at: Date.now() });
      const body: Record<string, unknown> = {
        session_id: this.gateway.endpoint.sessionKey,
        input: text,
        model: this.gateway.route ? routedModel(this.gateway.route, this.model) : this.model,
        provider: 'custom',
        ...(this.instructions ? { instructions: this.instructions } : {})
      };
      let runId: string;
      try {
        const submitted = await submitRun(this.gateway.endpoint, body, key);
        runId = submitted.run_id;
        freshSubmission &&= submitted.fresh;
      } catch (error) {
        // 429 是明确的「没收下，稍后再来」，可以放下一句；503 可能是网关 / 中间层返回的，
        // 分不清 Hermes 收没收到，按结果未知处理（预约留着，只放同一条重发）。
        if (error instanceof HermesHttpError && error.status === 429) {
          this.submission = null;
          return err(unavailable('Hermes 太忙（被限流），稍后再试'));
        }
        if (error instanceof HermesHttpError && error.status >= 400 && error.status < 500) {
          this.submission = null;
          // 键不用留；连不上 / 超时的留着，重发同一条沿用这个键
          await this.savePending(null);
        }
        if (error instanceof HermesHttpError && error.status === 409) return err(conflict(`Hermes 拒绝了这一轮：${error.code}`));
        // 连不上 / 超时 / 5xx：Hermes 收没收到不确定。reservation 留着，只放同一条重发。
        return err(unavailable(`Hermes 不收这一轮：${(error as Error).message}`));
      }
      await this.savePending({ ...pending, runId, at: Date.now() });
      const abort = new AbortController();
      // 先让 run 接管闸门，再松开提交占位：中间没有空窗。
      this.run = { id: runId, abort, following: true };
      this.submission = null;
      void this.follow(runId, abort, deliveryId, freshSubmission);
      return ok(undefined);
    } finally {
      this.submitting = false;
    }
  }

  /** 只清这一轮自己的记录：收尾时下一轮可能已经记上了。读改写串行，避免抢在别人落盘之后删掉新纪录。 */
  private async clearPendingFor(runId: string | null): Promise<void> {
    const home = this.home;
    if (!home) return;
    await this.serializePending(async () => {
      const current = await readPending(home);
      if (current?.runId === runId) await writePending(home, null);
    }).catch((error: unknown) => this.log(`清不掉 Hermes 的进行中一轮：${(error as Error).message}`));
  }

  private async savePending(pending: PendingTurn | null): Promise<void> {
    const home = this.home;
    if (!home) return;
    await this.serializePending(() => writePending(home, pending))
      .catch((error: unknown) => this.log(`记不下 Hermes 的进行中一轮：${(error as Error).message}`));
  }

  private serializePending<T>(op: () => Promise<T>): Promise<T> {
    const next = this.pendingTail.then(op, op);
    this.pendingTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private reportUnknown(deliveryId?: string): void {
    if (deliveryId) {
      this.queue.push({ kind: 'diagnostic', level: 'warn', text: UNKNOWN_OUTCOME_WARNING, uncertainDeliveryId: deliveryId });
    } else {
      // 旧 Hub 仍需标记文字，新 Hub 不再依赖它判断状态。
      this.queue.push({ kind: 'ended', outcome: 'interrupted', reason: UNKNOWN_OUTCOME_REASON, outcomeUnknown: true });
    }
  }

  /**
   * 开会话时对账：上次 worker 停掉前有一轮没收尾（记了 run_id），查 Hermes 说清结局。
   * 还在跑 → 接着跟；结果未知 → 交给人，记录留着、本地闸门挡着（点停也要查实终态才收）；
   * 明确终态 → 有 deliveryId 就补一条带 id 的 ended（精确收掉 hub 那条送达），老记录只记诊断。
   * 只提交了、没拿到 run_id 的保留提交位，不自动重发；若以后重发同一条则沿用幂等键。
   */
  async reconcile(): Promise<void> {
    if (!this.home) return;
    const pending = await readPending(this.home);
    if (!pending) return;
    if (!pending.runId) {
      this.submission = { key: pending.key, inputHash: pending.inputHash, ...(pending.deliveryId ? { deliveryId: pending.deliveryId } : {}) };
      if (pending.deliveryId) this.reportUnknown(pending.deliveryId);
      else this.queue.push({ kind: 'diagnostic', level: 'warn', text: 'worker 重启前只提交了一半，不确定 Hermes 收没收到；只放同一条重发。' });
      return;
    }
    const status = await this.status(pending.runId);
    if (status && ['queued', 'running', 'waiting', 'waiting_for_approval'].includes(status.status)) {
      const abort = new AbortController();
      this.run = { id: pending.runId, abort, following: true };
      this.queue.push({ kind: 'diagnostic', level: 'info', text: 'worker 重启前的一轮 Hermes 还在跑，接着跟。' });
      void this.follow(pending.runId, abort, pending.deliveryId);
      return;
    }
    if (!status || !(TERMINAL_RUN_STATUSES as readonly string[]).includes(status.status)) {
      // 未知或不认识的状态不证明停了：保留记录和闸门，点停也要查实同一个 run 的终态。
      this.run = { id: pending.runId, abort: new AbortController(), following: false };
      this.reportUnknown(pending.deliveryId);
      return;
    }
    if (pending.deliveryId) {
      const mapped = createHermesEventMapper()({ event: `run.${status.status}`, ...(status.error ? { error: status.error } : {}) });
      for (const event of mapped.events) this.queue.push(tagEnded(event, pending.deliveryId));
    } else {
      this.queue.push({ kind: 'diagnostic', level: 'info', text: `worker 重启前提交的一轮 Hermes 已经${status.status === 'completed' ? '完成' : status.status === 'failed' ? '失败' : '停止'}（${status.status}）。` });
    }
    await this.clearPendingFor(pending.runId);
  }

  /**
   * 跟一轮的事件流直到终态；断线了查状态，没结束就重连（SSE 自带补发）。
   *
   * `terminal` 只认 Hermes 明确报出的终态（SSE 终态帧 / 状态查询确认 completed、failed、
   * cancelled、interrupted）；`unknown` 是「查不到 / 结果未知 / 事件流耗尽」，它**不证明**
   * 远端那一轮停了：按送达归属报告不确定性，并且继续占着 `this.run` 的本地闸门。
   */
  private async follow(runId: string, abort: AbortController, deliveryId?: string, fresh = false): Promise<void> {
    const map = createHermesEventMapper();
    let terminal = false;
    let unknown = false;
    let firstOutputPending = fresh && !!deliveryId;
    for (let attempt = 0; !terminal && !unknown && !abort.signal.aborted && attempt < 20; attempt++) {
      try {
        await streamRun(
          this.gateway.endpoint,
          runId,
          (raw) => {
            if (terminal || unknown || abort.signal.aborted || this.run?.abort !== abort) return;
            const mapped = map(raw);
            // 先放开「正在跑」再推终态：收到 ended 就马上发下一轮，不该撞上「上一轮还没结束」
            if (mapped.terminal && this.run?.id === runId) this.run = null;
            if (mapped.terminal) this.withdrawRun(runId);
            for (const event of mapped.events) {
              // Only the first stream of a fresh submission is attributable: reconnects may replay.
              // Preserve mapped text even when Hermes identifies it as a child/non-assistant message.
              const child = raw['child_session_id'] || raw['subagent_id'] || raw['subagentId'] || raw['delegation_id'];
              const assistant = raw['role'] === undefined || raw['role'] === 'assistant';
              if (firstOutputPending && deliveryId && attempt === 0 && event.kind === 'text' && event.delta && !event.subagentId && !child && assistant) {
                const marked = { ...event, firstOutputDeliveryId: deliveryId };
                this.queue.push(marked);
                firstOutputPending = false;
              } else {
                this.queue.push(tagEnded(event, mapped.terminal ? deliveryId : undefined));
              }
            }
            if (mapped.control) void this.answer(runId, mapped.control);
            if (mapped.terminal) terminal = true;
          },
          abort.signal
        );
      } catch (error) {
        if (abort.signal.aborted) break;
        this.log(`Hermes 事件流断了：${(error as Error).message}`);
      }
      if (terminal || unknown || abort.signal.aborted || this.run?.abort !== abort) break;
      const status = await this.status(runId);
      if (abort.signal.aborted || this.run?.abort !== abort) break;
      if (status?.status === 'unknown') {
        // D3：结果未知不自动处理（不重放、不当成功），交给人；也不能当成「已停」的证据。
        this.reportUnknown(deliveryId);
        unknown = true;
        break;
      }
      if (status && (TERMINAL_RUN_STATUSES as readonly string[]).includes(status.status)) {
        // 流断在终态帧之前：状态查询确认了终态，可以按结局收尾并归属到这一条送达。
        if (this.run?.id === runId) this.run = null;
        this.withdrawRun(runId);
        const synthetic = map({ event: `run.${status.status}`, ...(status.error ? { error: status.error } : {}) });
        for (const event of synthetic.events) this.queue.push(tagEnded(event, deliveryId));
        terminal = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 10_000)));
    }
    if (!terminal && !unknown && !abort.signal.aborted && this.run?.abort === abort) {
      // 重连用尽也没拿到终态：不证明这一轮停了。
      this.reportUnknown(deliveryId);
      unknown = true;
    }
    // 旧流的迟到回调不能影响接替它的另一轮。
    if (!terminal && this.run?.abort !== abort) return;
    // 跟流结束后撤掉本轮批准；只有确认终态才清 pending，未知状态留待下次对账。
    if (!terminal) this.withdrawRun(runId);
    if (terminal) await this.clearPendingFor(runId);
    // 只有确认的终态（或主动 dispose）才放开「上一轮还没结束」；未知结局继续 fail closed。
    if ((terminal || abort.signal.aborted) && this.run?.id === runId) this.run = null;
    // 流已经跟完但结局未知：留下本地闸门；点停也要先查实终态才收。
    else if (unknown && this.run?.id === runId) this.run.following = false;
  }

  private async status(runId: string): Promise<{ status: string; execution_generation?: number; error?: string } | null> {
    return hermesJson<{ status: string; execution_generation?: number; error?: string }>(this.gateway.endpoint, 'GET', `/v1/runs/${encodeURIComponent(runId)}`).catch(() => null);
  }

  /**
   * 批准（ADR 0023）：推一张批准卡，等人点「允许 / 拒绝」；超时（默认 180s，比 Hermes 自己的 300s 短）当拒绝。
   * 不再自动放行。允许只给 `once`，从不给 session/always（不留永久授权）。
   * 澄清：回一句固定的「用户不在，自己判断」，记一条诊断。
   */
  private async answer(runId: string, control: HermesControl): Promise<void> {
    const generation = control.generation ?? (await this.status(runId))?.execution_generation;
    if (typeof generation !== 'number' || !control.requestId) {
      this.queue.push({ kind: 'diagnostic', level: 'warn', text: `Hermes 发来${control.kind === 'approval' ? '批准' : '澄清'}请求，但缺 id，没法回` });
      return;
    }
    if (control.kind === 'approval') {
      const id = `${runId}:${control.requestId}`.slice(0, 256);
      if (this.approvals.has(id)) return;
      this.approvals.set(id, { runId, requestId: control.requestId, generation });
      this.gate.request({ id, title: control.summary.slice(0, 4000) || 'Hermes 要执行一个需要批准的动作' });
      return;
    }
    this.queue.push({ kind: 'diagnostic', level: 'info', text: `Hermes 追问「${control.summary.slice(0, 200)}」，已回复用户不在、请自行判断` });
    await hermesJson(this.gateway.endpoint, 'POST', `/v1/runs/${encodeURIComponent(runId)}/clarify`, {
      request_id: control.requestId,
      execution_generation: generation,
      answer: CLARIFY_ANSWER
    }).catch((error: unknown) => {
      this.queue.push({ kind: 'diagnostic', level: 'warn', text: `回 Hermes 的澄清失败：${(error as Error).message}` });
    });
  }

  async respondApproval(id: string, decision: 'allow' | 'deny', author?: { readonly id: string; readonly name: string }): Promise<Result<void, DomainError>> {
    return (await this.gate.respond(id, decision, author)) ? ok(undefined) : err(invalid('这个批准请求已经结束了'));
  }

  /** 这一轮结束了还开着的卡：Hermes 那边已经不等了，收掉，不再回。 */
  private withdrawRun(runId: string): void {
    for (const [id, target] of this.approvals) {
      if (target.runId !== runId) continue;
      this.approvals.delete(id);
      this.gate.withdraw(id);
    }
  }

  async interrupt(): Promise<void> {
    const run = this.run;
    if (!run) {
      // 提交结果不确定、还没有 run id：不能当成「停了」把记录丢掉，否则远端真跑起来就没人收。
      // 预约和 pending 都留着，只放同一条（同一个键、同一条送达）重发。
      if (this.submission) {
        this.queue.push({ kind: 'diagnostic', level: 'warn', text: '提交结果还不确定，不能直接丢掉这一轮；记录留着，只能用同一条重发。' });
      }
      return;
    }
    // 不 abort 事件流：等 Hermes 自己发 run.cancelled，结局才准
    await hermesJson(this.gateway.endpoint, 'POST', `/v1/runs/${encodeURIComponent(run.id)}/stop`, {}).catch((error: unknown) => {
      this.log(`停 Hermes 这一轮失败：${(error as Error).message}`);
    });
    // 还在跟事件流：终态由 follow 收，不在这里补。
    if (run.following || this.run !== run) return;
    // 只剩对账未知的本地闸门：停一下再查同一个 run，只有确认终态才算停了。
    const status = await this.status(run.id);
    if (this.run !== run) return;
    if (!status || !(TERMINAL_RUN_STATUSES as readonly string[]).includes(status.status)) {
      this.queue.push({ kind: 'diagnostic', level: 'warn', text: `停这一轮 Hermes 没得到确认（${status?.status ?? '查不到状态'}）；记录留着，下次对账再看。` });
      return;
    }
    const pending = this.home ? await readPending(this.home) : null;
    if (pending && pending.runId !== run.id) {
      // 记录已经属于别的轮次：不动它，闸门也先留着，免得把别人的结局收错。
      this.queue.push({ kind: 'diagnostic', level: 'warn', text: '本地记录已经换成另一轮了，这次停轮没有收掉任何送达。' });
      return;
    }
    if (pending?.deliveryId) {
      const mapped = createHermesEventMapper()({ event: `run.${status.status}`, ...(status.error ? { error: status.error } : {}) });
      for (const event of mapped.events) this.queue.push(tagEnded(event, pending.deliveryId));
    } else {
      // 老记录没有 deliveryId：确认终态后照旧只记诊断（没有送达可收）。
      this.queue.push({ kind: 'diagnostic', level: 'info', text: `worker 重启前提交的一轮 Hermes 已经${status.status === 'completed' ? '完成' : status.status === 'failed' ? '失败' : '停止'}（${status.status}）。` });
    }
    this.withdrawRun(run.id);
    this.run = null;
    await this.clearPendingFor(run.id);
  }

  /** 事件流断线重连在 follow 里自己做；这里不需要额外补发。 */
  async adopt(): Promise<void> {}

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const run = this.run;
    // 没回答的批准一律拒绝（回给 Hermes），再关事件流
    await this.gate.close().catch(() => undefined);
    this.run?.abort.abort();
    this.run = null;
    this.queue.close();
    if (this.gateway.release) {
      // 共用网关：停掉自己这一轮（别的会话还在用网关），再交回引用
      if (run) await hermesJson(this.gateway.endpoint, 'POST', `/v1/runs/${encodeURIComponent(run.id)}/stop`, {}).catch(() => undefined);
      await this.gateway.release();
      return;
    }
    await stopChild(this.gateway.child);
  }
}
