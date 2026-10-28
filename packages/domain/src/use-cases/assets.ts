import {
  isFileAssetKind,
  assetScope,
  assetSlot,
  checkAssetName,
  resolveProjectAssets,
  compareFiles,
  packAsset,
  type Asset,
  type AssetKind,
  type AssetManifestEntry,
  type AssetRevision,
  type AssetSource,
  type FileDiff,
  type IncomingFile,
  type PackedAsset,
  type ProjectAssetChoice,
  type AssetScope,
  type WorkerAssetSync,
  type SessionAssetEntry
} from '../asset.ts';
import { conflict, invalid, notFound, type DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import { err, ok, type Result } from '../result.ts';
import type { WorkerStatus } from '../worker.ts';
import type { AuditAction, Principal } from '../account.ts';
import type { AuditLog } from '../ports/audit-log.ts';
import type { AssetRepository } from '../ports/asset-repository.ts';
import type { AssetReader, GitCandidate } from '../ports/asset-reader.ts';
import type { AssetDelivery, AssetSyncBoard } from '../ports/asset-delivery.ts';
import type { SecretInfo, SecretVault } from '../ports/secret-vault.ts';
import { MCP_CONFIG_FILE, checkSecretName, expandRecord, expandSecrets, mcpSecretRefs, parseMcpConfig, type McpConfig, type McpLaunch } from '../mcp.ts';

/** 资产中心是独立的限界上下文：不塞进 Deps。 */
export interface AssetDeps {
  readonly assets: AssetRepository;
  readonly reader: AssetReader;
  readonly delivery: AssetDelivery;
  readonly board: AssetSyncBoard;
  readonly workers: { list(): Promise<WorkerStatus[]> };
  /** MCP 资产引用的密钥（加密存放）。 */
  readonly secrets: SecretVault;
  /** 项目级资产要认项目（只读）。 */
  readonly projects: { byId(id: string): Promise<{ readonly id: string; readonly name: string } | null> };
  readonly now: () => number;
}

export const ASSET_KIND_LABEL: Readonly<Record<AssetKind, string>> = { skill: '技能', instruction: '指令', mcp: 'MCP 服务器' };

export interface AssetView extends Asset {
  /** 装在哪些 Worker 上。 */
  readonly workerIds: readonly string[];
  readonly files: number;
  readonly bytes: number;
}

export interface WorkerAssetsView {
  readonly workerId: string;
  readonly label: string;
  readonly state: WorkerStatus['state'];
  readonly assetIds: readonly string[];
  readonly sync: WorkerAssetSync | null;
}

export interface AssetsOverview {
  readonly assets: readonly AssetView[];
  readonly workers: readonly WorkerAssetsView[];
}

const MAX_DESCRIPTION = 1024;

export async function assetsOverview(deps: Pick<AssetDeps, 'assets' | 'board' | 'workers'>): Promise<AssetsOverview> {
  const [assets, installations, workers] = await Promise.all([deps.assets.list(), deps.assets.installations(), deps.workers.list()]);
  const byAsset = new Map<string, string[]>();
  const byWorker = new Map<string, string[]>();
  for (const { workerId, assetId } of installations) {
    byAsset.set(assetId, [...(byAsset.get(assetId) ?? []), workerId]);
    byWorker.set(workerId, [...(byWorker.get(workerId) ?? []), assetId]);
  }
  const views: AssetView[] = [];
  for (const asset of assets) {
    const pinned = await deps.assets.revision(asset.id, asset.pinned);
    views.push({
      ...asset,
      workerIds: byAsset.get(asset.id) ?? [],
      files: pinned?.files.length ?? 0,
      bytes: pinned?.files.reduce((sum, file) => sum + file.size, 0) ?? 0
    });
  }
  return {
    assets: views,
    workers: workers.map((worker) => ({
      workerId: worker.workerId,
      label: worker.label,
      state: worker.state,
      assetIds: byWorker.get(worker.workerId) ?? [],
      sync: deps.board.get(worker.workerId)
    }))
  };
}

async function describePacked(
  deps: Pick<AssetDeps, 'reader'>,
  kind: AssetKind,
  files: readonly IncomingFile[],
  givenName: string | null
): Promise<Result<{ name: string; description: string; packed: PackedAsset }, DomainError>> {
  const packed = await packAsset(kind, files);
  if (!packed.ok) return packed;
  if (kind === 'mcp') {
    const config = parseMcpConfig(new TextDecoder().decode(files[0]?.data ?? new Uint8Array()));
    if (!config.ok) return config;
    const checked = checkAssetName(config.value.name);
    if (!checked.ok) return checked;
    if (config.value.description.length > MAX_DESCRIPTION) return err(invalid('description 超过 1024 个字符'));
    return ok({ name: config.value.name, description: config.value.description.trim(), packed: packed.value });
  }
  const meta = deps.reader.describe(kind, files);
  if (!meta.ok) return meta;
  const name = kind === 'skill' ? meta.value.name : (givenName ?? meta.value.name);
  if (name === null || name === '') return err(invalid(kind === 'skill' ? 'SKILL.md 的 frontmatter 里没有 name' : '给这条指令起个名字'));
  const checked = checkAssetName(name);
  if (!checked.ok) return checked;
  if (kind === 'skill' && meta.value.description.trim() === '') return err(invalid('SKILL.md 的 frontmatter 里没有 description'));
  if (meta.value.description.length > MAX_DESCRIPTION) return err(invalid('description 超过 1024 个字符'));
  return ok({ name, description: meta.value.description.trim(), packed: packed.value });
}

const revisionOf = (
  assetId: string,
  name: string,
  description: string,
  packed: PackedAsset,
  commit: string | null,
  at: number
): AssetRevision => ({ assetId, digest: packed.digest, name, description, files: packed.files, commit, createdAt: at });

type CreateDeps = Pick<AssetDeps, 'assets' | 'reader' | 'now'> & Partial<Pick<AssetDeps, 'projects'>>;

async function createAsset(
  deps: CreateDeps,
  kind: AssetKind,
  source: AssetSource,
  files: readonly IncomingFile[],
  givenName: string | null,
  commit: string | null,
  projectId: string | null
): Promise<Result<Asset, DomainError>> {
  if (projectId !== null && !(await deps.projects?.byId(projectId))) return err(notFound('没有这个项目'));
  const described = await describePacked(deps, kind, files, givenName);
  if (!described.ok) return described;
  const { name, description, packed } = described.value;
  if (await deps.assets.byName(kind, name, projectId)) {
    const where = projectId === null ? '全局' : '这个项目里';
    return err(conflict(`${where}已经有叫「${name}」的${ASSET_KIND_LABEL[kind]}了：到它那里传新版本`));
  }
  const at = deps.now();
  const asset: Asset = {
    id: newId(),
    kind,
    name,
    projectId,
    description,
    source,
    pinned: packed.digest,
    latest: packed.digest,
    createdAt: at,
    updatedAt: at
  };
  await deps.assets.create(asset, revisionOf(asset.id, name, description, packed, commit, at), packed.blobs);
  return ok(asset);
}

export function uploadAsset(
  deps: CreateDeps,
  input: { kind: AssetKind; name?: string | null; files: readonly IncomingFile[]; projectId?: string | null }
): Promise<Result<Asset, DomainError>> {
  return createAsset(deps, input.kind, { type: 'upload' }, input.files, input.name ?? null, null, input.projectId ?? null);
}

const GIT_URL = /^(https:\/\/|ssh:\/\/|git@)[^\s]+$/;

export async function scanGitSource(
  deps: Pick<AssetDeps, 'reader'>,
  url: string,
  ref: string | null
): Promise<Result<{ commit: string; candidates: GitCandidate[] }, DomainError>> {
  if (!GIT_URL.test(url)) return err(invalid('只支持 https://、ssh:// 或 git@ 开头的仓库地址'));
  return deps.reader.scanGit(url, ref);
}

export async function importGitAsset(
  deps: CreateDeps,
  input: { kind: AssetKind; url: string; ref: string | null; path: string; name?: string | null; projectId?: string | null }
): Promise<Result<Asset, DomainError>> {
  if (!GIT_URL.test(input.url)) return err(invalid('只支持 https://、ssh:// 或 git@ 开头的仓库地址'));
  const checkout = await deps.reader.readGit(input.url, input.ref, input.path, input.kind);
  if (!checkout.ok) return checkout;
  const source: AssetSource = { type: 'git', url: input.url, ref: input.ref, path: input.path };
  return createAsset(deps, input.kind, source, checkout.value.files, input.name ?? null, checkout.value.commit, input.projectId ?? null);
}

/** 新版本只记成「最新」，不换钉：要看过 diff 再 `pinAssetRevision`。名字不能变（Worker 上的目录名）。 */
async function offerRevision(
  deps: Pick<AssetDeps, 'assets' | 'reader' | 'now'>,
  asset: Asset,
  files: readonly IncomingFile[],
  commit: string | null
): Promise<Result<{ asset: Asset; changed: boolean }, DomainError>> {
  const described = await describePacked(deps, asset.kind, files, asset.name);
  if (!described.ok) return described;
  const { name, description, packed } = described.value;
  if (name !== asset.name) return err(invalid(`新版本的名字变成了「${name}」：名字要保持「${asset.name}」`));
  const at = deps.now();
  const known = await deps.assets.revision(asset.id, packed.digest);
  if (!known) await deps.assets.addRevision(revisionOf(asset.id, name, description, packed, commit, at), packed.blobs);
  if (asset.latest === packed.digest) return ok({ asset, changed: false });
  const next: Asset = { ...asset, latest: packed.digest, updatedAt: at };
  await deps.assets.update(next);
  return ok({ asset: next, changed: packed.digest !== asset.pinned });
}

export async function uploadAssetRevision(
  deps: Pick<AssetDeps, 'assets' | 'reader' | 'now'>,
  assetId: string,
  files: readonly IncomingFile[]
): Promise<Result<{ asset: Asset; changed: boolean }, DomainError>> {
  const asset = await deps.assets.get(assetId);
  if (!asset) return err(notFound('没有这个资产'));
  return offerRevision(deps, asset, files, null);
}

/** git 来源：重新检出同一个 ref / 路径，内容变了就记一个待确认的新版本。 */
export async function checkAssetUpdate(
  deps: Pick<AssetDeps, 'assets' | 'reader' | 'now'>,
  assetId: string
): Promise<Result<{ asset: Asset; changed: boolean }, DomainError>> {
  const asset = await deps.assets.get(assetId);
  if (!asset) return err(notFound('没有这个资产'));
  if (asset.source.type !== 'git') return err(invalid('上传来的资产没有来源可查：直接传新版本'));
  const checkout = await deps.reader.readGit(asset.source.url, asset.source.ref, asset.source.path, asset.kind);
  if (!checkout.ok) return checkout;
  return offerRevision(deps, asset, checkout.value.files, checkout.value.commit);
}

const decoder = new TextDecoder('utf-8', { fatal: true });
function textOf(data: Uint8Array | null): string | null {
  if (data === null) return '';
  if (data.includes(0)) return null;
  try {
    return decoder.decode(data);
  } catch {
    return null;
  }
}

export async function diffAssetRevisions(
  deps: Pick<AssetDeps, 'assets' | 'reader'>,
  assetId: string,
  from: string,
  to: string
): Promise<Result<FileDiff[], DomainError>> {
  const [a, b] = await Promise.all([deps.assets.revision(assetId, from), deps.assets.revision(assetId, to)]);
  if (!a || !b) return err(notFound('没有这个版本'));
  const out: FileDiff[] = [];
  for (const entry of compareFiles(a.files, b.files)) {
    if (entry.change === 'unchanged') {
      out.push({ path: entry.path, change: entry.change, patch: null });
      continue;
    }
    const before = textOf(entry.before ? await deps.assets.blob(entry.before.sha256) : null);
    const after = textOf(entry.after ? await deps.assets.blob(entry.after.sha256) : null);
    const patch = before === null || after === null ? null : deps.reader.diffText(entry.path, before, after);
    out.push({ path: entry.path, change: entry.change, patch });
  }
  return ok(out);
}

/** 确认升级（或回退）：钉到一个已有版本，再把装了它的 Worker 都同步一遍。 */
export async function pinAssetRevision(
  deps: AssetDeps,
  assetId: string,
  digest: string
): Promise<Result<Asset, DomainError>> {
  const asset = await deps.assets.get(assetId);
  if (!asset) return err(notFound('没有这个资产'));
  const revision = await deps.assets.revision(assetId, digest);
  if (!revision) return err(notFound('没有这个版本'));
  const next: Asset = { ...asset, pinned: digest, description: revision.description, updatedAt: deps.now() };
  await deps.assets.update(next);
  await resyncHolders(deps, assetId);
  return ok(next);
}

export async function deleteAsset(deps: AssetDeps, assetId: string): Promise<Result<void, DomainError>> {
  const asset = await deps.assets.get(assetId);
  if (!asset) return err(notFound('没有这个资产'));
  const holders = (await deps.assets.installations()).filter((row) => row.assetId === assetId).map((row) => row.workerId);
  await deps.assets.remove(assetId);
  for (const workerId of holders) void syncWorkerAssets(deps, workerId);
  return ok(undefined);
}

export async function setAssetInstalled(
  deps: AssetDeps,
  input: { workerId: string; assetId: string; installed: boolean }
): Promise<Result<void, DomainError>> {
  const asset = await deps.assets.get(input.assetId);
  if (!asset) return err(notFound('没有这个资产'));
  if (input.installed) {
    const known = (await deps.workers.list()).some((worker) => worker.workerId === input.workerId);
    if (!known) return err(notFound('没有这台机器'));
    await deps.assets.install(input.workerId, input.assetId, deps.now());
  } else {
    await deps.assets.uninstall(input.workerId, input.assetId);
  }
  void syncWorkerAssets(deps, input.workerId);
  return ok(undefined);
}

async function resyncHolders(deps: AssetDeps, assetId: string): Promise<void> {
  const holders = (await deps.assets.installations()).filter((row) => row.assetId === assetId);
  for (const { workerId } of holders) void syncWorkerAssets(deps, workerId);
}

/** 一台 Worker 该有的资产：装给它的那些资产，各取钉住的版本。 */
export async function workerAssetManifest(
  deps: Pick<AssetDeps, 'assets'>,
  workerId: string
): Promise<AssetManifestEntry[]> {
  const mine = (await deps.assets.installations()).filter((row) => row.workerId === workerId);
  const entries: AssetManifestEntry[] = [];
  for (const { assetId } of mine) {
    const asset = await deps.assets.get(assetId);
    if (!asset) continue;
    const kind = asset.kind;
    if (!isFileAssetKind(kind)) continue;
    const revision = await deps.assets.revision(assetId, asset.pinned);
    if (!revision) continue;
    entries.push({
      assetId,
      kind,
      name: asset.name,
      slot: assetSlot(asset),
      description: revision.description,
      digest: revision.digest,
      files: revision.files
    });
  }
  return entries.sort((a, b) => a.slot.localeCompare(b.slot));
}

/**
 * 把清单推给 Worker 并记下结果。不在线就记「待同步」：它下次 hello 时会再同步。
 * 同一台并发两次时，只认最后开始的那次的结果。
 */
export async function syncWorkerAssets(deps: AssetDeps, workerId: string): Promise<WorkerAssetSync> {
  const manifest = await workerAssetManifest(deps, workerId);
  const previous = deps.board.get(workerId);
  const startedAt = Math.max(deps.now(), (previous?.at ?? 0) + 1);
  const online = (await deps.workers.list()).some((worker) => worker.workerId === workerId && worker.state === 'online');
  const base = { workerId, root: previous?.root ?? null, installed: previous?.installed ?? {}, at: startedAt };
  if (!online) {
    const status: WorkerAssetSync = { ...base, state: 'pending', error: null };
    deps.board.set(status);
    return status;
  }
  deps.board.set({ ...base, state: 'syncing', error: null });
  const report = await deps.delivery.push(workerId, manifest);
  const status: WorkerAssetSync = report.ok
    ? { workerId, state: 'synced', root: report.value.root, installed: report.value.installed, error: null, at: startedAt }
    : { ...base, state: 'failed', error: report.error.message };
  if (deps.board.get(workerId)?.at === startedAt) deps.board.set(status);
  return status;
}

/** Worker 来取 blob：只给它清单里确实有的那些（别的 Worker 的资产拿不到）。 */
export async function assetBlobsForWorker(
  deps: Pick<AssetDeps, 'assets'>,
  workerId: string,
  hashes: readonly string[]
): Promise<Result<{ sha256: string; data: Uint8Array }[], DomainError>> {
  const allowed = new Set((await workerAssetManifest(deps, workerId)).flatMap((entry) => entry.files.map((file) => file.sha256)));
  const out: { sha256: string; data: Uint8Array }[] = [];
  for (const hash of hashes) {
    if (!allowed.has(hash)) return err(invalid(`不在这台机器的资产清单里：${hash.slice(0, 12)}`));
    const data = await deps.assets.blob(hash);
    if (!data) return err(notFound(`内容丢了：${hash.slice(0, 12)}`));
    out.push({ sha256: hash, data });
  }
  return ok(out);
}

export async function assetRevisions(
  deps: Pick<AssetDeps, 'assets'>,
  assetId: string
): Promise<Result<AssetRevision[], DomainError>> {
  if (!(await deps.assets.get(assetId))) return err(notFound('没有这个资产'));
  return ok(await deps.assets.revisions(assetId));
}

/** 读一个版本里的一份文件（界面上预览 SKILL.md 用）。 */
export async function assetFileText(
  deps: Pick<AssetDeps, 'assets'>,
  assetId: string,
  digest: string,
  path: string
): Promise<Result<string | null, DomainError>> {
  const revision = await deps.assets.revision(assetId, digest);
  if (!revision) return err(notFound('没有这个版本'));
  const file = revision.files.find((candidate) => candidate.path === path);
  if (!file) return err(notFound('版本里没有这个文件'));
  return ok(textOf(await deps.assets.blob(file.sha256)));
}

/** 资产中心的写操作都留审计（谁、对哪个资产、做了什么）。 */
export async function recordAssetAudit(
  deps: { readonly audit: AuditLog; readonly now: () => number },
  actor: Principal,
  action: Extract<AuditAction, `asset.${string}`>,
  target: string,
  detail: string
): Promise<void> {
  await deps.audit.append({ id: newId(), actorId: actor.user.id, actorEmail: actor.user.email, action, target, detail, at: deps.now() });
}

/* ── MCP 资产与密钥 ── */

/** 一台 Worker 上生效的 MCP 资产（钉住的版本解析好的配置）。坏配置跳过（导入时已校验过，这里只防御）。 */
export async function workerMcpConfigs(
  deps: Pick<AssetDeps, 'assets'>,
  workerId: string,
  only?: ReadonlySet<string>
): Promise<{ asset: Asset; digest: string; config: McpConfig }[]> {
  const mine = (await deps.assets.installations()).filter((row) => row.workerId === workerId && (!only || only.has(row.assetId)));
  const out: { asset: Asset; digest: string; config: McpConfig }[] = [];
  for (const { assetId } of mine) {
    const asset = await deps.assets.get(assetId);
    if (!asset || asset.kind !== 'mcp') continue;
    const revision = await deps.assets.revision(assetId, asset.pinned);
    const file = revision?.files.find((candidate) => candidate.path === MCP_CONFIG_FILE);
    const data = file ? await deps.assets.blob(file.sha256) : null;
    if (!data) continue;
    const config = parseMcpConfig(new TextDecoder().decode(data));
    if (config.ok) out.push({ asset, digest: asset.pinned, config: config.value });
  }
  return out.sort((a, b) => a.asset.name.localeCompare(b.asset.name));
}

/**
 * 会话启动时给 Worker 的 MCP 清单：stdio 的密钥此刻才展开（只进那个进程的环境变量）；
 * http 只给名字（Worker 填本机中转地址），密钥留在 hub。缺密钥的那项跳过并报名字，不拦会话。
 */
export async function sessionMcpLaunch(
  deps: Pick<AssetDeps, 'assets' | 'secrets'>,
  workerId: string,
  only?: ReadonlySet<string>
): Promise<{ launch: McpLaunch[]; skipped: { name: string; reason: string }[] }> {
  const configs = await workerMcpConfigs(deps, workerId, only);
  const wanted = [...new Set(configs.filter(({ config }) => config.transport === 'stdio').flatMap(({ config }) => mcpSecretRefs(config)))];
  const secrets = wanted.length > 0 ? await deps.secrets.reveal(wanted) : {};
  const launch: McpLaunch[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const { asset, config } of configs) {
    if (config.transport === 'http') {
      launch.push({ transport: 'http', name: asset.name, url: '' });
      continue;
    }
    const env = expandRecord(config.env, secrets);
    const args = config.args.map((arg) => expandSecrets(arg, secrets));
    const bad = !env.ok ? env : args.find((arg) => !arg.ok);
    if (bad && !bad.ok) {
      skipped.push({ name: asset.name, reason: bad.error.message });
      continue;
    }
    launch.push({
      transport: 'stdio',
      name: asset.name,
      command: config.command,
      args: args.map((arg) => (arg.ok ? arg.value : '')),
      env: env.ok ? env.value : {}
    });
  }
  return { launch, skipped };
}

/** hub 代连远端 MCP：只认装在这台 Worker 上的 http 资产；密钥在这里展开进请求头。 */
export async function remoteMcpTarget(
  deps: Pick<AssetDeps, 'assets' | 'secrets'>,
  workerId: string,
  name: string,
  /** 会话的生效集合（见 sessionAssetPlan）；给了就只在里面找，否则同名时全局优先。 */
  only?: ReadonlySet<string>
): Promise<Result<{ assetId: string; digest: string; url: string; headers: Record<string, string> }, DomainError>> {
  const candidates = (await workerMcpConfigs(deps, workerId, only)).filter((entry) => entry.asset.name === name);
  const found = candidates.find((entry) => entry.asset.projectId === null) ?? candidates[0];
  if (!found) return err(notFound(`这台机器没装 MCP「${name}」`));
  if (found.config.transport !== 'http') return err(invalid(`「${name}」是本机 stdio 服务器，不经 hub 代连`));
  const secrets = await deps.secrets.reveal(mcpSecretRefs(found.config));
  const url = expandSecrets(found.config.url, secrets);
  if (!url.ok) return url;
  const headers = expandRecord(found.config.headers, secrets);
  if (!headers.ok) return headers;
  return ok({ assetId: found.asset.id, digest: found.digest, url: url.value, headers: headers.value });
}

export interface SecretView extends SecretInfo {
  /** 引用它的 MCP 资产名。 */
  readonly usedBy: readonly string[];
}

/** 密钥清单：只有名字、更新时间和谁在用；另附「被引用但还没设置」的名字。 */
export async function listSecrets(deps: Pick<AssetDeps, 'assets' | 'secrets'>): Promise<{ secrets: SecretView[]; missing: SecretView[] }> {
  const usedBy = new Map<string, string[]>();
  for (const asset of await deps.assets.list()) {
    if (asset.kind !== 'mcp') continue;
    const revision = await deps.assets.revision(asset.id, asset.pinned);
    const file = revision?.files.find((candidate) => candidate.path === MCP_CONFIG_FILE);
    const data = file ? await deps.assets.blob(file.sha256) : null;
    const config = data ? parseMcpConfig(new TextDecoder().decode(data)) : null;
    if (!config?.ok) continue;
    for (const ref of mcpSecretRefs(config.value)) usedBy.set(ref, [...(usedBy.get(ref) ?? []), asset.name]);
  }
  const stored = await deps.secrets.list();
  const names = new Set(stored.map((secret) => secret.name));
  return {
    secrets: stored.map((secret) => ({ ...secret, usedBy: usedBy.get(secret.name) ?? [] })),
    missing: [...usedBy.entries()].filter(([name]) => !names.has(name)).map(([name, users]) => ({ name, updatedAt: 0, usedBy: users }))
  };
}

const MAX_SECRET_BYTES = 16 * 1024;

export async function setSecret(deps: Pick<AssetDeps, 'secrets' | 'now'>, name: string, value: string): Promise<Result<void, DomainError>> {
  const checked = checkSecretName(name);
  if (!checked.ok) return checked;
  if (value === '') return err(invalid('密钥值不能为空'));
  if (new TextEncoder().encode(value).byteLength > MAX_SECRET_BYTES) return err(invalid('密钥值太长（上限 16 KB）'));
  if (/[\r\n\0]/.test(value)) return err(invalid('密钥值里不能有换行或空字符'));
  await deps.secrets.put(name, value, deps.now());
  return ok(undefined);
}

export async function deleteSecret(deps: Pick<AssetDeps, 'secrets'>, name: string): Promise<Result<void, DomainError>> {
  if (!(await deps.secrets.remove(name))) return err(notFound('没有这个密钥'));
  return ok(undefined);
}

/* ── 项目级作用域与会话资产清单 ── */

export interface ProjectAssetsView {
  readonly projectId: string;
  readonly choices: readonly (Omit<ProjectAssetChoice, 'asset'> & { readonly assetId: string; readonly scope: AssetScope; readonly overridden: boolean })[];
}

/** 项目设置里的资产页：这个项目看得见的资产、开关、谁被就近盖住。 */
export async function projectAssets(deps: Pick<AssetDeps, 'assets' | 'projects'>, projectId: string): Promise<Result<ProjectAssetsView, DomainError>> {
  if (!(await deps.projects.byId(projectId))) return err(notFound('没有这个项目'));
  const settings = await deps.assets.projectSettings(projectId);
  const { choices } = resolveProjectAssets(await deps.assets.list(), projectId, settings);
  return ok({
    projectId,
    choices: choices.map(({ asset, enabled, shadowedBy }) => ({
      assetId: asset.id,
      scope: assetScope(asset),
      enabled,
      shadowedBy,
      overridden: asset.id in settings
    }))
  });
}

export async function setProjectAsset(
  deps: Pick<AssetDeps, 'assets' | 'projects'>,
  input: { projectId: string; assetId: string; enabled: boolean | null }
): Promise<Result<void, DomainError>> {
  if (!(await deps.projects.byId(input.projectId))) return err(notFound('没有这个项目'));
  const asset = await deps.assets.get(input.assetId);
  if (!asset) return err(notFound('没有这个资产'));
  if (asset.projectId !== null && asset.projectId !== input.projectId) return err(invalid('这是别的项目的项目级资产，不能在这里开'));
  await deps.assets.setProjectSetting(input.projectId, input.assetId, input.enabled);
  return ok(undefined);
}

/**
 * 一次会话该用哪些资产：这个项目生效的（就近优先），再与这台 Worker 装了的取交集；
 * 文件类还得已经同步落地（以 Worker 回报的版本为准）。projectId = null（找不到任务）时只给全局的。
 */
export async function sessionAssetPlan(
  deps: Pick<AssetDeps, 'assets' | 'board'>,
  workerId: string,
  projectId: string | null
): Promise<{ assetIds: string[]; entries: SessionAssetEntry[] }> {
  const all = await deps.assets.list();
  const effective =
    projectId === null
      ? all.filter((asset) => asset.projectId === null)
      : resolveProjectAssets(all, projectId, await deps.assets.projectSettings(projectId)).effective;
  const installed = new Set((await deps.assets.installations()).filter((row) => row.workerId === workerId).map((row) => row.assetId));
  const landed = deps.board.get(workerId)?.installed ?? {};
  const entries: SessionAssetEntry[] = [];
  for (const asset of effective) {
    if (!installed.has(asset.id)) continue;
    const digest = isFileAssetKind(asset.kind) ? landed[asset.id] : asset.pinned;
    if (digest === undefined) continue;
    entries.push({ assetId: asset.id, kind: asset.kind, name: asset.name, digest, scope: assetScope(asset) });
  }
  entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return { assetIds: entries.map((entry) => entry.assetId), entries };
}
