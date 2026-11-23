/**
 * Worker 侧的本地 bundle 导入：把 hub 传来的自包含 Git bundle 解到项目仓库里，
 * 只创建一个专用 ref（`refs/agent-hub/fetch/<id>/<tipSha>`），不动 HEAD / 分支 / index / 工作区。
 *
 * 约束（失败关闭）：
 * - 必须显式提供工作区目录授权回调；没有默认放行。
 * - 只接受本地 bundle 字节；不联网、不带凭据，也不读机器 / 用户 / 仓库配置里的 URL 改写与 hook。
 * - bundle 必须自包含且只声明一个分支 tip：先在一个空的临时 bare 仓库里 verify + 还原 tip，
 *   确认 bundle 里的对象齐全，再碰目标仓库。
 * - 目标 ref 只允许创建；已存在同 tip 视为幂等，指向别的提交一律 conflict，不 force。
 * - 目标 ref 是符号引用时拒绝写，绝不顺着符号目标改到普通分支。
 * - 只接受普通主工作区：`.git` 必须是目录，git-dir 与 common-dir 必须一致；linked worktree /
 *   `.git` 文件 / separated git dir 一律失败关闭。
 * - 目标仓库出现 `objects/info/alternates`、symlink 对象目录、shallow 或 partial/promisor
 *   配置时拒绝导入，避免隐藏对象来源。
 *
 * 已知边界：
 * - bundle 字节上限只间接限制解包后的对象大小；`scratchRoot` 只选择临时目录父目录，
 *   本模块不读取 statfs、不验证也不施加配额；磁盘配额由调用方用挂载/cgroup 等负责。
 * - realpath 校验之后路径仍可能被替换（TOCTOU），本模块不承诺抵抗能改文件系统的本地攻击者。
 * - 只支持 SHA-1（tipSha 为 40 位）仓库；SHA-256 仓库会在这里失败关闭。
 * - 只创建 ref，不 checkout、不更新 remote-tracking ref。
 * - 屏蔽 global/system 配置也意味着不读 `safe.directory`：跨用户拥有的仓库会按 git 的
 *   dubious ownership 拒绝，调用方需保证 Worker 用户拥有目标工作区。
 * - 本模块不提供 UID 隔离或磁盘配额：同 UID 进程仍可读写工作区/临时目录并耗尽存储；
 *   部署方需要配额、独立用户/沙箱与临时目录保护。
 * - 错误信息不包含 git stderr 或异常字符串；排查时由调用方在受控日志里补充上下文。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { DomainError, Result } from '@agent-hub/domain';
import { conflict, invalid, unavailable } from '@agent-hub/domain';
import { authScopeUrl } from './git-workspace.ts';

/** 专用命名空间；不是普通分支，也不是 remote-tracking ref。 */
export const BUNDLE_REF_PREFIX = 'refs/agent-hub/fetch/';
/** 默认 bundle 上限（编码前的字节数）。 */
export const DEFAULT_MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
/** 构造函数可配置的上限硬顶，防止调用方无意中放宽到无界。 */
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

const REF_PATTERN = /^refs\/agent-hub\/fetch\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([0-9a-f]{40})$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ZERO_SHA1 = '0000000000000000000000000000000000000000';

const SAFE_GIT_CONFIG = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.logAllRefUpdates=false',
  'gc.auto=0',
  'maintenance.auto=false',
  'fetch.writeCommitGraph=false',
  'credential.helper=',
  'credential.interactive=false',
  'protocol.allow=never',
  'protocol.file.allow=always'
] as const;

const ENV_PASSTHROUGH = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR'] as const;

const FETCH_BUNDLE_ARGS = [
  'fetch',
  '--no-tags',
  '--no-prune',
  '--no-recurse-submodules',
  '--no-write-fetch-head',
  '--refmap=',
  '--no-auto-gc'
] as const;

export interface ProjectGitBundleImportInput {
  /** 目标仓库根目录（绝对路径）。 */
  readonly path: string;
  /** 项目登记的 origin 地址；HTTPS 按 authScopeUrl 规范化后比较。 */
  readonly expectedUrl: string;
  /** 自包含 bundle 的规范 base64。 */
  readonly bundleBase64: string;
  /** 小写 hex 的 SHA-256。 */
  readonly bundleSha256: string;
  /** bundle 里要导入的 commit，小写 hex SHA-1。 */
  readonly tipSha: string;
  /** 必须正好是 `refs/agent-hub/fetch/<id>/<tipSha>`。 */
  readonly ref: string;
}

export interface ProjectGitBundleImportOutcome {
  readonly ref: string;
  readonly tipSha: string;
  /** true = 目标 ref 本来就指向同一个 commit，本次没有新建。 */
  readonly alreadyPresent: boolean;
}

