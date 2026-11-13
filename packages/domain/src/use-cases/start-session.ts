import type { Session } from '../session.ts';
import type { DomainError } from '../errors.ts';
import { conflict } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import { setupNotReady } from '../workspace.ts';
import type { WorkerCommand } from '../ports/node-gateway.ts';
import type { Deps } from './deps.ts';

type StartCommand = Extract<WorkerCommand, { kind: 'start_session' }>;

/**
 * 拼一条 start_session 指令。派生、分叉、重新托管、倒带、迁移五处都走这里，
 * 所以「模型既是一列、也是一个可调项」这件事只在一个地方处理：
 * 会话的 model 总会并进 options.model，worker 只认 options。
 */
export function startCommand(
  session: Session & { readonly workerId: string },
  workspaceRoot: string,
  resume: StartCommand['resume'],
  inherited: Readonly<Record<string, string | boolean>> = session.options,
  branch?: StartCommand['branch']
): StartCommand {
  const options = session.model === '' ? { ...inherited } : { ...inherited, model: session.model };
  return {
    kind: 'start_session',
    sessionId: session.id,
    workerId: session.workerId,
    taskId: session.taskId,
    agentId: session.agentId,
    workspaceRoot,
    origin: session.origin,
    resume,
    options,
    ...(branch ? { branch } : {})
  };
}

/** 一条已经落库、落好机器的会话，配齐启动所需的一切。 */
export interface StartPlan {
  readonly session: Session & { readonly workerId: string };
  /** 工作目录：会话在工作空间里就是工作空间根，否则空串（Worker 自己决定）。 */
  readonly workspaceRoot: string;
  readonly resume: Extract<WorkerCommand, { kind: 'start_session' }>['resume'];
  readonly branch?: Extract<WorkerCommand, { kind: 'start_session' }>['branch'];
  /** 分叉/倒带/迁移时沿用来源会话的 options；不传就按 session.options。 */
  readonly inheritedOptions?: Readonly<Record<string, string | boolean>>;
  /**
   * 派发失败时是否把会话标成 `failed`（默认是）。
   * 重新托管（ensureHosted）传 false：它是「按需再把进程拉起来」，失败不该把一条已完成的会话改成失败态，
   * 也不影响下一次重试。
   */
  readonly markFailed?: boolean;
}

/**
 * 会话启动的唯一入口：五种来源（derive / resume / fork / rewind / continue）最后都走这里。
 *
 * 行为与旧的 startSavedSession 一致：派发失败把会话标 failed 且不托管；成功才 hosting.add。
 * 环境准备（资产/MCP/工具令牌）由 server 的 gateway 在真正下发前完成——它必须排在工具令牌之后，
 * 所以不在这里做；这里只负责把 server 回执里的环境版本统一落库（落库失败不影响启动）。
 */
export async function startSessionUseCase(
  deps: Pick<Deps, 'gateway' | 'hosting' | 'now' | 'sessions' | 'workspaces'>,
  plan: StartPlan
): Promise<Result<Session, DomainError>> {
  const { session } = plan;
  // 准备命令失败（docs/design/worktree.md §4）：目录还在但没准备好，不派发。
  // 只挡 failed；running 可能是 waitForSetup=false 的后台准备，允许会话先跑。
  if (session.workspaceId) {
    const workspace = await deps.workspaces.byId(session.workspaceId);
    if (workspace?.setup?.state === 'failed') {
      return err(conflict(setupNotReady(workspace, true) ?? '工作空间没有准备好（可以在机器页重试准备）'));
    }
  }
  const command = startCommand(
    session,
    plan.workspaceRoot,
    plan.resume,
    plan.inheritedOptions ?? session.options,
    plan.branch
  );
  const dispatched = await deps.gateway.dispatch(command);
  if (!dispatched.ok) {
    if (plan.markFailed !== false) {
      await deps.sessions.save({ ...session, status: 'failed', updatedAt: deps.now() });
    }
    return err(dispatched.error);
  }
  deps.hosting.add(session.id, session.workerId);
  const ack = dispatched.value;
  const revision = ack !== undefined && ack !== null ? ack.environmentRevision ?? null : null;
  if (revision !== null) {
    await deps.sessions.setEnvironmentRevision(session.id, revision, deps.now());
  }
  return ok(session);
}
