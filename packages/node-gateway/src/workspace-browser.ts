import { execFile } from 'node:child_process';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import fuzzysort from 'fuzzysort';
import type { BrowserEntry, ChangedFile, DirectoryPage, DomainError, FileChangeNotice, FileGitStatus, Result, WorkspaceBrowser } from '@agent-hub/domain';
import { FILES_LIMITS, invalid, isBrowsablePath, isCommitId, isSensitivePath, looksBinary, notFound, unavailable } from '@agent-hub/domain';

/**
 * WorkspaceBrowser 的本机实现（ADR 0025）：fs + git CLI + fuzzysort + chokidar。
 * Server 本机直接用；Worker 上包一层 RPC（worker-browser-rpc.ts）给 hub 用。
 * 边界两道：guard(root) 管「根在不在 WORKER_ROOTS 里」；realpath 管「相对路径有没有逃出根」。
 */
export interface BrowserOptions {
  /** 根不在允许范围里时返回给人看的错误；null = 放行。 */
  readonly guard?: (root: string) => Promise<string | null>;
  readonly debounceMs?: number;
  readonly gitTimeoutMs?: number;
}

const WALK_SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'target', 'coverage', '__pycache__', 'vendor']);
const WALK_LIMIT = 20_000;

class Fail extends Error {
  readonly error: DomainError;
  constructor(error: DomainError) {
    super(error.message);
    this.error = error;
  }
}
const fail = (error: DomainError): never => {
  throw new Fail(error);
};
async function attempt<T>(run: () => Promise<T>): Promise<Result<T, DomainError>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof Fail) return { ok: false, error: error.error };
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, error: notFound('文件或目录不存在') };
    return { ok: false, error: unavailable(error instanceof Error ? error.message : String(error)) };
  }
}

interface Git {
  (args: readonly string[], options?: { allowExit?: readonly number[]; input?: string }): Promise<string>;
}

