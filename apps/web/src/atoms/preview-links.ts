import type { PreviewLinkDto } from '@agent-hub/contract';

/**
 * 预览页签的纯逻辑（docs/design/preview.md §3 / §10）。
 *
 * 链接不是拼在路径里，而是 hub 为每条预览多开一个监听端口：所以这里只要把
 * 「当前页面的协议 + 主机名」和 `hubPort` 拼起来，绝对路径、HMR、重定向全都天然正确。
 * 不碰 DOM，方便单测；组件只负责渲染和请求。
 */

/** 端口区间下限：1024 以下留给系统与 hub 自己，和 domain 侧 `previewPorts` 的约定一致。 */
export const PREVIEW_MIN_PORT = 1024;
export const PREVIEW_MAX_PORT = 65535;
/** 标签长度上限，和契约 `previewLinkSchema.label` 的 max(60) 一致。 */
export const PREVIEW_LABEL_LIMIT = 60;

/**
 * 打开预览用的地址。端口挂在主机名后面，原 host 里的端口（比如 hub 的 7878）丢掉：
 * 页面走 https 时预览也必须走 https，否则浏览器会因为混合内容把请求拦下来。
 */
export function previewUrlFor(location: { protocol: string; hostname: string }, hubPort: number): string {
  const scheme = location.protocol === 'https:' ? 'https' : 'http';
  return `${scheme}://${location.hostname}:${hubPort}`;
}

/**
 * 表单能不能提交；能提交返回 null，否则返回一句给人看的原因。
 * 端口只收整数：`3000.5`、`3000abc`、空着都不行，免得服务端报一个更陌生的错。
 */
export function previewDraftProblem(input: { port: string; label: string }): string | null {
  const port = input.port.trim();
  if (port === '') return '先填端口，比如 5173';
  if (!/^\d+$/.test(port)) return '端口只能是数字，比如 5173';
  const value = Number(port);
  if (value < PREVIEW_MIN_PORT || value > PREVIEW_MAX_PORT) {
    return `端口要在 ${PREVIEW_MIN_PORT}–${PREVIEW_MAX_PORT} 之间`;
  }
  const label = input.label.trim();
  if ([...label].length > PREVIEW_LABEL_LIMIT) return `标签最多 ${PREVIEW_LABEL_LIMIT} 个字`;
  return null;
}

/** 状态行：一句话说清楚现在能不能打开。 */
export function previewStateLine(link: { state: PreviewLinkDto['state'] }): string {
  if (link.state === 'ready') return '运行中';
  if (link.state === 'stale') return '服务没在跑';
  return '机器离线';
}

/**
 * 「最近活跃」的粗粒度写法：秒级的抖动对用户没意义，所以只分三档。
 * `lastSeenAt` 在未来（时钟偏差）时按「刚刚」处理，别显示成负数分钟。
 */
export function previewAge(now: number, lastSeenAt: number): string {
  const seconds = Math.max(0, Math.round((now - lastSeenAt) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
}

/** 列表顺序：先建好的在上，新加的排最后（用户的视线在表单附近，刚建的就在眼前）。 */
export function sortPreviews(links: readonly PreviewLinkDto[]): PreviewLinkDto[] {
  return [...links].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
