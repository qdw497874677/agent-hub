import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type { AssetManifestEntryWire } from '@agent-hub/contract';
import { checkAssetName, normalizeAssetPath, type SessionAssets } from '@agent-hub/domain';

/**
 * Worker 的专属资产目录（docs/design/asset-hub.md、docs/design/asset-versions.md）。
 *
 * 只写 `root` 这一个目录：不碰 ~/.agents、~/.claude、~/.pi 之类的全局位置，卸载 = 删掉它。
 *
 *   root/.blobs/<sha256>                    按内容寻址的缓存，升级只取变了的文件
 *   root/assets/<digest12>/<slot>/…         不可变的技能版本（写一次不再改）
 *   root/assets/<digest12>/<slot>.md        不可变的指令版本
 *   root/assets/<digest12>/.digest          完整 digest，用来发现 12 位前缀撞车
 *   root/skills/<name>                      → …/assets/<digest12>/<slot>      兼容链接（指向当前）
 *   root/project-skills/<id8>/<name>        → …/assets/<digest12>/<slot>      兼容链接
 *   root/instructions/<slot>.md             → …/assets/<digest12>/<slot>.md   兼容链接
 *   root/.manifest.json                     当前落地的清单
 *
 * 内容一旦落地就只读：换钉 / 删除只换兼容链接、清不再被引用的版本目录，所以正在跑的会话
 * 拿到的版本化路径永远读得到当初那一版。`retain` 里的旧 digest 由 hub 按 session_assets 算出来。
 * 每个条目先在 .staging 里拼好，再整体改名换上去；同步串行执行。
 */
export interface WorkerAssets {
  readonly root: string;
  /**
   * 让目录与清单一致；缺的内容用 fetch 按哈希取（每批 ≤ 200 个）。
   * `retain` = 这台机器上仍有会话在用的旧版本 digest：对应的版本目录不清理（缺省 = 不保留）。
   */
  sync(
    entries: readonly AssetManifestEntryWire[],
    fetch: FetchBlobs,
    retain?: readonly string[]
  ): Promise<{ root: string; installed: Record<string, string> }>;
  /**
   * 此刻装着、且在这次会话清单（`only`）里的东西，返回不可变的版本化绝对路径。
   * 没给清单 = 什么都不给（#223 fail-closed）；旧语义「没给 = 全给」已废弃。
   */
  current(only?: ReadonlySet<string>): Promise<SessionAssets | undefined>;
}

export type FetchBlobs = (hashes: readonly string[]) => Promise<readonly { sha256: string; data: string }[]>;

const BATCH = 200;
/** digest 前缀长度：12 位十六进制足够避开日常撞车，撞了靠 .digest 发现。 */
const PREFIX = 12;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const prefixOf = (digest: string): string => digest.slice(0, PREFIX);

export function defaultAssetsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env['WORKER_ASSETS_DIR'] || join(homedir(), '.agent-hub', 'assets'));
}

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

/** 落地名：全局 = name；项目级 = name--<id8>。 */
const slotOf = (entry: Pick<AssetManifestEntryWire, 'name' | 'slot'>): string => entry.slot ?? entry.name;
const scopeOf = (entry: Pick<AssetManifestEntryWire, 'name' | 'slot'>): string | null => {
  const slot = slotOf(entry);
  return slot === entry.name ? null : slot.slice(slot.lastIndexOf('--') + 2);
};

function validate(entries: readonly AssetManifestEntryWire[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = checkAssetName(entry.name);
    if (!name.ok) throw new Error(name.error.message);
    const key = `${entry.kind}:${slotOf(entry)}`;
    if (seen.has(key)) throw new Error(`清单里「${entry.name}」重复了`);
    seen.add(key);
    if (entry.kind === 'instruction' && entry.files.length !== 1) throw new Error(`指令「${entry.name}」必须正好一个文件`);
    if (entry.kind === 'skill' && !entry.files.some((file) => file.path === 'SKILL.md')) {
      throw new Error(`技能「${entry.name}」缺 SKILL.md`);
    }
    for (const file of entry.files) {
      const path = normalizeAssetPath(file.path);
      if (!path.ok || path.value !== file.path) throw new Error(`「${entry.name}」里的路径不合法：${file.path}`);
    }
  }
}

