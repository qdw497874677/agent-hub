import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import pidtree from 'pidtree';
import pidusage from 'pidusage';
import type { DiskUsage, GpuUsage, ResourceProbe, ResourceSample, SessionUsage } from '@agent-hub/domain';

/**
 * ResourceProbe 的 Node 实现（ADR 0014）：
 * - CPU：两次 os.cpus() 的差；
 * - 内存：Linux 读 /proc/meminfo 的 MemAvailable（free 会把缓存算成「用掉了」），别处退回 os.freemem()；
 * - 磁盘：对 WORKER_ROOTS 逐个 statfs，同一块盘只报一次；
 * - 会话：pidtree 找出 agent 进程树，pidusage 汇总 CPU / RSS；
 * - GPU：有 nvidia-smi 才采，60 秒一次、2 秒超时；没有就不带 gpus 字段。
 */

export interface ResourceProbeOptions {
  readonly roots: readonly string[];
  readonly now?: () => number;
  /** 测试注入：替换外部命令 / 文件读取。 */
  readonly readText?: (path: string) => Promise<string>;
  readonly runGpuQuery?: () => Promise<string | null>;
  readonly gpuIntervalMs?: number;
}

type CpuTimes = { idle: number; total: number };

const cpuTimes = (): CpuTimes =>
  os.cpus().reduce(
    (acc, cpu) => {
      const t = cpu.times;
      acc.idle += t.idle;
      acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
      return acc;
    },
    { idle: 0, total: 0 }
  );

export function parseMeminfo(text: string): { total: number; available: number; swapUsed: number } | null {
  const kb = (key: string): number | null => {
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : null;
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  if (total === null || available === null) return null;
  const swapTotal = kb('SwapTotal') ?? 0;
  const swapFree = kb('SwapFree') ?? 0;
  return { total, available, swapUsed: Math.max(0, swapTotal - swapFree) };
}

/** nvidia-smi --query-gpu=name,utilization.gpu,memory.total,memory.used --format=csv,noheader,nounits */
export function parseNvidiaSmi(text: string): GpuUsage[] {
  const num = (value: string | undefined): number | null => {
    const n = Number(value?.trim());
    return value === undefined || value.trim() === '' || Number.isNaN(n) ? null : n;
  };
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((line) => {
      const [name, util, total, used] = line.split(',');
      const mib = (value: string | undefined) => {
        const n = num(value);
        return n === null ? null : n * 1024 * 1024;
      };
      const u = num(util);
      return { name: (name ?? '').trim().slice(0, 200), utilPercent: u === null ? null : Math.min(100, Math.max(0, u)), memTotal: mib(total), memUsed: mib(used) };
    });
}

const defaultGpuQuery = (): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,utilization.gpu,memory.total,memory.used', '--format=csv,noheader,nounits'],
      { timeout: 2000, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout)
    );
  });

export function createResourceProbe(options: ResourceProbeOptions): ResourceProbe {
  const now = options.now ?? Date.now;
  const readText = options.readText ?? ((path: string) => readFile(path, 'utf8'));
  const runGpuQuery = options.runGpuQuery ?? defaultGpuQuery;
  const gpuInterval = options.gpuIntervalMs ?? 60_000;
  let previous: CpuTimes | null = null;
  // GPU：null = 还没探过；false = 没有 nvidia-smi，不再试
  let gpuAvailable: boolean | null = null;
  let gpus: GpuUsage[] | undefined;
  let gpuAt = 0;

  async function machineCpu(): Promise<number | null> {
    const current = cpuTimes();
    const prev = previous;
    previous = current;
    if (!prev) return null;
    const total = current.total - prev.total;
    if (total <= 0) return null;
    return Math.min(100, Math.max(0, (1 - (current.idle - prev.idle) / total) * 100));
  }

  async function memory() {
    if (process.platform === 'linux') {
      const parsed = parseMeminfo(await readText('/proc/meminfo').catch(() => ''));
      if (parsed) return parsed;
    }
    return { total: os.totalmem(), available: os.freemem(), swapUsed: null };
  }

  async function disks(): Promise<DiskUsage[]> {
    const seen = new Set<string>();
    const out: DiskUsage[] = [];
    for (const root of options.roots.slice(0, 32)) {
      try {
        const st = await statfs(root);
        const total = st.blocks * st.bsize;
        const free = st.bavail * st.bsize;
        // 同一块盘（总量和剩余都一样）只报一次
        const key = `${total}:${st.bfree}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ root, total, free });
        if (out.length >= 16) break;
      } catch {
        // 目录没了 / 没权限：跳过，不让一个坏目录拖垮整份采样
      }
    }
    return out;
  }

  async function gpu(): Promise<GpuUsage[] | undefined> {
    if (gpuAvailable === false) return undefined;
    if (gpuAvailable === true && now() - gpuAt < gpuInterval) return gpus;
    const text = await runGpuQuery();
    gpuAt = now();
    if (text === null) {
      // 第一次就失败 = 这台没有 NVIDIA GPU，以后都不再起进程；之前成功过则只是这次没采到
      if (gpuAvailable === null) gpuAvailable = false;
      return gpuAvailable ? gpus : undefined;
    }
    gpuAvailable = true;
    const parsed = parseNvidiaSmi(text);
    gpus = parsed.length > 0 ? parsed : undefined;
    return gpus;
  }

  async function sessions(map: ReadonlyMap<string, number>): Promise<SessionUsage[]> {
    const out: SessionUsage[] = [];
    for (const [sessionId, pid] of [...map].slice(0, 256)) {
      try {
        const children = await pidtree(pid).catch(() => [] as number[]);
        const pids = [pid, ...children];
        const stats = await pidusage(pids);
        let cpu = 0;
        let rss = 0;
        let processes = 0;
        for (const stat of Object.values(stats)) {
          if (!stat) continue;
          cpu += stat.cpu;
          rss += stat.memory;
          processes += 1;
        }
        if (processes > 0) out.push({ sessionId, cpuPercent: Math.round(cpu * 10) / 10, rss, processes });
      } catch {
        // 进程刚退出：这次不报它
      }
    }
    return out;
  }

  return {
    async sample(map) {
      const [cpuPercent, mem, diskList, gpuList, sessionList] = await Promise.all([machineCpu(), memory(), disks(), gpu(), sessions(map)]);
      const load = process.platform === 'win32' ? null : (os.loadavg() as [number, number, number]);
      const sample: ResourceSample = {
        at: now(),
        machine: {
          cpuPercent: cpuPercent === null ? null : Math.round(cpuPercent * 10) / 10,
          cores: os.cpus().length,
          load,
          memTotal: mem.total,
          memAvailable: mem.available,
          swapUsed: mem.swapUsed,
          disks: diskList,
          ...(gpuList ? { gpus: gpuList } : {}),
          uptimeSec: Math.round(os.uptime())
        },
        sessions: sessionList
      };
      return sample;
    }
  };
}
