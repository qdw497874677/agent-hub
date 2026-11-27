import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, link, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { conflict, invalid, unavailable } from '@agent-hub/domain';
import type { WorkspaceGit } from '@agent-hub/domain';
import type { PlannedWorktreeCreateInput, PlannedWorktreeInspectInput, PlannedWorktreeInspection } from '@agent-hub/domain';
import type { GitWorkspaceOptions } from './git-workspace.ts';
import { isEqualOrDescendantPath, isStrictDescendantPath } from './path-boundary.ts';
import { plannedRepositoryIdentity } from './planned-repository-identity.ts';

const exec = promisify(execFile);
const locks = new Map<string, Promise<void>>();
async function lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const tail = prev.then(() => next);
  locks.set(key, tail);
  await prev;
  try { return await fn(); } finally { release(); if (locks.get(key) === tail) locks.delete(key); }
}

const env = { PATH: process.env.PATH, HOME: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_ALLOW_PROTOCOL: '', LC_ALL: 'C' };
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', ...args], { cwd, env, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}
const fail = (message: string) => { throw new Error(message); };

export function createPlannedWorktrees(check: (path: string) => Promise<string | null>, options: GitWorkspaceOptions, verifyOrigin: (path: string, expected: string) => Promise<boolean>): Pick<WorkspaceGit, 'inspectPlannedWorktree' | 'createPlannedWorktree' | 'verifyPlannedWorktree'> {
  async function guard(path: string): Promise<void> {
    if (!isAbsolute(path) || await check(path) !== null) fail('路径不在允许的 Worker roots 内');
  }
  async function inspect(input: PlannedWorktreeInspectInput, resolveRef = true): Promise<PlannedWorktreeInspection> {
    await guard(input.sourcePath);
    const source = await realpath(input.sourcePath);
    await guard(source);
    const topLevel = await realpath(await git(source, 'rev-parse', '--show-toplevel'));
    if (source !== topLevel) fail('来源必须是 Git 顶层目录');
    const commonDir = await realpath(resolve(source, await git(source, 'rev-parse', '--git-common-dir')));
    const gitDir = await realpath(await git(source, 'rev-parse', '--absolute-git-dir'));
    await guard(commonDir);
    await guard(gitDir);
    if (input.expectedOriginUrl !== undefined && !await verifyOrigin(source, input.expectedOriginUrl)) fail('origin 与预期仓库不匹配');
    if (input.startRef !== null && !/^refs\/(heads|remotes|tags)\/[a-zA-Z0-9._/-]+$/.test(input.startRef)) fail('起点必须是完整引用');
    if (input.startRef !== null) await git(source, 'check-ref-format', input.startRef);
    const oid = resolveRef ? await git(source, 'rev-parse', '--verify', '--end-of-options', `${input.startRef ?? 'HEAD'}^{commit}`) : '';
    if (resolveRef && !/^[0-9a-f]{40}$/.test(oid)) fail('不支持此 Git 对象格式');
    if (!options.groupsDir) fail('未配置组合工作空间根目录');
    const configuredRoot = join(resolve(options.groupsDir!), 'planned-worktrees');
    const groupsRoot = await realpath(options.groupsDir!);
    const rootStat = await lstat(configuredRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o022) !== 0) fail('计划工作区根目录不可用');
    const managedRoot = await realpath(configuredRoot);
    if (managedRoot !== join(groupsRoot, 'planned-worktrees')) fail('计划工作区根目录不可信');
    await guard(managedRoot);
    return { topLevel, commonDir, identity: await plannedRepositoryIdentity(topLevel, commonDir, gitDir), oid, managedRoot };
  }
  async function proofDirectory(): Promise<string> {
    if (!options.plannedProofDir || !isAbsolute(options.plannedProofDir)) fail('未配置可信操作证明目录');
    const path = resolve(options.plannedProofDir!);
    const s = await lstat(path);
    if (path !== options.plannedProofDir || !s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0 || s.uid !== process.getuid?.() || await realpath(path) !== path) fail('操作证明目录必须是 Worker 私有目录');
    return path;
  }
  async function readProof(path: string): Promise<string | null> {
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return null;
    if (!isAbsolute(path) || resolve(path) !== path || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || await realpath(path) !== path) fail('操作证明文件不可信');
    return readFile(path, 'utf8');
  }
  async function diskLock<T>(dir: string, key: string, fn: () => Promise<T>): Promise<T> {
    const path = join(dir, `${createHash('sha256').update(key).digest('hex')}.lock`);
    // Stale locks fail closed after process failure; never steal a possibly live lock.
    const handle = await open(path, 'wx', 0o600);
    try { return await fn(); } finally { await handle.close(); await unlink(path); }
  }
  type Identity = { dev: string; ino: string; birth: string };
  type Completed = { version: 2; fingerprint: string; source: Identity; common: Identity; sourceGitDir: string; sourceRegistration: Identity; target: Identity; gitDir: string; registration: Identity; marker: string };
  async function directoryIdentity(path: string): Promise<Identity> {
    if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) fail('目录路径不规范');
    const stat = await lstat(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.birthtimeNs <= 0n) fail('目录身份不可证明');
    return { dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) };
  }
  const fingerprint = (input: PlannedWorktreeCreateInput) => createHash('sha256').update(JSON.stringify({ sourcePath: input.sourcePath, startRef: input.startRef, expectedOriginUrl: input.expectedOriginUrl ?? null, expectedTopLevel: input.expectedTopLevel, expectedCommonDir: input.expectedCommonDir, expectedIdentity: input.expectedIdentity, expectedOid: input.expectedOid, targetPath: input.targetPath, branch: input.branch, operationId: input.operationId })).digest('hex');
  async function verifyTarget(path: string, input: PlannedWorktreeCreateInput, strictHead = true): Promise<{ target: Identity; gitDir: string; registration: Identity }> {
    if (await realpath(path) !== path) fail('目标路径不匹配');
    const target = await directoryIdentity(path);
    const gitFile = await lstat(join(path, '.git'));
    if (!gitFile.isFile() || gitFile.isSymbolicLink()) fail('目标 Git 文件不可信');
    if (await realpath(await git(path, 'rev-parse', '--show-toplevel')) !== path) fail('目标不是 Git 顶层');
    if (await realpath(resolve(path, await git(path, 'rev-parse', '--git-common-dir'))) !== input.expectedCommonDir) fail('目标 Git 身份不匹配');
    const gitDir = await git(path, 'rev-parse', '--absolute-git-dir');
    if (!isStrictDescendantPath(join(input.expectedCommonDir, 'worktrees'), gitDir)) fail('目标 Git 注册路径不可信');
    await guard(gitDir);
    const registration = await directoryIdentity(gitDir);
    if (strictHead && await git(path, 'symbolic-ref', '--quiet', 'HEAD') !== `refs/heads/${input.branch}`) fail('目标分支不匹配');
    if (strictHead && await git(path, 'rev-parse', '--verify', 'HEAD^{commit}') !== input.expectedOid) fail('目标提交不匹配');
    const registered = await git(input.sourcePath, 'worktree', 'list', '--porcelain', '-z');
    if (!registered.split('\0').includes(`worktree ${path}`)) fail('目标未注册为 Git worktree');
    return { target, gitDir, registration };
  }
  async function verifyCompleted(completed: Completed, proof: string, current: PlannedWorktreeInspection, target: string, input: PlannedWorktreeCreateInput, strictHead: boolean): Promise<void> {
    if (completed.version !== 2 || completed.fingerprint !== proof || !/^[0-9a-f]{64}$/.test(completed.marker)) fail('完成证明不匹配');
    const sourceGitDir = await realpath(await git(current.topLevel, 'rev-parse', '--absolute-git-dir'));
    const sourceIdentity = { source: await directoryIdentity(current.topLevel), common: await directoryIdentity(current.commonDir), sourceGitDir, sourceRegistration: await directoryIdentity(sourceGitDir) };
    if (JSON.stringify(sourceIdentity) !== JSON.stringify({ source: completed.source, common: completed.common, sourceGitDir: completed.sourceGitDir, sourceRegistration: completed.sourceRegistration })) fail('来源仓库身份已改变');
    const identity = await verifyTarget(target, input, strictHead);
    if (JSON.stringify(identity) !== JSON.stringify({ target: completed.target, gitDir: completed.gitDir, registration: completed.registration })) fail('目标或 Git 注册已被替换');
    const markerPath = join(identity.gitDir, 'agent-hub-planned-proof');
    const markerStat = await lstat(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || await readFile(markerPath, 'utf8') !== completed.marker) fail('Git 注册证明不匹配');
  }
  async function verifyPlanned(input: PlannedWorktreeCreateInput, strictHead: boolean) {
      try {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(input.operationId) || !/^[0-9a-f]{40}$/.test(input.expectedOid) || !/^[0-9a-f]{64}$/.test(input.expectedIdentity)) fail('无效计划');
        const initial = await inspect(input, false);
        return await lock(`operation:${input.operationId}`, () => lock(`repo:${initial.commonDir}`, async () => {
          const current = await inspect(input, false);
          if (current.topLevel !== input.expectedTopLevel || current.commonDir !== input.expectedCommonDir || current.identity !== input.expectedIdentity) fail('来源身份已变化');
          const target = resolve(input.targetPath);
          if (!isAbsolute(input.targetPath) || target !== input.targetPath || !isStrictDescendantPath(current.managedRoot, target) || isEqualOrDescendantPath(current.topLevel, target)) fail('目标不安全');
          await guard(target);
          const proofFile = join(await proofDirectory(), createHash('sha256').update(input.operationId).digest('hex') + '.json');
          const proof = await readProof(proofFile);
          if (proof === null) fail('没有完成证明');
          await verifyCompleted(JSON.parse(proof!) as Completed, fingerprint(input), current, target, input, strictHead);
          return { ok: true as const, value: { path: target, branch: input.branch, oid: input.expectedOid, alreadyCreated: true } };
        }));
      } catch { return { ok: false as const, error: unavailable('无法验证计划检出归属') }; }
  }
  return {
    async inspectPlannedWorktree(input) {
      try { return { ok: true, value: await inspect(input) }; }
      catch { return { ok: false, error: invalid('无法安全检查计划来源或仓库身份不匹配') }; }
    },
    verifyPlannedWorktree(input) { return verifyPlanned(input, false); },
    async createPlannedWorktree(input) {
      let provenNoPriorMutation = false;
      let intentStarted = false;
      try {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(input.operationId)) fail('无效操作 ID');
        if (!/^[0-9a-f]{40}$/.test(input.expectedOid)) fail('无效提交');
        if (!/^[0-9a-f]{64}$/.test(input.expectedIdentity)) fail('无效来源身份');
        // Reconciliation is read-only and depends exclusively on an immutable published
        // completion receipt; abandoned mutation lock markers are never removed/stolen.
        if (input.reconcileOnly) {
          return await verifyPlanned(input, true);
        }
        const initial = await inspect(input, false);
        return await lock(`operation:${input.operationId}`, () => lock(`repo:${initial.commonDir}`, async () => {
          const proofDir = await proofDirectory();
          return diskLock(proofDir, `operation:${input.operationId}`, () => diskLock(proofDir, `repo:${initial.commonDir}`, async () => {
          const current = await inspect(input, false);
          if (current.topLevel !== input.expectedTopLevel || current.commonDir !== input.expectedCommonDir || current.identity !== input.expectedIdentity) return { ok: false as const, error: conflict('来源身份已变化，无法证明操作状态') };
          if (input.branch.startsWith('-') || input.branch.includes('@{')) fail('无效分支');
          await git(current.topLevel, 'check-ref-format', `refs/heads/${input.branch}`);
          const proofFile = join(proofDir, createHash('sha256').update(input.operationId).digest('hex') + '.json');
          const intentFile = proofFile + '.intent';
          const proof = fingerprint(input);
          const target = resolve(input.targetPath);
          if (!isAbsolute(input.targetPath) || target !== input.targetPath || basename(target) === '') fail('目标必须是规范化绝对路径');
          await guard(target);
          if (!isStrictDescendantPath(current.managedRoot, target) || isEqualOrDescendantPath(current.topLevel, target)) fail('目标不在安全管理根下或嵌套在来源中');
          const worktrees = await git(current.topLevel, 'worktree', 'list', '--porcelain', '-z');
          for (const entry of worktrees.split('\0')) {
            if (entry.startsWith('worktree ')) {
              const worktree = await realpath(entry.slice(9)).catch(() => null);
              if (worktree && worktree !== target && isEqualOrDescendantPath(worktree, target)) fail('目标嵌套在已有 worktree 内');
            }
          }
          const existingProof = await readProof(proofFile);
          if (existingProof !== null) {
            await verifyCompleted(JSON.parse(existingProof) as Completed, proof, current, target, input, true);
            return { ok: true as const, value: { path: target, branch: input.branch, oid: input.expectedOid, alreadyCreated: true } };
          }
          if (input.reconcileOnly) return { ok: false as const, error: conflict('没有完成证明，无法对账') };
          const intent = await readProof(intentFile);
          if (intent !== null) return { ok: false as const, error: conflict(intent === proof ? '操作已有未完成记录，必须先对账' : '操作 ID 与已记录计划不一致') };
          provenNoPriorMutation = true;
          const resolved = await inspect(input);
          if (resolved.topLevel !== current.topLevel || resolved.commonDir !== current.commonDir || resolved.identity !== input.expectedIdentity || resolved.oid !== input.expectedOid) fail('来源身份或起点已变化');
          // These checks do not create directories or dispatch a Git mutation.
          if (await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; })) fail('目标已存在');
          const branchExists = await git(current.topLevel, 'show-ref', '--verify', '--quiet', `refs/heads/${input.branch}`).then(() => true, (error: { code?: number }) => { if (error.code === 1) return false; throw error; });
          if (branchExists) fail('分支已存在');
          const dangerous = await git(current.topLevel, 'config', '--get-regexp', '^(filter\\.|extensions\\.partialclone$|remote\\..*\\.promisor$)').catch((error: { code?: number }) => { if (error.code === 1) return ''; throw error; });
          if (dangerous) fail('不支持配置过滤器或部分克隆的仓库');
          const missing = await git(current.topLevel, 'rev-list', '--objects', '--missing=print', input.expectedOid);
          if (missing.split('\n').some((line) => line.startsWith('?'))) fail('本地对象不完整');
          let existingParent = current.managedRoot;
          for (const part of relative(current.managedRoot, dirname(target)).split(sep).filter(Boolean)) {
            existingParent = join(existingParent, part);
            await guard(existingParent);
            const stat = await lstat(existingParent).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
            if (!stat) break;
            if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || await realpath(existingParent) !== existingParent) fail('目标父目录不安全');
          }
          const sourceGitDir = await realpath(await git(current.topLevel, 'rev-parse', '--absolute-git-dir'));
          const sourceIdentity = { source: await directoryIdentity(current.topLevel), common: await directoryIdentity(current.commonDir), sourceGitDir, sourceRegistration: await directoryIdentity(sourceGitDir) };
          if (await plannedRepositoryIdentity(current.topLevel, current.commonDir, sourceGitDir) !== input.expectedIdentity) fail('来源身份已变化');
          intentStarted = true;
          const intentHandle = await open(intentFile, 'wx', 0o600);
          try { await intentHandle.writeFile(proof); await intentHandle.sync(); } finally { await intentHandle.close(); }
          const intentDir = await open(proofDir, 'r'); try { await intentDir.sync(); } finally { await intentDir.close(); }
          let parent = current.managedRoot;
          for (const part of relative(current.managedRoot, dirname(target)).split(sep).filter(Boolean)) {
            parent = join(parent, part);
            await guard(parent);
            try { await mkdir(parent, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
            const stat = await lstat(parent);
            if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || await realpath(parent) !== parent) fail('目标父目录不安全');
          }
          if (await lstat(target).catch(() => null)) return { ok: false as const, error: unavailable('目标已存在，无法证明归属') };
          await git(current.topLevel, 'worktree', 'add', '-b', input.branch, '--', target, input.expectedOid);
          const identity = await verifyTarget(target, input);
          const marker = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
          const markerFile = await open(join(identity.gitDir, 'agent-hub-planned-proof'), 'wx', 0o600);
          try { await markerFile.writeFile(marker); await markerFile.sync(); } finally { await markerFile.close(); }
          const registrationDir = await open(identity.gitDir, 'r'); try { await registrationDir.sync(); } finally { await registrationDir.close(); }
          if (JSON.stringify(await verifyTarget(target, input)) !== JSON.stringify(identity)) fail('目标或 Git 注册已被替换');
          const completed: Completed = { version: 2, fingerprint: proof, ...sourceIdentity, ...identity, marker };
          const tmp = join(proofDir, `.${randomUUID()}.tmp`);
          const f = await open(tmp, 'wx', 0o600);
          try { await f.writeFile(JSON.stringify(completed)); await f.sync(); } finally { await f.close(); }
          try { await link(tmp, proofFile); const dir = await open(proofDir, 'r'); try { await dir.sync(); } finally { await dir.close(); } } finally { await unlink(tmp).catch(() => undefined); }
          return { ok: true as const, value: { path: target, branch: input.branch, oid: input.expectedOid, alreadyCreated: false } };
          }));
        }));
      } catch {
        // Never clean up: an interrupted Git operation without proof has unknown ownership.
        return { ok: false, error: provenNoPriorMutation && !intentStarted && !input.reconcileOnly ? { ...conflict('计划检出前检查失败，未执行 Git 检出'), operationSettled: true } : unavailable('计划检出失败或状态未知；不得盲目重试') };
      }
    }
  };
}
