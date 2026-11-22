import type { Subject } from '../access.ts';
import { principalOfSubject } from '../access.ts';
import type { DomainError } from '../errors.ts';
import { conflict, forbidden, invalid, notFound, unavailable } from '../errors.ts';
import { githubRepoOf } from '../git-workflow.ts';
import type { SessionId, TaskId } from '../ids.ts';
import { newId } from '../ids.ts';
import type { GitHostApi } from '../ports/pull-requests.ts';
import type { GitAuth, PublishRefOutcome, RemotePullRequest, WorkspaceGit } from '../ports/workspace-git.ts';
import type { Project } from '../project.ts';
import { err, ok, type Result } from '../result.ts';
import type { DelegationClaim, DelegationFailure, WorkspaceDelegation } from '../workspace-delegation.ts';
import { DELEGATION_CLAIM_TTL_MS, newDelegationClaim } from '../workspace-delegation.ts';
import type { AccessPolicy } from './authorization.ts';
import { authorizeProject, authorizeWorker } from './authorization.ts';
import type { Deps } from './deps.ts';

/**
 * 派工记录 step B：把「已批准的功能分支提交」发布成远端分支，并开一个**草稿 PR**
 * （docs/design/workspace-delegation.md）。
 *
 * 本用例只做编排，所有 Git / 托管平台动作都经端口：
 * - 发布分支必须走 `WorkspaceGit.publishRef`（create-only，明确 SHA）；**不能**退回普通 `push`，
 *   也不复用普通的 gitPr（gh）路径：这里只允许项目所在团队的 GitHub 应用凭据。
 * - PR 的 head 用**记录里的功能分支名**（不是 SHA），base 用**记录里的 base 分支**；仓库只认
 *   `record.repoUrl` 对应的那一个项目仓库，地址变了就拒绝。
 * - 建 PR 之前在持久存储里原子领取 `(delegationId, approvalKey)` 这条尝试；领取之后任何不明结果
 *   都落 `uncertain`，**绝不**再自动创建 PR。崩溃后只能走显式 `reconcile`（只读远端核验 + 列 PR）。
 * - 领取的 claim 只是「同一条派工内串行化」的租约，**不是跨网络栅栏**：每次远端写之前都重新核对
 *   持有者 / 状态 / 租期，租期一过就不再发任何远端动作；GitHub 侧无法 fencing，这里也不假装能。
 * - 成功重放只读记录，不产生任何外部写。
 *
 * 不承诺 exactly-once：GitHub 创建 PR 没有幂等键，这里保证的是「有疑问就停」以及
 * 「同一次批准不会因为重试 / 崩溃而静默再开一个 PR」。
 */

/** 一次发布尝试的状态。只有 `publishing` 有 claim；离开时清空。 */
export type PublishAttemptState = 'publishing' | 'published' | 'failed' | 'uncertain';

/** `publishRef` 证明成立的远端事实（远端分支指向哪个提交、base 当时是什么）。 */
export interface PublishRemoteFacts {
  readonly sha: string;
  readonly branch: string;
  readonly baseBranch: string;
  /** 核验时远端 base 分支的提交；base 会前进，所以不要求和记录里的 `baseSha` 相等。 */
  readonly baseSha: string;
  readonly defaultBranch: string;
  readonly remoteSha: string | null;
  readonly published: boolean;
}

/** 已核验的 PR：字段全部来自这次调用的严格比对，不是「看起来像」。 */
export interface PublishedPullRequest {
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly base: string;
  readonly baseRepo: string;
  readonly state: 'open';
  readonly draft: true;
}

/**
 * 一次「人批准过的发布」。幂等键是 `(delegationId, approvalKey)`：
 * 同一个批准键 + 同一个指纹复用同一条尝试；批准键相同但提交 / 仓库 / 分支不同 = conflict。
 */
