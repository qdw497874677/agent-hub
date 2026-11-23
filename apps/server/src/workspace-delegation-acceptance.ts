import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
  authorizeProject,
  authorizeSession,
  conflict,
  err,
  invalid,
  notFound,
  ok,
  principalOfSubject,
  unavailable,
  withActiveTask,
  type AccessPolicy,
  type DelegationAcceptance,
  type DelegationAcceptanceResult,
  type DelegationAcceptanceStore,
  type DomainError,
  type Principal,
  type Project,
  type ProjectRepository,
  type Result,
  type Session,
  type SessionRepository,
  type Subject,
  type Task,
  type TaskGate,
  type TaskRepository,
  type WorkspaceDelegation,
  type WorkspaceDelegationStore
} from '@agent-hub/domain';
import { fail } from './http-error.ts';
import type { SubjectOf } from './auth.ts';

/**
 * 人工验收的 HTTP 适配器（docs/design/vibex-borrowing.md，第二期「V7 验收精确绑定 SHA」）。
 *
 * 这里只做三件事：
 * - 按「派工所有者 + 当前执行会话可读 + 任务可更新」判定，任何一种对不上都隐藏成 404，
 *   不借验收接口打开团队级派工详情。
 * - GET 返回追加历史和**当场**读出的执行工作树 HEAD；历史里的 SHA 原样返回，不因 HEAD
 *   变化而被改写。HEAD 读不到时只给中性文案，不回显 resolver 的原始错误。
 * - POST 先按当前可见性查同请求键的持久记录：完全一致就重放、不同就 conflict（都不读
 *   Worker）；只有新记录才核对完整 HEAD，落库前再读一次派工 / 任务 / 会话上下文。
 *
 * 验收记录不改任务状态、不触发发布，也不是测试通过证据。所有响应都不包含 instructions、
 * 工作树路径、仓库地址、复制指纹或 claim。
 */

/** 只读判定所需的最小端口；不含 git / Worker 凭据。 */
export interface DelegationAcceptanceRouteOptions {
  readonly delegations: Pick<WorkspaceDelegationStore, 'byId'>;
  readonly acceptances: Pick<DelegationAcceptanceStore, 'append' | 'byRequest' | 'latestForSha' | 'history'>;
  readonly projects: Pick<ProjectRepository, 'byId'>;
  readonly tasks: Pick<TaskRepository, 'byId'>;
  readonly sessions: Pick<SessionRepository, 'byId'>;
  readonly access?: AccessPolicy;
  /** 验收记录里的写入时间；测试注入固定时钟。 */
  readonly now: () => number;
  /** 和任务归档 / 恢复串行化；不传表示没有归档门。 */
  readonly taskGate?: TaskGate;
  /**
   * 只读 HEAD 解析（`createDelegationHeadResolver`）。GET 用它说明「现在验收哪个提交」，
   * POST 用它核对 expectedHeadSha；不传或解析失败时一律按「无法确认」处理。
   */
  readonly resolveHead?: (record: WorkspaceDelegation) => Promise<Result<string, DomainError>>;
}

/** 一条历史验收的对外视图：只给验收本身，不带派工路径、机器或指令。 */
export interface DelegationAcceptanceEntryView {
  readonly requestKey: string;
  readonly sha: string;
  readonly createdAt: number;
  readonly note: string | null;
}

/**
 * 当前验收状态：
 * - `none`：还没有任何验收记录，且当场 HEAD 可读；
 * - `accepted`：当场 HEAD 的精确 SHA 在历史里已有验收（`current` 非 null），即使 `latest`
 *   是另一个更晚验收的提交；
 * - `changed`：没有任何记录精确匹配当场 HEAD，但曾验收过别的 SHA；
 * - `unavailable`：派工尚未准备好，或当场读不到 HEAD，不能确认当前性（此时即使历史为空
 *   也不是 `none`，历史为空由 `history` / `latest` 单独表达）。
 */
export type DelegationAcceptanceStatus = 'none' | 'accepted' | 'changed' | 'unavailable';

