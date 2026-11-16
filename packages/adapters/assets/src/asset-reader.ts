import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { parse as parseYaml } from 'yaml';
import {
  ASSET_LIMITS,
  err,
  invalid,
  ok,
  unavailable,
  type AssetKind,
  type AssetMetadata,
  type AssetReader,
  type DomainError,
  type GitCandidate,
  type IncomingFile,
  type Result
} from '@agent-hub/domain';

export interface AssetReaderOptions {
  /** 单次 git 操作的上限（默认 60s）。 */
  readonly gitTimeoutMs?: number;
  readonly git?: string;
  /** 只给测试：允许 file:// 本地仓库。生产里只认远端仓库。 */
  readonly allowLocalRepos?: boolean;
}

const FRONTMATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** SKILL.md 开头的 YAML frontmatter：name / description（Agent Skills 标准）。 */
export function parseSkillFrontmatter(text: string): Result<{ name: string | null; description: string }, DomainError> {
  const match = FRONTMATTER.exec(text);
  if (!match) return err(invalid('SKILL.md 开头要有 --- 包起来的 frontmatter（name、description）'));
  let data: unknown;
  try {
    data = parseYaml(match[1] ?? '');
  } catch (error) {
    return err(invalid(`SKILL.md 的 frontmatter 不是合法 YAML：${(error as Error).message.split('\n')[0]}`));
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return err(invalid('SKILL.md 的 frontmatter 应是键值对'));
  const record = data as Record<string, unknown>;
  if (record['name'] !== undefined && record['name'] !== null && typeof record['name'] !== 'string') {
    return err(invalid('SKILL.md 的 frontmatter 里 name 必须是一行文字'));
  }
  if (record['description'] !== undefined && record['description'] !== null && typeof record['description'] !== 'string') {
    return err(invalid('SKILL.md 的 frontmatter 里 description 必须是文字'));
  }
  const name = typeof record['name'] === 'string' ? record['name'].trim() : null;
  const description = typeof record['description'] === 'string' ? record['description'].trim() : '';
  return ok({ name, description });
}

/** 指令的简介：第一行非空文字（去掉 markdown 标题符号）。 */
function instructionSummary(text: string): string {
  const body = text.replace(FRONTMATTER, '');
  const line = body.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find((l) => l !== '') ?? '';
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

const slug = (raw: string): string =>
  raw.toLowerCase().replace(/\.md$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '') || 'instruction';

const INSTRUCTION_FILES = /^(AGENTS|CLAUDE|GEMINI)\.md$|\.instructions\.md$/i;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.github']);

/** `target` 是否在 `root` 之内（两者都应是 realpath）。用 relative 判断，避免 `/a/bc` 被当成 `/a/b` 的子目录。 */
export function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** 解析真实路径并确认仍在 root 内；不存在 / 越界都返回 null。 */
async function realInside(root: string, candidate: string): Promise<string | null> {
  try {
    const real = await realpath(candidate);
    return isPathInside(root, real) ? real : null;
  } catch {
    return null;
  }
}

/** 日志里抹掉 `user:token@`；错误信息不回显原始 stderr（#224）。 */
export function redactGitStderr(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1***@');
}

/** 把 git 的 stderr 归成给调用者看的分类，不回显原始内容。 */
export function classifyGitFailure(stderr: string): '认证失败' | '主机不可达' | '分支不存在' | '其它' {
  const text = stderr.toLowerCase();
  if (
    /authentication failed|could not read (username|password)|invalid username or password|terminal prompts disabled|permission denied \(publickey\)|host key verification failed/.test(
      text
    )
  ) {
    return '认证失败';
  }
  if (/could not resolve host|connection (timed out|refused|reset)|network is unreachable|failed to connect|ssh: connect to host/.test(text)) {
    return '主机不可达';
  }
  if (/couldn't find remote ref|remote branch .* not found|not our ref|reference is not a tree/.test(text)) return '分支不存在';
  return '其它';
}

export function createAssetReader(options: AssetReaderOptions = {}): AssetReader {
  const timeout = options.gitTimeoutMs ?? 60_000;
  const gitBin = options.git ?? 'git';

  /**
   * 不交互、不跑钩子、不拉 LFS、不认本地 / ext 协议、不跟随 HTTP 重定向（只许远端仓库）。
   * `env` 由调用方给：干净环境（借用 HOME / SSH agent / 代理都是 #224 的攻击面）。
   */
  const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<Result<string, DomainError>> =>
    new Promise((resolve) => {
      execFile(
        gitBin,
        [
          '-c', 'core.hooksPath=/dev/null',
          '-c', `protocol.file.allow=${options.allowLocalRepos ? 'always' : 'never'}`,
          '-c', 'protocol.ext.allow=never',
          '-c', 'advice.detachedHead=false',
          ...args
        ],
        { cwd, timeout, maxBuffer: 4 * 1024 * 1024, env },
        (error, stdout, stderr) => {
          if (!error) return resolve(ok(stdout.trim()));
          const raw = String(stderr);
          // 原始 stderr 只进服务端日志，且先抹掉 user:token@；调用者只看到分类。
          console.warn(`[assets] git 失败：${redactGitStderr(raw.trim().split('\n').slice(-5).join(' | ') || error.message)}`);
          const kind = (error as { killed?: boolean }).killed ? '主机不可达' : classifyGitFailure(raw);
          resolve(err(unavailable(`克隆失败（${kind}）`)));
        }
      );
    });

  /**
   * git 只拿到最小环境：PATH / locale + 固定的 git 配置。
   * 不透传 SSH_AUTH_SOCK（不借用调用者的 ssh agent）、GIT_ASKPASS、代理（HTTP_PROXY / HTTPS_PROXY）；
   * HOME 指向一次导入内的临时空目录，结束就删，避免读到用户的 ~/.gitconfig / 凭据。
   */
  const gitEnv = (home: string): NodeJS.ProcessEnv => ({
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env['LANG'] ?? 'C',
    LC_ALL: process.env['LC_ALL'] ?? 'C',
    HOME: home,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    // 不跟随 HTTP 重定向（防公网地址 302 到内网），见文件头的 DNS 边界说明。
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.followRedirects',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
    GIT_LFS_SKIP_SMUDGE: '1'
  });

  /**
   * 浅取一个 ref（分支 / 标签 / 提交；null = 远端默认分支）到临时目录。调用方负责删。
   * 只关心仓库的一小部分时（`sparse` 给了目录）走稀疏检出：`--filter=blob:none` 先不拉文件内容，
   * 配合 `sparse-checkout` 只取需要的目录，导入大仓库时不必把整棵树拉下来。
   */
  async function checkout(url: string, ref: string | null, sparse: string | null = null): Promise<Result<{ dir: string; commit: string }, DomainError>> {
    if (ref !== null && (ref.startsWith('-') || /\s/.test(ref))) return err(invalid('ref 不合法'));
    // HOME 用一次性的空目录：不读用户配置，也不给 git 留凭据；导入结束随 checkout 一起删。
    const home = await mkdtemp(join(tmpdir(), 'hub-asset-home-'));
    const env = gitEnv(home);
    let dir: string | null = null;
    try {
      dir = await mkdtemp(join(tmpdir(), 'hub-asset-git-'));
      const steps: string[][] = [
        ['init', '-q'],
        ['remote', 'add', 'origin', url],
        ['fetch', '-q', '--depth', '1', '--no-tags', '--filter=blob:none', 'origin', ref ?? 'HEAD']
      ];
      if (sparse !== null && sparse !== '') {
        // cone 模式只认目录：检出的入口是文件时由调用方传它所在的目录（根目录不稀疏）。
        steps.push(['sparse-checkout', 'init', '--cone']);
        steps.push(['sparse-checkout', 'set', sparse]);
      }
      steps.push(['checkout', '-q', '--detach', 'FETCH_HEAD']);
      for (const step of steps) {
        const done = await git(dir, step, env);
        if (!done.ok) {
          await rm(dir, { recursive: true, force: true });
          dir = null;
          return done;
        }
      }
      const commit = await git(dir, ['rev-parse', 'HEAD'], env);
      if (!commit.ok) {
        await rm(dir, { recursive: true, force: true });
        dir = null;
        return commit;
      }
      return ok({ dir, commit: commit.value });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  /**
   * 走一棵目录：只收普通文件。符号链接条目（Dirent 既不是 file 也不是 dir）照旧跳过；
   * 每个目录再按真实路径确认仍在 `rootReal`（检出目录）之内 —— 中间目录是符号链接时，
   * `lstat` 会照样返回目录，只看 Dirent 拦不住（#222）。越界目录跳过并记日志，不中断整个导入。
   */
  async function collect(start: string, rootReal: string): Promise<Result<IncomingFile[], DomainError>> {
    const out: IncomingFile[] = [];
    let total = 0;
    const walk = async (relDir: string): Promise<DomainError | null> => {
      const realDir = await realInside(rootReal, relDir === '' ? start : join(start, relDir));
      if (realDir === null) {
        console.warn(`[assets] 跳过越界的目录：${relDir === '' ? '.' : relDir}`);
        return null;
      }
      for (const entry of await readdir(realDir, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
        if (entry.isDirectory()) {
          const failed = await walk(relPath);
          if (failed) return failed;
        } else if (entry.isFile()) {
          if (out.length >= ASSET_LIMITS.maxFiles) return invalid(`文件太多，上限 ${ASSET_LIMITS.maxFiles}`);
          // 读之前再按真实路径校验一次。单机导入场景里校验与读取之间的 TOCTOU 可以接受：
          // 检出目录是本次导入独占的临时目录，攻击者要在窗口内换掉链接需要写权限。
          const realFile = await realInside(rootReal, join(realDir, entry.name));
          if (realFile === null) {
            console.warn(`[assets] 跳过越界的文件：${relPath}`);
            continue;
          }
          const info = await lstat(realFile);
          if (info.size > ASSET_LIMITS.maxFileBytes) return invalid(`文件太大：${relPath}（单个文件上限 1 MB）`);
          // 先按 stat 大小判断总量，避免把明显超限的文件读进内存；读完再按实际字节累加一次。
          if (total + info.size > ASSET_LIMITS.maxTotalBytes) return invalid(`文件总大小超过 4 MB：累计到 ${relPath} 时超限`);
          const data = new Uint8Array(await readFile(realFile));
          total += data.byteLength;
          if (total > ASSET_LIMITS.maxTotalBytes) return invalid(`文件总大小超过 4 MB：累计到 ${relPath} 时超限`);
          out.push({ path: relPath, data });
        }
      }
      return null;
    };
    const failed = await walk('');
    return failed ? err(failed) : ok(out);
  }

  /**
   * 扫描候选时只读小文本文件：先看 stat 大小，超过单文件上限（1 MB）的不读进来。
   * 读不到的返回 null —— 候选照常列出来（导入时会给出清楚的错误），只是没有描述。
   */
  async function readSmallText(file: string): Promise<string | null> {
    const info = await lstat(file).catch(() => null);
    if (info === null || !info.isFile() || info.size > ASSET_LIMITS.maxFileBytes) return null;
    return readFile(file, 'utf8');
  }

  async function candidates(root: string, rootReal: string): Promise<GitCandidate[]> {
    const found: GitCandidate[] = [];
    const walk = async (relDir: string, depth: number): Promise<void> => {
      if (depth > 6 || found.length >= 200) return;
      const realDir = await realInside(rootReal, relDir === '' ? root : join(root, relDir));
      if (realDir === null) {
        console.warn(`[assets] 扫描时跳过越界的目录：${relDir === '' ? '.' : relDir}`);
        return;
      }
      const entries = await readdir(realDir, { withFileTypes: true });
      for (const entry of entries) {
        const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) await walk(relPath, depth + 1);
        else if (entry.isFile() && entry.name === 'SKILL.md') {
          const text = await readSmallText(join(realDir, entry.name));
          const meta = text === null ? null : parseSkillFrontmatter(text);
          const name = meta?.ok && meta.value.name ? meta.value.name : basename(relDir || 'skill');
          found.push({ kind: 'skill', path: relDir, name, description: meta?.ok ? meta.value.description : '' });
        } else if (entry.isFile() && /^(mcp|.+\.mcp)\.json$/i.test(entry.name)) {
          let name = slug(entry.name.replace(/\.json$/i, '').replace(/\.mcp$/i, '') || 'mcp');
          let description = '';
          const text = await readSmallText(join(realDir, entry.name));
          if (text !== null) {
            try {
              const parsed = JSON.parse(text) as { name?: unknown; description?: unknown };
              if (typeof parsed.name === 'string') name = parsed.name;
              if (typeof parsed.description === 'string') description = parsed.description;
            } catch {
              // 坏 JSON 也列出来：导入时会给出清楚的错误
            }
          }
          found.push({ kind: 'mcp', path: relPath, name, description });
        } else if (entry.isFile() && INSTRUCTION_FILES.test(entry.name)) {
          const text = (await readSmallText(join(realDir, entry.name))) ?? '';
          const stem = /^(AGENTS|CLAUDE|GEMINI)\.md$/i.test(entry.name) ? (relDir ? basename(relDir) : entry.name) : entry.name.replace(/\.instructions\.md$/i, '');
          found.push({ kind: 'instruction', path: relPath, name: slug(stem), description: instructionSummary(text) });
        }
      }
    };
    await walk('', 0);
    return found.sort((a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path));
  }

  /** 仓库内相对路径：拒绝空路径、绝对路径、反斜杠 / 空字符、以及任何 `..` 段（#222 的第一层保险）。 */
  const cleanPath = (path: string): Result<string, DomainError> => {
    if (path === '' || path.trim() === '') return err(invalid('仓库里的路径不合法'));
    if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return err(invalid('仓库里的路径不合法'));
    const trimmed = path.replace(/^\/+|\/+$/g, '');
    const normal = posix.normalize(trimmed);
    if (normal === '' || normal === '..' || normal.startsWith('../') || normal.split('/').includes('..')) {
      return err(invalid('仓库里的路径不合法'));
    }
    // `.` 是显式的「仓库根」，保留；空串、绝对路径、`..` 段一律拒绝。
    return ok(normal === '.' ? '' : normal);
  };

  return {
    describe(kind: AssetKind, files: readonly IncomingFile[]): Result<AssetMetadata, DomainError> {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const text = (data: Uint8Array): string | null => {
        try {
          return decoder.decode(data);
        } catch {
          return null;
        }
      };
      if (kind === 'skill') {
        const main = files.find((file) => file.path.replace(/^\.\//, '') === 'SKILL.md');
        if (!main) return err(invalid('技能目录的根上必须有 SKILL.md'));
        const body = text(main.data);
        if (body === null) return err(invalid('SKILL.md 不是 UTF-8 文本'));
        return parseSkillFrontmatter(body);
      }
      const only = files[0];
      if (kind === 'mcp') return ok({ name: null, description: '' }); // 名字和说明由领域层解析 mcp.json 得出
      const body = only ? text(only.data) : '';
      if (body === null) return err(invalid('指令文件不是 UTF-8 文本'));
      return ok({ name: null, description: instructionSummary(body) });
    },

    async scanGit(url, ref) {
      const got = await checkout(url, ref);
      if (!got.ok) return got;
      try {
        const rootReal = await realpath(got.value.dir).catch(() => null);
        if (rootReal === null) return err(unavailable('检出目录不存在'));
        return ok({ commit: got.value.commit, candidates: await candidates(rootReal, rootReal) });
      } finally {
        await rm(got.value.dir, { recursive: true, force: true });
      }
    },

    async readGit(url, ref, path, kind) {
      const rel = cleanPath(path);
      if (!rel.ok) return rel;
      // 稀疏检出：skill 只要那个目录；instruction / mcp 只要所在目录（根上的文件不稀疏）。
      // 目标就在仓库根时不做稀疏，否则会连根上的入口文件都拿不到。
      const sparse =
        kind === 'skill' ? (rel.value === '' ? null : rel.value) : rel.value === '' ? null : posix.dirname(rel.value) === '.' ? null : posix.dirname(rel.value);
      const got = await checkout(url, ref, sparse);
      if (!got.ok) return got;
      try {
        // 检出目录也取真实路径：mkdtemp 在 /tmp 是符号链接的系统上仍能正确做前缀判断。
        const rootReal = await realpath(got.value.dir).catch(() => null);
        if (rootReal === null) return err(unavailable('检出目录不存在'));
        // 目标路径必须是 realpath 之后仍在检出目录内的（中间目录是符号链接也算越界）。
        const realTarget = await realInside(rootReal, resolve(rootReal, rel.value));
        if (kind === 'instruction' || kind === 'mcp') {
          const info = realTarget === null ? null : await lstat(realTarget).catch(() => null);
          if (realTarget === null || !info?.isFile()) return err(invalid(`仓库里没有这个文件：${rel.value || '(根)'}`));
          if (info.size > ASSET_LIMITS.maxFileBytes) return err(invalid('文件太大'));
          const data = new Uint8Array(await readFile(realTarget));
          // MCP 资产在 hub 里统一叫 mcp.json（仓库里可以叫 xxx.mcp.json）
          return ok({ commit: got.value.commit, files: [{ path: kind === 'mcp' ? 'mcp.json' : basename(rel.value), data }] });
        }
        const info = realTarget === null ? null : await lstat(realTarget).catch(() => null);
        if (realTarget === null || !info?.isDirectory()) return err(invalid(`仓库里没有这个目录：${rel.value || '(根)'}`));
        const files = await collect(realTarget, rootReal);
        if (!files.ok) return files;
        return ok({ commit: got.value.commit, files: files.value });
      } finally {
        await rm(got.value.dir, { recursive: true, force: true });
      }
    },

    diffText(path, before, after) {
      return createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, '', '', { context: 3 });
    }
  };
}

