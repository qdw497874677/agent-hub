import { principalOfSubject, type Subject } from '../access.ts';
import type { AuditLog } from '../ports/audit-log.ts';
import type { NodeGateway } from '../ports/node-gateway.ts';
import type { ProjectRepository } from '../ports/project-repository.ts';
import type { SessionRepository } from '../ports/session-repository.ts';
import type { TaskRepository } from '../ports/task-repository.ts';
import type { WorkspaceRepository } from '../ports/workspace-repository.ts';
import type { ChangedFile, DirectoryPage, FileChangeNotice, FileContent, FileDiff, SessionBaseStore, WorkspaceBrowser } from '../ports/workspace-browser.ts';
import type { Project } from '../project.ts';
import type { Session } from '../session.ts';
import { asSessionId, newId } from '../ids.ts';
import { invalid, unavailable, type DomainError } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import { FILES_LIMITS, isBrowsablePath, isSensitivePath } from '../workspace-files.ts';
import { authorizeProject, authorizeSession, type AccessPolicy } from './authorization.ts';
import { routeOf } from './machine-dirs.ts';
import { locationOf } from './workspaces.ts';

/**
 * 工作空间文件浏览（ADR 0025 · P1，只读 + 单文件下载）。会话 → 工作空间 → 那台机器上的 WorkspaceBrowser。
 * 权限：看得见会话（session.read）且对项目有 workspace.files.read；敏感文件要显式确认并留审计；
 * 每人每秒最多 20 次；机器不在线就直说（不缓存，决定 8）。
 */
export interface WorkspaceFilesDeps {
  readonly projects: Pick<ProjectRepository, 'byId'>;
  readonly tasks: Pick<TaskRepository, 'byId'>;
  readonly sessions: Pick<SessionRepository, 'byId'>;
  readonly workspaces: WorkspaceRepository;
  readonly gateway: NodeGateway;
  readonly access?: AccessPolicy;
  readonly audit: Pick<AuditLog, 'append'>;
  /** Server 本机（含本机 Worker）上的实现。 */
  readonly local: WorkspaceBrowser;
  /** 远端 Worker 上的实现（经 hub↔worker RPC）。 */
  readonly remote: (workerId: string) => WorkspaceBrowser;
  readonly bases: SessionBaseStore;
  readonly now: () => number;
}

export type DiffBase = 'session' | 'head';

export interface FilesContext {
  readonly sessionId: string;
  readonly root: string;
  readonly workerId: string | null;
  /** 会话开始时的 HEAD（没记下来是 null，此时 session 基准退回当前 HEAD）。 */
  readonly sessionBase: string | null;
}

interface Located {
  readonly browser: WorkspaceBrowser;
  readonly root: string;
  readonly session: Session;
  readonly project: Project;
  readonly workerId: string | null;
}

