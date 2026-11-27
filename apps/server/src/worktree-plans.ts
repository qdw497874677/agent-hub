import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import {
  asProjectId, asTaskId, asWorkspaceGroupId, asWorkspaceId, authorizeProject, authorizeWorker,
  conflict, designatedPrimaryRepo, err, forbidden, invalid, isSystem, isUsable, newWorkspace, newWorkspaceId,
  notFound, ok, unavailable, withActiveTask, WORKSPACE_GROUP_NAME, WORKSPACE_GROUP_MEMBERS_MAX,
  type Deps, type DomainError, type PlannedWorktree, type PlannedWorktreeGuard, type PlannedWorktreeInspection,
  type PlannedWorktreeStore, type Principal, type Project, type ProjectRepo, type ProjectSetup, type Result,
  type Subject, type Workspace, type WorkspaceGroup, type PlannedWorktreeCreateInput
} from '@agent-hub/domain';

export interface WorktreePreview {
  workerId: string;
  source: 'local' | 'project';
  members: { id: string; startRef?: string; baseWorkspaceId?: string }[];
  primaryId?: string;
  runSetup?: boolean;
}
type Shape = Pick<PlannedWorktreeInspection, 'topLevel' | 'commonDir' | 'managedRoot' | 'oid' | 'identity'>;
type Member = {
  id: string; name: string; sourceId: string | null; sourcePath: string | null;
  baseId: string; basePath: string; base: Shape | null; linkedBaseIdentity: string | null; repoHash: string | null;
  targetPath: string; outputId: string; branch: string; startRef: string | null; oid: string; expectedOriginUrl: string | null;
};
export type WorktreePlanSpec = {
  source: WorktreePreview['source']; primaryId: string; members: Member[]; groupId: string | null;
  groupRoot: string | null; setupHash: string | null;
};
type Step = 'pending' | 'ready' | 'failed' | 'unknown';
type MemberProgress = { base: Shape | null; baseStep: Step; state: Step; problem: string | null };
export type WorktreePlanProgress = { members: MemberProgress[]; setupState: 'skipped' | 'pending' | 'running' | 'failed' | 'unknown' | 'ready'; problem: string | null };
type Row = PlannedWorktree<WorktreePlanSpec, WorktreePlanProgress>;
type Store = PlannedWorktreeStore<WorktreePlanSpec, WorktreePlanProgress>;
type PlanDeps = Pick<Deps, 'projects' | 'tasks' | 'taskGate' | 'workspaces' | 'workspaceGroups' | 'gateway' | 'now' | 'access' | 'workdirSafety'>;
type Access = { actor: Principal; project: Project; git: ReturnType<Deps['gateway']['git']> };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const repoHash = (repo: ProjectRepo) => digest([repo.id, repo.url, repo.name, repo.defaultBranch]);
const setupHash = (setup: ProjectSetup) => digest([setup.command, setup.timeoutSeconds, setup.waitForSetup]);
const primary = (row: Row) => row.plan.members.find((member) => member.id === row.plan.primaryId)!;
function oneRepo(project: Project, id: string): ProjectRepo | null {
  const rows = project.repos.filter((repo) => repo.id === id);
  return rows.length === 1 ? rows[0]! : null;
}
function sameShape(a: Shape, b: Shape): boolean {
  return a.topLevel === b.topLevel && a.commonDir === b.commonDir && a.oid === b.oid && a.managedRoot === b.managedRoot && a.identity === b.identity;
}

function checkoutInput(row: Row, index: number): PlannedWorktreeCreateInput | null {
  const member = row.plan.members[index];
  const base = row.progress.members[index]?.base;
  if (!member || !base || (row.plan.source === 'project' && !member.expectedOriginUrl)) return null;
  return { sourcePath: member.sourcePath ?? member.basePath,
    expectedTopLevel: base.topLevel, expectedCommonDir: base.commonDir, expectedIdentity: base.identity, expectedOid: member.oid,
    startRef: member.sourceId ? member.startRef : null, targetPath: member.targetPath, branch: member.branch, operationId: `${row.id}-${index}`,
    ...(member.expectedOriginUrl ? { expectedOriginUrl: member.expectedOriginUrl } : {}) };
}

