/** 连接健康徽标（ADR 0030 D1）：在线不等于好用——同步中 / 不稳定要说出来。老 hub 不报就不显示。 */
export type LinkInfo = {
  readonly state: 'connecting' | 'syncing' | 'live' | 'degraded' | 'disconnected' | 'rejected';
  readonly since: number;
  readonly rttMs: number | null;
  readonly connectedAt: number | null;
};

const TEXT: Record<LinkInfo['state'], string> = {
  connecting: '连接中',
  syncing: '同步中',
  live: '连接正常',
  degraded: '连接不稳',
  disconnected: '已断开',
  rejected: '被拒绝'
};

const TONE: Record<LinkInfo['state'], string> = {
  connecting: 'text-tertiary',
  syncing: 'text-tertiary',
  live: 'text-sage',
  degraded: 'text-accent',
  disconnected: 'text-tertiary',
  rejected: 'text-rust'
};

export function linkText(link: LinkInfo): string {
  const rtt = link.state === 'live' || link.state === 'degraded' ? (link.rttMs !== null ? ` · ${link.rttMs}ms` : '') : '';
  return `${TEXT[link.state]}${rtt}`;
}

export function LinkBadge({ link }: { link: LinkInfo | undefined }) {
  if (!link || link.state === 'disconnected') return null;
  return (
    <span data-testid="link-badge" data-state={link.state} className={`text-meta ${TONE[link.state]}`} title={`自 ${new Date(link.since).toLocaleTimeString()} 起`}>
      {linkText(link)}
    </span>
  );
}
