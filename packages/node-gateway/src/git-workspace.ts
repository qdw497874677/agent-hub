import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { execFile } from 'node:child_process';
import type { CommitPreview, DomainError, GitAuth, GitStatus, ImportCommitInput, ImportCommitOutcome, PrepareDelegationWorktreeInput, PrepareDelegationWorktreeOutcome, PublishRefInput, PublishRefOutcome, RemotePullRequest, Result, WorkspaceGit } from '@agent-hub/domain';
import { conflict, folderNameProblem, invalid, isSensitivePath, nonGitReason, unavailable, unsavedReason } from '@agent-hub/domain';
import { insideGroups } from './group-dir.ts';
import { runSetupScript } from './setup-script.ts';

/**
 * WorkspaceGit 的 git 实现（simple-git，跑这台机器上的 git 和它自己的凭据）。
 * `check` 是这台机器的目录边界：返回 null = 允许，否则是给人看的原因。
 * hub 本机传「全部允许」；Worker 传 WORKER_ROOTS 的 realpath 检查。
 * 私有 HTTPS 仓库的令牌由 hub 解出、以 `auth` 逐次传来：只进进程环境变量，不进命令行 / 日志。
 */
export interface GitWorkspaceOptions {
  /**
   * ADR 0027 D10：新建 worktree 放哪。省略 = hub 给的默认位置（仓库旁 `.worktrees/<仓库名>/<目录名>`）；
   * 配了（Worker 的 WORKER_WORKTREES_DIR）= `<worktreesDir>/<仓库名>/<目录名>`。只影响新建：
   * 沿用原分支重建（existing）照旧用登记的路径，老记录是绝对路径不迁移。
   */
  readonly worktreesDir?: string;
  /**
   * 组合工作空间（docs/design/multi-repo.md §12.1）：`ws.new_worktree` 的成员目录只允许落在这下面。
   * 省略 = 这台 Worker 不支持组合工作空间。
   */
  readonly groupsDir?: string;
  /**
   * 仅测试用：允许 `publishRef` 发布到本地路径 / `file:` 的 origin（真实 bare 仓库测试）。
   * 不来自 Worker 环境变量，也不在 RPC 参数里；生产构造永远不设置。
   */
  readonly allowLocalPublishOrigin?: boolean;
}

/**
 * `git rev-parse --git-common-dir` 在 worktree 里经常印相对路径，而且是相对这个 worktree，不是相对进程的 cwd。
 * 按 cwd 做 dirname 会指到一个不存在的目录，simple-git 直接拒绝构造。
 * 绝对路径原样用；相对路径相对 worktree 解析。
 */
export function mainWorktreeDir(worktree: string, commonDirOutput: string): string {
  const raw = commonDirOutput.trim();
  if (raw === '') return worktree;
  const common = isAbsolute(raw) ? raw : resolve(worktree, raw);
  return dirname(common);
}

/** D10：hub 给的默认路径 → 这台 Worker 配置的位置（保留最后两段 `<仓库名>/<目录名>`）。 */
export function relocateWorktree(path: string, worktreesDir: string | undefined): string {
  if (!worktreesDir) return path;
  const parts = path.split('/').filter(Boolean);
  const name = parts.at(-1) ?? 'worktree';
  const repo = parts.at(-2) ?? 'repo';
  return join(resolve(worktreesDir), repo, name);
}

/**
 * 与 contract 的 `ws.import_commit` 同一规则：只允许专用命名空间，且末尾 SHA 必须等于要导入的 SHA。
 * Worker 不靠 hub 自觉；本地再按这条规则失败关闭。
 */
const IMPORT_REF_PATTERN = /^refs\/agent-hub\/imports\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([0-9a-f]{40})$/;

