import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DomainError, GitAuth, Result } from '@agent-hub/domain';
import { plannedRepositoryIdentity } from './planned-repository-identity.ts';

export interface PlannedBaseOptions {
  readonly groupsDir?: string;
  readonly plannedProofDir?: string;
  /** Exact canonical HTTPS origins, provisioned by the Worker operator; missing/malformed denies network.
   * Operators must trust DNS for these origins and enforce appropriate network egress restrictions. */
  readonly plannedBaseAllowedOrigins?: readonly string[];
  /** Test-only process injection; never populate from a Worker request or configuration. */
  readonly testOnlyGit?: (args: readonly string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<string>;
}
export interface ResolvePlannedBaseInput { readonly repoUrl: string; readonly startRef: string | null; readonly auth?: GitAuth }
export interface PreparePlannedBaseInput extends ResolvePlannedBaseInput {
  readonly startRef: string; readonly operationId: string; readonly targetPath: string;
  readonly expectedOid: string; readonly reconcileOnly?: boolean;
}
export interface ResolvedPlannedBase { readonly managedRoot: string; readonly startRef: string; readonly oid: string }
export interface PreparedPlannedBase { readonly topLevel: string; readonly commonDir: string; readonly identity: string; readonly oid: string; readonly managedRoot: string }

type PhysicalIdentity = { path: string; dev: string; ino: string; birth: string };
type Receipt = { version: 2; operationId: string; targetPath: string; urlHash: string; startRef: string; oid: string; physical?: PhysicalIdentity[] };
const operationLocks = new Map<string, Promise<void>>();
async function withOperationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = operationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  operationLocks.set(key, current);
  await previous;
  try { return await fn(); } finally { if (operationLocks.get(key) === current) operationLocks.delete(key); release(); }
}
async function physicalIdentity(source: string, published: string): Promise<PhysicalIdentity[]> {
  const values: PhysicalIdentity[] = [];
  for (const [path, target] of [[source, published], [join(source, '.git'), join(published, '.git')], [join(source, '.git'), join(published, '.git')]] as const) {
    if (await realpath(path) !== path) throw new Error('Non-canonical repository identity');
    const st = await lstat(path, { bigint: true });
    if (!st.isDirectory() || st.isSymbolicLink() || st.birthtimeNs <= 0n) throw new Error('Repository identity unavailable');
    values.push({ path: target, dev: String(st.dev), ino: String(st.ino), birth: String(st.birthtimeNs) });
  }
  return values;
}
class Failure extends Error {
  readonly code: DomainError['code']; readonly settled: boolean;
  constructor(code: DomainError['code'], message: string, settled = false) { super(message); this.code = code; this.settled = settled; }
}
const fail = (message: string, code: DomainError['code'] = 'invalid', settled = true): never => { throw new Failure(code, message, settled); };
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const urlHash = (url: string) => createHash('sha256').update(url).digest('hex');

