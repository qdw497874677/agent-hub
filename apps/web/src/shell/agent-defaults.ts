/**
 * 团队级「运行时默认模型」的界面侧纯逻辑（不含 React）。
 *
 * 真源在服务端：GET / PUT `/api/team/agent-defaults`，形状是 `{ 运行时 id: 模型名 }`，
 * 空串等于「没有默认」。新会话没点名模型时按运行时取，已有会话不受影响。
 *
 * 这里只负责三件事：
 *   - 把各台机器上报的 agentModels 合成「这台 hub 上出现过的运行时 + 候选模型」；
 *   - 把服务端那份对象摊成可编辑的行（已知运行时在前，只存在于默认值里的运行时补在后面，
 *     否则保存一次就会把它们悄悄丢掉）；
 *   - 把行收回到请求体（空值丢弃，值去首尾空白）。
 */

/** 运行时 id → 界面上的名字。不认识的运行时直接显示 id，别硬翻。 */
const RUNTIME_LABELS: Readonly<Record<string, string>> = {
  pi: 'Pi',
  opencode: 'OpenCode',
  codex: 'Codex',
  hermes: 'Hermes',
  grok: 'Grok'
};

export const runtimeLabel = (runtimeId: string): string => RUNTIME_LABELS[runtimeId] ?? runtimeId;

/** `/api/workers` 里这一块的最小形状：只取界面上要用到的字段。 */
export interface RuntimeSource {
  readonly agentModels?: readonly {
    readonly agentId: string;
    readonly models?: readonly string[];
  }[];
}

export interface KnownRuntime {
  readonly runtimeId: string;
  /** 各台机器报上来的模型并集（同名运行时的多个模型清单合并，按首次出现排序）。 */
  readonly models: readonly string[];
}

export interface DefaultRow {
  readonly runtime: string;
  readonly model: string;
}

/**
 * 这台 hub 上出现过的运行时。离线的机器也照算（它上报过就算出现过），
 * 但没上报 agentModels 的老 Worker 不会贡献任何东西。
 */
export function knownRuntimes(workers: readonly RuntimeSource[]): KnownRuntime[] {
  const order: string[] = [];
  const models = new Map<string, string[]>();
  for (const worker of workers) {
    for (const entry of worker.agentModels ?? []) {
      const id = entry.agentId.trim();
      if (id === '') continue;
      let list = models.get(id);
      if (!list) {
        list = [];
        models.set(id, list);
        order.push(id);
      }
      for (const model of entry.models ?? []) {
        const name = model.trim();
        if (name !== '' && !list.includes(name)) list.push(name);
      }
    }
  }
  return order.map((runtimeId) => ({ runtimeId, models: models.get(runtimeId) ?? [] }));
}

/**
 * 可编辑的行：只列「已经配过默认」的运行时——没配的在「添加运行时」下拉里。
 * 已知运行时按上报顺序在前，只存在于默认值里的运行时按字母序补在后面
 * （不然保存一次就会把它们悄悄丢掉）。
 */
export function defaultRows(
  saved: Readonly<Record<string, string>>,
  known: readonly KnownRuntime[]
): DefaultRow[] {
  const rows: DefaultRow[] = [];
  const knownIds = known.map((runtime) => runtime.runtimeId);
  for (const runtime of knownIds) {
    const model = (saved[runtime] ?? '').trim();
    if (model !== '') rows.push({ runtime, model });
  }
  for (const runtime of Object.keys(saved).sort()) {
    if (knownIds.includes(runtime)) continue;
    const model = (saved[runtime] ?? '').trim();
    if (model !== '') rows.push({ runtime, model });
  }
  return rows;
}

/** 行 → 请求体：空模型（等于「没有默认」）不进对象。 */
export function defaultsFromRows(rows: readonly DefaultRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const runtime = row.runtime.trim();
    const model = row.model.trim();
    if (runtime === '' || model === '') continue;
    out[runtime] = model;
  }
  return out;
}

/** 两份默认值是否等价（key 顺序无关）。保存按钮只在不等价时可用。 */
export function sameDefaults(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
): boolean {
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => right[key] === left[key]);
}

/** 「添加运行时」下拉里能选的那些：还没出现在行里的已知运行时。 */
export function remainingRuntimes(
  known: readonly KnownRuntime[],
  rows: readonly DefaultRow[]
): KnownRuntime[] {
  const taken = new Set(rows.map((row) => row.runtime));
  return known.filter((runtime) => !taken.has(runtime.runtimeId));
}

/** 服务端的上限（`AGENT_DEFAULTS_MAX`）：多出来的行会在保存时被拒，不如提前拦住。 */
export const AGENT_DEFAULTS_MAX = 16;