export interface PublishAttempt {
  readonly delegationId: string;
  /** 人对这次发布给出的稳定键（同一次点击重放用同一个）。 */
  readonly approvalKey: string;
  /** 批准内容指纹：版本 + 派工身份 + 批准键 + 提交 + 仓库 + 分支 + base。 */
  readonly fingerprint: string;
  /** 人批准的具体提交（40 位小写）。 */
  readonly headSha: string;
  readonly state: PublishAttemptState;
  /** 只有 `publishing` 有值。 */
  readonly claim: DelegationClaim | null;
  /** `failed` / `uncertain` 时必填。 */
  readonly failure: DelegationFailure | null;
  readonly remote: PublishRemoteFacts | null;
  readonly pullRequest: PublishedPullRequest | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PublishAttemptInsert {
  readonly delegationId: string;
  readonly approvalKey: string;
  readonly fingerprint: string;
  readonly headSha: string;
  readonly claim: DelegationClaim;
  readonly at: number;
}

/**
 * `created` = 新建；`exists` = 同一个批准键已有记录；`blocked` = 这条派工的**另一条**批准键
 * 处于 `publishing` / `published` / `uncertain`，这次发布必须先停住（不能开第二次）。
 */
export type PublishAttemptInsertOutcome = 'created' | 'exists' | 'blocked';

export interface PublishAttemptInsertResult {
  readonly outcome: PublishAttemptInsertOutcome;
  /**
   * `exists` 时返回同键旧记录；`blocked` 时返回拦住这次发布的那条（可能是别的批准键）。
   * 任何情况下都不覆盖已有记录。
   */
  readonly attempt: PublishAttempt;
}

export interface PublishAttemptCasExpect {
  readonly state: PublishAttemptState;
  /** `null` = 必须没有 claim；字符串 = 必须是这次尝试；省略 = 不校验。 */
  readonly claimToken?: string | null;
}

export interface PublishAttemptCasInput {
  readonly delegationId: string;
  readonly approvalKey: string;
  readonly expect: PublishAttemptCasExpect;
  readonly state: PublishAttemptState;
  readonly at: number;
  /** 省略 = 不改；`null` = 清空。 */
  readonly claim?: DelegationClaim | null;
  readonly remote?: PublishRemoteFacts | null;
  readonly pullRequest?: PublishedPullRequest | null;
  readonly failure?: DelegationFailure | null;
}

export interface PublishAttemptCasResult {
  readonly ok: boolean;
  /**
   * 失败时返回当前尝试；若被**别的**批准键的 `publishing` / `published` / `uncertain`
   * 尝试挡住，则返回拦住它的那条，便于给出确定的中断原因。
   */
  readonly attempt: PublishAttempt | null;
}

/**
 * 持久化的发布尝试存储（由 storage 车道实现）。
 *
 * - `insert` 必须对 `(delegationId, approvalKey)` 唯一，已存在时返回 `exists`，不能覆盖；
 *   同一派工已有**别的**批准键处于 `publishing` / `published` / `uncertain` 时返回 `blocked`
 *   并带回那条尝试——这条派工一次只允许一条未失败的发布线。
 * - `compareAndSet` 必须原子地校验状态 / claim token；成功时按输入写入可选项并清空 claim
 *   （除非显式给了新 claim）。若被**别的**批准键的未落定尝试挡住，失败结果里带回那条尝试。
 */
export interface DelegationPublishStore {
  byKey(delegationId: string, approvalKey: string): Promise<PublishAttempt | null>;
  /** 这条派工最近一次发布尝试（人看「刚才发生了什么」用；不参与幂等判断）。 */
  latest(delegationId: string): Promise<PublishAttempt | null>;
  insert(input: PublishAttemptInsert): Promise<PublishAttemptInsertResult>;
  compareAndSet(input: PublishAttemptCasInput): Promise<PublishAttemptCasResult>;
}

/** 从当前 worktree 读出来、且必须与记录逐项一致的发布目标。 */
export interface DelegationPublishTarget {
  readonly executionSessionId: SessionId;
  readonly taskId: TaskId;
  readonly workerId: string;
  readonly path: string;
  readonly repoUrl: string;
  readonly branch: string;
  /** worktree 当前 HEAD（40 位小写）；必须等于人批准的提交。 */
  readonly headSha: string;
}

/** 可注入的外部动作；本用例只负责顺序、权限、幂等与状态。 */
export interface WorkspaceDelegationPublishBridges {
  /** 只读地取派工记录（父车道负责持久化）。 */
  readonly loadRecord: (delegationId: string) => Promise<WorkspaceDelegation | null>;
  /** 只读地读取执行会话当前的 worktree 身份；不得产生副作用。 */
  readonly resolveTarget: (record: WorkspaceDelegation) => Promise<Result<DelegationPublishTarget, DomainError>>;
  readonly git: (workerId: string) => WorkspaceGit;
  /** 绑定的 HTTPS 仓库凭据；公开仓库可以没有。 */
  readonly repoAuth?: (record: WorkspaceDelegation) => Promise<GitAuth | null>;
  /**
   * 项目所在团队配置的 GitHub 应用凭据（标准发布通道）。
   * 没有 = 不能建 PR；**不要**退回 Worker 的 gh 登录态。
   */
  readonly gitHost?: (project: Project) => Promise<{ readonly api: GitHostApi; readonly token: string } | null>;
}

export interface PublishDelegationCommandBase {
  /** 路由传入的当前登录主体；必须是普通人类 cookie 会话（不能带 `via`）。 */
  readonly actor: Subject | null;
  readonly delegationId: string;
  /** 人对这次发布的稳定批准键，必填且原样使用（不 trim / 不改大小写）。 */
  readonly approvalKey: string;
}

export type PublishDelegationCommand =
  | (PublishDelegationCommandBase & {
      readonly mode?: 'publish';
      /** 人批准时看到的提交号；必须等于 worktree 当前 HEAD。 */
      readonly expectedHeadSha: string;
    })
  | (PublishDelegationCommandBase & {
      /** 只读对账：不 push、不建 PR；只用已存的尝试与远端 / PR 列表核对。 */
      readonly mode: 'reconcile';
    });

export interface PublishDelegationRun {
  readonly record: WorkspaceDelegation;
  readonly attempt: PublishAttempt;
  /** 本次调用是否尝试了外部副作用。 */
  readonly attempted: boolean;
  /** 本次是读记录 / 远端状态的重放，没有外部写。 */
  readonly replayed: boolean;
  readonly reconciled: boolean;
}

const APPROVAL_KEY_MAX = 200;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const BRANCH_MAX = 200;

/**
 * 外部可见的 PR 文本。派工里的 instructions / 任务标题是 hub 内部上下文，
 * 不经过人工逐字批准就不能原样发到 GitHub；这里只放中性模板。
 */
const PULL_REQUEST_TITLE = '应用人工批准的改动';
const PULL_REQUEST_BODY = '本 PR 由 agent-hub 在人工确认后创建，请按项目流程审阅。';

function validBranchName(value: string): boolean {
  if (value === '' || value.length > BRANCH_MAX) return false;
  if (/\s/.test(value) || value.includes('..') || value.includes('~') || value.includes('\\')) return false;
  if (value.startsWith('/') || value.endsWith('/')) return false;
  return true;
}

/** 记录的静态不变量：没有「已准备好 + 明确基线 + 完整执行身份」就不许发布。 */
function recordProblem(record: WorkspaceDelegation): DomainError | null {
  if (record.state !== 'prepared') return conflict('只有已准备好的派工可以发布 PR');
  if (record.baseSha === null || !SHA_PATTERN.test(record.baseSha)) {
    return conflict('派工没有记录有效的基线提交，不能发布');
  }
  if (record.repoId.trim() === '' || record.repoUrl.trim() === '') return conflict('派工没有记录仓库，不能发布');
  if (!validBranchName(record.branch) || !validBranchName(record.baseBranch)) return conflict('派工记录的分支名不合法');
  if (record.branch === record.baseBranch) return conflict('功能分支不能就是 base 分支');
  if (record.workerId.trim() === '' || record.worktreePath.trim() === '') return conflict('派工没有记录工作树身份');
  return null;
}

/** 把 worktree 现况与记录逐项对齐；任何一项不同都说明「批准时的样子」已经变了。 */
function targetProblem(record: WorkspaceDelegation, target: DelegationPublishTarget): string | null {
  if (target.executionSessionId !== record.executionSessionId) return '执行会话';
  if (target.taskId !== record.taskId) return '任务';
  if (target.workerId !== record.workerId) return '机器';
  if (target.path !== record.worktreePath) return '工作树路径';
  if (target.repoUrl !== record.repoUrl) return '仓库地址';
  if (target.branch !== record.branch) return '功能分支';
  if (!SHA_PATTERN.test(target.headSha)) return 'HEAD 提交号';
  return null;
}

/**
 * 批准内容的指纹。批准键相同但指纹不同 = 人在同一个键下换了提交 / 仓库 / 分支，必须 conflict，
 * 不能把旧尝试当成新尝试重放。
 */
function fingerprintOf(record: WorkspaceDelegation, approvalKey: string, headSha: string): string {
  return [
    'workspace-delegation-publish/1',
    record.id,
    record.projectId,
    record.taskId,
    record.executionSessionId,
    approvalKey,
    headSha,
    record.repoId,
    record.repoUrl,
    record.branch,
    record.baseBranch
  ].join('\n');
}

/** 严格核验 GitHub 返回的 PR；返回 null = 全部符合，否则返回第一处不符。 */
function pullRequestProblem(
  pr: RemotePullRequest,
  expected: { readonly repo: string; readonly headRef: string; readonly headSha: string; readonly base: string }
): string | null {
  if (!Number.isInteger(pr.number) || pr.number <= 0) return 'PR 编号不是正整数';
  if (pr.state !== 'open') return `PR 状态是「${pr.state}」，不是 open`;
  if (pr.draft !== true) return 'PR 不是草稿';
  if (pr.repo !== expected.repo) return `PR head 仓库是「${pr.repo ?? '未知'}」，不是「${expected.repo}」`;
  if (pr.headRef !== expected.headRef) return `PR head 分支是「${pr.headRef ?? '未知'}」，不是「${expected.headRef}」`;
  if (pr.headSha !== expected.headSha) return 'PR 的 head 提交与批准的提交不一致';
  if (pr.base !== expected.base) return `PR base 是「${pr.base ?? '未知'}」，不是「${expected.base}」`;
  if (pr.baseRepo !== expected.repo) return `PR base 仓库是「${pr.baseRepo ?? '未知'}」，不是「${expected.repo}」`;
  const canonical = `https://github.com/${expected.repo}/pull/${pr.number}`;
  if (pr.url !== canonical) return 'PR 地址不是规范的 GitHub 编号地址';
  return null;
}

function toPublishedPullRequest(
  pr: RemotePullRequest,
  expected: { readonly repo: string; readonly headRef: string; readonly headSha: string; readonly base: string }
): PublishedPullRequest {
  return {
    repo: expected.repo,
    number: pr.number,
    url: pr.url,
    headRef: expected.headRef,
    headSha: expected.headSha,
    base: expected.base,
    baseRepo: expected.repo,
    state: 'open',
    draft: true
  };
}

function remoteFacts(outcome: PublishRefOutcome): PublishRemoteFacts {
  return {
    sha: outcome.sha,
    branch: outcome.branch,
    baseBranch: outcome.baseBranch,
    baseSha: outcome.baseSha,
    defaultBranch: outcome.defaultBranch,
    remoteSha: outcome.remoteSha,
    published: outcome.published
  };
}

function run(
  record: WorkspaceDelegation,
  attempt: PublishAttempt,
  flags: { readonly attempted: boolean; readonly replayed: boolean; readonly reconciled: boolean }
): PublishDelegationRun {
  return { record, attempt, ...flags };
}

export async function publishWorkspaceDelegationUseCase(
  deps: Pick<Deps, 'projects' | 'tasks' | 'access' | 'now'>,
  store: DelegationPublishStore,
  bridges: WorkspaceDelegationPublishBridges,
  command: PublishDelegationCommand
): Promise<Result<PublishDelegationRun, DomainError>> {
  const actor = command.actor;
  // 发布 PR 必须是真人 cookie 会话：token / bot / system 的 via 都不能当批准人。
  const principal = principalOfSubject(actor);
  if (!actor || !principal || principal.via) return err(forbidden('发布 PR 必须由真人登录会话发起'));

  const approvalKey = command.approvalKey;
  if (
    typeof approvalKey !== 'string' ||
    approvalKey.trim() === '' ||
    approvalKey.length > APPROVAL_KEY_MAX ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(approvalKey)
  ) {
    return err(invalid(`批准键必须是 trim 后非空、不超过 ${APPROVAL_KEY_MAX} 字符的字符串`));
  }
  if (typeof command.delegationId !== 'string' || command.delegationId.trim() === '') {
    return err(invalid('派工记录 id 不能为空'));
  }
  const reconcile = command.mode === 'reconcile';
  const expectedHeadSha = reconcile ? null : command.expectedHeadSha;
  if (!reconcile && (typeof expectedHeadSha !== 'string' || !SHA_PATTERN.test(expectedHeadSha))) {
    return err(invalid('必须给出 40 位小写的批准提交号'));
  }

  const record = await bridges.loadRecord(command.delegationId);
  if (!record || record.id !== command.delegationId) return err(notFound('派工记录不存在'));
  const problem = recordProblem(record);
  if (problem) return err(problem);

  const [task, project] = await Promise.all([deps.tasks.byId(record.taskId), deps.projects.byId(record.projectId)]);
  if (!task || task.id !== record.taskId) return err(notFound('派工任务不存在'));
  if (!project || project.id !== record.projectId || project.deletedAt !== null) return err(notFound('项目不存在'));
  if (task.projectId !== project.id) return err(conflict('派工任务与项目不再一致'));

  // 仓库只认项目清单里登记的那一条，且地址必须与记录逐字节一致；不接受任何「按名字猜」。
  const repo = project.repos.find((candidate) => candidate.id === record.repoId);
  if (!repo) return err(conflict('派工仓库不在项目的仓库清单里'));
  if (repo.url !== record.repoUrl) return err(conflict('项目仓库地址已变化，不能沿用这次派工'));
  const repoName = githubRepoOf(record.repoUrl);
  if (!repoName) return err(invalid('派工仓库不是可识别的 GitHub 仓库'));

  // 权限：项目必须可见，且**每一个**批准人（包括原派工人）此刻都必须仍然拥有 git.push
  // 与这台机器的使用权——派工时的授权可能早已被收回。
  const policy: AccessPolicy | undefined = deps.access;
  const visible = await authorizeProject(policy, actor, project, 'project.read');
  if (!visible.ok) return visible;
  const canPush = await authorizeProject(policy, actor, project, 'git.push');
  if (!canPush.ok) return canPush;
  const canUseWorker = await authorizeWorker(policy, actor, record.workerId, 'worker.use');
  if (!canUseWorker.ok) return canUseWorker;

  const at = deps.now();
  const previous = await store.byKey(record.id, approvalKey);

  /* ───────────────────────── 只读对账 ───────────────────────── */
  if (reconcile) {
    if (!previous) return err(notFound('没有这次发布尝试，无法对账'));
    const attempt = previous;
    const fingerprint = fingerprintOf(record, approvalKey, attempt.headSha);
    if (attempt.fingerprint !== fingerprint) return err(conflict('发布尝试与当前派工记录不一致，不能对账'));
    if (attempt.state === 'published') {
      // 已发布是终态：对账也只读记录，不碰远端。
      return ok(run(record, attempt, { attempted: false, replayed: true, reconciled: true }));
    }
    if (attempt.state === 'publishing' && attempt.claim !== null && attempt.claim.expiresAt > at) {
      return err(conflict('发布正在进行，等它落定后再对账'));
    }
    return reconcileReadOnly(deps, store, bridges, record, project, repoName, attempt);
  }

  /* ───────────────────────── 正常发布 ───────────────────────── */
  const headSha = expectedHeadSha as string;
  const fingerprint = fingerprintOf(record, approvalKey, headSha);

  if (previous) {
    if (previous.fingerprint !== fingerprint) return err(conflict('同一个批准键不能换提交 / 仓库 / 分支'));
    switch (previous.state) {
      case 'published': {
        // 成功重放：只读记录，任何外部通道都不碰。
        if (previous.pullRequest === null || previous.pullRequest.headSha !== headSha) {
          return err(conflict('已发布记录不完整，无法重放'));
        }
        return ok(run(record, previous, { attempted: false, replayed: true, reconciled: false }));
      }
      case 'uncertain':
        return err(conflict('上次发布结果不明；请先对账，不会重新创建 PR'));
      case 'publishing':
        if (previous.claim !== null && previous.claim.expiresAt > at) return err(conflict('正在发布，请稍后刷新'));
        return err(conflict('上次发布中断且未落定；请先对账'));
      case 'failed':
        // 明确失败（没有不明副作用）可以用同一个批准键安全重试。
        break;
    }
  }

  const target = await bridges.resolveTarget(record);
  if (!target.ok) return target;
  const mismatch = targetProblem(record, target.value);
  if (mismatch) return err(conflict(`工作树的${mismatch}与派工记录不一致，不能发布`));
  if (target.value.headSha !== headSha) return err(conflict('worktree 的 HEAD 已经不是批准的提交；请重新确认'));

  const git = bridges.git(record.workerId);
  if (typeof git.publishRef !== 'function') return err(unavailable('这台机器不支持发布已批准的提交（Worker 版本过旧）'));

  const host = bridges.gitHost ? await bridges.gitHost(project) : null;
  if (!host) return err(unavailable('项目没有可用的 GitHub 应用凭据，不能创建 PR'));
  const auth = bridges.repoAuth ? await bridges.repoAuth(record) : null;

  const attempt = await claimAttempt(store, previous, {
    delegationId: record.id,
    approvalKey,
    fingerprint,
    headSha,
    claim: newDelegationClaim(principal.user.id, newId(), at, DELEGATION_CLAIM_TTL_MS),
    at
  });
  if (!attempt.ok) return attempt;
  const owned = attempt.value;

  const expected = { repo: repoName, headRef: record.branch, headSha, base: record.baseBranch };
  const publishRef = git.publishRef.bind(git);
  const base = {
    path: record.worktreePath,
    branch: record.branch,
    sha: headSha,
    expectedUrl: record.repoUrl,
    baseBranch: record.baseBranch,
    ...(auth ? { auth } : {})
  };

  try {
    // 远端写之前重新核对租约：claim 不是栅栏，但租期过了就绝不再发远端动作。
    const lease = await checkOwnership(store, owned, deps.now());
    if (lease === 'lost') return err(conflict('发布尝试已被其他操作接管；请刷新'));
    if (lease === 'expired') {
      await settle(store, owned, {
        state: 'failed',
        at: deps.now(),
        failure: { kind: 'fatal', message: '发布租期已过，没有做任何远端写', at: deps.now() }
      });
      return err(unavailable('发布租期已过；没有发布任何内容，可以重试'));
    }

    const published = await publishRef(base);
    if (!published.ok) {
      // `publishRef` 的失败关闭错误都发生在创建 PR 之前；记录成 fatal，允许同一批准键安全重试。
      await settle(store, owned, {
        state: 'failed',
        at: deps.now(),
        failure: { kind: 'fatal', message: '发布分支失败，未创建 PR', at: deps.now() }
      });
      return err(published.error);
    }
    const outcome = published.value;
    if (outcome.uncertain) {
      await settle(store, owned, {
        state: 'uncertain',
        at: deps.now(),
        remote: remoteFacts(outcome),
        failure: { kind: 'uncertain', message: '远端状态无法确认，尚未创建 PR', at: deps.now() }
      });
      return err(unavailable('远端状态无法确认；已停止，不会创建 PR，请对账'));
    }
    if (!outcome.published) {
      await settle(store, owned, {
        state: 'failed',
        at: deps.now(),
        remote: remoteFacts(outcome),
        failure: { kind: 'fatal', message: '远端分支没有更新为批准的提交，未创建 PR', at: deps.now() }
      });
      return err(conflict('远端分支没有更新为批准的提交；没有创建 PR，可以重试'));
    }
    if (outcome.sha !== headSha || outcome.branch !== record.branch || outcome.baseBranch !== record.baseBranch) {
      await settle(store, owned, {
        state: 'uncertain',
        at: deps.now(),
        remote: remoteFacts(outcome),
        failure: { kind: 'uncertain', message: '远端核验结果与批准的提交 / 分支不一致', at: deps.now() }
      });
      return err(unavailable('远端核验结果与批准内容不一致；已停止，请对账'));
    }
    if (outcome.remoteSha !== null && outcome.remoteSha !== headSha) {
      await settle(store, owned, {
        state: 'uncertain',
        at: deps.now(),
        remote: remoteFacts(outcome),
        failure: { kind: 'uncertain', message: '远端功能分支另有提交，无法证明发布结果', at: deps.now() }
      });
      return err(unavailable('远端功能分支另有提交；已停止，请对账'));
    }

    // 建 PR 之前先列一次：崩溃 / 超时后可能已经有一个 PR，认领它，绝不盲目再建。
    const listed = await host.api.listPullRequestsByHead({ token: host.token, repo: repoName, head: record.branch });
    if (!listed.ok) {
      await settle(store, owned, {
        state: 'uncertain',
        at: deps.now(),
        remote: remoteFacts(outcome),
        failure: { kind: 'uncertain', message: '远端已发布，但无法核对是否已有 PR', at: deps.now() }
      });
      return err(unavailable('远端已发布，但无法核对是否已有 PR；已停止，请对账'));
    }
    const adoptable = listed.prs.filter((pr) => pullRequestProblem(pr, expected) === null);
    if (adoptable.length > 1) {
      await settle(store, owned, {
        state: 'uncertain',
        at: deps.now(),
        remote: remoteFacts(outcome),
        failure: { kind: 'uncertain', message: '同一 head 上有多条符合的草稿 PR，无法唯一认领', at: deps.now() }
      });
      return err(conflict('同一 head 上有多条符合的草稿 PR；请人工核对后再试'));
    }
    if (adoptable.length === 1) {
      const cas = await settle(store, owned, {
        state: 'published',
        at: deps.now(),
        remote: remoteFacts(outcome),
        pullRequest: toPublishedPullRequest(adoptable[0]!, expected)
      });
      if (!cas) return err(conflict('发布结果被并发修改，请刷新'));
      return ok(run(record, cas, { attempted: false, replayed: false, reconciled: false }));
    }
    const foreign = listed.prs.find((pr) => pr.headRef === record.branch && pr.state === 'open');
    if (foreign) {
      await settle(store, owned, {
        state: 'failed',
        at: deps.now(),
        remote: remoteFacts(outcome),
        failure: { kind: 'fatal', message: '同名分支已有不符合这次批准的开放 PR', at: deps.now() }
      });
      return err(conflict('同名分支已有不符合这次批准的开放 PR（可能不是草稿）；请人工核对'));
    }

    // 建 PR 也是远端写：再核对一次租约 / 持有者；租期过了或已被接管都不写。
    const createLease = await checkOwnership(store, owned, deps.now());
    if (createLease === 'lost') return err(conflict('发布尝试已被其他操作接管；请刷新'));
    if (createLease === 'expired') {
      await settle(store, owned, {
        state: 'uncertain',
        at: deps.now(),
        remote: remoteFacts(outcome),
        failure: { kind: 'uncertain', message: '创建 PR 前发布租期已过，PR 是否创建不明', at: deps.now() }
      });
      return err(unavailable('发布租期已过，PR 尚未创建；已停止，请对账'));
    }

    const created = await host.api.createPullRequest({
      token: host.token,
      repo: repoName,
      base: record.baseBranch,
      head: record.branch,
      title: PULL_REQUEST_TITLE,
      body: PULL_REQUEST_BODY,
      draft: true
    });
    if (!created.ok) {
      // 创建请求可能已经在 GitHub 侧生效；这里绝不能重试创建。
      await settle(store, owned, {
        state: 'uncertain',
        at: deps.now(),
        remote: remoteFacts(outcome),
        failure: { kind: 'uncertain', message: '创建 PR 的结果不明', at: deps.now() }
      });
      return err(unavailable('创建 PR 的结果不明；已停止，请对账（不会自动重试）'));
    }
    const createdProblem = pullRequestProblem(created.pr, expected);
    if (createdProblem) {
      await settle(store, owned, {
        state: 'uncertain',
        at: deps.now(),
        remote: remoteFacts(outcome),
        failure: { kind: 'uncertain', message: `返回的 PR 不符合批准内容：${createdProblem}`, at: deps.now() }
      });
      return err(unavailable(`返回的 PR 不符合批准内容（${createdProblem}）；已停止，请对账`));
    }
    const cas = await settle(store, owned, {
      state: 'published',
      at: deps.now(),
      remote: remoteFacts(outcome),
      pullRequest: toPublishedPullRequest(created.pr, expected)
    });
    if (!cas) {
      const reread = await store.byKey(record.id, approvalKey);
      if (reread?.state === 'published' && reread.fingerprint === fingerprint) {
        return ok(run(record, reread, { attempted: true, replayed: false, reconciled: false }));
      }
      return err(conflict('发布结果被并发修改；PR 可能已经创建，请对账后再操作'));
    }
    return ok(run(record, cas, { attempted: true, replayed: false, reconciled: false }));
  } catch (error) {
    // 进程崩溃走不到这里；这里是编排层的意外异常。两种情况都只能落 uncertain，不能重试创建。
    await settle(store, owned, {
      state: 'uncertain',
      at: deps.now(),
      failure: { kind: 'uncertain', message: '发布中断且结果不明', at: deps.now() }
    });
    return err(unavailable('发布中断且结果不明；已停止，请对账'));
  }
}

/** 被「这条派工的另一次发布」挡住时的确定性说明（都发生在任何外部写之前）。 */
function blockedProblem(attempt: PublishAttempt): DomainError {
  switch (attempt.state) {
    case 'published':
      return conflict('这条派工已经发布过 PR；请刷新查看结果，不能用新的批准键再发一次');
    case 'uncertain':
      return conflict('这条派工有一次结果不明的发布尝试；请先对账，不会自动重试');
    case 'publishing':
      return conflict('这条派工正在发布；请稍后刷新');
    case 'failed':
      return conflict('这条派工刚刚有失败的发布尝试；请刷新后再试');
  }
}

type OwnershipCheck = 'ok' | 'expired' | 'lost';

/**
 * 远端写之前重新核对：这条尝试仍然是「我在 publishing」且租约没过期。
 * claim 只能串行化同一 hub 里的写入，不是 GitHub 侧的栅栏；这里只保证「租期过了就不写」。
 */
async function checkOwnership(
  store: DelegationPublishStore,
  attempt: PublishAttempt,
  at: number
): Promise<OwnershipCheck> {
  const current = await store.byKey(attempt.delegationId, attempt.approvalKey);
  if (!current) return 'lost';
  if (current.state !== 'publishing' || current.claim === null || current.claim.token !== attempt.claim?.token) {
    return 'lost';
  }
  if (current.claim.expiresAt <= at) return 'expired';
  return 'ok';
}

/** 领取：没有就插入（原子），明确失败就 CAS 回 publishing；其它状态不碰。 */
async function claimAttempt(
  store: DelegationPublishStore,
  previous: PublishAttempt | null,
  input: PublishAttemptInsert
): Promise<Result<PublishAttempt, DomainError>> {
  if (previous) {
    if (previous.state !== 'failed') return err(conflict('这次发布不在可重试状态'));
    const cas = await store.compareAndSet({
      delegationId: input.delegationId,
      approvalKey: input.approvalKey,
      expect: { state: 'failed', claimToken: null },
      state: 'publishing',
      at: input.at,
      claim: input.claim
    });
    if (!cas.ok || !cas.attempt) {
      const blocker = cas.attempt;
      if (blocker && blocker.approvalKey !== input.approvalKey && blocker.state !== 'failed') {
        return err(blockedProblem(blocker));
      }
      return err(conflict('发布尝试已被并发修改，请刷新'));
    }
    if (cas.attempt.approvalKey !== input.approvalKey) return err(blockedProblem(cas.attempt));
    if (cas.attempt.state !== 'publishing' || cas.attempt.claim?.token !== input.claim.token) {
      return err(conflict('发布尝试已被并发修改，请刷新'));
    }
    return ok(cas.attempt);
  }
  const inserted = await store.insert(input);
  if (inserted.outcome === 'created') return ok(inserted.attempt);
  if (inserted.outcome === 'exists') return err(conflict('发布尝试已被并发创建，请刷新'));
  // blocked：同一派工的另一条批准键正在 / 已经发布。认领本身是原子的，所以到这里还没碰远端。
  if (inserted.attempt.approvalKey === input.approvalKey) return err(conflict('发布尝试已被并发创建，请刷新'));
  return err(blockedProblem(inserted.attempt));
}

/** 落定一次尝试。CAS 失败返回 null（调用方决定是重放还是 conflict）。 */
async function settle(
  store: DelegationPublishStore,
  attempt: PublishAttempt,
  input: {
    readonly state: PublishAttemptState;
    readonly at: number;
    readonly remote?: PublishRemoteFacts;
    readonly pullRequest?: PublishedPullRequest;
    readonly failure?: DelegationFailure;
  }
): Promise<PublishAttempt | null> {
  const cas = await store.compareAndSet({
    delegationId: attempt.delegationId,
    approvalKey: attempt.approvalKey,
    expect: { state: attempt.state, claimToken: attempt.claim?.token ?? null },
    state: input.state,
    at: input.at,
    claim: null,
    ...(input.remote === undefined ? {} : { remote: input.remote }),
    ...(input.pullRequest === undefined ? {} : { pullRequest: input.pullRequest }),
    failure: input.failure ?? null
  });
  return cas.ok ? cas.attempt : null;
}

/**
 * 只读对账：`publishRef verifyOnly` + 按 head 列 PR，绝不 push / 建 PR。
 * 结论只有三种：认领已有 PR（published）、远端已发布但没有 PR（failed，可安全重试创建）、
 * 或仍然证明不了（uncertain）。
 */
async function reconcileReadOnly(
  deps: Pick<Deps, 'now'>,
  store: DelegationPublishStore,
  bridges: WorkspaceDelegationPublishBridges,
  record: WorkspaceDelegation,
  project: Project,
  repoName: string,
  attempt: PublishAttempt
): Promise<Result<PublishDelegationRun, DomainError>> {
  const target = await bridges.resolveTarget(record);
  if (!target.ok) return target;
  const mismatch = targetProblem(record, target.value);
  if (mismatch) return err(conflict(`工作树的${mismatch}与派工记录不一致，不能对账`));
  if (target.value.headSha !== attempt.headSha) return err(conflict('worktree 已经不在这次发布的提交上，无法对账'));

  const git = bridges.git(record.workerId);
  if (typeof git.publishRef !== 'function') return err(unavailable('这台机器不支持核验发布结果（Worker 版本过旧）'));
  const host = bridges.gitHost ? await bridges.gitHost(project) : null;
  if (!host) return err(unavailable('项目没有可用的 GitHub 应用凭据，无法核对 PR'));
  const auth = bridges.repoAuth ? await bridges.repoAuth(record) : null;

  const expected = { repo: repoName, headRef: record.branch, headSha: attempt.headSha, base: record.baseBranch };
  let verified: PublishRefOutcome;
  try {
    const outcome = await git.publishRef({
      path: record.worktreePath,
      branch: record.branch,
      sha: attempt.headSha,
      expectedUrl: record.repoUrl,
      baseBranch: record.baseBranch,
      ...(auth ? { auth } : {}),
      verifyOnly: true
    });
    if (!outcome.ok) {
      await markUnverifiable(store, attempt, deps.now());
      return err(unavailable('暂时读不到远端状态，结果仍然不明；请稍后再对账'));
    }
    verified = outcome.value;
  } catch {
    await markUnverifiable(store, attempt, deps.now());
    return err(unavailable('暂时读不到远端状态，结果仍然不明；请稍后再对账'));
  }

  if (verified.uncertain) {
    const cas = await settle(store, attempt, {
      state: 'uncertain',
      at: deps.now(),
      remote: remoteFacts(verified),
      failure: { kind: 'uncertain', message: '远端状态无法确认，尚未创建 PR', at: deps.now() }
    });
    return cas ? ok(run(record, cas, { attempted: false, replayed: false, reconciled: true })) : err(conflict('对账结果被并发修改'));
  }

  const listed = await host.api.listPullRequestsByHead({ token: host.token, repo: repoName, head: record.branch }).catch(() => ({ ok: false as const, reason: 'list failed' }));
  if (!listed.ok) {
    const cas = await settle(store, attempt, {
      state: 'uncertain',
      at: deps.now(),
      remote: remoteFacts(verified),
      failure: { kind: 'uncertain', message: '无法列出 PR，结果仍然不明', at: deps.now() }
    });
    return cas ? err(unavailable('无法列出 PR，结果仍然不明；请稍后再对账')) : err(conflict('对账结果被并发修改'));
  }

  const adoptable = listed.prs.filter((pr) => pullRequestProblem(pr, expected) === null);
  if (adoptable.length > 1) {
    const cas = await settle(store, attempt, {
      state: 'uncertain',
      at: deps.now(),
      remote: remoteFacts(verified),
      failure: { kind: 'uncertain', message: '同一 head 上有多条符合的草稿 PR', at: deps.now() }
    });
    return cas ? ok(run(record, cas, { attempted: false, replayed: false, reconciled: true })) : err(conflict('对账结果被并发修改'));
  }
  if (adoptable.length === 1) {
    if (!verified.published) {
      // 远端分支不在这个提交、却有对应 PR：两处事实矛盾，只能保持不确定。
      const cas = await settle(store, attempt, {
        state: 'uncertain',
        at: deps.now(),
        remote: remoteFacts(verified),
        failure: { kind: 'uncertain', message: '远端分支与 PR 状态互相矛盾', at: deps.now() }
      });
      return cas ? ok(run(record, cas, { attempted: false, replayed: false, reconciled: true })) : err(conflict('对账结果被并发修改'));
    }
    const cas = await settle(store, attempt, {
      state: 'published',
      at: deps.now(),
      remote: remoteFacts(verified),
      pullRequest: toPublishedPullRequest(adoptable[0]!, expected)
    });
    if (!cas) return err(conflict('对账结果被并发修改'));
    return ok(run(record, cas, { attempted: false, replayed: false, reconciled: true }));
  }

  // 没有唯一匹配的草稿 PR：远端分支在不在都证明不了「没创建过 PR」——
  // 创建可能还在飞行、GitHub 列表会短暂滞后、PR 也可能已经关闭。所以只保持不确定。
  if (attempt.state === 'failed') {
    // 已经是「证明过没有副作用」的失败：对账不改写它，也不再做任何远端写。
    return ok(run(record, attempt, { attempted: false, replayed: false, reconciled: true }));
  }
  const cas = await settle(store, attempt, {
    state: 'uncertain',
    at: deps.now(),
    remote: remoteFacts(verified),
    failure: { kind: 'uncertain', message: '对账没有找到可唯一认领的草稿 PR，结果仍然不明', at: deps.now() }
  });
  if (!cas) return err(conflict('对账结果被并发修改，请刷新后重看'));
  return ok(run(record, cas, { attempted: false, replayed: false, reconciled: true }));
}

/** 对账读不到远端时：不把「读不到」当结论；已证明无副作用的 failed 保持原样。 */
async function markUnverifiable(store: DelegationPublishStore, attempt: PublishAttempt, at: number): Promise<void> {
  if (attempt.state === 'failed') return;
  await settle(store, attempt, {
    state: 'uncertain',
    at,
    failure: { kind: 'uncertain', message: '对账暂时读不到远端状态', at }
  });
}
