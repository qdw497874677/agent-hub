import type { ProjectId, SessionId } from './ids.ts';
import type { Session } from './session.ts';
import type { Task } from './task.ts';
import {
  PROJECT_ASSET_WRITE_TOOL_SCOPE,
  PROJECT_CANDIDATE_IMPORT_TOOL_SCOPE,
  PROJECT_MESSAGE_SEND_TOOL_SCOPE,
  PROJECT_READ_TOOL_SCOPE,
  PROJECT_TASK_WRITE_TOOL_SCOPE,
  PROJECT_WORKTREE_OPEN_TOOL_SCOPE,
  type GrantActor,
  type ToolScope
} from './tool.ts';
import { forbidden, invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';
import { newId } from './ids.ts';

/**
 * 项目会话的显式授权（docs/design/project-session-mcp.md §25-§31）。
 *
 * 普通任务会话默认只能读写自己任务；要在某个项目里直接建任务、写资产、开 worktree、发消息，
 * 必须由**会话归属人**在网页上逐项勾选。默认全关；提示词、资产文本、工具输出都不能打开权限。
 * 授权按 (账号, 会话, 项目) 持久化，每次动作都重新核对当前会话绑定与撤销状态。
 */
export type ProjectSessionGrantScope = 'project:read' | 'task:write' | 'asset:write' | 'worktree:open' | 'message:send' | 'candidate:import';

export const PROJECT_SESSION_GRANT_SCOPES: readonly ProjectSessionGrantScope[] = [
  'project:read',
  'task:write',
  'asset:write',
  'worktree:open',
  'message:send',
  'candidate:import'
];

const TOOL_SCOPE_BY_GRANT_SCOPE: Readonly<Record<ProjectSessionGrantScope, ToolScope>> = {
  'project:read': PROJECT_READ_TOOL_SCOPE,
  'task:write': PROJECT_TASK_WRITE_TOOL_SCOPE,
  'asset:write': PROJECT_ASSET_WRITE_TOOL_SCOPE,
  'worktree:open': PROJECT_WORKTREE_OPEN_TOOL_SCOPE,
  'message:send': PROJECT_MESSAGE_SEND_TOOL_SCOPE,
  'candidate:import': PROJECT_CANDIDATE_IMPORT_TOOL_SCOPE
};

/** 项目授权项 → 对应工具 scope（父层注入 provider 时用同一份映射，避免两处漂移）。 */
export function projectToolScope(scope: ProjectSessionGrantScope): ToolScope {
  return TOOL_SCOPE_BY_GRANT_SCOPE[scope];
}

export function projectToolScopes(scopes: readonly ProjectSessionGrantScope[]): readonly ToolScope[] {
  return [...new Set(scopes.map(projectToolScope))];
}

export function projectGrantScopeOf(scope: ToolScope): ProjectSessionGrantScope | null {
  for (const [grantScope, toolScope] of Object.entries(TOOL_SCOPE_BY_GRANT_SCOPE)) {
    if (toolScope === scope) return grantScope as ProjectSessionGrantScope;
  }
  return null;
}

/** 一条显式项目授权。`accountId` 永远是会话归属人，不是发起请求的 bot / 群。 */
export interface ProjectSessionGrant {
  readonly id: string;
  readonly accountId: string;
  readonly sessionId: SessionId;
  readonly projectId: ProjectId;
  readonly scopes: readonly ProjectSessionGrantScope[];
  /** 授权人（= accountId）；保留字段便于审计与迁移。 */
  readonly createdBy: string;
  readonly createdAt: number;
  /** null = 直到撤销；有值则过期即失效。 */
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
  readonly revokedBy: string | null;
}

export function projectSessionGrantActive(grant: ProjectSessionGrant, now: number): boolean {
  return grant.revokedAt === null && (grant.expiresAt === null || now < grant.expiresAt);
}

export interface ProjectSessionGrantRepository {
  /** 同一 (账号, 会话, 项目) 只有一条；再次授权替换 scope、有效期并清除撤销。 */
  save(grant: ProjectSessionGrant): Promise<ProjectSessionGrant>;
  byKey(accountId: string, sessionId: SessionId, projectId: ProjectId): Promise<ProjectSessionGrant | null>;
  byId(id: string): Promise<ProjectSessionGrant | null>;
  listBySession(sessionId: SessionId): Promise<readonly ProjectSessionGrant[]>;
  listByAccount(accountId: string): Promise<readonly ProjectSessionGrant[]>;
  /** 撤销一条；返回是否确实改了（已撤销过返回 false）。 */
  revoke(id: string, at: number, by: string): Promise<boolean>;
  /** 撤销这个账号在这条会话下的全部授权；返回条数。 */
  revokeSession(accountId: string, sessionId: SessionId, at: number, by: string): Promise<number>;
}

export interface ProjectSessionGrantDeps {
  readonly now: () => number;
  readonly projectSessionGrants: ProjectSessionGrantRepository;
}

/** 当前人类主体：必须是真人网页会话，且 userId 就是会话归属人。 */
export function humanAccountOf(actor?: GrantActor): Result<string, DomainError> {
  if (!actor?.userId) return err(forbidden('项目授权必须由登录账号发起'));
  if (actor.via !== 'web') return err(forbidden('项目授权只能由真人登录会话发起'));
  return ok(actor.userId);
}

export interface ProjectSessionBindingInput {
  readonly actor?: GrantActor;
  readonly session: Pick<Session, 'id' | 'taskId' | 'originProjectId' | 'createdBy'>;
  /** 任务会话必须给出当前任务；无任务会话必须为 null。 */
  readonly task: Pick<Task, 'projectId'> | null;
  /** 本次授权 / 操作针对的项目；必须与会话服务端绑定一致，绝不反向推断。 */
  readonly projectId: ProjectId;
}

export interface ProjectSessionBinding {
  readonly accountId: string;
  readonly sessionId: SessionId;
  readonly projectId: ProjectId;
}

/**
 * 服务端绑定项目（§27）：
 * - 任务会话核对任务项目；
 * - 无任务会话核对不可变来源；
 * - 两者同时存在但冲突 → 拒绝；
 * - 归属人、会话、项目任一不明确 → 拒绝。
 */
export function resolveProjectSessionBinding(
  input: ProjectSessionBindingInput
): Result<ProjectSessionBinding, DomainError> {
  const account = humanAccountOf(input.actor);
  if (!account.ok) return account;
  if (input.session.createdBy == null) return err(forbidden('会话没有可确认的归属人'));
  if (input.session.createdBy !== account.value) return err(forbidden('当前登录账号不是会话归属人'));

  if (input.session.taskId !== null) {
    if (!input.task) return err(forbidden('会话的任务不存在，无法确认项目'));
    if (input.session.originProjectId != null && input.session.originProjectId !== input.task.projectId) {
      return err(forbidden('会话的项目来源与任务项目冲突'));
    }
    if (input.projectId !== input.task.projectId) return err(forbidden('请求的项目与会话任务不一致'));
    return ok({ accountId: account.value, sessionId: input.session.id, projectId: input.task.projectId });
  }

  if (input.task !== null) return err(forbidden('无任务会话不能绑定任务'));
  if (input.session.originProjectId == null) return err(forbidden('无任务会话没有不可变的项目来源'));
  if (input.projectId !== input.session.originProjectId) {
    return err(forbidden('请求的项目与会话来源不一致'));
  }
  return ok({ accountId: account.value, sessionId: input.session.id, projectId: input.session.originProjectId });
}

export interface ProjectSessionGrantInput extends ProjectSessionBindingInput {
  readonly scopes: readonly ProjectSessionGrantScope[];
  readonly expiresAt?: number | null;
}

/** 授予 / 替换显式项目授权（只能由真人网页请求调用，工具侧没有入口）。 */
export async function grantProjectSession(
  deps: ProjectSessionGrantDeps,
  input: ProjectSessionGrantInput
): Promise<Result<ProjectSessionGrant, DomainError>> {
  const binding = resolveProjectSessionBinding(input);
  if (!binding.ok) return binding;

  const scopes = [...new Set(input.scopes)];
  const unknown = scopes.filter((scope) => !PROJECT_SESSION_GRANT_SCOPES.includes(scope));
  if (unknown.length > 0) return err(invalid(`未知的项目授权范围：${unknown.join('、')}`));
  if (scopes.length === 0) return err(invalid('至少勾选一项项目授权'));

  const now = deps.now();
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && !(expiresAt > now)) return err(invalid('项目授权的过期时间必须晚于现在'));

  return ok(
    await deps.projectSessionGrants.save({
      id: newId(),
      accountId: binding.value.accountId,
      sessionId: binding.value.sessionId,
      projectId: binding.value.projectId,
      scopes,
      createdBy: binding.value.accountId,
      createdAt: now,
      expiresAt,
      revokedAt: null,
      revokedBy: null
    })
  );
}

