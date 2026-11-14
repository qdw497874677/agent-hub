import type { Subject } from '../access.ts';
import type { DomainError } from '../errors.ts';
import { unavailable } from '../errors.ts';
import { asProjectId } from '../ids.ts';
import type { CleanupPolicy, SweepItem } from '../ports/workspace-sweeps.ts';
import { err, ok, type Result } from '../result.ts';
import { authorizeProject } from './authorization.ts';
import type { Deps } from './deps.ts';
import { listOn, routeOf } from './machine-dirs.ts';
import { cleanupPolicyFor, normalizePolicy, sweepTemporaryWorkspacesUseCase, type SweepReport } from './workspace-cleanup.ts';

/** 项目设置 · 清理（ADR 0027 阶段 3）：规则、立即清理、清理记录、孤儿目录。 */

export interface OrphanDir {
  readonly path: string;
  readonly workerId: string | null;
}
export interface CleanupRecords {
  readonly items: readonly SweepItem[];
  /** `.worktrees/<repo>/` 下没有任何登记对应的目录：只列出来，不自动删（人自己判断）。 */
  readonly orphans: readonly OrphanDir[];
}

type AdminDeps = Pick<Deps, 'projects' | 'access'> & Partial<Pick<Deps, 'cleanup'>>;

export async function cleanupPolicyUseCase(deps: AdminDeps, actor: Subject | null, projectId: string): Promise<Result<CleanupPolicy, DomainError>> {
  const project = await authorizeProject(deps.access, actor, await deps.projects.byId(asProjectId(projectId)), 'project.read');
  if (!project.ok) return project;
  return ok(await cleanupPolicyFor(deps, project.value.id));
}

export async function saveCleanupPolicyUseCase(
  deps: AdminDeps & Pick<Deps, 'now'>,
  actor: Subject | null,
  projectId: string,
  input: Partial<CleanupPolicy>
): Promise<Result<CleanupPolicy, DomainError>> {
  const project = await authorizeProject(deps.access, actor, await deps.projects.byId(asProjectId(projectId)), 'project.update');
  if (!project.ok) return project;
  if (!deps.cleanup) return err(unavailable('清理规则存储未就绪'));
  const policy = normalizePolicy(input, await cleanupPolicyFor(deps, project.value.id));
  if (!policy.ok) return policy;
  await deps.cleanup.sweeps.savePolicy('project', project.value.id, policy.value, deps.now());
  return policy;
}

export async function sweepProjectUseCase(deps: Deps, actor: Subject | null, projectId: string): Promise<Result<SweepReport, DomainError>> {
  const project = await authorizeProject(deps.access, actor, await deps.projects.byId(asProjectId(projectId)), 'project.update');
  if (!project.ok) return project;
  return ok(await sweepTemporaryWorkspacesUseCase(deps, { projectId: project.value.id, trigger: 'manual' }));
}

export async function cleanupRecordsUseCase(
  deps: AdminDeps & Pick<Deps, 'workspaces' | 'fs' | 'gateway'>,
  actor: Subject | null,
  projectId: string
): Promise<Result<CleanupRecords, DomainError>> {
  const project = await authorizeProject(deps.access, actor, await deps.projects.byId(asProjectId(projectId)), 'project.read');
  if (!project.ok) return project;
  const items = deps.cleanup ? await deps.cleanup.sweeps.itemsOfProject(project.value.id, 200) : [];
  const orphans: OrphanDir[] = [];
  const parents = new Map<string, string | null>();
  for (const w of await deps.workspaces.byProject(project.value.id)) {
    if (w.source !== 'worktree' || w.kind !== 'temporary') continue;
    // 父目录就是这台机器上「放 worktree 的容器」——不管是默认的仓库旁 `.worktrees/<repo>/`
    // 还是 `WORKER_WORKTREES_DIR=<dir>/<repo>/`，都由登记的 worktree 路径反推，不再按路径片段猜。
    const parent = w.path.slice(0, w.path.lastIndexOf('/'));
    if (parent !== '') parents.set(`${w.workerId ?? ''}\u0000${parent}`, w.workerId);
  }
  for (const [key, workerId] of parents) {
    const parent = key.split('\u0000')[1] ?? '';
    const listed = await listOn(deps, await routeOf(deps, workerId), parent).catch(() => null);
    if (!listed?.ok || !listed.value) continue;
    const known = new Set((await deps.workspaces.onMachine(workerId)).map((w) => w.path));
    for (const entry of listed.value.entries) if (!known.has(entry.path)) orphans.push({ path: entry.path, workerId });
  }
  return ok({ items, orphans });
}