export interface ProjectGitBundleImportOptions {
  /**
   * 仅测试用：允许 origin / expectedUrl 是本地路径（真实 bare 仓库测试）。
   * 生产 Worker 不设置；HTTPS 之外一律失败关闭。
   */
  readonly allowLocalOrigin?: boolean;
  /** 覆盖默认的 bundle 字节上限，最大 64 MiB。 */
  readonly maxBundleBytes?: number;
  /** 单条 git 命令的超时；bundle 相关命令至少给 120 秒。 */
  readonly timeoutMs?: number;
  /**
   * 可选：显式指定临时校验目录的父目录。必须由调用方预先创建，且是绝对、真实、
   * 可读写的普通目录；校验失败会直接拒绝导入，绝不回退到系统 tmpdir。
   * 省略时使用 os.tmpdir()。本模块不会创建或修改该父目录本身。
   */
  readonly scratchRoot?: string;
}

/** 目录边界：返回 null = 允许，否则是给人看的原因。 */
export type ProjectGitBundleWorkdirCheck = (path: string) => Promise<string | null>;

export interface ProjectGitBundleImporter {
  importBundle(input: ProjectGitBundleImportInput): Promise<Result<ProjectGitBundleImportOutcome, DomainError>>;
}

interface ValidatedInput {
  readonly path: string;
  readonly expectedUrl: string;
  readonly bundle: Buffer;
  readonly tipSha: string;
  readonly ref: string;
}

interface GitRun {
  readonly code: number;
  readonly stdout: string;
}

