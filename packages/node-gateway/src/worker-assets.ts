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
 *   root/sessions/<sessionId>/skills/<slot> → …/assets/<digest12>/<slot>      每会话视图（#226 P4）
 *   root/sessions/<sessionId>/instructions/<slot>.md → …/assets/<digest12>/<slot>.md
 *   root/sessions/<sessionId>/.view.json    视图引用了哪些 digest（清理时算引用计数）
 *   root/.manifest.json                     当前落地的清单
 *
 * 内容一旦落地就只读：换钉 / 删除只换兼容链接、清不再被引用的版本目录，所以正在跑的会话
 * 拿到的版本化路径永远读得到当初那一版。`retain` 里的旧 digest 由 hub 按 session_assets 算出来。
 * 每个条目先在 .staging 里拼好，再整体改名换上去；同步串行执行。
 *
 * 视图（#226 P4）：同名资产的两个版本可以同时给两个会话用——视图目录里每个会话各有自己的一组
 * 链接，会话只拿视图里的路径；换钉只改兼容链接与其它会话的视图，不碰这个会话。
 */
export interface WorkerAssets {
  readonly root: string;
  /**
   * 让目录与清单一致；缺的内容用 fetch 按哈希取（每批 ≤ 200 个）。
   * `retain` = 这台机器上仍有会话在用的旧版本 digest：对应的版本目录不清理（缺省 = 不保留）。
   * `sessions` = hub 认为这台机器上还活着的会话（会话 → 想要的 assetId）：一并原子重建视图，
   * 并清掉不在列表里的孤儿视图；不传 = 不动视图（旧 hub）。
   */
  sync(
    entries: readonly AssetManifestEntryWire[],
    fetch: FetchBlobs,
    retain?: readonly string[],
    sessions?: readonly SessionAssetRequest[]
  ): Promise<{ root: string; installed: Record<string, string>; views: Record<string, SessionAssetView> }>;
  /**
   * 此刻装着、且在这次会话清单（`only`）里的东西，返回不可变的版本化绝对路径。
   * 没给清单 = 什么都不给（#223 fail-closed）；旧语义「没给 = 全给」已废弃。
   */
  current(only?: ReadonlySet<string>, digests?: Readonly<Record<string, string>>): Promise<SessionAssets | undefined>;
  /**
   * 清单里点了名、但这台机器上找不到版本目录的资产（名字）。
   * 会话照常启动，由调用方把「degraded」说给用户听——不能静默继续（#225 M3）。
   */
  missing(only?: ReadonlySet<string>, digests?: Readonly<Record<string, string>>): Promise<readonly string[]>;
  /**
   * 给一个会话建/刷新视图（会话启动时用）：返回技能目录、指令目录与给 agent 的清单。
   * `assetIds` 为空 = 删掉旧视图并返回 undefined。视图里的链接指向不可变版本目录，
   * 与兼容链接（skills/<name> 等）互不影响，所以同名不同版本能同时给两个会话用。
   */
  view(request: SessionAssetRequest): Promise<SessionAssetView | undefined>;
  /** 会话结束 / 归档：删掉它的视图（版本目录仍按 retain/视图引用清理）。返回是否真的删了。 */
  dropSession(sessionId: string): Promise<boolean>;
}

/** 一个会话想要的资产：assetId 列表 + 可选的精确 digest（换钉后仍按会话钉住的那一版）。 */
export interface SessionAssetRequest {
  /** 会话 id：直接当目录名用（只允许字母数字与 . _ -，不以 . 开头）。 */
  readonly sessionId: string;
  readonly assetIds: readonly string[];
  /** assetId → digest；缺省 = 清单里的当前版本。 */
  readonly digests?: Readonly<Record<string, string>>;
}

/** 落在 sessions/<sessionId>/ 下的会话视图。 */
export interface SessionAssetView {
  readonly sessionId: string;
  /** <root>/sessions/<sessionId>/skills 的绝对路径。 */
  readonly skillsDir: string;
  /** <root>/sessions/<sessionId>/instructions 的绝对路径。 */
  readonly instructionsDir: string;
  /** 交给 agent 的清单：skills[].path 是 <skillsDir>/<slot>/SKILL.md，instructions[].path 是 <instructionsDir>/<slot>.md。 */
  readonly assets: SessionAssets;
  /** 清单点了名、但本机没有对应版本目录的资产 id。 */
  readonly missing: readonly string[];
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

/** 会话 id 当目录名用：只接受能安全落在 sessions/ 下的写法。 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function checkSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) throw new Error(`会话 ID 不能用作目录名：${sessionId}`);
}

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
  const viewRoot = join(root, 'sessions');
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

  /* ── 每会话视图（#226 P4）：sessions/<sessionId>/{skills,instructions}/… → 不可变版本目录 ── */

  const viewDir = (sessionId: string): string => join(viewRoot, sessionId);

