import { isPublished, type Asset, type AssetKind, type AssetRevision, type AssetScope, type IncomingFile } from '../asset.ts';
import {
  DEFAULT_REVIEW_SETTINGS,
  HUB_REVIEW_KEY,
  attainableApprovals,
  checkDecider,
  checkReason,
  checkReviewer,
  eligibleReviewers,
  hasHighFinding,
  isMcpStdio,
  mcpRiskSummary,
  parseSecretKey,
  requiredApprovals,
  scanAssetFiles,
  secretKey,
  secretLookupOrder,
  type AssetReviewSettings,
  type AssetSubmission,
  type InstallRequest,
  type Notification,
  type NotificationKind,
  type ReviewComment,
  type ReviewReport,
  type ReviewerContext,
  type SecretRefStatus,
  type SubmissionOrigin
} from '../asset-review.ts';
import { can, type AccessContext, type Resource } from '../access.ts';
import type { AuditAction, Principal, User, UserId, TeamId } from '../account.ts';
import { conflict, forbidden, invalid, notFound, type DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import { MCP_CONFIG_FILE, checkSecretName, mcpSecretRefs, parseMcpConfig, type McpConfig } from '../mcp.ts';
import { err, ok, type Result } from '../result.ts';
import type { AuditLog } from '../ports/audit-log.ts';
import type { AssetReviewRepository, NotificationRepository } from '../ports/asset-review-repository.ts';
import type { UserRepository } from '../ports/user-repository.ts';
import type { TeamRepository } from '../ports/team-repository.ts';
import type { AccessPolicy } from './authorization.ts';
import {
  ASSET_KIND_LABEL,
  checkAllAssetUpdates,
  checkAssetUpdate,
  importGitAsset,
  setSecret,
  syncWorkerAssets,
  uploadAsset,
  uploadAssetRevision,
  type AssetDeps
} from './assets.ts';

/**
 * 资产上架与审核的用例（ADR 0016）。规则在 asset-review.ts（纯函数），这里只编排：
 * 查谁、存什么、通知谁、审计怎么写。所有写操作都要一个 Principal（谁干的），审计里带上它（令牌来的再带令牌 id）。
 */
export interface AssetReviewDeps extends AssetDeps {
  readonly review: AssetReviewRepository;
  readonly notifications: NotificationRepository;
  readonly audit: AuditLog;
  readonly users: Pick<UserRepository, 'byId' | 'firstClusterAdmin'>;
  readonly teams: Pick<TeamRepository, 'byId'>;
  /** 机器当资源（本机 / 谁接入的）。 */
  readonly policy: Pick<AccessPolicy, 'context' | 'worker'>;
}

const SYSTEM = 'system';
const decoder = new TextDecoder('utf-8', { fatal: true });
const textOf = (data: Uint8Array | null): string | null => {
  if (data === null || data.includes(0)) return null;
  try {
    return decoder.decode(data);
  } catch {
    return null;
  }
};

// ---------- 小工具 ----------

async function audit(
  deps: Pick<AssetReviewDeps, 'audit' | 'now'>,
  actor: Principal | null,
  action: Extract<AuditAction, `asset.${string}`>,
  target: string,
  detail: string,
  teamId: string | null
): Promise<void> {
  const via = actor?.via ? `（经令牌 ${actor.via.name} / ${actor.via.tokenId}）` : '';
  await deps.audit.append({
    id: newId(),
    actorId: (actor?.user.id ?? SYSTEM) as UserId,
    actorEmail: actor?.user.email ?? '自动检查',
    action,
    target,
    detail: detail + via,
    at: deps.now(),
    teamId
  });
}

async function notify(
  deps: Pick<AssetReviewDeps, 'notifications' | 'now'>,
  userIds: readonly (string | null | undefined)[],
  except: readonly (string | null | undefined)[],
  kind: NotificationKind,
  title: string,
  body: string,
  link: string
): Promise<void> {
  const skip = new Set([SYSTEM, '', ...except.filter((id): id is string => !!id)]);
  for (const userId of new Set(userIds.filter((id): id is string => !!id))) {
    if (skip.has(userId)) continue;
    const note: Notification = { id: newId(), userId, kind, title, body, link, at: deps.now(), readAt: null };
    await deps.notifications.add(note);
  }
}

const label = (asset: Pick<Asset, 'kind' | 'name'>) => `${ASSET_KIND_LABEL[asset.kind]}「${asset.name}」`;
const reviewLink = (submissionId: string) => `#/assets/review/${submissionId}`;
const assetLink = (assetId: string) => `#/assets/item/${assetId}`;

async function settingsFor(deps: Pick<AssetReviewDeps, 'review'>, scope: AssetScope, teamId: string | null): Promise<AssetReviewSettings> {
  const key = scope === 'global' ? HUB_REVIEW_KEY : (teamId ?? HUB_REVIEW_KEY);
  return (await deps.review.settings(key)) ?? DEFAULT_REVIEW_SETTINGS;
}

/** 审这个资产时谁说了算：hub 管理员、资产团队的负责人、团队设置里仍在本团队的指定审核人。 */
export async function reviewerContext(
  deps: Pick<AssetReviewDeps, 'review' | 'users' | 'teams'>,
  asset: Pick<Asset, 'teamId'>
): Promise<ReviewerContext> {
  const admin = await deps.users.firstClusterAdmin();
  const team = asset.teamId ? await deps.teams.byId(asset.teamId as TeamId) : null;
  const settings = asset.teamId ? ((await deps.review.settings(asset.teamId)) ?? DEFAULT_REVIEW_SETTINGS) : DEFAULT_REVIEW_SETTINGS;
  const reviewers: string[] = [];
  for (const id of settings.reviewers) {
    const user = await deps.users.byId(id as UserId);
    if (user && user.teamId === asset.teamId && user.disabledAt === null && user.deletedAt === null) reviewers.push(user.id);
  }
  const hubReviewers: string[] = [];
  for (const id of ((await deps.review.settings(HUB_REVIEW_KEY)) ?? DEFAULT_REVIEW_SETTINGS).reviewers) {
    const user = await deps.users.byId(id as UserId);
    if (user && user.disabledAt === null && user.deletedAt === null) hubReviewers.push(user.id);
  }
  return { hubAdminId: admin?.id ?? null, teamOwnerId: team?.ownerId ?? null, reviewers, hubReviewers };
}

async function mcpConfigAt(deps: Pick<AssetDeps, 'assets'>, assetId: string, digest: string): Promise<McpConfig | null> {
  if (!digest) return null;
  const revision = await deps.assets.revision(assetId, digest);
  const file = revision?.files.find((candidate) => candidate.path === MCP_CONFIG_FILE);
  const data = file ? await deps.assets.blob(file.sha256) : null;
  const parsed = data ? parseMcpConfig(new TextDecoder().decode(data)) : null;
  return parsed?.ok ? parsed.value : null;
}

/** 提交时的自动检查：脚本 / 提示注入扫描、MCP 风险摘要、引用的密钥在哪一层取得到。 */
export async function buildReviewReport(
  deps: Pick<AssetReviewDeps, 'assets' | 'secrets' | 'users'>,
  asset: Asset,
  digest: string,
  previous: string,
  targetScope: AssetScope | null = null
): Promise<ReviewReport> {
  const revision = await deps.assets.revision(asset.id, digest);
  const before = previous ? await deps.assets.revision(asset.id, previous) : null;
  const old = new Map((before?.files ?? []).map((file) => [file.path, file.sha256]));
  const files: { path: string; text: string | null }[] = [];
  let changed = 0;
  for (const file of revision?.files ?? []) {
    if (old.get(file.path) !== file.sha256) changed += 1;
    files.push({ path: file.path, text: textOf(await deps.assets.blob(file.sha256)) });
  }
  changed += [...old.keys()].filter((path) => !(revision?.files ?? []).some((file) => file.path === path)).length;
  const findings = scanAssetFiles(files);
  let mcp = null;
  let secrets: SecretRefStatus[] = [];
  if (asset.kind === 'mcp') {
    const config = await mcpConfigAt(deps, asset.id, digest);
    if (config) {
      mcp = mcpRiskSummary(config, await mcpConfigAt(deps, asset.id, previous));
      const admin = await deps.users.firstClusterAdmin();
      const stored = new Set((await deps.secrets.list()).map((secret) => secret.name));
      const scoped = { ...asset, scope: targetScope ?? asset.scope };
      secrets = mcpSecretRefs(config).map((name) => {
        const hit = secretLookupOrder(scoped, name, admin?.id ?? null).find((step) => stored.has(step.key));
        return { name, from: hit?.layer ?? null };
      });
    }
  }
  return { findings, mcp, secrets, filesChanged: changed };
}

// ---------- 可见性与管理权 ----------

/** 这个人能不能看到这个资产（目录 / 详情）。全局人人可见；团队 / 项目同团队；个人只有作者。 */
export function canSeeAsset(actor: Principal, asset: Asset): boolean {
  if (asset.ownerId === actor.user.id) return true;
  if (!can(actor, 'asset.read')) return false;
  if (asset.scope === 'global') return isPublished(asset) || actor.user.clusterAdmin;
  if (asset.scope === 'personal') return false;
  return asset.teamId !== null && asset.teamId === actor.user.teamId;
}

/** 能不能给这个资产传新版本 / 撤回 / 提升：作者、同团队负责人（team 范围 asset.submit），全局资产还有 hub 管理员。 */
function canMaintain(actor: Principal, asset: Asset, permission: 'asset.submit' | 'asset.retire'): boolean {
  if (asset.scope === 'global' && actor.user.clusterAdmin && !actor.via) return true;
  const resource: Resource = { teamId: asset.teamId, createdBy: asset.ownerId };
  if (asset.scope === 'personal') return asset.ownerId === actor.user.id && can(actor, permission);
  if (asset.scope === 'global') return asset.ownerId === actor.user.id && can(actor, permission);
  return can(actor, permission, resource);
}

// ---------- 提交 ----------

async function openSubmission(
  deps: AssetReviewDeps,
  actor: Principal | null,
  asset: Asset,
  digest: string,
  origin: SubmissionOrigin,
  targetScope: AssetScope | null = null
): Promise<Result<{ asset: Asset; submission: AssetSubmission }, DomainError>> {
  const pending = await deps.review.submissions({ assetId: asset.id, status: ['pending'] });
  const same = pending.find((sub) => sub.digest === digest && sub.targetScope === targetScope);
  if (same) return ok({ asset, submission: same });
  const at = deps.now();
  for (const old of pending) {
    if (old.targetScope !== targetScope) continue;
    await deps.review.updateSubmission({ ...old, status: 'superseded', decidedAt: at, reason: '被更新的提交取代' });
  }
  const scope = targetScope ?? asset.scope;
  const report = await buildReviewReport(deps, asset, digest, asset.pinned, targetScope);
  const config = asset.kind === 'mcp' ? await mcpConfigAt(deps, asset.id, digest) : null;
  const settings = await settingsFor(deps, scope, asset.teamId);
  const submission: AssetSubmission = {
    id: newId(),
    assetId: asset.id,
    digest,
    previous: asset.pinned,
    submittedBy: actor?.user.id ?? SYSTEM,
    origin,
    tokenId: actor?.via?.tokenId ?? null,
    targetScope,
    status: 'pending',
    required: requiredApprovals(scope, isMcpStdio(asset.kind, config), settings),
    approvals: [],
    decidedBy: null,
    reason: null,
    report,
    createdAt: at,
    decidedAt: null
  };
  await deps.review.addSubmission(submission);
  const what = targetScope ? `申请提升到全局` : `版本 ${digest.slice(0, 12)}`;
  await audit(deps, actor, 'asset.submit', asset.name, `${label(asset)} 提交审核：${what}（${origin}）`, asset.teamId);
  // 1A：个人资产免审，提交即发布
  if (submission.required === 0) {
    const published = await publish(deps, actor, asset, submission, '个人资产免审（1A）');
    return ok({ asset: published, submission: (await deps.review.submission(submission.id)) ?? submission });
  }
  const ctx = await reviewerContext(deps, asset);
  const { ids, routedToHub } = eligibleReviewers(asset, submission, ctx);
  await notify(
    deps,
    ids,
    [],
    'review.requested',
    `待审核：${label(asset)}`,
    `${actor?.user.email ?? 'Git 自动检查'} 提交了${what}${routedToHub ? '（单人团队 / 负责人自己的提交，转 hub 管理员审）' : ''}`,
    reviewLink(submission.id)
  );
  return ok({ asset, submission });
}

async function publish(
  deps: AssetReviewDeps,
  actor: Principal | null,
  asset: Asset,
  submission: AssetSubmission,
  why: string
): Promise<Asset> {
  const revision = await deps.assets.revision(asset.id, submission.digest);
  const scope = submission.targetScope ?? asset.scope;
  const next: Asset = {
    ...asset,
    pinned: submission.digest,
    description: revision?.description ?? asset.description,
    scope,
    projectId: scope === 'project' ? asset.projectId : null,
    updatedAt: deps.now()
  };
  await deps.assets.update(next);
  await deps.review.updateSubmission({ ...submission, status: 'approved', decidedAt: deps.now(), decidedBy: actor?.user.id ?? SYSTEM });
  await audit(deps, actor, 'asset.publish', asset.name, `${label(asset)} 发布 ${submission.digest.slice(0, 12)}（${why}）`, asset.teamId);
  const holders = (await deps.assets.installations()).filter((row) => row.assetId === asset.id);
  for (const { workerId } of holders) void syncWorkerAssets(deps, workerId);
  return next;
}

export type SubmitAssetInput =
  | { readonly from: 'upload'; readonly kind: AssetKind; readonly scope: AssetScope; readonly projectId?: string | null; readonly name?: string | null; readonly files: readonly IncomingFile[] }
  | {
      readonly from: 'git';
      readonly kind: AssetKind;
      readonly scope: AssetScope;
      readonly projectId?: string | null;
      readonly name?: string | null;
      readonly url: string;
      readonly ref: string | null;
      readonly path: string;
    };

/**
 * 上架一个新资产：建资产（未发布）+ 第一个提交。项目级的「能不能改这个项目」由调用方（路由）先查过。
 * 全局只有集群管理员能直接上架；成员要全局走「提升」。
 */
export async function submitNewAsset(
  deps: AssetReviewDeps,
  actor: Principal,
  input: SubmitAssetInput
): Promise<Result<{ asset: Asset; submission: AssetSubmission }, DomainError>> {
  if (!can(actor, 'asset.submit')) return err(forbidden('你没有上架资产的权限'));
  if (input.scope === 'global' && !can(actor, 'asset.publish_global')) return err(forbidden('全局资产只有集群管理员能直接上架：先上架到团队，再申请提升到全局'));
  if (input.scope !== 'global' && !actor.user.teamId) return err(invalid('你还没有团队'));
  const ownership = { scope: input.scope, ownerId: actor.user.id, teamId: actor.user.teamId, publish: false } as const;
  const made =
    input.from === 'upload'
      ? await uploadAsset(deps, { kind: input.kind, name: input.name ?? null, files: input.files, projectId: input.projectId ?? null, ...ownership })
      : await importGitAsset(deps, {
          kind: input.kind,
          url: input.url,
          ref: input.ref,
          path: input.path,
          name: input.name ?? null,
          projectId: input.projectId ?? null,
          ...ownership
        });
  if (!made.ok) return made;
  await audit(deps, actor, 'asset.create', made.value.name, `上架${label(made.value)}（${input.scope}）`, made.value.teamId);
  return openSubmission(deps, actor, made.value, made.value.latest, actor.via ? 'token' : 'user');
}

/** 给已有资产交一个新版本（上传）。和已发布的相同就不提交。 */
export async function submitAssetRevision(
  deps: AssetReviewDeps,
  actor: Principal,
  assetId: string,
  files: readonly IncomingFile[]
): Promise<Result<{ asset: Asset; submission: AssetSubmission | null }, DomainError>> {
  const asset = await deps.assets.get(assetId);
  if (!asset || !canSeeAsset(actor, asset)) return err(notFound('没有这个资产'));
  if (!canMaintain(actor, asset, 'asset.submit')) return err(forbidden('只有作者（或团队负责人）能给它交新版本'));
  const offered = await uploadAssetRevision(deps, assetId, files);
  if (!offered.ok) return offered;
  await audit(deps, actor, 'asset.revision', asset.name, `${label(asset)} 新版本 ${offered.value.asset.latest.slice(0, 12)}`, asset.teamId);
  if (offered.value.asset.latest === asset.pinned) return ok({ asset: offered.value.asset, submission: null });
  const opened = await openSubmission(deps, actor, offered.value.asset, offered.value.asset.latest, actor.via ? 'token' : 'user');
  if (!opened.ok) return opened;
  return ok(opened.value);
}

/** 5A：Git 来源有新内容 → 自动成为待审提交；旧的钉住版本照常下发。 */
export async function checkGitForReview(
  deps: AssetReviewDeps,
  actor: Principal | null,
  assetId: string
): Promise<Result<{ asset: Asset; submission: AssetSubmission | null }, DomainError>> {
  const asset = await deps.assets.get(assetId);
  if (!asset || (actor && !canSeeAsset(actor, asset))) return err(notFound('没有这个资产'));
  if (actor && !canMaintain(actor, asset, 'asset.submit')) return err(forbidden('只有作者（或团队负责人）能检查更新'));
  const checked = await checkAssetUpdate(deps, assetId);
  if (!checked.ok) return checked;
  const next = checked.value.asset;
  if (next.latest === next.pinned) return ok({ asset: next, submission: null });
  const opened = await openSubmission(deps, actor, next, next.latest, 'git');
  if (!opened.ok) return opened;
  return ok(opened.value);
}

/** 定时巡检：所有 Git 来源的资产有新内容就开待审提交。 */
export async function sweepGitForReview(deps: AssetReviewDeps): Promise<{ checked: number; submitted: number; failed: number }> {
  const sweep = await checkAllAssetUpdates(deps);
  let submitted = 0;
  for (const asset of sweep.changed) {
    const opened = await openSubmission(deps, null, asset, asset.latest, 'git');
    if (opened.ok) submitted += 1;
  }
  return { checked: sweep.checked, submitted, failed: sweep.failed.length };
}

/** 团队 / 项目资产申请提升到全局：hub 管理员审。 */
export async function promoteAsset(deps: AssetReviewDeps, actor: Principal, assetId: string): Promise<Result<AssetSubmission, DomainError>> {
  const asset = await deps.assets.get(assetId);
  if (!asset || !canSeeAsset(actor, asset)) return err(notFound('没有这个资产'));
  if (asset.scope === 'global') return err(invalid('已经是全局资产'));
  if (asset.scope === 'personal') return err(invalid('个人资产先上架到团队，再申请提升到全局'));
  if (!isPublished(asset)) return err(invalid('先让当前版本通过团队审核'));
  if (!canMaintain(actor, asset, 'asset.submit')) return err(forbidden('只有作者（或团队负责人）能申请提升'));
  if (await deps.assets.findInScope(asset.kind, asset.name, 'global', '')) return err(conflict(`全局已经有叫「${asset.name}」的${ASSET_KIND_LABEL[asset.kind]}了`));
  const opened = await openSubmission(deps, actor, asset, asset.pinned, actor.via ? 'token' : 'user', 'global');
  return opened.ok ? ok(opened.value.submission) : opened;
}

// ---------- 审核 ----------

async function loadSubmission(deps: AssetReviewDeps, submissionId: string): Promise<Result<{ submission: AssetSubmission; asset: Asset }, DomainError>> {
  const submission = await deps.review.submission(submissionId);
  const asset = submission ? await deps.assets.get(submission.assetId) : null;
  if (!submission || !asset) return err(notFound('没有这次提交'));
  return ok({ submission, asset });
}

const reviewer = (actor: Principal) => ({ id: actor.user.id, hubAdmin: actor.user.clusterAdmin });

/** 通过一票。高风险发现要显式确认（acknowledgeHigh）。票够了就发布。 */
export async function approveSubmission(
  deps: AssetReviewDeps,
  actor: Principal,
  submissionId: string,
  options: { acknowledgeHigh?: boolean; note?: string } = {}
): Promise<Result<{ submission: AssetSubmission; published: boolean; selfApproved: boolean }, DomainError>> {
  if (actor.via) return err(forbidden('令牌不能审核资产'));
  const loaded = await loadSubmission(deps, submissionId);
  if (!loaded.ok) return loaded;
  const { submission, asset } = loaded.value;
  const ctx = await reviewerContext(deps, asset);
  const checked = checkReviewer(asset, submission, reviewer(actor), ctx);
  if (!checked.ok) {
    if (checked.error.code === 'forbidden' && (actor.user.id === submission.submittedBy || actor.user.id === asset.ownerId)) {
      await audit(deps, actor, 'asset.approve', asset.name, `⛔ 自审被拦下：${label(asset)} ${submission.digest.slice(0, 12)}`, asset.teamId);
    }
    return checked;
  }
  if (hasHighFinding(submission.report) && !options.acknowledgeHigh) return err(invalid('自动检查有高风险发现：逐条看过后勾选「我已确认高风险项」再通过'));
  const selfApproved = checked.value.selfApproved;
  const approvals = [...submission.approvals, { userId: actor.user.id, at: deps.now(), selfApproved }];
  const eligible = eligibleReviewers(asset, submission, ctx).ids.length;
  const needed = attainableApprovals(submission.required, eligible);
  const voted: AssetSubmission = { ...submission, approvals };
  await deps.review.updateSubmission(voted);
  await audit(
    deps,
    actor,
    selfApproved ? 'asset.self_approve' : 'asset.approve',
    asset.name,
    `${selfApproved ? '⚠ 自审（hub 管理员）' : '通过'}：${label(asset)} ${submission.digest.slice(0, 12)}（${approvals.length}/${needed}）${
      needed < submission.required ? `；合格审核人只有 ${eligible} 位，双人审核降为 ${needed} 票` : ''
    }${options.note ? `；备注：${options.note.slice(0, 200)}` : ''}`,
    asset.teamId
  );
  if (approvals.length < needed) {
    const others = eligibleReviewers(asset, voted, ctx).ids.filter((id) => !approvals.some((vote) => vote.userId === id));
    await notify(deps, others, [actor.user.id], 'review.requested', `还差一票：${label(asset)}`, `${actor.user.email} 已通过，需要第二位审核人`, reviewLink(submission.id));
    return ok({ submission: voted, published: false, selfApproved });
  }
  if (submission.targetScope === 'global') {
    const clash = await deps.assets.findInScope(asset.kind, asset.name, 'global', '');
    if (clash && clash.id !== asset.id) return err(conflict(`全局已经有叫「${asset.name}」的${ASSET_KIND_LABEL[asset.kind]}了`));
  }
  await publish(deps, actor, asset, voted, selfApproved ? 'hub 管理员自审，已打标记' : '审核通过');
  await notify(
    deps,
    [submission.submittedBy, asset.ownerId],
    [actor.user.id],
    'review.approved',
    `已发布：${label(asset)}`,
    `${actor.user.email} 通过了 ${submission.digest.slice(0, 12)}${submission.targetScope ? '，已提升到全局' : ''}`,
    assetLink(asset.id)
  );
  return ok({ submission: (await deps.review.submission(submission.id)) ?? voted, published: true, selfApproved });
}

/** 驳回（终止）或要求修改（作者改好再交新版本）。都必须写理由。 */
export async function rejectSubmission(
  deps: AssetReviewDeps,
  actor: Principal,
  submissionId: string,
  input: { reason: string; changesRequested?: boolean }
): Promise<Result<AssetSubmission, DomainError>> {
  if (actor.via) return err(forbidden('令牌不能审核资产'));
  const reason = checkReason(input.reason);
  if (!reason.ok) return reason;
  const loaded = await loadSubmission(deps, submissionId);
  if (!loaded.ok) return loaded;
  const { submission, asset } = loaded.value;
  const ctx = await reviewerContext(deps, asset);
  const checked = checkDecider(asset, submission, reviewer(actor), ctx);
  if (!checked.ok) return checked;
  const changes = input.changesRequested === true;
  const next: AssetSubmission = {
    ...submission,
    status: changes ? 'changes_requested' : 'rejected',
    reason: reason.value,
    decidedBy: actor.user.id,
    decidedAt: deps.now()
  };
  await deps.review.updateSubmission(next);
  await audit(deps, actor, changes ? 'asset.request_changes' : 'asset.reject', asset.name, `${label(asset)} ${submission.digest.slice(0, 12)}：${reason.value}`, asset.teamId);
  await notify(
    deps,
    [submission.submittedBy, asset.ownerId],
    [actor.user.id],
    changes ? 'review.changes' : 'review.rejected',
    `${changes ? '要求修改' : '被驳回'}：${label(asset)}`,
    reason.value,
    reviewLink(submission.id)
  );
  return ok(next);
}

/** 提交人 / 作者撤回待审的提交。 */
export async function withdrawSubmission(deps: AssetReviewDeps, actor: Principal, submissionId: string): Promise<Result<AssetSubmission, DomainError>> {
  const loaded = await loadSubmission(deps, submissionId);
  if (!loaded.ok) return loaded;
  const { submission, asset } = loaded.value;
  if (submission.status !== 'pending') return err(invalid('这次提交已经处理过了'));
  if (actor.user.id !== submission.submittedBy && actor.user.id !== asset.ownerId && !canMaintain(actor, asset, 'asset.retire')) {
    return err(forbidden('只有提交人或作者能撤回'));
  }
  const next: AssetSubmission = { ...submission, status: 'withdrawn', decidedBy: actor.user.id, decidedAt: deps.now() };
  await deps.review.updateSubmission(next);
  await audit(deps, actor, 'asset.withdraw', asset.name, `${label(asset)} 撤回 ${submission.digest.slice(0, 12)}`, asset.teamId);
  return ok(next);
}

/** 行内评论（path + line 可空 = 整体评论）。审核人、提交人、作者能评。 */
export async function commentOnSubmission(
  deps: AssetReviewDeps,
  actor: Principal,
  submissionId: string,
  input: { path?: string | null; line?: number | null; body: string }
): Promise<Result<ReviewComment, DomainError>> {
  if (actor.via) return err(forbidden('令牌不能评论'));
  const loaded = await loadSubmission(deps, submissionId);
  if (!loaded.ok) return loaded;
  const { submission, asset } = loaded.value;
  const ctx = await reviewerContext(deps, asset);
  const reviewers = eligibleReviewers(asset, submission, ctx).ids;
  const involved = [submission.submittedBy, asset.ownerId, ...reviewers];
  if (!involved.includes(actor.user.id)) return err(forbidden('只有审核人、提交人和作者能评论'));
  const body = input.body.trim();
  if (body === '' || body.length > 4000) return err(invalid('评论 1–4000 字'));
  if (input.path) {
    const revision = await deps.assets.revision(asset.id, submission.digest);
    if (!revision?.files.some((file) => file.path === input.path)) return err(invalid('版本里没有这个文件'));
  }
  const comment: ReviewComment = {
    id: newId(),
    submissionId,
    authorId: actor.user.id,
    path: input.path ?? null,
    line: input.path && input.line ? Math.max(1, Math.floor(input.line)) : null,
    body,
    at: deps.now()
  };
  await deps.review.addComment(comment);
  await audit(deps, actor, 'asset.comment', asset.name, `${label(asset)} ${comment.path ? `${comment.path}:${comment.line ?? ''} ` : ''}评论`, asset.teamId);
  await notify(deps, involved, [actor.user.id], 'review.comment', `新评论：${label(asset)}`, body.slice(0, 200), reviewLink(submission.id));
  return ok(comment);
}

/** 下架：取消发布（pinned 清空），装了的机器下次同步时移除。作者、团队负责人、hub 管理员（全局）能做。 */
export async function revokeAsset(deps: AssetReviewDeps, actor: Principal, assetId: string, reasonText: string): Promise<Result<Asset, DomainError>> {
  if (actor.via) return err(forbidden('令牌不能下架资产'));
  const reason = checkReason(reasonText);
  if (!reason.ok) return reason;
  const asset = await deps.assets.get(assetId);
  if (!asset || !canSeeAsset(actor, asset)) return err(notFound('没有这个资产'));
  if (!canMaintain(actor, asset, 'asset.retire')) return err(forbidden('只有作者、团队负责人或 hub 管理员能下架'));
  if (!isPublished(asset)) return err(invalid('它还没发布'));
  const next: Asset = { ...asset, pinned: '', updatedAt: deps.now() };
  await deps.assets.update(next);
  await audit(deps, actor, 'asset.revoke', asset.name, `${label(asset)} 下架：${reason.value}`, asset.teamId);
  await notify(deps, [asset.ownerId], [actor.user.id], 'asset.revoked', `已下架：${label(asset)}`, reason.value, assetLink(asset.id));
  const holders = (await deps.assets.installations()).filter((row) => row.assetId === asset.id);
  for (const { workerId } of holders) void syncWorkerAssets(deps, workerId);
  return ok(next);
}

// ---------- 安装（1A / 6B） ----------

export type InstallOutcome = { readonly kind: 'installed' } | { readonly kind: 'uninstalled' } | { readonly kind: 'requested'; readonly request: InstallRequest };

/**
 * 装 / 卸资产：
 * - 本机 Worker 只有集群管理员能装（ADR 0011）。
 * - 个人资产只能装到作者自己接入的机器（1A）。
 * - 能管这台机器（worker.manage）→ 直接装；同团队共享机器 → 提安装申请，团队负责人批（6B）。
 */
export async function setAssetOnWorker(
  deps: AssetReviewDeps,
  actor: Principal,
  input: { assetId: string; workerId: string; installed: boolean }
): Promise<Result<InstallOutcome, DomainError>> {
  if (actor.via) return err(forbidden('令牌不能装资产'));
  const asset = await deps.assets.get(input.assetId);
  if (!asset || !canSeeAsset(actor, asset)) return err(notFound('没有这个资产'));
  const workers = await deps.workers.list();
  if (!workers.some((worker) => worker.workerId === input.workerId)) return err(notFound('没有这台机器'));
  const ctx = await deps.policy.context();
  const resource = await deps.policy.worker(input.workerId);
  if (!can(actor, 'worker.read', resource, ctx) && !(resource.local && actor.user.clusterAdmin)) return err(notFound('没有这台机器'));
  if (resource.local && !actor.user.clusterAdmin) return err(forbidden('本机 Worker 只有集群管理员能装资产'));
  const manage = can(actor, 'worker.manage', resource, ctx) && can(actor, 'asset.assign', resource, ctx);
  if (!input.installed) {
    if (!manage && !(asset.scope === 'personal' && asset.ownerId === actor.user.id && resource.createdBy === actor.user.id)) {
      return err(forbidden('只有能管理这台机器的人能卸资产'));
    }
    await deps.assets.uninstall(input.workerId, asset.id);
    await audit(deps, actor, 'asset.uninstall', asset.name, `从 ${input.workerId} 卸下${label(asset)}`, asset.teamId);
    void syncWorkerAssets(deps, input.workerId);
    return ok({ kind: 'uninstalled' });
  }
  if (!isPublished(asset)) return err(invalid('还没通过审核的资产不能装'));
  if (asset.scope === 'personal') {
    if (asset.ownerId !== actor.user.id || resource.createdBy !== actor.user.id || resource.local) {
      return err(forbidden('个人资产只能装到作者自己接入的机器上（1A）'));
    }
  }
  if (manage) {
    await deps.assets.install(input.workerId, asset.id, deps.now());
    await audit(deps, actor, 'asset.install', asset.name, `装到 ${input.workerId}：${label(asset)}`, asset.teamId);
    void syncWorkerAssets(deps, input.workerId);
    return ok({ kind: 'installed' });
  }
  const pending = await deps.review.installRequests({ status: 'pending', workerId: input.workerId, assetId: asset.id });
  if (pending[0]) return ok({ kind: 'requested', request: pending[0] });
  const request: InstallRequest = {
    id: newId(),
    assetId: asset.id,
    workerId: input.workerId,
    requestedBy: actor.user.id,
    status: 'pending',
    decidedBy: null,
    reason: null,
    createdAt: deps.now(),
    decidedAt: null
  };
  await deps.review.addInstallRequest(request);
  await audit(deps, actor, 'asset.install_request', asset.name, `申请装到 ${input.workerId}：${label(asset)}`, resource.teamId);
  const team = resource.teamId ? await deps.teams.byId(resource.teamId as TeamId) : null;
  await notify(deps, [team?.ownerId, resource.createdBy], [actor.user.id], 'install.requested', `安装申请：${label(asset)}`, `${actor.user.email} 想装到 ${input.workerId}`, '#/assets/requests');
  return ok({ kind: 'requested', request });
}

/** 团队负责人（能管这台机器的人）批 / 驳安装申请。 */
export async function decideInstallRequest(
  deps: AssetReviewDeps,
  actor: Principal,
  requestId: string,
  input: { approve: boolean; reason?: string }
): Promise<Result<InstallRequest, DomainError>> {
  if (actor.via) return err(forbidden('令牌不能处理安装申请'));
  const request = await deps.review.installRequest(requestId);
  if (!request) return err(notFound('没有这条申请'));
  if (request.status !== 'pending') return err(invalid('这条申请已经处理过了'));
  const ctx = await deps.policy.context();
  const resource = await deps.policy.worker(request.workerId);
  if (!can(actor, 'worker.manage', resource, ctx)) return err(forbidden('只有能管理这台机器的人（团队负责人）能批'));
  if (actor.user.id === request.requestedBy && !actor.user.clusterAdmin) return err(forbidden('不能批自己的申请'));
  const asset = await deps.assets.get(request.assetId);
  if (!asset) return err(notFound('资产已经删了'));
  if (input.approve && !isPublished(asset)) return err(invalid('资产已下架，不能装'));
  if (!input.approve) {
    const reason = checkReason(input.reason ?? '');
    if (!reason.ok) return reason;
  }
  const next: InstallRequest = {
    ...request,
    status: input.approve ? 'approved' : 'rejected',
    decidedBy: actor.user.id,
    reason: input.reason?.trim() || null,
    decidedAt: deps.now()
  };
  await deps.review.updateInstallRequest(next);
  if (input.approve) {
    await deps.assets.install(request.workerId, asset.id, deps.now());
    void syncWorkerAssets(deps, request.workerId);
  }
  await audit(deps, actor, 'asset.install_decide', asset.name, `${input.approve ? '批准' : '驳回'}安装到 ${request.workerId}${next.reason ? `：${next.reason}` : ''}`, resource.teamId);
  await notify(
    deps,
    [request.requestedBy],
    [actor.user.id],
    input.approve ? 'install.approved' : 'install.rejected',
    `${input.approve ? '已批准' : '被驳回'}：安装${label(asset)}`,
    next.reason ?? `装到 ${request.workerId}`,
    assetLink(asset.id)
  );
  return ok(next);
}

// ---------- 读 ----------

export interface MarketAsset {
  readonly asset: Asset;
  readonly owner: string;
  readonly published: boolean;
  /** 最近一次提交（任何状态）。 */
  readonly latestSubmission: Pick<AssetSubmission, 'id' | 'status' | 'digest' | 'reason' | 'createdAt' | 'targetScope'> | null;
  readonly workerIds: readonly string[];
  readonly canMaintain: boolean;
}

const nameOf = async (deps: Pick<AssetReviewDeps, 'users'>, id: string, cache: Map<string, string>): Promise<string> => {
  if (id === SYSTEM) return 'Git 自动检查';
  if (!id) return '—';
  if (!cache.has(id)) {
    const user = await deps.users.byId(id as UserId);
    cache.set(id, user ? user.displayName || user.email : '（已删除）');
  }
  return cache.get(id) ?? '—';
};

async function marketView(deps: AssetReviewDeps, actor: Principal, assets: readonly Asset[]): Promise<MarketAsset[]> {
  const installs = await deps.assets.installations();
  const cache = new Map<string, string>();
  const out: MarketAsset[] = [];
  for (const asset of assets) {
    const latest = (await deps.review.submissions({ assetId: asset.id }))[0] ?? null;
    out.push({
      asset,
      owner: await nameOf(deps, asset.ownerId, cache),
      published: isPublished(asset),
      latestSubmission: latest
        ? { id: latest.id, status: latest.status, digest: latest.digest, reason: latest.reason, createdAt: latest.createdAt, targetScope: latest.targetScope }
        : null,
      workerIds: installs.filter((row) => row.assetId === asset.id).map((row) => row.workerId),
      canMaintain: canMaintain(actor, asset, 'asset.submit')
    });
  }
  return out.sort((a, b) => a.asset.kind.localeCompare(b.asset.kind) || a.asset.name.localeCompare(b.asset.name));
}

/** 目录：已发布、我看得见的。 */
export async function assetCatalog(deps: AssetReviewDeps, actor: Principal): Promise<MarketAsset[]> {
  const all = await deps.assets.list();
  return marketView(deps, actor, all.filter((asset) => isPublished(asset) && canSeeAsset(actor, asset)));
}

/** 我的：我上架的（含未发布 / 被驳回的）。 */
export async function myAssets(deps: AssetReviewDeps, actor: Principal): Promise<MarketAsset[]> {
  const all = await deps.assets.list();
  return marketView(deps, actor, all.filter((asset) => asset.ownerId === actor.user.id));
}

export interface ReviewQueueItem {
  readonly submission: AssetSubmission;
  readonly asset: Asset;
  readonly submitter: string;
  readonly routedToHub: boolean;
}

/** 待我审：我是合格审核人且还没投过票的待审提交。 */
export async function reviewQueue(deps: AssetReviewDeps, actor: Principal): Promise<ReviewQueueItem[]> {
  if (actor.via) return [];
  const pending = await deps.review.submissions({ status: ['pending'] });
  const cache = new Map<string, string>();
  const out: ReviewQueueItem[] = [];
  for (const submission of pending) {
    const asset = await deps.assets.get(submission.assetId);
    if (!asset) continue;
    const ctx = await reviewerContext(deps, asset);
    const { ids, routedToHub } = eligibleReviewers(asset, submission, ctx);
    if (!ids.includes(actor.user.id) || submission.approvals.some((vote) => vote.userId === actor.user.id)) continue;
    out.push({ submission, asset, submitter: await nameOf(deps, submission.submittedBy, cache), routedToHub });
  }
  return out;
}

export interface SubmissionDetail {
  readonly submission: AssetSubmission;
  readonly asset: Asset;
  readonly revision: AssetRevision | null;
  readonly previous: AssetRevision | null;
  readonly comments: readonly (ReviewComment & { readonly author: string })[];
  readonly submitter: string;
  readonly approvers: readonly { readonly name: string; readonly selfApproved: boolean; readonly at: number }[];
  readonly reviewers: readonly string[];
  readonly canApprove: boolean;
  readonly approveBlocked: string | null;
  readonly canDecide: boolean;
  readonly canWithdraw: boolean;
  readonly needed: number;
}

/** 审核页：提交、两个版本、评论、我能做什么。 */
export async function submissionDetail(deps: AssetReviewDeps, actor: Principal, submissionId: string): Promise<Result<SubmissionDetail, DomainError>> {
  const loaded = await loadSubmission(deps, submissionId);
  if (!loaded.ok) return loaded;
  const { submission, asset } = loaded.value;
  const ctx = await reviewerContext(deps, asset);
  const { ids } = eligibleReviewers(asset, submission, ctx);
  const involved = ids.includes(actor.user.id) || actor.user.id === submission.submittedBy || actor.user.id === asset.ownerId;
  if (!involved && !canSeeAsset(actor, asset)) return err(notFound('没有这次提交'));
  const cache = new Map<string, string>();
  const approve = checkReviewer(asset, submission, reviewer(actor), ctx);
  const comments = await deps.review.comments(submission.id);
  return ok({
    submission,
    asset,
    revision: await deps.assets.revision(asset.id, submission.digest),
    previous: submission.previous ? await deps.assets.revision(asset.id, submission.previous) : null,
    comments: await Promise.all(comments.map(async (comment) => ({ ...comment, author: await nameOf(deps, comment.authorId, cache) }))),
    submitter: await nameOf(deps, submission.submittedBy, cache),
    approvers: await Promise.all(submission.approvals.map(async (vote) => ({ name: await nameOf(deps, vote.userId, cache), selfApproved: vote.selfApproved, at: vote.at }))),
    reviewers: await Promise.all(ids.map((id) => nameOf(deps, id, cache))),
    canApprove: approve.ok && !actor.via,
    approveBlocked: approve.ok ? null : submission.status === 'pending' ? approve.error.message : null,
    canDecide: checkDecider(asset, submission, reviewer(actor), ctx).ok && !actor.via,
    canWithdraw: submission.status === 'pending' && (actor.user.id === submission.submittedBy || actor.user.id === asset.ownerId),
    needed: attainableApprovals(submission.required, ids.length)
  });
}

/** 资产详情：资产、版本、提交历史；看不见就 404。 */
export async function marketAssetDetail(
  deps: AssetReviewDeps,
  actor: Principal,
  assetId: string
): Promise<Result<{ item: MarketAsset; revisions: AssetRevision[]; submissions: AssetSubmission[] }, DomainError>> {
  const asset = await deps.assets.get(assetId);
  if (!asset || !canSeeAsset(actor, asset)) return err(notFound('没有这个资产'));
  const [item] = await marketView(deps, actor, [asset]);
  return ok({ item: item as MarketAsset, revisions: await deps.assets.revisions(asset.id), submissions: await deps.review.submissions({ assetId: asset.id }) });
}

/** 安装申请：我能批的（我能管的机器上的）+ 我提的。 */
export async function installRequestsFor(
  deps: AssetReviewDeps,
  actor: Principal
): Promise<{ toDecide: (InstallRequest & { asset: string; requester: string })[]; mine: (InstallRequest & { asset: string })[] }> {
  const all = await deps.review.installRequests({});
  const ctx = await deps.policy.context();
  const cache = new Map<string, string>();
  const toDecide: (InstallRequest & { asset: string; requester: string })[] = [];
  const mine: (InstallRequest & { asset: string })[] = [];
  for (const request of all) {
    const asset = await deps.assets.get(request.assetId);
    const name = asset ? label(asset) : '（已删除的资产）';
    if (request.requestedBy === actor.user.id) mine.push({ ...request, asset: name });
    if (request.status === 'pending' && can(actor, 'worker.manage', await deps.policy.worker(request.workerId), ctx) && request.requestedBy !== actor.user.id) {
      toDecide.push({ ...request, asset: name, requester: await nameOf(deps, request.requestedBy, cache) });
    }
  }
  return { toDecide, mine };
}

/** 资产市场能选的机器：我看得见的，标上「能直接装 / 要申请 / 只有集群管理员」。 */
export async function marketWorkers(
  deps: AssetReviewDeps,
  actor: Principal
): Promise<{ workerId: string; label: string; state: string; local: boolean; mine: boolean; mode: 'install' | 'request' | 'none' }[]> {
  const ctx: AccessContext = await deps.policy.context();
  const out: { workerId: string; label: string; state: string; local: boolean; mine: boolean; mode: 'install' | 'request' | 'none' }[] = [];
  for (const worker of await deps.workers.list()) {
    const resource = await deps.policy.worker(worker.workerId);
    const local = resource.local === true;
    if (local && !actor.user.clusterAdmin) continue;
    if (!can(actor, 'worker.read', resource, ctx)) continue;
    const manage = can(actor, 'worker.manage', resource, ctx);
    out.push({ workerId: worker.workerId, label: worker.label, state: worker.state, local, mine: resource.createdBy === actor.user.id, mode: manage ? 'install' : 'request' });
  }
  return out;
}

// ---------- 设置 ----------

export async function reviewSettingsFor(
  deps: AssetReviewDeps,
  actor: Principal
): Promise<{ team: (AssetReviewSettings & { teamId: string; editable: boolean }) | null; hub: (AssetReviewSettings & { editable: boolean }) | null }> {
  const teamId = actor.user.teamId;
  const team = teamId ? await deps.teams.byId(teamId) : null;
  const teamSettings = teamId ? ((await deps.review.settings(teamId)) ?? DEFAULT_REVIEW_SETTINGS) : null;
  const hub = actor.user.clusterAdmin ? ((await deps.review.settings(HUB_REVIEW_KEY)) ?? DEFAULT_REVIEW_SETTINGS) : null;
  return {
    team: teamId && teamSettings ? { ...teamSettings, teamId, editable: team?.ownerId === actor.user.id } : null,
    hub: hub ? { ...hub, editable: true } : null
  };
}

/** 团队负责人改本团队的审核人和双人审核开关；hub 管理员改 hub 级（全局资产）的。 */
export async function setReviewSettings(
  deps: AssetReviewDeps,
  actor: Principal,
  target: 'team' | 'hub',
  input: AssetReviewSettings
): Promise<Result<AssetReviewSettings, DomainError>> {
  if (actor.via) return err(forbidden('令牌不能改审核设置'));
  if (target === 'hub') {
    if (!actor.user.clusterAdmin) return err(forbidden('只有集群管理员能改全局资产的审核设置'));
    // hub 级指定审核人：hub 管理员团队里的人（全局资产的第二位审核人从这里出）
    const hubReviewers: string[] = [];
    for (const id of new Set(input.reviewers)) {
      const user: User | null = await deps.users.byId(id as UserId);
      if (!user || user.teamId !== actor.user.teamId || user.deletedAt !== null) return err(invalid('全局审核人必须是 hub 管理员团队的成员'));
      if (user.id !== actor.user.id) hubReviewers.push(user.id);
    }
    const next = { reviewers: hubReviewers, twoReviewers: input.twoReviewers };
    await deps.review.setSettings(HUB_REVIEW_KEY, next);
    await audit(deps, actor, 'asset.review_settings', 'hub', `全局审核人 ${hubReviewers.length} 位；全局双人审核 ${next.twoReviewers.global ? '开' : '关'}，MCP stdio 双人审核 ${next.twoReviewers.mcpStdio ? '开' : '关'}`, null);
    return ok(next);
  }
  const teamId = actor.user.teamId;
  const team = teamId ? await deps.teams.byId(teamId) : null;
  if (!team || team.ownerId !== actor.user.id) return err(forbidden('只有团队负责人能改审核设置'));
  const reviewers: string[] = [];
  for (const id of new Set(input.reviewers)) {
    const user: User | null = await deps.users.byId(id as UserId);
    if (!user || user.teamId !== team.id || user.deletedAt !== null) return err(invalid('审核人必须是本团队成员'));
    if (user.id !== team.ownerId) reviewers.push(user.id);
  }
  const next = { reviewers, twoReviewers: input.twoReviewers };
  await deps.review.setSettings(team.id, next);
  await audit(deps, actor, 'asset.review_settings', team.name, `审核人 ${reviewers.length} 位；MCP stdio 双人审核 ${next.twoReviewers.mcpStdio ? '开' : '关'}`, team.id);
  return ok(next);
}

// ---------- 团队 / 个人密钥 ----------

/** 我能管的密钥名（不含值）：个人 + 本团队。 */
export async function scopedSecrets(
  deps: AssetReviewDeps,
  actor: Principal
): Promise<{ personal: { name: string; updatedAt: number }[]; team: { name: string; updatedAt: number }[]; teamEditable: boolean }> {
  const all = await deps.secrets.list();
  const personal: { name: string; updatedAt: number }[] = [];
  const team: { name: string; updatedAt: number }[] = [];
  for (const secret of all) {
    const key = parseSecretKey(secret.name);
    if (key.layer === 'personal' && key.ref === actor.user.id) personal.push({ name: key.name, updatedAt: secret.updatedAt });
    if (key.layer === 'team' && key.ref === actor.user.teamId) team.push({ name: key.name, updatedAt: secret.updatedAt });
  }
  const owned = actor.user.teamId ? (await deps.teams.byId(actor.user.teamId))?.ownerId === actor.user.id : false;
  return { personal, team, teamEditable: owned };
}

export async function setScopedSecret(
  deps: AssetReviewDeps,
  actor: Principal,
  layer: 'personal' | 'team',
  name: string,
  value: string | null
): Promise<Result<void, DomainError>> {
  if (actor.via) return err(forbidden('令牌不能管密钥'));
  if (!can(actor, 'asset.secret.use')) return err(forbidden('你没有管理资产密钥的权限'));
  const checked = checkSecretName(name);
  if (!checked.ok) return checked;
  let ref: string = actor.user.id;
  if (layer === 'team') {
    const team = actor.user.teamId ? await deps.teams.byId(actor.user.teamId) : null;
    if (!team || team.ownerId !== actor.user.id) return err(forbidden('只有团队负责人能管团队密钥'));
    ref = team.id;
  }
  const key = secretKey(layer, name, ref);
  if (value === null) {
    if (!(await deps.secrets.remove(key))) return err(notFound('没有这个密钥'));
    await audit(deps, actor, 'asset.secret.delete', name, `删除${layer === 'team' ? '团队' : '个人'}密钥`, actor.user.teamId);
    return ok(undefined);
  }
  const stored = await setSecret({ secrets: { ...deps.secrets, put: (_n, v, at) => deps.secrets.put(key, v, at) }, now: deps.now }, name, value);
  if (!stored.ok) return stored;
  await audit(deps, actor, 'asset.secret.set', name, `设置${layer === 'team' ? '团队' : '个人'}密钥（值不记录）`, actor.user.teamId);
  return ok(undefined);
}

// ---------- 通知 ----------

export async function listNotifications(deps: AssetReviewDeps, actor: Principal): Promise<{ items: Notification[]; unread: number }> {
  return { items: await deps.notifications.list(actor.user.id, 50), unread: await deps.notifications.unread(actor.user.id) };
}

export async function markNotificationsRead(deps: AssetReviewDeps, actor: Principal, ids: readonly string[] | null): Promise<void> {
  await deps.notifications.markRead(actor.user.id, ids, deps.now());
}

// ---------- 迁移 ----------

/**
 * 老资产归属迁移（ADR 0016 §迁移）：作用域已由存储层按 project_id 填好（global / project），
 * 这里把作者记成 hub 管理员、团队记成他的团队；latest ≠ pinned 的转成待审提交。幂等：已有作者的不动。
 * 钉住的版本和安装关系不变，所以每台 Worker 的清单前后一致。
 */
export async function migrateAssetOwnership(deps: AssetReviewDeps): Promise<{ migrated: number; pending: number }> {
  const admin = await deps.users.firstClusterAdmin();
  if (!admin) return { migrated: 0, pending: 0 };
  let migrated = 0;
  let pending = 0;
  for (const asset of await deps.assets.list()) {
    if (asset.ownerId !== '') continue;
    const next: Asset = { ...asset, ownerId: admin.id, teamId: admin.teamId, updatedAt: asset.updatedAt };
    await deps.assets.update(next);
    migrated += 1;
    if (next.latest !== next.pinned) {
      const opened = await openSubmission(deps, null, next, next.latest, 'migration');
      if (opened.ok) pending += 1;
    }
  }
  if (migrated > 0) {
    await deps.audit.append({
      id: newId(),
      actorId: SYSTEM as UserId,
      actorEmail: '迁移',
      action: 'asset.migrate',
      target: 'assets',
      detail: `${migrated} 个老资产归到 ${admin.email}（作用域按原样：全局 / 项目），${pending} 个待确认的新版本转成待审提交`,
      at: deps.now(),
      teamId: null
    });
  }
  return { migrated, pending };
}

/**
 * 运营后台（/api/admin/assets）的直接上架 / 钉版本：只有集群管理员走得到，等同 3A 允许的「hub 管理员自批全局资产」。
 * 这里把同一版本上挂着的待审提交一并关掉（记成自批），并写一条带标记的审计。
 */
export async function recordAdminPublish(deps: AssetReviewDeps, actor: Principal, asset: Asset, digest: string, how: string): Promise<void> {
  const at = deps.now();
  const pending = await deps.review.submissions({ assetId: asset.id, status: ['pending'] });
  for (const sub of pending) {
    if (sub.targetScope !== null) continue;
    const status = sub.digest === digest ? 'approved' : 'superseded';
    await deps.review.updateSubmission({
      ...sub,
      status,
      approvals: status === 'approved' ? [...sub.approvals, { userId: actor.user.id, at, selfApproved: true }] : sub.approvals,
      decidedBy: actor.user.id,
      decidedAt: at,
      reason: status === 'approved' ? '运营后台直接发布' : '运营后台发布了别的版本'
    });
  }
  await audit(deps, actor, 'asset.self_approve', asset.name, `⚑ hub 管理员自批：${how} ${digest.slice(0, 12)}`, asset.teamId);
}
