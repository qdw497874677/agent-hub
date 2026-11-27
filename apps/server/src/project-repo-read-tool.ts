import {
  asSessionId, conflict, err, forbidden, invalid, notFound, ok, projectToolScope, unavailable, usableByProject,
  type Deps, type DomainError, type GrantActor, type Project, type ProjectRepo,
  type Result, type Session, type ToolGrant, type ToolProvider
} from '@agent-hub/domain';
import type { HubCredentialBroker } from './hub-credential-broker.ts';
import type { ProjectGitFetchFailureCode } from './project-git-fetch.ts';
import type { ProjectSessionGrantService } from './project-session-grant.ts';
import { asObject, checkRelativePath, exactString } from './project-session-input.ts';

export const PROJECT_REPO_READ_TOOL = 'project.repo.read';
const SCOPE = 'repo:read';
const ARGUMENTS = ['repo_id', 'branch', 'path', 'expected_tip'] as const;

type RepoContext = Pick<Deps, 'workspaces' | 'workspaceGroups'>;

function choices(project: Project): DomainError {
  if (!project.repos.length) return notFound('当前项目没有已登记的仓库');
  const names = project.repos.map(({ name, id }) => `${name} (${id})`).join('、');
  return invalid(`无法唯一确认仓库，请根据任务选择 repo_id：${names}`);
}

/** Only trusted registration/provenance may select implicitly; no checkout origin or first-repo fallback. */
async function resolveRepository(deps: RepoContext, project: Project, session: Session, requested: string | null): Promise<Result<ProjectRepo, DomainError>> {
  if (new Set(project.repos.map(({ id }) => id)).size !== project.repos.length) return err(conflict('仓库登记有冲突，请联系项目管理员修正'));
  if (requested !== null) {
    const repo = project.repos.find(({ id }) => id === requested);
    return repo ? ok(repo) : err(notFound('当前项目没有此仓库'));
  }
  if (!project.repos.length) return err(choices(project));
  if (session.groupId) {
    const group = await deps.workspaceGroups?.byId(session.groupId);
    const member = group?.members.length === 1 ? group.members[0] : null;
    const workspace = member && group?.projectId === project.id && member.state === 'ready'
      ? await deps.workspaces.byId(member.workspaceId) : null;
    const repo = project.repos.find(({ id, url }) => id === member?.repoId && url === workspace?.repoUrl);
    return repo && workspace?.groupId === group?.id && workspace?.projectId === project.id ? ok(repo) : err(choices(project));
  }
  if (session.workspaceId) {
    const workspace = await deps.workspaces.byId(session.workspaceId);
    if (!workspace || workspace.state !== 'ready' || workspace.groupId || !await usableByProject(deps, workspace, project.id)) return err(choices(project));
    let repoUrl = workspace.repoUrl;
    if (!repoUrl && workspace.source === 'worktree' && workspace.baseWorkspaceId) {
      const base = await deps.workspaces.byId(workspace.baseWorkspaceId);
      if (!base || base.kind !== 'long_lived' || base.state !== 'ready' || base.workerId !== workspace.workerId
        || !await usableByProject(deps, base, project.id)) return err(choices(project));
      repoUrl = base.repoUrl;
      if (!repoUrl) return err(choices(project));
    }
    if (repoUrl) {
      const matching = project.repos.filter(({ url }) => url === repoUrl);
      return matching.length === 1 && matching[0] ? ok(matching[0]) : err(choices(project));
    }
  }
  return project.repos.length === 1 && project.repos[0] ? ok(project.repos[0]) : err(choices(project));
}

function snapshotError(code: ProjectGitFetchFailureCode): DomainError {
  switch (code) {
    case 'bad_path': return invalid('文件路径不合法，请使用仓库内的相对路径');
    case 'bad_branch': return invalid('分支名不合法');
    case 'bad_tip': return invalid('expected_tip 必须是完整的提交 SHA');
    case 'tip_mismatch': return conflict('分支提交已变化；请重新读取，不能把新提交当作旧快照');
    case 'not_found': return notFound('远端快照中没有此路径');
    case 'binary': return invalid('仓库快照只能读取 UTF-8 文本，不能读取二进制文件');
    case 'unsupported': return invalid('不能读取仓库中的符号链接或子模块');
    case 'too_large': return unavailable('远端快照超出读取上限');
    case 'busy': return unavailable('仓库读取繁忙，请稍后重试');
    default: return unavailable('远端仓库暂不可读；请核对项目设置中的 Hub 托管访问，不会尝试机器凭据');
  }
}

