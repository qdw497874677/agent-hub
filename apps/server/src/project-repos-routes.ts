import type { Hono } from 'hono';
import {
  asProjectId,
  authorizeProject,
  checkReposUseCase,
  normalizeRepos,
  type AuditAction,
  type Deps,
  type Subject,
  type WorkerStatus
} from '@agent-hub/domain';
import { checkProjectReposRequest, type ProjectReposCheckDto } from '@agent-hub/contract';
import type { SubjectOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * 保存项目仓库清单前先检查（docs/design/multi-repo.md §11.2 的补充）：
 *
 *   POST /api/projects/:projectId/repos/check
 *   body { repos: ProjectRepoInput[]; workerId?: string | null }
 *
 * 权限与保存一致（project.update）。检查失败（连不上 / 分支不存在）不影响保存——
 * 这里只回报，前端提示用户改；只有「明确指定了一台不在线的机器」才是 409。
 * 一台在线机器都没有时 200 + unavailable：保存不能被离线挡住。
 */
export interface ProjectReposRouteDeps {
  readonly deps: Deps;
  /** 和 http.ts 里其它路由共用同一个审计入口（带 actor/ip/团队）。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly audit?: (c: any, subject: Subject | null, action: AuditAction, target: string, detail: string) => Promise<void>;
}

/** 老 Worker 不报 capabilities = 不限（本机 / 共享令牌），按有 git 能力处理。 */
const hasGit = (worker: WorkerStatus): boolean => worker.capabilities === undefined || worker.capabilities.includes('git');

export function installProjectReposRoutes(app: Hono<any>, options: ProjectReposRouteDeps, subjectOf: SubjectOf): void {
  const { deps, audit } = options;

  app.post('/api/projects/:projectId/repos/check', async (c) => {
    const parsed = checkProjectReposRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(c, { code: 'invalid', message: issue ? `${issue.path.join('.')}: ${issue.message}` : '仓库清单不对' });
    }

    const projectId = c.req.param('projectId');
    const subject = subjectOf(c);
    const project = await deps.projects.byId(asProjectId(projectId));
    const allowed = await authorizeProject(deps.access, subject, project, 'project.update');
    if (!allowed.ok) return fail(c, allowed.error);

    // 形状 / 上限 / 重名与保存走同一套规则：检查的必须就是保存时会被记下的那份。
    const normalized = normalizeRepos(parsed.data.repos);
    if (!normalized.ok) return fail(c, normalized.error);

    const workers = await deps.gateway.status();
    const online = workers.filter((worker) => worker.state === 'online' && hasGit(worker));
    let chosen: WorkerStatus | null = null;
    if (parsed.data.workerId === undefined) {
      // 优先本机（route = null）：凭据、网络都在 hub 这台机器上；没有就任挑一台在线的。
      chosen = online.find((worker) => worker.origin === 'local') ?? online[0] ?? null;
    } else if (parsed.data.workerId === null) {
      // 显式 null = 就要本机；本机不在线说清楚，别静默换机器。
      chosen = online.find((worker) => worker.origin === 'local') ?? null;
      if (!chosen) return fail(c, { code: 'conflict', message: '那台机器现在不在线' });
    } else {
      const found = workers.find((worker) => worker.workerId === parsed.data.workerId);
      if (!found || found.state !== 'online') return fail(c, { code: 'conflict', message: '那台机器现在不在线' });
      if (!hasGit(found)) return fail(c, { code: 'conflict', message: '那台机器没有 git 能力，检查不了仓库' });
      chosen = found;
    }

    if (!chosen) {
      const unavailable: ProjectReposCheckDto = { workerId: null, workerLabel: null, unavailable: '现在没有在线的机器可以检查仓库', results: [] };
      return c.json(unavailable);
    }

    const route = chosen.origin === 'local' ? null : chosen.workerId;
    const git = route === null ? deps.git : deps.gateway.git(route);
    const results = await checkReposUseCase(
      {
        checkRepo: async (target) => {
          const probe = await git.checkRepo(target.url, target.branch);
          // 网关掉线 / 超时也翻成一条普通的「检查不通过」，别让整批 500。
          return probe.ok ? probe.value : { reachable: false, defaultBranch: null, branchExists: false, message: probe.error.message };
        }
      },
      normalized.value.map((repo) => ({ name: repo.name, url: repo.url, branch: repo.defaultBranch }))
    );

    const bad = results.filter((result) => !result.ok).length;
    await audit?.(c, subject, 'project.repos_check', projectId, `检查 ${results.length} 个仓库，${bad} 个有问题`);
    return c.json({ workerId: route, workerLabel: chosen.label, unavailable: null, results } satisfies ProjectReposCheckDto);
  });
}
