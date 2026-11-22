import { can, principalOfSubject, type Subject } from '../access.ts';
import type { AuditLog } from '../ports/audit-log.ts';
import type { NodeGateway } from '../ports/node-gateway.ts';
import type { ProjectRepository } from '../ports/project-repository.ts';
import type { SessionRepository } from '../ports/session-repository.ts';
import type { TaskRepository } from '../ports/task-repository.ts';
import type { WorkLogRepository } from '../ports/work-log-repository.ts';
import type { PersistentAgentRepository } from '../ports/bot-repository.ts';
import type { WorkspaceGroupRepository } from '../ports/workspace-groups.ts';
import type { WorkspaceRepository } from '../ports/workspace-repository.ts';
import type { WorkspaceDelegationStore } from '../workspace-delegation.ts';
import type { CommitPreview, RemotePullRequest, WorkspaceGit } from '../ports/workspace-git.ts';
import type { RepoAuthPort } from '../ports/repo-auth.ts';
import type { GitHostApi, GitHostTokenStore, GitText, GitTextWriter, PullRequestLink, PullRequestRepository } from '../ports/pull-requests.ts';
import { archiveAfterPullRequestMerged } from './session-archive.ts';
import type { Project } from '../project.ts';
import { isContainerSession, type Session } from '../session.ts';
import type { Workspace } from '../workspace.ts';
import { asSessionId, asTaskId, newId } from '../ids.ts';
import type { TaskId } from '../ids.ts';
import { conflict, forbidden, invalid, type DomainError } from '../errors.ts';
import { draftLogEntry } from '../work-log.ts';
import { err, ok, type Result } from '../result.ts';
import { GIT_LIMITS, compareUrl, githubRepoOf, templateGitText } from '../git-workflow.ts';
import { authorizeProject, authorizeSession, type AccessPolicy } from './authorization.ts';
import { gitFor } from './machine-dirs.ts';
import { locationsOf, projectOfSession } from './workspaces.ts';

/**
 * 提交 / 推送 / 开 PR（ADR 0027 阶段 2）。会话 → 工作空间 → 那台机器上的 git。
 * 权限：提交 = 会话的 session.prompt（能叫 agent 改代码就能把改动提交）；推送 / PR = 项目的 git.push（D5）。
 * PR 两条路（D3）：团队 token（hub 调 REST）→ Worker 已登录的 gh → 只推送 + 给个「去 GitHub 新建」链接。
 */
export interface GitWorkflowDeps {
  readonly projects: Pick<ProjectRepository, 'byId'>;
  readonly tasks: Pick<TaskRepository, 'byId'>;
  readonly sessions: Pick<SessionRepository, 'byId' | 'save' | 'listByWorkspace' | 'listByProject' | 'listByTask'>;
  readonly workspaces: WorkspaceRepository;
  /** 组合工作空间（多仓库）；容器会话按它 / 工作空间反推项目（#221 步骤 7）。 */
  readonly workspaceGroups: WorkspaceGroupRepository;
  /** 容器会话（没有任务）的 bot 归属（#221 步骤 7）。 */
  readonly bots: Pick<PersistentAgentRepository, 'byId'>;
  readonly gateway: NodeGateway;
  readonly access?: AccessPolicy;
  readonly audit: Pick<AuditLog, 'append'>;
  readonly workLog: Pick<WorkLogRepository, 'list' | 'append'>;
  /** Server 本机的 git（远端走 gateway.git）。 */
  readonly git: WorkspaceGit;
  /** 私有 HTTPS 仓库的令牌（push 时用）；不给 = 只用机器自己的凭据。 */
  readonly repoAuth?: RepoAuthPort;
  readonly pullRequests: PullRequestRepository;
  readonly tokens: GitHostTokenStore;
  readonly host: GitHostApi;
  readonly writer?: GitTextWriter;
  /** 兜底团队（老数据 team_id 为 NULL）。 */
  readonly hubTeamId: () => Promise<string | null>;
  /**
   * 持久派工的执行会话身份（可选：老装配 / 测试没有它时行为不变）。
   * 命中时普通 push / PR 入口在预览与副作用前拒绝；本地 commit 不受影响。
   */
  readonly delegations?: Pick<WorkspaceDelegationStore, 'byExecutionSession'>;
  readonly now: () => number;
}

export type GitAction = 'commit' | 'push' | 'pr';
export type PrVia = 'token' | 'gh' | 'link';

