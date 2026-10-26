import { z } from 'zod';

/**
 * RPC 帧：与传输无关的请求-回复信封。谁都能发 call，谁都能回 reply / cancel。
 * WebSocket 只是承载它的一种适配器（见 node-gateway）；这里不认识任何传输。
 */
export const rpcErrorSchema = z.object({
  /** timeout | closed | cancelled | unknown_method | bad_params | bad_result | failed | invalid | forbidden */
  code: z.string().min(1),
  message: z.string()
});

export const rpcFrameSchema = z.discriminatedUnion('rpc', [
  z.object({ rpc: z.literal('call'), id: z.string().min(1), method: z.string().min(1), params: z.unknown() }),
  z.object({
    rpc: z.literal('reply'),
    id: z.string().min(1),
    result: z.unknown().optional(),
    error: rpcErrorSchema.optional()
  }),
  z.object({ rpc: z.literal('cancel'), id: z.string().min(1) })
]);

export type RpcError = z.infer<typeof rpcErrorSchema>;
export type RpcFrame = z.infer<typeof rpcFrameSchema>;
