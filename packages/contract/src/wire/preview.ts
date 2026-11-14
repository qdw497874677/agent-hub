import { z } from 'zod';

/** hub ↔ worker 的预览通道（单独一条 WS，不复用 /worker）。见 docs/design/preview.md §6。 */

export const PREVIEW_WS_PATH = '/preview';
export const PREVIEW_FRAME_BYTES = 64 * 1024;
export const PREVIEW_MAX_PAYLOAD = 2 * 1024 * 1024;

const streamIdSchema = z.string().regex(/^[0-9a-f]{16}$/);
const headerSchema = z.array(z.tuple([z.string().max(256), z.string().max(8192)])).max(128);
const base64Schema = z.string().max(90_000);

/** hub → worker。 */
export const previewUpSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('preview_open'),
    streamId: streamIdSchema,
    port: z.number().int().min(1).max(65535),
    method: z.string().min(1).max(16),
    path: z.string().min(1).max(8192),
    headers: headerSchema,
    upgrade: z.object({ protocol: z.string().max(256).nullable() }).optional()
  }),
  z.object({ kind: z.literal('preview_body'), streamId: streamIdSchema, data: base64Schema, end: z.boolean() }),
  z.object({ kind: z.literal('preview_close'), streamId: streamIdSchema }),
  z.object({ kind: z.literal('preview_pause'), streamId: streamIdSchema }),
  z.object({ kind: z.literal('preview_resume'), streamId: streamIdSchema }),
  z.object({ kind: z.literal('preview_ack'), streamId: streamIdSchema, credits: z.number().int().min(0).max(1024) })
]);

/** worker → hub。 */
export const previewDownSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('preview_head'),
    streamId: streamIdSchema,
    status: z.number().int().min(100).max(599),
    statusText: z.string().max(128),
    headers: headerSchema
  }),
  z.object({ kind: z.literal('preview_data'), streamId: streamIdSchema, data: base64Schema }),
  z.object({ kind: z.literal('preview_end'), streamId: streamIdSchema }),
  z.object({
    kind: z.literal('preview_failed'),
    streamId: streamIdSchema,
    message: z.string().max(500),
    code: z.enum(['refused', 'timeout', 'forbidden']).optional()
  })
]);

export type PreviewUpFrame = z.infer<typeof previewUpSchema>;
export type PreviewDownFrame = z.infer<typeof previewDownSchema>;

/** hub 侧预览链接的公开形状（DTO）。 */
export const previewLinkSchema = z.object({
  id: z.string().regex(/^pv_[0-9a-f]{8}$/),
  sessionId: z.string(),
  workerId: z.string(),
  port: z.number().int().min(1).max(65535),
  hubPort: z.number().int().min(1).max(65535),
  label: z.string().max(60),
  source: z.enum(['detected', 'manual']),
  state: z.enum(['ready', 'stale', 'offline']),
  createdAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative()
});
export type PreviewLinkDto = z.infer<typeof previewLinkSchema>;

export const createPreviewRequest = z.object({
  port: z.number().int().min(1).max(65535),
  label: z.string().trim().max(60).optional(),
  allowNonLoopback: z.boolean().optional()
});
export type CreatePreviewRequest = z.infer<typeof createPreviewRequest>;