export function createWorkspaceBrowser(options: BrowserOptions = {}): WorkspaceBrowser {
  const debounceMs = options.debounceMs ?? 300;
  const gitTimeoutMs = options.gitTimeoutMs ?? 10_000;
  const watchCounts = new Map<string, number>();

  async function rootOf(root: string): Promise<string> {
    if (root === '' || !root.startsWith('/')) fail(invalid('工作空间路径不合法'));
    const problem = await options.guard?.(root);
    if (problem) fail(invalid(problem));
    try {
      return await realpath(root);
    } catch {
      return fail(notFound('工作空间目录不存在'));
    }
  }

  /** rel → 根里面的真实路径；越界、碰 .git 一律 invalid。 */
  async function inside(real: string, rel: string): Promise<string> {
    if (!isBrowsablePath(rel)) fail(invalid('路径不合法'));
    const target = rel === '' ? real : join(real, rel);
    const resolved = await realpath(target);
    if (resolved !== real && !resolved.startsWith(real + sep)) fail(invalid('路径不在工作空间里'));
    if (resolved.slice(real.length).split(sep).includes('.git')) fail(invalid('路径不合法'));
    return resolved;
  }

  const gitIn = (cwd: string): Git => (args, opts = {}) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args],
        { cwd, timeout: gitTimeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } },
        (error, stdout) => {
          const exit = error && typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : error ? -1 : 0;
          if (error && !(opts.allowExit ?? []).includes(exit)) reject(error);
          else resolve(stdout);
        }
      );
      if (opts.input !== undefined) child.stdin?.end(opts.input);
    });

  async function isRepo(git: Git): Promise<boolean> {
    try {
      return (await git(['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
    } catch {
      return false;
    }
  }

  const STATUS: Record<string, FileGitStatus> = { M: 'modified', T: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'added', U: 'conflicted' };

  /** porcelain -z，路径相对 cwd（--relative 语义靠前缀自己剥）。 */
  async function statusMap(git: Git): Promise<Map<string, FileGitStatus>> {
    const prefix = (await git(['rev-parse', '--show-prefix'])).trim();
    const raw = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
    const map = new Map<string, FileGitStatus>();
    const parts = raw.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const item = parts[i]!;
      if (item.length < 4) continue;
      const x = item[0]!;
      const y = item[1]!;
      let path = item.slice(3);
      if (x === 'R' || x === 'C') i++; // 下一段是旧路径
      if (!path.startsWith(prefix)) continue;
      path = path.slice(prefix.length);
      const status: FileGitStatus = x === '?' ? 'untracked' : x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D') ? 'conflicted' : STATUS[x === ' ' ? y : x] ?? 'modified';
      map.set(path.replace(/\/$/, ''), status);
    }
    return map;
  }

  function rollUp(map: Map<string, FileGitStatus>, dir: string): FileGitStatus | null {
    const prefix = dir + '/';
    for (const [path, status] of map) if (path.startsWith(prefix)) return status === 'deleted' ? 'modified' : status === 'untracked' ? 'untracked' : 'modified';
    return null;
  }

  async function ignoredSet(git: Git, paths: readonly string[]): Promise<Set<string>> {
    if (paths.length === 0) return new Set();
    const out = await git(['check-ignore', '--stdin', '-z'], { allowExit: [1], input: paths.join('\0') + '\0' });
    return new Set(out.split('\0').filter(Boolean).map((p) => p.replace(/\/$/, '')));
  }

  async function walk(real: string): Promise<string[]> {
    const files: string[] = [];
    const queue = [''];
    while (queue.length > 0 && files.length < WALK_LIMIT) {
      const rel = queue.shift()!;
      const entries = await readdir(rel === '' ? real : join(real, rel), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (WALK_SKIP.has(entry.name)) continue;
        const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) queue.push(path);
        else if (entry.isFile()) files.push(path);
      }
    }
    return files;
  }

  async function baseRef(git: Git, base: string | null): Promise<string | null> {
    if (base !== null && !isCommitId(base)) fail(invalid('基准提交不合法'));
    const ref = base ?? 'HEAD';
    try {
      await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return ref;
    } catch {
      return null; // 还没有提交：全部算新增
    }
  }

  return {
    list: (root, path, { limit }) =>
      attempt(async (): Promise<DirectoryPage> => {
        const real = await rootOf(root);
        const dir = await inside(real, path);
        if (!(await stat(dir)).isDirectory()) fail(invalid('不是目录'));
        const dirents = (await readdir(dir, { withFileTypes: true })).filter((d) => d.name !== '.git');
        dirents.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        const truncated = dirents.length > limit;
        const kept = dirents.slice(0, limit);
        const git = gitIn(dir);
        const repo = await isRepo(git);
        const relOf = (name: string) => (path === '' ? name : `${path}/${name}`);
        const [ignored, statuses] = repo
          ? await Promise.all([ignoredSet(gitIn(real), kept.map((d) => relOf(d.name) + (d.isDirectory() ? '/' : ''))), statusMap(gitIn(real))]).catch(() => [new Set<string>(), new Map<string, FileGitStatus>()] as const)
          : [new Set<string>(), new Map<string, FileGitStatus>()];
        const entries: BrowserEntry[] = [];
        for (const d of kept) {
          const rel = relOf(d.name);
          const info = await lstat(join(dir, d.name)).catch(() => null);
          if (!info) continue;
          let type: BrowserEntry['type'] = info.isDirectory() ? 'dir' : info.isSymbolicLink() ? 'symlink' : 'file';
          if (type === 'symlink') {
            // 指向根里面的目录就当目录（展开时 inside() 会再把一次关）；指到外面的只显示不进入
            const target = await inside(real, rel).catch(() => null);
            if (target && (await stat(target).catch(() => null))?.isDirectory()) type = 'dir';
          }
          entries.push({
            name: d.name,
            path: rel,
            type,
            size: info.isFile() ? info.size : 0,
            modifiedAt: Math.floor(info.mtimeMs),
            ignored: ignored.has(rel),
            sensitive: type !== 'dir' && isSensitivePath(rel),
            git: statuses.get(rel) ?? (type === 'dir' ? rollUp(statuses, rel) : null)
          });
        }
        return { path, entries, truncated, isGit: repo };
      }),

    read: (root, path, maxBytes) =>
      attempt(async () => {
        const real = await rootOf(root);
        const file = await inside(real, path);
        const handle = await open(file, 'r');
        try {
          const info = await handle.stat();
          if (!info.isFile()) fail(invalid('不是文件'));
          const want = Math.min(info.size, maxBytes);
          const buffer = Buffer.alloc(want);
          let got = 0;
          while (got < want) {
            const { bytesRead } = await handle.read(buffer, got, want - got, got);
            if (bytesRead === 0) break;
            got += bytesRead;
          }
          const bytes = new Uint8Array(buffer.subarray(0, got));
          const binary = looksBinary(bytes);
          return { path, size: info.size, modifiedAt: Math.floor(info.mtimeMs), binary, truncated: info.size > got, bytes: binary ? new Uint8Array(0) : bytes };
        } finally {
          await handle.close();
        }
      }),

    find: (root, query, limit) =>
      attempt(async () => {
        const real = await rootOf(root);
        const git = gitIn(real);
        const files = (await isRepo(git))
          ? (await git(['ls-files', '-co', '--exclude-standard', '-z'])).split('\0').filter(Boolean).slice(0, WALK_LIMIT)
          : await walk(real);
        const q = query.trim();
        if (q === '') return files.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)).slice(0, limit);
        return fuzzysort.go(q, files, { limit, threshold: 0.2 }).map((hit) => hit.target);
      }),

    changes: (root, base) =>
      attempt(async (): Promise<ChangedFile[]> => {
        const real = await rootOf(root);
        const git = gitIn(real);
        if (!(await isRepo(git))) return [];
        const ref = await baseRef(git, base);
        const out: ChangedFile[] = [];
        if (ref !== null) {
          const names = (await git(['diff', '--relative', '--name-status', '-z', '-M', ref, '--', '.'])).split('\0');
          const nums = (await git(['diff', '--relative', '--numstat', '-z', '-M', ref, '--', '.'])).split('\0');
          const counts = new Map<string, [number, number]>();
          for (let i = 0; i < nums.length; i++) {
            const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(nums[i]!);
            if (!m) continue;
            let path = m[3]!;
            if (path === '') {
              i += 2; // 改名：旧路径、新路径各一段
              path = nums[i] ?? '';
            }
            counts.set(path, [m[1] === '-' ? 0 : Number(m[1]), m[2] === '-' ? 0 : Number(m[2])]);
          }
          for (let i = 0; i < names.length; i++) {
            const code = names[i]!;
            if (code === '') continue;
            const kind = code[0]!;
            if (kind === 'R' || kind === 'C') {
              const oldPath = names[++i]!;
              const path = names[++i]!;
              const [a, d] = counts.get(path) ?? [0, 0];
              out.push({ path, oldPath, status: kind === 'R' ? 'renamed' : 'added', additions: a, deletions: d });
            } else {
              const path = names[++i]!;
              const [a, d] = counts.get(path) ?? [0, 0];
              out.push({ path, status: STATUS[kind] ?? 'modified', additions: a, deletions: d });
            }
          }
        }
        const seen = new Set(out.map((f) => f.path));
        const untracked = (await git(['ls-files', '-o', '--exclude-standard', '-z', ...(ref === null ? ['-c'] : [])])).split('\0').filter((p) => p && !seen.has(p));
        for (const path of untracked) out.push({ path, status: ref === null ? 'added' : 'untracked', additions: 0, deletions: 0 });
        return out.sort((a, b) => a.path.localeCompare(b.path));
      }),

    diff: (root, path, base, maxBytes) =>
      attempt(async () => {
        const real = await rootOf(root);
        if (!isBrowsablePath(path) || path === '') fail(invalid('路径不合法'));
        await inside(real, path).catch((error: unknown) => {
          // 已删除的文件 realpath 不到：允许，diff 由 git 给
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
        const git = gitIn(real);
        if (!(await isRepo(git))) fail(invalid('不是 git 仓库，没有 diff'));
        const ref = await baseRef(git, base);
        let patch = ref === null ? '' : await git(['diff', '--relative', '-M', ref, '--', path]);
        if (patch === '') {
          const tracked = (await git(['ls-files', '-z', '--', path])).length > 0;
          if (!tracked || ref === null) patch = await git(['diff', '--no-index', '--', '/dev/null', path], { allowExit: [1] });
        }
        const binary = /^Binary files /m.test(patch);
        const truncated = Buffer.byteLength(patch) > maxBytes;
        return { path, patch: truncated ? Buffer.from(patch).subarray(0, maxBytes).toString('utf8') : patch, truncated, binary };
      }),

    head: (root) =>
      attempt(async () => {
        const real = await rootOf(root);
        const git = gitIn(real);
        if (!(await isRepo(git))) return null;
        try {
          return (await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim() || null;
        } catch {
          return null;
        }
      }),

    watch: (root, paths, onChange) =>
      attempt(async () => {
        const real = await rootOf(root);
        const used = watchCounts.get(real) ?? 0;
        const wanted = [...new Set(paths)];
        if (used + wanted.length > FILES_LIMITS.watchPoints) fail(invalid(`这个工作空间同时盯的目录太多了（上限 ${FILES_LIMITS.watchPoints}）`));
        const targets: string[] = [];
        for (const rel of wanted) {
          const abs = await inside(real, rel).catch(() => null);
          if (abs) targets.push(abs);
        }
        watchCounts.set(real, used + wanted.length);
        let pending = new Set<string>();
        let timer: NodeJS.Timeout | null = null;
        const flush = () => {
          timer = null;
          const changed = [...pending];
          pending = new Set();
          if (changed.length > 0) onChange({ paths: changed } satisfies FileChangeNotice);
        };
        const relOf = (abs: string) => (abs === real ? '' : abs.startsWith(real + sep) ? abs.slice(real.length + 1).split(sep).join('/') : null);
        const watcher: FSWatcher = chokidarWatch(targets, {
          depth: 0,
          ignoreInitial: true,
          followSymlinks: false,
          ignored: (p: string) => p.split(sep).includes('.git')
        });
        watcher.on('all', (_event, abs: string) => {
          const rel = relOf(abs);
          if (rel === null) return;
          pending.add(rel);
          const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
          pending.add(parent);
          if (!timer) timer = setTimeout(flush, debounceMs);
        });
        watcher.on('error', () => undefined);
        let closed = false;
        return () => {
          if (closed) return;
          closed = true;
          if (timer) clearTimeout(timer);
          watchCounts.set(real, Math.max(0, (watchCounts.get(real) ?? 0) - wanted.length));
          void watcher.close();
        };
      })
  };
}