export function createGitWorkspace(check: (path: string) => Promise<string | null> = async () => null, options: GitWorkspaceOptions = {}): WorkspaceGit {
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

    async clone({ repoUrl, parent, name, branch, auth, recurseSubmodules }) {
      const problem = folderNameProblem(name);
      if (problem !== null) return { ok: false, error: invalid(problem) };
      const blocked = await guard(parent);
      if (blocked) return { ok: false, error: blocked };
      const target = join(resolve(parent), name);
      const binding = bindAuth(auth, repoUrl);
      if (!binding.ok) return { ok: false, error: invalid(binding.reason) };
      // 目标可以是空目录（人在目录选择器里刚「新建文件夹」的），git 本来就能 clone 进空目录
      const before = await lstat(target).catch(() => null);
      const emptyDir = before?.isDirectory() === true && (await readdir(target).catch(() => ['?'])).length === 0;
      if (before && !emptyDir) return { ok: false, error: conflict(`「${target}」已经存在且不是空目录`) };
      // 本地路径远端的子模块在 clone 后再 init（simple-git 不允许改 protocol.file.allow）。
      // 带令牌时不用 --recurse-submodules：子模块地址由仓库内容决定，不能继承这次凭据的环境。
      const recurseInClone = recurseSubmodules && !isLocalGitUrl(repoUrl) && !hasAuth(binding.auth);
      const flags = [...(branch ? ['--branch', branch] : []), ...(recurseInClone ? ['--recurse-submodules'] : [])];
      try {
        await mkdir(parent, { recursive: true });
        // 不让 git 弹交互式密码提示把进程挂住：没凭据就直接失败，原因回给人看
        await networkGit(parent, undefined, binding.auth, repoUrl).clone(repoUrl, name, flags);
      } catch (error) {
        // 失败要还原：本来没有就删掉，本来是空目录就清回空目录
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
        if (emptyDir) await mkdir(target, { recursive: true }).catch(() => undefined);
        return failed('下载仓库', error);
      }
      if (recurseSubmodules) {
        const sub = await initSubmodules(target);
        if (!sub.ok) {
          await rm(target, { recursive: true, force: true }).catch(() => undefined);
          if (emptyDir) await mkdir(target, { recursive: true }).catch(() => undefined);
          return sub;
        }
      }
      return { ok: true, value: { path: target, branch: await currentBranch(simpleGit(target)) } };
    },

    async checkRepo(repoUrl, branch, auth) {
      const url = repoUrl.trim();
      if (url === '') return { ok: true, value: { reachable: false, defaultBranch: null, branchExists: false, message: '仓库地址不能为空' } };
      const binding = bindAuth(auth, url);
      if (!binding.ok) return { ok: true, value: { reachable: false, defaultBranch: null, branchExists: false, message: binding.reason } };
      try {
        // 只读：ls-remote 不进本地目录、不 clone。20 秒够了，慢网络 / 私有仓库也别把保存请求挂住。
        const git = networkGit(tmpdir(), 20_000, binding.auth, url);
        const head = await git.raw(['ls-remote', '--symref', url, 'HEAD']);
        // 第一行形如 `ref: refs/heads/master\tHEAD`；没有 symref（裸提交号 / 老服务端）时按未知处理。
        const defaultBranch = /^ref:\s+refs\/heads\/(.+?)\s+HEAD$/m.exec(head)?.[1]?.trim() ?? null;
        const heads = await git.raw(['ls-remote', '--heads', url]);
        const names = heads
          .split('\n')
          .slice(0, 500)
          .map((line) => /^[0-9a-f]+\s+refs\/heads\/(.+)$/i.exec(line.trim())?.[1] ?? null)
          .filter((name): name is string => name !== null);
        const wanted = branch?.trim() ?? '';
        return { ok: true, value: { reachable: true, defaultBranch, branchExists: wanted === '' || names.includes(wanted), message: null } };
      } catch (error) {
        // 失败不抛：回 reachable=false，原因抹掉 URL 里的凭据；截到 2000 与 RPC 契约一致。
        const reason = gitMessage(error).slice(0, 2000);
        return { ok: true, value: { reachable: false, defaultBranch: null, branchExists: false, message: reason || '连不上这个仓库' } };
      }
    },

    async addWorktree({ repoPath, path: requested, branch, base, existing, auth, recurseSubmodules }) {
      const path = existing ? requested : relocateWorktree(requested, options.worktreesDir);
      for (const place of [repoPath, dirname(path)]) {
        const blocked = await guard(place);
        if (blocked) return { ok: false, error: blocked };
      }
      if (await lstat(path).catch(() => null)) return { ok: false, error: conflict(`「${path}」已经存在`) };
      return withRepoLock(repoPath, async () => {
        const repoGit = simpleGit(repoPath);
        if (!(await repoGit.checkIsRepo().catch(() => false))) return { ok: false, error: invalid(`「${repoPath}」不是 git 仓库`) };
        const remotes = await repoGit.getRemotes().catch(() => []);
        const hasOrigin = remotes.some((remote) => remote.name === 'origin');
        // 令牌只绑定 fetch 实际用的远端地址（配置里的原样 URL，不套 insteadOf），且必须与 hub 的预期地址一致
        const destination = hasOrigin ? await fetchDestination(repoPath) : null;
        const binding = bindAuth(auth, destination);
        if (!binding.ok) return { ok: false, error: invalid(binding.reason) };
        const git = networkGit(repoPath, undefined, binding.auth, destination);
        // 先 fetch，再按远端默认分支开，避免用本地过期的 master/main。
        if (hasOrigin) await git.fetch('origin').catch(() => undefined);
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
          return finishWorktree(path, branch, recurseSubmodules);
        }
        if (local.trim() !== '') return { ok: false, error: conflict(`分支 ${branch} 已经存在：改用已有的那个工作空间`) };
        const remoteHas = hasOrigin && (await git.raw(['branch', '-r', '--list', `origin/${branch}`]).catch(() => '')).trim() !== '';
        const from = remoteHas ? `origin/${branch}` : await resolveRemoteBase(git, hasOrigin, base);
        try {
          await mkdir(dirname(path), { recursive: true });
          await git.raw(['worktree', 'add', '--no-track', '-b', branch, path, from]);
        } catch (error) {
          return failed('新开分支', error);
        }
        return finishWorktree(path, branch, recurseSubmodules);
      });
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

    async saveWip(path, message, auth) {
      const blocked = await guard(path);
      if (blocked) return { ok: false, error: blocked };
      if (!(await exists(path))) return { ok: false, error: unavailable(`目录不存在：${path}`) };
      const git = simpleGit(path);
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
        // push 的目的地可能由 remote.origin.pushurl 覆盖，令牌只能绑在实际 push 的 URL 上
        const destination = await pushDestination(path);
        const binding = bindAuth(auth, destination);
        if (!binding.ok) return { ok: true, value: { committed: staged, pushed: false, branch, reason: binding.reason } };
        try {
          await networkGit(path, undefined, binding.auth, destination).raw(['push', '-u', 'origin', branch]);
        } catch (error) {
          return { ok: true, value: { committed: staged, pushed: false, branch, reason: `推送失败：${gitMessage(error)}` } };
        }
        return { ok: true, value: { committed: staged, pushed: true, branch, reason: null } };
      } catch (error) {
        return failed('提交 WIP', error);
      }
    },

    async preview(path, maxPatchBytes, options) {
      const blocked = await guard(path);
      if (blocked) return { ok: false, error: blocked };
      if (!(await exists(path))) return { ok: false, error: unavailable(`目录不存在：${path}`) };
      try {
        return { ok: true, value: await previewOf(path, maxPatchBytes, options?.redactSensitive === true) };
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

    async push(path, auth) {
      const blocked = await guard(path);
      if (blocked) return { ok: false, error: blocked };
      const git = simpleGit(path);
      const branch = (await git.raw(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim() || null;
      if (!branch) return { ok: true, value: { pushed: false, branch: null, reason: '当前不在任何分支上（detached HEAD）' } };
      const remotes = await git.getRemotes().catch(() => []);
      if (!remotes.some((remote) => remote.name === 'origin')) return { ok: true, value: { pushed: false, branch, reason: '没有 origin 远端' } };
      const destination = await pushDestination(path);
      const binding = bindAuth(auth, destination);
      if (!binding.ok) return { ok: true, value: { pushed: false, branch, reason: binding.reason } };
      try {
        await networkGit(path, undefined, binding.auth, destination).raw(['push', '-u', 'origin', branch]);
        return { ok: true, value: { pushed: true, branch, reason: null } };
      } catch (error) {
        return { ok: true, value: { pushed: false, branch, reason: gitMessage(error) } };
      }
    },

    async publishRef(input: PublishRefInput) {
      const { path, sha, auth, verifyOnly } = input;
      const blocked = await guard(path);
      if (blocked) return { ok: false, error: blocked };
      if (!(await exists(path))) return { ok: false, error: unavailable(`目录不存在：${path}`) };
      const branch = validBranchRef(input.branch);
      const baseBranch = validBranchRef(input.baseBranch);
      if (branch === null) return { ok: false, error: invalid('功能分支名不合法') };
      if (baseBranch === null) return { ok: false, error: invalid('base 分支名不合法') };
      if (!/^[0-9a-f]{40}$/.test(sha)) return { ok: false, error: invalid('要发布的提交必须是 40 位小写 SHA') };
      if (branch === baseBranch) return { ok: false, error: invalid('功能分支不能就是要发布的 base 分支') };
      const allowLocal = options.allowLocalPublishOrigin === true;
      const expectedScope = authScopeUrl(input.expectedUrl);
      if (expectedScope === null && !(allowLocal && isLocalGitUrl(input.expectedUrl))) {
        return { ok: false, error: invalid('项目仓库地址必须是可校验的 HTTPS 地址') };
      }
      const git = simpleGit(path);
      if (!(await git.checkIsRepo().catch(() => false)) || !(await ownRepo(git, path))) {
        return { ok: false, error: invalid('目录不是 git 仓库根目录') };
      }
      try {
        return await withRepoLock(path, async (): Promise<Result<PublishRefOutcome, DomainError>> => {
          // ── 本地准入：分支 / HEAD / 工作区 —— 任何一项对不上都说明「批准时的样子」已经变了 ──
          const live = (await git.raw(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
          if (live !== branch) return { ok: false, error: conflict(`本地当前分支是「${live || 'detached HEAD'}」，不是要发布的「${branch}」`) };
          const head = (await git.raw(['rev-parse', 'HEAD']).catch(() => '')).trim();
          if (head !== sha) return { ok: false, error: conflict('本地 HEAD 已经不是批准的提交；请重新确认后再发布') };
          const dirty = await simpleGit(path, { config: ['status.showUntrackedFiles=normal'] })
            .raw(['status', '--porcelain', '-z'])
            .catch(() => '?');
          if (dirty !== '') return { ok: false, error: conflict('工作区不干净：先把改动提交或清理，再发布批准的提交') };

          // ── 目的地准入：只认 domain 给的 expectedUrl，且 fetch / push 都必须落到它上面 ──
          const origin = await readOriginDestination(path);
          if (!origin.ok) return origin;
          const destination = origin.value;
          const expected = input.expectedUrl.trim();
          const matches = (canonical: string | null, url: string): boolean =>
            expectedScope === null ? allowLocal && url === expected : canonical === expectedScope;
          if (!matches(destination.canonicalFetch, destination.fetchUrl) || !matches(destination.canonicalPush, destination.pushUrl)) {
            return { ok: false, error: invalid('origin 的 fetch / push 目的地与项目仓库地址不一致，已拒绝发布') };
          }
          const binding = bindAuth(auth, destination.fetchUrl);
          if (!binding.ok) return { ok: false, error: invalid(binding.reason) };
          if (expectedScope !== null && !hasAuth(binding.auth)) {
            return { ok: false, error: invalid('发布到 HTTPS 仓库必须使用绑定该仓库的凭据（不读机器上的 ambient 凭据）') };
          }
          const env = publishEnv(binding.auth, destination.fetchUrl);

          // ── 远端权威事实：默认分支、base、现有功能分支 ──
          const symref = await runGit(path, ['ls-remote', '--symref', destination.fetchUrl, 'HEAD'], env);
          if (symref.code !== 0) return { ok: false, error: unavailable(`连不上远端：${gitMessage(symref.stderr)}`) };
          const defaultBranch = parseSymrefDefault(symref.stdout);
          if (defaultBranch === null) return { ok: false, error: invalid('远端没有可解析的默认分支（ls-remote --symref HEAD），已拒绝发布') };
          if (defaultBranch === branch) return { ok: false, error: invalid('功能分支不能是远端默认分支') };
          const refs = await runGit(path, ['ls-remote', destination.fetchUrl, `refs/heads/${baseBranch}`, `refs/heads/${branch}`], env);
          if (refs.code !== 0) return { ok: false, error: unavailable(`连不上远端：${gitMessage(refs.stderr)}`) };
          const baseSha = parseLsRemoteRef(refs.stdout, `refs/heads/${baseBranch}`);
          if (baseSha === null) return { ok: false, error: invalid(`远端没有 base 分支「${baseBranch}」，已拒绝发布`) };
          const remoteSha = parseLsRemoteRef(refs.stdout, `refs/heads/${branch}`);
          if (remoteSha !== null && remoteSha !== sha) {
            return { ok: false, error: conflict(`远端分支「${branch}」已经指向另一个提交；失败关闭，不覆盖`) };
          }
          // remoteSha 只记录「这次调用结束时证明的远端状态」；push 的回报本身不算证明。
          const outcome = (
            provenSha: string | null,
            published: boolean,
            pushed: boolean,
            uncertain: boolean,
            reason: string | null
          ): Result<PublishRefOutcome, DomainError> => ({
            ok: true,
            value: { sha, branch, published, pushed, baseBranch, baseSha, defaultBranch, remoteSha: provenSha, uncertain, reason }
          });
          if (remoteSha === sha) return outcome(sha, true, false, false, null);
          if (verifyOnly === true) return outcome(null, false, false, false, `仅核验：远端还没有「${branch}」这个提交`);

          // ── 只做 create-only 的 ref 更新：空 expected lease 要求该 ref 在远端起手就不存在，
          //    因此并发创建 / 任何替换都会被远端拒绝；这不是通用 force，也永远不会覆盖已有提交。──
          const pushed = await runGit(
            path,
            ['push', '--no-verify', '--signed=no', '--recurse-submodules=no', `--force-with-lease=refs/heads/${branch}:`, destination.pushUrl, `${sha}:refs/heads/${branch}`],
            env,
            120_000
          );
          // ── 无论 push 的回报如何，都以远端事实为准；证明不了就返回 uncertain，不盲目重试 ──
          const after = await runGit(path, ['ls-remote', destination.fetchUrl, `refs/heads/${branch}`], env);
          if (after.code !== 0) {
            return outcome(null, false, pushed.code === 0, true, `push 结果无法用 ls-remote 确认：${gitMessage(after.stderr)}`);
          }
          const afterSha = parseLsRemoteRef(after.stdout, `refs/heads/${branch}`);
          if (afterSha !== sha) {
            return outcome(
              afterSha,
              false,
              pushed.code === 0,
              false,
              pushed.code === 0 ? 'push 回报成功但远端不是这个提交，已失败关闭' : `推送失败：${gitMessage(pushed.stderr)}`
            );
          }
          return outcome(sha, true, true, false, pushed.code === 0 ? null : `push 报错但远端已更新为该提交：${gitMessage(pushed.stderr)}`);
        });
      } catch (error) {
        return failed('发布分支', error);
      }
    },

    async prepareDelegationWorktree(input: PrepareDelegationWorktreeInput) {
      const { repoPath, auth } = input;
      const blockedRepo = await guard(repoPath);
      if (blockedRepo) return { ok: false, error: blockedRepo };
      const blockedPath = await guard(input.path);
      if (blockedPath) return { ok: false, error: blockedPath };
      if (!(await exists(repoPath))) return { ok: false, error: unavailable(`目录不存在：${repoPath}`) };
      const branch = validBranchRef(input.branch);
      const baseBranch = validBranchRef(input.baseBranch);
      if (branch === null) return { ok: false, error: invalid('功能分支名不合法') };
      if (baseBranch === null) return { ok: false, error: invalid('base 分支名不合法') };
      if (branch === baseBranch) return { ok: false, error: invalid('功能分支不能就是要拉取的 base 分支') };
      const repoAbs = resolve(repoPath);
      const target = resolve(input.path);
      if (target === repoAbs || target.startsWith(`${repoAbs}/`)) {
        return { ok: false, error: invalid('目标 worktree 不能放在源仓库目录里（会改变源工作区）') };
      }
      const parentInfo = await lstat(dirname(target)).catch(() => null);
      if (parentInfo?.isDirectory() !== true) return { ok: false, error: invalid(`目标目录的父目录不存在：${dirname(target)}`) };
      const allowLocal = options.allowLocalPublishOrigin === true;
      const expectedScope = authScopeUrl(input.expectedUrl);
      if (expectedScope === null && !(allowLocal && isLocalGitUrl(input.expectedUrl))) {
        return { ok: false, error: invalid('项目仓库地址必须是可校验的 HTTPS 地址') };
      }
      const git = simpleGit(repoPath);
      if (!(await git.checkIsRepo().catch(() => false)) || !(await ownRepo(git, repoPath))) {
        return { ok: false, error: invalid('目录不是 git 仓库根目录') };
      }
      try {
        return await withRepoLock(repoPath, async (): Promise<Result<PrepareDelegationWorktreeOutcome, DomainError>> => {
          // ── 本地准入：目标目录 / 分支都不采用已有状态；源仓库的工作区、index、HEAD 一律不碰 ──
          if ((await lstat(target).catch(() => null)) !== null) {
            return { ok: false, error: conflict(`目标目录已经存在（不采用已有目录）：${target}`) };
          }
          const localRef = (await git.raw(['rev-parse', '-q', '--verify', `refs/heads/${branch}`]).catch(() => '')).trim();
          if (localRef !== '') return { ok: false, error: conflict(`本地分支 ${branch} 已经存在（不采用已有分支）`) };

          // ── 目的地准入：只认 domain 给的 expectedUrl，且 fetch / push 都必须落到它上面 ──
          const origin = await readOriginDestination(repoPath);
          if (!origin.ok) return origin;
          const destination = origin.value;
          const expected = input.expectedUrl.trim();
          const matches = (canonical: string | null, url: string): boolean =>
            expectedScope === null ? allowLocal && url === expected : canonical === expectedScope;
          if (!matches(destination.canonicalFetch, destination.fetchUrl) || !matches(destination.canonicalPush, destination.pushUrl)) {
            return { ok: false, error: invalid('origin 的 fetch / push 目的地与项目仓库地址不一致，已拒绝准备工作区') };
          }
          // 公开 base 可以不传凭据；传了就必须绑定同一个目的地（不读 ambient 凭据）。
          const binding = bindAuth(auth, destination.fetchUrl);
          if (!binding.ok) return { ok: false, error: invalid(binding.reason) };
          const env = publishEnv(binding.auth, destination.fetchUrl);

          // ── 远端权威事实：默认分支、选中的 base、是否已有同名功能分支 ──
          const symref = await runGit(repoPath, ['ls-remote', '--symref', destination.fetchUrl, 'HEAD'], env);
          if (symref.code !== 0) return { ok: false, error: unavailable(`连不上远端：${gitMessage(symref.stderr)}`) };
          const defaultBranch = parseSymrefDefault(symref.stdout);
          if (defaultBranch === null) return { ok: false, error: invalid('远端没有可解析的默认分支（ls-remote --symref HEAD），已拒绝准备工作区') };
          if (defaultBranch === branch) return { ok: false, error: invalid('功能分支不能是远端默认分支') };
          const refs = await runGit(repoPath, ['ls-remote', destination.fetchUrl, `refs/heads/${baseBranch}`, `refs/heads/${branch}`], env);
          if (refs.code !== 0) return { ok: false, error: unavailable(`连不上远端：${gitMessage(refs.stderr)}`) };
          const baseSha = parseLsRemoteRef(refs.stdout, `refs/heads/${baseBranch}`);
          if (baseSha === null) return { ok: false, error: conflict(`远端没有 base 分支「${baseBranch}」，已拒绝准备工作区`) };
          if (parseLsRemoteRef(refs.stdout, `refs/heads/${branch}`) !== null) {
            return { ok: false, error: conflict(`远端已经有分支「${branch}」（不采用已有分支）`) };
          }

          // ── 显式严格 fetch：只取选中 base 的这一个提交，失败不吞、不退回本地 ref；源工作区 / index / 分支不动。
          //    fetch 超时 5 分钟，worktree add 2 分钟，事后的状态核验 30 秒。──
          const fetched = await runGit(
            repoPath,
            ['fetch', '--no-tags', '--no-prune', '--no-recurse-submodules', '--no-write-fetch-head', destination.fetchUrl, baseSha],
            env,
            300_000
          );
          if (fetched.code !== 0) {
            return { ok: false, error: unavailable(`拉取 base 分支失败（未创建工作区）：${gitMessage(fetched.stderr)}`) };
          }
          const object = await runGit(repoPath, ['rev-parse', '-q', '--verify', `${baseSha}^{commit}`], env, 20_000);
          if (object.code !== 0 || object.stdout.trim() !== baseSha) {
            return { ok: false, error: unavailable('远端 base 提交没有按预期落到本地，已拒绝创建工作区') };
          }

          // ── 精确路径 + 精确 SHA 开分支；不重定位目录、不递归子模块、不跑 setup / hooks。──
          const added = await runGit(
            repoPath,
            ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--no-track', '-b', branch, target, baseSha],
            env,
            120_000
          );

          // ── 只认「能证明」的成功：目录 realpath、注册路径、实际分支、实际 HEAD 全部对上。──
          const realTarget = await realpath(target).catch(() => null);
          const list = await runGit(repoPath, ['worktree', 'list', '--porcelain'], env, 30_000);
          const registered = list.code === 0 && (await worktreePathsOf(list.stdout)).includes(realTarget ?? target);
          const actualBranch = realTarget === null ? '' : (await runGit(realTarget, ['symbolic-ref', '--short', '-q', 'HEAD'], env, 30_000)).stdout.trim();
          const actualHead = realTarget === null ? '' : (await runGit(realTarget, ['rev-parse', 'HEAD'], env, 30_000)).stdout.trim();
          if (added.code === 0 && realTarget !== null && registered && actualBranch === branch && actualHead === baseSha) {
            return { ok: true, value: { path: realTarget, branch, baseSha } };
          }

          // 失败后默认「无法确认」；只有目标目录与本地分支都确实不存在，才算证明了没有任何效果。
          const dirNow = await lstat(target).catch(() => null);
          const refNow = (await git.raw(['rev-parse', '-q', '--verify', `refs/heads/${branch}`]).catch(() => '')).trim();
          const detail = gitMessage(added.stderr) || gitMessage(list.stderr);
          if (dirNow === null && refNow === '') {
            return { ok: false, error: unavailable(`创建工作区失败（没有产生任何工作区 / 分支）：${detail || '原因未知'}`) };
          }
          return {
            ok: false,
            error: unavailable(`创建工作区的结果无法确认（目录或分支可能已部分存在），请人工检查「${target}」后再重试${detail ? `：${detail}` : ''}`)
          };
        });
      } catch (error) {
        return failed('准备工作区', error);
      }
    },

    async importCommit(input: ImportCommitInput) {
      const { sha } = input;
      const blockedSource = await guard(input.sourcePath);
      if (blockedSource) return { ok: false, error: blockedSource };
      const blockedTarget = await guard(input.targetPath);
      if (blockedTarget) return { ok: false, error: blockedTarget };
      if (!(await exists(input.sourcePath))) return { ok: false, error: unavailable(`目录不存在：${input.sourcePath}`) };
      if (!(await exists(input.targetPath))) return { ok: false, error: unavailable(`目录不存在：${input.targetPath}`) };
      const sourceBranch = validBranchRef(input.sourceBranch);
      if (sourceBranch === null) return { ok: false, error: invalid('源分支名不合法') };
      if (!/^[0-9a-f]{40}$/.test(sha)) return { ok: false, error: invalid('要导入的提交必须是 40 位小写 SHA') };
      const ref = input.ref;
      const refMatch = IMPORT_REF_PATTERN.exec(ref);
      if (ref !== ref.trim() || refMatch === null) {
        return { ok: false, error: invalid('导入用的 ref 必须是 refs/agent-hub/imports/<id>/<sha>') };
      }
      if (refMatch[2] !== sha) {
        return { ok: false, error: invalid('ref 末尾的 SHA 必须等于要导入的提交') };
      }
      const allowLocal = options.allowLocalPublishOrigin === true;
      const expectedScope = authScopeUrl(input.expectedUrl);
      if (expectedScope === null && !(allowLocal && isLocalGitUrl(input.expectedUrl))) {
        return { ok: false, error: invalid('项目仓库地址必须是可校验的 HTTPS 地址') };
      }
      const sourceAbs = await realpath(input.sourcePath).catch(() => null);
      const targetAbs = await realpath(input.targetPath).catch(() => null);
      if (sourceAbs === null || targetAbs === null) {
        return { ok: false, error: invalid('无法解析源仓库或目标仓库的真实路径，已拒绝导入') };
      }
      if (sourceAbs === targetAbs) return { ok: false, error: invalid('源仓库和目标仓库不能是同一个目录') };
      if (sourceAbs.startsWith(`${targetAbs}/`) || targetAbs.startsWith(`${sourceAbs}/`)) {
        return { ok: false, error: invalid('源仓库和目标仓库不能互相嵌套') };
      }
      // 本地传递专用 env：不联网、不读 global / system 配置，也不接受任意 GIT_* 覆盖。
      const env = publishEnv(undefined, null);
      env.GIT_ALLOW_PROTOCOL = 'file';
      // 只允许本机文件路径：连 ambient 的 ssh / askpass 可执行入口也不带进去。
      delete env.GIT_SSH;
      delete env.GIT_SSH_COMMAND;
      delete env.GIT_ASKPASS;

      // 必须是 canonical 的 git 仓库根目录；解析不出真实路径就失败关闭，不拿输入路径凑合。
      const canonicalRoot = async (path: string): Promise<string | null> => {
        const top = await runGit(path, ['rev-parse', '--show-toplevel'], env, 20_000);
        if (top.code !== 0) return null;
        const dir = top.stdout.trim();
        if (dir === '') return null;
        return realpath(dir).catch(() => null);
      };
      const [sourceRoot, targetRoot] = await Promise.all([canonicalRoot(sourceAbs), canonicalRoot(targetAbs)]);
      if (sourceRoot === null) return { ok: false, error: invalid('源目录不是 git 仓库根目录（或无法确认真实路径）') };
      if (targetRoot === null) return { ok: false, error: invalid('目标目录不是 git 仓库根目录（或无法确认真实路径）') };
      if (sourceRoot !== sourceAbs) return { ok: false, error: invalid('源目录不是 canonical git 仓库根目录') };
      if (targetRoot !== targetAbs) return { ok: false, error: invalid('目标目录不是 canonical git 仓库根目录') };

      // 同一个仓库（主 checkout / worktree）之间不算两个独立 clone；common-dir 解析失败也失败关闭。
      const commonDirOf = async (path: string): Promise<string | null> => {
        const raw = await runGit(path, ['rev-parse', '--git-common-dir'], env, 20_000);
        if (raw.code !== 0) return null;
        const dir = raw.stdout.trim();
        if (dir === '') return null;
        return realpath(isAbsolute(dir) ? dir : resolve(path, dir)).catch(() => null);
      };
      const [sourceCommon, targetCommon] = await Promise.all([commonDirOf(sourceAbs), commonDirOf(targetAbs)]);
      if (sourceCommon === null || targetCommon === null) {
        return { ok: false, error: invalid('无法确认源仓库和目标仓库是两个独立的 clone，已拒绝导入') };
      }
      if (sourceCommon === targetCommon) {
        return { ok: false, error: invalid('源仓库和目标仓库必须是两个独立的 clone') };
      }

      // ── 目的地准入：两边都只认 domain 给的 expectedUrl，fetch / push 都必须落到它上面 ──
      const expected = input.expectedUrl.trim();
      const matches = (canonical: string | null, url: string): boolean =>
        expectedScope === null ? allowLocal && url === expected : canonical === expectedScope;
      for (const [label, path] of [['源仓库', sourceAbs], ['目标仓库', targetAbs]] as const) {
        const origin = await readOriginDestination(path);
        if (!origin.ok) return origin;
        const destination = origin.value;
        if (!matches(destination.canonicalFetch, destination.fetchUrl) || !matches(destination.canonicalPush, destination.pushUrl)) {
          return { ok: false, error: invalid(`${label}的 origin fetch / push 目的地与项目仓库地址不一致，已拒绝导入`) };
        }
      }

      try {
        return await withRepoLock(targetAbs, async (): Promise<Result<ImportCommitOutcome, DomainError>> => {
          const refCheck = await runGit(sourceAbs, ['check-ref-format', ref], env, 20_000);
          if (refCheck.code !== 0) return { ok: false, error: invalid('导入用的 ref 名不合法') };

          // ── 源仓库准入：HEAD 必须正好在记录的分支上；提交必须是该分支历史里的 commit（不退回别的 ref）──
          const live = (await runGit(sourceAbs, ['symbolic-ref', '--short', '-q', 'HEAD'], env, 20_000)).stdout.trim();
          if (live !== sourceBranch) {
            return { ok: false, error: conflict(`源仓库当前分支是「${live || 'detached HEAD'}」，不是记录的源分支「${sourceBranch}」`) };
          }
          const tip = await runGit(sourceAbs, ['rev-parse', '-q', '--verify', `refs/heads/${sourceBranch}^{commit}`], env, 20_000);
          if (tip.code !== 0 || tip.stdout.trim() === '') {
            return { ok: false, error: conflict(`源仓库没有分支「${sourceBranch}」`) };
          }
          const object = await runGit(sourceAbs, ['rev-parse', '-q', '--verify', `${sha}^{commit}`], env, 20_000);
          if (object.code !== 0 || object.stdout.trim() !== sha) {
            return { ok: false, error: invalid('要导入的提交不是源仓库里的提交') };
          }
          const reachable = await runGit(sourceAbs, ['merge-base', '--is-ancestor', sha, tip.stdout.trim()], env, 20_000);
          if (reachable.code !== 0) {
            return { ok: false, error: conflict(`要导入的提交不在记录的源分支「${sourceBranch}」历史里；已拒绝导入`) };
          }

          // ── 目标仓库：已有同一个 ref 指向同一提交 = 幂等，不写任何东西 ──
          const existing = await runGit(targetAbs, ['rev-parse', '-q', '--verify', ref], env, 20_000);
          if (existing.code === 0) {
            if (existing.stdout.trim() !== sha) {
              return { ok: false, error: conflict(`目标仓库的 ${ref} 已经指向另一个提交；失败关闭，不覆盖`) };
            }
            const present = await runGit(targetAbs, ['rev-parse', '-q', '--verify', `${sha}^{commit}`], env, 20_000);
            if (present.code !== 0 || present.stdout.trim() !== sha) {
              return { ok: false, error: unavailable('目标仓库的 ref 指向的提交无法解析，请人工检查') };
            }
            return { ok: true, value: { ref, sha, alreadyPresent: true } };
          }

          // ── 只从源仓库的绝对路径取对象：禁止换 transport / 执行额外程序，也不写 FETCH_HEAD ──
          const fetched = await runGit(
            targetAbs,
            [
              '-c', 'protocol.allow=never',
              '-c', 'protocol.file.allow=always',
              '-c', 'core.hooksPath=/dev/null',
              '-c', 'gc.auto=0',
              '-c', 'maintenance.auto=false',
              'fetch', '--no-tags', '--no-prune', '--no-recurse-submodules', '--no-write-fetch-head',
              '--refmap=', '--no-auto-gc',
              '--', sourceAbs, sha
            ],
            env,
            300_000
          );
          if (fetched.code !== 0) {
            return { ok: false, error: unavailable(`从源仓库导入提交失败（未写任何 ref）：${gitMessage(fetched.stderr)}`) };
          }
          const imported = await runGit(targetAbs, ['rev-parse', '-q', '--verify', `${sha}^{commit}`], env, 20_000);
          if (imported.code !== 0 || imported.stdout.trim() !== sha) {
            return { ok: false, error: unavailable('导入后的提交没有按预期落到目标仓库，已拒绝写 ref') };
          }

          // ── create-only：old 是零 OID，ref 已存在时拒绝；并发写了同一个值则退化成幂等 ──
          const zero = '0'.repeat(40);
          const created = await runGit(targetAbs, ['update-ref', ref, sha, zero], env, 20_000);
          if (created.code === 0) {
            const after = await runGit(targetAbs, ['rev-parse', '-q', '--verify', ref], env, 20_000);
            if (after.code !== 0 || after.stdout.trim() !== sha) {
              return { ok: false, error: unavailable(`写 ${ref} 的结果无法确认，请人工检查目标仓库`) };
            }
            return { ok: true, value: { ref, sha, alreadyPresent: false } };
          }
          const now = await runGit(targetAbs, ['rev-parse', '-q', '--verify', ref], env, 20_000);
          if (now.code === 0 && now.stdout.trim() === sha) {
            return { ok: true, value: { ref, sha, alreadyPresent: true } };
          }
          const detail = gitMessage(created.stderr);
          return {
            ok: false,
            error: conflict(`目标仓库的 ${ref} 已经存在另一个提交（或写入被并发改动）；失败关闭${detail ? `：${detail}` : ''}`)
          };
        });
      } catch (error) {
        return failed('导入提交', error);
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
        return { ok: true, value: viewed.ok ? viewed : { ok: true, pr: { number: Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0), url, state: 'open' as const, headSha: null, mergedAt: null } } };
      }
      if (request.action === 'list') return { ok: true, value: await listPr(run, request.head, request.repo) };
      return { ok: true, value: await viewPr(run, String(request.number)) };
    },

    async remove(path, kind, options) {
      const blocked = await guard(path);
      if (blocked) return { ok: false, error: blocked };
      if (!(await exists(path))) return { ok: true, value: { removed: true } }; // 已经没了：登记可以收掉
      return withRepoLock(path, async () => {
      if (options?.force) {
        // 人二次确认过「这些改动不要了」：worktree 用 --force 摘掉（分支和已提交的仍在主仓库里），目录整个删
        try {
          if (kind === 'worktree') await detachWorktree(path, true);
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
          await detachWorktree(path, false); // 不加 --force；分支保留
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
      });
    },

    async runSetup({ path, command, timeoutMs, env }) {
      const blocked = await guard(path);
      if (blocked) return { ok: false, error: blocked };
      if (!(await exists(path))) return { ok: false, error: invalid(`准备命令要用的目录不存在：${path}`) };
      return { ok: true, value: await runSetupScript({ path, command, timeoutMs, ...(env ? { env } : {}) }) };
    }
  };
}

/* ── 组合工作空间（docs/design/multi-repo.md §12.1）：在容器里给成员开新分支的 worktree ── */

/** 组合工作空间成员的 worktree 端口：只有 `ws.new_worktree` 这一件事。 */
export interface GroupWorktrees {
  newWorktree(input: {
    readonly repoPath: string;
    readonly path: string;
    readonly branch: string;
    readonly base?: string | null;
    /** 私有 HTTPS 仓库的令牌（开 worktree 前要 fetch origin）。 */
    readonly auth?: GitAuth;
    readonly recurseSubmodules?: boolean;
  }): Promise<Result<{ readonly path: string; readonly branch: string }, DomainError>>;
}

/**
 * `ws.new_worktree`：和 `addWorktree`（existing 为假）走同一套「新开分支」逻辑，但**不经过
 * `relocateWorktree`**——成员目录由 domain 按容器根算好，Worker 只校验它在 groups 目录下。
 * `check` 与 git 同一个边界（WORKER_ROOTS）。
 */
export function createGroupWorktrees(check: (path: string) => Promise<string | null>, options: { readonly groupsDir: string }): GroupWorktrees {
  const groupsDir = resolve(options.groupsDir);
  return {
    async newWorktree({ repoPath, path: requested, branch, base, auth, recurseSubmodules }) {
      if (!requested.startsWith('/')) return { ok: false, error: invalid('成员目录必须是绝对路径') };
      const path = resolve(requested);
      const repo = resolve(repoPath);
      for (const place of [repo, path]) {
        const problem = await check(place);
        if (problem !== null) return { ok: false, error: invalid(problem) };
      }
      if (!insideGroups(groupsDir, path)) return { ok: false, error: invalid(`成员目录必须放在 ${groupsDir} 下面：${path}`) };
      if (branch.trim() === '') return { ok: false, error: invalid('分支名不能为空') };
      if (await lstat(path).catch(() => null)) return { ok: false, error: conflict(`「${path}」已经存在`) };
      return addWorktreeOnNewBranch({ repoPath: repo, path, branch, base, auth, recurseSubmodules });
    }
  };
}

/**
 * 在 `repoPath` 上新建 `branch` 并检出到 `path`。
 * 远端有同名分支时跟踪 `origin/<branch>`（成员要能直接 push / 看远端状态），否则从 `base ?? HEAD` 开。
 * 分支本地已存在一律 conflict：那是「复用已有工作空间」的路径，不是这里。
 */
export async function addWorktreeOnNewBranch(input: {
  readonly repoPath: string;
  readonly path: string;
  readonly branch: string;
  readonly base?: string | null;
  readonly auth?: GitAuth;
  readonly recurseSubmodules?: boolean;
}): Promise<Result<{ readonly path: string; readonly branch: string }, DomainError>> {
  const { repoPath, path, branch, base, auth, recurseSubmodules } = input;
  return withRepoLock(repoPath, async () => {
    const repoGit = simpleGit(repoPath);
    if (!(await repoGit.checkIsRepo().catch(() => false))) return { ok: false, error: invalid(`「${repoPath}」不是 git 仓库`) };
    const remotes = await repoGit.getRemotes().catch(() => []);
    const hasOrigin = remotes.some((remote) => remote.name === 'origin');
    const destination = hasOrigin ? await fetchDestination(repoPath) : null;
    const binding = bindAuth(auth, destination);
    if (!binding.ok) return { ok: false, error: invalid(binding.reason) };
    const git = networkGit(repoPath, undefined, binding.auth, destination);
    if (hasOrigin) await git.fetch('origin').catch(() => undefined);
    const local = await git.raw(['branch', '--list', branch]).catch(() => '');
    if (local.trim() !== '') return { ok: false, error: conflict(`分支 ${branch} 已经存在：改用已有的那个工作空间`) };
    const remoteHas = hasOrigin && (await git.raw(['branch', '-r', '--list', `origin/${branch}`]).catch(() => '')).trim() !== '';
    const from = remoteHas ? `origin/${branch}` : await resolveRemoteBase(git, hasOrigin, base);
    try {
      await mkdir(dirname(path), { recursive: true });
      if (remoteHas) await git.raw(['worktree', 'add', '--track', '-b', branch, path, from]);
      else await git.raw(['worktree', 'add', '--no-track', '-b', branch, path, from]);
    } catch (error) {
      return { ok: false, error: unavailable(`新开分支失败：${gitMessage(error)}`) };
    }
    return finishWorktree(path, branch, recurseSubmodules);
  });
}

/** 从主工作区摘掉 worktree。common dir 解析不到目录时，就在这个 worktree 里摘掉自己（git 允许）。 */
async function detachWorktree(path: string, force: boolean): Promise<void> {
  const raw = (await simpleGit(path).raw(['rev-parse', '--git-common-dir'])).trim();
  const main = mainWorktreeDir(path, raw);
  const args = ['worktree', 'remove', ...(force ? ['--force'] : []), path];
  const mainIsDir = await lstat(main).then((stat) => stat.isDirectory()).catch(() => false);
  if (mainIsDir) {
    await simpleGit(main).raw(args);
    await simpleGit(main).raw(['worktree', 'prune']).catch(() => undefined);
    return;
  }
  await simpleGit(path).raw(args);
  await simpleGit(path).raw(['worktree', 'prune']).catch(() => undefined);
}

/** 机器自己的 git 凭据要用到的变量（ssh agent、自定义 ssh 命令、askpass、代理），其余 GIT_* 不放行。 */
const CREDENTIAL_ENV = ['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GIT_TERMINAL_PROMPT'] as const;
/** 逐次传入的 HTTPS 令牌落在这里（git 的 `-c http.extraHeader=…` 环境写法），优先级高于机器自己的凭据。 */
const AUTH_ENV = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1'] as const;
const PASS_THROUGH = ['PATH', 'HOME', 'USER', 'LANG', 'SSH_AUTH_SOCK', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'];

/**
 * 令牌要绑定的目标地址：只认能解析的 HTTPS URL。
 * 去掉 userinfo / query / fragment / 尾斜杠，只留 `https://host[:port]/path`。
 * 含空白或控制字符一律拒绝：`GIT_CONFIG_KEY_*` 会被 git 当成 config key，不能让它带换行。
 */
export function authScopeUrl(raw: string | null | undefined): string | null {
  const rawValue = raw ?? '';
  // 控制字符（含 CR/LF）在原始值里就拒绝，不靠 trim 抹掉
  if (/[\u0000-\u001f\u007f]/.test(rawValue)) return null;
  const value = rawValue.trim();
  if (value === '' || /\s/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.host === '') return null;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

function hasAuth(auth: GitAuth | undefined): boolean {
  return auth !== undefined && auth.header.trim() !== '';
}

type AuthBinding =
  | { readonly ok: true; readonly auth: GitAuth | undefined }
  | { readonly ok: false; readonly reason: string };

/**
 * 令牌必须绑定到 hub 给的预期 HTTPS 地址，并且与本次操作实际的目的地一致。
 * - 没有 auth / 空头：未认证操作，照常放行；
 * - 有 auth 但没带 `url`：旧 hub 的未绑定令牌，新 Worker 拒绝使用（不把它硬套到任何目的地）；
 * - 地址不合法或与目的地不一致：拒绝使用（失败关闭），不降级成「发给当前这个地址」。
 */
function bindAuth(auth: GitAuth | undefined, destination: string | null): AuthBinding {
  if (!hasAuth(auth)) return { ok: true, auth: undefined };
  const expected = authScopeUrl(auth?.url);
  if (expected === null) return { ok: false, reason: '认证信息没有绑定有效的 HTTPS 仓库地址（旧版 hub？），已拒绝使用' };
  const actual = authScopeUrl(destination);
  if (actual === null) return { ok: false, reason: '本次操作的目标不是可校验的 HTTPS 地址，不能用令牌' };
  if (actual !== expected) return { ok: false, reason: '本次操作的目标与令牌绑定的仓库不一致，已拒绝使用令牌' };
  return { ok: true, auth };
}

/**
 * 网络 git 的环境（导出只为测试）：机器自己的凭据变量 + 逐次令牌。
 *
 * 令牌只以 `http.<预期 HTTPS 地址>.extraHeader` 的形式注入，并且**只发给与 `auth.url` 一致的目的地**：
 * 别的 host（子模块、重定向、`insteadOf` 改写后的地址）匹配不到这个 scope，拿不到头。
 * 同时把 `http.followRedirects` 关掉：带凭据的请求不接受任何重定向。
 * 没有 `auth`、或 `auth.url` 缺失 / 与 `destination` 不一致，就一条 `GIT_CONFIG_*` 都不设。
 */
export function networkEnv(auth?: GitAuth, source: NodeJS.ProcessEnv = process.env, destination?: string | null): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  for (const key of [...PASS_THROUGH, ...CREDENTIAL_ENV.slice(0, 3)]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  const binding = bindAuth(auth, destination ?? null);
  const header = binding.ok ? (binding.auth?.header.trim() ?? '') : '';
  const scope = header === '' ? null : authScopeUrl(destination);
  if (scope !== null) {
    env.GIT_CONFIG_COUNT = '2';
    env.GIT_CONFIG_KEY_0 = `http.${scope}.extraHeader`;
    env.GIT_CONFIG_VALUE_0 = header;
    // false = 所有重定向都当错误；默认的 initial 会跟随首个重定向，可能把凭据带到别的地址。
    env.GIT_CONFIG_KEY_1 = 'http.followRedirects';
    env.GIT_CONFIG_VALUE_1 = 'false';
  }
  return env;
}

/**
 * 要走网络的 git（clone / fetch / ls-remote / push）：不许弹交互式密码提示把进程挂住，没凭据就直接失败。
 * `auth` 存在时只在 `destination` 是 HTTPS 的前提下注入 `http.<destination>.extraHeader`
 * （等价 `git -c http.extraHeader=…`）：令牌只出现在环境变量里，不进 argv（`ps` 看不见）、
 * 不进 stderr（git 不回显这个头），也不会被带到别的 host。
 */
function networkGit(baseDir: string, timeoutMs?: number, auth?: GitAuth, destination?: string | null): SimpleGit {
  const env = networkEnv(auth, process.env, destination);
  const timeout = timeoutMs === undefined ? {} : { timeout: { block: timeoutMs } };
  return simpleGit({ baseDir, allowEnvironment: [...CREDENTIAL_ENV, ...AUTH_ENV], ...timeout }).env(env);
}

/**
 * 直接读仓库配置里的原始 URL，不用 `remote get-url`：后者会套 `insteadOf` 改写。
 * 令牌的 scope 必须绑在**配置里写的**那个地址上；如果 git 之后把它改写到别处，
 * 改写后的地址匹配不到 scope，就拿不到头（安全失败），而不是把令牌跟着改写走。
 */
async function rawRemoteUrls(path: string, key: 'url' | 'pushurl'): Promise<string[]> {
  const raw = await simpleGit(path)
    .raw(['config', '--get-all', `remote.origin.${key}`])
    .catch(() => '');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** fetch 实际用的地址：`remote.origin.url` 必须恰好一条，否则绑定不了。 */
async function fetchDestination(path: string): Promise<string | null> {
  const urls = await rawRemoteUrls(path, 'url');
  return urls.length === 1 ? urls[0]! : null;
}

/**
 * push 实际用的地址：只有 `pushurl` 与 `url` 指向同一个 HTTPS 目的地时才绑定。
 * 仓库配置能把 push 改到另一个地址，而那个地址不一定是这次操作「预期的仓库」，
 * 所以出现额外目的地、或多条 pushurl / 多条 url 时返回 null（这一趟不带令牌，宁可 push 失败）。
 */
export async function pushDestination(path: string): Promise<string | null> {
  const urls = await rawRemoteUrls(path, 'url');
  if (urls.length !== 1) return null;
  const base = urls[0]!;
  const pushUrls = await rawRemoteUrls(path, 'pushurl');
  if (pushUrls.length === 0) return base;
  if (pushUrls.length > 1) return null;
  const push = pushUrls[0]!;
  const pushScope = authScopeUrl(push);
  return pushScope !== null && pushScope === authScopeUrl(base) ? push : null;
}

function isLocalGitUrl(url: string | null | undefined): boolean {
  const value = (url ?? '').trim();
  return value.startsWith('/') || value.startsWith('file:') || value.startsWith('~') || /^\.{1,2}\//.test(value);
}

/** 发布分支名只认 git 允许的普通分支：拒绝 `-` 开头、`..`、`@{`、控制字符与 `.lock` 等注入面。 */
export function validBranchRef(name: string): string | null {
  if (name === '' || name.length > 255 || name !== name.trim()) return null;
  if (/[\u0000-\u0020\u007f~^:?*\[\\]/.test(name)) return null;
  if (name === '@' || name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return null;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return null;
  const parts = name.split('/');
  return parts.some((part) => part === '' || part === '.' || part === '..' || part.startsWith('.') || part.endsWith('.lock') || part === '@')
    ? null
    : name;
}

interface GitRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 带完整环境控制的 git（发布用）：不继承 ambient config，失败不抛异常。 */
function runGit(cwd: string, args: string[], env: Record<string, string>, timeoutMs = 60_000): Promise<GitRun> {
  return new Promise((done) => {
    execFile('git', args, { cwd, env, timeout: timeoutMs, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr || (error ? error.message : '')) });
    });
  });
}

/**
 * 发布专用 env：沿用 networkEnv 的「令牌只发给绑定的 HTTPS 地址 + 不跟随重定向」，
 * 再屏蔽 global / system 配置与 credential helper。
 *
 * 为什么：`url.*.insteadOf`、`http.*.extraHeader`、`credential.helper` 都能来自用户全局配置，
 * 把「校验过的目的地」在真正联网时改写到别处，或让 git 自己附加另一份凭据。
 * 发布只允许仓库自带的本地配置，且下面的 `readOriginDestination` 会核对 insteadOf 展开结果。
 */
export function publishEnv(auth?: GitAuth, destination?: string | null, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = networkEnv(auth, source, destination);
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_SYSTEM = '/dev/null';
  const count = Number(env.GIT_CONFIG_COUNT ?? '0') || 0;
  const extra: readonly (readonly [string, string])[] = [
    // 空值 = 清空 credential helper 列表：发布只认本次传入的 scoped auth，不读机器上的 helper。
    ['credential.helper', ''],
    ['credential.interactive', 'false'],
    ['http.followRedirects', 'false']
  ];
  extra.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${count + index}`] = key;
    env[`GIT_CONFIG_VALUE_${count + index}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(count + extra.length);
  return env;
}

/** origin 的 fetch / push 目的地，以及 git 解析（insteadOf）之后的规范形式。 */
export interface OriginDestination {
  readonly fetchUrl: string;
  readonly pushUrl: string;
  readonly canonicalFetch: string | null;
  readonly canonicalPush: string | null;
  readonly local: boolean;
}

/**
 * 读出 origin 的真实目的地：raw 配置各恰好一条，且 git 展开后与 raw 指向同一个地方。
 * 展开在 publishEnv 下做（屏蔽 global/system 的 insteadOf），所以核对的就是发布时 git 看到的东西；
 * 仓库本地 insteadOf 仍会生效，因而也会被这一致性检查抓住并拒绝。
 */
export async function readOriginDestination(path: string): Promise<Result<OriginDestination, DomainError>> {
  const raw = await rawRemoteUrls(path, 'url');
  if (raw.length !== 1) return { ok: false, error: invalid('origin 必须恰好配置一个 fetch 地址') };
  const rawPushUrls = await rawRemoteUrls(path, 'pushurl');
  if (rawPushUrls.length > 1) return { ok: false, error: invalid('origin 配置了多个 push 地址，拒绝发布') };
  const rawFetch = raw[0]!.trim();
  const rawPush = (rawPushUrls[0] ?? raw[0]!).trim();
  const env = publishEnv();
  const expandedFetch = (await runGit(path, ['remote', 'get-url', 'origin'], env, 20_000)).stdout.trim();
  const expandedPush = (await runGit(path, ['remote', 'get-url', '--push', 'origin'], env, 20_000)).stdout.trim();
  const fetchUrl = expandedFetch || rawFetch;
  const pushUrl = expandedPush || rawPush;
  const canonicalFetch = authScopeUrl(fetchUrl);
  const canonicalPush = authScopeUrl(pushUrl);
  const local = canonicalFetch === null && isLocalGitUrl(fetchUrl);
  if (canonicalFetch === null && !local) return { ok: false, error: invalid('origin 不是可校验的 HTTPS 地址（本地路径仅测试策略放行）') };
  if (canonicalPush === null && !local) return { ok: false, error: invalid('origin 的 push 地址不是可校验的 HTTPS 地址') };
  if (canonicalFetch !== null && authScopeUrl(rawFetch) !== canonicalFetch) {
    return { ok: false, error: invalid('origin 地址被 git 配置改写（insteadOf），拒绝发布') };
  }
  if (canonicalPush !== null && authScopeUrl(rawPush) !== canonicalPush) {
    return { ok: false, error: invalid('origin 的 push 地址被 git 配置改写（insteadOf），拒绝发布') };
  }
  if (canonicalFetch === null && fetchUrl !== rawFetch) return { ok: false, error: invalid('origin 地址被 git 配置改写（insteadOf），拒绝发布') };
  if (canonicalPush === null && pushUrl !== rawPush) return { ok: false, error: invalid('origin 的 push 地址被 git 配置改写（insteadOf），拒绝发布') };
  return { ok: true, value: { fetchUrl, pushUrl, canonicalFetch, canonicalPush, local } };
}

/** `ls-remote --symref <url> HEAD` 的第一行 `ref: refs/heads/<name>\tHEAD`。 */
export function parseSymrefDefault(raw: string): string | null {
  for (const line of raw.split('\n')) {
    const match = /^ref:\s+refs\/heads\/(\S+)\tHEAD$/.exec(line.trim());
    if (match) return validBranchRef(match[1]!);
  }
  return null;
}

/** `ls-remote` 输出里只认 `refs/heads/...` 的精确匹配，并校验 OID 是 40 位小写十六进制。 */
export function parseLsRemoteRef(raw: string, ref: string): string | null {
  for (const line of raw.split('\n')) {
    const [oid, name] = line.trim().split(/\s+/);
    if (name === ref && oid !== undefined && /^[0-9a-f]{40}$/.test(oid)) return oid;
  }
  return null;
}

/** `git worktree list --porcelain` 里的注册路径（尽量 realpath；已消失的路径原样保留）。 */
async function worktreePathsOf(raw: string): Promise<string[]> {
  const paths: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const given = line.slice('worktree '.length).trim();
    if (given === '') continue;
    paths.push(await realpath(given).catch(() => resolve(given)));
  }
  return paths;
}

/**
 * 建好 checkout 后按项目开关递归初始化子模块；失败时由调用方决定是否清掉目录。
 *
 * 子模块地址来自 `.gitmodules`，是仓库内容而不是操作者指定的目的地：可能指向任意 host。
 * 所以这里**永远不带令牌**，只用机器自己的凭据（SSH key / agent）或匿名；私有子模块会失败，
 * 这是有意的取舍——宁可初始化失败，也不把项目令牌交给仓库内容控制的一串 URL。
 */
async function initSubmodules(path: string): Promise<Result<void, DomainError>> {
  try {
    const origin = ((await simpleGit(path).remote(['get-url', 'origin']).catch(() => '')) || '').trim();
    if (isLocalGitUrl(origin)) {
      // simple-git 默认禁止改 protocol.file.allow；本地 bare 测试仓库走 execFile。
      await new Promise<void>((done, fail) => {
        execFile(
          'git',
          ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'],
          { cwd: path, env: networkEnv(), timeout: 120_000, maxBuffer: 1 << 20 },
          (error) => (error ? fail(error) : done())
        );
      });
    } else {
      await networkGit(path).raw(['submodule', 'update', '--init', '--recursive']);
    }
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: unavailable(`初始化子模块失败：${gitMessage(error)}`) };
  }
}

async function finishWorktree(
  path: string,
  branch: string,
  recurse: boolean | undefined
): Promise<Result<{ readonly path: string; readonly branch: string }, DomainError>> {
  if (!recurse) return { ok: true, value: { path, branch } };
  const sub = await initSubmodules(path);
  if (sub.ok) return { ok: true, value: { path, branch } };
  await detachWorktree(path, true).catch(() => rm(path, { recursive: true, force: true }).catch(() => undefined));
  return sub;
}


/** 同一源仓库上的 git 操作排队，避免并发 session 抢 .git 锁。 */
const repoLocks = new Map<string, Promise<void>>();

async function withRepoLock<T>(repoPath: string, run: () => Promise<T>): Promise<T> {
  const key = resolve(repoPath);
  const previous = repoLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  repoLocks.set(key, previous.then(() => current));
  try {
    await previous;
    return await run();
  } finally {
    release();
    if (repoLocks.get(key) === current) repoLocks.delete(key);
  }
}

/**
 * 开新分支时从「fetch 之后的远端默认分支」起步，不用本地可能过期的 master/main。
 * 请求的 base 若能在 origin/ 下找到，优先用它；否则用 origin/HEAD，再不行才退回本地。
 */
export async function resolveRemoteBase(
  git: { raw(args: string[]): Promise<string> },
  hasOrigin: boolean,
  requested?: string | null
): Promise<string> {
  const exists = async (ref: string): Promise<boolean> =>
    (await git.raw(['rev-parse', '-q', '--verify', `${ref}^{commit}`]).catch(() => '')).trim() !== '';
  if (hasOrigin) {
    const wanted = requested?.trim() ?? '';
    const remote = wanted === '' ? '' : wanted.startsWith('origin/') ? wanted : `origin/${wanted}`;
    if (remote !== '' && (await exists(remote))) return remote;
    const head = (await git.raw(['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
    if (head !== '' && (await exists(head))) return head;
    for (const name of ['origin/main', 'origin/master']) {
      if (await exists(name)) return name;
    }
  }
  // fetch 失败或 origin 只是挂着的地址时，不要把不存在的 origin/main 交给 worktree add。
  const local = (requested?.trim() ?? '').replace(/^origin\//, '');
  if (local !== '' && (await exists(local))) return local;
  return 'HEAD';
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
  const viewed = await run(['pr', 'view', ref, '--json', 'number,url,state,headRefOid,headRefName,headRepository,headRepositoryOwner,mergedAt,baseRefName']);
  if (!viewed.ok) return viewed;
  try {
    const o = JSON.parse(viewed.out) as GhPrJson;
    return { ok: true, pr: toRemotePr(o) };
  } catch {
    return { ok: false, reason: 'gh 返回的不是 JSON' };
  }
}

/** 按分支列 PR：认领 agent 用 gh pr create 在会话分支上开的、没落库的 PR（#262）。只列开着的（#269）。 */
async function listPr(run: GhRun, head: string, repo: string | undefined): Promise<{ ok: true; prs: readonly RemotePullRequest[] } | { ok: false; reason: string }> {
  // --repo 必须绑到候选的 origin：只给 --head 时 gh 会按当前目录推断仓库，
  // worktree 可能推断到 upstream，PR 号就属于另一个仓库了（#269）。
  const target = repo ? ['--repo', repo] : [];
  const listed = await run(['pr', 'list', '--head', head, ...target, '--state', 'open', '--limit', '20', '--json', 'number,url,state,headRefOid,headRefName,headRepository,headRepositoryOwner,mergedAt,baseRefName']);
  if (!listed.ok) return listed;
  try {
    const items = JSON.parse(listed.out) as GhPrJson[];
    return { ok: true, prs: items.map(toRemotePr) };
  } catch {
    return { ok: false, reason: 'gh 返回的不是 JSON' };
  }
}

/** `gh --json` 里本模块关心的字段（老版本 gh 可能不带 headRepository / headRefName）。 */
interface GhPrJson {
  readonly number: number;
  readonly url: string;
  readonly state: string;
  readonly headRefOid?: string;
  readonly headRefName?: string;
  /**
   * gh 的 GraphQL 导出：`headRepository` 是 `{id,name,nameWithOwner}`（query_builder.go），
   * 但旧版/不同导出只给 `{id,name}`，owner 在单独的 `headRepositoryOwner.login`。
   */
  readonly headRepository?: { readonly name?: string; readonly nameWithOwner?: string } | null;
  readonly headRepositoryOwner?: { readonly login?: string } | null;
  readonly mergedAt?: string | null;
  readonly baseRefName?: string;
}

function headRepoOf(o: GhPrJson): string | null {
  const full = o.headRepository?.nameWithOwner;
  if (full) return full;
  const owner = o.headRepositoryOwner?.login;
  const name = o.headRepository?.name;
  return owner && name ? `${owner}/${name}` : null; // 缺一半就不猜：认领那边会因此拒绝
}

function toRemotePr(o: GhPrJson): RemotePullRequest {
  return {
    number: o.number,
    url: o.url,
    state: o.state === 'MERGED' ? 'merged' : o.state === 'CLOSED' ? 'closed' : 'open',
    headSha: o.headRefOid ?? null,
    mergedAt: o.mergedAt ? Date.parse(o.mergedAt) : null,
    base: o.baseRefName ?? null,
    // head 仓库 / 分支名：自动认领据此排斥 fork 与同名分支（#269）；老 gh 不带就是 null
    repo: headRepoOf(o),
    headRef: o.headRefName ?? null
  };
}

const STATUS_OF: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'added', T: 'modified', '?': 'untracked' };

/** 受保护预览最多用多少个 pathspec；超过就整段省略，绝不退回整树 diff + 文本过滤。 */
const MAX_DIFF_PATHSPECS = 1000;

// 只给受保护预览用：--find-copies-harder 会把未修改文件也当复制源，能识破「从敏感文件复制出新文件」。
// 它比普通 diff 贵，但不影响 Git 工作流的默认预览。
const PROTECTED_DIFF_ARGS = ['diff', '--no-color', '--no-ext-diff', '-M', '-C', '--find-copies-harder'] as const;

/** 受保护预览里一条已跟踪改动；rename/copy 保留源路径。 */
export interface TrackedDiffEntry {
  readonly path: string;
  readonly status: string;
  readonly oldPath?: string;
}

export interface TrackedDiffPlan {
  /** 源或目标命中敏感规则：这些路径的整对改动都不展示。 */
  readonly hidden: ReadonlySet<string>;
  /** 不需要隐藏的路径（改名 / 复制的两侧都算），用于按路径取 diff。 */
  readonly allowed: readonly string[];
  /** 过滤后的元数据；与 allowed 来自同一份 git 清单。 */
  readonly entries: readonly TrackedDiffEntry[];
}

/**
 * 解析 `git diff --name-status -z`。结构不完整就返回 null，绝不能猜。
 * 先收全部记录再统一过滤：一个路径只要在任何记录里被标成敏感源/目标，就从 allowlist 消失，
 * 不让后面的普通记录把它重新放回来。
 */
export function parseTrackedDiffPlan(raw: string): TrackedDiffPlan | null {
  const tokens = raw.split('\0');
  const records: TrackedDiffEntry[] = [];
  const hidden = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i]!;
    if (status === '') continue;
    const mapped = STATUS_OF[status[0] ?? ''] ?? 'modified';
    if (status[0] === 'R' || status[0] === 'C') {
      const from = tokens[++i];
      const to = tokens[++i];
      if (!from || !to) return null;
      records.push({ path: to, status: mapped, oldPath: from });
      if (isSensitivePath(from) || isSensitivePath(to)) {
        hidden.add(from);
        hidden.add(to);
      }
    } else {
      const one = tokens[++i];
      if (!one) return null;
      records.push({ path: one, status: mapped });
      if (isSensitivePath(one)) hidden.add(one);
    }
  }
  const entries = records.filter((entry) => !hidden.has(entry.path) && !(entry.oldPath !== undefined && hidden.has(entry.oldPath)));
  const allowed = [...new Set(entries.flatMap((entry) => (entry.oldPath === undefined ? [entry.path] : [entry.oldPath, entry.path])))];
  return { hidden, allowed, entries };
}

/**
 * 以 git 自己的改名 / 复制识别为准列出工作区改动（#269）。
 * 必须传入已解析的 HEAD，所有 diff 都针对同一个提交，避免中途 symbolic HEAD 移动。
 * 失败时返回 null；调用方必须整段省略，不能退回文本过滤。
 */
async function trackedDiffPlan(git: SimpleGit, head: string): Promise<TrackedDiffPlan | null> {
  const raw = await git.raw([...PROTECTED_DIFF_ARGS, '--name-status', '-z', head]).catch(() => null);
  return raw === null ? null : parseTrackedDiffPlan(raw);
}

export type ProtectedDiff = { readonly ok: true; readonly patch: string } | { readonly ok: false };

/**
 * 受保护模式下的已跟踪 diff：只按 git 清单里的允许路径取。
 * 任何失败都返回 ok:false，由调用方把 patch 留空并标注 notice；没有整树兜底。
 */
export async function protectedDiff(git: Pick<SimpleGit, 'raw'>, head: string, plan: TrackedDiffPlan): Promise<ProtectedDiff> {
  if (plan.allowed.length === 0) return { ok: true, patch: '' };
  if (plan.allowed.length > MAX_DIFF_PATHSPECS) return { ok: false };
  const pathspecs = plan.allowed.map((p) => `:(literal)${p}`);
  const raw = await git.raw([...PROTECTED_DIFF_ARGS, head, '--', ...pathspecs]).catch(() => null);
  return raw === null ? { ok: false } : { ok: true, patch: raw };
}

async function previewOf(path: string, maxPatchBytes: number, redactSensitive = false): Promise<CommitPreview> {
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

  const files: { path: string; status: string }[] = [];
  let notice: string | undefined;
  let protectedUnavailable = false;
  let plan: TrackedDiffPlan | null = null;

  if (redactSensitive) {
    if (head) {
      plan = await trackedDiffPlan(git, head);
      if (plan === null) {
        // 拿不到权威路径清单就整段省略：绝不能退回整树 diff + 文本过滤，那样改名 / 复制目标可能漏出。
        protectedUnavailable = true;
        notice = '敏感路径过滤清单读取失败：为安全起见，本次未返回工作区 diff；请重试或检查 git 状态。';
      }
    } else {
      plan = { hidden: new Set(), allowed: [], entries: [] };
    }
    if (!protectedUnavailable) {
      // 元数据也来自同一份已解析 HEAD 的清单，不再看可能移动的 symbolic HEAD。
      for (const entry of plan!.entries) files.push({ path: entry.path, status: entry.status });
      // 未跟踪文件只列名字；ls-files 不依赖当前 HEAD，也不会把内容带出来。
      const untrackedRaw = await git.raw(['ls-files', '--others', '--exclude-standard', '-z']).catch(() => null);
      if (untrackedRaw === null) {
        protectedUnavailable = true;
        notice = '未跟踪文件清单读取失败：为安全起见，本次未返回工作区 diff。';
      } else {
        for (const file of untrackedRaw.split('\0')) {
          if (file !== '' && !isSensitivePath(file)) files.push({ path: file, status: 'untracked' });
        }
      }
    }
    if (protectedUnavailable) files.length = 0;
  } else {
    // D7：未跟踪文件也算（强制 normal，不受仓库配置影响）。默认预览完全沿用旧参数。
    const porcelain = await git.raw(['-c', 'status.showUntrackedFiles=normal', 'status', '--porcelain=v1', '-z']);
    const parts = porcelain.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i]!;
      if (entry.length < 4) continue;
      const xy = entry.slice(0, 2);
      const code = xy === '??' ? '?' : (xy[0] !== ' ' ? xy[0]! : xy[1]!);
      const renamed = xy[0] === 'R' || xy[0] === 'C';
      if (renamed) i++; // 默认预览不读旧名，但仍要跳过 -z 里的旧名段
      files.push({ path: entry.slice(3), status: STATUS_OF[code] ?? 'modified' });
    }
  }

  let patch = '';
  let truncated = false;
  let patchWithheld = false;
  if (redactSensitive && plan !== null && plan.allowed.length > MAX_DIFF_PATHSPECS) {
    // 路径太多时不再退回整树 diff；整个 patch 留空，并把原因显式带出去。
    patchWithheld = true;
    truncated = true;
    notice = `改动路径超过 ${MAX_DIFF_PATHSPECS} 个，无法安全按路径筛选敏感文件；本次未返回 diff。`;
  }
  if (maxPatchBytes > 0 && (files.length > 0 || (redactSensitive && !protectedUnavailable))) {
    let safe = '';
    if (redactSensitive) {
      if (protectedUnavailable) {
        patchWithheld = true;
      } else if (patchWithheld) {
        // 已在前面判定要整段省略。
      } else if (head) {
        const diff = await protectedDiff(git, head, plan!);
        if (diff.ok) {
          safe = diff.patch;
        } else {
          patchWithheld = true;
          truncated = true;
          notice = '受保护 diff 读取失败：为安全起见，本次未返回 diff。';
        }
      }
    } else {
      safe = head ? await git.raw(['diff', '--no-color', '--no-ext-diff', 'HEAD']).catch(() => '') : '';
    }
    // 未跟踪的只列名字（内容进不了模型，免得把大文件 / 密钥送出去）。
    const untracked = files.filter((f) => f.status === 'untracked').map((f) => `新文件：${f.path}`).join('\n');
    const all = patchWithheld ? '' : [safe, untracked].filter(Boolean).join('\n');
    const bytes = Buffer.from(all);
    truncated = truncated || bytes.length > maxPatchBytes;
    patch = truncated ? bytes.subarray(0, maxPatchBytes).toString('utf8') : all;
  } else if (redactSensitive && protectedUnavailable) {
    truncated = true;
  }
  if (patchWithheld) {
    patch = '';
    truncated = true;
  }
  return {
    isGit: true, branch, defaultBranch, remoteUrl, upstream, ahead, head, files, patch, truncated,
    ...(redactSensitive ? { redactedSensitive: true } : {}),
    ...(notice === undefined ? {} : { notice }),
    sizeBytes: await sizeOf(path)
  };
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
  // git 的报错可能带上 URL 里的凭据：抹掉 user:token@；也可能回显 http.extraHeader / Authorization
  return text
    .replace(/\/\/[^/@\s]+@/g, '//***@')
    .replace(/(authorization:\s*)(basic|bearer)?\s*\S+/gi, '$1***')
    .replace(/x-access-token:[^\s@]+/gi, 'x-access-token:***')
    .trim()
    .split('\n')
    .slice(0, 3)
    .join(' ');
}
