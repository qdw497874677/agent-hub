import type {
  DomainError,
  GrantActor,
  Result,
  Session,
  SessionId,
  SessionRepository,
  Task,
  TaskId,
  TaskRepository,
  ToolScope,
  WorkspaceDelegationStore,
  ProjectSessionGrant,
  ProjectSessionGrantRepository,
  ProjectSessionGrantScope
} from '@agent-hub/domain';
import {
  DEFAULT_TOOL_SCOPES,
  PROJECT_SESSION_GRANT_SCOPES,
  WORKSPACE_DELEGATE_SCOPE,
  WORKSPACE_REPORT_SCOPE,
  forbidden,
  grantProjectSession,
  invalid,
  listProjectSessionGrants,
  projectSessionGrantActive,
  projectToolScopes,
  requireProjectSessionScope,
  resolveProjectSessionBinding,
  restrictedChildScopes,
  revokeProjectSessionGrants,
  unavailable
} from '@agent-hub/domain';
import { err, ok } from '@agent-hub/domain';

/**
 * 项目会话授权的服务层（docs/design/project-session-mcp.md §27-§31）。
 *
 * 两个入口刻意分开：
 * - `grant` / `revoke` / `list` **只给浏览器认证后的 HTTP 路由**调用；工具侧没有任何入口，
 *   提示词、资产或工具输出都不可能给自己授权。
 * - `authorize` 给工具 provider / 动作入口调用：项目由会话绑定在服务端推导，绝不信任模型传来的 projectId。
 *
 * 安全约定：
 * - 所有入口都通过 `loadActor` 重新读取账号当前状态，并与冻结在授权/令牌里的主体逐字段比对；
 *   不存在「没传 loadActor 就当成 web 登录」的兜底。
 * - 所有入口都过注入的 `sourceEligible`：共享链接 / bot / 群 / connector / dispatch 等来源
 *   是否允许由父层决定，服务层不默认放行。
 * - 项目授权变更必须同时让旧工具令牌失效（`invalidateSessionTools` 由父层接到 gateway.revoke），
 *   否则撤销后重新授权会让旧令牌静默拿回项目 scope。
 */
export type ProjectSessionGrantAction = 'grant' | 'revoke' | 'list' | 'authorize' | 'issue';

/** 来源资格判定的输入；父层可按 action 区分授权 / 撤销 / 动作 / 签发。 */
export interface ProjectSessionGrantSource {
  readonly action: ProjectSessionGrantAction;
  readonly actor: GrantActor;
  readonly session: Session;
  readonly projectId: ProjectSessionGrant['projectId'] | null;
}

export type ProjectSessionGrantSourceEligibility = (
  input: ProjectSessionGrantSource
) => Promise<boolean> | boolean;

export interface ProjectSessionGrantServiceDeps {
  readonly now: () => number;
  readonly projectSessionGrants: ProjectSessionGrantRepository;
  readonly sessions: Pick<SessionRepository, 'byId'>;
  readonly tasks: Pick<TaskRepository, 'byId'>;
  /**
   * 受限子会话识别（两种派工模式都按 executionSessionId 命中）。工具调用时若不可用，
   * 无法证明不是子会话；宁可收紧也不放行项目写工具。
   */
  readonly workspaceDelegations: Pick<WorkspaceDelegationStore, 'byExecutionSession'>;
  /** 仅在已经核实为受限派工执行会话后判断可否回报。 */
  readonly canReportDelegation?: (sessionId: SessionId, actor?: GrantActor) => Promise<boolean>;
  /** 账号当前状态；返回 null 即拒绝。生产环境必须注入，不能默认成 web。 */
  readonly loadActor: (accountId: string) => Promise<GrantActor | null>;
  /** 来源资格（共享 / bot / 群 / connector / dispatch）；生产环境必须注入。 */
  readonly sourceEligible: ProjectSessionGrantSourceEligibility;
  /** 现有权限复核：worktree 打开要求 project.update，建任务要求 task.create。 */
  readonly checkCurrentPermission: (input: CurrentPermissionInput) => Promise<Result<void, DomainError>>;
  /**
   * 让这条会话的旧工具令牌立刻失效（父层接 gateway.revoke({id: sessionId})）。
   * 授权被撤销 / 缩小 / 重新打开时都必须调用；ACP 不能热换令牌，只能等下一次托管换新。
   */
  readonly invalidateSessionTools: (sessionId: SessionId) => Promise<void> | void;
}

