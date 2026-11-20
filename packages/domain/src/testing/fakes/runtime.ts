import type {
  CommitPreview,
  GitStatus,
  RemotePullRequest,
  RepoProbe,
  SessionHosting,
  SessionQueue,
  WorkspaceGit
} from '../../index.ts';
import { err, ok, unavailable } from '../../index.ts';

/**
 * 运行时假件：会话托管、测试队列、假 git。
 * `dispatched` / `frames` / `agents` / `workers` 这几个可变记录属于 `InMemoryWorld`（见 world.ts）。
 */

/** 测试里的队列：直接跑。串行性由 server 的真实实现单独测。 */
export const immediateQueue: SessionQueue = { run: (_id, work) => work() };


export function fakeHosting(): SessionHosting & { live: Map<string, string | null> } {
  return (() => {
  const live = new Map<string, string | null>();
  return {
    live,
    has: (id: string) => live.has(id),
    add: (id: string, workerId: string | null) => void live.set(id, workerId),
    drop: (id: string) => void live.delete(id),
    dropWorker: (workerId: string) => {
      let dropped = 0;
      for (const [id, owner] of live) {
        if (owner !== null && owner !== workerId) continue;
        live.delete(id);
        dropped += 1;
      }
      return dropped;
    },
    clear: () => live.clear()
  };
})();
}

export interface FakeGit {
  /** 「机器:动作:路径」，机器 local = Server 本机。 */
  readonly calls: string[];
  /** 路径 → 状态；没登记的当成干净的 git 目录。 */
  readonly statuses: Map<string, GitStatus>;
  /** 这些路径 inspect 出来是 git 仓库（带 origin）。 */
  readonly repos: Set<string>;
  /** 这些路径 inspect 出来不存在（默认所有路径都存在）；给「补克隆」这类用例用。 */
  readonly absent: Set<string>;
  /** 路径 → git 远端地址（没登记的 git 目录用示例地址）；clone 会自动登记。 */
  readonly remotes: Map<string, string>;
  /** 下一次 clone / addWorktree 失败的原因。 */
  failNext: string | null;
  /** 路径 → 提交预览（ADR 0027 §2）；没登记的 = 干净、无 origin。commit 会清空 files、ahead+1。 */
  readonly previews: Map<string, CommitPreview>;
  /** gh 的行为：null = 没装；否则建出来的 PR 编号从这里递增；listed = 按分支 list 返回的已有 PR。 */
  gh: { next: number; state: RemotePullRequest['state']; listed?: readonly RemotePullRequest[] } | null;
  /** 准备命令的结果；没登记 = 成功（exit 0、无输出），'*' = 所有路径的默认值。 */
  readonly setups: Map<string, { exitCode: number; output: string; timedOut: boolean }>;
  /** 仓库检查：键是 `url@branch`（branch 为空时是 `url@`）；没登记 = 可达、默认分支 main、分支必须叫 main。 */
  readonly repoChecks: Map<string, RepoProbe>;
  /** 带 HTTPS 令牌的调用：`机器:动作:目标:header`，只在调用方传了 auth 时记（断言令牌透传）。 */
  readonly authCalls: string[];
  on(machine: string): WorkspaceGit;
}

