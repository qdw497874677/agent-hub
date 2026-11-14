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

/**
 * 公开分享的有效期档位（小时）。1 小时用来临时给同事看一眼，7 天是常用上限；
 * 真正的天花板由后端兜（`sharePreviewRequest` 的 max 720）。
 */
export const shareHoursOptions = [1, 24, 72, 168] as const;

/** 档位的人话（1 小时 / 1 天 / 3 天 / 7 天），界面上不出现「24 小时」这种要心算的写法。 */
export function shareHoursLabel(hours: number): string {
  if (hours === 1) return '1 小时';
  if (hours % 24 === 0) return `${hours / 24} 天`;
  return `${hours} 小时`;
}

const HOUR_MS = 3_600_000;

/**
 * 分享状态那一行：只说「还开着多久」或「已经过期」，没分享就什么都不说（返回 null）。
 *
 * 有 `expiresAt` 才谈得上剩多久；后端理论上两者一起给，但缺一个就当没有（宁可少说一句，
 * 也不要在界面上编一个到期时间）。
 */
export function shareStateText(link: { shared: boolean; shareExpiresAt: number | null }, now: number): string | null {
  if (!link.shared || link.shareExpiresAt === null) return null;
  const left = link.shareExpiresAt - now;
  if (left <= 0) return '分享已过期';
  if (left < HOUR_MS) return '公开分享 · 不到 1 小时';
  // 向上取整：还剩 23 小时 10 分时说「还有 24 小时」，别让人以为少算了一截。
  return `公开分享 · 还有 ${Math.ceil(left / HOUR_MS)} 小时`;
}

/** 分享是否仍然有效（行上的「公开」标签只在有效时亮）。 */
export function shareActive(link: { shared: boolean; shareExpiresAt: number | null }, now: number): boolean {
  return link.shared && link.shareExpiresAt !== null && link.shareExpiresAt > now;
}
