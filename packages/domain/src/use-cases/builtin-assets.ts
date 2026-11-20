import { can } from '../access.ts';
import type { Principal, UserId } from '../account.ts';
import type { Asset } from '../asset.ts';
import { secretLookupOrder } from '../asset-review.ts';
import { BUILTIN_ASSETS, BUILTIN_CHROMIUM, builtinById, builtinComponentById, builtinComponentForCapability, builtinUpdateAvailable, needsBrowser, requiredCapabilitiesOf, type BuiltinAsset, type BuiltinComponent } from '../builtin-assets.ts';
import { catalogKey } from '../component-catalog.ts';
import { conflict, forbidden, invalid, notFound, type DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import { err, ok, type Result } from '../result.ts';
import type { RuntimeJob } from '../runtime-install.ts';
import type { AcquisitionResolution } from '../acquisition.ts';
import type { WorkerStatus } from '../worker.ts';
import { authorizeAssetProject, setScopedSecret, type AssetReviewDeps } from './asset-review.ts';
import { createBuiltinAsset, setProjectAsset, updateBuiltinAssetRecord } from './assets.ts';
import { authorizeComponentInstall, reviewComponent, startComponentJob, submitComponent, type ComponentDeps } from './component-install.ts';
import { LOCAL_WORKER_DENIED } from './authorization.ts';

/**
 * 内置资产（builtin-assets.ts 的清单）：在项目设置里一键启用，不用贴 JSON。
 * - 启用 = 在这个项目里建一份项目级资产，来源记成 builtin + 清单版本，直接发布（内容随 hub 发版，审的就是代码）；
 * - 要密钥的先填密钥（存进团队密钥，复用现有保险箱），填齐了才建；
 * - hub 升级后清单版本变了：已启用的保持锁住的版本，列表里提示「有新版本」，主人点「更新」才换。
 */

export interface BuiltinSecretView {
  readonly name: string;
  readonly label: string;
  readonly hint: string;
  readonly url?: string;
  /** 这个项目的资产此刻取得到它（只看有没有，不看值）。 */
  readonly set: boolean;
}

export interface BuiltinAssetView {
  readonly id: string;
  readonly kind: BuiltinAsset['kind'];
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  readonly version: string;
  readonly source: BuiltinAsset['source'];
  readonly secrets: readonly BuiltinSecretView[];
  readonly requiresBrowser: boolean;
  readonly note: string | null;
  readonly pairsWith: readonly string[];
  /** 已在这个项目启用：资产 id、锁住的清单版本、开关、有没有新版本。 */
  readonly enabled: { readonly assetId: string; readonly version: string; readonly on: boolean; readonly update: string | null } | null;
  /** 项目里已经有同名、但不是这一项内置的资产：不能再启用（避免覆盖）。 */
  readonly clash: string | null;
}

const enabledIn = (assets: readonly Asset[], projectId: string, item: BuiltinAsset): Asset | null =>
  assets.find((asset) => asset.scope === 'project' && asset.projectId === projectId && asset.source.type === 'builtin' && asset.source.id === item.id) ?? null;

const clashIn = (assets: readonly Asset[], projectId: string, item: BuiltinAsset): Asset | null =>
  assets.find(
    (asset) => asset.scope === 'project' && asset.projectId === projectId && asset.kind === item.kind && asset.name === item.name && !(asset.source.type === 'builtin' && asset.source.id === item.id)
  ) ?? null;

async function secretsSet(deps: AssetReviewDeps, actor: Principal, item: BuiltinAsset): Promise<Set<string>> {
  if (item.secrets.length === 0) return new Set();
  const stored = new Set((await deps.secrets.list()).map((secret) => secret.name));
  const hubAdmin = deps.hubAdminId ? await deps.hubAdminId() : null;
  // 启用后资产记在当前用户名下、项目级：按这个归属去找（团队密钥；hub 管理员的还能用 hub 级）
  const owner = { scope: 'project' as const, ownerId: actor.user.id, teamId: actor.user.teamId };
  return new Set(item.secrets.filter((secret) => secretLookupOrder(owner, secret.name, hubAdmin).some((step) => stored.has(step.key))).map((s) => s.name));
}

/** 项目设置里的「内置资产」列表。要能改项目（和上传项目资产同一道门）。 */
export async function builtinAssetsFor(deps: AssetReviewDeps, actor: Principal, projectId: string): Promise<Result<BuiltinAssetView[], DomainError>> {
  const allowed = await authorizeAssetProject(deps, actor, projectId);
  if (!allowed.ok) return allowed;
  const assets = await deps.assets.list();
  const settings = await deps.assets.projectSettings(projectId);
  const out: BuiltinAssetView[] = [];
  for (const item of BUILTIN_ASSETS) {
    const asset = enabledIn(assets, projectId, item);
    const set = await secretsSet(deps, actor, item);
    const clash = asset ? null : clashIn(assets, projectId, item);
    out.push({
      id: item.id,
      kind: item.kind,
      name: item.name,
      title: item.title,
      summary: item.summary,
      version: item.version,
      source: item.source,
      secrets: item.secrets.map((secret) => ({ ...secret, set: set.has(secret.name) })),
      requiresBrowser: item.requires?.browser === 'chromium',
      note: item.note ?? null,
      pairsWith: item.pairsWith ?? [],
      enabled: asset
        ? { assetId: asset.id, version: asset.source.type === 'builtin' ? asset.source.version : '', on: settings[asset.id] ?? true, update: builtinUpdateAvailable(asset) }
        : null,
      clash: clash ? `项目里已经有叫「${clash.name}」的资产` : null
    });
  }
  return ok(out);
}

async function audit(deps: AssetReviewDeps, actor: Principal, action: 'asset.create' | 'asset.revision', target: string, detail: string, teamId: string | null) {
  const via = actor.via ? `（经令牌 ${actor.via.name} / ${actor.via.tokenId}）` : '';
  await deps.audit.append({ id: newId(), actorId: actor.user.id as UserId, actorEmail: actor.user.email, action, target, detail: detail + via, at: deps.now(), teamId });
}

/**
 * 启用一项内置资产到项目。secrets：这次顺手填的密钥（名字 → 值），存成团队密钥；没填又取不到的就拒绝并点名。
 * 已经启用过：只把项目开关打开，不重复建。
 * 开放 API 令牌也能启用（ADR 0015）：assets:write + 项目改权限（projects:write）才过得了 authorizeAssetProject；审计里带令牌名。
 */
export async function enableBuiltinAsset(
  deps: AssetReviewDeps,
  actor: Principal,
  input: { projectId: string; builtinId: string; secrets?: Readonly<Record<string, string>> }
): Promise<Result<{ asset: Asset; created: boolean }, DomainError>> {
  if (!can(actor, 'asset.submit')) return err(forbidden('你没有上架资产的权限'));
  const allowed = await authorizeAssetProject(deps, actor, input.projectId);
  if (!allowed.ok) return allowed;
  const item = builtinById(input.builtinId);
  if (!item) return err(notFound('没有这一项内置资产'));
  const assets = await deps.assets.list();
  const existing = enabledIn(assets, input.projectId, item);
  if (existing) {
    const on = await setProjectAsset(deps, { projectId: input.projectId, assetId: existing.id, enabled: null });
    if (!on.ok) return on;
    return ok({ asset: existing, created: false });
  }
  const clash = clashIn(assets, input.projectId, item);
  if (clash) return err(conflict(`项目里已经有叫「${clash.name}」的资产：先删掉或改名再启用内置的`));
  const given = input.secrets ?? {};
  for (const name of Object.keys(given)) if (!item.secrets.some((secret) => secret.name === name)) return err(invalid(`「${item.title}」用不到密钥 ${name}`));
  for (const secret of item.secrets) {
    const value = given[secret.name]?.trim();
    if (!value) continue;
    const saved = await setScopedSecret(deps, actor, 'team', secret.name, value);
    if (!saved.ok) return saved.error.code === 'forbidden' ? err(forbidden(`${secret.label}要存成团队密钥，只有团队负责人能填：请负责人先填好`)) : saved;
  }
  const set = await secretsSet(deps, actor, item);
  const missing = item.secrets.filter((secret) => !set.has(secret.name));
  if (missing.length) return err(invalid(`先填${missing.map((secret) => secret.label).join('、')}再启用`));
  const made = await createBuiltinAsset(deps, { item, projectId: input.projectId, scope: 'project', ownerId: actor.user.id, teamId: actor.user.teamId, publish: true });
  if (!made.ok) return made;
  await audit(deps, actor, 'asset.create', made.value.name, `启用内置资产「${item.title}」${item.version}（项目 ${allowed.value?.name ?? input.projectId}）`, made.value.teamId);
  return ok({ asset: made.value, created: true });
}

/** 已启用的内置资产换到清单里的新版本（主人确认后才换）。 */
export async function updateBuiltinAsset(deps: AssetReviewDeps, actor: Principal, assetId: string): Promise<Result<Asset, DomainError>> {
  if (actor.via) return err(forbidden('令牌不能更新内置资产'));
  const asset = await deps.assets.get(assetId);
  if (!asset || asset.source.type !== 'builtin' || asset.scope !== 'project') return err(notFound('没有这个内置资产'));
  const allowed = await authorizeAssetProject(deps, actor, asset.projectId);
  if (!allowed.ok) return allowed;
  const item = builtinById(asset.source.id);
  if (!item) return err(notFound('这一项已经不在内置清单里了'));
  if (item.version === asset.source.version) return err(conflict('已经是最新的内置版本'));
  const from = asset.source.version;
  const updated = await updateBuiltinAssetRecord(deps, asset, item);
  if (!updated.ok) return updated;
  await audit(deps, actor, 'asset.revision', asset.name, `内置资产「${item.title}」${from} → ${item.version}`, asset.teamId);
  return ok(updated.value);
}

/* ── 能力状态与组件安装 ── */

export interface CapabilityStatus {
  readonly workerId: string;
  readonly label: string;
  readonly online: boolean;
  readonly ready: boolean;
  readonly installing: boolean;
  /** 装不了的原因（不在线、Worker 太旧、没有对应运行时……）；能装是 null。 */
  readonly blocker: string | null;
  readonly capability: string;
  /** 最近一次相关安装任务（不分成败都能看到）。 */
  readonly installJob: {
    readonly jobId: string;
    readonly state: string;
    readonly message: string;
    readonly acquisition?: AcquisitionResolution | null;
  } | null;
  /** 这台机器已选定的获取结果；还没有是 null。 */
  readonly acquisition: AcquisitionResolution | null;
}

/** @deprecated 请用 CapabilityStatus；浏览器只是 browser:chromium 的视图。 */
export type BrowserStatus = CapabilityStatus;

const trustedOf = (worker: Pick<WorkerStatus, 'drift'>): string[] => (worker.drift?.trusted ?? []).map((cap) => cap.capability);

export function workerNeedsBrowser(worker: Pick<WorkerStatus, 'drift'> | null | undefined, asset: Pick<Asset, 'source'>): boolean {
  if (asset.source.type !== 'builtin') return false;
  return needsBrowser(builtinById(asset.source.id), worker ? trustedOf(worker) : []);
}

function acquisitionOf(worker: WorkerStatus, capability: string): AcquisitionResolution | null {
  const fromInventory = (worker.inventory?.acquisitions ?? []).find((item) => !item.capability || item.capability === capability) ?? null;
  if (fromInventory) return fromInventory;
  const job = worker.runtimeJob;
  if (job?.result?.acquisition && (!job.result.acquisition.capability || job.result.acquisition.capability === capability)) {
    return job.result.acquisition;
  }
  return null;
}

function jobProvides(job: WorkerStatus['runtimeJob'], capability: string, componentId?: string): boolean {
  if (!job?.component) return false;
  if (componentId && job.component.componentId === componentId) return true;
  return job.component.provides.some((entry) => entry.capability === capability);
}

/**
 * 逐台机器看某个能力是否就绪。capability 默认 browser:chromium（给旧的浏览器视图用）。
 */
export function capabilityStatus(workers: readonly WorkerStatus[], capability: string = BUILTIN_CHROMIUM.capability): CapabilityStatus[] {
  const builtin = builtinComponentForCapability(capability);
  const componentId = builtin?.componentId;
  return workers.map((worker) => {
    const ready = trustedOf(worker).includes(capability);
    const job = worker.runtimeJob;
    const related = jobProvides(job, capability, componentId);
    const chosen = acquisitionOf(worker, capability);
    const installJob =
      job && related
        ? { jobId: job.jobId, state: job.state, message: job.message, ...(job.result?.acquisition ? { acquisition: job.result.acquisition } : {}) }
        : null;
    const installing = related && job?.state === 'running';
    const runtime = builtin?.runtime ?? 'pi';
    const blocker =
      worker.state !== 'online'
        ? '机器不在线'
        : !worker.inventory?.componentInstall
          ? 'Worker 版本太旧，不支持安装组件：先更新它'
          : !worker.inventory.runtimes.some((item) => item.agentId === runtime)
            ? `这台机器上没有 ${runtime} 运行时（这个组件挂在 ${runtime} 下面装）`
            : null;
    return {
      workerId: worker.workerId,
      label: worker.label,
      online: worker.state === 'online',
      ready,
      installing: Boolean(installing),
      blocker,
      capability,
      installJob,
      acquisition: chosen
    };
  });
}

/** 浏览器就绪视图：capability_status 在 browser:chromium 上的别名。 */
export function browserStatus(workers: readonly WorkerStatus[]): CapabilityStatus[] {
  return capabilityStatus(workers, BUILTIN_CHROMIUM.capability);
}

export interface InstallComponentRequest {
  readonly workerId: string;
  readonly componentId?: string;
  readonly version?: string;
  readonly capability?: string;
}

async function resolveInstallTarget(
  deps: ComponentDeps,
  request: InstallComponentRequest
): Promise<{ componentId: string; version: string; builtin: BuiltinComponent | null } | { error: DomainError }> {
  if (!request.componentId && !request.capability) {
    return { error: invalid('要指定 componentId 或 capability') };
  }
  let builtin = request.componentId ? builtinComponentById(request.componentId) ?? null : null;
  if (!builtin && request.capability) builtin = builtinComponentForCapability(request.capability) ?? null;
  if (request.capability && builtin && !builtin.provides.some((entry) => entry.capability === request.capability)) {
    return { error: invalid(`组件 ${builtin.componentId} 不提供能力 ${request.capability}`) };
  }
  const componentId = request.componentId ?? builtin?.componentId;
  if (!componentId) return { error: notFound(`没有提供能力 ${request.capability} 的组件`) };
  const version = request.version ?? builtin?.version;
  if (version) return { componentId, version, builtin };
  const listed = (await deps.catalog.list()).filter((item) => item.id === componentId && item.status === 'approved');
  const latest = listed.sort((a, b) => b.submittedAt - a.submittedAt)[0];
  if (!latest) return { error: notFound('组件目录里没有已批准的这一项') };
  return { componentId, version: latest.version, builtin };
}

/**
 * 给一台机器装组件：可按 componentId 或按 capability 解析。
 * 目录里没有对应的内置项时，集群管理员会提交并批准；登记人令牌只能装已批准的。
 * 鉴权与原来的内置浏览器安装相同。
 */
export async function installWorkerComponent(
  deps: ComponentDeps,
  actor: Principal | null,
  request: InstallComponentRequest
): Promise<Result<RuntimeJob, DomainError>> {
  if (!actor) return err(forbidden('请先登录'));
  const worker = (await deps.workers.list()).find((candidate) => candidate.workerId === request.workerId);
  if (actor.via && worker?.origin === 'local') return err(forbidden(LOCAL_WORKER_DENIED));
  const manage = actor.user.clusterAdmin || (!actor.via && can(actor, 'asset.publish_global'));
  if (!manage) {
    const scoped = await authorizeComponentInstall(deps, actor, request.workerId, worker);
    if (!scoped.ok) return scoped;
  }
  const target = await resolveInstallTarget(deps, request);
  if ('error' in target) return err(target.error);
  return installCatalogComponent(deps, actor, request.workerId, target, manage);
}

async function installCatalogComponent(
  deps: ComponentDeps,
  actor: Principal,
  workerId: string,
  target: { componentId: string; version: string; builtin: BuiltinComponent | null },
  manage: boolean
): Promise<Result<RuntimeJob, DomainError>> {
  const { componentId, version, builtin } = target;
  let item = await deps.catalog.byId(catalogKey(componentId, version));
  if (!item || item.status === 'rejected') {
    if (!builtin) return err(forbidden('组件目录里还没有审核过的这一项：请集群管理员先提交并批准'));
    if (!manage) return err(forbidden('组件目录里还没有审核过的这一项：请集群管理员先在界面或 MCP 上装一次（提交并批准）'));
    const submitted = await submitComponent(deps, actor, {
      id: componentId,
      packageName: builtin.packageName,
      version: builtin.version,
      runtime: builtin.runtime,
      provides: builtin.provides,
      strategies: builtin.strategies
    });
    if (!submitted.ok) return submitted;
    item = submitted.value;
  }
  if (builtin && item.integrity !== builtin.integrity) return err(conflict('registry 上这个版本的哈希和内置清单不一致，已停止：请检查 npm 源'));
  if (item.status === 'pending') {
    if (!manage) return err(conflict('这个组件还在等集群管理员批准：批准后再装（capability_status 会一直显示 blocker）'));
    const reviewed = await reviewComponent(deps, actor, componentId, version, { approve: true, note: builtin ? `内置组件「${builtin.componentId}」` : '组件安装' });
    if (!reviewed.ok) return reviewed;
    item = reviewed.value;
    if (item.status !== 'approved') return err(conflict('这个组件还要另一位集群管理员批准（双人审核）：到「组件」里批准后再装'));
  }
  return startComponentJob(deps, actor, workerId, { componentId, version, action: 'install_component' });
}

/** 给机器装内置浏览器：component_install({ capability: 'browser:chromium' }) 的薄别名。 */
export async function installBuiltinBrowser(deps: ComponentDeps, actor: Principal | null, workerId: string): Promise<Result<RuntimeJob, DomainError>> {
  return installWorkerComponent(deps, actor, { workerId, capability: BUILTIN_CHROMIUM.capability });
}

/* ── 会话需要某项能力时的自动引导 ── */

export function builtinIdsForCapabilities(capabilities: readonly string[]): string[] {
  const ids: string[] = [];
  const add = (id: string) => {
    if (!ids.includes(id)) ids.push(id);
  };
  for (const asset of BUILTIN_ASSETS) {
    if (!requiredCapabilitiesOf(asset).some((capability) => capabilities.includes(capability))) continue;
    add(asset.id);
    for (const pair of asset.pairsWith ?? []) add(pair);
  }
  return ids;
}

export interface CapabilityBootstrap {
  readonly enabled: readonly string[];
  readonly install?: { readonly workerId: string; readonly jobId: string; readonly capability: string };
  readonly skipped?: string;
}

/** 项目还没配置过、会用到这些能力的内置资产时自动启用（用户显式停用过的不动，有自己的同名资产的也不覆盖）。 */
export async function ensureBuiltinAssetsForCapabilities(deps: AssetReviewDeps, projectId: string, actor: Principal, capabilities: readonly string[]): Promise<string[]> {
  const assets = await deps.assets.list();
  const enabled: string[] = [];
  for (const id of builtinIdsForCapabilities(capabilities)) {
    const item = builtinById(id);
    if (!item) continue;
    if (enabledIn(assets, projectId, item)) continue;
    if (clashIn(assets, projectId, item)) continue;
    const made = await enableBuiltinAsset(deps, actor, { projectId, builtinId: id });
    if (made.ok) enabled.push(id);
  }
  return enabled;
}

/** @deprecated 请用 ensureBuiltinAssetsForCapabilities */
export async function ensureBuiltinBrowserAssets(deps: AssetReviewDeps, projectId: string, actor: Principal): Promise<string[]> {
  return ensureBuiltinAssetsForCapabilities(deps, projectId, actor, [BUILTIN_CHROMIUM.capability]);
}

/**
 * 会话 requires 某些能力时，在派生前尽力而为：
 * 1. 项目没配置过就自动启用相关内置资产（不强行打开用户关掉的）；
 * 2. 缺的能力，若没有就绪机器且也没人在装，挑一台能装的发起安装任务。
 * 权限不够 / 没有候选机器都不拦派生，只把原因写进 skipped。
 */
export async function bootstrapCapabilitiesForSession(
  assets: AssetReviewDeps | undefined,
  install: ComponentDeps | undefined,
  actor: Principal | null,
  input: { projectId?: string | null; requires?: readonly string[] }
): Promise<CapabilityBootstrap> {
  const requires = input.requires ?? [];
  const out: { enabled: string[]; install?: { workerId: string; jobId: string; capability: string }; skipped?: string } = { enabled: [] };
  if (requires.length === 0) return out;
  if (assets && input.projectId && actor) out.enabled = await ensureBuiltinAssetsForCapabilities(assets, input.projectId, actor, requires);
  if (!install) return out;
  const workers = await install.workers.list();
  const missing = requires.filter((capability) => !workers.some((worker) => worker.state === 'online' && trustedOf(worker).includes(capability)));
  if (missing.length === 0) return out;
  const capability = missing[0]!;
  const statuses = capabilityStatus(workers, capability);
  const installing = workers.some((worker) => statuses.find((row) => row.workerId === worker.workerId)?.installing);
  if (installing) {
    out.skipped = `已有机器正在安装「${capability}」：用 capability_status 查进度，装好后重试`;
    return out;
  }
  const builtin = builtinComponentForCapability(capability);
  const runtime = builtin?.runtime ?? 'pi';
  const candidate = workers.find(
    (worker) => worker.state === 'online' && worker.origin !== 'local' && worker.inventory?.componentInstall && worker.inventory.runtimes.some((item) => item.agentId === runtime)
  );
  if (!candidate) {
    out.skipped = `没有能装「${capability}」的在线机器（Worker 太旧或没有 ${runtime} 运行时）：先更新 Worker 再试`;
    return out;
  }
  if (!actor) {
    out.skipped = '没有登录主体，不能发起安装：用账号的令牌再试';
    return out;
  }
  const started = await installWorkerComponent(install, actor, { workerId: candidate.workerId, capability, ...(builtin ? { componentId: builtin.componentId } : {}) });
  if (!started.ok) {
    out.skipped = started.error.message;
    return out;
  }
  out.install = { workerId: candidate.workerId, jobId: started.value.jobId, capability };
  return out;
}

/** 会话要浏览器时的引导：bootstrapCapabilitiesForSession 的薄别名。 */
export async function bootstrapBuiltinBrowserForSession(
  assets: AssetReviewDeps | undefined,
  install: ComponentDeps | undefined,
  actor: Principal | null,
  input: { projectId?: string | null; requires?: readonly string[] }
): Promise<CapabilityBootstrap> {
  return bootstrapCapabilitiesForSession(assets, install, actor, input);
}
