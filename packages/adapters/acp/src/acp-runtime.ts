import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { jsonlRecords } from '@agent-hub/contract';
import type {
  AgentRuntime,
  DomainError,
  Result,
  RuntimeOption,
  RuntimeSession,
  SessionEvent,
  StartSpec
} from '@agent-hub/domain';
import { unavailable } from '@agent-hub/domain';
import { acpDescriptor, type AcpAgentConfig } from './config.ts';
import { endedFromStopReason, mapAcpUpdate } from './map-acp.ts';
import { mapAcpOptions } from './map-options.ts';

class EventQueue implements AsyncIterable<SessionEvent> {
  private readonly items: SessionEvent[] = [];
  private readonly waiters: ((result: IteratorResult<SessionEvent>) => void)[] = [];
  private closed = false;

  push(event: SessionEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.items.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    return {
      next: (): Promise<IteratorResult<SessionEvent>> => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      }
    };
  }
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

class AcpSession implements RuntimeSession {
  readonly sessionId: RuntimeSession['sessionId'];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly queue = new EventQueue();
  private readonly pending = new Map<string, Pending>();
  private readonly toolNames = new Map<string, string>();
  private current: readonly RuntimeOption[] = [];
  private counter = 0;
  private agentSessionId = '';
  private readonly onOptions: (options: readonly RuntimeOption[]) => void;

  constructor(
    sessionId: RuntimeSession['sessionId'],
    child: ChildProcessWithoutNullStreams,
    onOptions: (options: readonly RuntimeOption[]) => void
  ) {
    this.sessionId = sessionId;
    this.child = child;
    this.onOptions = onOptions;
    void this.pump();
  }

  setAgentSessionId(id: string): void {
    this.agentSessionId = id;
  }

  private setOptions(raw: unknown): void {
    const options = mapAcpOptions(raw);
    if (options.length === 0) return;
    this.current = options;
    this.onOptions(options);
  }

  private async pump(): Promise<void> {
    try {
      for await (const line of jsonlRecords(this.child.stdout)) {
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(line) as Record<string, unknown>;
        } catch {
          this.queue.push({ kind: 'diagnostic', level: 'warn', text: '无法解析的 ACP 记录' });
          continue;
        }

        const id = record['id'];
        if (record['method'] !== undefined && id !== undefined) {
          this.answerAcpRequest(record);
          continue;
        }
        if (id !== undefined && this.pending.has(String(id))) {
          const pending = this.pending.get(String(id));
          this.pending.delete(String(id));
          if (record['error']) {
            pending?.reject(new Error(String((record['error'] as Record<string, unknown>)['message'])));
          } else {
            pending?.resolve((record['result'] as Record<string, unknown>) ?? {});
          }
          continue;
        }
        const params = record['params'] as Record<string, unknown> | undefined;
        if (record['method'] === 'session/update' && params) {
          const update = params['update'] as Record<string, unknown> | undefined;
          // agent 自己也能改配置（比如限流后换模型），它推的是全量状态。
          if (update?.['sessionUpdate'] === 'config_option_update') {
            this.setOptions(update['configOptions']);
            continue;
          }
          for (const event of mapAcpUpdate(params['update'], this.toolNames)) this.queue.push(event);
        }
      }
    } catch (error) {
      this.queue.push({
        kind: 'diagnostic',
        level: 'error',
        text: `ACP 事件流中断：${(error as Error).message}`
      });
    } finally {
      this.queue.push({ kind: 'ended', outcome: 'failed' });
      this.queue.close();
    }
  }

  /** ACP 允许 agent 反向请求客户端。不答就会卡住，所以每个请求都要有回音。 */
  private answerAcpRequest(record: Record<string, unknown>): void {
    const id = record['id'] as string | number;
    const method = String(record['method']);

    if (method === 'session/request_permission') {
      const params = record['params'] as Record<string, unknown> | undefined;
      const options = (params?.['options'] as { optionId?: string; kind?: string }[] | undefined) ?? [];
      const allow = options.find((option) => option.kind?.startsWith('allow')) ?? options[0];
      this.write({
        jsonrpc: '2.0',
        id,
        result: allow?.optionId
          ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
          : { outcome: { outcome: 'cancelled' } }
      });
      return;
    }

    this.write({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `agent-hub v1 未实现 ${method}` }
    });
  }

  private write(payload: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.counter += 1;
    const id = this.counter;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async initialize(cwd: string): Promise<void> {
    await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
    });
    const session = await this.request('session/new', { cwd, mcpServers: [] });
    const id = session['sessionId'];
    if (typeof id === 'string') this.agentSessionId = id;
    this.setOptions(session['configOptions']);
  }

  async load(cwd: string, agentSessionRef: string): Promise<void> {
    await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
    });
    const session = await this.request('session/load', {
      sessionId: agentSessionRef,
      cwd,
      mcpServers: []
    });
    this.agentSessionId = agentSessionRef;
    this.setOptions(session['configOptions']);
  }

  options(): readonly RuntimeOption[] {
    return this.current;
  }

  async changeOption(id: string, value: string | boolean): Promise<Result<readonly RuntimeOption[], DomainError>> {
    try {
      const result = await this.request('session/set_config_option', {
        sessionId: this.agentSessionId,
        configId: id,
        type: typeof value === 'boolean' ? 'boolean' : 'id',
        value
      });
      // 响应是全量状态：换模型会连带改变别的项的可选值，所以整份换掉。
      this.setOptions(result['configOptions']);
      if (this.current.length === 0) return { ok: false, error: unavailable('agent 没有回报配置项') };
      return { ok: true, value: this.current };
    } catch (error) {
      return { ok: false, error: unavailable((error as Error).message) };
    }
  }

  async prompt(text: string): Promise<Result<void, DomainError>> {
    try {
      const result = await this.request('session/prompt', {
        sessionId: this.agentSessionId,
        prompt: [{ type: 'text', text }]
      });
      this.queue.push(endedFromStopReason(result['stopReason']));
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: unavailable((error as Error).message) };
    }
  }

  async interrupt(): Promise<void> {
    this.write({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: this.agentSessionId }
    });
  }

  events(): AsyncIterable<SessionEvent> {
    return this.queue;
  }

  async adopt(_cursor: number): Promise<void> {
    return;
  }

  async dispose(): Promise<void> {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    this.child.once('exit', () => clearTimeout(timer));
  }
}

