/**
 * Worker 能力上限（ADR 0030 D3）。凭据上存一组能力；hub 发请求前、Worker 收请求时都按它查。
 *
 * 诚实边界：`sessions` 本身就是在那台机器上跑任意代码的 agent，所以 readonly 预设不含它；
 * 「能跑 agent 但不能动 git」只是在限制 hub 自己的工具，不是沙箱。
 */
export type WorkerCapability = 'sessions' | 'files.read' | 'files.write' | 'git' | 'git.remote' | 'runtimes' | 'update';

/** 方法 / 帧声明用：'control' = 连接本身的管理（回声、探测、资产清单），任何凭据都允许。 */
export type WorkerMethodCapability = WorkerCapability | 'control';

export const WORKER_CAPABILITIES: readonly WorkerCapability[] = ['sessions', 'files.read', 'files.write', 'git', 'git.remote', 'runtimes', 'update'];

export const WORKER_CAPABILITY_LABELS: Readonly<Record<WorkerCapability, string>> = {
  sessions: '跑 agent 会话',
  'files.read': '读文件',
  'files.write': '写文件 / 回滚',
  git: '本地 git',
  'git.remote': '推送 / 开 PR',
  runtimes: '装卸运行时',
  update: '自更新'
};

export type WorkerCapabilityPreset = 'full' | 'readonly' | 'no-remote' | 'no-install';

export const WORKER_CAPABILITY_PRESETS: Readonly<Record<WorkerCapabilityPreset, readonly WorkerCapability[]>> = {
  full: WORKER_CAPABILITIES,
  readonly: ['files.read'],
  'no-remote': WORKER_CAPABILITIES.filter((c) => c !== 'git.remote'),
  'no-install': WORKER_CAPABILITIES.filter((c) => c !== 'runtimes' && c !== 'update')
};

export const WORKER_PRESET_LABELS: Readonly<Record<WorkerCapabilityPreset, string>> = {
  full: '完整',
  readonly: '只读（不能跑 agent）',
  'no-remote': '不能推送 / 开 PR',
  'no-install': '不能装卸运行时 / 自更新'
};

const known = new Set<string>(WORKER_CAPABILITIES);

/** 只留认识的、去重、按固定顺序。null / undefined = 老凭据，按 full。 */
export function normalizeCapabilities(input: readonly string[] | null | undefined): readonly WorkerCapability[] {
  if (input == null) return WORKER_CAPABILITIES;
  const set = new Set(input.filter((c) => known.has(c)));
  return WORKER_CAPABILITIES.filter((c) => set.has(c));
}

export function canInvoke(capabilities: readonly string[] | null | undefined, needed: WorkerMethodCapability | undefined): boolean {
  if (needed === undefined || needed === 'control') return true;
  return normalizeCapabilities(capabilities).includes(needed);
}

/** 这组能力正好等于哪个预设（UI 显示用）；都不是 = null（自定义）。 */
export function presetOf(capabilities: readonly string[] | null | undefined): WorkerCapabilityPreset | null {
  const caps = normalizeCapabilities(capabilities);
  for (const [name, preset] of Object.entries(WORKER_CAPABILITY_PRESETS) as [WorkerCapabilityPreset, readonly WorkerCapability[]][]) {
    if (preset.length === caps.length && preset.every((c) => caps.includes(c))) return name;
  }
  return null;
}

/** 只能收窄不能放宽：兑换 / 改动时取交集。 */
export function narrowCapabilities(current: readonly string[] | null | undefined, requested: readonly string[] | null | undefined): readonly WorkerCapability[] {
  const base = normalizeCapabilities(current);
  const want = normalizeCapabilities(requested);
  return base.filter((c) => want.includes(c));
}

/**
 * hub→worker 指令帧（非 RPC）要的能力。按 kind 查；没列出的（welcome / enrolled / rpc 信封）是连接管理。
 * rpc 信封里的方法按 worker-methods 上声明的能力另查。
 */
export const COMMAND_CAPABILITY: Readonly<Record<string, WorkerMethodCapability>> = {
  start_session: 'sessions',
  prompt: 'sessions',
  interrupt: 'sessions',
  compact: 'sessions',
  dispose: 'sessions',
  approval: 'sessions',
  set_option: 'sessions',
  update: 'update',
  update_commit: 'update',
  update_abort: 'update',
  runtime_job: 'runtimes',
  probe: 'control'
};

export const commandCapability = (kind: string): WorkerMethodCapability => COMMAND_CAPABILITY[kind] ?? 'control';

/** 收不到的原因（hub 返回 forbidden 时的文案）。 */
export const capabilityDenied = (needed: WorkerCapability): string => `这台机器的凭据不允许「${WORKER_CAPABILITY_LABELS[needed]}」`;
