import {
  createTaskUseCase,
  deriveSessionUseCase,
  recordProvenance,
  withAccess,
  type Deps,
  type LoginId,
  type Principal,
  type ProvenanceVia,
  type Session,
  type Subject,
  type UserId,
  type UserRepository
} from '@agent-hub/domain';
import type { AccessRepos, ProvenanceDeps } from '@agent-hub/domain';
import type { DomainError, Result } from '@agent-hub/domain';

/**
 * 停用或已删除的账号不能再当会话发起人。loginId 只区分审计来源，规则相同。
 * 用 Date.now()，不跟 deps.now 走：原来几处都是这样。
 */
export async function loadActor(
  users: UserRepository,
  access: AccessRepos | undefined,
  userId: string,
  loginId: string
): Promise<Principal | null> {
  const user = await users.byId(userId as UserId);
  if (!user || user.disabledAt !== null || user.deletedAt !== null) return null;
  return withAccess(access, { user, loginId: loginId as LoginId }, Date.now());
}

/**
 * bot 会话：建任务、派生、可选的派生记录、再写来历。
 * 连接器要先 saveSpawn 再写来历；P2P / 群没有这一步。via 仍由调用方给（bot 或 group）。
 * 任务或派生失败原样返回，不写来历、不写派生记录。
 */
export async function openRoleSession(
  deps: Pick<Deps, 'agents' | 'gateway' | 'hosting' | 'now' | 'projects' | 'sessions' | 'tasks' | 'workLog' | 'workspaces' | 'access'>,
  provenance: ProvenanceDeps,
  input: {
    readonly projectId: string;
    readonly title: string;
    readonly ownerId: string;
    readonly agentId: string;
    readonly model: string;
    /** bot 配的启动选项：建会话时垫进去（会话内仍可覆盖）。 */
    readonly options?: Readonly<Record<string, string | boolean>>;
    readonly actor: Subject;
    readonly via: ProvenanceVia;
    readonly afterDerive?: (session: Session) => Promise<void>;
  }
): Promise<Result<Session, DomainError>> {
  const task = await createTaskUseCase(deps, { projectId: input.projectId, title: input.title, ownerId: input.ownerId });
  if (!task.ok) return task;
  const created = await deriveSessionUseCase(deps, {
    taskId: task.value.id,
    agentId: input.agentId,
    model: input.model,
    ...(input.options ? { options: input.options } : {}),
    actor: input.actor
  });
  if (!created.ok) return created;
  await input.afterDerive?.(created.value);
  await recordProvenance(provenance, { session: created.value, subject: input.actor, via: input.via }).catch(() => undefined);
  return created;
}