export interface CurrentPermissionInput {
  readonly scope: ProjectSessionGrantScope;
  readonly accountId: string;
  readonly sessionId: SessionId;
  readonly projectId: ProjectSessionGrant['projectId'];
  readonly taskId: TaskId | null;
}

export type ProjectToolSession = Pick<Session, 'id' | 'taskId' | 'workerId'>;

export interface ProjectSessionGrantService {
  /** 浏览器（归属人）：授予 / 替换。 */
  grant(input: {
    readonly accountId: string;
    readonly sessionId: SessionId;
    readonly projectId: ProjectSessionGrant['projectId'];
    readonly scopes: readonly ProjectSessionGrantScope[];
    readonly expiresAt?: number | null;
  }): Promise<Result<ProjectSessionGrant, DomainError>>;
  /** 浏览器（归属人）：撤销；省略 projectId 撤销这条会话下全部项目授权。 */
  revoke(input: {
    readonly accountId: string;
    readonly sessionId: SessionId;
    readonly projectId?: ProjectSessionGrant['projectId'];
  }): Promise<Result<{ readonly revoked: number }, DomainError>>;
  /** 浏览器（归属人）：查看。 */
  list(input: { readonly accountId: string; readonly sessionId: SessionId }): Promise<Result<readonly ProjectSessionGrant[], DomainError>>;
  /** 工具 / 动作入口：按会话绑定的项目校验单项能力；项目不从入参取。 */
  authorize(input: {
    readonly actor?: GrantActor;
    readonly sessionId: SessionId;
    readonly scope: ProjectSessionGrantScope;
  }): Promise<Result<ProjectSessionGrant, DomainError>>;
  /**
   * `withToolAccess` 的 scopes 替换点：受限子会话返回最小集，普通会话返回 null
   * （普通会话继续走默认 + extraScopes，不改变既有行为）。
   */
  toolScopes(input: { readonly session: ProjectToolSession; readonly actor?: GrantActor }): Promise<readonly ToolScope[] | null>;
  /** `withToolAccess` 的 extraScopes 追加点：把当前有效项目授权映射成工具 scope；子会话恒为空。 */
  projectExtraScopes(input: { readonly session: ProjectToolSession; readonly actor?: GrantActor }): Promise<readonly ToolScope[]>;
  /** `createToolGateway` 的 scopeCap：撤销项目授权或识别出受限子会话后，旧令牌立即被收窄。 */
  toolScopeCap(session: ProjectToolSession, actor?: GrantActor): Promise<readonly ToolScope[] | null>;
}

interface CanonicalBinding {
  readonly session: Session;
  readonly task: Pick<Task, 'projectId'> | null;
  readonly projectId: ProjectSessionGrant['projectId'];
  readonly accountId: string;
}

const sameActor = (left: GrantActor, right: GrantActor): boolean =>
  left.userId === right.userId && left.via === right.via;

const sameScopes = (left: readonly ProjectSessionGrantScope[], right: readonly ProjectSessionGrantScope[]): boolean => {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((scope) => set.has(scope));
};

