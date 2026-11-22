import type { ProjectId, SessionId, TaskId } from '../ids.ts';

/** 一次搜索最多接受的字符数（按 UTF-16 计，够一条标题 / 一段 id）。 */
export const METADATA_SEARCH_QUERY_MAX = 160;
/** 每组默认返回条数。 */
export const METADATA_SEARCH_GROUP_LIMIT = 10;
/** 每组硬上限：再大就不是「快速跳转」，而是在翻列表。 */
export const METADATA_SEARCH_GROUP_MAX = 20;

/** 项目元数据命中：项目名从 ProjectRepository 取，避免存储层再带一份可能过期的名字。 */
export interface ProjectMetadataHit {
  readonly projectId: ProjectId;
}

/** 任务元数据命中：标题命中，不带目标正文。 */
export interface TaskMetadataHit {
  readonly taskId: TaskId;
  readonly projectId: ProjectId;
  readonly title: string;
}

/**
 * 会话元数据命中：标题（新会话可命名）或 id（老会话只能按 id 认）命中。
 *
 * `projectId` 是任务所属项目；无任务的容器会话这里是 null，归属必须看 `originProjectId`
 * （#243：出生项目不可变）。两者都没有的会话不允许出现在结果里。
 */
export interface SessionMetadataHit {
  readonly sessionId: SessionId;
  readonly taskId: TaskId | null;
  readonly projectId: ProjectId | null;
  readonly originProjectId: ProjectId | null;
  readonly title: string | null;
  readonly taskTitle: string | null;
  readonly updatedAt: number;
}

export interface MetadataSearchGroups {
  readonly projects: readonly ProjectMetadataHit[];
  readonly tasks: readonly TaskMetadataHit[];
  readonly sessions: readonly SessionMetadataHit[];
}

export interface MetadataSearchQuery {
  /** 已 trim 过的搜索词；空串由实现直接返回空组。 */
  readonly query: string;
  /** 每组取多少条；实现负责夹到 1..METADATA_SEARCH_GROUP_MAX。 */
  readonly limitPerGroup: number;
  /**
   * 每组可命中的项目范围，已按该组权限（project.read / task.read / session.read）算好。
   * 存储层必须在 LIMIT 之前按范围过滤：不可见项目的命中不能挤掉可见结果，
   * 尤其是按精确 id 命中的老会话。
   */
  readonly scope: MetadataSearchScope;
}

/** 三个组各自的可见项目 id；同一项目在不同组里权限可能不同。 */
export interface MetadataSearchScope {
  readonly projects: readonly ProjectId[];
  readonly tasks: readonly ProjectId[];
  readonly sessions: readonly ProjectId[];
}

/**
 * 跨项目的元数据搜索端口。只碰名字 / 标题 / 会话 id：
 * 不读 session_text、目标、项目描述，避免把正文扫描带进快速跳转。
 */
export interface MetadataSearchGateway {
  search(query: MetadataSearchQuery): Promise<MetadataSearchGroups>;
}
