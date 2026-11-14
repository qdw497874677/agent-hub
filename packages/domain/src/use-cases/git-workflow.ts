import { can, principalOfSubject, type Subject } from '../access.ts';
import type { AuditLog } from '../ports/audit-log.ts';
import type { NodeGateway } from '../ports/node-gateway.ts';
import type { ProjectRepository } from '../ports/project-repository.ts';
import type { SessionRepository } from '../ports/session-repository.ts';
import type { TaskRepository } from '../ports/task-repository.ts';
import type { WorkLogRepository } from '../ports/work-log-repository.ts';
import type { WorkspaceGroupRepository } from '../ports/workspace-groups.ts';
import type { WorkspaceRepository } from '../ports/workspace-repository.ts';
import type { CommitPreview, RemotePullRequest, WorkspaceGit } from '../ports/workspace-git.ts';
import type { GitHostApi, GitHostTokenStore, GitText, GitTextWriter, PullRequestLink, PullRequestRepository } from '../ports/pull-requests.ts';
import type { Project } from '../project.ts';
import type { Session } from '../session.ts';
import type { Workspace } from '../workspace.ts';
import { asSessionId, asTaskId, newId } from '../ids.ts';
import { conflict, forbidden, invalid, type DomainError } from '../errors.ts';
import { draftLogEntry } from '../work-log.ts';
import { err, ok, type Result } from '../result.ts';
import { GIT_LIMITS, compareUrl, githubRepoOf, templateGitText } from '../git-workflow.ts';
import { authorizeProject, authorizeSession, type AccessPolicy } from './authorization.ts';
import { gitFor } from './machine-dirs.ts';
import { locationsOf } from './workspaces.ts';

/**
 * 提交 / 推送 / 开 PR（ADR 0027 阶段 2）。会话 → 工作空间 → 那台机器上的 git。
 * 权限：提交 = 会话的 session.prompt（能叫 agent 改代码就能把改动提交）；推送 / PR = 项目的 git.push（D5）。
 * PR 两条路（D3）：团队 token（hub 调 REST）→ Worker 已登录的 gh → 只推送 + 给个「去 GitHub 新建」链接。
 */
export interface GitWorkflowDeps {
  readonly projects: Pick<ProjectRepository, 'byId'>;
  readonly tasks: Pick<TaskRepository, 'byId'>;
  readonly sessions: Pick<SessionRepository, 'byId'>;
  readonly workspaces: WorkspaceRepository;
  /** 组合工作空间（多仓库）；不给 = 只会落到单仓库路径。 */
  readonly workspaceGroups?: WorkspaceGroupRepository;
  readonly gateway: NodeGateway;
  readonly access?: AccessPolicy;
  readonly audit: Pick<AuditLog, 'append'>;
  readonly workLog: Pick<WorkLogRepository, 'list' | 'append'>;
  /** Server 本机的 git（远端走 gateway.git）。 */
  readonly git: WorkspaceGit;
  readonly pullRequests: PullRequestRepository;
  readonly tokens: GitHostTokenStore;
  readonly host: GitHostApi;
  readonly writer?: GitTextWriter;
  /** 兜底团队（老数据 team_id 为 NULL）。 */
  readonly hubTeamId: () => Promise<string | null>;
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
  readonly root: string;
  readonly session: Session;
  readonly project: Project;
  readonly workspace: Workspace | null;
}

