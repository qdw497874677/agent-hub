/**
 * 预览两种模式（端口映射 / 路径前缀）共用的头规则（#213 / #221 步骤 0）。
 *
 * 两种模式面对的是同一类上游 dev server，凭据头的处理必须完全一致——
 * 否则换个模式就等于换个安全边界。
 */

/** 客户端发来的、不该转给上游的头（hop-by-hop 以外的部分；两种模式共用）。 */
export const PREVIEW_REQUEST_DROP: ReadonlySet<string> = new Set([
  'host',
  'expect',
  'cookie',
  'authorization',
  'proxy-authorization'
]);

/** 上游响应的、不该回给浏览器的头。`set-cookie` 会让 dev server 在 hub 的 origin 上写 cookie。 */
export const PREVIEW_RESPONSE_DROP: ReadonlySet<string> = new Set(['set-cookie']);

/** 分享令牌走查询串，固定不让它经 Referer 外泄；上游自己设的也覆盖掉。 */
export const PREVIEW_REFERRER_POLICY = 'no-referrer';