/** The journal links output identities even after first use; never infer plan ownership from a path. */
export function plannedWorktreeGuard(store: Store, gitFor: (workerId: string) => ReturnType<Deps['gateway']['git']>): PlannedWorktreeGuard {
  const output = (id: string) => store.byWorkspaceId(id).find((row) => row.state !== 'draft' && row.state !== 'failed' && row.plan.members.some((member) => member.outputId === id));
  return {
    isWorkspaceProtected: (id) => store.isWorkspaceProtected(id),
    isGroupProtected: (id) => store.isGroupProtected(id),
    forOutput(id) {
      const row = output(id);
      return row && row.state !== 'failed' ? { source: row.plan.source, state: row.state, groupId: row.plan.groupId } : null;
    },
    async verifyOutput(id) {
      const row = output(id);
      if (!row || (row.state !== 'ready-unused' && row.state !== 'closed')) return err(conflict('无法确认计划工作目录'));
      const index = row.plan.members.findIndex((member) => member.outputId === id);
      const target = checkoutInput(row, index);
      if (!target) return err(conflict('无法确认计划工作目录'));
      const git = gitFor(row.workerId);
      if (!git.verifyPlannedWorktree) return err(unavailable('当前机器不能核验计划工作目录，请检查机器状态和版本'));
      const proof = await git.verifyPlannedWorktree(target);
      return proof.ok && proof.value.path === target.targetPath && proof.value.oid === target.expectedOid && proof.value.branch === target.branch ?
        ok(undefined) : err(conflict('工作目录或 Git 注册已改变，无法安全启动会话'));
    },
    noteStarted(id) {
      const row = output(id);
      if (row?.state === 'ready-unused') store.compareAndSet(row.id, row.revision, { ...row, state: 'closed' });
    }
  };
}

