/**
 * 预览两种模式（端口映射 / 路径前缀）共用的头规则（#213 / #221 步骤 0）。
 *
 * 规则本体在 `@agent-hub/contract` 的 `wire/preview` 里，原因：worker 侧也要用同一份，
 * 而 worker 不能依赖 apps/server。这里只做 server 侧的稳定出口，两个模式从同一处取，
 * 否则换个模式就等于换个安全边界。
 */

export {
  PREVIEW_HOP_BY_HOP,
  PREVIEW_PRIVATE_REQUEST_HEADERS,
  PREVIEW_REQUEST_DROP,
  PREVIEW_RESPONSE_DROP,
  PREVIEW_REFERRER_POLICY,
  previewConnectionTokens,
  previewConnectionTokensFromPairs,
  previewRequestHeaderDropped,
  previewResponseHeaderDropped
} from '@agent-hub/contract';
