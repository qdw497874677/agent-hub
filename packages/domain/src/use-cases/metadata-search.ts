import type { ProjectRepository } from '../ports/project-repository.ts';
import type { MetadataSearchGateway, SessionMetadataHit } from '../ports/metadata-search.ts';
import {
  METADATA_SEARCH_GROUP_LIMIT,
  METADATA_SEARCH_GROUP_MAX,
  METADATA_SEARCH_QUERY_MAX
} from '../ports/metadata-search.ts';
import type { AccessPolicy } from './authorization.ts';
import { projectAsResource } from './authorization.ts';
import { can, type Subject } from '../access.ts';
import type { ProjectId, SessionId, TaskId } from '../ids.ts';
import { invalid, type DomainError } from '../errors.ts';
import { ok, type Result } from '../result.ts';

export interface MetadataSearchProject {
  readonly projectId: ProjectId;
  readonly name: string;
}

export interface MetadataSearchTask {
  readonly taskId: TaskId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly projectName: string;
}

export interface MetadataSearchSession {
  readonly sessionId: SessionId;
  readonly taskId: TaskId | null;
  readonly projectId: ProjectId;
  readonly projectName: string;
  /** 命名过的会话标题；老会话没命名时为 null，界面用 id 兜底。 */
  readonly title: string | null;
  /** 任务会话显示任务标题；容器会话为 null。 */
  readonly taskTitle: string | null;
  readonly updatedAt: number;
}

export interface MetadataSearchView {
  readonly projects: readonly MetadataSearchProject[];
  readonly tasks: readonly MetadataSearchTask[];
  readonly sessions: readonly MetadataSearchSession[];
}

export interface MetadataSearchDeps {
  readonly projects: Pick<ProjectRepository, 'list'>;
  readonly metadataSearch: MetadataSearchGateway;
  /** 有 policy 时按现有项目可见性过滤；没有 policy（单机 / 测试）只排除回收站。 */
  readonly access?: AccessPolicy;
}

/**
 * 快速跳转用的元数据搜索：项目名、任务标题、会话标题 / id，分三组返回。
 *
 * 和 `/api/search` 的区别：这里不搜会话正文，也不搜任务目标——只回答「跳到哪」，
 * 不回答「哪句话提到过」。所以结果里没有 snippet，也不需要读 session_text。
 *
 * 授权在存储层 LIMIT 之前完成：先用 `ProjectRepository.list()` 和现有 policy 算出
 * 每组可见的项目 id，交给存储层过滤后再取前 N 条。否则不可见项目的命中会先占满
 * LIMIT，把后面的可见结果（尤其是按精确 id 命中的老会话）挤掉。
 *
 * 容器会话只认 `originProjectId`（#243 不可变出生项目）；它为空时失败关闭，
 * 绝不回退到工作空间或任意项目。
 */
export async function metadataSearchUseCase(
  deps: MetadataSearchDeps,
  actor: Subject | null,
  input: { readonly query: string; readonly limitPerGroup?: number }
): Promise<Result<MetadataSearchView, DomainError>> {
  const query = input.query.trim();
  if (query === '') return { ok: false, error: invalid('搜索词不能为空') };
  if (query.length > METADATA_SEARCH_QUERY_MAX) {
    return { ok: false, error: invalid(`搜索词最多 ${METADATA_SEARCH_QUERY_MAX} 个字符`) };
  }

  const limit = normalizeLimit(input.limitPerGroup);
  // 一次 policy context 覆盖三个组；每组分别判定，自定义角色下三者可能不同。
  const ctx = deps.access ? await deps.access.context() : null;
  const projects = await deps.projects.list();
  const names = new Map<ProjectId, string>();
  const scope = { projects: [] as ProjectId[], tasks: [] as ProjectId[], sessions: [] as ProjectId[] };

  for (const project of projects) {
    if (project.deletedAt !== null) continue;
    names.set(project.id, project.name);
    if (ctx === null) {
      // 单机语义：没有 policy 时只排除回收站，和 projectReader 一致。
      scope.projects.push(project.id);
      scope.tasks.push(project.id);
      scope.sessions.push(project.id);
      continue;
    }
    const resource = projectAsResource(project, ctx);
    // 先过项目可见性（和 authorizeProject 一样），再看该组自己的读权限；
    // 否则自定义角色只拿到 task.read / session.read 时，会越过项目边界看到标题。
    if (!can(actor, 'project.read', resource, ctx)) continue;
    scope.projects.push(project.id);
    if (can(actor, 'task.read', resource, ctx)) scope.tasks.push(project.id);
    if (can(actor, 'session.read', resource, ctx)) scope.sessions.push(project.id);
  }

  const groups = await deps.metadataSearch.search({ query, limitPerGroup: limit, scope });
  const projectScope = new Set(scope.projects);
  const taskScope = new Set(scope.tasks);
  const sessionScope = new Set(scope.sessions);

  const projectHits: MetadataSearchProject[] = [];
  for (const hit of groups.projects) {
    if (projectHits.length >= limit) break;
    if (!projectScope.has(hit.projectId)) continue;
    const name = names.get(hit.projectId);
    if (name === undefined) continue;
    projectHits.push({ projectId: hit.projectId, name });
  }

  const taskHits: MetadataSearchTask[] = [];
  for (const hit of groups.tasks) {
    if (taskHits.length >= limit) break;
    if (!taskScope.has(hit.projectId)) continue;
    const name = names.get(hit.projectId);
    if (name === undefined) continue;
    taskHits.push({ taskId: hit.taskId, projectId: hit.projectId, title: hit.title, projectName: name });
  }

  const sessionHits: MetadataSearchSession[] = [];
  for (const hit of groups.sessions) {
    if (sessionHits.length >= limit) break;
    // 任务会话按任务项目归属；容器会话只认不可变出生项目。
    const origin = sessionOriginProject(hit);
    if (origin === null || !sessionScope.has(origin)) continue;
    const name = names.get(origin);
    if (name === undefined) continue;
    sessionHits.push({
      sessionId: hit.sessionId,
      taskId: hit.taskId,
      projectId: origin,
      projectName: name,
      title: hit.title,
      taskTitle: hit.taskTitle,
      updatedAt: hit.updatedAt
    });
  }

  return ok({ projects: projectHits, tasks: taskHits, sessions: sessionHits });
}

/**
 * 任务会话用任务所属项目；容器会话只认出生项目。
 * 容器会话的 `projectId`（工作空间 / 组带出来的）可能是私有的，不能当授权依据。
 * 任务存在但任务行缺失时 `projectId` 为 null，同样失败关闭，不回退到出生项目。
 */
function sessionOriginProject(hit: SessionMetadataHit): ProjectId | null {
  return hit.taskId === null ? hit.originProjectId : hit.projectId;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return METADATA_SEARCH_GROUP_LIMIT;
  return Math.max(1, Math.min(METADATA_SEARCH_GROUP_MAX, Math.trunc(limit)));
}