/**
 * 按**当前**绑定读取有效授权。撤销、过期、项目漂移、账号/会话不一致都返回 forbidden；
 * 没有记录同样拒绝（默认关闭），绝不回落到「普通任务会话的隐式权限」。
 */
export async function checkProjectSessionGrant(
  deps: ProjectSessionGrantDeps,
  input: ProjectSessionBindingInput
): Promise<Result<ProjectSessionGrant, DomainError>> {
  const binding = resolveProjectSessionBinding(input);
  if (!binding.ok) return binding;

  const grant = await deps.projectSessionGrants.byKey(
    binding.value.accountId,
    binding.value.sessionId,
    binding.value.projectId
  );
  if (!grant) return err(forbidden('这个会话没有该项目的显式授权'));
  if (
    grant.accountId !== binding.value.accountId ||
    grant.sessionId !== binding.value.sessionId ||
    grant.projectId !== binding.value.projectId
  ) {
    return err(forbidden('项目授权与会话当前绑定不一致'));
  }
  if (!projectSessionGrantActive(grant, deps.now())) return err(forbidden('项目授权已撤销或已过期'));
  return ok(grant);
}

/** 在有效授权里再核对单项能力；供工具 provider / HTTP 动作入口共用。 */
export async function requireProjectSessionScope(
  deps: ProjectSessionGrantDeps,
  input: ProjectSessionBindingInput & { readonly scope: ProjectSessionGrantScope }
): Promise<Result<ProjectSessionGrant, DomainError>> {
  const checked = await checkProjectSessionGrant(deps, input);
  if (!checked.ok) return checked;
  if (!checked.value.scopes.includes(input.scope)) {
    return err(forbidden(`项目授权里没有 ${input.scope} 权限`));
  }
  return checked;
}

