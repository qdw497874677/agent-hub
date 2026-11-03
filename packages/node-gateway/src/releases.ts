import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execRunner, HUB_BUNDLE_REF } from './updater.ts';
import type { CommandRunner, UpdateReport } from './updater.ts';
import { rollbackNotePath } from './boot-marker.ts';

/**
 * Worker 的 releases 布局（ADR 0030 D2，P5）：
 *
 *   <root>/releases/<40位提交>/   不可变，一次装好（git 检出 + npm ci）
 *   <root>/current  -> 正在跑的版本
 *   <root>/previous -> 上一个已提交的版本（第一次迁移时是原来的 git 工作区，原样保留）
 *   <root>/state/update.json      {id, previous, target, phase, boots, startedAt}
 *
 * staging → preflight → publish（切 symlink）→ 重启进 trial → hub 握手 update_commit 才算数；
 * 没通过（hub 发 update_abort，或启动守卫数到 boots > 2）就把 current 切回 previous，不重装依赖。
 * 只在 HUB_WORKER_UPDATE_MODE=releases 时用；默认还是原地更新（legacy）。
 */
export type ReleasePhase = 'trial' | 'committed' | 'rolled_back';

export interface UpdateStateFile {
  readonly id: string;
  readonly previous: string;
  readonly target: string;
  readonly phase: ReleasePhase;
  readonly boots: number;
  readonly startedAt: number;
}

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[a-z0-9-]{1,64}$/;

export const defaultReleasesRoot = (home: string): string => join(home, '.local', 'share', 'agent-hub', 'worker');

const paths = (root: string) => ({
  releases: join(root, 'releases'),
  current: join(root, 'current'),
  previous: join(root, 'previous'),
  state: join(root, 'state', 'update.json')
});