export function createWorktreePlans(input: {
  deps: PlanDeps; store: Store;
  allowRemoteBase?: boolean;
  refreshActor: (actor: Principal) => Promise<Principal | null>;
  authForRepo: (project: Project, repo: ProjectRepo) => Promise<Result<import('@agent-hub/domain').GitAuth | null, DomainError>>;
}) {
  const { deps, store } = input;
  const inFlight = new Set<string>();

  async function projectTask(subject: Subject | null, projectId: string, taskId: string, write: boolean) {
    if (!subject || isSystem(subject) || subject.via) return err(forbidden('请以网页登录账号操作 Worktree'));
    const actor = await input.refreshActor(subject);
    if (!actor) return err(forbidden('登录或权限已失效，请重新登录'));
    const project = await authorizeProject(deps.access, actor, await deps.projects.byId(asProjectId(projectId)), write ? 'session.create' : 'task.read');
    if (!project.ok) return project;
    const task = await deps.tasks.byId(asTaskId(taskId));
    if (!task || task.projectId !== project.value.id) return err(notFound('任务不存在'));
    if (write && task.archivedAt != null) return err(conflict('任务已归档，请恢复后再继续'));
    return ok({ actor, project: project.value });
  }

  async function access(subject: Subject | null, projectId: string, taskId: string, workerId: string, write: boolean): Promise<Result<Access, DomainError>> {
    const allowed = await projectTask(subject, projectId, taskId, write);
    if (!allowed.ok) return allowed;
    const worker = await authorizeWorker(deps.access, allowed.value.actor, workerId);
    if (!worker.ok) return worker;
    return ok({ ...allowed.value, git: deps.gateway.git(workerId) });
  }

  async function allowSources(context: Access, remote = false): Promise<Result<void, DomainError>> {
    const files = await authorizeProject(deps.access, context.actor, context.project, 'workspace.files.read');
    if (!files.ok) return files;
    if (remote) {
      const write = await authorizeProject(deps.access, context.actor, context.project, 'project.update');
      if (!write.ok) return write;
    }
    return ok(undefined);
  }

  async function sources(project: Project, taskId: string, workerId: string): Promise<Workspace[]> {
    // Null is a legacy local marker, never a generic cross-worker match.
    const localId = (await deps.gateway.status()).find((worker) => worker.origin === 'local')?.workerId;
    return (await deps.workspaces.byProject(project.id)).filter((item) => isUsable(item) && item.isGit !== false &&
      (item.workerId ?? localId) === workerId && (item.kind === 'long_lived' || item.ownerTaskId === taskId));
  }

  async function inspectRef(git: Access['git'], path: string, startRef: string | null, expectedOriginUrl?: string) {
    const inspect = git.inspectPlannedWorktree;
    if (!inspect) return err(unavailable('这台机器尚不支持 Worktree 计划'));
    return inspect({ sourcePath: path, startRef, ...(expectedOriginUrl === undefined ? {} : { expectedOriginUrl }) });
  }

  async function localStart(git: Access['git'], path: string, ref: string | null, expectedOriginUrl?: string) {
    if (ref === null || ref.startsWith('refs/')) {
      const found = await inspectRef(git, path, ref, expectedOriginUrl);
      return found.ok ? ok({ ref, found: found.value }) : found;
    }
    const names = [`refs/heads/${ref}`, `refs/remotes/origin/${ref}`];
    const hits: { ref: string; found: Shape }[] = [];
    for (const name of names) {
      const found = await inspectRef(git, path, name, expectedOriginUrl);
      if (found.ok) hits.push({ ref: name, found: found.value });
      else if (found.error.code !== 'invalid' && found.error.code !== 'not_found') return found;
    }
    if (hits.length === 0) return err(invalid('本地没有该起点，请选择已有分支或完整引用'));
    if (new Set(hits.map((hit) => hit.found.oid)).size > 1) return err(conflict('同名本地分支和已知远端引用不同，请填写完整引用'));
    return ok(hits[0]!);
  }

  async function confirmSourceLinks(context: Access, taskId: string, workerId: string, plan: WorktreePlanSpec, progress: WorktreePlanProgress): Promise<Result<void, DomainError>> {
    const available = await sources(context.project, taskId, workerId);
    const found = (id: string, path: string) => available.some((item) => item.id === id && item.path === path);
    if (plan.members.some((member, index) =>
      (member.sourceId !== null && !found(member.sourceId, member.sourcePath!)) ||
      (progress.members[index]?.baseStep === 'ready' && !found(member.baseId, member.basePath)))) {
      return err(conflict('来源工作目录归属或状态已变，请重新选择'));
    }
    return ok(undefined);
  }

  async function visible(subject: Subject | null, projectId: string, taskId: string, row: Row, write: boolean) {
    const project = await projectTask(subject, projectId, taskId, write);
    if (!project.ok) return project;
    if (row.actorId !== project.value.actor.user.id || row.projectId !== projectId || row.taskId !== taskId) return err(notFound('Worktree 计划不存在'));
    const context = await access(subject, projectId, taskId, row.workerId, write);
    if (!context.ok) return context;
    const allowed = await allowSources(context.value);
    if (!allowed.ok) return allowed;
    const links = await confirmSourceLinks(context.value, taskId, row.workerId, row.plan, row.progress);
    return links.ok ? context : links;
  }

  function dto(row: Row, project: Project) {
    const configured = project.worktree?.setup;
    const anyReady = row.state === 'ready-unused' || row.state === 'closed';
    return {
      id: row.id, revision: row.revision, state: inFlight.has(row.id) || row.state !== 'pending' ? row.state : 'unknown',
      source: row.plan.source, workerId: row.workerId, primaryId: row.plan.primaryId,
      setupCommand: configured && row.plan.setupHash === setupHash(configured) ? configured.command : null,
      setupState: row.progress.setupState === 'running' && !inFlight.has(row.id) ? 'unknown' : row.progress.setupState,
      workspaceId: anyReady && !row.plan.groupId ? primary(row).outputId : null,
      groupId: anyReady ? row.plan.groupId : null,
      ...(row.progress.problem ? { problem: row.progress.problem } : {}),
      members: row.plan.members.map((member, index) => {
        const progress = row.progress.members[index]!;
        return { id: member.id, name: member.name, sourcePath: member.sourcePath ?? progress.base?.topLevel ?? null,
          targetPath: member.targetPath, branch: member.branch, startRef: member.startRef, oid: member.oid,
          baseAction: member.sourceId ? 'reuse' : 'clone', state: progress.state,
          ...(progress.problem ? { problem: progress.problem } : {}) };
      })
    };
  }

  function save(row: Row, state: Row['state'], progress: WorktreePlanProgress = row.progress): Row {
    const next = store.compareAndSet(row.id, row.revision, { ...row, state, progress });
    if (!next) throw new Error('planned worktree changed concurrently');
    return next;
  }

  function patchMember(row: Row, index: number, patch: Partial<MemberProgress>, state: Row['state'] = row.state): Row {
    return save(row, state, { ...row.progress, members: row.progress.members.map((member, i) => i === index ? { ...member, ...patch } : member) });
  }

  async function preview(subject: Subject | null, projectId: string, taskId: string, request: WorktreePreview) {
    const context = await access(subject, projectId, taskId, request.workerId, true);
    if (!context.ok) return context;
    const { git, project, actor } = context.value;
    if (request.runSetup) return err(invalid('此处创建 Worktree 不会运行项目准备命令'));
    const allowed = await allowSources(context.value);
    if (!allowed.ok) return allowed;
    if (!git.inspectPlannedWorktree || !git.createPlannedWorktree) return err(unavailable('这台机器尚不支持 Worktree 计划'));
    const selections = request.members;
    if (!selections.length || selections.length > WORKSPACE_GROUP_MEMBERS_MAX || new Set(selections.map((member) => member.id)).size !== selections.length) return err(invalid('请选择 1 到 8 个不同的来源'));
    const group = selections.length > 1;
    const primaryId = !group ? selections[0]!.id : request.source === 'local' ? request.primaryId : designatedPrimaryRepo(project)?.id;
    if (!primaryId || !selections.some((member) => member.id === primaryId) || (request.primaryId && request.primaryId !== primaryId)) return err(invalid('请选择有效的主目录；项目多仓须包含项目指定的主仓'));
    const available = await sources(project, taskId, request.workerId);
    const longLived = available.filter((item) => item.kind === 'long_lived');
    const planId = randomUUID();
    const groupId = group ? `group_${planId.replaceAll('-', '').slice(0, 16)}` : null;
    const members: Member[] = [];
    const identities = new Set<string>();
    const names = new Set<string>();
    let groupRoot: string | null = null;

    for (const [index, selected] of selections.entries()) {
      const repo = request.source === 'project' ? oneRepo(project, selected.id) : null;
      if (request.source === 'project' && !repo) return err(invalid('项目仓库不存在或登记不唯一'));
      if (request.source === 'local' && selected.baseWorkspaceId) return err(invalid('本地来源不能另选项目仓库底座'));
      let source: Workspace | null = null;
      let baseRow: Workspace | null = null;
      let base: Shape | null = null;
      let linkedBaseIdentity: string | null = null;
      let root: string;
      let oid: string;
      let startRef: string | null;
      const requestedRef = selected.startRef ?? repo?.defaultBranch ?? null;

      if (!repo) {
        source = available.find((item) => item.id === selected.id) ?? null;
        if (!source) return err(notFound('找不到这台机器上可用的来源工作目录'));
        const found = await localStart(git, source.path, requestedRef);
        if (!found.ok) return found;
        const candidates = source.kind === 'long_lived' ? [source] : longLived;
        const matching: Array<{ row: Workspace; identity: Shape }> = [];
        for (const row of candidates) {
          const check = row.id === source.id ? found : await localStart(git, row.path, null);
          if (check.ok && check.value.found.commonDir === found.value.found.commonDir) matching.push({ row, identity: check.value.found });
          else if (!check.ok && check.error.code !== 'invalid' && check.error.code !== 'not_found') return check;
        }
        const match = source.baseWorkspaceId ? matching.find((candidate) => candidate.row.id === source?.baseWorkspaceId) : matching.length === 1 ? matching[0] : undefined;
        if (!match) return err(conflict('没有唯一可验证的长期 Git 底座；请先登记稳定的源仓库目录'));
        baseRow = match.row;
        base = found.value.found;
        if (baseRow.id !== source.id) linkedBaseIdentity = match.identity.identity;
        ({ managedRoot: root, oid } = base);
        startRef = found.value.ref;
      } else {
        const candidates = selected.baseWorkspaceId ? longLived.filter((item) => item.id === selected.baseWorkspaceId) : longLived;
        if (selected.baseWorkspaceId && candidates.length !== 1) return err(notFound('指定底座不属于当前项目和机器'));
        const matching: Workspace[] = [];
        for (const row of candidates) {
          const check = await inspectRef(git, row.path, null, repo.url);
          if (check.ok) matching.push(row);
          else if (check.error.code !== 'invalid' && check.error.code !== 'not_found') return check;
          else if (selected.baseWorkspaceId || row.repoUrl === repo.url) return err(conflict('登记底座不能验证，请检查后重新选择；不会自动改为克隆'));
        }
        if (matching.length > 1) return err(conflict('多个底座匹配，请按目录明确选择一个底座'));
        source = matching[0] ?? null;
        baseRow = source;
        if (source) {
          const found = await localStart(git, source.path, requestedRef, repo.url);
          if (!found.ok) return found;
          base = found.value.found;
          ({ managedRoot: root, oid } = base);
          startRef = found.value.ref;
        } else {
          if (!input.allowRemoteBase) return err(unavailable('这台机器没有已验证的仓库底座；当前 Hub 不会为 Worktree 自动克隆，请先准备并登记仓库目录'));
          const current = await access(subject, projectId, taskId, request.workerId, true);
          if (!current.ok) return current;
          const remote = await allowSources(current.value, true);
          if (!remote.ok) return remote;
          const liveRepo = oneRepo(current.value.project, repo.id);
          if (!liveRepo || repoHash(liveRepo) !== repoHash(repo)) return err(conflict('项目仓库登记已变，请重新预览'));
          const currentGit = current.value.git;
          if (!currentGit.resolvePlannedBase || !currentGit.preparePlannedBase) return err(unavailable('这台机器不支持准备计划底座'));
          const auth = await input.authForRepo(current.value.project, liveRepo);
          if (!auth.ok) return auth;
          const ref = requestedRef === null || requestedRef.startsWith('refs/') ? requestedRef : `refs/heads/${requestedRef}`;
          const resolved = await currentGit.resolvePlannedBase({ repoUrl: liveRepo.url, startRef: ref, ...(auth.value ? { auth: auth.value } : {}) });
          if (!resolved.ok) return resolved;
          ({ managedRoot: root, oid, startRef } = resolved.value);
        }
      }

      if (base && identities.has(base.commonDir)) return err(invalid('多个来源指向同一个 Git 仓库，不能重复添加'));
      if (base) identities.add(base.commonDir);
      if (!posix.isAbsolute(root) || posix.normalize(root) !== root || root === '/') return err(conflict('机器没有返回有效的计划根目录'));
      const container: string = posix.join(root, groupId ?? `checkout-${planId}`);
      if (groupRoot && groupRoot !== container) return err(conflict('这份计划不能跨机器目录根'));
      groupRoot = container;
      const rawName = (repo?.name ?? posix.basename(source!.path)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 36);
      const stem = WORKSPACE_GROUP_NAME.test(rawName) && rawName !== 'repos' ? rawName : `repo-${index + 1}`;
      let name = stem;
      for (let suffix = 2; names.has(name); suffix++) name = `${stem}-${suffix}`;
      names.add(name);
      const targetPath = posix.join(container, ...(group && selected.id !== primaryId ? ['repos', name] : [name]));
      members.push({ id: selected.id, name, sourceId: source?.id ?? null, sourcePath: source?.path ?? null,
        baseId: baseRow?.id ?? newWorkspaceId(), basePath: baseRow?.path ?? posix.join(root, 'bases', `${planId}-${index}`), base, linkedBaseIdentity,
        repoHash: repo ? repoHash(repo) : null, expectedOriginUrl: repo?.url ?? null, targetPath, outputId: newWorkspaceId(),
        branch: `ahub/worktree-${planId.slice(0, 12)}-${index + 1}`, startRef, oid });
    }

    const live = await access(subject, projectId, taskId, request.workerId, true);
    if (!live.ok) return live;
    const stillAllowed = await allowSources(live.value, members.some((member) => member.sourceId === null));
    if (!stillAllowed.ok) return stillAllowed;
    const plan: WorktreePlanSpec = { source: request.source, members, primaryId, groupId, groupRoot: group ? groupRoot : null, setupHash: null };
    const progress: WorktreePlanProgress = { setupState: 'skipped', problem: null,
      members: members.map((member) => ({ base: member.base, baseStep: member.base ? 'ready' : 'pending', state: 'pending', problem: null })) };
    const registered = confirmRegistration(plan, live.value.project);
    if (!registered.ok) return registered;
    const linked = await confirmSourceLinks(live.value, taskId, request.workerId, plan, progress);
    if (!linked.ok) return linked;
    if (!store.create({ id: planId, actorId: actor.user.id, projectId, taskId, workerId: request.workerId, createdAt: deps.now(), state: 'draft', plan, progress,
      protectedWorkspaceIds: [...new Set(members.flatMap((member) => [member.sourceId, member.baseId, member.outputId].filter((id): id is string => id !== null)))],
      protectedGroupIds: groupId ? [groupId] : [] })) return err(conflict('无法登记这份 Worktree 计划，请重试预览'));
    return ok(dto(store.get(planId)!, live.value.project));
  }

  function confirmRegistration(plan: WorktreePlanSpec, project: Project): Result<void, DomainError> {
    if (plan.source === 'project' && plan.groupId && designatedPrimaryRepo(project)?.id !== plan.primaryId) return err(conflict('项目主仓已变，请重新预览'));
    if (plan.source === 'project' && plan.members.some((member) => {
      const repo = oneRepo(project, member.id);
      return !repo || repoHash(repo) !== member.repoHash;
    })) return err(conflict('项目仓库登记已变，请重新预览'));
    return ok(undefined);
  }

  async function confirmStableBase(context: Access, member: Member, source: Shape): Promise<Result<void, DomainError>> {
    if (!member.sourceId || member.baseId === member.sourceId) return ok(undefined);
    const stable = await inspectRef(context.git, member.basePath, null);
    if (!stable.ok || stable.value.commonDir !== source.commonDir || stable.value.managedRoot !== source.managedRoot || stable.value.identity !== member.linkedBaseIdentity)
      return err(conflict('长期底座不能验证，请重新预览'));
    return ok(undefined);
  }

  async function confirmCurrent(row: Row, context: Access): Promise<Result<void, DomainError>> {
    const registered = confirmRegistration(row.plan, context.project);
    if (!registered.ok) return registered;
    for (const member of row.plan.members) {
      const repo = row.plan.source === 'project' ? oneRepo(context.project, member.id) : null;
      if (!member.sourceId) continue;
      const check = await inspectRef(context.git, member.sourcePath!, member.startRef, repo?.url);
      if (!check.ok || !member.base || !sameShape(member.base, check.value)) return err(conflict('实际 Git 来源或起点已变，请重新预览'));
      const stable = await confirmStableBase(context, member, member.base);
      if (!stable.ok) return stable;
    }
    return ok(undefined);
  }

  async function checkOutput(row: Row, index: number, context: Access, reconcileOnly: boolean) {
    const target = checkoutInput(row, index);
    if (!target || !context.git.createPlannedWorktree) return err(unavailable('没有经过验证的 Git 底座'));
    return context.git.createPlannedWorktree(reconcileOnly ? { ...target, reconcileOnly: true } : target);
  }

  function matchesOutput(member: Member, value: { path: string; oid: string; branch: string }): boolean {
    return value.path === member.targetPath && value.oid === member.oid && value.branch === member.branch;
  }

  async function registerBase(row: Row, member: Member, shape: Shape, project: Project, repo: ProjectRepo) {
    const id = asWorkspaceId(member.baseId);
    const previous = await deps.workspaces.byId(id);
    if (previous) {
      if (previous.kind !== 'long_lived' || previous.source !== 'cloned' || previous.path !== shape.topLevel || previous.workerId !== row.workerId || previous.repoUrl !== repo.url || !isUsable(previous)) return false;
      return (await deps.workspaces.linksOf(id)).some((link) => link.projectId === project.id);
    }
    const created = newWorkspace({ id, projectId: project.id, teamId: project.teamId, repoUrl: repo.url, workerId: row.workerId,
      path: shape.topLevel, kind: 'long_lived', source: 'cloned', isGit: true, label: member.name, now: deps.now() });
    if (!created.ok) return false;
    const saved = await deps.workspaces.save(created.value);
    return saved.status === 'saved' && (await deps.workspaces.linksOf(id)).some((link) => link.projectId === project.id);
  }

  async function publish(row: Row, project: Project) {
    const groupId = row.plan.groupId ? asWorkspaceGroupId(row.plan.groupId) : null;
    for (const member of row.plan.members) {
      const id = asWorkspaceId(member.outputId);
      const previous = await deps.workspaces.byId(id);
      if (previous && (previous.state !== 'ready' || previous.path !== member.targetPath || previous.projectId !== project.id || previous.ownerTaskId !== row.taskId || previous.workerId !== row.workerId || previous.groupId !== groupId)) return false;
      if (previous) continue;
      const workspace = newWorkspace({ id, projectId: project.id, teamId: project.teamId, repoUrl: null, groupId, workerId: row.workerId,
        path: member.targetPath, kind: 'temporary', source: 'worktree', ownerTaskId: asTaskId(row.taskId), baseWorkspaceId: asWorkspaceId(member.baseId),
        branch: member.branch, isGit: true, label: member.name, now: deps.now() });
      if (!workspace.ok || (await deps.workspaces.save(workspace.value)).status !== 'saved') return false;
    }
    if (groupId && row.plan.groupRoot) {
      const group: WorkspaceGroup = { id: groupId, projectId: project.id, workerId: row.workerId, root: row.plan.groupRoot,
        layout: 'amp', primaryRepoId: row.plan.source === 'project' ? row.plan.primaryId : null,
        primaryWorkspaceId: asWorkspaceId(primary(row).outputId), ownerTaskId: asTaskId(row.taskId), createdAt: row.createdAt,
        state: 'ready', error: null, members: row.plan.members.map((member) => ({ workspaceId: asWorkspaceId(member.outputId),
          repoId: row.plan.source === 'project' ? member.id : null, projectRepoId: row.plan.source === 'project' ? member.id : null,
          sourceWorkspaceId: row.plan.source === 'local' && member.sourceId ? asWorkspaceId(member.sourceId) : null, name: member.name, state: 'ready', error: null })) };
      const existing = await deps.workspaceGroups.byId(groupId);
      if (existing && (existing.projectId !== group.projectId || existing.root !== group.root || existing.ownerTaskId !== group.ownerTaskId || existing.primaryWorkspaceId !== group.primaryWorkspaceId)) return false;
      if (!existing) await deps.workspaceGroups.save(group);
    }
    return true;
  }

  async function execute(subject: Subject | null, projectId: string, taskId: string, planId: string, revision: number) {
    const initial = store.get(planId);
    if (!initial) return err(notFound('Worktree 计划不存在'));
    const allowed = await visible(subject, projectId, taskId, initial, true);
    if (!allowed.ok) return allowed;
    if (initial.state === 'ready-unused' || initial.state === 'closed' || initial.state === 'failed' || inFlight.has(planId)) return ok(dto(initial, allowed.value.project));
    if (initial.revision !== revision) return err(conflict('计划状态已变，请先核对当前状态'));
    inFlight.add(planId);
    try {
      return await withActiveTask(deps, asTaskId(taskId), async () => {
        const action = async () => {
          let row = store.get(planId)!;
          if (row.revision !== revision) return err(conflict('计划状态已变，请先核对当前状态'));
          const context = await visible(subject, projectId, taskId, row, true);
          if (!context.ok) return context;
          const safety = deps.workdirSafety;
          if (!safety) return err(unavailable('Worktree 计划的目录保护不可用'));
          let live = context.value;
          if (row.plan.setupHash) return err(conflict('此版本不会执行准备命令；已产生的检出保留，请勿重放旧计划'));
          if (row.state === 'draft') {
            const checked = await confirmCurrent(row, context.value);
            if (!checked.ok) return checked;
          }
          const admitted = await safety.runExclusive(async () => {
            try { safety.assertNoRemoval({ workspaceId: primary(row).baseId, workerId: row.workerId, cwd: primary(row).basePath }); }
            catch { return err(conflict('有待确认的目录删除，暂不能创建或核对 Worktree')); }
            const current = await visible(subject, projectId, taskId, row, true);
            if (!current.ok) return current;
            const registered = confirmRegistration(row.plan, current.value.project);
            if (!registered.ok) return registered;
            const missing = row.plan.members.filter((member, index) => !member.sourceId && ['pending', 'failed'].includes(row.progress.members[index]!.baseStep));
            if (missing.length > 0) {
              if (!input.allowRemoteBase) return err(unavailable('当前 Hub 不允许启动新的底座克隆；已发出的操作可按原计划核对'));
              const reserved = store.listByProjectWorker(row.projectId, row.workerId).some((other) =>
                other.id !== row.id && other.state !== 'draft' && other.state !== 'failed' &&
                other.plan.members.some((item, index) => !item.sourceId && missing.some((member) => member.id === item.id) &&
                  (other.state === 'pending' || ['unknown', 'ready'].includes(other.progress.members[index]!.baseStep))));
              if (reserved) return err(conflict('同一项目仓库已有底座计划或结果；请核对原计划，再重新预览'));
              const candidates = await sources(current.value.project, row.taskId, row.workerId);
              if (candidates.some((item) => item.kind === 'long_lived' && missing.some((member) => oneRepo(current.value.project, member.id)?.url === item.repoUrl))) {
                return err(conflict('仓库已有已登记的底座，请重新预览，不会再次克隆'));
              }
            }
            row = save(row, 'pending', { ...row.progress, problem: null });
            return current;
          });
          if (!admitted.ok) return admitted;
          live = admitted.value;
          const recheck = async (needRemote = false) => {
            const current = await visible(subject, projectId, taskId, row, true);
            if (!current.ok) return current;
            const allowed = await allowSources(current.value, needRemote);
            if (!allowed.ok) return allowed;
            const registered = confirmRegistration(row.plan, current.value.project);
            if (!registered.ok) return registered;
            live = current.value;
            return current;
          };
          for (const [index, member] of row.plan.members.entries()) {
            let progress = row.progress.members[index]!;
            if (progress.state === 'ready') continue;
            const fresh = await recheck(!member.sourceId && progress.baseStep !== 'ready' && progress.baseStep !== 'unknown');
            if (!fresh.ok) return fresh;
            const repo = row.plan.source === 'project' ? oneRepo(live.project, member.id) : null;
            if (!member.sourceId && repo && progress.baseStep !== 'ready') {
              if (!live.git.preparePlannedBase || !member.startRef) return err(unavailable('这台机器不支持准备计划底座'));
              const reconcileOnly = progress.baseStep === 'unknown';
              const auth = reconcileOnly ? ok(null) : await input.authForRepo(live.project, repo);
              if (!auth.ok) return auth;
              row = patchMember(row, index, { baseStep: 'unknown', problem: null });
              const base = await live.git.preparePlannedBase({ repoUrl: repo.url, startRef: member.startRef, operationId: `${row.id}-${index}`,
                targetPath: member.basePath, expectedOid: member.oid, ...(auth.value ? { auth: auth.value } : {}), ...(reconcileOnly ? { reconcileOnly } : {}) });
              const beforeRegister = await recheck(!reconcileOnly);
              if (!beforeRegister.ok) return beforeRegister;
              if (!base.ok || base.value.topLevel !== member.basePath || base.value.oid !== member.oid || !await registerBase(row, member, base.value, live.project, repo)) {
                row = patchMember(row, index, { baseStep: !base.ok && base.error.operationSettled && !reconcileOnly ? 'failed' : 'unknown',
                  state: !base.ok && base.error.operationSettled && !reconcileOnly ? 'failed' : 'unknown', problem: '底座尚未确认；不会接管已有目录或重新选择仓库' });
                continue;
              }
              row = patchMember(row, index, { base: base.value, baseStep: 'ready', state: 'pending', problem: null });
              progress = row.progress.members[index]!;
            }
            const base = progress.base;
            if (!base || !live.git.createPlannedWorktree) return err(unavailable('没有经过验证的 Git 底座'));
            if (row.progress.members.some((other, i) => i !== index && other.base?.commonDir === base.commonDir)) {
              row = patchMember(row, index, { state: 'failed', problem: '多个成员指向同一 Git 仓库，不能继续' });
              continue;
            }
            const reconcileOnly = progress.state === 'unknown';
            const beforeCheckout = await recheck();
            if (!beforeCheckout.ok) return beforeCheckout;
            const stable = await confirmStableBase(beforeCheckout.value, member, base);
            if (!stable.ok) return stable;
            // Checking a linked base awaits Worker I/O, so revalidate identity and rights before dispatch.
            const checkoutAccess = member.sourceId && member.baseId !== member.sourceId ? await recheck() : beforeCheckout;
            if (!checkoutAccess.ok) return checkoutAccess;
            row = patchMember(row, index, { state: 'unknown', problem: null });
            const made = await checkOutput(row, index, checkoutAccess.value, reconcileOnly);
            if (made.ok && matchesOutput(member, made.value)) {
              row = patchMember(row, index, { state: 'ready' });
            } else {
              const failed = !made.ok && made.error.operationSettled === true && !reconcileOnly;
              row = patchMember(row, index, { state: failed ? 'failed' : 'unknown', problem: failed ? '没有执行检出；请核对来源和起点再继续' : '检出结果未确认；只会核对原操作，不会重复创建' });
            }
          }
          if (!row.progress.members.every((member) => member.state === 'ready')) {
            const untouched = row.progress.members.every((member, index) => member.state === 'failed' &&
              (row.plan.members[index]!.sourceId !== null || member.baseStep === 'failed'));
            row = untouched ? save(row, 'failed', { ...row.progress, problem: '确认未新建底座或检出；请修改来源或起点后重新预览' }) : save(row, 'unknown');
            const finalAccess = await recheck();
            return finalAccess.ok ? ok(dto(row, finalAccess.value.project)) : finalAccess;
          }
          // A prior ready flag is not proof that the same checkout still exists.
          for (const [index, member] of row.plan.members.entries()) {
            const checked = await recheck();
            if (!checked.ok) return checked;
            const base = row.progress.members[index]!.base;
            if (!base) return err(conflict('长期底座不能验证，请重新预览'));
            const stable = await confirmStableBase(checked.value, member, base);
            if (!stable.ok) return stable;
            const proofAccess = member.sourceId && member.baseId !== member.sourceId ? await recheck() : checked;
            if (!proofAccess.ok) return proofAccess;
            const proof = await checkOutput(row, index, proofAccess.value, true);
            if (!proof.ok || !matchesOutput(member, proof.value)) {
              row = patchMember(row, index, { state: 'unknown', problem: '已完成的检出无法重新证明，保留原计划供核对' }, 'unknown');
              const finalAccess = await recheck();
              return finalAccess.ok ? ok(dto(row, finalAccess.value.project)) : finalAccess;
            }
          }
          return safety.runExclusive(async () => {
            const finalAccess = await recheck();
            if (!finalAccess.ok) return finalAccess;
            if (!await publish(row, live.project)) return ok(dto(save(row, 'unknown', { ...row.progress, problem: '检出已保留，但工作目录登记未确认' }), live.project));
            return ok(dto(save(row, 'ready-unused'), live.project));
          });
        };
        return action();
      });
    } finally { inFlight.delete(planId); }
  }

  return {
    preview, execute,
    async get(subject: Subject | null, projectId: string, taskId: string, id: string) {
      const row = store.get(id);
      if (!row) return err(notFound('Worktree 计划不存在'));
      const context = await visible(subject, projectId, taskId, row, false);
      return context.ok ? ok(dto(row, context.value.project)) : context;
    },
    async list(subject: Subject | null, projectId: string, taskId: string) {
      const context = await projectTask(subject, projectId, taskId, false);
      if (!context.ok) return context;
      const plans: ReturnType<typeof dto>[] = [];
      for (const row of store.listByTask(taskId).slice(-40).reverse()) {
        if (row.actorId !== context.value.actor.user.id || row.projectId !== projectId) continue;
        const live = await visible(subject, projectId, taskId, row, false);
        if (live.ok) plans.push(dto(row, live.value.project));
      }
      return ok({ plans });
    }
  };
}
