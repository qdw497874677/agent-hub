import { invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/**
 * 运行时套件（ADR 0021，docs/design/runtime-bundles.md）P1：
 * - 清单格式：`kind: bundle` + 组件清单（§3），只做校验，不装东西（安装是 P2）；
 * - Worker 清单上报（§7）：运行时 + 组件，外部安装的只显示、不算能力；
 * - 漂移检测框架（§7）：期望（hub 的 pins）对实际（清单）。漂移的能力标「不可信」，hub 不自动修复。
 */

export type ComponentKind = 'runtime-plugin' | 'mcp-server' | 'skill';
export const COMPONENT_KINDS: readonly ComponentKind[] = ['runtime-plugin', 'mcp-server', 'skill'];

/** 组件来源：npm 必须确切版本 + sha512 完整性；mcp-server / skill 直接引用已发布的资产版本（复用 ADR 0016 下发）。git 来源是 P4。 */
export type ComponentSource =
  | { readonly type: 'npm'; readonly package: string; readonly version: string; readonly integrity: string }
  | { readonly type: 'asset'; readonly ref: string };

export interface ComponentProvides {
  readonly capability: string;
  readonly mode?: string;
}

export interface BundleComponent {
  readonly id: string;
  readonly kind: ComponentKind;
  readonly source: ComponentSource;
  readonly install?: { readonly target: string };
  readonly config?: { readonly file: string; readonly template: Readonly<Record<string, unknown>> };
  readonly provides: readonly ComponentProvides[];
  readonly conflicts: readonly string[];
  readonly requires?: { readonly runtime?: string };
}

export interface BundleManifest {
  readonly kind: 'bundle';
  readonly id: string;
  readonly runtime: { readonly agentId: string; readonly version: string };
  readonly components: readonly BundleComponent[];
}

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const AGENT_ID = /^[a-z][a-z0-9-]{0,31}$/;
/** 确切版本：不收范围、tag、latest（§9「锁版本」）。 */
const EXACT_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.]{1,32})?$/;
const NPM_PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,213}$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
/** 资产引用：asset:<名字>@<版本号>。 */
const ASSET_REF = /^asset:[a-z0-9][a-z0-9._-]{0,63}@\d{1,6}$/;
const CAPABILITY = /^[a-z][a-z0-9-]*(:[a-z0-9*][a-z0-9._*-]*)+$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function parseSource(raw: unknown, kind: ComponentKind, where: string): Result<ComponentSource, string> {
  if (!isRecord(raw)) return err(`${where}：缺 source`);
  if (raw['type'] === 'npm') {
    if (kind !== 'runtime-plugin') return err(`${where}：${kind} 组件只能引用已发布的资产（source.type: asset）`);
    const pkg = str(raw['package']);
    const version = str(raw['version']);
    const integrity = str(raw['integrity']);
    if (!pkg || !NPM_PACKAGE.test(pkg)) return err(`${where}：npm 包名不合法`);
    if (!version || !EXACT_VERSION.test(version)) return err(`${where}：npm 版本必须是确切版本（不收范围、tag）`);
    if (!integrity || !SHA512.test(integrity)) return err(`${where}：npm 来源必须带 sha512 完整性哈希`);
    return ok({ type: 'npm', package: pkg, version, integrity });
  }
  if (raw['type'] === 'asset') {
    if (kind === 'runtime-plugin') return err(`${where}：运行时插件必须是 npm 来源（git 来源在后续期）`);
    const ref = str(raw['ref']);
    if (!ref || !ASSET_REF.test(ref)) return err(`${where}：资产引用格式是 asset:<名字>@<版本号>`);
    return ok({ type: 'asset', ref });
  }
  return err(`${where}：source.type 只支持 npm / asset`);
}

