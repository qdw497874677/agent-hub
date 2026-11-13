import type { Session } from '../session.ts';
import type { Project } from '../project.ts';
import { defaultWorkspaceFor, locationOf } from './workspaces.ts';
import type { DomainError } from '../errors.ts';
import { notFound } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import { placeSession } from '../worker.ts';
import type { Deps } from './deps.ts';
import { startSessionUseCase } from './start-session.ts';

export async function projectOf(
  deps: Pick<Deps, 'tasks' | 'projects'>,
  session: Session
): Promise<Project | null> {
  const task = await deps.tasks.byId(session.taskId);
  return task ? deps.projects.byId(task.projectId) : null;
}

/**
 * 会话跑完就没人托管它了（worker 那边已经 dispose）。
 * 想再对它做任何事（说话、改模型），都得先把 agent 按上次的位置重新拉起来——
 * 这就是 S7.1「重开浏览器还能接着干活」。
 */
export async function ensureHosted(
  deps: Pick<Deps, 'hosting' | 'tasks' | 'projects' | 'gateway' | 'sessions' | 'workspaces' | 'now'> &
    Partial<Pick<Deps, 'toolGrants' | 'environment'>>,
  session: Session
): Promise<Result<void, DomainError>> {
  // 环境版本只比较，不在这里解释资产/MCP；算不出来就维持旧行为。
  const currentRevision = deps.environment
    ? await deps.environment.revision(session).catch(() => null)
    : null;
  const stale =
    currentRevision !== null &&
    session.environmentRevision != null &&
    currentRevision !== session.environmentRevision;
  if (deps.hosting.has(session.id)) {
    // 资产/MCP/技能变化：不在一轮中途换进程，等下一次投递前重新托管。
    // 重新托管会走 start_session(resume)，Worker 同 id 启动会先 dispose 旧进程。
    if (!stale) {
      // 托管中的进程可能已经跨过 token 的 TTL。ACP 的 MCP Authorization 只在
      // session/new|load 注入，prompt 无法热换；令牌失效时主动重新托管，
      // 让 start_session 重新签发并下发。
      const grant = deps.toolGrants ? await deps.toolGrants.activeForSession(session.id, deps.now()) : null;
      if (!deps.toolGrants || grant !== null) return ok(undefined);
    }
    deps.hosting.drop(session.id);
  }
  const project = await projectOf(deps, session);
  if (!project) return err(notFound('会话所属任务或项目不存在'));
  // resume 必须回到原来那台：agent 的会话文件只在那台机器上。
  // 老会话（多机之前建的）没有落点，这里补落一次并记下来，以后就钉在那台上了。
  let placed: Session & { readonly workerId: string };
  if (session.workerId !== null) {
    placed = { ...session, workerId: session.workerId };
  } else {
    const where = await locationOf(deps, project, session);
    const chosen = placeSession(await deps.gateway.status(), {
      agentId: session.agentId,
      requested: null,
      projectWorker: where.workerId,
      model: session.model
    });
    if (!chosen.ok) return chosen;
    placed = { ...session, workerId: chosen.value };
    await deps.sessions.save(placed);
  }
  // 迁移前的老会话：补上它一直在用的那个工作空间（同一个目录），以后就按工作空间走。
  if (placed.workspaceId === null) {
    const linked = await defaultWorkspaceFor(deps, project.id);
    if (linked) {
      placed = { ...placed, workspaceId: linked.id };
      await deps.sessions.save(placed);
    }
  }
  const { root } = await locationOf(deps, project, placed);
  const started = await startSessionUseCase(deps, {
    session: placed,
    workspaceRoot: root,
    resume: { agentSessionRef: session.agentSessionRef, cursor: session.lastSeq },
    // 重新托管失败不改写状态：会话可能早就 done，只是这次拉不起来，下一次还能重试。
    markFailed: false
  });
  // 环境版本由启动入口按 server 回执统一落库：失败时保留旧值，下一次还能重试。
  return started.ok ? ok(undefined) : err(started.error);
}


