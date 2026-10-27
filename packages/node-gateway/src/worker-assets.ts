import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AssetManifestEntryWire } from '@agent-hub/contract';
import { checkAssetName, normalizeAssetPath, type SessionAssets } from '@agent-hub/domain';

/**
 * Worker 的专属资产目录（docs/design/asset-hub.md）。
 *
 * 只写 `root` 这一个目录：不碰 ~/.agents、~/.claude、~/.pi 之类的全局位置，卸载 = 删掉它。
 *
 *   root/.blobs/<sha256>        按内容寻址的缓存，升级只取变了的文件
 *   root/skills/<name>/…        一个技能一个目录（Agent Skills 标准）
 *   root/instructions/<name>.md 一条指令一个文件
 *   root/.manifest.json         当前落地的清单
 *
 * 每个条目先在 .staging 里拼好，再整体改名换上去：会话启动时读到的永远是完整的一版。
 * 同步串行执行。
 */
export interface WorkerAssets {
  readonly root: string;
  /** 让目录与清单一致；缺的内容用 fetch 按哈希取（每批 ≤ 200 个）。 */
  sync(entries: readonly AssetManifestEntryWire[], fetch: FetchBlobs): Promise<{ root: string; installed: Record<string, string> }>;
  /** 此刻装着的东西；什么都没装时返回 undefined（会话照旧启动，不加任何参数）。 */
  current(): Promise<SessionAssets | undefined>;
}

export type FetchBlobs = (hashes: readonly string[]) => Promise<readonly { sha256: string; data: string }[]>;

const BATCH = 200;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function defaultAssetsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env['WORKER_ASSETS_DIR'] || join(homedir(), '.agent-hub', 'assets'));
}

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

function validate(entries: readonly AssetManifestEntryWire[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = checkAssetName(entry.name);
    if (!name.ok) throw new Error(name.error.message);
    const key = `${entry.kind}:${entry.name}`;
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
  const manifestPath = join(root, '.manifest.json');
  let queue: Promise<unknown> = Promise.resolve();

  const target = (entry: Pick<AssetManifestEntryWire, 'kind' | 'name'>): string =>
    entry.kind === 'skill' ? join(root, 'skills', entry.name) : join(root, 'instructions', `${entry.name}.md`);

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

  /** 拼好一个条目再整体换上去。 */
  async function place(entry: AssetManifestEntryWire): Promise<void> {
    const destination = target(entry);
    await mkdir(dirname(destination), { recursive: true });
    if (entry.kind === 'instruction') {
      await writeAtomic(destination, await readFile(join(blobs, entry.files[0]!.sha256)));
      return;
    }
    const build = join(staging, randomUUID());
    for (const file of entry.files) {
      const path = join(build, file.path);
      if (!path.startsWith(build + '/')) throw new Error(`路径越界：${file.path}`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, await readFile(join(blobs, file.sha256)));
    }
    const old = join(staging, randomUUID());
    if (await exists(destination)) await rename(destination, old);
    await rename(build, destination);
    await rm(old, { recursive: true, force: true });
  }

  /** 目录是 hub 专属的：清单外的东西一律清掉。 */
  async function prune(dir: string, keep: ReadonlySet<string>): Promise<void> {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) if (!keep.has(name)) await rm(join(dir, name), { recursive: true, force: true });
  }

  async function runSync(entries: readonly AssetManifestEntryWire[], fetch: FetchBlobs) {
    validate(entries);
    await mkdir(root, { recursive: true });
    await rm(staging, { recursive: true, force: true });
    await ensureBlobs(entries, fetch);
    const before = new Map((await readManifest()).map((entry) => [`${entry.kind}:${entry.name}`, entry.digest]));
    for (const entry of entries) {
      const same = before.get(`${entry.kind}:${entry.name}`) === entry.digest && (await exists(target(entry)));
      if (!same) await place(entry);
    }
    await prune(join(root, 'skills'), new Set(entries.filter((e) => e.kind === 'skill').map((e) => e.name)));
    await prune(join(root, 'instructions'), new Set(entries.filter((e) => e.kind === 'instruction').map((e) => `${e.name}.md`)));
    await prune(blobs, new Set(entries.flatMap((entry) => entry.files.map((file) => file.sha256))));
    await writeAtomic(manifestPath, JSON.stringify({ entries }, null, 2));
    await rm(staging, { recursive: true, force: true });
    return { root, installed: Object.fromEntries(entries.map((entry) => [entry.assetId, entry.digest])) };
  }

  return {
    root,
    sync(entries, fetch) {
      const run = queue.then(() => runSync(entries, fetch));
      queue = run.catch(() => {});
      return run;
    },
    async current() {
      await queue;
      const entries = await readManifest();
      if (entries.length === 0) return undefined;
      const skills = entries
        .filter((entry) => entry.kind === 'skill')
        .map((entry) => ({ name: entry.name, description: entry.description, path: join(target(entry), 'SKILL.md') }));
      const instructions = entries
        .filter((entry) => entry.kind === 'instruction')
        .map((entry) => ({ name: entry.name, path: target(entry) }));
      return { root, skillsDir: skills.length > 0 ? join(root, 'skills') : null, skills, instructions };
    }
  };
}