interface IndexStat {
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface WorktreeSnapshot {
  readonly headRef: string | null;
  readonly headSha: string | null;
  readonly index: IndexStat | null;
}

interface RefState {
  readonly symbolic: boolean;
  readonly sha: string | null;
}

interface BundleHead {
  readonly sha: string;
  readonly ref: string;
}

/**
 * `path` 是该机器的目录边界回调：hub 本机可全放行，Worker 传 WORKER_ROOTS 的 realpath 检查。
 * 必须显式传入；省略或传入非函数会在构造时抛错（失败关闭），不存在默认放行。
 * 回调抛错按失败关闭处理。
 */
export function createProjectGitBundleImporter(
  check: ProjectGitBundleWorkdirCheck,
  options: ProjectGitBundleImportOptions = {}
): ProjectGitBundleImporter {
  if (typeof check !== 'function') {
    throw new TypeError('必须提供工作区目录授权回调');
  }
  const maxBundleBytes = normalizeMaxBundleBytes(options.maxBundleBytes);
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const bundleTimeoutMs = Math.max(timeoutMs, 120_000);
  const allowLocalOrigin = options.allowLocalOrigin === true;
  const scratchRootOption = options.scratchRoot;
  const env = gitEnv();

  const guard = async (path: string): Promise<DomainError | null> => {
    if (typeof path !== 'string' || !isAbsolute(path) || CONTROL_CHARACTERS.test(path)) {
      return invalid('工作区目录必须是合法的绝对路径');
    }
    let reason: string | null;
    try {
      reason = await check(path);
    } catch {
      return unavailable('工作区目录授权检查失败，已拒绝导入');
    }
    if (reason === null) return null;
    if (typeof reason === 'string' && reason.trim() !== '') return invalid(reason);
    return invalid('工作区目录未获授权，已拒绝导入');
  };

  return {
    importBundle: async (input) => {
      const validated = validateInput(input, maxBundleBytes, allowLocalOrigin);
      if (!validated.ok) return validated;
      const request = validated.value;

      // 显式 scratchRoot 必须先于任何目标仓库操作校验通过；失败不回退到 tmpdir。
      const scratchRoot = await resolveScratchRoot(scratchRootOption);
      if (!scratchRoot.ok) return scratchRoot;

      const requestedGuard = await guard(request.path);
      if (requestedGuard !== null) return { ok: false, error: requestedGuard };

      const root = await realpath(request.path).catch(() => null);
      if (root === null) return { ok: false, error: invalid('工作区路径不存在或无法解析') };

      // 第一次校验的是调用方给的路径；symlink 可能把真实目录带到边界之外，按 realpath 再校验一次。
      const realGuard = await guard(root);
      if (realGuard !== null) return { ok: false, error: realGuard };

      const workspace = await verifyWorkspace(root, request.expectedUrl, allowLocalOrigin, env, timeoutMs);
      if (!workspace.ok) return workspace;

      let tempDir: string | null = null;
      try {
        try {
          tempDir = await mkdtemp(join(scratchRoot.value, 'agent-hub-bundle-'));
        } catch {
          return { ok: false, error: unavailable('无法在 scratchRoot 中创建临时校验目录') };
        }
        await chmod(tempDir, 0o700);
        tempDir = await realpath(tempDir);
        const bundlePath = join(tempDir, 'payload.bundle');
        await writeFile(bundlePath, request.bundle, { mode: 0o600, flag: 'wx' });

        const bundle = await validateBundleInScratch(tempDir, bundlePath, request.tipSha, env, bundleTimeoutMs);
        if (!bundle.ok) return bundle;

        return await installDedicatedRef(
          root,
          request,
          bundle.value.headRef,
          bundlePath,
          env,
          timeoutMs,
          bundleTimeoutMs
        );
      } catch {
        return { ok: false, error: unavailable('导入 bundle 时发生本地错误，已停止') };
      } finally {
        if (tempDir !== null) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  };
}

/** 按 hub 的命名规则生成专用 ref；参数不合法返回 null。 */
export function projectGitBundleRef(projectId: string, tipSha: string): string | null {
  if (!PROJECT_ID_PATTERN.test(projectId) || !SHA1_PATTERN.test(tipSha)) return null;
  return `${BUNDLE_REF_PREFIX}${projectId}/${tipSha}`;
}

function normalizeMaxBundleBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_BUNDLE_BYTES;
  if (!Number.isFinite(value)) return DEFAULT_MAX_BUNDLE_BYTES;
  const floored = Math.floor(value);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_BUNDLE_BYTES);
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 60_000;
  const floored = Math.floor(value);
  if (floored < 1_000) return 1_000;
  return Math.min(floored, 600_000);
}

/**
 * 显式 scratchRoot 只在 import 时校验，且失败关闭：不自动创建、不回退 tmpdir。
 * 要求真实目录（非符号链接及其路径）是为了让调用方的配额目录就是实际落盘位置。
 */
async function resolveScratchRoot(configured: string | undefined): Promise<Result<string, DomainError>> {
  if (configured === undefined) return { ok: true, value: tmpdir() };
  if (
    typeof configured !== 'string' ||
    configured === '' ||
    configured !== configured.trim() ||
    !isAbsolute(configured) ||
    CONTROL_CHARACTERS.test(configured)
  ) {
    return { ok: false, error: invalid('scratchRoot 必须是合法的绝对路径') };
  }

  // 只去掉尾部的 `/`，仍要求 realpath 与给定路径一致（不经过符号链接）。
  const requested = configured.replace(/\/+$/, '') || '/';

  let info;
  try {
    info = await lstat(requested);
  } catch {
    return { ok: false, error: invalid('scratchRoot 必须是已存在的目录') };
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    return { ok: false, error: invalid('scratchRoot 必须是普通目录（不能是文件或符号链接）') };
  }

  const actual = await realpath(requested).catch(() => null);
  if (actual === null) {
    return { ok: false, error: invalid('scratchRoot 无法解析为真实目录') };
  }
  if (actual !== requested) {
    return { ok: false, error: invalid('scratchRoot 不能经过符号链接，请传真实路径') };
  }

  try {
    await access(requested, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    return { ok: false, error: unavailable('scratchRoot 不可读写，已拒绝导入') };
  }
  return { ok: true, value: requested };
}

function validateInput(
  input: ProjectGitBundleImportInput,
  maxBundleBytes: number,
  allowLocalOrigin: boolean
): Result<ValidatedInput, DomainError> {
  if (input === null || typeof input !== 'object') return { ok: false, error: invalid('导入参数不合法') };
  const { path, expectedUrl, bundleBase64, bundleSha256, tipSha, ref } = input;

  if (typeof path !== 'string' || path.trim() === '' || !isAbsolute(path) || CONTROL_CHARACTERS.test(path)) {
    return { ok: false, error: invalid('path 必须是合法的绝对路径') };
  }
  if (
    typeof expectedUrl !== 'string' ||
    expectedUrl === '' ||
    expectedUrl !== expectedUrl.trim() ||
    CONTROL_CHARACTERS.test(expectedUrl)
  ) {
    return { ok: false, error: invalid('expectedUrl 不合法') };
  }
  if (authScopeUrl(expectedUrl) === null && !(allowLocalOrigin && isLocalGitUrl(expectedUrl))) {
    return { ok: false, error: invalid('expectedUrl 必须是可校验的 HTTPS 地址') };
  }

  if (typeof bundleSha256 !== 'string' || !SHA256_PATTERN.test(bundleSha256)) {
    return { ok: false, error: invalid('bundleSha256 必须是 64 位小写十六进制') };
  }
  if (typeof tipSha !== 'string' || !SHA1_PATTERN.test(tipSha)) {
    return { ok: false, error: invalid('tipSha 必须是 40 位小写十六进制') };
  }
  if (typeof ref !== 'string') return { ok: false, error: invalid('ref 不合法') };
  const refMatch = REF_PATTERN.exec(ref);
  if (refMatch === null) {
    return { ok: false, error: invalid('ref 必须位于 refs/agent-hub/fetch/<id>/<tipSha>') };
  }
  if (refMatch[2] !== tipSha) {
    return { ok: false, error: invalid('ref 末尾的 SHA 必须等于 tipSha') };
  }

  if (typeof bundleBase64 !== 'string') return { ok: false, error: invalid('bundleBase64 不合法') };
  const maxEncodedLength = Math.ceil(maxBundleBytes / 3) * 4;
  if (bundleBase64.length > maxEncodedLength) {
    return { ok: false, error: invalid(`bundle 超过大小上限（${maxBundleBytes} 字节）`) };
  }
  if (bundleBase64.length === 0 || bundleBase64.length % 4 !== 0 || !BASE64_PATTERN.test(bundleBase64)) {
    return { ok: false, error: invalid('bundleBase64 不是规范的 base64') };
  }
  const bundle = Buffer.from(bundleBase64, 'base64');
  if (bundle.length > maxBundleBytes) {
    return { ok: false, error: invalid(`bundle 超过大小上限（${maxBundleBytes} 字节）`) };
  }
  if (bundle.toString('base64') !== bundleBase64) {
    return { ok: false, error: invalid('bundleBase64 不是规范的 base64') };
  }
  const actualSha = createHash('sha256').update(bundle).digest('hex');
  if (actualSha !== bundleSha256) {
    return { ok: false, error: invalid('bundle 的 sha256 与声明不一致') };
  }

  return {
    ok: true,
    value: { path, expectedUrl, bundle, tipSha, ref }
  };
}

function gitEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_PAGER: 'cat',
    GIT_EDITOR: 'true'
  };
  for (const key of ENV_PASSTHROUGH) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runGit(
  cwd: string,
  args: readonly string[],
  env: Record<string, string>,
  timeoutMs: number
): Promise<GitRun> {
  const argv: string[] = [];
  for (const entry of SAFE_GIT_CONFIG) argv.push('-c', entry);
  argv.push(...args);

  return new Promise((resolveRun) => {
    execFile(
      'git',
      argv,
      {
        cwd,
        env,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true
      },
      (error, stdout) => {
        let code = 0;
        if (error !== null) {
          const rawCode = (error as { code?: unknown }).code;
          code = typeof rawCode === 'number' ? rawCode : 1;
        }
        // 只保留退出码和 stdout：stderr 可能含仓库路径或本地配置，不作为错误信息回传。
        resolveRun({ code, stdout });
      }
    );
  });
}

function splitConfigLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function isLocalGitUrl(url: string): boolean {
  const value = url.trim();
  return value.startsWith('/') || value.startsWith('file:') || value.startsWith('~') || /^\.{1,2}\//.test(value);
}

async function verifyWorkspace(
  root: string,
  expectedUrl: string,
  allowLocalOrigin: boolean,
  env: Record<string, string>,
  timeoutMs: number
): Promise<Result<{ readonly root: string }, DomainError>> {
  const bare = await runGit(root, ['rev-parse', '--is-bare-repository'], env, timeoutMs);
  if (bare.code !== 0) {
    return { ok: false, error: invalid('目录不是 git 仓库') };
  }
  if (bare.stdout.trim() !== 'false') {
    return { ok: false, error: invalid('导入目标必须是带工作区的 git 仓库根目录') };
  }

  const top = await runGit(root, ['rev-parse', '--show-toplevel'], env, timeoutMs);
  if (top.code !== 0) {
    return { ok: false, error: invalid('目录不是 git 工作区根目录') };
  }
  const topRaw = top.stdout.trim();
  if (topRaw === '') return { ok: false, error: invalid('无法确定 git 工作区根目录') };
  const topReal = await realpath(topRaw).catch(() => null);
  if (topReal === null || topReal !== root) {
    return { ok: false, error: invalid('path 必须正好是 git 仓库根目录，不能是子目录') };
  }

  const layoutProblem = await verifyRepositoryLayout(root, env, timeoutMs);
  if (layoutProblem !== null) return { ok: false, error: layoutProblem };

  const modeProblem = await verifyRepositoryMode(root, env, timeoutMs);
  if (modeProblem !== null) return { ok: false, error: modeProblem };

  const rawFetchResult = await readConfigAll(root, 'remote.origin.url', env, timeoutMs);
  if (!rawFetchResult.ok) return rawFetchResult;
  const rawFetchUrls = rawFetchResult.value;
  if (rawFetchUrls.length !== 1) {
    return { ok: false, error: invalid('origin 必须恰好配置一个 fetch 地址') };
  }
  const rawPushResult = await readConfigAll(root, 'remote.origin.pushurl', env, timeoutMs);
  if (!rawPushResult.ok) return rawPushResult;
  const rawPushUrls = rawPushResult.value;
  if (rawPushUrls.length > 1) {
    return { ok: false, error: invalid('origin 配置了多个 push 地址，拒绝导入') };
  }

  const rawFetch = rawFetchUrls[0]!;
  const rawPush = rawPushUrls[0] ?? rawFetch;
  const expandedFetch = await runGit(root, ['remote', 'get-url', 'origin'], env, timeoutMs);
  if (expandedFetch.code !== 0) {
    return { ok: false, error: unavailable('无法展开 origin 的 fetch 地址') };
  }
  const expandedPush = await runGit(root, ['remote', 'get-url', '--push', 'origin'], env, timeoutMs);
  if (expandedPush.code !== 0) {
    return { ok: false, error: unavailable('无法展开 origin 的 push 地址') };
  }
  const fetchUrl = expandedFetch.stdout.trim() || rawFetch;
  const pushUrl = expandedPush.stdout.trim() || rawPush;

  // 初始切片不尝试解释任何 URL 改写：raw 与 git 展开值必须逐字一致。
  if (fetchUrl !== rawFetch || pushUrl !== rawPush) {
    return { ok: false, error: invalid('origin 地址被 git 配置改写（insteadOf），拒绝导入') };
  }

  const canonicalFetch = authScopeUrl(fetchUrl);
  const canonicalPush = authScopeUrl(pushUrl);
  if (canonicalFetch === null && !isLocalGitUrl(fetchUrl)) {
    return { ok: false, error: invalid('origin 不是可校验的 HTTPS 地址（本地路径仅测试策略放行）') };
  }
  if (canonicalPush === null && !isLocalGitUrl(pushUrl)) {
    return { ok: false, error: invalid('origin 的 push 地址不是可校验的 HTTPS 地址') };
  }
  if (canonicalFetch !== null && canonicalPush !== null && canonicalFetch !== canonicalPush) {
    return { ok: false, error: invalid('origin 的 fetch / push 规范地址不一致') };
  }

  const expectedScope = authScopeUrl(expectedUrl);
  if (expectedScope === null) {
    if (!allowLocalOrigin || !isLocalGitUrl(expectedUrl)) {
      return { ok: false, error: invalid('expectedUrl 必须是可校验的 HTTPS 地址') };
    }
    if (fetchUrl !== expectedUrl || pushUrl !== expectedUrl) {
      return { ok: false, error: invalid('origin 与项目登记的仓库地址不一致') };
    }
  } else if (canonicalFetch !== expectedScope || canonicalPush !== expectedScope) {
    return { ok: false, error: invalid('origin 与项目登记的仓库地址不一致') };
  }

  return { ok: true, value: { root } };
}

async function verifyPlainDirectory(path: string, label: string): Promise<DomainError | null> {
  const info = await lstat(path).catch(() => null);
  if (info === null) return invalid(`仓库缺少 ${label} 目录`);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    return invalid(`仓库 ${label} 不是普通目录，拒绝导入`);
  }
  return null;
}