export interface GitState {
  readonly isGit: boolean;
  readonly branch: string | null;
  readonly defaultBranch: string | null;
  readonly hasOrigin: boolean;
  /** github owner/name；不是 GitHub null。 */
  readonly repo: string | null;
  readonly files: CommitPreview['files'];
  readonly ahead: number;
  readonly upstream: string | null;
  readonly canPush: boolean;
  /** 不能开 PR 的原因（在默认分支上 / 没 origin / 不是 GitHub）；能开 null。 */
  readonly prBlocked: string | null;
  /** 有 token 走 token，否则试 gh（真不行再退成链接）。 */
  readonly prVia: 'token' | 'gh';
  readonly pullRequests: readonly PullRequestLink[];
  /** 该成员工作目录占用；拿不到就省略。 */
  readonly sizeBytes?: number | null;
}

export interface GitRunInput {
  /** commit = 只提交；push = 提交（有改动时）+ 推送；pr = 再开 PR。 */
  readonly action: GitAction;
  readonly message: string;
  readonly title?: string;
  readonly body?: string;
}

export interface GitRunOutcome {
  readonly sha: string | null;
  readonly committed: boolean;
  readonly pushed: boolean;
  readonly branch: string | null;
  readonly pullRequest: PullRequestLink | null;
  /** PR 两条路都没走通：给人点的链接。 */
  readonly compareUrl: string | null;
  readonly notes: readonly string[];
}

interface Located {
  readonly git: WorkspaceGit;
  /** 工作空间所在机器（null = hub 本机）；解析仓库令牌时用。 */
  readonly workerId: string | null;
  readonly root: string;
  readonly session: Session;
  readonly project: Project;
  readonly workspace: Workspace | null;
}