export interface DelegationAcceptanceView {
  readonly delegationId: string;
  readonly state: WorkspaceDelegation['state'];
  /** 追加顺序（旧 -> 新），条数由存储层限幅。 */
  readonly history: readonly DelegationAcceptanceEntryView[];
  /** 最近一次验收；没有记录时为 null。 */
  readonly latest: DelegationAcceptanceEntryView | null;
  /**
   * 当场 HEAD 的精确历史验收：按 `(delegationId, sha)` 索引查到的那条，不受 history 条数限制。
   * HEAD 不可读或从未验收过这个 SHA 时为 null；它可能不是 `latest`（例如中途验收过别的提交）。
   */
  readonly current: DelegationAcceptanceEntryView | null;
  /** 当场读到的完整 HEAD；派工未准备好 / 读不到时为 null。 */
  readonly headSha: string | null;
  /** HEAD 读不到时的中性说明；不包含 resolver 的原始错误。 */
  readonly headUnavailable: string | null;
  /** HEAD 成功读出时的观察时间。 */
  readonly headObservedAt: number | null;
  readonly status: DelegationAcceptanceStatus;
  /**
   * 服务端推导的「现在能否提交验收」，只作为界面提示：
   * 派工 state=prepared、当场 HEAD 可读、任务未归档，且当前主体对任务有 task.update。
   * 任何查询 / 权限判定失败都默认 false；GET 本身仍是只读的，不会因 false 返回 403。
   */
  readonly canAccept: boolean;
}

export interface DelegationAcceptanceSubmitView {
  readonly delegationId: string;
  readonly outcome: 'created' | 'replayed';
  readonly acceptance: DelegationAcceptanceEntryView;
}

const HEAD_UNAVAILABLE = '暂时无法读取执行工作树的当前提交';
const CONFLICT_KEY = '同一请求键已用于其他验收内容';

/** 请求键原样落库（不做 trim / 大小写归一），但长度和字符集有界。 */
const REQUEST_KEY = z
  .string()
  .max(200, 'requestKey 不能超过 200 字符')
  .refine(
    (value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value),
    'requestKey 必须是 trim 后非空、且不含控制字符的字符串'
  );

/** 备注允许换行 / 制表，但不允许其他控制字符；原样保存，空字符串与省略不同。 */
const NOTE = z
  .string()
  .max(2000, 'note 不能超过 2000 字符')
  .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), 'note 不能包含控制字符');

const ACCEPT_BODY = z
  .object({
    requestKey: REQUEST_KEY,
    expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/, 'expectedHeadSha 必须是 40 位小写十六进制提交'),
    note: NOTE.nullable().optional()
  })
  .strict();

const NO_STORE = { 'cache-control': 'no-store' };

function humanOf(subject: Subject | null): Principal | null {
  const principal = principalOfSubject(subject);
  return principal !== null && principal.via === undefined ? principal : null;
}

async function readJson(c: Context): Promise<unknown> {
  return c.req.json().catch(() => null);
}

function acceptanceView(record: DelegationAcceptance): DelegationAcceptanceEntryView {
  return {
    requestKey: record.requestKey,
    sha: record.sha,
    createdAt: record.createdAt,
    note: record.note
  };
}

/** 失败响应也禁止缓存：错误里可能暴露某条派工是否存在。 */
function failed(c: Context, error: DomainError): Response {
  const response = fail(c, error);
  response.headers.set('cache-control', 'no-store');
  return response;
}

interface LoadedAcceptanceContext {
  readonly record: WorkspaceDelegation;
  readonly project: Project;
  readonly task: Task;
  readonly session: Session;
}

/**
 * 所有「这条派工对本主体可见」的判定集中在这里：
 * - 必须是真人 cookie 主体、且是派工记录的所有者；
 * - 项目必须可见，任务必须存在且仍属于这个项目（防止卡片 / 任务漂移）；
 * - 当前执行会话必须存在、属于同一任务、由所有者创建、不是 bot / 侧聊 / 派生，
 *   并且主体能读它；
 * - 写操作额外要求 task.update，且任务未归档。
 * 任何一项不成立都按「派工记录不存在」隐藏，避免变成探测别的团队派工的接口。
 */
async function loadContext(
  options: DelegationAcceptanceRouteOptions,
  delegationId: string,
  actor: Subject,
  principal: Principal,
  write: boolean
): Promise<Result<LoadedAcceptanceContext, DomainError>> {
  const record = await options.delegations.byId(delegationId);
  if (!record || record.accountId !== principal.user.id) return err(notFound('派工记录不存在'));

  const project = await options.projects.byId(record.projectId);
  if (!project) return err(notFound('派工记录不存在'));
  const visible = await authorizeProject(options.access, actor, project, 'project.read');
  if (!visible.ok) return err(notFound('派工记录不存在'));

  const task = await options.tasks.byId(record.taskId);
  if (!task || task.projectId !== project.id) return err(notFound('派工记录不存在'));

  const session = await options.sessions.byId(record.executionSessionId);
  if (
    !session ||
    session.taskId !== record.taskId ||
    session.createdBy !== record.accountId ||
    session.botId ||
    session.parentSessionId ||
    session.kind === 'side'
  ) {
    return err(notFound('派工记录不存在'));
  }
  const readable = await authorizeSession(options.access, actor, project, session, 'session.read');
  if (!readable.ok) return err(notFound('派工记录不存在'));

  if (write) {
    const writable = await authorizeProject(options.access, actor, project, 'task.update');
    if (!writable.ok) return err(writable.error);
    if (task.archivedAt != null) return err(conflict('任务已归档，请恢复后再继续'));
  }
  return ok({ record, project, task, session });
}

