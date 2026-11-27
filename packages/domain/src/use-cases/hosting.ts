import type { Session } from '../session.ts';
import { defaultWorkspaceFor, locationOf, projectOfSession } from './workspaces.ts';
import type { DomainError } from '../errors.ts';
import { conflict, notFound } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import { placeSession } from '../worker.ts';
import type { Deps } from './deps.ts';
import { startSessionUseCase } from './start-session.ts';
import { withActiveTask } from './task-admission.ts';
import { admitBranchSession } from './branch-admission.ts';
import { handoffFirstEnded, handoffRecord } from './handoff-admission.ts';
import { groupReady, primaryMember } from '../workspace-group.ts';
import { isUsable, setupNotReady } from '../workspace.ts';

/** Verify persisted planned placement before any legacy resume/fork can fall back to another directory. */
export async function admitPlannedPlacement(
  deps: Pick<Deps, 'workspaces'> & Partial<Pick<Deps, 'workspaceGroups' | 'plannedWorktreeGuard'>>,
  session: Pick<Session, 'workspaceId' | 'groupId' | 'taskId' | 'workerId'>,
  options: { readonly verify?: boolean } = {}
): Promise<Result<void, DomainError>> {
  const guard = deps.plannedWorktreeGuard;
  if (!guard) return ok(undefined);
  const output = session.workspaceId ? guard.forOutput(session.workspaceId) : null;
  const group = session.groupId ? await deps.workspaceGroups?.byId(session.groupId) : null;
  const plannedGroup = !!(session.groupId && (guard.isGroupProtected(session.groupId) || group?.primaryWorkspaceId || output?.groupId));
  if (!output && !plannedGroup) return ok(undefined);
  if (!session.workspaceId || !session.taskId || !output) return err(conflict('无法验证计划工作空间的会话落点'));
  if (output.state !== 'ready-unused' && output.state !== 'closed') return err(conflict('工作空间计划尚未就绪'));
  const workspace = await deps.workspaces.byId(session.workspaceId);
  if (!workspace || workspace.ownerTaskId !== session.taskId || !isUsable(workspace) ||
      (workspace.workerId !== null && workspace.workerId !== session.workerId)) return err(conflict('计划工作空间不属于当前任务或落点不可用'));
  if (!output.groupId) {
    if (session.groupId || workspace.groupId) return err(conflict('计划工作空间的组合落点不匹配'));
    if (options.verify === false) return ok(undefined);
    if (!guard.verifyOutput) return err(conflict('无法验证计划工作空间的实际检出'));
    return guard.verifyOutput(workspace.id);
  }
  if (!group || session.groupId !== output.groupId || group.id !== output.groupId || !groupReady(group) ||
      group.ownerTaskId !== session.taskId || primaryMember(group)?.workspaceId !== workspace.id ||
      (group.workerId !== null && group.workerId !== session.workerId)) return err(conflict('计划组合落点不匹配或尚未就绪'));
  for (const member of group.members) {
    const plan = guard.forOutput(member.workspaceId);
    const item = await deps.workspaces.byId(member.workspaceId);
    if (!plan || plan.groupId !== group.id || (plan.state !== 'ready-unused' && plan.state !== 'closed') ||
        !item || item.ownerTaskId !== session.taskId || item.groupId !== group.id || !isUsable(item) || item.workerId !== group.workerId) {
      return err(conflict('计划组合成员不属于当前任务或尚未就绪'));
    }
  }
  if (options.verify === false) return ok(undefined);
  if (!guard.verifyOutput) return err(conflict('无法验证计划工作空间的实际检出'));
  for (const member of group.members) {
    const verified = await guard.verifyOutput(member.workspaceId);
    if (!verified.ok) return verified;
  }
  return ok(undefined);
}


/**
 * 会话跑完就没人托管它了（worker 那边已经 dispose）。
 * 想再对它做任何事（说话、改模型），都得先把 agent 按上次的位置重新拉起来——
 * 这就是 S7.1「重开浏览器还能接着干活」。
 */
export async function ensureHosted(
  deps: Pick<Deps, 'hosting' | 'tasks' | 'taskGate' | 'projects' | 'gateway' | 'sessions' | 'workspaces' | 'bots' | 'workspaceGroups' | 'now'> &
    Partial<Pick<Deps, 'toolGrants' | 'environment' | 'branchAttempts' | 'agentHandoffs' | 'deliveries' | 'plannedWorktreeGuard'>>,
  session: Session,
  options: { readonly requireFresh?: boolean } = {}
): Promise<Result<void, DomainError>> {
  const handoff = await handoffRecord(deps, session.id);
  if (!handoff.ok) return handoff;
  if (handoff.value && !(await handoffFirstEnded(deps, handoff.value))) return err(conflict('交接首轮尚未完成，不能重新托管'));
  const admitted = await admitBranchSession(deps, session.id);
  if (!admitted.ok) return admitted;
  const current = admitted.value ?? session;
  return withActiveTask(deps, current.taskId, () => ensureHostedAdmitted(deps, current, options));
}

async function ensureHostedAdmitted(
  deps: Pick<Deps, 'hosting' | 'tasks' | 'projects' | 'gateway' | 'sessions' | 'workspaces' | 'bots' | 'workspaceGroups' | 'now'> &
    Partial<Pick<Deps, 'toolGrants' | 'environment' | 'plannedWorktreeGuard'>>,
  session: Session,
  options: { readonly requireFresh?: boolean }
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
    if (!stale && !options.requireFresh) {
      // 托管中的进程可能已经跨过 token 的 TTL。ACP 的 MCP Authorization 只在
      // session/new|load 注入，prompt 无法热换；令牌失效时主动重新托管，
      // 让 start_session 重新签发并下发。
      const grant = deps.toolGrants ? await deps.toolGrants.activeForSession(session.id, deps.now()) : null;
      if (!deps.toolGrants || grant !== null) return admitPlannedPlacement(deps, session, { verify: false });
    }
  }
  const admission = await admitPlannedPlacement(deps, session);
  if (!admission.ok) return admission;
  if (deps.hosting.has(session.id)) deps.hosting.drop(session.id);
  const project = await projectOfSession(deps, session);
  if (!project) return err(notFound('会话所属任务或项目不存在'));
  if (session.workspaceId && deps.plannedWorktreeGuard?.forOutput(session.workspaceId)) {
    const group = session.groupId ? await deps.workspaceGroups.byId(session.groupId) : null;
    const ids = group ? group.members.map((member) => member.workspaceId) : [session.workspaceId];
    for (const id of ids) {
      const workspace = await deps.workspaces.byId(id);
      if (!workspace) return err(conflict('无法验证计划工作空间的准备状态'));
      const blocked = setupNotReady(workspace, project.worktree?.setup?.waitForSetup ?? true);
      if (blocked) return err(conflict(blocked));
    }
  }
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
      const linkedAdmission = await admitPlannedPlacement(deps, placed);
      if (!linkedAdmission.ok) return linkedAdmission;
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
  if (started.ok && placed.workspaceId && deps.plannedWorktreeGuard?.forOutput(placed.workspaceId)) deps.plannedWorktreeGuard.noteStarted(placed.workspaceId);
  // 环境版本由启动入口按 server 回执统一落库：失败时保留旧值，下一次还能重试。
  return started.ok ? ok(undefined) : err(started.error);
}