async function verifyRepositoryLayout(
  root: string,
  env: Record<string, string>,
  timeoutMs: number
): Promise<DomainError | null> {
  const dotGit = join(root, '.git');
  const dotGitStat = await lstat(dotGit).catch(() => null);
  if (dotGitStat === null) return invalid('无法确认仓库的 .git 目录');
  if (dotGitStat.isSymbolicLink() || !dotGitStat.isDirectory()) {
    return invalid('只支持普通主工作区：linked worktree / .git 文件 / separated git dir 暂不支持');
  }
  const dotGitReal = await realpath(dotGit).catch(() => null);
  if (dotGitReal === null) return invalid('无法确认仓库的 .git 目录');

  const gitDir = await runGit(root, ['rev-parse', '--absolute-git-dir'], env, timeoutMs);
  if (gitDir.code !== 0) return invalid('无法确认仓库目录布局');
  const common = await runGit(root, ['rev-parse', '--git-common-dir'], env, timeoutMs);
  if (common.code !== 0) return invalid('无法确认仓库目录布局');
  const gitDirRaw = gitDir.stdout.trim();
  const commonRaw = common.stdout.trim();
  if (gitDirRaw === '' || commonRaw === '') return invalid('无法确认仓库目录布局');
  const commonPath = isAbsolute(commonRaw) ? commonRaw : join(root, commonRaw);
  const [gitDirReal, commonReal] = await Promise.all([
    realpath(gitDirRaw).catch(() => null),
    realpath(commonPath).catch(() => null)
  ]);
  if (gitDirReal === null || commonReal === null || gitDirReal !== dotGitReal || commonReal !== dotGitReal) {
    return invalid('gitdir / common-dir 与工作区 .git 不一致，暂不支持导入');
  }

  // refs 在 reftable 后端下可能不存在；存在时必须是普通目录，不能被 symlink 带出去。
  const refs = await lstat(join(dotGitReal, 'refs')).catch(() => null);
  if (refs !== null && (refs.isSymbolicLink() || !refs.isDirectory())) {
    return invalid('仓库 refs 不是普通目录，拒绝导入');
  }

  const objects = join(dotGitReal, 'objects');
  const objectsProblem = await verifyPlainDirectory(objects, 'objects');
  if (objectsProblem !== null) return objectsProblem;
  for (const name of ['pack', 'info'] as const) {
    const entry = await lstat(join(objects, name)).catch(() => null);
    if (entry !== null && (entry.isSymbolicLink() || !entry.isDirectory())) {
      return invalid(`仓库 objects/${name} 不是普通目录，拒绝导入`);
    }
  }
  const alternates = await lstat(join(objects, 'info', 'alternates')).catch(() => null);
  if (alternates !== null) {
    return invalid('仓库配置了 alternate 对象目录，拒绝导入');
  }
  return null;
}