/** HEAD 只在派工确实 prepared 时读取；任何错误都压成中性文案，不把私有路径 / git 输出带出去。 */
async function observeHead(
  record: WorkspaceDelegation,
  resolveHead: ((record: WorkspaceDelegation) => Promise<Result<string, DomainError>>) | undefined,
  now: () => number
): Promise<{ readonly sha: string | null; readonly unavailable: string | null; readonly observedAt: number | null }> {
  if (record.state !== 'prepared') return { sha: null, unavailable: null, observedAt: null };
  if (resolveHead === undefined) return { sha: null, unavailable: HEAD_UNAVAILABLE, observedAt: null };
  try {
    const result = await resolveHead(record);
    return result.ok ? { sha: result.value, unavailable: null, observedAt: now() } : { sha: null, unavailable: HEAD_UNAVAILABLE, observedAt: null };
  } catch {
    return { sha: null, unavailable: HEAD_UNAVAILABLE, observedAt: null };
  }
}

function statusOf(
  latest: DelegationAcceptance | null,
  current: DelegationAcceptance | null,
  headSha: string | null
): DelegationAcceptanceStatus {
  // 读不到当场 HEAD（派工未准备好或 Worker 不可用）时，不能把「没有历史」说成 none：
  // 当前性本身未知，统一是 unavailable；历史是否为空由 history / latest 单独表达。
  if (headSha === null) return 'unavailable';
  // 精确 SHA 的验收证据优先于「最近一条」：HEAD 回到 A 时，即使更晚验收过 B，A 仍是
  // accepted；latest 继续单独表示最近一次验收，两者不要混用。
  if (current !== null) return 'accepted';
  return latest === null ? 'none' : 'changed';
}

/**
 * 只读 GET 里的 `canAccept` 提示。这里不抛错、不返回原因：
 * 派工未 prepared、HEAD 不可读、任务归档、没有 task.update、查询抛错，全部 false。
 */
async function canAcceptNow(
  options: DelegationAcceptanceRouteOptions,
  actor: Subject,
  loaded: LoadedAcceptanceContext,
  headSha: string | null
): Promise<boolean> {
  if (headSha === null || loaded.record.state !== 'prepared' || loaded.task.archivedAt != null) return false;
  if (options.access === undefined) return true;
  try {
    const writable = await authorizeProject(options.access, actor, loaded.project, 'task.update');
    return writable.ok;
  } catch {
    return false;
  }
}

/**
 * 挂载：
 * - `GET  /api/workspace-delegations/:delegationId/acceptance`（历史 + 当场 HEAD）
 * - `POST /api/workspace-delegations/:delegationId/acceptance`（追加一次验收）
 *
 * 两个接口都只对派工所有者的真人会话开放；GET 不要求 task.update，POST 要求。
 */
export function installDelegationAcceptanceRoutes(
  app: Hono<any>,
  options: DelegationAcceptanceRouteOptions,
  subjectOf: SubjectOf
): void {
  app.get('/api/workspace-delegations/:delegationId/acceptance', async (c) => {
    try {
      return await getAcceptance(c, options, subjectOf);
    } catch {
      return failed(c, unavailable('验收信息暂时不可用，请稍后重试'));
    }
  });

  app.post('/api/workspace-delegations/:delegationId/acceptance', async (c) => {
    try {
      return await postAcceptance(c, options, subjectOf);
    } catch {
      return failed(c, unavailable('验收暂时无法提交，请重试'));
    }
  });
}

async function getAcceptance(
  c: Context,
  options: DelegationAcceptanceRouteOptions,
  subjectOf: SubjectOf
): Promise<Response> {
  const actor = subjectOf(c);
  const principal = humanOf(actor);
  if (!actor || principal === null) return failed(c, notFound('派工记录不存在'));

  const delegationId = c.req.param('delegationId');
  if (delegationId === undefined) return failed(c, notFound('派工记录不存在'));

  const loaded = await loadContext(options, delegationId, actor, principal, false);
  if (!loaded.ok) return failed(c, loaded.error);

  const record = loaded.value.record;
  const history = await options.acceptances.history(record.id);
  const latest = history.length === 0 ? null : (history[history.length - 1] ?? null);
  const head = await observeHead(record, options.resolveHead, options.now);
  // 必须绕过 history 的条数窗口：较早验收过的 SHA 可能不在最近 50 条里。
  const current = head.sha === null ? null : await options.acceptances.latestForSha(record.id, head.sha);
  const canAccept = await canAcceptNow(options, actor, loaded.value, head.sha);

  const body: DelegationAcceptanceView = {
    delegationId: record.id,
    state: record.state,
    history: history.map(acceptanceView),
    latest: latest === null ? null : acceptanceView(latest),
    current: current === null ? null : acceptanceView(current),
    headSha: head.sha,
    headUnavailable: head.unavailable,
    headObservedAt: head.observedAt,
    status: statusOf(latest, current, head.sha),
    canAccept
  };
  return c.json(body, 200, NO_STORE);
}