export function fakeGit(): FakeGit {
  const calls: string[] = [];
  const statuses = new Map<string, GitStatus>();
  const repos = new Set<string>();
  const previews = new Map<string, CommitPreview>();
  const setups = new Map<string, { exitCode: number; output: string; timedOut: boolean }>();
  const absent = new Set<string>();
  const remotes = new Map<string, string>();
  const repoChecks = new Map<string, RepoProbe>();
  const authCalls: string[] = [];
  const state: FakeGit = {
    calls,
    authCalls,
    statuses,
    repos,
    absent,
    remotes,
    failNext: null,
    previews,
    gh: null,
    setups,
    repoChecks,
    on(machine) {
      const noteAuth = (op: string, target: string, auth?: { readonly header: string }) => {
        if (auth) authCalls.push(`${machine}:${op}:${target}:${auth.header}`);
      };
      const fail = () => {
        const reason = state.failNext;
        state.failNext = null;
        return reason;
      };
      const statusOf = (path: string): GitStatus =>
        statuses.get(path) ?? { dirty: false, untracked: 0, unpushed: 0, branch: 'main', upstream: null };
      return {
        inspect: async (path) => {
          calls.push(`${machine}:inspect:${path}`);
          const isGit = repos.has(path);
          const exists = isGit || !absent.has(path);
          return ok({
            exists,
            isGit,
            remoteUrl: isGit ? (remotes.get(path) ?? 'https://example.com/demo.git') : null,
            branch: isGit ? 'main' : null
          });
        },
        checkRepo: async (repoUrl, branch, auth) => {
          calls.push(`${machine}:check_repo:${repoUrl}${branch ? `@${branch}` : ''}`);
          noteAuth('check_repo', repoUrl, auth);
          const reason = fail();
          if (reason) return err(unavailable(reason));
          return ok(repoChecks.get(`${repoUrl}@${branch ?? ''}`) ?? { reachable: true, defaultBranch: 'main', branchExists: branch === null || branch === 'main', message: null });
        },
        clone: async (input) => {
          calls.push(`${machine}:clone:${input.repoUrl}->${input.parent}/${input.name}`);
          noteAuth('clone', input.repoUrl, input.auth);
          const reason = fail();
          if (reason) return err(unavailable(reason));
          repos.add(`${input.parent}/${input.name}`);
          remotes.set(`${input.parent}/${input.name}`, input.repoUrl);
          return ok({ path: `${input.parent}/${input.name}`, branch: input.branch ?? 'main' });
        },
        addWorktree: async (input) => {
          calls.push(`${machine}:worktree:${input.repoPath}->${input.path}@${input.branch}${input.existing ? ':existing' : ''}${input.base ? `<${input.base}` : ''}`);
          noteAuth('worktree', input.repoPath, input.auth);
          const reason = fail();
          if (reason) return err(unavailable(reason));
          return ok({ path: input.path, branch: input.branch });
        },
        status: async (path) => {
          calls.push(`${machine}:status:${path}`);
          const reason = fail();
          if (reason) return err(unavailable(reason));
          return ok(statusOf(path));
        },
        saveWip: async (path, message, auth) => {
          calls.push(`${machine}:save_wip:${path}:${message}`);
          noteAuth('save_wip', path, auth);
          const reason = fail();
          if (reason) return err(unavailable(reason));
          const status = statusOf(path);
          const committed = Boolean(status.dirty) || status.untracked > 0;
          statuses.set(path, { ...status, dirty: false, untracked: 0, unpushed: 0, upstream: `origin/${status.branch}` });
          return ok({ committed, pushed: true, branch: status.branch, reason: null });
        },
        preview: async (path, maxPatchBytes) => {
          calls.push(`${machine}:preview:${path}`);
          const found = previews.get(path) ?? { isGit: true, branch: 'main', defaultBranch: 'main', remoteUrl: null, upstream: null, ahead: 0, head: 'h0', files: [], patch: '', truncated: false };
          if (found.patch.length > maxPatchBytes) return ok({ ...found, patch: found.patch.slice(0, maxPatchBytes), truncated: true });
          return ok(found);
        },
        commit: async (path, input) => {
          calls.push(`${machine}:commit:${path}:${input.authorName}<${input.authorEmail}>:${input.message.split('\n')[0]}`);
          const p = previews.get(path);
          if (!p || p.files.length === 0) return ok({ committed: false, sha: null, reason: '没有改动' });
          const sha = `c${calls.length}`;
          previews.set(path, { ...p, files: [], patch: '', head: sha, ahead: p.ahead + 1 });
          return ok({ committed: true, sha, reason: null });
        },
        push: async (path, auth) => {
          calls.push(`${machine}:push:${path}`);
          noteAuth('push', path, auth);
          const p = previews.get(path);
          if (!p?.remoteUrl) return ok({ pushed: false, branch: p?.branch ?? null, reason: '没有 origin' });
          previews.set(path, { ...p, ahead: 0, upstream: `origin/${p.branch}` });
          return ok({ pushed: true, branch: p.branch, reason: null });
        },
        gh: async (path, request) => {
          calls.push(`${machine}:gh:${request.action}:${path}`);
          if (!state.gh) return ok({ ok: false as const, reason: 'gh 没装' });
          if (request.action === 'list') return ok({ ok: true as const, prs: state.gh.listed ?? [] });
          const number = request.action === 'create' ? state.gh.next++ : request.number;
          return ok({ ok: true as const, pr: { number, url: `https://github.com/o/r/pull/${number}`, state: request.action === 'create' ? 'open' as const : state.gh.state, headSha: null, mergedAt: state.gh.state === 'merged' && request.action === 'view' ? 1 : null } });
        },
        remove: async (path, kind, options) => {
          calls.push(`${machine}:remove:${kind}:${path}${options?.force ? ':force' : ''}`);
          if (options?.force) return ok({ removed: true });
          const status = statusOf(path);
          const squashed = options?.mergedHead !== undefined && status.head === options.mergedHead;
          if (status.dirty || status.untracked > 0 || (status.unpushed > 0 && !squashed)) return ok({ removed: false, reason: '有未保存的改动' });
          return ok({ removed: true });
        },
        runSetup: async ({ path, command, timeoutMs }) => {
          calls.push(`${machine}:run_setup:${path}:${command}:${timeoutMs}`);
          const reason = fail();
          if (reason) return err(unavailable(reason));
          return ok(setups.get(path) ?? setups.get('*') ?? { exitCode: 0, output: '', timedOut: false });
        }
      };
    }
  };
  return state;
}