function parseComponent(raw: unknown, index: number): Result<BundleComponent, string> {
  const where = `components[${index}]`;
  if (!isRecord(raw)) return err(`${where}：不是对象`);
  const id = str(raw['id']);
  if (!id || !ID.test(id)) return err(`${where}：id 不合法`);
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !(COMPONENT_KINDS as readonly string[]).includes(kind)) return err(`${where}（${id}）：kind 只能是 ${COMPONENT_KINDS.join(' / ')}`);
  // 兼容 §3 的简写：mcp-server / skill 写 asset: { ref }
  const sourceRaw = raw['source'] ?? (isRecord(raw['asset']) ? { type: 'asset', ref: raw['asset']['ref'] } : undefined);
  const source = parseSource(sourceRaw, kind as ComponentKind, `${where}（${id}）`);
  if (!source.ok) return source;
  const provides: ComponentProvides[] = [];
  for (const item of Array.isArray(raw['provides']) ? raw['provides'] : []) {
    if (!isRecord(item) || !str(item['capability']) || !CAPABILITY.test(item['capability'] as string)) return err(`${where}（${id}）：provides 里的能力名不合法`);
    provides.push({ capability: item['capability'] as string, ...(str(item['mode']) ? { mode: item['mode'] as string } : {}) });
  }
  const conflicts: string[] = [];
  for (const item of Array.isArray(raw['conflicts']) ? raw['conflicts'] : []) {
    if (typeof item !== 'string' || item.length > 128) return err(`${where}（${id}）：conflicts 只收字符串`);
    conflicts.push(item);
  }
  const install = isRecord(raw['install']) && str(raw['install']['target']) ? { target: raw['install']['target'] as string } : undefined;
  if (kind === 'runtime-plugin' && !install) return err(`${where}（${id}）：运行时插件要写 install.target`);
  const config = isRecord(raw['config']) && str(raw['config']['file']) ? { file: raw['config']['file'] as string, template: isRecord(raw['config']['template']) ? raw['config']['template'] : {} } : undefined;
  if (config && (config.file.includes('/') || config.file.includes('\\') || config.file.startsWith('.'))) return err(`${where}（${id}）：config.file 只能是文件名`);
  const requires = isRecord(raw['requires']) && str(raw['requires']['runtime']) ? { runtime: raw['requires']['runtime'] as string } : undefined;
  return ok({
    id,
    kind: kind as ComponentKind,
    source: source.value,
    provides,
    conflicts,
    ...(install ? { install } : {}),
    ...(config ? { config } : {}),
    ...(requires ? { requires } : {})
  });
}

/** 能力是否命中冲突规则：`capability:context-strategy:*` 这种以 * 结尾的按前缀比。 */
function conflictHits(rule: string, capability: string): boolean {
  const target = rule.startsWith('capability:') ? rule.slice('capability:'.length) : null;
  if (target === null) return false;
  return target.endsWith('*') ? capability.startsWith(target.slice(0, -1)) : capability === target;
}

/** 校验一份套件清单（已解析成对象的 YAML / JSON）。不合法返回第一条中文原因。 */
export function parseBundleManifest(raw: unknown): Result<BundleManifest, DomainError> {
  const fail = (message: string) => err(invalid(`套件清单不合法：${message}`));
  if (!isRecord(raw)) return fail('不是对象');
  if (raw['kind'] !== 'bundle') return fail('kind 必须是 bundle');
  const id = str(raw['id']);
  if (!id || !ID.test(id)) return fail('id 不合法');
  const runtime = raw['runtime'];
  if (!isRecord(runtime) || !str(runtime['agentId']) || !AGENT_ID.test(runtime['agentId'] as string)) return fail('runtime.agentId 不合法');
  if (!str(runtime['version']) || !EXACT_VERSION.test(runtime['version'] as string)) return fail('runtime.version 必须是确切版本');
  if (!Array.isArray(raw['components'])) return fail('components 必须是数组');
  if (raw['components'].length > 32) return fail('组件太多（最多 32 个）');
  const components: BundleComponent[] = [];
  for (const [index, item] of raw['components'].entries()) {
    const parsed = parseComponent(item, index);
    if (!parsed.ok) return fail(parsed.error);
    if (components.some((c) => c.id === parsed.value.id)) return fail(`组件 id 重复：${parsed.value.id}`);
    components.push(parsed.value);
  }
  // 冲突只在同一个套件内检查；和 Worker 上已装组件的冲突在安装计划（P2）里查
  for (const a of components)
    for (const rule of a.conflicts)
      for (const b of components)
        if (b !== a && b.provides.some((p) => conflictHits(rule, p.capability))) return fail(`组件冲突：${a.id} 和 ${b.id}（${rule}）`);
  return ok({ kind: 'bundle', id, runtime: { agentId: runtime['agentId'] as string, version: runtime['version'] as string }, components });
}

// ---------- 清单上报与漂移（§7） ----------

export interface InventoryRuntime {
  readonly agentId: string;
  readonly version: string;
  /** 运行时从哪来：machine = 机器自带，hub = hub 装的。 */
  readonly source: 'machine' | 'hub';
}

export interface InventoryComponent {
  readonly id: string;
  readonly runtime: string;
  readonly version: string;
  /** 外部安装的常常拿不到哈希：空串。 */
  readonly integrity: string;
  readonly enabled: boolean;
  readonly managedBy: 'hub' | 'external';
  /** 外部组件的原始来源描述（例如 `npm:foo@1.0.0`），只用于显示。 */
  readonly source?: string;
}

export interface InventoryCapability {
  readonly capability: string;
  readonly mode?: string;
  /** 由哪个组件提供。 */
  readonly via: string;
}