async function postAcceptance(
  c: Context,
  options: DelegationAcceptanceRouteOptions,
  subjectOf: SubjectOf
): Promise<Response> {
  const actor = subjectOf(c);
  const principal = humanOf(actor);
  if (!actor || principal === null) return failed(c, notFound('派工记录不存在'));

  const body = ACCEPT_BODY.safeParse(await readJson(c));
  if (!body.success) return failed(c, invalid('请求内容不合法'));

  const delegationId = c.req.param('delegationId');
  if (delegationId === undefined) return failed(c, notFound('派工记录不存在'));
  const requestKey = body.data.requestKey;
  const expectedHeadSha = body.data.expectedHeadSha;
  const note = body.data.note ?? null;

  const loaded = await loadContext(options, delegationId, actor, principal, true);
  if (!loaded.ok) return failed(c, loaded.error);
  const record = loaded.value.record;

  // 持久重放先于任何 Worker I/O：同键同内容直接返回原记录，同键不同内容只报冲突，
  // 都不把已有记录（备注 / 旧 SHA）回给调用方。
  const existing = await options.acceptances.byRequest(record.id, requestKey);
  if (existing) {
    const replay =
      existing.sha === expectedHeadSha && existing.actorId === principal.user.id && existing.note === note;
    if (!replay) return failed(c, conflict(CONFLICT_KEY));
    const response: DelegationAcceptanceSubmitView = {
      delegationId: record.id,
      outcome: 'replayed',
      acceptance: acceptanceView(existing)
    };
    return c.json(response, 200, NO_STORE);
  }

  // 只有新记录需要当场核对；派工未准备好时没有可核对的工作树，不落记录。
  if (record.state !== 'prepared') return failed(c, conflict('派工还没有可核对的工作树'));

  let headSha: string;
  if (options.resolveHead === undefined) {
    return failed(c, unavailable('暂时无法核对执行工作树当前提交，未记录验收'));
  }
  try {
    const head = await options.resolveHead(record);
    if (!head.ok) return failed(c, unavailable('暂时无法核对执行工作树当前提交，未记录验收'));
    headSha = head.value;
  } catch {
    return failed(c, unavailable('暂时无法核对执行工作树当前提交，未记录验收'));
  }
  if (headSha !== expectedHeadSha) {
    return failed(c, conflict('执行工作树当前提交与预期不一致，请刷新后重试'));
  }
  const verifiedHead = headSha;

  // 落库前重新读取派工 / 任务 / 会话 / 权限，并和归档 / 恢复串行化。HEAD 已经核对过，
  // 这里不再触发第二次 Worker 读取；只要目标身份或状态变了就要求人重试。
  const appended = await withActiveTask<DelegationAcceptanceResult>(
    { taskGate: options.taskGate, tasks: options.tasks },
    record.taskId,
    async (): Promise<Result<DelegationAcceptanceResult, DomainError>> => {
      const live = await loadContext(options, delegationId, actor, principal, true);
      if (!live.ok) return live;
      const current = live.value.record;
      if (
        current.state !== 'prepared' ||
        current.executionSessionId !== record.executionSessionId ||
        current.workerId !== record.workerId ||
        current.branch !== record.branch ||
        current.worktreePath !== record.worktreePath
      ) {
        return err(conflict('派工记录在验收期间发生了变化，请刷新后重试'));
      }
      try {
        const result = await options.acceptances.append({
          delegationId: current.id,
          requestKey,
          sha: verifiedHead,
          actorId: principal.user.id,
          createdAt: options.now(),
          note
        });
        if (result.outcome === 'conflict') return err(conflict(CONFLICT_KEY));
        // 另一个连接可能在我们 byRequest 之后抢先写入同内容：存储返回 replayed 时必须
        // 原样告诉调用方，不能把一次重放包装成新建。
        return ok(result);
      } catch {
        return err(unavailable('验收记录暂时无法保存，请重试'));
      }
    }
  );
  if (!appended.ok) return failed(c, appended.error);

  const response: DelegationAcceptanceSubmitView = {
    delegationId: record.id,
    outcome: appended.value.outcome === 'replayed' ? 'replayed' : 'created',
    acceptance: acceptanceView(appended.value.record)
  };
  return c.json(response, 200, NO_STORE);
}
