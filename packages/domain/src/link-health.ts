/**
 * 连接健康（ADR 0030 D1）。纯状态机：hub 每条 Worker 连接一份，网关把心跳 / 回声 / 断线事件喂进来。
 *
 * - syncing：hello 被接受，还没确认对端真的在处理帧（第一次回声没回来）。
 * - live：心跳和回声都正常。
 * - degraded：漏了心跳，或回声超时 / 太慢——连接还在，但别指望它及时。
 * - disconnected：断了（心跳判死或对端关闭）。
 * - rejected：被拒（凭据不对、被管理员踢、协议不兼容），不会自己回来。
 * connecting 只在 Worker 侧有意义，hub 看不到。
 */
export type LinkState = 'connecting' | 'syncing' | 'live' | 'degraded' | 'disconnected' | 'rejected';

export interface HeartbeatPolicy {
  /** hub 发 ping 的间隔。 */
  readonly intervalMs: number;
  /** 连续漏几次 pong 判死（Q1：2）。 */
  readonly missLimit: number;
  /** 应用层回声（link.echo）的间隔。 */
  readonly echoMs: number;
  /** 回声超过这么久算慢 / 失败。 */
  readonly echoTimeoutMs: number;
}

export const DEFAULT_HEARTBEAT: HeartbeatPolicy = { intervalMs: 10_000, missLimit: 2, echoMs: 30_000, echoTimeoutMs: 10_000 };

/** Worker 侧看门狗：比 hub 判死多等一个间隔，避免两边同时抢着断。 */
export const workerWatchdogMs = (policy: Pick<HeartbeatPolicy, 'intervalMs' | 'missLimit'>): number =>
  policy.intervalMs * (policy.missLimit + 1);

export interface LinkHealth {
  readonly state: LinkState;
  /** 进入当前状态的时间。 */
  readonly since: number;
  /** 这条连接建立的时间；断了保留最后一次的。 */
  readonly connectedAt: number | null;
  /** 最近一次回声往返（ms）；没测过 / 老 Worker 不支持为 null。 */
  readonly rttMs: number | null;
  /** 连续漏掉的 pong。 */
  readonly missed: number;
  /** 回声是否卡住（超时或太慢）。 */
  readonly echoStalled: boolean;
  /** 收到过任何一次回声结果（含「不支持」）：从 syncing 走出来的条件。 */
  readonly synced: boolean;
}

export type LinkEvent =
  | { readonly type: 'connected' }
  | { readonly type: 'pong' }
  | { readonly type: 'missed' }
  /** rttMs = null：对端不认识 link.echo（老 Worker），只当它活着。 */
  | { readonly type: 'echo'; readonly rttMs: number | null }
  | { readonly type: 'echo_failed' }
  | { readonly type: 'closed'; readonly rejected: boolean };

export const initialLink = (at: number): LinkHealth => ({
  state: 'disconnected',
  since: at,
  connectedAt: null,
  rttMs: null,
  missed: 0,
  echoStalled: false,
  synced: false
});

function settle(health: Omit<LinkHealth, 'state' | 'since'>, previous: LinkHealth, at: number): LinkHealth {
  const state: LinkState = !health.synced ? (health.missed > 0 || health.echoStalled ? 'degraded' : 'syncing') : health.missed > 0 || health.echoStalled ? 'degraded' : 'live';
  return { ...health, state, since: state === previous.state ? previous.since : at };
}

export function reduceLink(health: LinkHealth, event: LinkEvent, at: number, policy: HeartbeatPolicy = DEFAULT_HEARTBEAT): LinkHealth {
  const { state: _state, since: _since, ...rest } = health;
  switch (event.type) {
    case 'connected':
      return { state: 'syncing', since: at, connectedAt: at, rttMs: null, missed: 0, echoStalled: false, synced: false };
    case 'closed': {
      const state: LinkState = event.rejected ? 'rejected' : 'disconnected';
      return { ...rest, missed: 0, echoStalled: false, synced: false, state, since: health.state === state ? health.since : at };
    }
    default:
      if (health.state === 'disconnected' || health.state === 'rejected') return health;
  }
  switch (event.type) {
    case 'pong':
      return settle({ ...rest, missed: 0 }, health, at);
    case 'missed':
      return settle({ ...rest, missed: rest.missed + 1 }, health, at);
    case 'echo':
      return settle({ ...rest, synced: true, rttMs: event.rttMs, echoStalled: event.rttMs !== null && event.rttMs > policy.echoTimeoutMs }, health, at);
    case 'echo_failed':
      return settle({ ...rest, echoStalled: true }, health, at);
  }
}

/** 漏到上限就该断开重来。 */
export const linkIsDead = (health: LinkHealth, policy: HeartbeatPolicy = DEFAULT_HEARTBEAT): boolean => health.missed >= policy.missLimit;

/**
 * Worker 重连退避（Q2）：指数退避封顶 60 秒；只有连上并稳定满 stableMs 才把次数清零，
 * 免得「连上就被踢」的循环每次都从 0.5 秒重来、把 hub 打爆。
 */
export const RECONNECT_POLICY = { baseMs: 500, capMs: 60_000, stableMs: 60_000 } as const;

export function reconnectDelay(attempt: number, random: number, policy: { baseMs: number; capMs: number } = RECONNECT_POLICY): number {
  const raw = Math.min(policy.capMs, policy.baseMs * 2 ** Math.min(attempt, 30));
  return Math.round(raw * (0.8 + random * 0.4));
}
