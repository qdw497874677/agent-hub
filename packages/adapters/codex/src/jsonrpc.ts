import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** 报给 Codex 的客户端版本（与 `package.json` 的 version 保持一致）。 */
export const CODEX_CLIENT_VERSION = '0.0.0';

export interface JsonRpcErrorPayload {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(payload: JsonRpcErrorPayload) {
    super(payload.message);
    this.name = 'JsonRpcError';
    this.code = payload.code;
    this.data = payload.data;
  }
}

export type JsonRpcRequestHandler = (
  method: string,
  params: Record<string, unknown>,
  respond: (result: unknown) => void,
  fail: (code: number, message: string) => void
) => void;

export interface JsonRpcPeerOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly defaultTimeoutMs?: number;
  readonly onNotification?: (method: string, params: Record<string, unknown>) => void;
  readonly onRequest?: JsonRpcRequestHandler;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 最小 JSON-RPC 2.0 对端：一行一条消息，请求按 id 配对，服务端发来的
 * request（审批）交给 `onRequest`，notification 交给 `onNotification`。
 * 只管协议，不碰进程：stdin/stdout 由调用方给。
 */
export class JsonRpcPeer {
  private readonly pending = new Map<number, Pending>();
  private readonly lines;
  private readonly options: JsonRpcPeerOptions;
  private nextId = 0;
  private closed = false;

  constructor(options: JsonRpcPeerOptions) {
    this.options = options;
    this.lines = createInterface({ input: options.input, crlfDelay: Infinity });
    this.lines.on('line', (line) => this.handleLine(line));
    this.lines.on('close', () => this.failAll(new Error('codex 连接已关闭')));
  }

  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('codex 连接已关闭'));
    const id = ++this.nextId;
    const timeout = timeoutMs ?? this.options.defaultTimeoutMs ?? 30_000;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex 在 ${timeout}ms 内没有回应 ${method}`));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params: params ?? {} });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  /** 回服务端发来的 request（审批结果）。已关闭或流已坏时静默丢弃。 */
  respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result: result ?? null });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  close(reason = '连接已关闭'): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error(reason));
    this.lines.close();
  }

  private write(payload: unknown): void {
    if (this.closed) return;
    const stream = this.options.output;
    if (stream.destroyed || stream.writableEnded) return;
    stream.write(`${JSON.stringify(payload)}\n`, (error) => {
      if (error) this.failAll(error);
    });
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private handleLine(line: string): void {
    const text = line.trim();
    if (text === '') return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const record = asRecord(message);
    const method = typeof record['method'] === 'string' ? record['method'] : '';
    const id = record['id'];
    const hasId = typeof id === 'number' || typeof id === 'string';
    if (method !== '') {
      const params = asRecord(record['params']);
      if (!hasId) {
        this.options.onNotification?.(method, params);
        return;
      }
      let answered = false;
      const respond = (result: unknown): void => {
        if (answered) return;
        answered = true;
        this.respond(id, result);
      };
      const fail = (code: number, errorMessage: string): void => {
        if (answered) return;
        answered = true;
        this.respondError(id, code, errorMessage);
      };
      if (this.options.onRequest === undefined) {
        fail(-32601, `没有实现的方法：${method}`);
        return;
      }
      try {
        this.options.onRequest(method, params, respond, fail);
      } catch (error) {
        fail(-32603, errorText(error));
      }
      return;
    }
    if (!hasId || typeof id !== 'number') return;
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const errorPayload = asRecord(record['error']);
    if (Object.keys(errorPayload).length > 0) {
      pending.reject(
        new JsonRpcError({
          code: typeof errorPayload['code'] === 'number' ? errorPayload['code'] : 0,
          message: typeof errorPayload['message'] === 'string' ? errorPayload['message'] : 'codex 返回了错误',
          data: errorPayload['data']
        })
      );
      return;
    }
    pending.resolve(record['result'] ?? null);
  }
}