async function verifyRepositoryMode(
  root: string,
  env: Record<string, string>,
  timeoutMs: number
): Promise<DomainError | null> {
  const shallow = await runGit(root, ['rev-parse', '--is-shallow-repository'], env, timeoutMs);
  if (shallow.code !== 0) return unavailable('无法确认仓库是否为 shallow 仓库');
  if (shallow.stdout.trim() === 'true') return invalid('shallow 仓库暂不支持导入');

  const format = await readConfigAll(root, 'extensions.objectFormat', env, timeoutMs);
  if (!format.ok) return format.error;
  if (format.value.some((value) => value.toLowerCase() !== 'sha1')) {
    return invalid('只支持 SHA-1 对象格式的仓库');
  }

  const partial = await readConfigAll(root, 'extensions.partialClone', env, timeoutMs);
  if (!partial.ok) return partial.error;
  if (partial.value.length > 0) return invalid('partial clone 仓库暂不支持导入');

  const promisor = await runGit(
    root,
    ['config', '--local', '--bool', '--get-regexp', '^remote\\..*\\.promisor$'],
    env,
    timeoutMs
  );
  if (promisor.code === 0) {
    if (splitConfigLines(promisor.stdout).some((line) => /\s+true$/i.test(line))) {
      return invalid('promisor 仓库暂不支持导入');
    }
  } else if (promisor.code !== 1) {
    return unavailable('无法确认仓库是否使用 promisor remote');
  }

  const filters = await runGit(
    root,
    ['config', '--local', '--get-regexp', '^remote\\..*\\.partialclonefilter$'],
    env,
    timeoutMs
  );
  if (filters.code === 0) {
    if (splitConfigLines(filters.stdout).length > 0) {
      return invalid('partial clone 仓库暂不支持导入');
    }
  } else if (filters.code !== 1) {
    return unavailable('无法确认仓库是否使用 partial clone filter');
  }
  return null;
}

