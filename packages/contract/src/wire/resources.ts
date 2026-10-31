import { z } from 'zod';

/** 机器资源（ADR 0014）。上限防一台坏 Worker 塞爆 hub 内存。 */

const bytes = z.number().nonnegative();

export const diskUsageSchema = z.object({ root: z.string().max(4096), total: bytes, free: bytes });

export const gpuUsageSchema = z.object({
  name: z.string().max(200),
  utilPercent: z.number().min(0).max(100).nullable(),
  memTotal: bytes.nullable(),
  memUsed: bytes.nullable()
});

export const machineUsageSchema = z.object({
  cpuPercent: z.number().min(0).max(100).nullable(),
  cores: z.number().int().nonnegative(),
  load: z.tuple([z.number(), z.number(), z.number()]).nullable(),
  memTotal: bytes,
  memAvailable: bytes,
  swapUsed: bytes.nullable(),
  disks: z.array(diskUsageSchema).max(16),
  gpus: z.array(gpuUsageSchema).max(8).optional(),
  uptimeSec: z.number().nonnegative()
});

export const sessionUsageSchema = z.object({
  sessionId: z.string().min(1).max(200),
  cpuPercent: z.number().nonnegative(),
  rss: bytes,
  processes: z.number().int().nonnegative()
});

export const resourceSampleSchema = z.object({
  at: z.number().int().nonnegative(),
  machine: machineUsageSchema,
  sessions: z.array(sessionUsageSchema).max(256)
});

/** Worker → hub：一份采样。只在 welcome.accepts 含 'metrics' 时发。 */
export const workerMetricsSchema = resourceSampleSchema.extend({ type: z.literal('metrics') });

export const pressureSchema = z.object({
  level: z.enum(['ok', 'warn', 'full']),
  reasons: z.array(z.string())
});

/** `/api/workers` 里每台机器的资源视图。 */
export const workerResourcesSchema = z.object({
  sample: resourceSampleSchema,
  pressure: pressureSchema,
  refusing: z.boolean(),
  refuseWhenFull: z.boolean()
});

/** `/api/workers/:id/metrics`：最近 1 小时（内存里的环形缓冲）。 */
export const workerMetricsHistorySchema = z.object({
  workerId: z.string(),
  samples: z.array(resourceSampleSchema)
});

export const resourcePolicyRequest = z.object({ refuseWhenFull: z.boolean() });

/** hub 和 Worker 在握手里互报能力：认识的才发，不认识的字段老版本 zod 会直接丢掉。 */
export const WORKER_CAPABILITY_METRICS = 'metrics';
