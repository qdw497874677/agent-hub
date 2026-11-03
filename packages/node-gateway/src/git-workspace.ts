import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { execFile } from 'node:child_process';
import type { CommitPreview, DomainError, GitStatus, RemotePullRequest, Result, WorkspaceGit } from '@agent-hub/domain';
import { conflict, folderNameProblem, invalid, nonGitReason, unavailable, unsavedReason } from '@agent-hub/domain';

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
      // 目标可以是空目录（人在目录选择器里刚「新建文件夹」的），git 本来就能 clone 进空目录
      const before = await lstat(target).catch(() => null);
      const emptyDir = before?.isDirectory() === true && (await readdir(target).catch(() => ['?'])).length === 0;
      if (before && !emptyDir) return { ok: false, error: conflict(`「${target}」已经存在且不是空目录`) };
      try {
        await mkdir(parent, { recursive: true });
        // 不让 git 弹交互式密码提示把进程挂住：没凭据就直接失败，原因回给人看
        await networkGit(parent).clone(repoUrl, name, branch ? ['--branch', branch] : []);
      } catch (error) {
        // 失败要还原：本来没有就删掉，本来是空目录就清回空目录
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
        if (emptyDir) await mkdir(target, { recursive: true }).catch(() => undefined);
        return failed('下载仓库', error);
      }
      return { ok: true, value: { path: target, branch: await currentBranch(simpleGit(target)) } };
    },

    async addWorktree({ repoPath, path, branch, base, existing }) {
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
      if (existing) {
        // 沿用原分支：本地有就直接检出（它不能正被别的 worktree 占着，git 会拒）；只有远端有就建跟踪分支
        const remoteOnly = local.trim() === '' && hasOrigin;
        try {
          await mkdir(dirname(path), { recursive: true });
          if (remoteOnly) await git.raw(['worktree', 'add', '--track', '-b', branch, path, `origin/${branch}`]);
          else await git.raw(['worktree', 'add', path, branch]);
        } catch (error) {
          return failed('检出分支', error);
        }
        return { ok: true, value: { path, branch } };
      }
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

    async saveWip(path, message) {
      const blocked = await guard(path);
      if (blocked) return { ok: false, error: blocked };
      if (!(await exists(path))) return { ok: false, error: unavailable(`目录不存在：${path}`) };
      const git = networkGit(path);
      if (!(await git.checkIsRepo().catch(() => false))) return { ok: true, value: { committed: false, pushed: false, branch: null, reason: '不是 git 仓库' } };
      try {
        // symbolic-ref 在还没有提交的新仓库上也能用；detached HEAD 时失败
        const branch = (await git.raw(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
        if (branch === '') return { ok: true, value: { committed: false, pushed: false, branch: null, reason: '当前不在任何分支上（detached HEAD）' } };
        await git.raw(['add', '-A']);
        const staged = (await git.raw(['diff', '--cached', '--name-only'])).trim() !== '';
        if (staged) await git.raw(['-c', 'user.name=Agent Hub', '-c', 'user.email=agent-hub@localhost', 'commit', '--no-verify', '-m', message]);
        const remotes = await git.getRemotes().catch(() => []);
        if (!remotes.some((remote) => remote.name === 'origin')) return { ok: true, value: { committed: staged, pushed: false, branch, reason: '没有 origin 远端' } };
        try {
          await git.raw(['push', '-u', 'origin', branch]);
        } catch (error) {
          return { ok: true, value: { committed: staged, pushed: false, branch, reason: `推送失败：${String((error as Error).message ?? error).split('\n')[0]}` } };
        }
        return { ok: true, value: { committed: staged, pushed: true, branch, reason: null } };
      } catch (error) {
        return failed('提交 WIP', error);
      }
    },

    async preview(path, maxPatchBytes) {
      const blocked = await guard(path);
      if (blocked) return { ok: false, error: blocked };
      if (!(await exists(path))) return { ok: false, error: unavailable(`目录不存在：${path}`) };
      try {
        return { ok: true, value: await previewOf(path, maxPatchBytes) };
      } catch (error) {
        return failed('读取改动', error);
      }
    },

    async commit(path, { message, authorName, authorEmail }) {
      const blocked = await guard(path);
      if (blocked) return { ok: false, error: blocked };
      if (!message.trim()) return { ok: false, error: invalid('提交说明不能为空') };
      const git = simpleGit(path);
      try {
        const branch = (await git.raw(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
        if (branch === '') return { ok: true, value: { committed: false, sha: null, reason: '当前不在任何分支上（detached HEAD）' } };
        await git.raw(['add', '-A']);
        if ((await git.raw(['diff', '--cached', '--name-only'])).trim() === '') return { ok: true, value: { committed: false, sha: null, reason: '没有要提交的改动' } };
        // author = 操作人；committer 用机器自己的 git 身份，没配就退回 author
        const ident = await git.raw(['config', 'user.email']).catch(() => '');
        const fallback = ident.trim() ? [] : ['-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`];
        await git.raw([...fallback, 'commit', '--no-verify', `--author=${authorName.replace(/[<>\n]/g, '')} <${authorEmail.replace(/[<>\s]/g, '')}>`, '-m', message]);
        return { ok: true, value: { committed: true, sha: (await git.revparse(['HEAD'])).trim(), reason: null } };
      } catch (error) {
        return { ok: true, value: { committed: false, sha: null, reason: gitMessage(error) } };
      }
    },

    async push(path) {
      const blocked = await guard(path);
      if (blocked) return { ok: false, error: blocked };
      const git = networkGit(path);
      const branch = (await git.raw(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim() || null;
      if (!branch) return { ok: true, value: { pushed: false, branch: null, reason: '当前不在任何分支上（detached HEAD）' } };
      const remotes = await git.getRemotes().catch(() => []);
      if (!remotes.some((remote) => remote.name === 'origin')) return { ok: true, value: { pushed: false, branch, reason: '没有 origin 远端' } };
      try {
        await git.raw(['push', '-u', 'origin', branch]);
        return { ok: true, value: { pushed: true, branch, reason: null } };
      } catch (error) {
        return { ok: true, value: { pushed: false, branch, reason: gitMessage(error) } };
      }
    },

    async gh(path, request) {
      const blocked = await guard(path);
      if (blocked) return { ok: false, error: blocked };
      const run = (args: string[]) => runGh(path, args);
      if (request.action === 'create') {
        const created = await run(['pr', 'create', '--base', request.base, '--head', request.head, '--title', request.title, '--body', request.body]);
        if (!created.ok) return { ok: true, value: created };
        const url = created.out.trim().split('\n').map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l)).at(-1);
        if (!url) return { ok: true, value: { ok: false, reason: 'gh 没有返回 PR 链接' } };
        const viewed = await viewPr(run, url);
        return { ok: true, value: viewed.ok ? viewed : { ok: true, pr: { number: Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0), url, state: 'open', headSha: null, mergedAt: null } } };
      }
      return { ok: true, value: await viewPr(run, String(request.number)) };
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
      // PR 已合并（含 squash）且 HEAD 就是 PR 的 head：这些「只在本分支」的提交已经进了主干
      const merged = options?.mergedHead && status.head === options.mergedHead;
      const reason = keepReason(merged ? { ...status, unpushed: 0 } : status);
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
        const files = status.files ?? (await countFiles(path));
        const entries = await readdir(path).catch(() => ['?']);
        if (files > 0 || entries.length > 0) return { ok: true, value: { removed: false, reason: files > 0 ? nonGitReason(files) : '不是 git 仓库，目录不是空的（还有空文件夹），先留着' } };
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

type GhRun = (args: string[]) => Promise<{ ok: true; out: string } | { ok: false; reason: string }>;

/** 跑这台机器上已登录的 gh：不交互、60 秒；没装 / 没登录都翻成 ok:false + 原因（原因里抹掉凭据）。 */
function runGh(cwd: string, args: string[]): ReturnType<GhRun> {
  const env: Record<string, string> = { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' };
  for (const key of [...PASS_THROUGH, 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return new Promise((done) => {
    execFile('gh', args, { cwd, env, timeout: 60_000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (!error) return done({ ok: true, out: String(stdout) });
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return done({ ok: false, reason: '这台机器上没有 gh' });
      done({ ok: false, reason: gitMessage(String(stderr || error.message)) || 'gh 失败' });
    });
  });
}

async function viewPr(run: GhRun, ref: string): Promise<{ ok: true; pr: RemotePullRequest } | { ok: false; reason: string }> {
  const viewed = await run(['pr', 'view', ref, '--json', 'number,url,state,headRefOid,mergedAt']);
  if (!viewed.ok) return viewed;
  try {
    const o = JSON.parse(viewed.out) as { number: number; url: string; state: string; headRefOid?: string; mergedAt?: string | null };
    const state = o.state === 'MERGED' ? 'merged' : o.state === 'CLOSED' ? 'closed' : 'open';
    return { ok: true, pr: { number: o.number, url: o.url, state, headSha: o.headRefOid ?? null, mergedAt: o.mergedAt ? Date.parse(o.mergedAt) : null } };
  } catch {
    return { ok: false, reason: 'gh 返回的不是 JSON' };
  }
}

const STATUS_OF: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'added', T: 'modified', '?': 'untracked' };

async function previewOf(path: string, maxPatchBytes: number): Promise<CommitPreview> {
  const git = simpleGit(path);
  const empty: CommitPreview = { isGit: false, branch: null, defaultBranch: null, remoteUrl: null, upstream: null, ahead: 0, head: null, files: [], patch: '', truncated: false };
  if (!(await git.checkIsRepo().catch(() => false))) return empty;
  const branch = await currentBranch(git);
  // 读配置里的原始 URL，不用 get-url（它会套 insteadOf 改写，认不出 GitHub）
  const remoteUrl = ((await git.raw(['config', '--get', 'remote.origin.url']).catch(() => '')) || '').trim() || null;
  const head = (await git.raw(['rev-parse', '-q', '--verify', 'HEAD']).catch(() => '')).trim() || null;
  let defaultBranch = (await git.raw(['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']).catch(() => '')).trim().replace(/^origin\//, '') || null;
  if (!defaultBranch) {
    for (const name of ['main', 'master']) {
      const has = (await git.raw(['rev-parse', '-q', '--verify', `refs/heads/${name}`]).catch(() => '')).trim() || (await git.raw(['rev-parse', '-q', '--verify', `refs/remotes/origin/${name}`]).catch(() => '')).trim();
      if (has) {
        defaultBranch = name;
        break;
      }
    }
  }
  const upstream = (await git.raw(['rev-parse', '--abbrev-ref', '-q', '@{upstream}']).catch(() => '')).trim() || null;
  const against = upstream ?? (defaultBranch && remoteUrl ? `origin/${defaultBranch}` : null);
  const ahead = head && against ? Number((await git.raw(['rev-list', '--count', `${against}..HEAD`]).catch(() => '0')).trim()) || 0 : 0;
  // D7：未跟踪文件也算（强制 normal，不受仓库配置影响）
  const porcelain = await git.raw(['-c', 'status.showUntrackedFiles=normal', 'status', '--porcelain=v1', '-z']);
  const files: { path: string; status: string }[] = [];
  const parts = porcelain.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const code = xy === '??' ? '?' : (xy[0] !== ' ' ? xy[0]! : xy[1]!);
    files.push({ path: entry.slice(3), status: STATUS_OF[code] ?? 'modified' });
    if (xy[0] === 'R' || xy[0] === 'C') i++; // -z 下重命名的旧名单独一段
  }
  let patch = '';
  let truncated = false;
  if (maxPatchBytes > 0 && files.length > 0) {
    // 只看不写：已跟踪的 diff 对 HEAD；未跟踪的只列名字（内容进不了模型，免得把大文件 / 密钥送出去）
    const raw = head ? await git.raw(['diff', '--no-color', '--no-ext-diff', 'HEAD']).catch(() => '') : '';
    const untracked = files.filter((f) => f.status === 'untracked').map((f) => `新文件：${f.path}`).join('\n');
    const all = [raw, untracked].filter(Boolean).join('\n');
    const bytes = Buffer.from(all);
    truncated = bytes.length > maxPatchBytes;
    patch = truncated ? bytes.subarray(0, maxPatchBytes).toString('utf8') : all;
  }
  return { isGit: true, branch, defaultBranch, remoteUrl, upstream, ahead, head, files, patch, truncated };
}

/** 有什么会丢就说什么；都没有返回 null（规则在领域里，和自动清理同一套）。 */
export const keepReason = unsavedReason;

async function statusOf(path: string): Promise<GitStatus> {
  const git = simpleGit(path);
  // 只认「自己就是仓库根」的目录：非 git 临时目录常建在某个仓库里面（Worker 根目录本身是仓库），
  // 这时 git 看到的是外层仓库——外层干净不代表这个目录里没东西，按非 git 目录处理
  if (!(await git.checkIsRepo().catch(() => false)) || !(await ownRepo(git, path))) {
    return { dirty: null, untracked: 0, unpushed: 0, branch: null, upstream: null, files: await countFiles(path), sizeBytes: await sizeOf(path) };
  }
  // 强制 normal：用户全局设 status.showUntrackedFiles=no 时也要看见未跟踪文件（D7）
  const status = await simpleGit(path, { config: ['status.showUntrackedFiles=normal'] }).status();
  const untracked = status.not_added.length;
  const dirty = status.files.length - untracked > 0;
  const branch = await currentBranch(git);
  // 只在这个分支上、其它分支和远端都没有的提交：这些才是删了就找不回来的
  // 跟在 --branches 前面的 --exclude 不带 refs/heads/ 前缀
  const exclude = branch ? [`--exclude=${branch}`] : [];
  const lonely = await git
    .raw(['rev-list', '--count', 'HEAD', '--not', ...exclude, '--branches', '--remotes'])
    .catch(() => '0');
  const head = (await git.raw(['rev-parse', 'HEAD']).catch(() => '')).trim() || null;
  return { dirty, untracked, unpushed: Number(lonely.trim()) || 0, branch, upstream: status.tracking ?? null, head, sizeBytes: await sizeOf(path) };
}

async function ownRepo(git: SimpleGit, path: string): Promise<boolean> {
  const top = (await git.raw(['rev-parse', '--show-toplevel']).catch(() => '')).trim();
  if (!top) return false;
  const [a, b] = await Promise.all([realpath(top).catch(() => top), realpath(path).catch(() => path)]);
  return a === b;
}

/** 非 git 目录里有几个文件（递归，不跟符号链接，封顶 10000）；读不了算 1（宁可留着）。 */
async function countFiles(path: string, cap = 10_000): Promise<number> {
  let n = 0;
  const walk = async (dir: string): Promise<void> => {
    if (n >= cap) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (n >= cap) return;
      if (entry.isDirectory()) await walk(join(dir, entry.name));
      else n += 1;
    }
  };
  try {
    await walk(path);
    return n;
  } catch {
    return Math.max(n, 1);
  }
}

/** 目录占用（du -sk，超时就不报）；只用于清理记录的展示。 */
function sizeOf(path: string): Promise<number | null> {
  return new Promise((done) => {
    execFile('du', ['-sk', path], { timeout: 10_000 }, (error, stdout) => {
      const kb = Number(String(stdout).split(/\s/)[0]);
      done(error || !Number.isFinite(kb) ? null : kb * 1024);
    });
  });
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