/** 写临时文件 + fsync + rename：断电也只会看到旧的或新的。 */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/** 原子地把 link 指向 target（先建临时 symlink 再 rename 盖过去）。 */
function pointLink(link: string, target: string): void {
  const tmp = `${link}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}

/** 格式固定、单行：scripts/worker-boot-guard.sh 用 sed 读它。 */
export function formatUpdateState(state: UpdateStateFile): string {
  return `{"id":"${state.id}","previous":"${state.previous}","target":"${state.target}","phase":"${state.phase}","boots":${state.boots},"startedAt":${state.startedAt}}\n`;
}

export function readUpdateState(root: string): UpdateStateFile | null {
  try {
    const raw = JSON.parse(readFileSync(paths(root).state, 'utf8')) as Partial<UpdateStateFile>;
    if (!raw.id || !ID.test(raw.id) || !raw.target || !SHA.test(raw.target) || !raw.previous || !SHA.test(raw.previous)) return null;
    if (raw.phase !== 'trial' && raw.phase !== 'committed' && raw.phase !== 'rolled_back') return null;
    return { id: raw.id, previous: raw.previous, target: raw.target, phase: raw.phase, boots: Number(raw.boots) || 0, startedAt: Number(raw.startedAt) || 0 };
  } catch {
    return null;
  }
}

export function writeUpdateState(root: string, state: UpdateStateFile): void {
  mkdirSync(join(root, 'state'), { recursive: true });
  writeAtomic(paths(root).state, formatUpdateState(state));
}

const resolveLink = (link: string): string | null => {
  try {
    return realpathSync(link);
  } catch {
    return null;
  }
};

/** current 指向的 releases/<sha> 的提交号；还没迁移（没有 current）或指到别处返回 null。 */
export function currentRelease(root: string): string | null {
  const real = resolveLink(paths(root).current);
  if (!real) return null;
  const name = basename(real);
  return SHA.test(name) && existsSync(join(paths(root).releases, name)) ? name : null;
}

/** 正在跑的就是 update.json 里 trial 的目标：hello 里带上 update:{id, phase:'trial'}。 */
export function trialInProgress(root: string, runningDir: string): UpdateStateFile | null {
  const state = readUpdateState(root);
  if (!state || state.phase !== 'trial') return null;
  const real = resolveLink(runningDir);
  return real && basename(real) === state.target && resolveLink(paths(root).current) === real ? state : null;
}

export interface ReleaseUpdateOptions {
  readonly root: string;
  /** 正在跑的代码目录（迁移时它就是 previous）。必须是 git 检出。 */
  readonly runningDir: string;
  /** 正在跑的提交。 */
  readonly runningCommit: string;
  readonly commit: string;
  readonly report: (status: UpdateReport) => void;
  readonly run?: CommandRunner;
  readonly fetchBundle?: (commit: string) => Promise<string | null>;
  readonly installArgs?: readonly string[];
  /** preflight 用的 node（默认当前进程的）。 */
  readonly node?: string;
  readonly now?: () => number;
}

const LOG_LIMIT = 4000;

/**
 * staging + preflight + publish。返回 true = current 已切到新版本、update.json 已写 trial，调用方退出重启。
 * 换上之前任何一步失败都只删 staging，current / previous 一点不动。
 */
export async function runReleaseUpdate(options: ReleaseUpdateOptions): Promise<boolean> {
  const run = options.run ?? execRunner;
  const p = paths(options.root);
  let log = '';
  const report = (state: UpdateReport['state'], message: string): void => options.report({ state, message, logTail: log.slice(-LOG_LIMIT) });
  const step = async (command: string, args: readonly string[], cwd: string): Promise<boolean> => {
    log += `$ ${command} ${args.join(' ')}\n`;
    const result = await run(command, args, cwd);
    log += result.output.endsWith('\n') || result.output === '' ? result.output : `${result.output}\n`;
    return result.code === 0;
  };
  const target = options.commit;
  if (!SHA.test(target) || !SHA.test(options.runningCommit)) {
    report('refused', '目标提交号不合法');
    return false;
  }
  if (currentRelease(options.root) === target) {
    report('succeeded', `已是目标版本 ${target.slice(0, 7)}，无需更新`);
    return false;
  }
  const pending = readUpdateState(options.root);
  if (pending?.phase === 'trial') {
    report('refused', `上一次更新 ${pending.target.slice(0, 7)} 还在试运行，等它提交或回退后再更新`);
    return false;
  }
  mkdirSync(p.releases, { recursive: true });
  const release = join(p.releases, target);
  if (!existsSync(release)) {
    const staging = join(p.releases, `.staging-${randomBytes(4).toString('hex')}`);
    const abandon = (why: string): false => {
      rmSync(staging, { recursive: true, force: true });
      report('failed', `${why}，没有改动当前版本`);
      return false;
    };
    report('updating', `在 releases 里准备 ${target.slice(0, 7)}（不动正在跑的版本）`);
    // 从正在跑的检出克隆（本地、快）；缺的提交先从 hub 的 bundle 取，取不到再 git fetch origin
    if (!(await step('git', ['clone', '--quiet', '--no-checkout', options.runningDir, staging], options.root))) return abandon('克隆代码失败');
    // staging 的 origin 跟正在跑的那份一致（GitHub 等），不留成本地路径：以后的版本还要从它 fetch
    const origin = await run('git', ['remote', 'get-url', 'origin'], options.runningDir);
    const originUrl = origin.code === 0 ? origin.output.trim() : '';
    if (originUrl) await step('git', ['remote', 'set-url', 'origin', originUrl], staging);
    let have = await step('git', ['cat-file', '-e', `${target}^{commit}`], staging);
    if (!have && options.fetchBundle) {
      const bundle = await options.fetchBundle(target).catch(() => null);
      if (bundle) have = (await step('git', ['fetch', '--quiet', bundle, `+${HUB_BUNDLE_REF}:${HUB_BUNDLE_REF}`], staging)) && (await step('git', ['cat-file', '-e', `${target}^{commit}`], staging));
    }
    if (!have && originUrl) have = (await step('git', ['fetch', '--quiet', 'origin'], staging)) && (await step('git', ['cat-file', '-e', `${target}^{commit}`], staging));
    if (!have) return abandon(`取不到提交 ${target.slice(0, 7)}`);
    if (!(await step('git', ['checkout', '--quiet', '--detach', target], staging))) return abandon('检出失败');
    report('updating', '安装依赖（npm ci）');
    if (!(await step('npm', options.installArgs ?? ['ci', '--omit=dev', '--no-audit', '--no-fund'], staging))) return abandon('npm ci 失败');
    report('updating', '预检（--selfcheck）');
    if (!(await step(options.node ?? process.execPath, ['apps/worker/src/selfcheck.ts'], staging))) return abandon('预检失败');
    try {
      renameSync(staging, release);
    } catch (error) {
      return abandon(`发布失败（${(error as Error).message}）`);
    }
  }
  // publish：previous = 正在跑的（第一次迁移时就是原来的工作区），current = 新版本
  const running = resolveLink(options.runningDir) ?? options.runningDir;
  pointLink(p.previous, running);
  writeUpdateState(options.root, {
    id: `${(options.now ?? Date.now)().toString(36)}-${randomBytes(3).toString('hex')}`,
    previous: options.runningCommit,
    target,
    phase: 'trial',
    boots: 0,
    startedAt: (options.now ?? Date.now)()
  });
  pointLink(p.current, release);
  report('updating', `已换上 ${target.slice(0, 7)}，重启后试运行（hub 观察 60 秒稳定再提交）`);
  return true;
}

/** hub 说试运行通过：记 committed，清理更早的版本（只留 current、previous 和最多 1 个更早的）。 */
export function commitRelease(root: string, id: string): boolean {
  const state = readUpdateState(root);
  if (!state || state.id !== id || state.phase !== 'trial') return false;
  writeUpdateState(root, { ...state, phase: 'committed' });
  pruneReleases(root);
  return true;
}

export function pruneReleases(root: string, keepExtra = 1): string[] {
  const p = paths(root);
  const keep = new Set([resolveLink(p.current), resolveLink(p.previous)].filter((entry): entry is string => entry !== null));
  let entries: { dir: string; mtime: number }[] = [];
  try {
    entries = readdirSync(p.releases)
      .filter((name) => SHA.test(name))
      .map((name) => join(p.releases, name))
      .filter((dir) => !keep.has(resolveLink(dir) ?? dir))
      .map((dir) => ({ dir, mtime: statSync(dir).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
  const removed = entries.slice(keepExtra).map((entry) => entry.dir);
  for (const dir of removed) rmSync(dir, { recursive: true, force: true });
  return removed;
}

/**
 * hub 说试运行没通过：current 切回 previous，写回退记录（旧版连上后补报 rolled_back）。返回 true = 调用方退出重启。
 */
export function abortRelease(root: string, stateDir: string, id: string, reason: string): boolean {
  const state = readUpdateState(root);
  if (!state || state.id !== id || state.phase !== 'trial') return false;
  const p = paths(root);
  const previous = resolveLink(p.previous);
  if (!previous || !existsSync(join(previous, 'apps', 'worker', 'src', 'main.ts'))) return false;
  pointLink(p.current, previous);
  writeUpdateState(root, { ...state, phase: 'rolled_back' });
  mkdirSync(stateDir, { recursive: true });
  writeAtomic(rollbackNotePath(stateDir), `${state.target} ${state.previous}\nhub 判定试运行没通过：${reason.slice(0, 300)}。已把 current 切回 ${state.previous.slice(0, 7)}（没重装依赖）。\n`);
  return true;
}

/** 给测试用：读 link 指向（不解析多层）。 */
export const linkTarget = (link: string): string | null => {
  try {
    return readlinkSync(link);
  } catch {
    return null;
  }
};