export function createWorkspaceFilesService(deps: WorkspaceFilesDeps) {
  const buckets = new Map<string, { at: number; count: number }>();
  const throttle = (subject: Subject | null): Result<void, DomainError> => {
    const key = principalOfSubject(subject)?.user.id ?? 'anonymous';
    const second = Math.floor(deps.now() / 1000);
    const bucket = buckets.get(key);
    if (!bucket || bucket.at !== second) {
      buckets.set(key, { at: second, count: 1 });
      if (buckets.size > 10_000) buckets.clear();
      return ok(undefined);
    }
    bucket.count += 1;
    return bucket.count > FILES_LIMITS.requestsPerSecond ? err(unavailable('请求太频繁，稍后再试')) : ok(undefined);
  };

  async function locate(subject: Subject | null, sessionId: string, opts: { throttle?: boolean } = {}): Promise<Result<Located, DomainError>> {
    if (opts.throttle !== false) {
      const limited = throttle(subject);
      if (!limited.ok) return limited;
    }
    const session = await deps.sessions.byId(asSessionId(sessionId));
    const task = session ? await deps.tasks.byId(session.taskId) : null;
    const project = task ? await deps.projects.byId(task.projectId) : null;
    const seen = await authorizeSession(deps.access, subject, project, session, 'session.read');
    if (!seen.ok) return seen;
    const allowed = await authorizeProject(deps.access, subject, project, 'workspace.files.read');
    if (!allowed.ok) return allowed;
    const location = await locationOf(deps, allowed.value, seen.value);
    if (location.root === '') return err(invalid('这条会话还没有工作空间'));
    const workerId = await routeOf(deps, location.workerId);
    return ok({ browser: workerId === null ? deps.local : deps.remote(workerId), root: location.root, session: seen.value, project: allowed.value, workerId: location.workerId });
  }

  const checkPath = (path: string): Result<void, DomainError> => (isBrowsablePath(path) ? ok(undefined) : err(invalid('路径不合法')));

  async function sensitiveGate(subject: Subject | null, found: Located, path: string, confirmed: boolean, how: string): Promise<Result<void, DomainError>> {
    if (!isSensitivePath(path)) return ok(undefined);
    if (!confirmed) return err(invalid('这是敏感文件（可能含密钥），确认后才能打开'));
    const me = principalOfSubject(subject);
    await deps.audit.append({
      id: newId(),
      actorId: (me?.user.id ?? 'system') as never,
      actorEmail: me?.user.email ?? '',
      action: 'workspace.files.sensitive',
      target: found.session.id,
      detail: `${how} ${path}`.slice(0, 500),
      at: deps.now(),
      teamId: found.project.teamId ?? null
    });
    return ok(undefined);
  }

  async function baseFor(found: Located, base: DiffBase): Promise<string | null> {
    if (base === 'head') return null;
    return deps.bases.get(found.session.id);
  }

  return {
    async context(subject: Subject | null, sessionId: string): Promise<Result<FilesContext, DomainError>> {
      const found = await locate(subject, sessionId);
      if (!found.ok) return found;
      return ok({ sessionId: found.value.session.id, root: found.value.root, workerId: found.value.workerId, sessionBase: await deps.bases.get(found.value.session.id) });
    },
    async list(subject: Subject | null, sessionId: string, path: string): Promise<Result<DirectoryPage, DomainError>> {
      const bad = checkPath(path);
      if (!bad.ok) return bad;
      const found = await locate(subject, sessionId);
      if (!found.ok) return found;
      return found.value.browser.list(found.value.root, path, { limit: FILES_LIMITS.dirEntries });
    },
    /** 预览：最多 1 MB；敏感文件要 confirmed。 */
    async read(subject: Subject | null, sessionId: string, path: string, confirmed: boolean): Promise<Result<FileContent, DomainError>> {
      return readUpTo(subject, sessionId, path, confirmed, FILES_LIMITS.previewBytes, '预览');
    },
    async download(subject: Subject | null, sessionId: string, path: string, confirmed: boolean): Promise<Result<FileContent, DomainError>> {
      const got = await readUpTo(subject, sessionId, path, confirmed, FILES_LIMITS.downloadBytes, '下载');
      if (got.ok && got.value.truncated) return err(invalid(`文件超过 ${FILES_LIMITS.downloadBytes / 1024 / 1024} MB，不能在这里下载`));
      return got;
    },
    async find(subject: Subject | null, sessionId: string, query: string): Promise<Result<readonly string[], DomainError>> {
      if (query.length > 200) return err(invalid('搜索词太长'));
      const found = await locate(subject, sessionId);
      if (!found.ok) return found;
      return found.value.browser.find(found.value.root, query, FILES_LIMITS.findResults);
    },
    async changes(subject: Subject | null, sessionId: string, base: DiffBase): Promise<Result<{ base: DiffBase; commit: string | null; files: readonly ChangedFile[] }, DomainError>> {
      const found = await locate(subject, sessionId);
      if (!found.ok) return found;
      const commit = await baseFor(found.value, base);
      const files = await found.value.browser.changes(found.value.root, commit);
      return files.ok ? ok({ base, commit, files: files.value }) : files;
    },
    async diff(subject: Subject | null, sessionId: string, path: string, base: DiffBase): Promise<Result<FileDiff, DomainError>> {
      const bad = checkPath(path);
      if (!bad.ok || path === '') return err(invalid('路径不合法'));
      const found = await locate(subject, sessionId);
      if (!found.ok) return found;
      if (isSensitivePath(path)) return err(invalid('敏感文件不显示 diff'));
      return found.value.browser.diff(found.value.root, path, await baseFor(found.value, base), FILES_LIMITS.diffBytes);
    },
    /** 订阅变化（SSE 用）：最多 200 个点；机器断线时 onChange 收到 reset。 */
    async watch(subject: Subject | null, sessionId: string, paths: readonly string[], onChange: (notice: FileChangeNotice) => void): Promise<Result<() => void, DomainError>> {
      if (paths.length > FILES_LIMITS.watchPoints) return err(invalid(`最多同时盯 ${FILES_LIMITS.watchPoints} 个目录 / 文件`));
      if (!paths.every(isBrowsablePath)) return err(invalid('路径不合法'));
      const found = await locate(subject, sessionId, { throttle: false });
      if (!found.ok) return found;
      return found.value.browser.watch(found.value.root, paths, onChange);
    },
    /** 会话开跑时记下工作空间的 HEAD（决定 7）；已记过不覆盖，失败不影响会话。 */
    async recordBase(sessionId: string): Promise<void> {
      if (await deps.bases.get(sessionId)) return;
      const session = await deps.sessions.byId(asSessionId(sessionId));
      const task = session ? await deps.tasks.byId(session.taskId) : null;
      const project = task ? await deps.projects.byId(task.projectId) : null;
      if (!session || !project) return;
      const location = await locationOf(deps, project, session);
      if (location.root === '') return;
      const workerId = await routeOf(deps, location.workerId);
      const browser = workerId === null ? deps.local : deps.remote(workerId);
      const head = await browser.head(location.root);
      if (head.ok && head.value) await deps.bases.setIfAbsent(sessionId, head.value);
    }
  };

  async function readUpTo(subject: Subject | null, sessionId: string, path: string, confirmed: boolean, maxBytes: number, how: string): Promise<Result<FileContent, DomainError>> {
    if (path === '' || !isBrowsablePath(path)) return err(invalid('路径不合法'));
    const found = await locate(subject, sessionId);
    if (!found.ok) return found;
    const gate = await sensitiveGate(subject, found.value, path, confirmed, how);
    if (!gate.ok) return gate;
    return found.value.browser.read(found.value.root, path, maxBytes);
  }
}
export type WorkspaceFilesService = ReturnType<typeof createWorkspaceFilesService>;
