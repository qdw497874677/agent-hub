import { can } from '../access.ts';
import type { Principal, UserId } from '../account.ts';
import type { Asset } from '../asset.ts';
import { secretLookupOrder } from '../asset-review.ts';
import { BUILTIN_ASSETS, BUILTIN_CHROMIUM, builtinById, builtinUpdateAvailable, needsBrowser, type BuiltinAsset } from '../builtin-assets.ts';
import { catalogKey } from '../component-catalog.ts';
import { conflict, forbidden, invalid, notFound, type DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import { err, ok, type Result } from '../result.ts';
import type { RuntimeJob } from '../runtime-install.ts';
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

/* ── 浏览器（Playwright 要的 Chromium） ── */

export interface BrowserStatus {
  readonly workerId: string;
  readonly label: string;
  readonly online: boolean;
  readonly ready: boolean;
  readonly installing: boolean;
  /** 装不了的原因（不在线、Worker 太旧、没有 pi 运行时……）；能装是 null。 */
  readonly blocker: string | null;
  /** 最近一次 Chromium 安装任务（不分成败都能看到）：进度 / 失败原因从这里查；没发过是 null。 */
  readonly installJob: { readonly jobId: string; readonly state: string; readonly message: string } | null;
}

const trustedOf = (worker: Pick<WorkerStatus, 'drift'>): string[] => (worker.drift?.trusted ?? []).map((cap) => cap.capability);

/** 这台机器缺不缺浏览器：派生预览里用来给 Playwright 打「需安装浏览器」。 */
export function workerNeedsBrowser(worker: Pick<WorkerStatus, 'drift'> | null | undefined, asset: Pick<Asset, 'source'>): boolean {
  if (asset.source.type !== 'builtin') return false;
  return needsBrowser(builtinById(asset.source.id), worker ? trustedOf(worker) : []);
}

export function browserStatus(workers: readonly WorkerStatus[]): BrowserStatus[] {
  return workers.map((worker) => {
    const ready = !needsBrowser({ requires: { browser: 'chromium' } }, trustedOf(worker));
    const job = worker.runtimeJob;
    const chromiumJob =
      job && job.component?.componentId === BUILTIN_CHROMIUM.componentId
        ? { jobId: job.jobId, state: job.state, message: job.message }
        : null;
    const installing = job?.state === 'running' && job.component?.componentId === BUILTIN_CHROMIUM.componentId;
    const blocker =
      worker.state !== 'online'
        ? '机器不在线'
        : !worker.inventory?.componentInstall
          ? 'Worker 版本太旧，不支持安装组件：先更新它'
          : !worker.inventory.runtimes.some((runtime) => runtime.agentId === 'pi')
            ? '这台机器上没有 pi 运行时（浏览器组件挂在 pi 下面装）'
            : null;
    return { workerId: worker.workerId, label: worker.label, online: worker.state === 'online', ready, installing, blocker, installJob: chromiumJob };
  });
}

/**
 * 一键装 Chromium：复用组件目录（ADR 0021）——目录里没有就按内置清单提交（hub 去 registry 核对哈希必须和清单一致），
 * 待审的由当前集群管理员批准（双人审核时还要另一位），再在这台机器上发安装任务。全程走现有审计。
 *
 * 鉴权（三层）：
 * - 本机（origin=local）永远不让开放 API 碰：令牌一律拒，UI 用户走本机管理员的 runtime.component.install；
 * - 界面管理员（can asset.publish_global）：全流程（提交 / 审核 / 安装），原行为不变；
 * - 令牌：runtime.component.install 永不在令牌权限里，按账号放宽——集群管理员或这台机器的登记人
 *   （authorizeComponentInstall）；他们只能装目录里已审核过的组件，不能替管理员做提交 / 审核的决定。
 */
export async function installBuiltinBrowser(deps: ComponentDeps, actor: Principal | null, workerId: string): Promise<Result<RuntimeJob, DomainError>> {
  if (!actor) return err(forbidden('请先登录'));
  const worker = (await deps.workers.list()).find((candidate) => candidate.workerId === workerId);
  if (actor.via && worker?.origin === 'local') return err(forbidden(LOCAL_WORKER_DENIED));
  // 集群管理员（含管理员的个人令牌）能扶植目录：提交 + 自准 + 安装一气呵成；普通登录管理员同款；worker 登记人令牌只能装已批准的。
  const manage = actor.user.clusterAdmin || (!actor.via && can(actor, 'asset.publish_global'));
  if (!manage) {
    const scoped = await authorizeComponentInstall(deps, actor, workerId, worker);
    if (!scoped.ok) return scoped;
  }
  return installBrowserFor(deps, actor, workerId, manage);
}

async function installBrowserFor(deps: ComponentDeps, actor: Principal, workerId: string, manage: boolean): Promise<Result<RuntimeJob, DomainError>> {
  const { componentId, packageName, version, integrity, capability, mode } = BUILTIN_CHROMIUM;
  let item = await deps.catalog.byId(catalogKey(componentId, version));
  if (!item || item.status === 'rejected') {
    if (!manage) return err(forbidden('组件目录里还没有审核过的浏览器组件：请集群管理员先在界面或 MCP 上装一次（提交并批准）'));
    const submitted = await submitComponent(deps, actor, { id: componentId, packageName, version, runtime: 'pi', provides: [{ capability, mode }] });
    if (!submitted.ok) return submitted;
    item = submitted.value;
  }
  if (item.integrity !== integrity) return err(conflict('registry 上这个版本的哈希和内置清单不一致，已停止：请检查 npm 源'));
  if (item.status === 'pending') {
    if (!manage) return err(conflict('浏览器组件还在等集群管理员批准：批准后再装（worker_component_status 会一直显示 blocker）'));
    const reviewed = await reviewComponent(deps, actor, componentId, version, { approve: true, note: '内置浏览器（Playwright）' });
    if (!reviewed.ok) return reviewed;
    item = reviewed.value;
    if (item.status !== 'approved') return err(conflict('浏览器组件还要另一位集群管理员批准（双人审核）：到「组件」里批准后再装'));
  }
  return startComponentJob(deps, actor, workerId, { componentId, version, action: 'install_component' });
}

/* ── 会话需要浏览器时的自动引导 ── */

/** 会话要浏览器（requires browser:chromium）时自动启用的内置项：Playwright MCP + 和它搭配的 web-testing 技能。 */
const BROWSER_BUILTIN_IDS = ['playwright', 'web-testing'];

/** 自动启用的结果（尽力而为：单项失败不拦另外一项，也不抛错）。 */
export interface BuiltinBrowserBootstrap {
  /** 这次自动启用的内置资产 id；项目已经配置过（或显式停用过）为空数组。 */
  readonly enabled: readonly string[];
  /** 已经给这台机器发起了 Chromium 安装任务。 */
  readonly install?: { readonly workerId: string; readonly jobId: string };
  /** 为什么没发安装任务（都就绪 / 已在装 / 没有能装的机器 / 权限不够）；发了是省略。 */
  readonly skipped?: string;
}

/**
 * 项目还没配置过内置浏览器资产时自动启用（用户显式停用过的不动，有自己的同名资产的也不覆盖）。
 * 用会话发起者的身份启用（他既然能在这个项目开会话，就看得见它）；缺 asset.submit 权限时
 * 尽力而为地跳过。审计记在发起者头上。返回这次新启用的内置资产 id。
 */
export async function ensureBuiltinBrowserAssets(deps: AssetReviewDeps, projectId: string, actor: Principal): Promise<string[]> {
  const assets = await deps.assets.list();
  const enabled: string[] = [];
  for (const id of BROWSER_BUILTIN_IDS) {
    const item = builtinById(id);
    if (!item) continue;
    if (enabledIn(assets, projectId, item)) continue;
    if (clashIn(assets, projectId, item)) continue;
    const made = await enableBuiltinAsset(deps, actor, { projectId, builtinId: id });
    if (made.ok) enabled.push(id);
  }
  return enabled;
}

/**
 * 会话要浏览器（requires browser:chromium）时，在派生前做两件尽力而为的事：
 * 1. 项目没配置过就自动启用内置 Playwright MCP / web-testing（不强行打开用户关掉的）；
 * 2. 没有一台就绪机器且也没人在装时，挑一台能装的（在线、非本机、支持装组件、有 pi 运行时）发起安装任务。
 * 权限不够 / 没有候选机器都不拦派生，只把原因写进 skipped——派生失败的报错里会带上。
 */
export async function bootstrapBuiltinBrowserForSession(
  assets: AssetReviewDeps | undefined,
  install: ComponentDeps | undefined,
  actor: Principal | null,
  input: { projectId?: string | null; requires?: readonly string[] }
): Promise<BuiltinBrowserBootstrap> {
  const out: { enabled: string[]; install?: { workerId: string; jobId: string }; skipped?: string } = { enabled: [] };
  if (!input.requires?.includes(BUILTIN_CHROMIUM.capability)) return out;
  if (assets && input.projectId && actor) out.enabled = await ensureBuiltinBrowserAssets(assets, input.projectId, actor);
  if (!install) return out;
  const workers = await install.workers.list();
  const statuses = new Map(browserStatus(workers).map((status) => [status.workerId, status]));
  const ready = workers.some((worker) => worker.state === 'online' && statuses.get(worker.workerId)?.ready);
  if (ready) return out;
  const installing = workers.some((worker) => statuses.get(worker.workerId)?.installing);
  if (installing) {
    out.skipped = '已有机器正在安装 Chromium：用 worker_component_status 查进度，装好后重试';
    return out;
  }
  const candidate = workers.find(
    (worker) => worker.state === 'online' && worker.origin !== 'local' && worker.inventory?.componentInstall && worker.inventory.runtimes.some((runtime) => runtime.agentId === 'pi')
  );
  if (!candidate) {
    out.skipped = '没有能装 Chromium 的在线机器（Worker 太旧或没有 pi 运行时）：先更新 Worker 再试';
    return out;
  }
  if (!actor) {
    out.skipped = '没有登录主体，不能发起安装：用账号的令牌再试';
    return out;
  }
  const started = await installBuiltinBrowser(install, actor, candidate.workerId);
  if (!started.ok) {
    out.skipped = started.error.message;
    return out;
  }
  out.install = { workerId: candidate.workerId, jobId: started.value.jobId };
  return out;
}
