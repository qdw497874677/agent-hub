import type { DatabaseSync } from 'node:sqlite';
import type {
  MetadataSearchGateway,
  MetadataSearchGroups,
  ProjectMetadataHit,
  SessionMetadataHit,
  TaskMetadataHit
} from '@agent-hub/domain';
import {
  METADATA_SEARCH_GROUP_LIMIT,
  METADATA_SEARCH_GROUP_MAX,
  METADATA_SEARCH_QUERY_MAX,
  asProjectId,
  asSessionId,
  asTaskId
} from '@agent-hub/domain';

/**
 * 快速跳转的元数据搜索（项目名 / 任务标题 / 会话标题或 id）。
 *
 * 刻意不碰 `session_text`、`tasks.goal`、`projects.description`：
 * 那是 `/api/search` 的正文搜索，代价和语义都不一样。这里只回答「跳到哪」。
 *
 * 可见项目范围由调用方按组算好传进来，SQL 在 LIMIT 之前用 `json_each` 过滤。
 * 这样不可见项目的命中不会先占满 LIMIT，把后面的可见结果挤掉。
 *
 * 所有用户输入都走绑定参数；`%` / `_` / `\` 先转义，避免搜索词变成通配符。
 */
export function createMetadataSearch(db: DatabaseSync): MetadataSearchGateway {
  const projects = db.prepare(
    'SELECT id FROM projects ' +
      "WHERE deleted_at IS NULL AND name LIKE ? ESCAPE '\\' " +
      'AND id IN (SELECT value FROM json_each(?)) ' +
      'ORDER BY name COLLATE NOCASE ASC, created_at DESC, id ASC LIMIT ?'
  );
  const tasks = db.prepare(
    'SELECT t.id, t.project_id, t.title FROM tasks t ' +
      'JOIN projects p ON p.id = t.project_id ' +
      "WHERE p.deleted_at IS NULL AND t.title LIKE ? ESCAPE '\\' " +
      'AND t.project_id IN (SELECT value FROM json_each(?)) ' +
      'ORDER BY t.updated_at DESC, t.id ASC LIMIT ?'
  );
  // 任务会话按任务项目归属；容器会话按不可变的出生项目归属（#243）。
  // 任务存在但任务行缺失时 CASE 得到 NULL，不会回退到出生项目——和
  // `projectOfSessionOrigin` 的失败关闭语义一致。
  const sessions = db.prepare(
    'SELECT s.id AS session_id, s.task_id, t.project_id AS project_id, ' +
      's.origin_project_id, s.title, t.title AS task_title, s.updated_at ' +
      'FROM sessions s ' +
      'LEFT JOIN tasks t ON t.id = s.task_id ' +
      'JOIN projects p ON p.id = CASE WHEN s.task_id IS NOT NULL THEN t.project_id ELSE s.origin_project_id END ' +
      "WHERE p.deleted_at IS NULL AND IFNULL(s.kind, 'chat') <> 'side' " +
      'AND (s.task_id IS NOT NULL OR s.origin_project_id IS NOT NULL) ' +
      'AND p.id IN (SELECT value FROM json_each(?)) ' +
      "AND ((s.title IS NOT NULL AND TRIM(s.title) <> '' AND s.title LIKE ? ESCAPE '\\') OR s.id = ?) " +
      'ORDER BY s.updated_at DESC, s.id ASC LIMIT ?'
  );

  return {
    async search(query): Promise<MetadataSearchGroups> {
      const needle = query.query.trim();
      // 空词 / 超长词都不该退化成 `LIKE '%%'` 或一次全表扫描。
      if (needle === '' || needle.length > METADATA_SEARCH_QUERY_MAX) {
        return { projects: [], tasks: [], sessions: [] };
      }
      const pattern = `%${escapeLike(needle)}%`;
      const limit = normalizeLimit(query.limitPerGroup);
      const projectScope = JSON.stringify(query.scope.projects);
      const taskScope = JSON.stringify(query.scope.tasks);
      const sessionScope = JSON.stringify(query.scope.sessions);

      const projectRows =
        query.scope.projects.length === 0 ? [] : (projects.all(pattern, projectScope, limit) as { id: string }[]);
      const taskRows =
        query.scope.tasks.length === 0
          ? []
          : (tasks.all(pattern, taskScope, limit) as { id: string; project_id: string; title: string }[]);
      const sessionRows =
        query.scope.sessions.length === 0
          ? []
          : (sessions.all(sessionScope, pattern, needle, limit) as {
              session_id: string;
              task_id: string | null;
              project_id: string | null;
              origin_project_id: string | null;
              title: string | null;
              task_title: string | null;
              updated_at: number;
            }[]);

      return {
        projects: projectRows.map((row): ProjectMetadataHit => ({ projectId: asProjectId(row.id) })),
        tasks: taskRows.map(
          (row): TaskMetadataHit => ({
            taskId: asTaskId(row.id),
            projectId: asProjectId(row.project_id),
            title: row.title
          })
        ),
        sessions: sessionRows.map(
          (row): SessionMetadataHit => ({
            sessionId: asSessionId(row.session_id),
            taskId: row.task_id === null ? null : asTaskId(row.task_id),
            projectId: row.project_id === null ? null : asProjectId(row.project_id),
            originProjectId: row.origin_project_id === null ? null : asProjectId(row.origin_project_id),
            title: row.title,
            taskTitle: row.task_title,
            updatedAt: row.updated_at
          })
        )
      };
    }
  };
}

/** LIKE 里的 `%`、`_`、`\` 必须转义，不然用户搜 "100%" 会匹配到一切。 */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return METADATA_SEARCH_GROUP_LIMIT;
  return Math.max(1, Math.min(METADATA_SEARCH_GROUP_MAX, Math.trunc(limit)));
}