async function readConfigAll(
  root: string,
  key: string,
  env: Record<string, string>,
  timeoutMs: number
): Promise<Result<string[], DomainError>> {
  const run = await runGit(root, ['config', '--local', '--get-all', key], env, timeoutMs);
  if (run.code === 1) return { ok: true, value: [] };
  if (run.code !== 0) {
    return { ok: false, error: unavailable('无法读取仓库配置') };
  }
  return { ok: true, value: splitConfigLines(run.stdout) };
}

function isSafeBundleHeadRef(ref: string): boolean {
  if (!ref.startsWith('refs/')) return false;
  if (!/^refs\/[A-Za-z0-9._\/-]+$/.test(ref)) return false;
  if (ref.includes('..') || ref.includes('//') || ref.includes('@{')) return false;
  if (ref.endsWith('/') || ref.endsWith('.lock')) return false;
  return true;
}

function parseBundleHeads(raw: string): BundleHead[] | null {
  const heads: BundleHead[] = [];
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const match = /^([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match === null) return null;
    const sha = match[1]!;
    const ref = match[2]!;
    if (!isSafeBundleHeadRef(ref)) return null;
    heads.push({ sha, ref });
  }
  return heads;
}

async function validateBundleInScratch(
  tempDir: string,
  bundlePath: string,
  tipSha: string,
  env: Record<string, string>,
  timeoutMs: number
): Promise<Result<{ readonly headRef: string }, DomainError>> {
  const scratch = join(tempDir, 'scratch.git');
  const init = await runGit(tempDir, ['init', '--bare', '--quiet', '--template=', scratch], env, timeoutMs);
  if (init.code !== 0) {
    return { ok: false, error: unavailable('创建临时校验仓库失败') };
  }

  // verify 必须在仓库里跑：空仓库没有前置提交，因此 thin bundle 会在这里被拒。
  const verify = await runGit(scratch, ['bundle', 'verify', bundlePath], env, timeoutMs);
  if (verify.code !== 0) {
    return {
      ok: false,
      error: invalid('bundle 校验失败（可能不完整或已损坏）')
    };
  }

  const listed = await runGit(scratch, ['bundle', 'list-heads', bundlePath], env, timeoutMs);
  if (listed.code !== 0) {
    return { ok: false, error: invalid('无法读取 bundle 的 ref') };
  }
  const heads = parseBundleHeads(listed.stdout);
  if (heads === null) {
    return { ok: false, error: invalid('bundle 声明的 ref 不合法') };
  }
  if (heads.length !== 1) {
    return { ok: false, error: invalid('bundle 必须只声明一个分支 tip') };
  }
  const head = heads[0]!;
  if (!head.ref.startsWith('refs/heads/')) {
    return { ok: false, error: invalid('bundle 的唯一 tip 必须位于 refs/heads/') };
  }
  if (head.sha !== tipSha) {
    return { ok: false, error: invalid('bundle 没有把 tipSha 暴露为唯一分支 tip') };
  }

  const destination = `refs/agent-hub/verify/${tipSha}`;
  const fetched = await runGit(
    scratch,
    [...FETCH_BUNDLE_ARGS, '--', bundlePath, `+${head.ref}:${destination}`],
    env,
    timeoutMs
  );
  if (fetched.code !== 0) {
    // 无法区分“bundle 缺对象”和临时目录空间/IO 失败，不能冒充 bundle 非法。
    return {
      ok: false,
      error: unavailable('临时校验仓库无法完整还原 bundle（可能空间不足，或 bundle 不完整）')
    };
  }

  const type = await runGit(scratch, ['cat-file', '-t', tipSha], env, timeoutMs);
  if (type.code !== 0 || type.stdout.trim() !== 'commit') {
    return { ok: false, error: invalid('bundle 的 tipSha 不是 commit 对象') };
  }
  const resolved = await runGit(
    scratch,
    ['rev-parse', '-q', '--verify', '--end-of-options', `${tipSha}^{commit}`],
    env,
    timeoutMs
  );
  if (resolved.code !== 0 || resolved.stdout.trim() !== tipSha) {
    return { ok: false, error: invalid('bundle 的 tipSha 不是可解析的 commit') };
  }

  // verify 只检查 bundle 的声明与前置提交；再在空仓库里走一遍 tip 的完整可达图，
  // 确认 blob/tree/commit 都真的在 bundle 里，而不是等导入目标仓库时才发现缺对象。
  const connectivity = await runGit(
    scratch,
    ['fsck', '--connectivity-only', '--no-dangling', '--no-progress', tipSha],
    env,
    timeoutMs
  );
  if (connectivity.code !== 0) {
    return { ok: false, error: invalid('bundle 的可达历史不完整或已损坏') };
  }

  return { ok: true, value: { headRef: head.ref } };
}

