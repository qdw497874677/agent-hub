/** 界面上的绝对时间一律用看的人所在时区：`M-DD HH:mm`。 */
export function localTime(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const INSTANT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/g;

/**
 * 服务器写进文字里的时刻（ISO 8601，带 Z 或时区偏移，例如审计里的「有效至 …Z」）换成本地时间。
 * 服务器不知道看的人在哪个时区，所以存 UTC、到界面上再换；没带时区的不碰（不知道该按哪个区解释）。
 */
export function localizeInstants(text: string): string {
  return text.replace(INSTANT, (iso) => {
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? iso : localTime(ms);
  });
}
