import type { z } from 'zod';
import { rpcFrameSchema, type RpcError, type RpcFrame } from './frames.ts';
import { RpcFailure, type RpcCallOptions, type RpcMethod, type RpcOutcome, type RpcPort } from './port.ts';

export interface RpcChannelOptions {
  /** 把帧交给底下的传输；返回 false = 此刻发不出去（断线）。 */
  readonly send: (frame: RpcFrame) => boolean;
  readonly timeoutMs?: number;
  /** id 前缀：两端各用各的，日志里一眼分得清是谁发起的。 */
  readonly idPrefix?: string;
}

export interface RpcChannel extends RpcPort {
  /** 传输收到一帧（已解析的 JSON）就交给这里。 */
  receive(frame: unknown): void;
  /** 传输断了：在途的请求一律以 closed 结束，对端发来的在跑的调用被取消。 */
  close(reason: string): void;
}

type Waiting = { readonly settle: (outcome: RpcOutcome<unknown>) => void; readonly timer: ReturnType<typeof setTimeout> };
type Handler = (params: unknown, context: { signal: AbortSignal }) => Promise<unknown>;

const fail = (code: string, message: string): RpcOutcome<never> => ({ ok: false, error: { code, message } });

/** 端口的唯一实现：请求-回复按 id 对上，带超时与取消。纯逻辑，不碰任何 I/O。 */
export function createRpcChannel(options: RpcChannelOptions): RpcChannel {
  const waiting = new Map<string, Waiting>();
  const running = new Map<string, AbortController>();
  const handlers = new Map<string, { method: RpcMethod; run: Handler }>();
  const defaultTimeout = options.timeoutMs ?? 30_000;
  const prefix = options.idPrefix ?? 'r';
  let seq = 0;

  const finish = (id: string, outcome: RpcOutcome<unknown>): void => {
    const entry = waiting.get(id);
    if (!entry) return;
    waiting.delete(id);
    clearTimeout(entry.timer);
    entry.settle(outcome);
  };

  async function serve(id: string, method: string, params: unknown): Promise<void> {
    const reply = (body: { result?: unknown; error?: RpcError }): void => {
      if (!running.has(id)) return; // 已被取消：对端不再等
      running.delete(id);
      options.send({ rpc: 'reply', id, ...body });
    };
    const controller = new AbortController();
    running.set(id, controller);
    const entry = handlers.get(method);
    if (!entry) return reply({ error: { code: 'unknown_method', message: `对端不认识方法 ${method}` } });
    const parsed = entry.method.params.safeParse(params);
    if (!parsed.success) return reply({ error: { code: 'bad_params', message: parsed.error.message } });
    try {
      const result = await entry.run(parsed.data, { signal: controller.signal });
      reply({ result });
    } catch (error) {
      reply({
        error:
          error instanceof RpcFailure
            ? { code: error.code, message: error.message }
            : { code: 'failed', message: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  return {
    request<P extends z.ZodType, R extends z.ZodType>(
      method: RpcMethod<P, R>,
      params: z.input<P>,
      call: RpcCallOptions = {}
    ): Promise<RpcOutcome<z.output<R>>> {
      return new Promise((resolve) => {
        if (call.signal?.aborted) return resolve(fail('cancelled', '调用方已取消'));
        seq += 1;
        const id = `${prefix}${seq}`;
        const timeoutMs = call.timeoutMs ?? defaultTimeout;
        const timer = setTimeout(() => {
          options.send({ rpc: 'cancel', id });
          finish(id, fail('timeout', `${method.name} 超时（${timeoutMs}ms）`));
        }, timeoutMs);
        (timer as { unref?: () => void }).unref?.();
        const onAbort = (): void => {
          options.send({ rpc: 'cancel', id });
          finish(id, fail('cancelled', '调用方已取消'));
        };
        call.signal?.addEventListener('abort', onAbort, { once: true });
        waiting.set(id, {
          timer,
          settle: (outcome) => {
            call.signal?.removeEventListener('abort', onAbort);
            if (!outcome.ok) return resolve(outcome);
            const checked = method.result.safeParse(outcome.value);
            resolve(checked.success ? { ok: true, value: checked.data } : fail('bad_result', checked.error.message));
          }
        });
        if (!options.send({ rpc: 'call', id, method: method.name, params })) finish(id, fail('closed', '通道未连接'));
      });
    },

    handle(method, handler): void {
      handlers.set(method.name, { method, run: handler as Handler });
    },

    receive(raw: unknown): void {
      const parsed = rpcFrameSchema.safeParse(raw);
      if (!parsed.success) return;
      const frame = parsed.data;
      if (frame.rpc === 'call') void serve(frame.id, frame.method, frame.params);
      else if (frame.rpc === 'cancel') {
        running.get(frame.id)?.abort();
        running.delete(frame.id);
      } else finish(frame.id, frame.error ? { ok: false, error: frame.error } : { ok: true, value: frame.result });
    },

    close(reason: string): void {
      for (const id of [...waiting.keys()]) finish(id, fail('closed', reason));
      for (const controller of running.values()) controller.abort();
      running.clear();
    }
  };
}