export function createGitWorkflowService(deps: GitWorkflowDeps) {
  async function locate(subject: Subject | null, sessionId: string, permission: 'session.read' | 'session.prompt', member?: string): Promise<Result<Located, DomainError>> {
    const session = await deps.sessions.byId(asSessionId(sessionId));
    const project = session ? await projectOfSession(deps, session) : null;
    const seen = await authorizeSession(deps.access, subject, project, session, permission);
    if (!seen.ok) return seen;
    const files = await authorizeProject(deps.access, subject, project, 'workspace.files.read');
    if (!files.ok) return files;
    const location = await locationsOf(deps, files.value, seen.value);
    if (location.root === '') return err(invalid('这条会话还没有工作空间'));
    let root = location.root;
    // 组合工作空间（§12.5）：git 只在成员仓库里跑，容器根不是仓库。
    if (location.group !== null) {
      const options = location.members.map((item) => item.name).filter(Boolean);
      const hint = options.length ? `，可选：${options.join('、')}` : '';
      if (!member) return err(invalid(`请选择要提交的仓库（member 传仓库名或 workspaceId${hint}）`));
      const picked = location.members.find((item) => item.workspaceId === member || item.name === member || item.repoId === member);
      if (!picked) return err(invalid(`这颗仓库不属于这条会话的组合工作空间（member 传仓库名或 workspaceId${hint}）`));
      root = picked.root;
    }
    const workspace = seen.value.workspaceId ? await deps.workspaces.byId(seen.value.workspaceId) : null;
    return ok({ git: await gitFor(deps, location.workerId), workerId: location.workerId, root, session: seen.value, project: files.value, workspace });
  }

  const canPush = async (subject: Subject | null, project: Project): Promise<boolean> => (await authorizeProject(deps.access, subject, project, 'git.push')).ok;
  const teamOf = async (project: Project): Promise<string | null> => project.teamId ?? (await deps.hubTeamId());

  function prBlocked(preview: CommitPreview, workspace: Workspace | null): string | null {
    if (!preview.remoteUrl) return '没有 origin 远端，只能提交';
    if (!githubRepoOf(preview.remoteUrl)) return 'origin 不是 GitHub，推送后请到托管平台上开 PR';
    if (!preview.branch) return '当前不在分支上（detached HEAD）';
    // base 只信 origin 报的默认分支；拿不到就不能开 PR，绝不替用户写死 main
    if (!preview.defaultBranch) return '取不到 origin 的默认分支（先 fetch origin），不能凭空选 base';
    if (preview.branch === preview.defaultBranch) {
      return workspace?.kind === 'temporary' ? '临时工作空间不该在默认分支上' : `长期工作空间在默认分支 ${preview.branch} 上，不能对它自己开 PR；先切到功能分支`;
    }
    return null;
  }

  async function state(subject: Subject | null, sessionId: string, member?: string): Promise<Result<GitState, DomainError>> {
    const found = await locate(subject, sessionId, 'session.read', member);
    if (!found.ok) return found;
    const preview = await found.value.git.preview(found.value.root, 0);
    if (!preview.ok) return preview;
    const p = preview.value;
    const team = await teamOf(found.value.project);
    const token = team ? await deps.tokens.status(team) : { configured: false };
    return ok({
      isGit: p.isGit,
      branch: p.branch,
      defaultBranch: p.defaultBranch,
      hasOrigin: p.remoteUrl !== null,
      repo: githubRepoOf(p.remoteUrl),
      files: p.files,
      ahead: p.ahead,
      upstream: p.upstream,
      canPush: await canPush(subject, found.value.project),
      prBlocked: prBlocked(p, found.value.workspace),
      prVia: token.configured ? 'token' : 'gh',
      pullRequests: isContainerSession(found.value.session) ? [] : await deps.pullRequests.byTask(found.value.session.taskId as TaskId),
      ...(p.sizeBytes == null ? {} : { sizeBytes: p.sizeBytes })
    });
  }

  /** D4：提炼模型写；没配 / 失败 / 被拒用模板。 */
  async function draft(subject: Subject | null, sessionId: string, member?: string): Promise<Result<GitText & { source: 'model' | 'template' }, DomainError>> {
    const found = await locate(subject, sessionId, 'session.prompt', member);
    if (!found.ok) return found;
    const preview = await found.value.git.preview(found.value.root, GIT_LIMITS.patchBytes);
    if (!preview.ok) return preview;
    if (!preview.value.isGit) return err(invalid('这个工作空间不是 git 仓库'));
    // 容器会话（#221 步骤 7）没有任务日志可读：标题和工作日志留空，用模板写。
    const task = isContainerSession(found.value.session) ? null : await deps.tasks.byId(found.value.session.taskId as TaskId);
    const log = isContainerSession(found.value.session)
      ? []
      : await deps.workLog.list(found.value.session.taskId as TaskId, { limit: 8, excludeSystem: true });
    const input = {
      projectId: found.value.project.id,
      taskTitle: task?.title ?? '',
      files: preview.value.files,
      patch: preview.value.patch,
      workLog: log.map((e) => e.body).reverse().join('\n\n').slice(0, 4000)
    };
    const written = deps.writer ? await deps.writer.write(input).catch(() => null) : null;
    return ok(written ? { ...written, source: 'model' as const } : { ...templateGitText(input), source: 'template' as const });
  }

  async function run(subject: Subject | null, sessionId: string, input: GitRunInput, member?: string): Promise<Result<GitRunOutcome, DomainError>> {
    const message = input.message.trim();
    if (message.length > GIT_LIMITS.messageChars) return err(invalid('提交说明太长'));
    const found = await locate(subject, sessionId, 'session.prompt', member);
    if (!found.ok) return found;
    const { git, workerId, root, project, session, workspace } = found.value;
    // 派工执行会话（docs/design/workspace-delegation.md §4）：平台不替它发布。
    // 在 preview / 任何副作用之前按持久身份拒绝，且与 actor / 调用入口（API 或 agent 工具）无关。
    if (input.action !== 'commit' && deps.delegations && (await deps.delegations.byExecutionSession(session.id))) {
      return err(conflict('派工执行会话不能推送或开 PR：请在主会话里由人确认发布'));
    }
    if (input.action !== 'commit' && !(await canPush(subject, project))) return err(conflict('你没有这个项目的推送权限（git.push）'));
    const me = principalOfSubject(subject);
    const preview = await git.preview(root, 0);
    if (!preview.ok) return preview;
    if (!preview.value.isGit) return err(invalid('这个工作空间不是 git 仓库'));
    if (input.action !== 'commit' && !preview.value.remoteUrl) return err(conflict('没有 origin 远端，只能提交'));
    // #217 / #221 步骤 0：不许把默认分支推上去——绕过 PR 直接改主干，审查与回滚都失效。
    if (input.action !== 'commit' && preview.value.defaultBranch !== null && preview.value.branch === preview.value.defaultBranch) {
      return err(conflict(`不能推送默认分支 ${preview.value.branch}：先切到功能分支，再走 PR`));
    }
    if (input.action === 'pr') {
      const blocked = prBlocked(preview.value, workspace);
      if (blocked) return err(conflict(blocked));
      if (!input.title?.trim()) return err(invalid('PR 标题不能为空'));
    }
    const notes: string[] = [];
    let sha: string | null = preview.value.head;
    let committed = false;
    if (preview.value.files.length > 0) {
      if (!message) return err(invalid('提交说明不能为空'));
      const done = await git.commit(root, {
        message,
        authorName: me?.user.displayName || me?.user.email || 'agent-hub',
        authorEmail: me?.user.email || 'agent-hub@localhost'
      });
      if (!done.ok) return done;
      if (!done.value.committed) return err(conflict(done.value.reason ?? '提交失败'));
      committed = true;
      sha = done.value.sha;
      await audit(subject, project, 'git.commit', session.id, `${preview.value.branch ?? 'HEAD'} ${sha ?? ''}`);
    } else if (input.action === 'commit') {
      return err(conflict('没有要提交的改动'));
    } else {
      notes.push('没有新改动，直接推送已有提交');
    }
    let pushed = false;
    const branch = preview.value.branch;
    if (input.action !== 'commit') {
      // 私有 HTTPS 仓库：按工作空间路径反查项目仓库的令牌；拿不到就照旧用机器自己的凭据
      const auth = (await deps.repoAuth?.forPath(workerId, root)) ?? undefined;
      const out = await git.push(root, auth);
      if (!out.ok) return out;
      if (!out.value.pushed) return ok({ sha, committed, pushed: false, branch, pullRequest: null, compareUrl: null, notes: [...notes, `推送失败：${out.value.reason ?? '未知原因'}`] });
      pushed = true;
      await audit(subject, project, 'git.push', session.id, branch ?? '');
    }
    let pullRequest: PullRequestLink | null = null;
    let link: string | null = null;
    if (input.action === 'pr' && branch) {
      const repo = githubRepoOf(preview.value.remoteUrl)!;
      // prBlocked 已确认 defaultBranch 存在；这里只做类型收窄，不再回落 main
      const base = preview.value.defaultBranch!;
      const title = input.title!.trim().slice(0, GIT_LIMITS.titleChars);
      const body = (input.body ?? '').slice(0, GIT_LIMITS.bodyChars);
      const team = await teamOf(project);
      const token = team ? await deps.tokens.reveal(team) : null;
      let created: { pr: RemotePullRequest; via: 'token' | 'gh' } | null = null;
      if (token) {
        const r = await deps.host.createPullRequest({ token, repo, base, head: branch, title, body });
        if (r.ok) created = { pr: r.pr, via: 'token' };
        else notes.push(`团队 token 开 PR 失败：${r.reason}`);
      }
      if (!created) {
        const r = await git.gh(root, { action: 'create', base, head: branch, title, body });
        if (r.ok && r.value.ok && 'pr' in r.value) created = { pr: r.value.pr, via: 'gh' };
        else notes.push(`Worker 上的 gh 不可用：${r.ok ? (r.value as { reason: string }).reason : r.error.message}`);
      }
      if (created) {
        const now = deps.now();
        await audit(subject, project, 'git.pr', session.id, `${repo}#${created.pr.number} via ${created.via}`);
        // PR 行和工作日志都按任务汇总；容器会话没有任务，PR 只回到本次结果里（#221 步骤 7）。
        if (!isContainerSession(session)) {
          const taskId = session.taskId as TaskId;
          pullRequest = {
            id: newId(),
            taskId,
            workspaceId: workspace?.id ?? null,
            sessionId: session.id,
            provider: 'github',
            via: created.via,
            repo,
            number: created.pr.number,
            url: created.pr.url,
            branch,
            base,
            state: created.pr.state,
            headSha: created.pr.headSha ?? sha,
            mergedAt: created.pr.mergedAt,
            createdBy: me?.user.id ?? 'system',
            createdAt: now,
            lastSyncedAt: now
          };
          await deps.pullRequests.save(pullRequest);
          const entry = draftLogEntry({ id: newId(), taskId: asTaskId(taskId), author: { kind: 'system' }, body: `开了 PR [${repo}#${created.pr.number}](${created.pr.url})：${title}`, links: [{ kind: 'pr', ref: created.pr.url, label: `#${created.pr.number}` }], sessionId: session.id, now });
          if (entry.ok) await deps.workLog.append(entry.value).catch(() => undefined);
        }
      } else {
        link = compareUrl(repo, base, branch);
      }
    }
    return ok({ sha, committed, pushed, branch, pullRequest, compareUrl: link, notes });
  }

  async function listForTask(subject: Subject | null, taskId: string): Promise<Result<readonly PullRequestLink[], DomainError>> {
    const task = await deps.tasks.byId(asTaskId(taskId));
    const project = task ? await deps.projects.byId(task.projectId) : null;
    const allowed = await authorizeProject(deps.access, subject, project, 'project.read');
    if (!allowed.ok) return allowed;
    return ok(await deps.pullRequests.byTask(taskId));
  }

  /** 同步一个 PR 的状态：token 优先，再试建它那台机器的 gh；都不行原样留着。 */
  async function syncOne(link: PullRequestLink): Promise<PullRequestLink> {
    let remote: RemotePullRequest | null = null;
    const task = await deps.tasks.byId(asTaskId(link.taskId));
    const project = task ? await deps.projects.byId(task.projectId) : null;
    const team = project ? await teamOf(project) : null;
    const token = team ? await deps.tokens.reveal(team) : null;
    if (token) {
      const r = await deps.host.getPullRequest({ token, repo: link.repo, number: link.number });
      if (r.ok) remote = r.pr;
    }
    if (!remote) {
      // 没 token：回到开 PR 的那个地方用 gh 查（工作空间，或会话所在的项目根目录）
      let where: { workerId: string | null; root: string } | null = null;
      const workspace = link.workspaceId ? await deps.workspaces.byId(link.workspaceId as never) : null;
      if (workspace && workspace.state !== 'removed') where = { workerId: workspace.workerId, root: workspace.path };
      else if (!workspace && link.sessionId && project) {
        const session = await deps.sessions.byId(asSessionId(link.sessionId));
        if (session) {
          const location = await locationsOf(deps, project, session).catch(() => null);
          // 组合工作空间：容器根不是 git 仓库，这里的 gh 兜底不适用（有 workspaceId 的链接走上面）。
          if (location && location.group === null && location.root !== '') where = { workerId: location.workerId, root: location.root };
        }
      }
      if (where) {
        const git = await gitFor(deps, where.workerId);
        const r = await git.gh(where.root, { action: 'view', number: link.number }).catch(() => null);
        if (r?.ok && r.value.ok && 'pr' in r.value) remote = r.value.pr;
      }
    }
    const next: PullRequestLink = remote
      ? { ...link, state: remote.state, headSha: remote.headSha ?? link.headSha, mergedAt: remote.mergedAt, url: remote.url || link.url, lastSyncedAt: deps.now() }
      : { ...link, lastSyncedAt: deps.now() };
    await deps.pullRequests.save(next);
    if (next.state === 'merged' && link.state !== 'merged') {
      await archiveAfterPullRequestMerged({ ...deps, cleanup: { pullRequests: deps.pullRequests } as never }, next).catch(() => 0);
    }
    return next;
  }

  /** 巡检：10 分钟没同步过的开着的 PR。 */
  async function syncDue(limit = 50): Promise<number> {
    const due = await deps.pullRequests.openSyncedBefore(deps.now() - GIT_LIMITS.syncEveryMs, limit);
    for (const link of due) await syncOne(link).catch(() => undefined);
    return due.length;
  }

  /**
   * 按分支认领的候选：仓库 + 分支 + 本地 HEAD。
   * 仓库和分支都来自那个目录实际的 origin / 检出（不信任工作空间登记的历史值），
   * `head` 是认领时唯一的本地证据：PR 的 head_sha 必须正好是它。
   */
  interface BranchCandidate {
    readonly repo: string;
    readonly branch: string;
    readonly head: string;
    readonly defaultBranch: string | null;
    readonly workerId: string | null;
    readonly root: string | null;
    readonly workspaceId: string | null;
    readonly sessionId: string | null;
  }

  /** 打开任务时的按分支发现节流：和普通同步一样最多 1 分钟一次，避免连点打爆 GitHub；refresh 立刻来。 */
  const lastBranchScanAt = new Map<string, number>();

  /** owner/name 大小写不敏感（GitHub 仓库名就是），比较 / 去重都用它。 */
  const repoKey = (repo: string): string => repo.toLowerCase();

  /**
   * 任务下有哪些 checkout 可能在 GitHub 上有 PR：每个目录只 preview 一次，用真实 origin + HEAD 当证据。
   * 登记表里的 repoUrl / branch 可能是历史值（agent 换过分支、仓库改过 remote），不能拿来认领。
   */
  async function branchCandidates(subject: Subject | null, taskId: string, project: Project, knownBranches: ReadonlySet<string>): Promise<BranchCandidate[]> {
    const found: BranchCandidate[] = [];
    const seen = new Set<string>();
    const spots = new Map<string, { workerId: string | null; root: string; workspaceId: string | null; sessionId: string | null }>();
    // 同一目录可能被工作空间行和会话同时看到：有会话就有会话（PR 要挂到会话上）
    const addSpot = (spot: { workerId: string | null; root: string; workspaceId: string | null; sessionId: string | null }): void => {
      const key = `${spot.workerId ?? ''}:${spot.root}`;
      const previous = spots.get(key);
      if (!previous || (previous.sessionId === null && spot.sessionId !== null)) spots.set(key, spot);
    };
    const add = (candidate: BranchCandidate): void => {
      // 默认分支上的 PR 不会是这条任务的（也不该被自动认领）。defaultBranch 拿不到时才退回名字兜底，不凭空写 main。
      if (candidate.defaultBranch !== null ? candidate.branch === candidate.defaultBranch : candidate.branch === 'main' || candidate.branch === 'master') return;
      const branchKey = `${repoKey(candidate.repo)}#${candidate.branch}`;
      if (knownBranches.has(branchKey)) return; // 已落库的分支：普通同步会去管它
      // 同仓库同分支在不同目录可能有不同的 HEAD（例如同一任务的两个 checkout）：
      // 去重要带上 HEAD，否则先扫到的那条会把后一条真正匹配 PR 的候选吞掉（#269）。
      const key = `${branchKey}#${candidate.head}`;
      if (seen.has(key)) return;
      seen.add(key);
      found.push(candidate);
    };
    // 任务自己的工作空间（临时 worktree）：目录还可用就去看它的 HEAD
    for (const workspace of await deps.workspaces.byTask(asTaskId(taskId))) {
      if (workspace.state === 'removed') continue;
      addSpot({ workerId: workspace.workerId, root: workspace.path, workspaceId: workspace.id, sessionId: null });
    }
    // 会话的工作区 / 组合工作空间成员（同一目录只问一次）
    for (const session of await deps.sessions.listByTask(asTaskId(taskId))) {
      if (!(await authorizeSession(deps.access, subject, project, session, 'session.read')).ok) continue;
      const workspace = session.workspaceId ? await deps.workspaces.byId(session.workspaceId) : null;
      if (workspace && workspace.state !== 'removed') {
        addSpot({ workerId: workspace.workerId, root: workspace.path, workspaceId: workspace.id, sessionId: session.id });
      }
      const location = await locationsOf(deps, project, session).catch(() => null);
      if (location?.group) {
        // 组合工作空间：git 在成员仓库里，逐个成员看当前分支
        for (const member of location.members) addSpot({ workerId: location.workerId, root: member.root, workspaceId: member.workspaceId, sessionId: session.id });
      } else if (location && location.root !== '') {
        addSpot({ workerId: location.workerId, root: location.root, workspaceId: session.workspaceId ?? null, sessionId: session.id });
      }
    }
    for (const spot of spots.values()) {
      const preview = await (await gitFor(deps, spot.workerId)).preview(spot.root, 0).catch(() => null);
      if (!preview?.ok || !preview.value.isGit) continue;
      const repo = githubRepoOf(preview.value.remoteUrl);
      const branch = preview.value.branch;
      const head = preview.value.head;
      // 缺 origin / 分支 / HEAD 就没有认领的资格：宁可少认，不能把别的任务的 PR 串过来
      if (!repo || !branch || !head) continue;
      add({ repo, branch, head, defaultBranch: preview.value.defaultBranch, workerId: spot.workerId, root: spot.root, workspaceId: spot.workspaceId, sessionId: spot.sessionId });
    }
    return found;
  }

  /** 查一个分支在 GitHub 上的 PR：token 优先（hub 直调 REST），不行再用分支所在机器的 gh。 */
  async function fetchByBranch(candidate: BranchCandidate, token: string | null): Promise<{ ok: true; prs: readonly RemotePullRequest[]; via: 'token' | 'gh' } | { ok: false; reason: string }> {
    if (token) {
      const r = await deps.host.listPullRequestsByHead({ token, repo: candidate.repo, head: candidate.branch }).catch(() => ({ ok: false as const, reason: '连不上 GitHub' }));
      if (r.ok) return { ok: true, prs: r.prs, via: 'token' };
    }
    if (candidate.root !== null) {
      const git = await gitFor(deps, candidate.workerId);
      const r = await git.gh(candidate.root, { action: 'list', head: candidate.branch, repo: candidate.repo }).catch(() => null);
      if (r?.ok && r.value.ok && 'prs' in r.value) return { ok: true, prs: r.value.prs, via: 'gh' };
      if (r?.ok && !r.value.ok) return r.value;
      if (r && !r.ok) return { ok: false, reason: r.error.message };
    }
    return { ok: false, reason: token ? 'GitHub API 和 gh 都不可用' : '没有 token，gh 也不可用' };
  }

  /**
   * 按分支认领：GitHub 上已有、但没走 session_git_run 的 PR（#262：agent 用 gh pr create 在会话分支上开的）。
   * 认进任务后走普通同步。失败不打断已有列表：原因写进工作日志。
   */
  async function adoptByBranch(
    subject: Subject | null,
    taskId: string,
    project: Project,
    listed: readonly PullRequestLink[],
    options?: { readonly refresh?: boolean }
  ): Promise<readonly PullRequestLink[]> {
    const now = deps.now();
    const lastScanAt = lastBranchScanAt.get(taskId);
    // 只有扫过一次之后才节流（fake 时钟的 now 可能远小于 60_000，不能用 0 当「没扫过」）
    if (!options?.refresh && lastScanAt !== undefined && now - lastScanAt < 60_000) return [];
    lastBranchScanAt.set(taskId, now);
    const knownBranches = new Set(listed.map((link) => `${repoKey(link.repo)}#${link.branch}`));
    const knownNumbers = new Set(listed.map((link) => `${repoKey(link.repo)}#${link.number}`));
    const candidates = await branchCandidates(subject, taskId, project, knownBranches);
    if (candidates.length === 0) return [];
    const team = await teamOf(project);
    const token = team ? await deps.tokens.reveal(team) : null;
    const failures: string[] = [];
    const adopted: PullRequestLink[] = [];
    for (const candidate of candidates) {
      const remote = await fetchByBranch(candidate, token).catch(() => ({ ok: false as const, reason: '查 PR 失败' }));
      if (!remote.ok) {
        failures.push(`${candidate.repo}#${candidate.branch}：${remote.reason}`);
        continue;
      }
      for (const pr of remote.prs) {
        // 自动认领只收「开着的、且能证明 head 就是这次 checkout」的 PR：
        // - closed / merged 是历史 PR（合并收敛由 syncOne 的 state 同步与 ADR 0027 §3 的清理路径负责，不在这里补认）
        // - head_sha 必须等于本地 HEAD：同仓库同分支名的另一条任务不会被串进来
        // - head 仓库 / 分支名必须对上（gh 按分支列可能带回 fork / 近似分支）；老 Worker 不带这两项，一律跳过
        // - base 只信 PR 自己报的或 preview 的 defaultBranch，绝不回落写死的 main
        if (pr.state !== 'open') continue;
        if (!pr.headSha || pr.headSha !== candidate.head) continue;
        if (!pr.headRef || pr.headRef !== candidate.branch) continue;
        if (!pr.repo || repoKey(pr.repo) !== repoKey(candidate.repo)) continue;
        const base = pr.base ?? candidate.defaultBranch;
        if (!base || base === candidate.branch) continue;
        // 同一 repo#number 只认一次（库里已有 / 同一轮已认的都跳过）
        const numberKey = `${repoKey(candidate.repo)}#${pr.number}`;
        if (knownNumbers.has(numberKey)) continue;
        knownNumbers.add(numberKey);
        const link: PullRequestLink = {
          id: newId(),
          taskId,
          workspaceId: candidate.workspaceId,
          sessionId: candidate.sessionId,
          provider: 'github',
          via: remote.via,
          repo: candidate.repo,
          number: pr.number,
          url: pr.url,
          branch: candidate.branch,
          base,
          state: pr.state,
          headSha: pr.headSha,
          mergedAt: pr.mergedAt,
          createdBy: principalOfSubject(subject)?.user.id ?? 'system',
          createdAt: now,
          lastSyncedAt: now
        };
        await deps.pullRequests.save(link).catch(() => undefined);
        adopted.push(link);
        const entry = draftLogEntry({ id: newId(), taskId: asTaskId(taskId), author: { kind: 'system' }, body: `认领已有 PR [${link.repo}#${link.number}](${link.url})（head 是分支 ${link.branch}，不是从会话里开的）`, links: [{ kind: 'pr', ref: link.url, label: `#${link.number}` }], sessionId: link.sessionId ? asSessionId(link.sessionId) : null, now });
        if (entry.ok) await deps.workLog.append(entry.value).catch(() => undefined);
      }
    }
    if (adopted.length === 0 && failures.length > 0) {
      const entry = draftLogEntry({ id: newId(), taskId: asTaskId(taskId), author: { kind: 'system' }, body: `按分支找已有 PR 没成功：${failures.join('；').slice(0, 300)}`, links: [], sessionId: null, now });
      if (entry.ok) await deps.workLog.append(entry.value).catch(() => undefined);
    }
    return adopted;
  }

  /**
   * 打开任务时：看得见就同步一遍这个任务开着的 PR（默认最多 1 分钟一次，避免连点刷新打爆 GitHub）。
   * `refresh: true` 时立刻再拉一次（人刚在外面合并、要马上收起会话）。
   */
  async function syncTask(
    subject: Subject | null,
    taskId: string,
    options?: { readonly refresh?: boolean }
  ): Promise<Result<readonly PullRequestLink[], DomainError>> {
    const listed = await listForTask(subject, taskId);
    if (!listed.ok) return listed;
    const task = await deps.tasks.byId(asTaskId(taskId));
    const project = task ? await deps.projects.byId(task.projectId) : null;
    // 先认领没走 session_git_run 的（#262）：head 是任务下会话分支、GitHub 上已有但没落库的 PR
    const adopted = project ? await adoptByBranch(subject, taskId, project, listed.value, options).catch(() => [] as readonly PullRequestLink[]) : [];
    const minAgeMs = options?.refresh ? 0 : 60_000;
    const out: PullRequestLink[] = [];
    for (const link of [...listed.value, ...adopted]) {
      out.push(link.state === 'open' && deps.now() - link.lastSyncedAt >= minAgeMs ? await syncOne(link).catch(() => link) : link);
    }
    return ok(out);
  }

  async function audit(subject: Subject | null, project: Project, action: 'git.commit' | 'git.push' | 'git.pr', target: string, detail: string) {
    const me = principalOfSubject(subject);
    await deps.audit.append({ id: newId(), actorId: (me?.user.id ?? 'system') as never, actorEmail: me?.user.email ?? '', action, target, detail: detail.slice(0, 500), at: deps.now(), ...(project.teamId ? { teamId: project.teamId } : {}) });
  }

  /** 团队代码托管 token（D3）：team.manage 才能看状态 / 设 / 删；永远只回「有没有 + 末 4 位」。 */
  async function tokenTeam(subject: Subject | null): Promise<Result<string, DomainError>> {
    const me = principalOfSubject(subject);
    const teamId = me?.user.teamId ?? null;
    if (!teamId || !can(subject, 'team.manage', { kind: 'team', id: teamId, teamId })) return err(forbidden('只有团队 owner / admin 能管理代码托管 token'));
    return ok(teamId);
  }
  async function tokenStatus(subject: Subject | null) {
    const team = await tokenTeam(subject);
    if (!team.ok) return team;
    return ok(await deps.tokens.status(team.value));
  }
  async function setToken(subject: Subject | null, token: string) {
    const team = await tokenTeam(subject);
    if (!team.ok) return team;
    const clean = token.trim();
    if (!/^[A-Za-z0-9_\-]{20,255}$/.test(clean)) return err(invalid('token 格式不对（应是 GitHub 的 ghp_ / github_pat_ 开头那串）'));
    await deps.tokens.put(team.value, clean, deps.now());
    await teamAudit(subject, team.value, 'git.host_token.set', `…${clean.slice(-4)}`);
    return ok(await deps.tokens.status(team.value));
  }
  async function removeToken(subject: Subject | null) {
    const team = await tokenTeam(subject);
    if (!team.ok) return team;
    await deps.tokens.remove(team.value);
    await teamAudit(subject, team.value, 'git.host_token.remove', '');
    return ok(await deps.tokens.status(team.value));
  }
  async function teamAudit(subject: Subject | null, teamId: string, action: 'git.host_token.set' | 'git.host_token.remove', detail: string) {
    const me = principalOfSubject(subject);
    await deps.audit.append({ id: newId(), actorId: (me?.user.id ?? 'system') as never, actorEmail: me?.user.email ?? '', action, target: `team:${teamId}`, detail, at: deps.now(), teamId });
  }

  return { state, draft, run, listForTask, syncTask, syncDue, tokenStatus, setToken, removeToken };
}

export type GitWorkflowService = ReturnType<typeof createGitWorkflowService>;
