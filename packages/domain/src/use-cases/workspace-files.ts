import { principalOfSubject, type Subject } from '../access.ts';
import type { AuditLog } from '../ports/audit-log.ts';
import type { NodeGateway } from '../ports/node-gateway.ts';
import type { ProjectRepository } from '../ports/project-repository.ts';
import type { SessionRepository } from '../ports/session-repository.ts';
import type { TaskRepository } from '../ports/task-repository.ts';
import type { WorkspaceGroupRepository } from '../ports/workspace-groups.ts';
import type { WorkspaceRepository } from '../ports/workspace-repository.ts';
import { CHECKPOINT_REF_PREFIX, CHECKPOINT_RETENTION_MS, checkpointRef, type ChangedFile, type CheckpointStore, type DirectoryPage, type FileChangeNotice, type FileContent, type FileDiff, type RestoreOutcome, type SessionBaseStore, type TurnCheckpoint, type WorkspaceBrowser } from '../ports/workspace-browser.ts';
import type { Project } from '../project.ts';
import type { Session } from '../session.ts';
import { asSessionId, newId } from '../ids.ts';
import { invalid, notFound, unavailable, type DomainError } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import { FILES_LIMITS, isBrowsablePath, isSensitivePath } from '../workspace-files.ts';
import { authorizeProject, authorizeSession, type AccessPolicy } from './authorization.ts';
import { routeOf } from './machine-dirs.ts';
import { locationsOf, type SessionLocation, type SessionLocationMember } from './workspaces.ts';

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
  /** 组合工作空间（多仓库）的落点；不给 = 只会落到单仓库路径。 */
  readonly workspaceGroups?: WorkspaceGroupRepository;
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

export interface FilesContextMember {
  readonly workspaceId: string;
  /** 成员在容器里的目录名（= 仓库名）。 */
  readonly name: string;
  readonly state: 'ready' | 'preparing' | 'failed';
}

/** 组合会话才有：容器根（不是 git 仓库）+ 可以切换的成员。 */
export interface FilesContextGroup {
  readonly root: string;
  readonly members: readonly FilesContextMember[];
}

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
  /** 组合会话：容器根与成员清单（单仓库会话不出现这个字段）。 */
  readonly group?: FilesContextGroup;
  /** 组合会话当前落在哪个成员（workspaceId）；未指定 = null，此时 root 是容器。单仓库不出现。 */
  readonly member?: string | null;
}

interface Located {
  readonly browser: WorkspaceBrowser;
  readonly root: string;
  readonly session: Session;
  readonly project: Project;
  readonly workerId: string | null;
  /** 完整落点（组合会话带容器 + 成员）。 */
  readonly location: SessionLocation;
  /** 当前选中的成员；单仓库 / 组合但没选成员时为 null。 */
  readonly member: SessionLocationMember | null;
  /** 当前 root 就是容器根（不是 git 仓库，只能在里面列目录 / 读文件）。 */
  readonly container: boolean;
}

