import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { jsonlRecords } from '@agent-hub/contract';
import type {
  AgentDescriptor,
  AgentRuntime,
  DomainError,
  Result,
  RuntimeSession,
  SessionEvent,
  StartSpec
} from '@agent-hub/domain';
import { unavailable } from '@agent-hub/domain';
import { piDescriptorFor } from './descriptor.ts';
import { createPiEventMapper } from './map-event.ts';

/**
 * 事件队列：把 child process 的推送转成 domain 要的 `AsyncIterable<SessionEvent>`。
 * 关闭后仍在排队的消费者会被正常结束，不会挂住。
 */
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

class PiSession implements RuntimeSession {
  readonly sessionId: RuntimeSession['sessionId'];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly queue = new EventQueue();
  private readonly pending = new Map<string, Pending>();
  private readonly mapper = createPiEventMapper();
  private counter = 0;
  private disposed = false;
  /** Pi 的失败原因几乎都在 stderr 上（比如模型名有歧义），丢掉它等于把可诊断性丢了。 */
  private lastStderr = '';

  constructor(sessionId: RuntimeSession['sessionId'], child: ChildProcessWithoutNullStreams) {
    this.sessionId = sessionId;
    this.child = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text === '') return;
      this.lastStderr = text;
      this.queue.push({ kind: 'diagnostic', level: 'warn', text });
    });
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const line of jsonlRecords(this.child.stdout)) {
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          this.queue.push({ kind: 'diagnostic', level: 'warn', text: '无法解析的 Pi 记录' });
          continue;
        }
        const head = record as Record<string, unknown>;
        if (head['type'] === 'response' && typeof head['id'] === 'string') {
          const pending = this.pending.get(head['id']);
          if (pending) {
            this.pending.delete(head['id']);
            if (head['success'] === true) pending.resolve(head);
            else pending.reject(new Error(String(head['error'] ?? '命令失败')));
          }
          continue;
        }
        for (const event of this.mapper.map(record)) this.queue.push(event);
      }
    } catch (error) {
      this.queue.push({
        kind: 'diagnostic',
        level: 'error',
        text: `Pi 事件流中断：${(error as Error).message}`
      });
    } finally {
      // 退出码 + 最后一行 stderr 一起进 ended.reason：卡片上要能看出为什么失败。
      const code = this.child.exitCode;
      const reason = this.disposed
        ? undefined
        : [code === null ? 'Pi 进程已退出' : `Pi 退出码 ${code}`, this.lastStderr]
            .filter((part) => part !== '')
            .join('：');
      this.queue.push({
        kind: 'ended',
        outcome: this.disposed ? 'stopped' : 'failed',
        ...(reason ? { reason } : {})
      });
      this.queue.close();
      for (const [, pending] of this.pending) pending.reject(new Error('Pi 进程已退出'));
      this.pending.clear();
    }
  }

  private send(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.counter += 1;
    const id = `c${this.counter}`;
    const payload = { id, ...command };
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  async prompt(text: string): Promise<Result<void, DomainError>> {
    try {
      await this.send({ type: 'prompt', message: text });
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: unavailable((error as Error).message) as DomainError };
    }
  }

  async interrupt(): Promise<void> {
    if (this.disposed) return;
    this.child.stdin.write(`${JSON.stringify({ type: 'abort' })}\n`);
  }

  events(): AsyncIterable<SessionEvent> {
    return this.queue;
  }

  /**
   * 双权威：送给模型的上下文由 Pi 自己的会话文件负责，平台只记住自己确认到哪。
   * 所以这里是记账，不是重放——重放会把同一段上下文送两遍。
   */
  async adopt(_cursor: number): Promise<void> {
    return;
  }

  /** 问 Pi 要它自己的会话 id：这是双权威之间那座桥的锚点。 */
  async identify(): Promise<string | null> {
    try {
      const response = await this.send({ type: 'get_state' });
      const data = response['data'] as Record<string, unknown> | undefined;
      const id = data?.['sessionId'];
      return typeof id === 'string' && id ? id : null;
    } catch {
      return null;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    this.child.once('exit', () => clearTimeout(timer));
  }
}

export interface PiRuntimeOptions {
  readonly command?: string;
  readonly sessionDir?: string;
  /** 本机 Pi 认得的模型列表。空数组表示「用 Pi 自己的默认」。 */
  readonly models?: readonly string[];
  readonly defaultModel?: string;
  readonly onAgentSessionRef?: (sessionId: string, agentSessionRef: string) => void;
}

export function createPiRuntime(options: PiRuntimeOptions = {}): AgentRuntime {
  const command = options.command ?? 'pi';

  return {
    descriptor: piDescriptorFor(options.models ?? [], options.defaultModel ?? '') satisfies AgentDescriptor,

    async start(spec: StartSpec): Promise<Result<RuntimeSession, DomainError>> {
      // 空 model 意味着「用 Pi 自己的默认」，不要硬塞一个可能不存在的模型名。
      const args = ['--mode', 'rpc', ...(spec.model === '' ? [] : ['--model', spec.model])];
      if (options.sessionDir) args.push('--session-dir', options.sessionDir);
      const ref = spec.resume?.agentSessionRef ?? null;
      if (ref) args.push('--session-id', ref);

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(command, args, { cwd: spec.workspaceRoot, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        return { ok: false, error: unavailable(`无法启动 Pi：${(error as Error).message}`) };
      }

      child.on('error', () => {
        /* 启动失败由 exit 事件与事件流共同反映，这里只避免未处理的 error 崩进程 */
      });

      const session = new PiSession(spec.sessionId, child);

      child.once('spawn', () => {
        void session.identify().then((ref) => {
          if (ref) options.onAgentSessionRef?.(spec.sessionId, ref);
        });
      });

      return { ok: true, value: session };
    }
  } satisfies AgentRuntime;
}