export interface RevokeProjectSessionGrantsInput {
  readonly actor?: GrantActor;
  readonly sessionId: SessionId;
  /** 省略 = 撤销这条会话下该账号的全部项目授权。 */
  readonly projectId?: ProjectId;
}

/**
 * 归属人撤销。刻意不复核项目绑定：即使项目漂移 / 来源已不可确认，主人也必须能撤权。
 */
export async function revokeProjectSessionGrants(
  deps: ProjectSessionGrantDeps,
  input: RevokeProjectSessionGrantsInput
): Promise<Result<{ readonly revoked: number }, DomainError>> {
  const account = humanAccountOf(input.actor);
  if (!account.ok) return account;

  const grants = await deps.projectSessionGrants.listBySession(input.sessionId);
  const owned = grants.filter(
    (grant) => grant.accountId === account.value && (input.projectId === undefined || grant.projectId === input.projectId)
  );
  if (owned.length === 0) return err(forbidden('只有会话归属人才能撤销这个会话的项目授权'));

  const now = deps.now();
  let revoked = 0;
  for (const grant of owned) {
    if (await deps.projectSessionGrants.revoke(grant.id, now, account.value)) revoked += 1;
  }
  return ok({ revoked });
}

/** 归属人查看自己在这条会话上的项目授权（包含已撤销 / 已过期，便于界面展示状态）。 */
export async function listProjectSessionGrants(
  deps: ProjectSessionGrantDeps,
  input: { readonly actor?: GrantActor; readonly sessionId: SessionId }
): Promise<Result<readonly ProjectSessionGrant[], DomainError>> {
  const account = humanAccountOf(input.actor);
  if (!account.ok) return account;
  const grants = await deps.projectSessionGrants.listBySession(input.sessionId);
  return ok(grants.filter((grant) => grant.accountId === account.value));
}