export function createProjectSessionGrantService(deps: ProjectSessionGrantServiceDeps): ProjectSessionGrantService {
  /** 只读当前账号；没有注入就是配置错误，绝不回落到「当成 web」。 */
  const actorOf = async (accountId: string): Promise<Result<GrantActor, DomainError>> => {
    const actor = await deps.loadActor(accountId);
    if (!actor || actor.userId !== accountId) return err(forbidden('当前账号不可用'));
    return ok(actor);
  };

  const snapshot = async (sessionId: SessionId) => {
    const session = await deps.sessions.byId(sessionId);
    if (!session) return null;
    const task = session.taskId === null ? null : await deps.tasks.byId(session.taskId);
    return { session, task };
  };

  const isRestrictedChild = async (sessionId: SessionId): Promise<boolean> =>
    (await deps.workspaceDelegations.byExecutionSession(sessionId)) !== null;

  const childScopes = async (sessionId: SessionId, actor?: GrantActor): Promise<readonly ToolScope[]> => {
    const allowed = await deps.canReportDelegation?.(sessionId, actor);
    return allowed ? restrictedChildScopes([WORKSPACE_REPORT_SCOPE]) : restrictedChildScopes();
  };

  /**
   * 当前服务端绑定（唯一真源）。任务会话看任务项目，无任务会话看不可变来源；
   * 冲突 / 任务缺失 / 来源缺失都返回 null。这里的 projectId 之后只用于 `byKey`，
   * 不会跨项目把同会话的历史授权合并进来。
   */
  const canonicalBinding = async (sessionId: SessionId): Promise<CanonicalBinding | null> => {
    const current = await snapshot(sessionId);
    if (!current) return null;
    const { session, task } = current;
    const accountId = session.createdBy;
    if (!accountId) return null;
    if (session.taskId !== null) {
      if (!task) return null;
      if (session.originProjectId != null && session.originProjectId !== task.projectId) return null;
      return { session, task, projectId: task.projectId, accountId };
    }
    if (task !== null) return null;
    if (session.originProjectId == null) return null;
    return { session, task: null, projectId: session.originProjectId, accountId };
  };

  const sourceAllowed = async (input: ProjectSessionGrantSource): Promise<boolean> => {
    try {
      return await deps.sourceEligible(input);
    } catch {
      return false;
    }
  };

  const invalidate = async (sessionId: SessionId): Promise<Result<void, DomainError>> => {
    try {
      await deps.invalidateSessionTools(sessionId);
      return ok(undefined);
    } catch {
      return err(unavailable('无法作废旧工具令牌，授权变更未生效，请重试'));
    }
  };

  const activeProjectToolScopes = async (binding: CanonicalBinding): Promise<readonly ToolScope[]> => {
    const grant = await deps.projectSessionGrants.byKey(binding.accountId, binding.session.id, binding.projectId);
    if (!grant) return [];
    if (grant.accountId !== binding.accountId || grant.sessionId !== binding.session.id || grant.projectId !== binding.projectId) {
      return [];
    }
    if (!projectSessionGrantActive(grant, deps.now())) return [];
    return projectToolScopes(grant.scopes);
  };

  return {
    async grant(input) {
      const actor = await actorOf(input.accountId);
      if (!actor.ok) return actor;
      const current = await snapshot(input.sessionId);
      if (!current) return err(forbidden('会话不存在'));
      // 受限子会话（两种派工模式的 executionSessionId）永远不能自己拿项目授权。
      if (await isRestrictedChild(input.sessionId)) return err(forbidden('受限子会话不能获得项目授权'));

      const scopes = [...new Set(input.scopes)];
      const unknown = scopes.filter((scope) => !PROJECT_SESSION_GRANT_SCOPES.includes(scope));
      if (unknown.length > 0) return err(invalid(`未知的项目授权范围：${unknown.join('、')}`));
      if (scopes.length === 0) return err(invalid('至少勾选一项项目授权'));

      const binding = resolveProjectSessionBinding({
        actor: actor.value,
        session: current.session,
        task: current.task,
        projectId: input.projectId
      });
      if (!binding.ok) return binding;

      if (!(await sourceAllowed({
        action: 'grant',
        actor: actor.value,
        session: current.session,
        projectId: binding.value.projectId
      }))) {
        return err(forbidden('当前来源不能授予项目授权'));
      }

      // 逐项复核现有权限（task.create / project.update / …），任何一项不通过都不落库。
      for (const scope of scopes) {
        const permission = await deps.checkCurrentPermission({
          scope,
          accountId: binding.value.accountId,
          sessionId: current.session.id,
          projectId: binding.value.projectId,
          taskId: current.session.taskId
        });
        if (!permission.ok) return err(permission.error);
      }

      const existing = await deps.projectSessionGrants.byKey(
        binding.value.accountId,
        binding.value.sessionId,
        binding.value.projectId
      );
      // 首次授权时旧令牌本来就没有项目 scope；只有曾经存在过授权（撤销 / 过期 / scope 变化）才
      // 可能让旧令牌静默拿回权限，必须先作废旧令牌再写新授权。
      const mustInvalidate =
        existing !== null &&
        (!projectSessionGrantActive(existing, deps.now()) || !sameScopes(existing.scopes, scopes));
      if (mustInvalidate) {
        const invalidated = await invalidate(input.sessionId);
        if (!invalidated.ok) return invalidated;
      }

      return grantProjectSession(deps, {
        actor: actor.value,
        session: current.session,
        task: current.task,
        projectId: input.projectId,
        scopes,
        expiresAt: input.expiresAt ?? null
      });
    },

    async revoke(input) {
      const actor = await actorOf(input.accountId);
      if (!actor.ok) return actor;
      const current = await snapshot(input.sessionId);
      if (!current) return err(forbidden('会话不存在'));
      // 撤销 / 查看只看归属关系，不复核项目绑定或当前权限：任务权限没了也必须能撤权。
      if (current.session.createdBy !== input.accountId) {
        return err(forbidden('只有会话归属人才能撤销这个会话的项目授权'));
      }
      if (!(await sourceAllowed({
        action: 'revoke',
        actor: actor.value,
        session: current.session,
        projectId: input.projectId ?? null
      }))) {
        return err(forbidden('当前来源不能撤销项目授权'));
      }

      const revoked = await revokeProjectSessionGrants(deps, {
        actor: actor.value,
        sessionId: input.sessionId,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId })
      });
      if (!revoked.ok) return revoked;
      if (revoked.value.revoked > 0) {
        const invalidated = await invalidate(input.sessionId);
        if (!invalidated.ok) return invalidated;
      }
      return revoked;
    },

    async list(input) {
      const actor = await actorOf(input.accountId);
      if (!actor.ok) return actor;
      const current = await snapshot(input.sessionId);
      if (!current) return err(forbidden('会话不存在'));
      if (current.session.createdBy !== input.accountId) {
        return err(forbidden('只有会话归属人才能查看这个会话的项目授权'));
      }
      if (!(await sourceAllowed({ action: 'list', actor: actor.value, session: current.session, projectId: null }))) {
        return err(forbidden('当前来源不能查看项目授权'));
      }
      return listProjectSessionGrants(deps, { actor: actor.value, sessionId: input.sessionId });
    },

    async authorize(input) {
      // 受限子会话不继承调度 / 项目写授权：即使库里有历史授权记录、令牌里也还带着 scope，
      // 动作入口仍按 executionSessionId 拒绝（两种派工模式同一个标记）。
      if (await isRestrictedChild(input.sessionId)) return err(forbidden('受限子会话不继承项目授权'));
      const binding = await canonicalBinding(input.sessionId);
      if (!binding) return err(forbidden('会话没有可确认的项目绑定'));

      // 每次都重新读账号，并与冻结主体逐字段比对；传进来的旧 actor 不能自己证明自己。
      const loaded = await actorOf(binding.accountId);
      if (!loaded.ok) return loaded;
      if (input.actor && !sameActor(input.actor, loaded.value)) {
        return err(forbidden('当前登录主体与会话归属人不一致'));
      }
      if (!(await sourceAllowed({
        action: 'authorize',
        actor: loaded.value,
        session: binding.session,
        projectId: binding.projectId
      }))) {
        return err(forbidden('当前来源不能执行项目动作'));
      }

      const checked = await requireProjectSessionScope(deps, {
        actor: loaded.value,
        session: binding.session,
        task: binding.task,
        projectId: binding.projectId,
        scope: input.scope
      });
      if (!checked.ok) return checked;

      const permission = await deps.checkCurrentPermission({
        scope: input.scope,
        accountId: checked.value.accountId,
        sessionId: binding.session.id,
        projectId: checked.value.projectId,
        taskId: binding.session.taskId
      });
      if (!permission.ok) return err(permission.error);
      return checked;
    },

    async toolScopes(input) {
      try {
        return (await isRestrictedChild(input.session.id)) ? await childScopes(input.session.id, input.actor) : null;
      } catch {
        return restrictedChildScopes();
      }
    },

    async projectExtraScopes(input) {
      try {
        if (!input.actor) return [];
        if (await isRestrictedChild(input.session.id)) return [];
        const binding = await canonicalBinding(input.session.id);
        if (!binding) return [];
        const loaded = await actorOf(binding.accountId);
        if (!loaded.ok) return [];
        if (!sameActor(input.actor, loaded.value)) return [];
        if (!(await sourceAllowed({
          action: 'issue',
          actor: loaded.value,
          session: binding.session,
          projectId: binding.projectId
        }))) {
          return [];
        }
        return await activeProjectToolScopes(binding);
      } catch {
        return [];
      }
    },

    async toolScopeCap(session, actor) {
      try {
        if (await isRestrictedChild(session.id)) return await childScopes(session.id, actor);
        const binding = await canonicalBinding(session.id);
        // 普通会话保持默认行为：workspace:delegate 仍由令牌自身是否包含决定（交集不会凭空授予）。
        const base = [...DEFAULT_TOOL_SCOPES, WORKSPACE_DELEGATE_SCOPE];
        if (!binding) return base;
        return [...base, ...(await activeProjectToolScopes(binding))];
      } catch {
        return [];
      }
    }
  };
}