async function readRefState(
  root: string,
  ref: string,
  env: Record<string, string>,
  timeoutMs: number
): Promise<Result<RefState, DomainError>> {
  const symbolic = await runGit(root, ['symbolic-ref', '-q', ref], env, timeoutMs);
  if (symbolic.code === 0) {
    return { ok: true, value: { symbolic: true, sha: null } };
  }
  if (symbolic.code !== 1) {
    return { ok: false, error: unavailable('读取 ref 状态失败') };
  }

  const resolved = await runGit(root, ['rev-parse', '-q', '--verify', '--end-of-options', ref], env, timeoutMs);
  if (resolved.code === 1) return { ok: true, value: { symbolic: false, sha: null } };
  if (resolved.code !== 0) {
    return { ok: false, error: unavailable('读取 ref 状态失败') };
  }
  const sha = resolved.stdout.trim();
  if (!SHA1_PATTERN.test(sha)) {
    return { ok: false, error: unavailable('ref 指向的 SHA 不合法') };
  }
  return { ok: true, value: { symbolic: false, sha } };
}

async function snapshotWorktree(
  root: string,
  env: Record<string, string>,
  timeoutMs: number
): Promise<Result<WorktreeSnapshot, DomainError>> {
  const symbolic = await runGit(root, ['symbolic-ref', '-q', 'HEAD'], env, timeoutMs);
  let headRef: string | null = null;
  if (symbolic.code === 0) {
    headRef = symbolic.stdout.trim();
    if (headRef === '') return { ok: false, error: unavailable('无法确定 HEAD 指向的分支') };
  } else if (symbolic.code !== 1) {
    return { ok: false, error: unavailable('读取 HEAD 失败') };
  }

  const head = await runGit(root, ['rev-parse', '-q', '--verify', '--end-of-options', 'HEAD'], env, timeoutMs);
  let headSha: string | null = null;
  if (head.code === 0) {
    headSha = head.stdout.trim();
    if (!SHA1_PATTERN.test(headSha)) {
      return { ok: false, error: unavailable('HEAD 的 SHA 不合法') };
    }
  } else if (head.code !== 1) {
    return { ok: false, error: unavailable('读取 HEAD 失败') };
  }

  const indexPathOutput = await runGit(root, ['rev-parse', '--git-path', 'index'], env, timeoutMs);
  if (indexPathOutput.code !== 0) {
    return { ok: false, error: unavailable('无法定位 index') };
  }
  const rawIndexPath = indexPathOutput.stdout.trim();
  if (rawIndexPath === '') return { ok: false, error: unavailable('无法定位 index') };
  const indexPath = isAbsolute(rawIndexPath) ? rawIndexPath : join(root, rawIndexPath);

  let index: IndexStat | null = null;
  try {
    const info = await lstat(indexPath);
    if (info.isSymbolicLink() || !info.isFile()) {
      return { ok: false, error: unavailable('index 不是普通文件，拒绝导入') };
    }
    index = { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { ok: false, error: unavailable('读取 index 状态失败') };
    }
  }

  return { ok: true, value: { headRef, headSha, index } };
}

