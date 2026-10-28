import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, posix } from 'node:path';
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

export function createAssetReader(options: AssetReaderOptions = {}): AssetReader {
  const timeout = options.gitTimeoutMs ?? 60_000;
  const gitBin = options.git ?? 'git';

  /** 不交互、不跑钩子、不拉 LFS、不认本地 / ext 协议（只许远端仓库）。 */
  const git = (cwd: string, args: string[]): Promise<Result<string, DomainError>> =>
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
        {
          cwd,
          timeout,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_ASKPASS: 'echo', SSH_ASKPASS: 'echo' }
        },
        (error, stdout, stderr) => {
          if (!error) return resolve(ok(stdout.trim()));
          const why = (error as { killed?: boolean }).killed ? '超时' : String(stderr).trim().split('\n').slice(-1)[0] || error.message;
          resolve(err(unavailable(`git 失败：${why}`)));
        }
      );
    });

  /** 浅取一个 ref（分支 / 标签 / 提交；null = 远端默认分支）到临时目录。调用方负责删。 */
  async function checkout(url: string, ref: string | null): Promise<Result<{ dir: string; commit: string }, DomainError>> {
    if (ref !== null && (ref.startsWith('-') || /\s/.test(ref))) return err(invalid('ref 不合法'));
    const dir = await mkdtemp(join(tmpdir(), 'hub-asset-git-'));
    const steps: string[][] = [
      ['init', '-q'],
      ['remote', 'add', 'origin', url],
      ['fetch', '-q', '--depth', '1', '--no-tags', 'origin', ref ?? 'HEAD'],
      ['checkout', '-q', '--detach', 'FETCH_HEAD']
    ];
    for (const step of steps) {
      const done = await git(dir, step);
      if (!done.ok) {
        await rm(dir, { recursive: true, force: true });
        return done;
      }
    }
    const commit = await git(dir, ['rev-parse', 'HEAD']);
    if (!commit.ok) {
      await rm(dir, { recursive: true, force: true });
      return commit;
    }
    return ok({ dir, commit: commit.value });
  }

  /** 走一棵目录：只收普通文件；符号链接（Dirent 不是 file / dir）一律跳过，防止指到仓库外。 */
  async function collect(root: string, rel = ''): Promise<Result<IncomingFile[], DomainError>> {
    const out: IncomingFile[] = [];
    const walk = async (relDir: string): Promise<DomainError | null> => {
      for (const entry of await readdir(join(root, relDir), { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
        if (entry.isDirectory()) {
          const failed = await walk(relPath);
          if (failed) return failed;
        } else if (entry.isFile()) {
          if (out.length >= ASSET_LIMITS.maxFiles) return invalid(`文件太多，上限 ${ASSET_LIMITS.maxFiles}`);
          const full = join(root, relPath);
          const info = await lstat(full);
          if (info.size > ASSET_LIMITS.maxFileBytes) return invalid(`文件太大：${relPath}`);
          out.push({ path: relPath, data: new Uint8Array(await readFile(full)) });
        }
      }
      return null;
    };
    const failed = await walk(rel);
    return failed ? err(failed) : ok(out);
  }

  async function candidates(root: string): Promise<GitCandidate[]> {
    const found: GitCandidate[] = [];
    const walk = async (relDir: string, depth: number): Promise<void> => {
      if (depth > 6 || found.length >= 200) return;
      const entries = await readdir(join(root, relDir), { withFileTypes: true });
      for (const entry of entries) {
        const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) await walk(relPath, depth + 1);
        else if (entry.isFile() && entry.name === 'SKILL.md') {
          const meta = parseSkillFrontmatter(await readFile(join(root, relPath), 'utf8'));
          const name = meta.ok && meta.value.name ? meta.value.name : basename(relDir || 'skill');
          found.push({ kind: 'skill', path: relDir, name, description: meta.ok ? meta.value.description : '' });
        } else if (entry.isFile() && /^(mcp|.+\.mcp)\.json$/i.test(entry.name)) {
          let name = slug(entry.name.replace(/\.json$/i, '').replace(/\.mcp$/i, '') || 'mcp');
          let description = '';
          try {
            const parsed = JSON.parse(await readFile(join(root, relPath), 'utf8')) as { name?: unknown; description?: unknown };
            if (typeof parsed.name === 'string') name = parsed.name;
            if (typeof parsed.description === 'string') description = parsed.description;
          } catch {
            // 坏 JSON 也列出来：导入时会给出清楚的错误
          }
          found.push({ kind: 'mcp', path: relPath, name, description });
        } else if (entry.isFile() && INSTRUCTION_FILES.test(entry.name)) {
          const text = await readFile(join(root, relPath), 'utf8');
          const stem = /^(AGENTS|CLAUDE|GEMINI)\.md$/i.test(entry.name) ? (relDir ? basename(relDir) : entry.name) : entry.name.replace(/\.instructions\.md$/i, '');
          found.push({ kind: 'instruction', path: relPath, name: slug(stem), description: instructionSummary(text) });
        }
      }
    };
    await walk('', 0);
    return found.sort((a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path));
  }

  const cleanPath = (path: string): Result<string, DomainError> => {
    const trimmed = path.replace(/^\/+|\/+$/g, '');
    const normal = posix.normalize(trimmed === '' ? '.' : trimmed);
    if (normal.startsWith('..') || normal.includes('\\')) return err(invalid('仓库里的路径不合法'));
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
        return ok({ commit: got.value.commit, candidates: await candidates(got.value.dir) });
      } finally {
        await rm(got.value.dir, { recursive: true, force: true });
      }
    },

    async readGit(url, ref, path, kind) {
      const rel = cleanPath(path);
      if (!rel.ok) return rel;
      const got = await checkout(url, ref);
      if (!got.ok) return got;
      try {
        const target = join(got.value.dir, rel.value);
        const info = await lstat(target).catch(() => null);
        if (kind === 'instruction' || kind === 'mcp') {
          if (!info?.isFile()) return err(invalid(`仓库里没有这个文件：${rel.value || '(根)'}`));
          if (info.size > ASSET_LIMITS.maxFileBytes) return err(invalid('文件太大'));
          const data = new Uint8Array(await readFile(target));
          // MCP 资产在 hub 里统一叫 mcp.json（仓库里可以叫 xxx.mcp.json）
          return ok({ commit: got.value.commit, files: [{ path: kind === 'mcp' ? 'mcp.json' : basename(rel.value), data }] });
        }
        if (!info?.isDirectory()) return err(invalid(`仓库里没有这个目录：${rel.value || '(根)'}`));
        const files = await collect(target);
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