export interface AcpRuntimeOptions {
  readonly onAgentSessionRef?: (sessionId: string, agentSessionRef: string) => void;
  /** agent 报上来的可调项（含当前值），worker 用它告诉 server。 */
  readonly onOptions?: (sessionId: string, options: readonly RuntimeOption[]) => void;
}

/**
 * 一个 ACP agent = 一条命令 + 一套协议。
 * 换 agent 只换 `config`，不改这里——这就是「通用」在这一层的全部含义。
 */
export function createAcpRuntime(config: AcpAgentConfig, options: AcpRuntimeOptions = {}): AgentRuntime {
  return {
    descriptor: acpDescriptor(config),

    async start(spec: StartSpec): Promise<Result<RuntimeSession, DomainError>> {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(config.command, [...config.args], {
          cwd: spec.workspaceRoot,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (error) {
        return { ok: false, error: unavailable(`无法启动 ${config.label}：${(error as Error).message}`) };
      }
      child.on('error', () => {
        /* 见 Pi 适配器的同名处理：避免未处理的 error 事件崩进程 */
      });

      // 每一项可调项都是 agent 自己报的；平台只转手，不改写。
      const session = new AcpSession(spec.sessionId, child, (reported) => {
        options.onOptions?.(spec.sessionId, reported);
      });
      const ref = spec.resume?.agentSessionRef ?? null;
      try {
        if (ref) await session.load(spec.workspaceRoot, ref);
        else await session.initialize(spec.workspaceRoot);
      } catch (error) {
        await session.dispose();
        return { ok: false, error: unavailable(`${config.label} 握手失败：${(error as Error).message}`) };
      }

      // 开跑前用户已经选好的项（派生时选的模型），交给 agent 去落实。
      for (const [id, value] of Object.entries(spec.options)) {
        const changed = await session.changeOption(id, value);
        if (!changed.ok) {
          await session.dispose();
          return { ok: false, error: changed.error };
        }
      }

      options.onAgentSessionRef?.(spec.sessionId, ref ?? 'pending');
      return { ok: true, value: session };
    }
  } satisfies AgentRuntime;
}
