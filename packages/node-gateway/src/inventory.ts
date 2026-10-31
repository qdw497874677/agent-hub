import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { InventoryCapability, InventoryComponent, InventoryRuntime, RuntimeProvision, WorkerInventory } from '@agent-hub/domain';

/**
 * Worker 侧的套件清单采集（ADR 0021 §7）。只读：不改任何文件、不跑任何命令。
 * - 运行时：来自 RuntimeManager 的 provisions（机器自带 / hub 安装）；
 * - hub 管理的组件：`<componentsRoot>/<runtime>/<id>/current` → 版本目录，里面的 `.component.json` 记哈希和 provides（P2 安装时写）；
 * - 外部组件：用户自己在 pi 的 settings.json 里装的包（`pi install`），只显示，不算能力。
 */
export interface InventorySources {
  readonly provisions: ReadonlyMap<string, RuntimeProvision>;
  /** hub 管理的组件目录；默认 `<runtimes>/components`。 */
  readonly componentsRoot: string;
  /** pi 的 agent 目录（PI_CODING_AGENT_DIR 或 ~/.pi/agent）；null = 不看。 */
  readonly piAgentDir: string | null;
  readonly now?: () => number;
}

const SAFE = /^[A-Za-z0-9@._+-]{1,214}$/;
const MAX_COMPONENTS = 200;

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** pi 的包来源串：`npm:<pkg>@<ver>`、`git:<repo>@<ref>`、本地路径。拿不到版本时为 'unknown'。 */
export function parsePiPackage(entry: unknown): { id: string; version: string; source: string; enabled: boolean } | null {
  const source = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null && typeof (entry as { source?: unknown }).source === 'string' ? (entry as { source: string }).source : null;
  if (!source || source.length > 300) return null;
  const enabled = !(typeof entry === 'object' && entry !== null && (entry as { enabled?: unknown }).enabled === false);
  if (source.startsWith('npm:')) {
    const spec = source.slice(4);
    const at = spec.lastIndexOf('@');
    const [id, version] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, 'unknown'];
    return { id, version: version || 'unknown', source, enabled };
  }
  if (source.startsWith('git:')) {
    const spec = source.slice(4);
    const at = spec.lastIndexOf('@');
    const repo = at > 0 ? spec.slice(0, at) : spec;
    const id = repo.split('/').filter(Boolean).pop()?.replace(/\.git$/, '') ?? repo;
    return { id, version: at > 0 ? spec.slice(at + 1) : 'unknown', source, enabled };
  }
  const id = source.split(/[\\/]/).filter(Boolean).pop() ?? source;
  return { id, version: 'local', source, enabled };
}

function externalPi(dir: string): InventoryComponent[] {
  const settings = readJson(join(dir, 'settings.json'));
  const packages = typeof settings === 'object' && settings !== null ? (settings as { packages?: unknown }).packages : undefined;
  if (!Array.isArray(packages)) return [];
  const out: InventoryComponent[] = [];
  for (const entry of packages.slice(0, MAX_COMPONENTS)) {
    const parsed = parsePiPackage(entry);
    if (!parsed) continue;
    out.push({ id: parsed.id.slice(0, 214), runtime: 'pi', version: parsed.version.slice(0, 64), integrity: '', enabled: parsed.enabled, managedBy: 'external', source: parsed.source });
  }
  return out;
}

function managed(root: string): { components: InventoryComponent[]; capabilities: InventoryCapability[] } {
  const components: InventoryComponent[] = [];
  const capabilities: InventoryCapability[] = [];
  if (!existsSync(root)) return { components, capabilities };
  for (const runtime of readdirSync(root)) {
    if (!SAFE.test(runtime)) continue;
    let ids: string[] = [];
    try {
      ids = readdirSync(join(root, runtime));
    } catch {
      continue;
    }
    for (const id of ids) {
      if (!SAFE.test(id) || components.length >= MAX_COMPONENTS) continue;
      let version: string;
      try {
        version = readlinkSync(join(root, runtime, id, 'current'));
      } catch {
        continue;
      }
      if (!SAFE.test(version)) continue;
      const meta = readJson(join(root, runtime, id, version, '.component.json')) as { integrity?: unknown; enabled?: unknown; provides?: unknown } | null;
      components.push({
        id,
        runtime,
        version,
        integrity: typeof meta?.integrity === 'string' ? meta.integrity.slice(0, 200) : '',
        enabled: meta?.enabled !== false,
        managedBy: 'hub'
      });
      for (const p of Array.isArray(meta?.provides) ? meta.provides : []) {
        if (typeof p?.capability === 'string') capabilities.push({ capability: p.capability.slice(0, 128), ...(typeof p.mode === 'string' ? { mode: p.mode.slice(0, 64) } : {}), via: id });
      }
    }
  }
  return { components, capabilities };
}

export function collectInventory(sources: InventorySources): WorkerInventory {
  const runtimes: InventoryRuntime[] = [];
  for (const [agentId, provision] of sources.provisions) {
    if (provision.source === 'missing') continue;
    runtimes.push({ agentId, version: provision.version ?? 'unknown', source: provision.source });
  }
  const hub = managed(sources.componentsRoot);
  const external = sources.piAgentDir && sources.provisions.has('pi') ? externalPi(sources.piAgentDir) : [];
  return {
    runtimes,
    components: [...hub.components, ...external].slice(0, MAX_COMPONENTS),
    capabilities: hub.capabilities.slice(0, MAX_COMPONENTS),
    collectedAt: (sources.now ?? Date.now)()
  };
}