export function createProjectRepoReadTool(input: {
  deps: Pick<Deps, 'projects' | 'sessions' | 'workspaces' | 'workspaceGroups'>;
  grants: Pick<ProjectSessionGrantService, 'authorize'>;
  broker: Pick<HubCredentialBroker, 'readRepo'>;
  toolGrantStillActive(grant: ToolGrant): Promise<boolean>;
  now(): number;
  allowsProject(projectId: string): boolean;
}): ToolProvider {
  return {
    id: 'project-repo-read',
    tools: () => [{
      name: PROJECT_REPO_READ_TOOL, version: 1, scope: projectToolScope(SCOPE), perMinute: 8, omitAuditPayload: true,
      description: '读取当前会话项目已登记仓库的远端分支快照（目录或 UTF-8 文本）。不下载本地文件、不更新工作目录，不接收 URL、凭据或机器参数。仓库不明确时根据项目候选确认 repo_id；相同快照的后续读取可传 expected_tip。',
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        repo_id: { type: 'string', maxLength: 200, description: '当前项目的仓库 ID（有歧义时必填）' },
        branch: { type: 'string', maxLength: 255, description: '分支；省略取仓库默认分支' },
        path: { type: 'string', maxLength: 512, description: '仓库内相对路径，省略读取根目录' },
        expected_tip: { type: 'string', pattern: '^([a-f0-9]{40}|[a-f0-9]{64})$', description: '固定上一次读到的完整提交 SHA' }
      } }
    }],
    async call(name, raw, { grant }) {
      if (name !== PROJECT_REPO_READ_TOOL) return err(notFound('工具不存在'));
      const actor: GrantActor | undefined = grant.actor;
      if (actor?.via !== 'web' || !actor.userId || !grant.scopes.includes(projectToolScope(SCOPE))) return err(forbidden('没有仓库读取授权'));
      const accountId = actor.userId;
      const data = asObject(raw);
      if (!data.ok) return data;
      if (Object.keys(data.value).some((key) => !ARGUMENTS.some((argument) => argument === key))) return err(invalid('只支持 repo_id、branch、path、expected_tip'));
      const repoId = exactString(data.value, 'repo_id', 200); if (!repoId.ok) return repoId;
      const branch = exactString(data.value, 'branch', 255); if (!branch.ok) return branch;
      const path = exactString(data.value, 'path', 512); if (!path.ok) return path;
      const tip = exactString(data.value, 'expected_tip', 64); if (!tip.ok) return tip;
      if (path.value && checkRelativePath(path.value)) return err(invalid('文件路径不合法，请使用仓库内的相对路径'));
      if (tip.value && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tip.value)) return err(snapshotError('bad_tip'));

      const sessionId = asSessionId(grant.sessionId);
      const authorize = async () => await input.toolGrantStillActive(grant)
        ? input.grants.authorize({ actor, sessionId, scope: SCOPE })
        : err(forbidden('没有仓库读取授权'));
      const access = await authorize();
      if (!access.ok) return access;
      const { projectId } = access.value;
      if (!input.allowsProject(projectId)) return err(forbidden('此项目未启用 Hub 仓库读取'));
      const resolve = async () => {
        const [project, session] = await Promise.all([input.deps.projects.byId(projectId), input.deps.sessions.byId(sessionId)]);
        if (!project || project.deletedAt != null || !session) return err(notFound('项目或会话不可用'));
        return resolveRepository(input.deps, project, session, repoId.value);
      };
      const selection = await resolve();
      if (!selection.ok) return selection;
      const repo = selection.value;
      const reauthorize = async () => {
        const current = await authorize();
        if (!current.ok || current.value.projectId !== projectId || current.value.id !== access.value.id
          || current.value.createdAt !== access.value.createdAt || current.value.accountId !== accountId) return false;
        const selectedAgain = await resolve();
        return selectedAgain.ok && selectedAgain.value.id === repo.id && selectedAgain.value.url === repo.url
          && selectedAgain.value.defaultBranch === repo.defaultBranch;
      };
      const result = await input.broker.readRepo({
        projectId, repoId: repo.id, branch: branch.value, path: path.value, expectedTip: tip.value,
        reauthorize, auditContext: { actorId: accountId, sessionId }
      });
      if (!result.ok) return err(snapshotError(result.code));
      const { path: fetchedPath, branch: fetchedBranch, tip: fetchedTip, kind, entries, content } = result.result;
      return ok({ repo: { id: repo.id, name: repo.name }, source: 'remote_snapshot', branch: fetchedBranch, tip: fetchedTip,
        readAt: input.now(), path: fetchedPath, localFilesUpdated: false,
        ...(kind === 'directory' ? { kind, entries } : { kind, content }) });
    }
  };
}