/** A separate, fail-closed primitive. It does not use clone/addWorktree's rollback or fallback behavior. */
export function createPlannedBases(check: (path: string) => Promise<string | null>, options: PlannedBaseOptions) {
  const run = async (args: string[], auth: GitAuth | undefined, cwd: string): Promise<string> => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_ALLOW_PROTOCOL: 'https',
      GIT_CEILING_DIRECTORIES: cwd,
      GIT_CONFIG_COUNT: auth ? '5' : '4',
      GIT_CONFIG_KEY_0: 'http.followRedirects', GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '',
      GIT_CONFIG_KEY_2: 'http.sslVerify', GIT_CONFIG_VALUE_2: 'true',
      GIT_CONFIG_KEY_3: 'credential.interactive', GIT_CONFIG_VALUE_3: 'never',
      ...(auth ? { GIT_CONFIG_KEY_4: `http.${auth.url}.extraHeader`, GIT_CONFIG_VALUE_4: auth.header } : {}),
    };
    if (options.testOnlyGit) return options.testOnlyGit(args, env, cwd);
    return new Promise((res, rej) => execFile('git', args, { cwd, env, timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, out) => err ? rej(err) : res(out)));
  };
  const root = async () => {
    if (!options.groupsDir || !options.plannedProofDir) return fail('Worker 未配置计划底座目录', 'not_implemented');
    const groups = resolve(options.groupsDir);
    if (groups !== options.groupsDir || await realpath(groups) !== groups) return fail('计划根目录不规范');
    const managedRoot = join(groups, 'planned-worktrees');
    if (await realpath(managedRoot) !== managedRoot || await check(managedRoot) !== null) return fail('计划根目录不受允许');
    if (await lstat(join(managedRoot, '.git')).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; })) return fail('计划根目录不可为 Git 仓库');
    for (const path of [groups, managedRoot]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) return fail('计划根目录权限不安全');
    }
    const proof = resolve(options.plannedProofDir);
    if (proof !== options.plannedProofDir || await realpath(proof) !== proof) return fail('凭据目录不规范');
    const stat = await lstat(proof);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700) return fail('凭据目录不安全');
    return { managedRoot, proof };
  };
  const validate = (input: ResolvePlannedBaseInput, network: boolean) => {
    let url: URL;
    try { url = new URL(input.repoUrl); } catch { return fail('仅支持 HTTPS 仓库地址'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || /[\s\x00-\x1f]/.test(input.repoUrl) || !url.hostname || url.href !== input.repoUrl) return fail('仅支持规范且不含凭据的 HTTPS 仓库地址');
    if (network) {
      const allowed = options.plannedBaseAllowedOrigins;
      if (!allowed?.length || allowed.some((origin) => {
        try { const parsed = new URL(origin); return parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username !== '' || parsed.password !== ''; } catch { return true; }
      }) || !allowed.includes(url.origin)) return fail('远端地址未获 Worker 管理员允许', 'forbidden');
      if (input.auth && (input.auth.url !== input.repoUrl || !/^Authorization: Basic [A-Za-z0-9+/=]+$/.test(input.auth.header) || input.auth.header.length > 8192)) return fail('仓库凭据与地址不匹配');
    }
    if (input.startRef !== null && (!input.startRef.startsWith('refs/heads/') || input.startRef.length > 1024)) return fail('起点必须是完整分支引用');
  };
  const advertised = async (input: ResolvePlannedBaseInput, cwd: string) => {
    if (input.startRef !== null) {
      try { await run(['check-ref-format', input.startRef], undefined, cwd); } catch { return fail('分支引用不合法'); }
    }
    let text: string;
    try { text = await run(['ls-remote', '--symref', '--', input.repoUrl, 'HEAD', ...(input.startRef ? [input.startRef] : [])], input.auth, cwd); }
    catch { return fail('无法解析远端引用', 'unavailable'); }
    const lines = text.trim().split('\n');
    const defaultRef = lines.find((x) => x.startsWith('ref: ') && x.endsWith('\tHEAD'))?.slice(5, -5);
    const ref = input.startRef ?? defaultRef;
    if (!ref || !ref.startsWith('refs/heads/')) return fail('远端默认分支不可用', 'conflict');
    try { await run(['check-ref-format', ref], undefined, cwd); } catch { return fail('远端分支引用不合法', 'conflict'); }
    const matches = lines.filter((x) => x.endsWith(`\t${input.startRef ? ref : 'HEAD'}`)).map((x) => x.split('\t')[0]).filter((x): x is string => x !== undefined && oidPattern.test(x));
    const oid = matches[0];
    if (matches.length !== 1 || oid === undefined) return fail('远端分支不存在或引用不明确', 'conflict');
    return { startRef: ref, oid };
  };
  const result = async <T>(fn: () => Promise<T>, allowSettled: () => boolean = () => true): Promise<Result<T, DomainError>> => {
    try { return { ok: true, value: await fn() }; }
    catch (error) { const e = error instanceof Failure ? error : new Failure('unavailable', '计划底座操作失败，状态需要对账'); return { ok: false, error: { code: e.code, message: e.message, ...(allowSettled() && e.settled ? { operationSettled: true as const } : {}) } }; }
  };
  const inspect = async (input: PreparePlannedBaseInput, receipt: Receipt, managedRoot: string): Promise<PreparedPlannedBase> => {
    if (!receipt.physical || JSON.stringify(await physicalIdentity(input.targetPath, input.targetPath)) !== JSON.stringify(receipt.physical)) return fail('底座所有权无法证明', 'conflict', false);
    const gitDir = join(input.targetPath, '.git');
    if (await realpath(gitDir) !== gitDir || !(await lstat(gitDir)).isDirectory()) return fail('底座 Git 身份不匹配', 'conflict', false);
    const [top, common, head, origin] = await Promise.all([
      run(['rev-parse', '--show-toplevel'], undefined, input.targetPath), run(['rev-parse', '--git-common-dir'], undefined, input.targetPath),
      input.reconcileOnly ? Promise.resolve(null) : run(['rev-parse', '--verify', 'HEAD^{commit}'], undefined, input.targetPath), run(['config', '--local', '--get-all', 'remote.origin.url'], undefined, input.targetPath),
    ]);
    if (top.trim() !== input.targetPath || resolve(input.targetPath, common.trim()) !== gitDir || (head !== null && head.trim() !== input.expectedOid) || origin.trim() !== input.repoUrl) return fail('底座身份或提交已改变', 'conflict', false);
    return { topLevel: input.targetPath, commonDir: gitDir, identity: await plannedRepositoryIdentity(input.targetPath, gitDir, gitDir), oid: input.expectedOid, managedRoot };
  };
  return {
    resolvePlannedBase(input: ResolvePlannedBaseInput): Promise<Result<ResolvedPlannedBase, DomainError>> { return result(async () => {
      validate(input, true); const { managedRoot } = await root(); return { managedRoot, ...await advertised(input, managedRoot) };
    }); },
    preparePlannedBase(input: PreparePlannedBaseInput): Promise<Result<PreparedPlannedBase, DomainError>> { let beforeMutation = true; return result(async () => {
      validate(input, false);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.operationId) || !oidPattern.test(input.expectedOid)) return fail('操作标识或提交不合法');
      const { managedRoot, proof } = await root();
      const bases = join(managedRoot, 'bases');
      if (input.targetPath !== join(bases, input.operationId)) return fail('目标路径不匹配操作标识');
      const receiptPath = join(proof, `base-${input.operationId}.json`);
      const initial: Receipt = { version: 2, operationId: input.operationId, targetPath: input.targetPath, urlHash: urlHash(input.repoUrl), startRef: input.startRef, oid: input.expectedOid };
      const same = (x: Receipt) => x.version === 2 && x.operationId === initial.operationId && x.targetPath === initial.targetPath && x.urlHash === initial.urlHash && x.startRef === initial.startRef && x.oid === initial.oid;
      return withOperationLock(receiptPath, async () => {
      let receipt: Receipt | undefined;
      try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Receipt; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return fail('无法读取操作凭据', 'conflict', false); }
      if (receipt) {
        if (!same(receipt)) return fail('操作凭据与计划不匹配', 'conflict', false);
        return inspect({ ...input, reconcileOnly: true }, receipt, managedRoot);
      }
      if (input.reconcileOnly) return fail('没有可核对的操作凭据', 'conflict', false);
      validate(input, true);
      const current = await advertised(input, managedRoot);
      if (current.startRef !== input.startRef || current.oid !== input.expectedOid) return fail('远端起点已改变，需要重新确认', 'conflict', false);
      beforeMutation = false;
      let file;
      try { file = await open(receiptPath, 'wx', 0o600); } catch { return fail('操作已存在，必须先对账', 'conflict', false); }
      try {
        await file.writeFile(JSON.stringify(initial)); await file.sync();
        const proofDir = await open(proof, 'r'); try { await proofDir.sync(); } finally { await proofDir.close(); }
      try { await mkdir(bases, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      const baseStat = await lstat(bases);
      if (await realpath(bases) !== bases || await check(bases) !== null || !baseStat.isDirectory() || baseStat.uid !== process.getuid?.() || (baseStat.mode & 0o077) !== 0) return fail('底座根目录不安全');
        const staging = await mkdtemp(join(bases, `.stage-${input.operationId}-`));
        const clone = join(staging, 'repo');
        try { await run(['clone', '--no-local', '--no-hardlinks', '--no-checkout', '--no-tags', '--single-branch', '--branch', input.startRef.slice('refs/heads/'.length), '--', input.repoUrl, clone], input.auth, managedRoot); }
        catch { return fail('底座克隆失败，需对账', 'unavailable', false); }
        const after = await advertised(input, managedRoot);
        if (after.oid !== input.expectedOid || after.startRef !== input.startRef) return fail('远端起点已改变，需要重新确认', 'conflict', false);
        const head = (await run(['rev-parse', '--verify', 'HEAD^{commit}'], undefined, clone)).trim();
        const origin = (await run(['config', '--local', '--get-all', 'remote.origin.url'], undefined, clone)).trim();
        if (head !== input.expectedOid || origin !== input.repoUrl) return fail('克隆内容与确认计划不匹配', 'conflict', false);
        await run(['-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', input.expectedOid], undefined, clone);
        const receipt: Receipt = { ...initial, physical: await physicalIdentity(clone, input.targetPath) };
        await file.truncate(0); await file.write(JSON.stringify(receipt), 0, 'utf8'); await file.sync();
        // GNU mv uses a no-replace rename; verify the published inode and that the source moved.
        await new Promise<void>((res, rej) => execFile('mv', ['--no-clobber', '--no-target-directory', '--', clone, input.targetPath], { timeout: 10_000 }, (err) => err ? rej(err) : res()));
        if (await lstat(clone).then(() => true, () => false)) return fail('目标已存在，未发布底座', 'conflict', false);
        const basesDir = await open(bases, 'r'); try { await basesDir.sync(); } finally { await basesDir.close(); }
        return inspect(input, receipt, managedRoot);
      } finally { await file.close(); }
      });
    }, () => beforeMutation); },
  };
}
