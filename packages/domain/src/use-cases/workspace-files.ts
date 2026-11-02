import { principalOfSubject, type Subject } from '../access.ts';
import type { AuditLog } from '../ports/audit-log.ts';
import type { NodeGateway } from '../ports/node-gateway.ts';
import type { ProjectRepository } from '../ports/project-repository.ts';
import type { SessionRepository } from '../ports/session-repository.ts';
import type { TaskRepository } from '../ports/task-repository.ts';
import type { WorkspaceRepository } from '../ports/workspace-repository.ts';
import { CHECKPOINT_REF_PREFIX, CHECKPOINT_RETENTION_MS, checkpointRef, type ChangedFile, type CheckpointStore, type DirectoryPage, type FileChangeNotice, type FileContent, type FileDiff, type SessionBaseStore, type TurnCheckpoint, type WorkspaceBrowser } from '../ports/workspace-browser.ts';
import type { Project } from '../project.ts';
import type { Session } from '../session.ts';
import { asSessionId, newId } from '../ids.ts';
import { invalid, notFound, unavailable, type DomainError } from '../errors.ts';
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
  readonly sessions: Pick<SessionRepository, 'byId' | 'listByWorkspace'>;
  readonly workspaces: WorkspaceRepository;
  readonly gateway: NodeGateway;
  readonly access?: AccessPolicy;
  readonly audit: Pick<AuditLog, 'append'>;
  /** Server 本机（含本机 Worker）上的实现。 */
  readonly local: WorkspaceBrowser;
  /** 远端 Worker 上的实现（经 hub↔worker RPC）。 */
  readonly remote: (workerId: string) => WorkspaceBrowser;
  readonly bases: SessionBaseStore;
  /** 回合检查点（ADR 0027 阶段 1）；不给 = 没有「本轮」视图。 */
  readonly checkpoints?: CheckpointStore;
  readonly now: () => number;
}

/** session：会话开始时的 HEAD → 工作区；head：当前 HEAD → 工作区；turn：某一轮开始前 → 这一轮结束后（没结束 = 工作区）。 */
export type DiffBase = 'session' | 'head' | 'turn';

export interface FilesContext {
  readonly sessionId: string;
  readonly root: string;
  readonly workerId: string | null;
  /** 会话开始时的 HEAD（没记下来是 null，此时 session 基准退回当前 HEAD）。 */
  readonly sessionBase: string | null;
  /**
   * 别的项目此刻在同一个工作空间里跑的会话数（ADR 0026 Q6）。改动页的 git 改动是整个目录的，
   * 里面可能混着它们的改动；只给个数，不透露是哪个项目。
   */
  readonly otherProjectSessions: number;
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

  async function rangeFor(found: Located, base: DiffBase, turn?: number): Promise<Result<{ base: string | null; target: string | null; turn: TurnCheckpoint | null }, DomainError>> {
    if (base === 'head') return ok({ base: null, target: null, turn: null });
    if (base === 'session') return ok({ base: await deps.bases.get(found.session.id), target: null, turn: null });
    const turns = deps.checkpoints ? await deps.checkpoints.list(found.session.id) : [];
    const picked = turn === undefined ? turns.at(-1) : turns.find((t) => t.turn === turn);
    if (!picked) return err(notFound(turns.length === 0 ? '这条会话还没有回合检查点' : '没有这一轮'));
    return ok({ base: picked.before, target: picked.after, turn: picked });
  }

  /** 后台记账用的定位：不走权限（组合根在会话指令发出时调）。 */
  async function locateSystem(sessionId: string): Promise<{ browser: WorkspaceBrowser; root: string } | null> {
    const session = await deps.sessions.byId(asSessionId(sessionId));
    const task = session ? await deps.tasks.byId(session.taskId) : null;
    const project = task ? await deps.projects.byId(task.projectId) : null;
    if (!session || !project) return null;
    const location = await locationOf(deps, project, session);
    if (location.root === '') return null;
    const workerId = await routeOf(deps, location.workerId);
    return { browser: workerId === null ? deps.local : deps.remote(workerId), root: location.root };
  }

  // 同一会话的检查点一个接一个打（开始、结束不交叉）
  const chains = new Map<string, Promise<unknown>>();
  const serial = <T>(sessionId: string, run: () => Promise<T>): Promise<T> => {
    const next = (chains.get(sessionId) ?? Promise.resolve()).then(run, run);
    chains.set(sessionId, next.catch(() => undefined));
    void next.finally(() => {
      if (chains.get(sessionId) === next) chains.delete(sessionId);
    }).catch(() => undefined);
    return next;
  };