function sameIndex(left: IndexStat | null, right: IndexStat | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameWorktree(before: WorktreeSnapshot, after: WorktreeSnapshot): boolean {
  return before.headRef === after.headRef && before.headSha === after.headSha && sameIndex(before.index, after.index);
}

async function assertCommitPresent(
  root: string,
  tipSha: string,
  env: Record<string, string>,
  timeoutMs: number,
  afterFetch = false
): Promise<DomainError | null> {
  const writeNote = afterFetch ? '；对象写入可能不完整' : '';
  const type = await runGit(root, ['cat-file', '-t', tipSha], env, timeoutMs);
  if (type.code !== 0 || type.stdout.trim() !== 'commit') {
    return afterFetch
      ? unavailable(`取对象后无法确认 tipSha 是 commit${writeNote}`)
      : invalid('tipSha 在目标仓库中不是可用的 commit 对象');
  }
  const resolved = await runGit(
    root,
    ['rev-parse', '-q', '--verify', '--end-of-options', `${tipSha}^{commit}`],
    env,
    timeoutMs
  );
  if (resolved.code !== 0 || resolved.stdout.trim() !== tipSha) {
    return afterFetch
      ? unavailable(`取对象后无法解析 tipSha${writeNote}`)
      : invalid('tipSha 在目标仓库中不是可解析的 commit');
  }
  return null;
}

async function rollbackRef(
  root: string,
  ref: string,
  tipSha: string,
  env: Record<string, string>,
  timeoutMs: number
): Promise<string> {
  const removed = await runGit(root, ['update-ref', '--no-deref', '-d', ref, tipSha], env, timeoutMs);
  return removed.code === 0 ? '已撤销本次创建的新 ref' : '撤销新 ref 失败，请人工核查';
}

async function installDedicatedRef(
  root: string,
  input: ValidatedInput,
  headRef: string,
  bundlePath: string,
  env: Record<string, string>,
  timeoutMs: number,
  bundleTimeoutMs: number
): Promise<Result<ProjectGitBundleImportOutcome, DomainError>> {
  const before = await snapshotWorktree(root, env, timeoutMs);
  if (!before.ok) return before;

  const initial = await readRefState(root, input.ref, env, timeoutMs);
  if (!initial.ok) return initial;
  if (initial.value.symbolic) {
    return { ok: false, error: invalid('目标 ref 当前是符号引用，拒绝写入') };
  }
  if (initial.value.sha !== null) {
    if (initial.value.sha !== input.tipSha) {
      return { ok: false, error: conflict('目标 ref 已存在且指向不同的提交，拒绝覆盖') };
    }
    const problem = await assertCommitPresent(root, input.tipSha, env, timeoutMs);
    if (problem !== null) return { ok: false, error: problem };
    return {
      ok: true,
      value: { ref: input.ref, tipSha: input.tipSha, alreadyPresent: true }
    };
  }

  // 只取对象、不写 ref：目标 fetch 不带目的 refspec，并禁用 FETCH_HEAD / tags / prune / hooks。
  const fetched = await runGit(root, [...FETCH_BUNDLE_ARGS, '--', bundlePath, `+${headRef}`], env, bundleTimeoutMs);
  if (fetched.code !== 0) {
    return {
      ok: false,
      error: unavailable('从 bundle 取对象失败，目标仓库可能已写入部分对象（ref 未创建）')
    };
  }
  const missing = await assertCommitPresent(root, input.tipSha, env, timeoutMs, true);
  if (missing !== null) return { ok: false, error: missing };

  // fetch 期间可能有并发写入；写 ref 之前重新读一次。
  const again = await readRefState(root, input.ref, env, timeoutMs);
  if (!again.ok) return again;
  if (again.value.symbolic) {
    return { ok: false, error: invalid('目标 ref 在导入过程中变成符号引用，拒绝写入') };
  }
  if (again.value.sha !== null) {
    if (again.value.sha !== input.tipSha) {
      return { ok: false, error: conflict('目标 ref 已存在且指向不同的提交，拒绝覆盖') };
    }
    return {
      ok: true,
      value: { ref: input.ref, tipSha: input.tipSha, alreadyPresent: true }
    };
  }

  const created = await runGit(
    root,
    ['update-ref', '--no-deref', input.ref, input.tipSha, ZERO_SHA1],
    env,
    timeoutMs
  );
  if (created.code !== 0) {
    const now = await readRefState(root, input.ref, env, timeoutMs);
    if (!now.ok) {
      return { ok: false, error: unavailable('目标 ref 写入失败，状态未知，请人工核查') };
    }
    if (!now.value.symbolic && now.value.sha === input.tipSha) {
      return {
        ok: true,
        value: { ref: input.ref, tipSha: input.tipSha, alreadyPresent: true }
      };
    }
    if (now.value.symbolic) {
      return { ok: false, error: invalid('目标 ref 在写入时是符号引用，拒绝跟随') };
    }
    return { ok: false, error: unavailable('目标 ref 写入失败，状态未知（未强制覆盖）') };
  }

  const after = await snapshotWorktree(root, env, timeoutMs);
  if (!after.ok) {
    const note = await rollbackRef(root, input.ref, input.tipSha, env, timeoutMs);
    return { ok: false, error: unavailable(`导入后无法确认工作区状态；${note}`) };
  }
  if (!sameWorktree(before.value, after.value)) {
    const note = await rollbackRef(root, input.ref, input.tipSha, env, timeoutMs);
    return {
      ok: false,
      error: unavailable(`导入过程中 HEAD / 分支 / index 发生变化，${note}；请人工核查`)
    };
  }

  const final = await readRefState(root, input.ref, env, timeoutMs);
  if (!final.ok || final.value.symbolic || final.value.sha !== input.tipSha) {
    const note = await rollbackRef(root, input.ref, input.tipSha, env, timeoutMs);
    return { ok: false, error: unavailable(`导入后目标 ref 未指向 tipSha，${note}；请人工核查`) };
  }

  return {
    ok: true,
    value: { ref: input.ref, tipSha: input.tipSha, alreadyPresent: false }
  };
}