export function createWorkspaceFilesService(deps: WorkspaceFilesDeps) {
  const buckets = new Map<string, { tokens: number; updatedAt: number }>();
  const throttle = (subject: Subject | null): Result<void, DomainError> => {
    const key = principalOfSubject(subject)?.user.id ?? 'anonymous';
    const now = deps.now();
    const burst = FILES_LIMITS.requestBurst;
    const rate = FILES_LIMITS.requestsPerSecond;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: burst, updatedAt: now };
      buckets.set(key, bucket);
      if (buckets.size > 10_000) buckets.clear();
    }
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(burst, bucket.tokens + (elapsed / 1000) * rate);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) return err(unavailable('请求太频繁，稍后再试'));
    bucket.tokens -= 1;
    return ok(undefined);
  };

  async function locate(subject: Subject | null, sessionId: string, opts: { throttle?: boolean; member?: string } = {}): Promise<Result<Located, DomainError>> {
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
    const location = await locationsOf(deps, allowed.value, seen.value);
    if (location.root === '') return err(invalid('这条会话还没有工作空间'));
    let root = location.root;
    let member: SessionLocationMember | null = null;
    // 单仓库会话忽略 member（行为与组合之前完全一致）。
    if (location.group !== null && opts.member) {
      const picked = location.members.find((item) => item.workspaceId === opts.member);
      if (!picked) return err(invalid('这颗仓库不属于这条会话的组合工作空间'));
      member = picked;
      root = picked.root;
    }
    const workerId = await routeOf(deps, location.workerId);
    return ok({
      browser: workerId === null ? deps.local : deps.remote(workerId),
      root,
      session: seen.value,
      project: allowed.value,
      workerId: location.workerId,
      location,
      member,
      container: location.group !== null && member === null
    });
  }

  /** 组合会话的 .agent-hub 是容器标记目录：不列、不读、不搜。 */
  const insideAgentHub = (path: string): boolean => path === '.agent-hub' || path.startsWith('.agent-hub/');
  const hiddenGroupPath = (found: Located, path: string): boolean => found.location.group !== null && insideAgentHub(path);
  /** 会话基准按成员分开存（不同仓库的 HEAD 互不相干）。 */
  const baseKey = (found: Located): string => (found.member ? `${found.session.id}:${found.member.workspaceId}` : found.session.id);

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
    if (base === 'session') return ok({ base: await deps.bases.get(baseKey(found)), target: null, turn: null });
    const turns = deps.checkpoints ? await deps.checkpoints.list(found.session.id) : [];
    const picked = turn === undefined ? turns.at(-1) : turns.find((t) => t.turn === turn);
    if (!picked) return err(notFound(turns.length === 0 ? '这条会话还没有回合检查点' : '没有这一轮'));
    return ok({ base: picked.before, target: picked.after, turn: picked });
  }

  /** 后台记账用的定位：不走权限（组合根在会话指令发出时调）。 */
  async function locateSystem(sessionId: string): Promise<{ browser: WorkspaceBrowser; root: string; session: Session; group: SessionLocation['group'] } | null> {
    const session = await deps.sessions.byId(asSessionId(sessionId));
    const task = session ? await deps.tasks.byId(session.taskId) : null;
    const project = task ? await deps.projects.byId(task.projectId) : null;
    if (!session || !project) return null;
    const location = await locationsOf(deps, project, session);
    if (location.root === '') return null;
    const workerId = await routeOf(deps, location.workerId);
    return { browser: workerId === null ? deps.local : deps.remote(workerId), root: location.root, session, group: location.group };
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
    async context(subject: Subject | null, sessionId: string, member?: string): Promise<Result<FilesContext, DomainError>> {
      const found = await locate(subject, sessionId, { member });
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
      const group = found.value.location.group;
      return ok({
        sessionId: found.value.session.id,
        root: found.value.root,
        workerId: found.value.workerId,
        sessionBase: found.value.container ? null : await deps.bases.get(baseKey(found.value)),
        otherProjectSessions,
        // 单仓库会话不出现 group / member，保持既有前端契约不变。
        ...(group === null
          ? {}
          : {
              group: {
                root: found.value.location.root,
                members: found.value.location.members.map((item) => ({ workspaceId: item.workspaceId, name: item.name, state: item.state }))
              },
              member: found.value.member?.workspaceId ?? null
            })
      });
    },
    async list(subject: Subject | null, sessionId: string, path: string, member?: string): Promise<Result<DirectoryPage, DomainError>> {
      const bad = checkPath(path);
      if (!bad.ok) return bad;
      const found = await locate(subject, sessionId, { member });
      if (!found.ok) return found;
      if (hiddenGroupPath(found.value, path)) return err(invalid('路径不合法'));
      const page = await found.value.browser.list(found.value.root, path, { limit: FILES_LIMITS.dirEntries });
      if (!page.ok || !found.value.container) return page;
      // 容器的 .agent-hub 是平台标记目录，不能出现在文件树里。
      return ok({ ...page.value, entries: page.value.entries.filter((entry) => entry.name !== '.agent-hub') });
    },
    /** 预览：最多 1 MB；敏感文件要 confirmed。 */
    async read(subject: Subject | null, sessionId: string, path: string, confirmed: boolean, member?: string): Promise<Result<FileContent, DomainError>> {
      return readUpTo(subject, sessionId, path, confirmed, FILES_LIMITS.previewBytes, '预览', member);
    },
    async download(subject: Subject | null, sessionId: string, path: string, confirmed: boolean, member?: string): Promise<Result<FileContent, DomainError>> {
      const got = await readUpTo(subject, sessionId, path, confirmed, FILES_LIMITS.downloadBytes, '下载', member);
      if (got.ok && got.value.truncated) return err(invalid(`文件超过 ${FILES_LIMITS.downloadBytes / 1024 / 1024} MB，不能在这里下载`));
      return got;
    },
    async find(subject: Subject | null, sessionId: string, query: string, member?: string): Promise<Result<readonly string[], DomainError>> {
      if (query.length > 200) return err(invalid('搜索词太长'));
      const found = await locate(subject, sessionId, { member });
      if (!found.ok) return found;
      const hits = await found.value.browser.find(found.value.root, query, FILES_LIMITS.findResults);
      if (!hits.ok || found.value.location.group === null) return hits;
      return ok(hits.value.filter((path) => !insideAgentHub(path)));
    },
    async changes(subject: Subject | null, sessionId: string, base: DiffBase, turn?: number, member?: string): Promise<Result<{ base: DiffBase; commit: string | null; target: string | null; turn: number | null; files: readonly ChangedFile[] }, DomainError>> {
      const found = await locate(subject, sessionId, { member });
      if (!found.ok) return found;
      // 容器根不是 git 仓库：没选成员时没有「整体改动」，直接给空（前端按成员分别查）。
      if (found.value.container) return ok({ base, commit: null, target: null, turn: null, files: [] });
      const range = await rangeFor(found.value, base, turn);
      if (!range.ok) return range;
      const files = await found.value.browser.changes(found.value.root, range.value.base, range.value.target);
      return files.ok ? ok({ base, commit: range.value.base, target: range.value.target, turn: range.value.turn?.turn ?? null, files: files.value }) : files;
    },
    async diff(subject: Subject | null, sessionId: string, path: string, base: DiffBase, turn?: number, member?: string): Promise<Result<FileDiff, DomainError>> {
      const bad = checkPath(path);
      if (!bad.ok || path === '') return err(invalid('路径不合法'));
      const found = await locate(subject, sessionId, { member });
      if (!found.ok) return found;
      if (found.value.container) return err(invalid('请选择要查看改动的仓库'));
      if (hiddenGroupPath(found.value, path)) return err(invalid('路径不合法'));
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
        // 组合工作空间（§12.3 v1）：容器不是 git 仓库，不做跨仓检查点。
        if (where.group !== null) return null;
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
        if (where && where.group === null) await closeTurn(store, where, open);
      });
    },
    /** 以这条问话开头的那一轮（「从这里重来」用）；没有检查点 = null。 */
    async turnFor(sessionId: string, promptSeq: number): Promise<TurnCheckpoint | null> {
      return (await deps.checkpoints?.list(sessionId))?.find((t) => t.promptSeq === promptSeq) ?? null;
    },
    /**
     * 连文件一起回滚（ADR 0027 阶段 4）：工作区恢复到这一轮开始前；恢复前的样子拍到同一会话前缀下的安全 ref，
     * 跟会话的检查点一起过保留期 / 随工作空间删除。权限、共享检查在调用方（rewind 用例）。
     */
    async turnsOf(sessionId: string): Promise<readonly TurnCheckpoint[]> {
      return (await deps.checkpoints?.list(sessionId)) ?? [];
    },
    async restoreTurn(sessionId: string, promptSeq: number): Promise<Result<RestoreOutcome & { readonly turn: number }, DomainError>> {
      const where = await locateSystem(sessionId);
      if (!where) return err(invalid('这条会话还没有工作空间'));
      // 组合工作空间（§12.3 v1）：不做跨仓回滚，请在成员仓库里各自提交 / 撤销。
      if (where.group !== null) return err(invalid('组合工作空间暂不支持回滚，请在成员仓库里各自提交'));
      const turn = await this.turnFor(sessionId, promptSeq);
      if (!turn) return err(notFound('这条消息没有检查点（检查点上线之前的消息，或工作空间不是 git 仓库），不能回滚文件'));
      return serial(sessionId, async () => {
        const safety = checkpointRef(sessionId, 900_000 + (Math.floor(deps.now() / 1000) % 99_999));
        const done = await where.browser.restore(where.root, turn.before, safety);
        return done.ok ? ok({ ...done.value, turn: turn.turn }) : done;
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
    async watch(subject: Subject | null, sessionId: string, paths: readonly string[], onChange: (notice: FileChangeNotice) => void, member?: string): Promise<Result<() => void, DomainError>> {
      if (paths.length > FILES_LIMITS.watchPoints) return err(invalid(`最多同时盯 ${FILES_LIMITS.watchPoints} 个目录 / 文件`));
      if (!paths.every(isBrowsablePath)) return err(invalid('路径不合法'));
      const found = await locate(subject, sessionId, { throttle: false, member });
      if (!found.ok) return found;
      if (found.value.container) return err(invalid('请选择要查看改动的仓库'));
      if (paths.some((path) => hiddenGroupPath(found.value, path))) return err(invalid('路径不合法'));
      return found.value.browser.watch(found.value.root, paths, onChange);
    },
    /** 会话开跑时记下工作空间的 HEAD（决定 7）；已记过不覆盖，失败不影响会话。 */
    async recordBase(sessionId: string): Promise<void> {
      const session = await deps.sessions.byId(asSessionId(sessionId));
      const task = session ? await deps.tasks.byId(session.taskId) : null;
      const project = task ? await deps.projects.byId(task.projectId) : null;
      if (!session || !project) return;
      const location = await locationsOf(deps, project, session);
      if (location.root === '') return;
      // 组合工作空间：每个成员各记一份（容器根不是 git 仓库）。
      const targets: Array<{ key: string; root: string }> =
        location.group === null
          ? [{ key: sessionId, root: location.root }]
          : location.members.filter((item) => item.root !== '').map((item) => ({ key: `${sessionId}:${item.workspaceId}`, root: item.root }));
      const workerId = await routeOf(deps, location.workerId);
      const browser = workerId === null ? deps.local : deps.remote(workerId);
      for (const target of targets) {
        if (await deps.bases.get(target.key)) continue;
        const head = await browser.head(target.root);
        if (head.ok && head.value) await deps.bases.setIfAbsent(target.key, head.value);
      }
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

  async function readUpTo(subject: Subject | null, sessionId: string, path: string, confirmed: boolean, maxBytes: number, how: string, member?: string): Promise<Result<FileContent, DomainError>> {
    if (path === '' || !isBrowsablePath(path)) return err(invalid('路径不合法'));
    const found = await locate(subject, sessionId, { member });
    if (!found.ok) return found;
    if (hiddenGroupPath(found.value, path)) return err(invalid('路径不合法'));
    const gate = await sensitiveGate(subject, found.value, path, confirmed, how);
    if (!gate.ok) return gate;
    return found.value.browser.read(found.value.root, path, maxBytes);
  }
}
export type WorkspaceFilesService = ReturnType<typeof createWorkspaceFilesService>;