export interface WorkerInventory {
  readonly runtimes: readonly InventoryRuntime[];
  readonly components: readonly InventoryComponent[];
  readonly capabilities: readonly InventoryCapability[];
  /** Worker 采集的时间（epoch ms）。 */
  readonly collectedAt: number;
  /** Worker 能接组件任务（P2）。 */
  readonly componentInstall?: boolean;
}

/** 期望状态：hub 的 component_pins 里的一行（P2 才会写入；P1 一直是空的）。 */
export interface ComponentPin {
  readonly componentId: string;
  readonly runtime: string;
  readonly version: string;
  readonly integrity: string;
}

export type DriftItem =
  | { readonly kind: 'missing'; readonly componentId: string; readonly runtime: string; readonly expected: string }
  | { readonly kind: 'mismatch'; readonly componentId: string; readonly runtime: string; readonly expected: string; readonly actual: string }
  | { readonly kind: 'external'; readonly componentId: string; readonly runtime: string; readonly actual: string }
  /** hub 目录里有、但 hub 没有钉过（有人手动放进去的）：按不一致处理。 */
  | { readonly kind: 'unexpected'; readonly componentId: string; readonly runtime: string; readonly actual: string };

export interface DriftReport {
  readonly items: readonly DriftItem[];
  /** 可信的能力：hub 管理、没有漂移的组件提供的。调度只看这份。 */
  readonly trusted: readonly InventoryCapability[];
  /** 因漂移标为不可信的能力：调度跳过，界面提示「修复（重新安装）」。 */
  readonly untrusted: readonly InventoryCapability[];
}

/**
 * 漂移检测（§7，决定 5 / 6）：
 * - 期望有、实际没有 → missing；版本或哈希不对 → mismatch：这两类组件提供的能力都不可信；
 * - 外部组件（managedBy: external）→ external：只列出来，不算能力，也不算报警；
 * - hub 管理但不在期望里的组件也按不可信处理（来路不明）。
 * 不做任何修复：修复要有权限的人手动触发。
 */
export function detectDrift(expected: readonly ComponentPin[], inventory: WorkerInventory | null): DriftReport {
  const items: DriftItem[] = [];
  const components = inventory?.components ?? [];
  const bad = new Set<string>();
  for (const pin of expected) {
    const actual = components.find((c) => c.managedBy === 'hub' && c.id === pin.componentId && c.runtime === pin.runtime);
    if (!actual) {
      items.push({ kind: 'missing', componentId: pin.componentId, runtime: pin.runtime, expected: pin.version });
      continue;
    }
    if (actual.version !== pin.version || actual.integrity !== pin.integrity) {
      items.push({ kind: 'mismatch', componentId: pin.componentId, runtime: pin.runtime, expected: pin.version, actual: actual.version });
      bad.add(actual.id);
    }
  }
  for (const c of components) {
    if (c.managedBy === 'external') items.push({ kind: 'external', componentId: c.id, runtime: c.runtime, actual: c.version });
    else if (!expected.some((pin) => pin.componentId === c.id && pin.runtime === c.runtime)) {
      items.push({ kind: 'unexpected', componentId: c.id, runtime: c.runtime, actual: c.version });
      bad.add(c.id);
    }
  }
  const external = new Set(components.filter((c) => c.managedBy === 'external').map((c) => c.id));
  const trusted: InventoryCapability[] = [];
  const untrusted: InventoryCapability[] = [];
  for (const cap of inventory?.capabilities ?? []) {
    if (external.has(cap.via)) continue;
    const managed = components.find((c) => c.id === cap.via && c.managedBy === 'hub');
    if (!managed || bad.has(cap.via) || !managed.enabled) untrusted.push(cap);
    else trusted.push(cap);
  }
  return { items, trusted, untrusted };
}

/** 是否有需要人处理的漂移（外部组件不算）。 */
export const hasDrift = (report: DriftReport): boolean => report.items.some((item) => item.kind !== 'external');

/**
 * mcp-server / skill 组件不走新的安装通道：它们就是已发布的资产版本，按会话经现有的资产下发（ADR 0016）送到 Worker。
 * 这里只把清单里的资产引用解析成 { name, version }，交给资产服务去查审核状态和下发。
 */
export function bundleAssetRefs(manifest: BundleManifest): { readonly componentId: string; readonly kind: ComponentKind; readonly name: string; readonly version: number }[] {
  return manifest.components.flatMap((component) => {
    if (component.source.type !== 'asset') return [];
    const [name, version] = component.source.ref.slice('asset:'.length).split('@') as [string, string];
    return [{ componentId: component.id, kind: component.kind, name, version: Number(version) }];
  });
}