export function createWorkerAssets(options: { readonly root?: string } = {}): WorkerAssets {
  const root = resolve(options.root ?? defaultAssetsRoot());
  const blobs = join(root, '.blobs');
  const staging = join(root, '.staging');
  const versions = join(root, 'assets');
  const manifestPath = join(root, '.manifest.json');
  let queue: Promise<unknown> = Promise.resolve();

  // 版本目录：assets/<digest 前 12 位>/<slot>（技能）或 <slot>.md（指令）。
  const versionDir = (entry: Pick<AssetManifestEntryWire, 'digest'>): string => join(versions, prefixOf(entry.digest));
  const versionPath = (entry: Pick<AssetManifestEntryWire, 'kind' | 'digest' | 'name' | 'slot'>): string =>
    join(versionDir(entry), entry.kind === 'instruction' ? `${slotOf(entry)}.md` : slotOf(entry));

  // 兼容旧路径的符号链接位置：skills/<name>、project-skills/<id8>/<name>、instructions/<slot>.md。
  const linkPath = (entry: Pick<AssetManifestEntryWire, 'kind' | 'name' | 'slot'>): string => {
    if (entry.kind === 'instruction') return join(root, 'instructions', `${slotOf(entry)}.md`);
    const scope = scopeOf(entry);
    return scope === null ? join(root, 'skills', entry.name) : join(root, 'project-skills', scope, entry.name);
  };

  async function readManifest(): Promise<AssetManifestEntryWire[]> {
    try {
      const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as { entries?: AssetManifestEntryWire[] };
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      return [];
    }
  }

  async function writeAtomic(path: string, bytes: Uint8Array | string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temp = join(staging, randomUUID());
    await mkdir(staging, { recursive: true });
    await writeFile(temp, bytes);
    await rename(temp, path);
  }

  async function ensureBlobs(entries: readonly AssetManifestEntryWire[], fetch: FetchBlobs): Promise<void> {
    await mkdir(blobs, { recursive: true });
    const wanted = new Set(entries.flatMap((entry) => entry.files.map((file) => file.sha256)));
    const missing: string[] = [];
    for (const hash of wanted) if (!(await exists(join(blobs, hash)))) missing.push(hash);
    while (missing.length > 0) {
      const batch = missing.slice(0, BATCH);
      const got = await fetch(batch);
      let progress = 0;
      for (const blob of got) {
        const index = missing.indexOf(blob.sha256);
        if (index < 0) continue;
        const bytes = Buffer.from(blob.data, 'base64');
        if (sha256(bytes) !== blob.sha256) throw new Error(`取回的内容哈希不对：${blob.sha256.slice(0, 12)}`);
        await writeAtomic(join(blobs, blob.sha256), bytes);
        missing.splice(index, 1);
        progress += 1;
      }
      if (progress === 0) throw new Error(`hub 没给出 ${missing.length} 份内容`);
    }
  }

  /**
   * 把条目内容放进不可变的版本目录。已存在就跳过（内容寻址），但 `.digest` 不一致时说明
   * 两个完整 digest 撞了同一个 12 位前缀，宁可报错也不能把别人的内容当成自己的。
   */
  async function materialize(entry: AssetManifestEntryWire): Promise<void> {
    const version = versionDir(entry);
    const marker = join(version, '.digest');
    await mkdir(version, { recursive: true });
    const recorded = await readFile(marker, 'utf8').catch(() => null);
    const digest = recorded?.trim();
    if (digest !== undefined && digest !== '' && digest !== entry.digest) {
      throw new Error(`资产版本前缀冲突：${prefixOf(entry.digest)} 已属于 ${digest}，不能再放 ${entry.digest}`);
    }
    if (digest === undefined || digest === '') await writeAtomic(marker, entry.digest);

    if (entry.kind === 'instruction') {
      const destination = versionPath(entry);
      if (!(await exists(destination))) await writeAtomic(destination, await readFile(join(blobs, entry.files[0]!.sha256)));
      return;
    }
    const destination = versionPath(entry);
    if (await exists(destination)) return;
    const build = join(staging, randomUUID());
    for (const file of entry.files) {
      const path = join(build, file.path);
      if (!path.startsWith(build + '/')) throw new Error(`路径越界：${file.path}`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, await readFile(join(blobs, file.sha256)));
    }
    await rename(build, destination);
  }

  /** 用相对符号链接刷新兼容路径；先建临时链接再改名，原子替换旧的链接 / 文件。 */
  async function replaceLink(link: string, target: string): Promise<void> {
    const dir = dirname(link);
    await mkdir(dir, { recursive: true });
    await mkdir(staging, { recursive: true });
    const temp = join(staging, randomUUID());
    // 链接内容必须是相对路径：整个 root 搬走/挂到别处仍然有效。
    await symlink(relative(dir, target), temp);
    // 旧布局在这些位置放的是真实目录：先挪进 staging 再放链接，最后再删旧的。
    if ((await lstat(link).catch(() => null))?.isDirectory()) {
      const archived = join(staging, randomUUID());
      await rename(link, archived);
      await rename(temp, link);
      await rm(archived, { recursive: true, force: true });
      return;
    }
    await rename(temp, link);
  }

  /** 目录是 hub 专属的：清单外的东西一律清掉。rm 不会跟随符号链接。 */
  async function prune(dir: string, keep: ReadonlySet<string>): Promise<void> {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) if (!keep.has(name)) await rm(join(dir, name), { recursive: true, force: true });
  }

  async function runSync(entries: readonly AssetManifestEntryWire[], fetch: FetchBlobs, retain: readonly string[]) {
    validate(entries);
    await mkdir(root, { recursive: true });
    await rm(staging, { recursive: true, force: true });
    await ensureBlobs(entries, fetch);
    for (const entry of entries) await materialize(entry);
    for (const entry of entries) await replaceLink(linkPath(entry), versionPath(entry));

    const skills = entries.filter((e) => e.kind === 'skill');
    await prune(join(root, 'skills'), new Set(skills.filter((e) => scopeOf(e) === null).map((e) => e.name)));
    const scoped = new Map<string, Set<string>>();
    for (const e of skills) {
      const scope = scopeOf(e);
      if (scope !== null) scoped.set(scope, (scoped.get(scope) ?? new Set()).add(e.name));
    }
    await prune(join(root, 'project-skills'), new Set(scoped.keys()));
    for (const [scope, names] of scoped) await prune(join(root, 'project-skills', scope), names);
    await prune(join(root, 'instructions'), new Set(entries.filter((e) => e.kind === 'instruction').map((e) => `${slotOf(e)}.md`)));

    // 版本目录只保留「当前清单 ∪ retain」里的 digest；其余旧版本清掉。
    const keepVersions = new Set([...entries.map((e) => prefixOf(e.digest)), ...retain.map(prefixOf)]);
    await prune(versions, keepVersions);

    await prune(blobs, new Set(entries.flatMap((entry) => entry.files.map((file) => file.sha256))));
    await writeAtomic(manifestPath, JSON.stringify({ entries }, null, 2));
    await rm(staging, { recursive: true, force: true });
    return { root, installed: Object.fromEntries(entries.map((entry) => [entry.assetId, entry.digest])) };
  }

  return {
    root,
    sync(entries, fetch, retain = []) {
      const run = queue.then(() => runSync(entries, fetch, retain));
      queue = run.catch(() => {});
      return run;
    },
    async current(only = new Set<string>()) {
      await queue;
      // 清单为空 = 一个都不给（#223）。历史上 `only` 缺省表示「全给」，那等于把
      // hub 的解析失败放大成「把机器上所有资产塞进会话」——现在一律按显式清单过滤。
      const entries = (await readManifest()).filter((entry) => only.has(entry.assetId));
      if (entries.length === 0) return undefined;
      const skills = entries
        .filter((entry) => entry.kind === 'skill')
        .map((entry) => ({ name: entry.name, description: entry.description, path: join(versionPath(entry), 'SKILL.md') }));
      const instructions = entries
        .filter((entry) => entry.kind === 'instruction')
        .map((entry) => ({ name: entry.name, path: versionPath(entry) }));
      return { root, skills, instructions };
    }
  };
}
