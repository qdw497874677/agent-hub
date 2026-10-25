import type { ProjectId, SessionId } from '../ids.ts';
import type { DomainError } from '../errors.ts';
import { invalid, notFound } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import { isSafeRelativePath } from '../attachment.ts';
import type { Deps } from './deps.ts';
import { projectOf } from './hosting.ts';

/** 遍历上限：再大的仓库也只扫这么多，选择器要的是「快」，不是「全」。 */
const SCAN_LIMIT = 5000;
const RESULT_LIMIT = 50;

/** 名字命中排在路径命中前面，越短越靠前——和编辑器里的 Ctrl+P 一个手感。 */
function rank(path: string, query: string): number {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  if (name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  if (lower.includes(query)) return 2;
  let at = 0;
  for (const char of query) {
    at = lower.indexOf(char, at);
    if (at === -1) return -1;
    at += 1;
  }
  return 3;
}

/** `@` 引用选择器：项目里按名字模糊匹配的文件，相对项目根。 */
export async function listProjectFiles(
  deps: Pick<Deps, 'fs' | 'projects'>,
  projectId: ProjectId,
  query: string
): Promise<Result<{ files: string[]; truncated: boolean }, DomainError>> {
  const project = await deps.projects.byId(projectId);
  if (!project) return err(notFound('项目不存在'));
  const scanned = await deps.fs.listFiles(project.rootPath.replace(/\/+$/, ''), SCAN_LIMIT);
  const needle = query.trim().toLowerCase();
  const matched = scanned.files
    .map((path) => ({ path, score: needle === '' ? path.split('/').length : rank(path, needle) }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => left.score - right.score || left.path.length - right.path.length || left.path.localeCompare(right.path));
  return ok({
    files: matched.slice(0, RESULT_LIMIT).map((entry) => entry.path),
    truncated: scanned.truncated || matched.length > RESULT_LIMIT
  });
}

/**
 * 专注对话回取上传过的附件（缩略图、点开看原图）。
 * 只放行这条会话自己的附件目录，别的路径一律拒——这不是通用文件服务器。
 */
export async function readSessionAttachment(
  deps: Pick<Deps, 'fs' | 'projects' | 'sessions' | 'tasks'>,
  sessionId: SessionId,
  path: string
): Promise<Result<Uint8Array, DomainError>> {
  if (!isSafeRelativePath(path) || !path.startsWith(`.agent-hub/attachments/${sessionId}/`)) {
    return err(invalid('只能读取这条会话的附件'));
  }
  const session = await deps.sessions.byId(sessionId);
  if (!session) return err(notFound('会话不存在'));
  const project = await projectOf(deps, session);
  if (!project) return err(notFound('会话所属项目不存在'));
  const bytes = await deps.fs.readFile(`${project.rootPath.replace(/\/+$/, '')}/${path}`);
  return bytes === null ? err(notFound('附件不存在')) : ok(bytes);
}
