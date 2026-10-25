import { invalid, notFound, type DomainError } from '../errors.ts';
import { asProjectId } from '../ids.ts';
import { ok, type Result } from '../result.ts';
import type { SearchHit } from '../ports/search-gateway.ts';
import type { Deps } from './deps.ts';

const DEFAULT_LIMIT = 20;

/**
 * 在项目里找东西：任务标题/目标，以及会话里说过的话。
 *
 * 为什么搜会话正文：一天的会话有二三十条，记得住的往往是一句话，不是标题。
 * 这是「画布为主、列表为辅」里列表存在的第一个理由。
 */
export async function searchUseCase(
  deps: Pick<Deps, 'projects' | 'search'>,
  input: { readonly projectId: string; readonly query: string }
): Promise<Result<readonly SearchHit[], DomainError>> {
  const query = input.query.trim();
  if (query === '') return { ok: false, error: invalid('搜索词不能为空') };

  const project = await deps.projects.byId(asProjectId(input.projectId));
  if (project === null) return { ok: false, error: notFound('项目不存在') };

  const hits = await deps.search.search({ projectId: project.id, query, limit: DEFAULT_LIMIT });
  return ok(hits);
}
