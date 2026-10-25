import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AsyncQueue, jsonlRecords } from '@agent-hub/contract';
import type {
  AgentDescriptor,
  AgentRuntime,
  DomainError,
  OptionValue,
  Result,
  RuntimeOption,
  RuntimeSession,
  SessionEvent,
  StartSpec
} from '@agent-hub/domain';
import { unavailable } from '@agent-hub/domain';
import { piDescriptorFor } from './descriptor.ts';
import { createPiEventMapper } from './map-event.ts';

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

class PiSession implements RuntimeSession {
  readonly sessionId: RuntimeSession['sessionId'];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly queue = new AsyncQueue<SessionEvent>();
  private readonly pending = new Map<string, Pending>();
  private readonly mapper = createPiEventMapper();
  private counter = 0;
  private disposed = false;
  /**
   * Pi 的可调项不是一次问完的：模型清单在本机探测时就已知，
   * 但思考档位取决于**当前模型**（不支持的模型只给 `['off']`），
   * 所以换模型之后必须重新问一次，否则会给用户一个按下去就报错的档位。
   */
  private readonly modelChoices: readonly string[];
  private current: readonly RuntimeOption[] = [];
  private readonly onOptions: ((options: readonly RuntimeOption[]) => void) | undefined;
  /** Pi 的失败原因几乎都在 stderr 上（比如模型名有歧义），丢掉它等于把可诊断性丢了。 */
  private lastStderr = '';

  constructor(
    sessionId: RuntimeSession['sessionId'],
    child: ChildProcessWithoutNullStreams,
    modelChoices: readonly string[],
    onOptions?: (options: readonly RuntimeOption[]) => void
  ) {
    this.sessionId = sessionId;
    this.child = child;
    this.modelChoices = modelChoices;
    this.onOptions = onOptions;
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

  private async modelOption(): Promise<RuntimeOption | null> {
    if (this.modelChoices.length === 0) return null;
    let current = this.modelChoices[0] ?? '';
    try {
      const response = await this.send({ type: 'get_state' });
      const data = response['data'] as Record<string, unknown> | undefined;
      const model = data?.['model'] as { id?: unknown; provider?: unknown } | undefined;
      if (typeof model?.id === 'string' && typeof model.provider === 'string') {
        current = `${model.provider}/${model.id}`;
      }
    } catch {
      /* 问不到就用第一个：至少选择器不是空的 */
    }
    return {
      id: 'model',
      label: '模型',
      category: 'model',
      kind: 'select',
      current,
      choices: this.modelChoices.map<{ kind: 'value'; value: OptionValue }>((model) => ({
        kind: 'value',
        value: { value: model, label: model }
      }))
    };
  }

  private async thinkingOption(): Promise<RuntimeOption | null> {
    try {
      const response = await this.send({ type: 'get_available_thinking_levels' });
      const data = response['data'] as Record<string, unknown> | undefined;
      const raw = data?.['levels'] ?? data?.['thinkingLevels'];
      const levels = Array.isArray(raw) ? raw.filter((level): level is string => typeof level === 'string') : [];
      if (levels.length === 0) return null;
      const state = await this.send({ type: 'get_state' });
      const stateData = state['data'] as Record<string, unknown> | undefined;
      const current = typeof stateData?.['thinkingLevel'] === 'string' ? stateData['thinkingLevel'] : levels[0];
      return {
        id: 'thinking',
        label: '思考强度',
        category: 'thought_level',
        kind: 'select',
        current: current ?? levels[0] ?? 'off',
        choices: levels.map<{ kind: 'value'; value: OptionValue }>((level) => ({
          kind: 'value',
          value: { value: level, label: level }
        }))
      };
    } catch {
      return null;
    }
  }

  /** 问 Pi 一遍：模型 + 思考档位。两次往返换来一个「不撒谎」的选择器，值得。 */
  async loadOptions(): Promise<readonly RuntimeOption[]> {
    const options: RuntimeOption[] = [];
    const model = await this.modelOption();
    if (model) options.push(model);
    const thinking = await this.thinkingOption();
    if (thinking) options.push(thinking);
    this.current = options;
    if (options.length === 0) return options;
    this.onOptions?.(options);
    return options;
  }

  options(): readonly RuntimeOption[] {
    return this.current;
  }

  async changeOption(
    id: string,
    value: string | boolean
  ): Promise<Result<readonly RuntimeOption[], DomainError>> {
    try {
      if (id === 'model') {
        if (typeof value !== 'string') return { ok: false, error: unavailable('模型必须是一个字符串') };
        const slash = value.indexOf('/');
        if (slash <= 0) return { ok: false, error: unavailable(`模型名要写成 provider/model：${value}`) };
        await this.send({
          type: 'set_model',
          provider: value.slice(0, slash),
          modelId: value.slice(slash + 1)
        });
      } else if (id === 'thinking') {
        if (typeof value !== 'string') return { ok: false, error: unavailable('思考档位必须是一个字符串') };
        await this.send({ type: 'set_thinking_level', level: value });
      } else {
        return { ok: false, error: unavailable(`Pi 没有可调项 ${id}`) };
      }
      // 换模型会连带改变可用档位，所以整份重新问一遍。
      return { ok: true, value: await this.loadOptions() };
    } catch (error) {
      return { ok: false, error: unavailable((error as Error).message) };
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
  /** 可调项当前值上报（模型、思考强度）。 */
  readonly onOptions?: (sessionId: string, options: readonly RuntimeOption[]) => void;
}

export function createPiRuntime(options: PiRuntimeOptions = {}): AgentRuntime {
  const command = options.command ?? 'pi';

  return {
    descriptor: piDescriptorFor(
      options.models ?? [],
      options.defaultModel ?? ''
    ) satisfies AgentDescriptor,

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

      const session = new PiSession(spec.sessionId, child, options.models ?? [], (reported) =>
        options.onOptions?.(spec.sessionId, reported)
      );

      child.once('spawn', () => {
        void session.identify().then((ref) => {
          if (ref) options.onAgentSessionRef?.(spec.sessionId, ref);
        });
        void session.loadOptions();
      });

      return { ok: true, value: session };
    }
  } satisfies AgentRuntime;
}
