import {
  err,
  forbidden,
  ok,
  type DomainError,
  type ProvenanceStore,
  type Result,
  type SessionId,
  type SessionRepository,
  type Subject,
  type TaskDispatchStore,
  type ToolContext,
  type WorkspaceDelegationStore
} from '@agent-hub/domain';

/**
 * #217 HIGH：git 写工具（commit / push / PR）的身份闸。
 *
 * bot / 群聊 / 连接器 / 调度器会话都没有「当轮人类」身份；它们只能靠冻结的
 * createdBy / 任务 owner 冒充人类（GrantActor 也是签发时冻的）。这些写入失败必须
 * 关闭，而不是回落到那些字段。判据全部来自服务端持久上下文：
 *
 * - sessions.bot_id（新会话）
 * - createBotOfSession 的兼容反查（老会话的 spawn / 群成员）
 * - agent_spawns / 群成员映射（botOfSession 解析不出来的兜底）
 * - SessionProvenance.via = bot / group，或非人类的 actor
 * - TaskDispatch.bySession（调度器 / 外部连接器派生的任务会话）
 * - workspace_delegations.byExecutionSession（持久派工预留的执行会话）
 *
 * 普通用户会话（没有以上标记）继续走原来的 subjectOf；找不到账号也拒绝。
 */
export interface GitWriteIdentityDeps {
  readonly sessions: Pick<SessionRepository, 'byId'>;
  readonly botOfSession: (sessionId: SessionId) => Promise<{ readonly botId: string | null } | null>;
  readonly spawnOf: (sessionId: SessionId) => Promise<{ readonly role: string } | null>;
  readonly memberOfSession: (sessionId: SessionId) => Promise<{ readonly role: string } | null>;
  readonly provenance: Pick<ProvenanceStore, 'get'>;
  readonly dispatches: Pick<TaskDispatchStore, 'bySession'>;
  /** 持久派工的执行会话身份（durable，不依赖冻结的 actor）。 */
  readonly delegations: Pick<WorkspaceDelegationStore, 'byExecutionSession'>;
  readonly subjectOf: (sessionId: SessionId) => Promise<Subject | null>;
}

const SHARED_DENIED = 'bot/群聊/连接器会话没有可验证的当轮人类身份：git commit/push/PR 已关闭；请让人类在自己的会话里操作';
const DELEGATED_DENIED = '派工执行会话没有平台 Git 写权限：本地改动由人确认后发布，commit/push/PR 已关闭';

export function createGitWriteSubjectOf(deps: GitWriteIdentityDeps) {
  return async (sessionId: SessionId, ctx: ToolContext): Promise<Result<Subject, DomainError>> => {
    const session = await deps.sessions.byId(sessionId);
    if (!session) return err(forbidden('找不到这条会话，git 写入已关闭'));

    // 派工执行会话：先看持久派工记录，再谈任何冻结 actor / owner / subject 回落。
    if (await deps.delegations.byExecutionSession(sessionId)) return err(forbidden(DELEGATED_DENIED));

    // 共享来源：不信任冻结的 grant.actor，也不回落到 createdBy / 任务 owner。
    if (session.botId != null) return err(forbidden(SHARED_DENIED));
    if (await deps.botOfSession(sessionId)) return err(forbidden(SHARED_DENIED));
    // botOfSession 在项目归属解析失败时会提前返回 null；这两条兼容映射直接兜底。
    if (await deps.spawnOf(sessionId)) return err(forbidden(SHARED_DENIED));
    if (await deps.memberOfSession(sessionId)) return err(forbidden(SHARED_DENIED));

    const provenance = await deps.provenance.get(sessionId);
    if (provenance?.via === 'bot' || provenance?.via === 'group') return err(forbidden(SHARED_DENIED));
    if (provenance && !provenance.backfilled && provenance.actor.kind !== 'user' && provenance.actor.kind !== 'api_token') {
      return err(forbidden('这条会话的来历不是人类账号，git 写入已关闭'));
    }

    // 有调度记录 = 调度器替 bot 起跑的任务会话（连接器来源只是其中一种）。
    if (await deps.dispatches.bySession(sessionId)) return err(forbidden(SHARED_DENIED));

    // 防御性兜底：旧授权若明确记了 bot/群/连接器/调度来源，同样不放行。
    const via = ctx.grant.actor?.via;
    if (via === 'bot' || via === 'group' || via === 'connector' || via === 'dispatch') return err(forbidden(SHARED_DENIED));
    // 授权里明确没有人类账号时也不回落到 createdBy / 任务 owner。
    if (ctx.grant.actor && ctx.grant.actor.userId === null) return err(forbidden(SHARED_DENIED));

    const subject = await deps.subjectOf(sessionId);
    if (!subject) return err(forbidden('这条会话找不到可验证的账号，git 写入已关闭'));
    return ok(subject);
  };
}