  /**
   * 把「会话想要的 assetId」翻译成版本化条目：assetId → 清单里的条目，digest 优先；
   * 版本目录不在就算缺（调用方照常启动会话，把这些 id 报成 degraded）。
   * `manifest` = 调用方手里那份清单（同步过程中清单文件还没写完，不能用旧文件）。
   */
  async function resolveRequest(
    request: SessionAssetRequest,
    manifest?: readonly AssetManifestEntryWire[]
  ): Promise<{ entries: AssetManifestEntryWire[]; missing: string[] }> {
    const listed = new Map((manifest ?? (await readManifest())).map((entry) => [entry.assetId, entry]));
    const entries: AssetManifestEntryWire[] = [];
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const assetId of request.assetIds) {
      const found = listed.get(assetId);
      const digest = request.digests?.[assetId];
      const entry = found === undefined ? undefined : digest === undefined ? found : { ...found, digest };
      if (entry === undefined || !(await exists(versionPath(entry)))) {
        missing.push(assetId);
        continue;
      }
      // 同一落地名（kind:slot）只留一份：视图里两个链接写同一个位置没有意义。
      const key = `${entry.kind}:${slotOf(entry)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
    return { entries, missing };
  }

  /**
   * 在 .staging 里拼好整个视图，再整体改名换成 sessions/<sessionId>（原子替换，中途不会露出半个视图）。
   * 链接一律用相对路径：整个 root 搬走/挂到别处仍然有效。
   */
  async function writeView(sessionId: string, entries: readonly AssetManifestEntryWire[]): Promise<void> {
    const build = join(staging, randomUUID());
    const skills = join(build, 'skills');
    const instructions = join(build, 'instructions');
    await mkdir(skills, { recursive: true });
    await mkdir(instructions, { recursive: true });
    const linkTo = async (link: string, target: string): Promise<void> => {
      await symlink(relative(dirname(link), target), link);
    };
    for (const entry of entries) {
      if (entry.kind === 'skill') await linkTo(join(skills, slotOf(entry)), versionPath(entry));
      else await linkTo(join(instructions, `${slotOf(entry)}.md`), versionPath(entry));
    }
    // 记下视图引用的 digest：prune 版本目录时算引用计数（文件真被删了也不至于误判）。
    const pinned = entries.map((entry) => ({ assetId: entry.assetId, digest: entry.digest, kind: entry.kind, slot: slotOf(entry) }));
    await writeFile(join(build, '.view.json'), JSON.stringify({ sessionId, entries: pinned }, null, 2));

    await mkdir(viewRoot, { recursive: true });
    await mkdir(staging, { recursive: true });
    const target = viewDir(sessionId);
    const trash = join(staging, randomUUID());
    if (await exists(target)) await rename(target, trash);
    await rename(build, target);
    await rm(trash, { recursive: true, force: true });
  }

  /** 删掉一个会话的视图；先挪进 staging 再删，读视图的人不会看到删到一半的目录。 */
  async function removeView(sessionId: string): Promise<boolean> {
    checkSessionId(sessionId);
    const target = viewDir(sessionId);
    if (!(await exists(target))) return false;
    await mkdir(staging, { recursive: true });
    const trash = join(staging, randomUUID());
    await rename(target, trash);
    await rm(trash, { recursive: true, force: true });
    return true;
  }

  function toView(sessionId: string, entries: readonly AssetManifestEntryWire[], missing: readonly string[]): SessionAssetView {
    const dir = viewDir(sessionId);
    const skillsDir = join(dir, 'skills');
    const instructionsDir = join(dir, 'instructions');
    return {
      sessionId,
      skillsDir,
      instructionsDir,
      assets: {
        root: dir,
        skillsDir,
        instructionsDir,
        skills: entries
          .filter((entry) => entry.kind === 'skill')
          .map((entry) => ({ name: entry.name, description: entry.description, path: join(skillsDir, slotOf(entry), 'SKILL.md') })),
        instructions: entries
          .filter((entry) => entry.kind === 'instruction')
          .map((entry) => ({ name: entry.name, path: join(instructionsDir, `${slotOf(entry)}.md`) }))
      },
      missing
    };
  }

  /** 所有视图引用到的 digest：版本目录的保留集合要算上它们（运行中的会话还挂着旧版本）。 */
  async function viewDigests(): Promise<string[]> {
    const names = await readdir(viewRoot).catch(() => [] as string[]);
    const digests: string[] = [];
    for (const name of names) {
      try {
        const parsed = JSON.parse(await readFile(join(viewRoot, name, '.view.json'), 'utf8')) as {
          entries?: { digest?: unknown }[];
        };
        for (const entry of parsed.entries ?? []) if (typeof entry.digest === 'string') digests.push(entry.digest);
      } catch {
        // 视图坏了：当作没有引用；下一次同步会重建它或按孤儿清掉。
      }
    }
    return digests;
  }

  async function runSync(
    entries: readonly AssetManifestEntryWire[],
    fetch: FetchBlobs,
    retain: readonly string[],
    sessions?: readonly SessionAssetRequest[]
  ) {
    validate(entries);
    await mkdir(root, { recursive: true });
    await rm(staging, { recursive: true, force: true });
    await ensureBlobs(entries, fetch);
    for (const entry of entries) await materialize(entry);
    for (const entry of entries) await replaceLink(linkPath(entry), versionPath(entry));

    // 每会话视图：按 hub 给的活跃会话列表重建；列表外的是孤儿（会话早没了 / Worker 崩溃留下的），清掉。
    // 旧 hub 不传 sessions = 不动视图（还能靠会话结束时的 dropSession / 下次同步收掉）。
    const views: Record<string, SessionAssetView> = {};
    if (sessions !== undefined) {
      const keep = new Set<string>();
      for (const request of sessions) {
        checkSessionId(request.sessionId);
        const resolved = await resolveRequest(request, entries);
        await writeView(request.sessionId, resolved.entries);
        keep.add(request.sessionId);
        views[request.sessionId] = toView(request.sessionId, resolved.entries, resolved.missing);
      }
      await prune(viewRoot, keep);
    }

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

    // 版本目录只保留「当前清单 ∪ retain ∪ 视图引用」里的 digest；其余旧版本清掉。
    const keepVersions = new Set([
      ...entries.map((e) => prefixOf(e.digest)),
      ...retain.map(prefixOf),
      // 视图还挂着的旧版本（会话钉住的版本）不能删，否则运行中的会话读到空目录。
      ...(await viewDigests()).map(prefixOf)
    ]);
    await prune(versions, keepVersions);

    await prune(blobs, new Set(entries.flatMap((entry) => entry.files.map((file) => file.sha256))));
    await writeAtomic(manifestPath, JSON.stringify({ entries }, null, 2));
    await rm(staging, { recursive: true, force: true });
    return { root, installed: Object.fromEntries(entries.map((entry) => [entry.assetId, entry.digest])), views };
  }

  return {
    root,
    sync(entries, fetch, retain = [], sessions?) {
      const run = queue.then(() => runSync(entries, fetch, retain, sessions));
      queue = run.catch(() => {});
      return run;
    },
    async current(only = new Set<string>(), digests?: Readonly<Record<string, string>>) {
      await queue;
      // 清单为空 = 一个都不给（#223）。历史上 `only` 缺省表示「全给」，那等于把
      // hub 的解析失败放大成「把机器上所有资产塞进会话」——现在一律按显式清单过滤。
      const listed = (await readManifest()).filter((entry) => only.has(entry.assetId));
      if (listed.length === 0) return undefined;
      // #226 E4c：清单带了精确 digest 就按它取版本（换钉后旧版本仍在 retain 里）；
      // 没带才回落到清单里当前那一版。
      const pinned = listed.map((entry) => {
        const digest = digests?.[entry.assetId];
        return digest === undefined ? entry : { ...entry, digest };
      });
      // 版本目录被清掉/磁盘丢了：不给路径，由 missing() 说给用户听（#225 M3）。
      const entries: AssetManifestEntryWire[] = [];
      for (const entry of pinned) if (await exists(versionPath(entry))) entries.push(entry);
      if (entries.length === 0) return undefined;
      const skills = entries
        .filter((entry) => entry.kind === 'skill')
        .map((entry) => ({ name: entry.name, description: entry.description, path: join(versionPath(entry), 'SKILL.md') }));
      const instructions = entries
        .filter((entry) => entry.kind === 'instruction')
        .map((entry) => ({ name: entry.name, path: versionPath(entry) }));
      return { root, skills, instructions };
    },
    async missing(only = new Set<string>(), digests?: Readonly<Record<string, string>>) {
      await queue;
      const entries = (await readManifest()).filter((entry) => only.has(entry.assetId));
      const gone: string[] = [];
      for (const entry of entries) {
        const digest = digests?.[entry.assetId];
        const probe = digest === undefined ? entry : { ...entry, digest };
        if (!(await exists(versionPath(probe)))) gone.push(entry.name);
      }
      return gone;
    },
    view(request) {
      // 与 sync 共用一条队列：同步在跑的时候建视图会读到半新半旧的清单。
      const run = queue.then(async () => {
        checkSessionId(request.sessionId);
        if (request.assetIds.length === 0) {
          await removeView(request.sessionId);
          return undefined;
        }
        const resolved = await resolveRequest(request);
        await writeView(request.sessionId, resolved.entries);
        return toView(request.sessionId, resolved.entries, resolved.missing);
      });
      queue = run.catch(() => {});
      return run;
    },
    dropSession(sessionId) {
      const run = queue.then(() => removeView(sessionId));
      queue = run.catch(() => {});
      return run;
    }
  };
}
