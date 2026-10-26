import type { z } from 'zod';
import type { RpcError } from './frames.ts';

/** 一个具名方法：名字 + 参数 / 结果的 schema。两端共用同一份定义，谁也不手写帧。 */
export interface RpcMethod<P extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly params: P;
  readonly result: R;
}

export type RpcOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RpcError };

export interface RpcCallOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface RpcHandlerContext {
  /** 对端发了 cancel 或通道关了。 */
  readonly signal: AbortSignal;
}

/**
 * 端口：用例 / 适配器只依赖它。实现（createRpcChannel）不知道底下是 WebSocket 还是别的。
 * request 永不 reject：超时、断线、对端报错都折成 { ok:false }。
 */
export interface RpcPort {
  request<P extends z.ZodType, R extends z.ZodType>(
    method: RpcMethod<P, R>,
    params: z.input<P>,
    options?: RpcCallOptions
  ): Promise<RpcOutcome<z.output<R>>>;
  handle<P extends z.ZodType, R extends z.ZodType>(
    method: RpcMethod<P, R>,
    handler: (params: z.output<P>, context: RpcHandlerContext) => Promise<z.input<R>>
  ): void;
}

/** handler 里抛它，对端拿到的就是这个 code（否则一律 failed）。 */
export class RpcFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
