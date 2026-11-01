import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { AsyncQueue } from '@agent-hub/contract';
import {
  conflict,
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
import { hermesSessionKey, prepareHermesHome } from './home.ts';
import { createHermesEventMapper, type HermesControl } from './map-event.ts';

/** Runs API 里 P1 离不开的几项（/v1/capabilities）。缺一项就不开会话，不猜。 */
export const REQUIRED_FEATURES = ['run_submission', 'run_status', 'run_events_sse', 'run_stop'] as const;

/** 澄清问题的固定回答：hub 里没有人在线答 Hermes 的追问（设计文档 §14.1，保守选择）。 */
/** 结果未知的固定原因文字：界面认它给「重发 / 不用了」（outcome_unknown 是 Hermes 的说法）。 */
export const UNKNOWN_OUTCOME_REASON = 'Hermes 这一轮的结果未知（outcome_unknown）';

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
  /** 每会话 HERMES_HOME 的根目录（见 home.ts）。 */
  readonly root: string;
  readonly toolShim?: { readonly command: string; readonly args: readonly string[] };
  readonly onAgentSessionRef?: (sessionId: string, ref: string) => void;
  readonly log?: (message: string) => void;
  /** 等 API Server 起来的上限。 */
  readonly bootTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

interface Gateway {
  readonly child: ChildProcess;
  readonly endpoint: HermesEndpoint;
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

/**
 * 一个 hub 会话 = 一个 Hermes 网关进程（独占一个 HERMES_HOME、127.0.0.1 上的随机端口、随机 API 密钥）。
 * 偏离 ADR 0022 D2-A（每 worker 一个网关），原因见设计文档 §14：中继令牌按会话发、Runs API 没有每轮 cwd、
 * MCP 是 profile 级、一个网关只服务一个 HERMES_HOME。
 */
export function createHermesRuntime(options: HermesRuntimeOptions): AgentRuntime {
  const command = options.command ?? 'hermes';
  const log = options.log ?? (() => undefined);
  return {
    descriptor: hermesDescriptor(),
    async start(spec: StartSpec): Promise<Result<RuntimeSession, DomainError>> {
      if (!spec.provider) return err(unavailable('Hermes 只能用 hub 模型提供商：请先在会话里选一个 hub 模型'));
      const model = hermesModel(spec);
      if (!model) return err(unavailable('选的 hub 模型提供商没有模型'));
      let home: string;
      try {
        home = await prepareHermesHome(options.root, spec.sessionId, {
          model,
          workspaceRoot: spec.workspaceRoot,
          ...(spec.tools && options.toolShim ? { toolShim: options.toolShim } : {})
        });
      } catch (error) {
        return err(unavailable(`建不了 Hermes 目录：${(error as Error).message}`));
      }
      const port = await freePort();
      const key = randomBytes(24).toString('hex');
      const env: Record<string, string> = {
        ...hermesBaseEnv(options.env ?? process.env),
        HERMES_HOME: home,
        API_SERVER_ENABLED: 'true',
        API_SERVER_HOST: '127.0.0.1',
        API_SERVER_PORT: String(port),
        API_SERVER_KEY: key,
        [PROVIDER_BASE_URL_ENV]: spec.provider.baseUrl,
        [PROVIDER_TOKEN_ENV]: spec.provider.token,
        ...(spec.tools
          ? { AGENT_HUB_TOOL_URL: spec.tools.url, AGENT_HUB_TOOL_TOKEN: spec.tools.token, AGENT_HUB_MCP: JSON.stringify(spec.mcp ?? []) }
          : {})
      };
      let child: ChildProcess;
      try {
        child = spawn(command, ['gateway', 'run'], { cwd: spec.workspaceRoot, env, stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (error) {
        return err(unavailable(`无法启动 Hermes：${(error as Error).message}`));
      }
      child.on('error', () => undefined);
      let stderrTail = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
      });
      const baseUrl = `http://127.0.0.1:${port}`;
      const sessionKey = spec.resume?.agentSessionRef ?? hermesSessionKey(spec.sessionId);
      const gateway: Gateway = { child, endpoint: { baseUrl, key, sessionKey } };
      try {
        await waitHealthy(child, baseUrl, options.bootTimeoutMs ?? 60_000);
        const caps = await hermesJson<{ features?: Record<string, unknown> }>(gateway.endpoint, 'GET', '/v1/capabilities');
        const missing = REQUIRED_FEATURES.filter((feature) => !caps?.features?.[feature]);
        if (missing.length > 0) throw new Error(`这个 Hermes 版本缺 Runs API 能力：${missing.join(', ')}`);
        await hermesJson(gateway.endpoint, 'POST', '/api/sessions', { id: sessionKey }).catch((error: unknown) => {
          // 已经有了 = resume；被别的主人占着 = 拒绝（不接管别人的 Hermes 会话）
          if (error instanceof HermesHttpError && error.status === 409) {
            if (error.code === 'permission_denied') throw new Error('foreign_session');
            return;
          }
          throw error;
        });
      } catch (error) {
        child.kill('SIGTERM');
        const message = (error as Error).message;
        if (message === 'foreign_session') return err(forbidden('这个 Hermes 会话属于别的主人，hub 不接管'));
        log(`Hermes 起不来：${message}${stderrTail ? `\n${stderrTail.split('\n').slice(-5).join('\n')}` : ''}`);
        return err(unavailable(`Hermes 起不来：${message}`));
      }
      if (!spec.resume?.agentSessionRef) options.onAgentSessionRef?.(spec.sessionId, sessionKey);
      const instructions = await instructionsFor(spec.assets);
      const session = new HermesSession(spec.sessionId, gateway, model, instructions, log, home);
      await session.reconcile();
      return ok(session);
    }
  };
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
}
export const PENDING_FILE = 'ahub-pending.json';
const hashInput = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);

export async function readPending(home: string): Promise<PendingTurn | null> {
  try {
    const value = JSON.parse(await readFile(join(home, PENDING_FILE), 'utf8')) as Partial<PendingTurn>;
    if (typeof value.key !== 'string' || typeof value.inputHash !== 'string') return null;
    return { key: value.key, inputHash: value.inputHash, runId: typeof value.runId === 'string' ? value.runId : null, at: typeof value.at === 'number' ? value.at : 0 };
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

export class HermesSession implements RuntimeSession {
  readonly sessionId: SessionId;
  private readonly gateway: Gateway;
  private readonly model: string;
  private readonly instructions: string;
  private readonly log: (message: string) => void;
  private readonly queue = new AsyncQueue<SessionEvent>();
  private seq = 0;
  private run: { id: string; abort: AbortController } | null = null;
  private disposed = false;
  private readonly home: string | null;

  constructor(sessionId: SessionId, gateway: Gateway, model: string, instructions: string, log: (message: string) => void, home: string | null = null) {
    this.sessionId = sessionId;
    this.home = home;
    this.gateway = gateway;
    this.model = model;
    this.instructions = instructions;
    this.log = log;
    gateway.child.once('exit', (code, signal) => {
      if (this.disposed) return;
      if (this.run) this.queue.push({ kind: 'ended', outcome: 'interrupted', reason: `Hermes 网关退出了（${code ?? signal}）` });
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
    // 幂等键：会话 + 轮次 + 随机数；重试只用同一个（§14：还要带同一个 X-Hermes-Session-Key）。
    // 记在 HERMES_HOME：上次同一条输入没确认收到（worker 中途重启），这次沿用那个键，不会多跑一轮。
    const text = hermesInput(input);
    const inputHash = hashInput(text);
    const previous = this.home ? await readPending(this.home) : null;
    const key = previous && previous.runId === null && previous.inputHash === inputHash ? previous.key : `ahub:${this.sessionId}:${++this.seq}:${randomBytes(6).toString('hex')}`;
    await this.savePending({ key, inputHash, runId: null, at: Date.now() });
    const body: Record<string, unknown> = {
      session_id: this.gateway.endpoint.sessionKey,
      input: text,
      model: this.model,
      provider: 'custom',
      ...(this.instructions ? { instructions: this.instructions } : {})
    };
    let runId: string;
    try {
      const submitted = await submitRun(this.gateway.endpoint, body, key);
      runId = submitted.run_id;
    } catch (error) {
      if (error instanceof HermesHttpError && (error.status === 429 || error.status === 503)) return err(unavailable('Hermes 太忙（被限流），稍后再试'));
      // 明确被拒（4xx）：这一轮肯定没跑，键不用留；连不上 / 超时的留着，重发同一条沿用这个键
      if (error instanceof HermesHttpError && error.status >= 400 && error.status < 500) await this.savePending(null);
      if (error instanceof HermesHttpError && error.status === 409) return err(conflict(`Hermes 拒绝了这一轮：${error.code}`));
      return err(unavailable(`Hermes 不收这一轮：${(error as Error).message}`));
    }
    await this.savePending({ key, inputHash, runId, at: Date.now() });
    const abort = new AbortController();
    this.run = { id: runId, abort };
    void this.follow(runId, abort);
    return ok(undefined);
  }

  /** 只清这一轮自己的记录：收尾时下一轮可能已经记上了。 */
  private async clearPendingFor(runId: string): Promise<void> {
    if (!this.home) return;
    const current = await readPending(this.home);
    if (current?.runId === runId) await this.savePending(null);
  }

  private async savePending(pending: PendingTurn | null): Promise<void> {
    if (!this.home) return;
    await writePending(this.home, pending).catch((error: unknown) => this.log(`记不下 Hermes 的进行中一轮：${(error as Error).message}`));
  }

  /**
   * 开会话时对账：上次 worker 停掉前有一轮没收尾（记了 run_id），查 Hermes 说清结局。
   * 还在跑 → 接着跟；结果未知 → 交给人（界面上给「重发 / 不用了」）；已结束 → 记一条诊断。
   * 只提交了、没拿到 run_id 的不动：下次发同一条会沿用同一个幂等键。
   */
  async reconcile(): Promise<void> {
    if (!this.home) return;
    const pending = await readPending(this.home);
    if (!pending?.runId) return;
    const status = await this.status(pending.runId);
    if (status && ['queued', 'running', 'waiting'].includes(status.status)) {
      const abort = new AbortController();
      this.run = { id: pending.runId, abort };
      this.queue.push({ kind: 'diagnostic', level: 'info', text: 'worker 重启前的一轮 Hermes 还在跑，接着跟。' });
      void this.follow(pending.runId, abort);
      return;
    }
    await this.savePending(null);
    if (!status || status.status === 'unknown') {
      this.queue.push({ kind: 'diagnostic', level: 'warn', text: 'worker 重启前提交的一轮 Hermes，结果不确定；没有自动重试，请看工作区后决定是否重发。' });
      this.queue.push({ kind: 'ended', outcome: 'interrupted', reason: UNKNOWN_OUTCOME_REASON });
      return;
    }
    this.queue.push({ kind: 'diagnostic', level: 'info', text: `worker 重启前提交的一轮 Hermes 已经${status.status === 'completed' ? '完成' : status.status === 'failed' ? '失败' : '停止'}（${status.status}）。` });
  }

  /** 跟一轮的事件流直到终态；断线了查状态，没结束就重连（SSE 自带补发）。 */
  private async follow(runId: string, abort: AbortController): Promise<void> {
    const map = createHermesEventMapper();
    let terminal = false;
    for (let attempt = 0; !terminal && !abort.signal.aborted && attempt < 20; attempt++) {
      try {
        await streamRun(
          this.gateway.endpoint,
          runId,
          (raw) => {
            if (terminal) return;
            const mapped = map(raw);
            // 先放开「正在跑」再推终态：收到 ended 就马上发下一轮，不该撞上「上一轮还没结束」
            if (mapped.terminal && this.run?.id === runId) this.run = null;
            for (const event of mapped.events) this.queue.push(event);
            if (mapped.control) void this.answer(runId, mapped.control);
            if (mapped.terminal) terminal = true;
          },
          abort.signal
        );
      } catch (error) {
        if (abort.signal.aborted) break;
        this.log(`Hermes 事件流断了：${(error as Error).message}`);
      }
      if (terminal || abort.signal.aborted) break;
      const status = await this.status(runId);
      if (status?.status === 'unknown') {
        // D3：结果未知不自动处理（不重放、不当成功），交给人
        this.queue.push({ kind: 'diagnostic', level: 'warn', text: 'Hermes 重启过，这一轮是否执行完不确定；没有自动重试，请看工作区后决定是否重发。' });
        this.queue.push({ kind: 'ended', outcome: 'interrupted', reason: UNKNOWN_OUTCOME_REASON });
        terminal = true;
        break;
      }
      if (status && ['completed', 'failed', 'cancelled', 'interrupted'].includes(status.status)) {
        // 流断在终态帧之前：按状态补一个结局
        const synthetic = map({ event: `run.${status.status}`, ...(status.error ? { error: status.error } : {}) });
        for (const event of synthetic.events) this.queue.push(event);
        terminal = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 10_000)));
    }
    if (!terminal && !abort.signal.aborted) this.queue.push({ kind: 'ended', outcome: 'interrupted', reason: '连不上 Hermes 的事件流' });
    // 有了结局（包括结果未知、已经交给人）就不用再对账；连不上 / 被 dispose 的留着，下次开会话再查
    if (terminal) await this.clearPendingFor(runId);
    if (this.run?.id === runId) this.run = null;
  }

  private async status(runId: string): Promise<{ status: string; execution_generation?: number; error?: string } | null> {
    return hermesJson<{ status: string; execution_generation?: number; error?: string }>(this.gateway.endpoint, 'GET', `/v1/runs/${encodeURIComponent(runId)}`).catch(() => null);
  }

  /**
   * 批准：hub 没有批准卡片，和 ACP 运行时一样自动放行——但只给 `once`，从不给 session/always（不留永久授权）。
   * 澄清：回一句固定的「用户不在，自己判断」。两种都记一条诊断，事后能查。
   */
  private async answer(runId: string, control: HermesControl): Promise<void> {
    const generation = control.generation ?? (await this.status(runId))?.execution_generation;
    if (typeof generation !== 'number' || !control.requestId) {
      this.queue.push({ kind: 'diagnostic', level: 'warn', text: `Hermes 发来${control.kind === 'approval' ? '批准' : '澄清'}请求，但缺 id，没法回` });
      return;
    }
    const field = control.kind === 'approval' ? { choice: 'once' } : { answer: CLARIFY_ANSWER };
    this.queue.push({
      kind: 'diagnostic',
      level: 'info',
      text: control.kind === 'approval' ? `自动批准了一次（仅本次）：${control.summary.slice(0, 200)}` : `Hermes 追问「${control.summary.slice(0, 200)}」，已回复用户不在、请自行判断`
    });
    await hermesJson(this.gateway.endpoint, 'POST', `/v1/runs/${encodeURIComponent(runId)}/${control.kind}`, {
      request_id: control.requestId,
      execution_generation: generation,
      ...field
    }).catch((error: unknown) => {
      this.queue.push({ kind: 'diagnostic', level: 'warn', text: `回 Hermes 的${control.kind === 'approval' ? '批准' : '澄清'}失败：${(error as Error).message}` });
    });
  }

  async interrupt(): Promise<void> {
    const run = this.run;
    if (!run) return;
    // 不 abort 事件流：等 Hermes 自己发 run.cancelled，结局才准
    await hermesJson(this.gateway.endpoint, 'POST', `/v1/runs/${encodeURIComponent(run.id)}/stop`, {}).catch((error: unknown) => {
      this.log(`停 Hermes 这一轮失败：${(error as Error).message}`);
    });
  }

  /** 事件流断线重连在 follow 里自己做；这里不需要额外补发。 */
  async adopt(): Promise<void> {}

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.run?.abort.abort();
    this.run = null;
    this.queue.close();
    const child = this.gateway.child;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      clearTimeout(timer);
    }
  }
}