export function createGitWorkflowService(deps: GitWorkflowDeps) {
  async function locate(subject: Subject | null, sessionId: string, permission: 'session.read' | 'session.prompt', member?: string): Promise<Result<Located, DomainError>> {
    const session = await deps.sessions.byId(asSessionId(sessionId));
    const task = session ? await deps.tasks.byId(session.taskId) : null;
    const project = task ? await deps.projects.byId(task.projectId) : null;
    const seen = await authorizeSession(deps.access, subject, project, session, permission);
    if (!seen.ok) return seen;
    const files = await authorizeProject(deps.access, subject, project, 'workspace.files.read');
    if (!files.ok) return files;
    const location = await locationsOf(deps, files.value, seen.value);
    if (location.root === '') return err(invalid('这条会话还没有工作空间'));
    let root = location.root;
    // 组合工作空间（§12.5）：git 只在成员仓库里跑，容器根不是仓库。
    if (location.group !== null) {
      if (!member) return err(invalid('请选择要提交的仓库'));
      const picked = location.members.find((item) => item.workspaceId === member);
      if (!picked) return err(invalid('这颗仓库不属于这条会话的组合工作空间'));
      root = picked.root;
    }
    const workspace = seen.value.workspaceId ? await deps.workspaces.byId(seen.value.workspaceId) : null;
    return ok({ git: await gitFor(deps, location.workerId), root, session: seen.value, project: files.value, workspace });
  }

  const canPush = async (subject: Subject | null, project: Project): Promise<boolean> => (await authorizeProject(deps.access, subject, project, 'git.push')).ok;
  const teamOf = async (project: Project): Promise<string | null> => project.teamId ?? (await deps.hubTeamId());

  function prBlocked(preview: CommitPreview, workspace: Workspace | null): string | null {
    if (!preview.remoteUrl) return '没有 origin 远端，只能提交';
    if (!githubRepoOf(preview.remoteUrl)) return 'origin 不是 GitHub，推送后请到托管平台上开 PR';
    if (!preview.branch) return '当前不在分支上（detached HEAD）';
    if (preview.defaultBranch && preview.branch === preview.defaultBranch) {
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
      pullRequests: await deps.pullRequests.byTask(found.value.session.taskId)
    });
  }

  /** D4：提炼模型写；没配 / 失败 / 被拒用模板。 */
  async function draft(subject: Subject | null, sessionId: string, member?: string): Promise<Result<GitText & { source: 'model' | 'template' }, DomainError>> {
    const found = await locate(subject, sessionId, 'session.prompt', member);
    if (!found.ok) return found;
    const preview = await found.value.git.preview(found.value.root, GIT_LIMITS.patchBytes);
    if (!preview.ok) return preview;
    if (!preview.value.isGit) return err(invalid('这个工作空间不是 git 仓库'));
    const task = await deps.tasks.byId(found.value.session.taskId);
    const log = await deps.workLog.list(found.value.session.taskId, { limit: 8, excludeSystem: true });
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
    const { git, root, project, session, workspace } = found.value;
    if (input.action !== 'commit' && !(await canPush(subject, project))) return err(conflict('你没有这个项目的推送权限（git.push）'));
    const me = principalOfSubject(subject);
    const preview = await git.preview(root, 0);
    if (!preview.ok) return preview;
    if (!preview.value.isGit) return err(invalid('这个工作空间不是 git 仓库'));
    if (input.action !== 'commit' && !preview.value.remoteUrl) return err(conflict('没有 origin 远端，只能提交'));
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
      const out = await git.push(root);
      if (!out.ok) return out;
      if (!out.value.pushed) return ok({ sha, committed, pushed: false, branch, pullRequest: null, compareUrl: null, notes: [...notes, `推送失败：${out.value.reason ?? '未知原因'}`] });
      pushed = true;
      await audit(subject, project, 'git.push', session.id, branch ?? '');
    }
    let pullRequest: PullRequestLink | null = null;
    let link: string | null = null;
    if (input.action === 'pr' && branch) {
      const repo = githubRepoOf(preview.value.remoteUrl)!;
      const base = preview.value.defaultBranch ?? 'main';
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
        if (r.ok && r.value.ok) created = { pr: r.value.pr, via: 'gh' };
        else notes.push(`Worker 上的 gh 不可用：${r.ok ? (r.value as { reason: string }).reason : r.error.message}`);
      }
      if (created) {
        const now = deps.now();
        pullRequest = {
          id: newId(),
          taskId: session.taskId,
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
        await audit(subject, project, 'git.pr', session.id, `${repo}#${created.pr.number} via ${created.via}`);
        const entry = draftLogEntry({ id: newId(), taskId: asTaskId(session.taskId), author: { kind: 'system' }, body: `开了 PR [${repo}#${created.pr.number}](${created.pr.url})：${title}`, links: [{ kind: 'pr', ref: created.pr.url, label: `#${created.pr.number}` }], sessionId: session.id, now });
        if (entry.ok) await deps.workLog.append(entry.value).catch(() => undefined);
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
        if (r?.ok && r.value.ok) remote = r.value.pr;
      }
    }
    const next: PullRequestLink = remote
      ? { ...link, state: remote.state, headSha: remote.headSha ?? link.headSha, mergedAt: remote.mergedAt, url: remote.url || link.url, lastSyncedAt: deps.now() }
      : { ...link, lastSyncedAt: deps.now() };
    await deps.pullRequests.save(next);
    return next;
  }

  /** 巡检：10 分钟没同步过的开着的 PR。 */
  async function syncDue(limit = 50): Promise<number> {
    const due = await deps.pullRequests.openSyncedBefore(deps.now() - GIT_LIMITS.syncEveryMs, limit);
    for (const link of due) await syncOne(link).catch(() => undefined);
    return due.length;
  }

  /** 打开任务时：看得见就同步一遍这个任务开着的 PR（最多 1 分钟一次）。 */
  async function syncTask(subject: Subject | null, taskId: string): Promise<Result<readonly PullRequestLink[], DomainError>> {
    const listed = await listForTask(subject, taskId);
    if (!listed.ok) return listed;
    const out: PullRequestLink[] = [];
    for (const link of listed.value) out.push(link.state === 'open' && deps.now() - link.lastSyncedAt > 60_000 ? await syncOne(link).catch(() => link) : link);
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
