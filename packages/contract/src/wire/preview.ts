import { z } from 'zod';

/** hub ↔ worker 的预览通道（单独一条 WS，不复用 /worker）。见 docs/design/preview.md §6。 */

export const PREVIEW_WS_PATH = '/preview';
export const PREVIEW_FRAME_BYTES = 64 * 1024;
export const PREVIEW_MAX_PAYLOAD = 2 * 1024 * 1024;

/**
 * 预览链路上「哪些头不该继续往前走」的唯一一份规则（hub 两种模式 + worker 共用）。
 *
 * 放在 contract 里是因为 hub（apps/server）与 worker（packages/node-gateway）都要用，
 * 而 worker 不能反向依赖 apps/server。两边各写一份的话，换个入口就等于换个安全边界。
 * 这里只做规范化判断（大小写不敏感），具体模式差异（CSP / Referer / host 重写）留在各自入口。
 */

/** HTTP 逐跳头：只在单条连接上有意义，代理不该转发（RFC 9110 §7.6.1）。 */
export const PREVIEW_HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

/** 只属于 hub 这一跳的凭据：dev server 不该看到，也不该拿它冒充用户。 */
export const PREVIEW_PRIVATE_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'cookie',
  'authorization',
  'proxy-authorization'
]);

/** 客户端发来的、不该转给上游的头（host 重写、expect 只对当前连接有意义）。 */
export const PREVIEW_REQUEST_DROP: ReadonlySet<string> = new Set([
  'host',
  'expect',
  ...PREVIEW_PRIVATE_REQUEST_HEADERS
]);

/** 上游响应的、不该回给浏览器的头。`set-cookie` 会让 dev server 在 hub 的 origin 上写 cookie。 */
export const PREVIEW_RESPONSE_DROP: ReadonlySet<string> = new Set(['set-cookie']);

/** 分享令牌走查询串，固定不让它经 Referer 外泄；上游自己设的也覆盖掉。 */
export const PREVIEW_REFERRER_POLICY = 'no-referrer';

/** 把 `Connection` 头拆成小写 token 集合（这些字段同样是逐跳的，必须一起丢）。 */
export function previewConnectionTokens(value: string | readonly string[] | undefined): ReadonlySet<string> {
  const tokens = new Set<string>();
  if (value === undefined) return tokens;
  for (const item of typeof value === 'string' ? [value] : value) {
    for (const token of item.toLowerCase().split(',')) {
      const trimmed = token.trim();
      if (trimmed !== '') tokens.add(trimmed);
    }
  }
  return tokens;
}

/**
 * 从「名字可能重复」的头对里收集**所有** `Connection` 行。
 *
 * 只取第一条会漏掉后一条点名的动态逐跳字段（Node 的 rawHeaders / hub 的 `PreviewHead`
 * 都是按对给出的，重复行很常见）。
 */
export function previewConnectionTokensFromPairs(
  headers: Iterable<readonly [string, string]>
): ReadonlySet<string> {
  const values: string[] = [];
  for (const [name, value] of headers) {
    if (name.toLowerCase() === 'connection') values.push(value);
  }
  return previewConnectionTokens(values);
}

/**
 * 请求头该不该丢掉（名字大小写不敏感）。
 *
 * `upgrade` 为 true 时仍会丢掉 `connection` / `upgrade`：升级请求必须带这两个头，
 * 但值由调用方显式补成规范形式，避免把浏览器的那份再叠加一遍。
 * 同时关掉 `sec-websocket-extensions`：预览隧道不做 permessage-deflate 协商。
 * `connectionTokens` 是 RFC 9110 要求的动态逐跳字段。
 */
export function previewRequestHeaderDropped(
  name: string,
  options: { readonly upgrade?: boolean; readonly connectionTokens?: ReadonlySet<string> } = {}
): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('proxy-')) return true;
  if (PREVIEW_REQUEST_DROP.has(lower)) return true;
  if (PREVIEW_HOP_BY_HOP.has(lower)) return true;
  if (options.connectionTokens?.has(lower) === true) return true;
  return options.upgrade === true && lower === 'sec-websocket-extensions';
}

/**
 * 响应头该不该丢掉（名字大小写不敏感）。
 *
 * 和请求方向共用同一份逐跳 / `proxy-*` / `set-cookie` 规则，外加 `Connection` 点名的动态字段。
 * 101 的 `connection` / `upgrade` 也在这里丢掉，由调用方补成唯一的规范值；
 * 协商结果（`sec-websocket-protocol` / `sec-websocket-accept`）不在此名单里，保持原样。
 */
export function previewResponseHeaderDropped(
  name: string,
  options: { readonly connectionTokens?: ReadonlySet<string> } = {}
): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('proxy-')) return true;
  if (PREVIEW_RESPONSE_DROP.has(lower)) return true;
  if (PREVIEW_HOP_BY_HOP.has(lower)) return true;
  return options.connectionTokens?.has(lower) === true;
}

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
  /** 这台机器上正在监听的回环端口（定期上报，hub 用来标 ready / stale）。 */
  z.object({ kind: z.literal('preview_ports'), ports: z.array(z.number().int().min(1).max(65535)).max(256) }),
  /** 从终端输出里认出来的端口；`port` 已经过 worker 侧 /proc 校验。 */
  z.object({
    kind: z.literal('preview_detected'),
    sessionId: z.string().min(1).max(200),
    port: z.number().int().min(1).max(65535),
    label: z.string().max(60).optional()
  }),
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
  lastSeenAt: z.number().int().nonnegative(),
  /** 是否签了公开分享令牌（令牌本身只存哈希，不回传）。 */
  shared: z.boolean(),
  shareExpiresAt: z.number().int().nonnegative().nullable()
});
export type PreviewLinkDto = z.infer<typeof previewLinkSchema>;

export const sharePreviewRequest = z.object({
  /** 有效期（小时），默认 24，上限 24 * 30。 */
  hours: z.number().int().min(1).max(720).optional()
});

export const createPreviewRequest = z.object({
  port: z.number().int().min(1).max(65535),
  label: z.string().trim().max(60).optional(),
  allowNonLoopback: z.boolean().optional()
});
export type CreatePreviewRequest = z.infer<typeof createPreviewRequest>;