  return {
    async context(subject: Subject | null, sessionId: string): Promise<Result<FilesContext, DomainError>> {
      const found = await locate(subject, sessionId);
      if (!found.ok) return found;
      let otherProjectSessions = 0;
      const workspaceId = found.value.session.workspaceId;
      if (workspaceId) {
        for (const other of await deps.sessions.listByWorkspace(workspaceId)) {
          if (other.status !== 'running' || other.id === found.value.session.id) continue;
          const task = await deps.tasks.byId(other.taskId);
          if (task && task.projectId !== found.value.project.id) otherProjectSessions += 1;
        }
      }
      return ok({
        sessionId: found.value.session.id,
        root: found.value.root,
        workerId: found.value.workerId,
        sessionBase: await deps.bases.get(found.value.session.id),
        otherProjectSessions
      });
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
    async changes(subject: Subject | null, sessionId: string, base: DiffBase, turn?: number): Promise<Result<{ base: DiffBase; commit: string | null; target: string | null; turn: number | null; files: readonly ChangedFile[] }, DomainError>> {
      const found = await locate(subject, sessionId);
      if (!found.ok) return found;
      const range = await rangeFor(found.value, base, turn);
      if (!range.ok) return range;
      const files = await found.value.browser.changes(found.value.root, range.value.base, range.value.target);
      return files.ok ? ok({ base, commit: range.value.base, target: range.value.target, turn: range.value.turn?.turn ?? null, files: files.value }) : files;
    },
    async diff(subject: Subject | null, sessionId: string, path: string, base: DiffBase, turn?: number): Promise<Result<FileDiff, DomainError>> {
      const bad = checkPath(path);
      if (!bad.ok || path === '') return err(invalid('路径不合法'));
      const found = await locate(subject, sessionId);
      if (!found.ok) return found;
      if (isSensitivePath(path)) return err(invalid('敏感文件不显示 diff'));
      const range = await rangeFor(found.value, base, turn);
      if (!range.ok) return range;
      return found.value.browser.diff(found.value.root, path, range.value.base, FILES_LIMITS.diffBytes, range.value.target);
    },
    /** 这条会话的回合列表（新的在后）。 */
    async turns(subject: Subject | null, sessionId: string): Promise<Result<readonly TurnCheckpoint[], DomainError>> {
      const found = await locate(subject, sessionId);
      if (!found.ok) return found;
      return ok(deps.checkpoints ? await deps.checkpoints.list(found.value.session.id) : []);
    },
    /**
     * 一轮开始前打检查点（ADR 0027 D2）。promptSeq = 这一轮问话的事件序号。
     * 上一轮没收尾（崩了、没发 ended）就先把它收掉，免得「本轮」跨两轮。失败不影响会话。
     */
    async beginTurn(sessionId: string, promptSeq: number): Promise<TurnCheckpoint | null> {
      const store = deps.checkpoints;
      if (!store) return null;
      return serial(sessionId, async () => {
        const where = await locateSystem(sessionId);
        if (!where) return null;
        const turns = await store.list(sessionId);
        const open = turns.at(-1);
        if (open && open.after === null) await closeTurn(store, where, open);
        const turn = (turns.at(-1)?.turn ?? 0) + 1;
        const before = await where.browser.checkpoint(where.root, checkpointRef(sessionId, turn * 2 - 1));
        if (!before.ok || !before.value) return null;
        const row = { sessionId, turn, promptSeq, before: before.value, startedAt: deps.now() };
        await store.begin(row);
        return { ...row, after: null, endedAt: null, files: null, additions: null, deletions: null };
      });
    },
    /** 一轮结束后打检查点，顺手算好这一轮改了多少（卡片 / 列表直接用）。 */
    async endTurn(sessionId: string): Promise<void> {
      const store = deps.checkpoints;
      if (!store) return;
      await serial(sessionId, async () => {
        const open = (await store.list(sessionId)).at(-1);
        if (!open || open.after !== null) return;
        const where = await locateSystem(sessionId);
        if (where) await closeTurn(store, where, open);
      });
    },
    /** 保留期清理（D1）：最后一个检查点 30 天前的会话，删 ref + 删行。删工作空间时用 dropSession。 */
    async sweepCheckpoints(): Promise<number> {
      const store = deps.checkpoints;
      if (!store) return 0;
      let swept = 0;
      for (const sessionId of await store.staleSessions(deps.now() - CHECKPOINT_RETENTION_MS)) {
        const session = await deps.sessions.byId(asSessionId(sessionId));
        if (session?.status === 'running') continue;
        await this.dropSession(sessionId);
        swept += 1;
      }
      return swept;
    },
    async dropSession(sessionId: string): Promise<void> {
      const where = await locateSystem(sessionId).catch(() => null);
      // ref 删不掉（机器离线 / 目录没了）也删行：ref 在仓库里不占工作区，下次 gc 时没人引用的对象也会走
      if (where) await where.browser.dropRefs(where.root, `${CHECKPOINT_REF_PREFIX}${sessionId}/`).catch(() => undefined);
      await deps.checkpoints?.remove(sessionId);
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

  async function closeTurn(store: CheckpointStore, where: { browser: WorkspaceBrowser; root: string }, open: TurnCheckpoint): Promise<void> {
    const after = await where.browser.checkpoint(where.root, checkpointRef(open.sessionId, open.turn * 2));
    if (!after.ok || !after.value) return;
    const changed = await where.browser.changes(where.root, open.before, after.value);
    const files = changed.ok ? changed.value : [];
    await store.end(open.sessionId, open.turn, {
      after: after.value,
      endedAt: deps.now(),
      files: files.length,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0)
    });
  }

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
