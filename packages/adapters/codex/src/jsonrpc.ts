import type { Readable, Writable } from 'node:stream';
import { jsonlRecords } from '@agent-hub/contract';

/** 报给 Codex 的客户端版本（与 `package.json` 的 version 保持一致）。 */
export const CODEX_CLIENT_VERSION = '0.0.0';

/** 无法解析的帧最多报几次诊断：坏流不该把事件通道刷屏。 */
const MAX_INVALID_FRAME_REPORTS = 3;

/** 输出流不可用时的固定诊断：不透传底层错误文本，避免把本机细节带出去。 */
const OUTPUT_FAILED_REASON = 'codex 连接写入失败';

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
  /**
   * 收到 JSON 解不开的帧时回调。回调不带任何原文：诊断必须是固定、有界的，
   * 不能把对端内容（可能含密钥）抄进日志或事件流。
   */
  readonly onInvalidFrame?: () => void;
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
 *
 * 切帧用 `@agent-hub/contract` 的 `jsonlRecords`：只按 LF 切，UTF-8 解码器跨 chunk
 * 保留状态，所以 JSON 字符串里合法的 U+2028 / U+2029、以及跨 chunk 的 CRLF 都不会被拆错。
 */
export class JsonRpcPeer {
  private readonly pending = new Map<number, Pending>();
  private readonly options: JsonRpcPeerOptions;
  private nextId = 0;
  private closed = false;
  private invalidFrames = 0;

  constructor(options: JsonRpcPeerOptions) {
    this.options = options;
    // 输出流坏掉（EPIPE / 被销毁）也必须走同一个终态：否则挂起的请求只能等超时，
    // 而 Writable 的 'error' 没人接住会变成未捕获异常。固定原因，不透传原始错误。
    this.options.output.on('error', () => this.close(OUTPUT_FAILED_REASON));
    // 持续读到 EOF（即使 close 之后也把剩余数据丢掉）：让流上的错误始终有人接住，
    // 不会因为提前停止读取冒出未处理的 'error'。
    void this.pump();
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
  }

  private async pump(): Promise<void> {
    try {
      for await (const line of jsonlRecords(this.options.input)) {
        if (this.closed) continue;
        this.handleLine(line);
      }
    } catch (error) {
      // 读失败和 EOF 一样是终态：之后的请求没有回复路径，必须立刻拒绝而不是等超时。
      this.close(errorText(error).slice(0, 200));
      return;
    }
    // EOF 之后不会再有任何响应：挂着的请求必须立刻拒掉，不能等各自的超时；
    // 同时把对端标成已关闭，之后新建的请求连写都不写。
    this.close('codex 连接已关闭');
  }

  private write(payload: unknown): void {
    if (this.closed) return;
    const stream = this.options.output;
    // 输出已经不可写：立刻终结，不能让请求在无回复的流上挂到超时。
    if (stream.destroyed || stream.writableEnded) {
      this.close(OUTPUT_FAILED_REASON);
      return;
    }
    try {
      stream.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error !== null && error !== undefined) this.close(OUTPUT_FAILED_REASON);
      });
    } catch {
      // write 同步抛错（流状态异常）同样按输出失败处理。
      this.close(OUTPUT_FAILED_REASON);
    }
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
      this.invalidFrames += 1;
      if (this.invalidFrames <= MAX_INVALID_FRAME_REPORTS) this.options.onInvalidFrame?.();
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
