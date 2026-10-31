/**
 * 机器资源（ADR 0014）：Worker 采样、hub 只在内存里留「最新一份 + 最近 1 小时」。
 * 这里只放纯类型和纯函数：阈值、压力评估、防抖。采样在 node-gateway 的 ResourceProbe 实现里。
 */

export interface DiskUsage {
  readonly root: string;
  readonly total: number;
  readonly free: number;
}

export interface GpuUsage {
  readonly name: string;
  readonly utilPercent: number | null;
  readonly memTotal: number | null;
  readonly memUsed: number | null;
}

export interface MachineUsage {
  /** 全机 CPU 占用 0–100（两次采样之间的差）。第一次采样没有基准，为 null。 */
  readonly cpuPercent: number | null;
  readonly cores: number;
  /** 1/5/15 分钟负载；Windows 上没有，为 null。 */
  readonly load: readonly [number, number, number] | null;
  readonly memTotal: number;
  /** 「还能给新进程用的」内存：Linux 读 MemAvailable，别处退回 os.freemem()。 */
  readonly memAvailable: number;
  readonly swapUsed: number | null;
  readonly disks: readonly DiskUsage[];
  /** 有 GPU（nvidia-smi 可用）才有；没有就不带这个字段。 */
  readonly gpus?: readonly GpuUsage[];
  readonly uptimeSec: number;
}

export interface SessionUsage {
  readonly sessionId: string;
  readonly cpuPercent: number;
  /** 进程树的常驻内存合计，字节。 */
  readonly rss: number;
  readonly processes: number;
}

export interface ResourceSample {
  readonly at: number;
  readonly machine: MachineUsage;
  readonly sessions: readonly SessionUsage[];
}

export type PressureLevel = 'ok' | 'warn' | 'full';

export interface Pressure {
  readonly level: PressureLevel;
  /** 给人看的原因，按严重程度排；ok 时为空。 */
  readonly reasons: readonly string[];
}

export interface Thresholds {
  readonly memWarnRatio: number;
  readonly memFullRatio: number;
  readonly diskWarnRatio: number;
  readonly diskWarnBytes: number;
  readonly diskFullRatio: number;
  readonly diskFullBytes: number;
  readonly cpuWarnPercent: number;
  /** CPU 要连续高这么久才算 warn（CPU 高本身不会到 full）。 */
  readonly cpuSustainMs: number;
  /** 等级要连续这么多次采样一致才切换。 */
  readonly debounceSamples: number;
}

const GiB = 1024 ** 3;

export const DEFAULT_THRESHOLDS: Thresholds = {
  memWarnRatio: 0.15,
  memFullRatio: 0.05,
  diskWarnRatio: 0.1,
  diskWarnBytes: 5 * GiB,
  diskFullRatio: 0.02,
  diskFullBytes: 1 * GiB,
  cpuWarnPercent: 90,
  cpuSustainMs: 60_000,
  debounceSamples: 3
};

const rank: Record<PressureLevel, number> = { ok: 0, warn: 1, full: 2 };

export function formatBytes(bytes: number): string {
  if (bytes >= GiB) return `${(bytes / GiB).toFixed(bytes >= 10 * GiB ? 0 : 1)}G`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}M`;
  return `${Math.round(bytes / 1024)}K`;
}

/**
 * 只看一份采样（加上最近的历史判断 CPU 是否「持续」高）算出压力。不防抖。
 * history 是按时间升序、包含 sample 本身也行。
 */
export function assessPressure(
  sample: ResourceSample,
  history: readonly ResourceSample[] = [],
  thresholds: Thresholds = DEFAULT_THRESHOLDS
): Pressure {
  const found: { level: PressureLevel; reason: string }[] = [];
  const m = sample.machine;
  if (m.memTotal > 0) {
    const ratio = m.memAvailable / m.memTotal;
    if (ratio < thresholds.memFullRatio) found.push({ level: 'full', reason: `内存只剩 ${formatBytes(m.memAvailable)}` });
    else if (ratio < thresholds.memWarnRatio) found.push({ level: 'warn', reason: `内存只剩 ${formatBytes(m.memAvailable)}` });
  }
  for (const disk of m.disks) {
    if (disk.total <= 0) continue;
    const ratio = disk.free / disk.total;
    if (ratio < thresholds.diskFullRatio || disk.free < thresholds.diskFullBytes) {
      found.push({ level: 'full', reason: `${disk.root} 磁盘只剩 ${formatBytes(disk.free)}` });
    } else if (ratio < thresholds.diskWarnRatio || disk.free < thresholds.diskWarnBytes) {
      found.push({ level: 'warn', reason: `${disk.root} 磁盘只剩 ${formatBytes(disk.free)}` });
    }
  }
  if (m.cpuPercent !== null && m.cpuPercent > thresholds.cpuWarnPercent) {
    const since = sample.at - thresholds.cpuSustainMs;
    const window = history.filter((h) => h.at >= since && h.at < sample.at);
    const covered = window.length > 0 && window[0]!.at - since <= thresholds.cpuSustainMs / 2;
    if (covered && window.every((h) => h.machine.cpuPercent !== null && h.machine.cpuPercent > thresholds.cpuWarnPercent)) {
      found.push({ level: 'warn', reason: `CPU 持续 ${Math.round(m.cpuPercent)}%` });
    }
  }
  found.sort((a, b) => rank[b.level] - rank[a.level]);
  const level = found[0]?.level ?? 'ok';
  return { level, reasons: found.map((f) => f.reason) };
}

/**
 * 防抖：新等级要连续 n 次才生效，避免在阈值边上来回闪。
 * 纯函数：调用方保存返回的 state。
 */
export interface DebounceState {
  readonly current: Pressure;
  readonly candidate: PressureLevel | null;
  readonly streak: number;
}

export const initialDebounce: DebounceState = { current: { level: 'ok', reasons: [] }, candidate: null, streak: 0 };

export function debouncePressure(state: DebounceState, next: Pressure, samples = DEFAULT_THRESHOLDS.debounceSamples): DebounceState {
  if (next.level === state.current.level) return { current: next, candidate: null, streak: 0 };
  const streak = state.candidate === next.level ? state.streak + 1 : 1;
  if (streak >= samples) return { current: next, candidate: null, streak: 0 };
  return { current: state.current, candidate: next.level, streak };
}

/** hub 给 UI 的一台机器的资源视图（老 Worker 不报就没有这个字段）。 */
export interface WorkerResources {
  readonly sample: ResourceSample;
  readonly pressure: Pressure;
  /** 这台开了「满了就拒绝新会话」，并且现在是 full。 */
  readonly refusing: boolean;
  readonly refuseWhenFull: boolean;
}
