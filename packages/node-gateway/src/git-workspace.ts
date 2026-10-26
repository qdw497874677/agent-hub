import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { DomainError, GitStatus, Result, WorkspaceGit } from '@agent-hub/domain';
import { conflict, folderNameProblem, invalid, unavailable, unsavedReason } from '@agent-hub/domain';

/**
 * WorkspaceGit 的 git 实现（simple-git，跑这台机器上的 git 和它自己的凭据）。
 * `check` 是这台机器的目录边界：返回 null = 允许，否则是给人看的原因。
 * hub 本机传「全部允许」；Worker 传 WORKER_ROOTS 的 realpath 检查。
 */
export function createGitWorkspace(check: (path: string) => Promise<string | null> = async () => null): WorkspaceGit {
  const guard = async (path: string): Promise<DomainError | null> => {
    if (!path.startsWith('/')) return invalid('目录必须是绝对路径');
    const problem = await check(path);
    return problem === null ? null : invalid(problem);
  };
  const exists = async (path: string) => (await lstat(path).catch(() => null))?.isDirectory() ?? false;
  const failed = (what: string, error: unknown): Result<never, DomainError> => ({
    ok: false,
    error: unavailable(`${what}失败：${gitMessage(error)}`)
  });

  return {
    async inspect(path) {
      const blocked = await guard(path);
      if (blocked) return { ok: false, error: blocked };
      if (!(await exists(path))) return { ok: true, value: { exists: false, isGit: false, remoteUrl: null, branch: null } };
      const git = simpleGit(path);
      const isGit = await git.checkIsRepo().catch(() => false);
      if (!isGit) return { ok: true, value: { exists: true, isGit: false, remoteUrl: null, branch: null } };
      const remoteUrl = (await git.remote(['get-url', 'origin']).catch(() => '')) || '';
      return { ok: true, value: { exists: true, isGit: true, remoteUrl: remoteUrl.trim() || null, branch: await currentBranch(git) } };
    },

    async clone({ repoUrl, parent, name, branch }) {
      const problem = folderNameProblem(name);
      if (problem !== null) return { ok: false, error: invalid(problem) };
      const blocked = await guard(parent);
      if (blocked) return { ok: false, error: blocked };
      const target = join(resolve(parent), name);
      if (await lstat(target).catch(() => null)) return { ok: false, error: conflict(`「${target}」已经存在`) };
      try {
        await mkdir(parent, { recursive: true });
        // 不让 git 弹交互式密码提示把进程挂住：没凭据就直接失败，原因回给人看
        await networkGit(parent).clone(repoUrl, name, branch ? ['--branch', branch] : []);
      } catch (error) {
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
        return failed('下载仓库', error);
      }
      return { ok: true, value: { path: target, branch: await currentBranch(simpleGit(target)) } };
    },

    async addWorktree({ repoPath, path, branch, base }) {
      for (const place of [repoPath, dirname(path)]) {
        const blocked = await guard(place);
        if (blocked) return { ok: false, error: blocked };
      }
      if (await lstat(path).catch(() => null)) return { ok: false, error: conflict(`「${path}」已经存在`) };
      const git = networkGit(repoPath);
      if (!(await git.checkIsRepo().catch(() => false))) return { ok: false, error: invalid(`「${repoPath}」不是 git 仓库`) };
      const remotes = await git.getRemotes().catch(() => []);
      const hasOrigin = remotes.some((remote) => remote.name === 'origin');
      if (hasOrigin) await git.fetch('origin').catch(() => undefined); // 离线也能开分支，只是基于本地的
      const local = await git.raw(['branch', '--list', branch]).catch(() => '');
      if (local.trim() !== '') return { ok: false, error: conflict(`分支 ${branch} 已经存在：改用已有的那个工作空间`) };
      const remoteHas = hasOrigin && (await git.raw(['branch', '-r', '--list', `origin/${branch}`]).catch(() => '')).trim() !== '';
      const from = remoteHas ? `origin/${branch}` : base || 'HEAD';
      try {
        await mkdir(dirname(path), { recursive: true });
        await git.raw(['worktree', 'add', '--no-track', '-b', branch, path, from]);
      } catch (error) {
        return failed('新开分支', error);
      }
      return { ok: true, value: { path, branch } };
    },

    async status(path) {
      const blocked = await guard(path);
      if (blocked) return { ok: false, error: blocked };
      if (!(await exists(path))) return { ok: false, error: unavailable(`目录不存在：${path}`) };
      try {
        return { ok: true, value: await statusOf(path) };
      } catch (error) {
        return failed('检查改动', error);
      }
    },

    async remove(path, kind, options) {
      const blocked = await guard(path);
      if (blocked) return { ok: false, error: blocked };
      if (!(await exists(path))) return { ok: true, value: { removed: true } }; // 已经没了：登记可以收掉
      if (options?.force) {
        // 人二次确认过「这些改动不要了」：worktree 用 --force 摘掉（分支和已提交的仍在主仓库里），目录整个删
        try {
          const common = kind === 'worktree' ? (await simpleGit(path).raw(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim() : null;
          if (common) await simpleGit(dirname(common)).raw(['worktree', 'remove', '--force', path]);
          else await rm(path, { recursive: true, force: true });
        } catch (error) {
          return failed('删除工作空间', error);
        }
        return { ok: true, value: { removed: true } };
      }
      let status: GitStatus;
      try {
        status = await statusOf(path);
      } catch (error) {
        return failed('检查改动', error);
      }
      const reason = keepReason(status);
      if (kind === 'worktree') {
        if (status.dirty === null) return { ok: false, error: invalid(`「${path}」不是 git worktree`) };
        if (reason) return { ok: true, value: { removed: false, reason } };
        try {
          const common = (await simpleGit(path).raw(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
          await simpleGit(dirname(common)).raw(['worktree', 'remove', path]); // 不加 --force；分支保留
        } catch (error) {
          return failed('删除工作空间', error);
        }
        return { ok: true, value: { removed: true } };
      }
      // 非 git 的临时目录：平台看不出哪些东西要紧，只有空目录才删
      if (status.dirty === null) {
        const entries = await readdir(path).catch(() => ['?']);
        if (entries.length > 0) return { ok: true, value: { removed: false, reason: '不是 git 目录，里面还有文件，平台不确定能不能删' } };
      } else if (reason) {
        return { ok: true, value: { removed: false, reason } };
      }
      await rm(path, { recursive: true, force: true });
      return { ok: true, value: { removed: true } };
    }
  };
}

/** 机器自己的 git 凭据要用到的变量（ssh agent、自定义 ssh 命令、askpass、代理），其余 GIT_* 不放行。 */
const CREDENTIAL_ENV = ['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GIT_TERMINAL_PROMPT'] as const;
const PASS_THROUGH = ['PATH', 'HOME', 'USER', 'LANG', 'SSH_AUTH_SOCK', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'];

/** 要走网络的 git（clone / fetch）：不许弹交互式密码提示把进程挂住，没凭据就直接失败。 */
function networkGit(baseDir: string): SimpleGit {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  for (const key of [...PASS_THROUGH, ...CREDENTIAL_ENV.slice(0, 3)]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return simpleGit({ baseDir, allowEnvironment: CREDENTIAL_ENV }).env(env);
}

/** 有什么会丢就说什么；都没有返回 null（规则在领域里，和自动清理同一套）。 */
export const keepReason = unsavedReason;

async function statusOf(path: string): Promise<GitStatus> {
  const git = simpleGit(path);
  if (!(await git.checkIsRepo().catch(() => false))) {
    return { dirty: null, untracked: 0, unpushed: 0, branch: null, upstream: null };
  }
  const status = await git.status();
  const untracked = status.not_added.length;
  const dirty = status.files.length - untracked > 0;
  const branch = await currentBranch(git);
  // 只在这个分支上、其它分支和远端都没有的提交：这些才是删了就找不回来的
  // 跟在 --branches 前面的 --exclude 不带 refs/heads/ 前缀
  const exclude = branch ? [`--exclude=${branch}`] : [];
  const lonely = await git
    .raw(['rev-list', '--count', 'HEAD', '--not', ...exclude, '--branches', '--remotes'])
    .catch(() => '0');
  return { dirty, untracked, unpushed: Number(lonely.trim()) || 0, branch, upstream: status.tracking ?? null };
}

async function currentBranch(git: SimpleGit): Promise<string | null> {
  const name = (await git.raw(['branch', '--show-current']).catch(() => '')).trim();
  return name || null;
}

function gitMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // git 的报错可能带上 URL 里的凭据：抹掉 user:token@
  return text.replace(/\/\/[^/@\s]+@/g, '//***@').trim().split('\n').slice(0, 3).join(' ');
}
