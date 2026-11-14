import type { PreviewLinkId, SessionId } from './ids.ts';

/** 预览链接：把 worker 上的一个回环端口映射到 hub 的一个监听端口。见 docs/design/preview.md。 */

export const PREVIEW_LABELS_MAX = 60;
/** 单个会话最多挂这么多条预览。 */
export const PREVIEW_LINKS_MAX = 8;
/** 默认端口区间宽度（HUB_PORT+1 .. HUB_PORT+20）。 */
export const PREVIEW_PORT_SPAN = 20;

export interface PreviewLink {
  readonly id: PreviewLinkId;
  readonly sessionId: SessionId;
  readonly workerId: string;
  /** worker 上的回环端口。 */
  readonly port: number;
  /** hub 上分配的监听端口。 */
  readonly hubPort: number;
  readonly label: string;
  readonly source: 'detected' | 'manual';
  readonly state: 'ready' | 'stale' | 'offline';
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

/**
 * 解析 `HUB_PREVIEW_PORTS`（`17901-17920` 或单个 `17901`），没配时按 hub 端口往后推。
 * 区间非法（倒序、越界、为 0）时返回 null，让调用方关掉预览而不是猜。
 */
export function parsePreviewPortRange(
  raw: string | null | undefined,
  hubPort: number
): { readonly from: number; readonly to: number } | null {
  const text = raw?.trim() ?? '';
  if (text === '') {
    const from = hubPort + 1;
    const to = hubPort + PREVIEW_PORT_SPAN;
    if (from < 1 || to > 65535) return null;
    return { from, to };
  }
  const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(text);
  if (match === null) return null;
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  if (from < 1024 || to > 65535 || from > to) return null;
  return { from, to };
}

/** 端口允许范围之外的取值一律拒绝（只允许回环上跑着的普通服务端口）。 */
export function previewPortProblem(port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '端口要是 1–65535 的整数';
  if (port < 1024) return '端口不能小于 1024';
  return null;
}

export function previewLabelOf(label: string | undefined, port: number): string {
  const text = label?.trim() ?? '';
  if (text === '') return `端口 ${port}`;
  return text.slice(0, PREVIEW_LABELS_MAX);
}

export const previewLinkIdFrom = (hex: string): PreviewLinkId => `pv_${hex}` as PreviewLinkId;

/** hub 上给用户看的地址：绑定在哪个主机就从哪访问。 */
export function previewUrl(host: string, hubPort: number, https: boolean): string {
  return `${https ? 'https' : 'http'}://${host}:${hubPort}/`;
}
