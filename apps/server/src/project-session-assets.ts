import { createHash } from 'node:crypto';
import {
  ASSET_KINDS,
  ASSET_LIMITS,
  assetFileText,
  assetRevisions,
  assetVisibleIn,
  authorizeProjectResource,
  can,
  conflict,
  err,
  forbidden,
  invalid,
  isPublished,
  notFound,
  ok,
  recordAssetAudit,
  requestFingerprint,
  requestReplayKey,
  resolveProjectAssets,
  setProjectAsset,
  submitAssetRevision,
  submitNewAsset,
  unavailable,
  type AssetKind,
  type AssetReviewDeps,
  type AssetViewer,
  type Deps,
  type DomainError,
  type GrantActor,
  type IncomingFile,
  type OperationReceiptPayload,
  type OperationReceiptStore,
  type Principal,
  type ProjectId,
  type ProjectLike,
  type Result,
  type SessionId
} from '@agent-hub/domain';
import type {
  ProjectAssetCreateCommand,
  ProjectAssetEnableSnapshot,
  ProjectAssetInputFile,
  ProjectAssetListQuery,
  ProjectAssetReadQuery,
  ProjectAssetReadSnapshot,
  ProjectAssetReviseCommand,
  ProjectAssetSetEnabledCommand,
  ProjectAssetSummary,
  ProjectAssetToolDeps,
  ProjectAssetWriteSnapshot
} from './project-session-asset-tools.ts';
import type { ProjectSessionGrantService } from './project-session-grant.ts';
import { checkRelativePath, hasControl, PATH_MAX } from './project-session-input.ts';

/**
 * 项目会话资产工具的动作层（docs/design/project-session-mcp.md「资产工具的实现边界」）。
 *
 * 这一层只做四件事：
 * 1. 用当前冻结的 grant 重新核对「这个人现在还能在这个项目里读 / 写」；
 * 2. 用现有的 `resolveProjectAssets` / `assetVisibleIn` 判定可见性，只认已发布版本；
 * 3. 创建 / 修订转交 `submitNewAsset` / `submitAssetRevision`，发布仍然只走审核；
 * 4. 写操作先落 `OperationReceiptStore` 占位，结果不明时保持 pending，绝不当成新提交重放。
 *
 * 它**不**发布版本、**不**改团队 / 全局共享原始资产、**不**提供绕过审核的入口；
 * 审计里只出现资产标识与动作，不出现文件正文、来源地址或密钥。
 */

/* ── 动作标识（回执命名空间的一部分，不对外暴露） ── */

const PROJECT_ASSET_CREATE_OPERATION = 'project.asset.create';
const PROJECT_ASSET_REVISE_OPERATION = 'project.asset.revise';
const PROJECT_ASSET_SET_ENABLED_OPERATION = 'project.asset.set_enabled';

/* ── 边界上限：与 provider / 领域保持同一套 ── */

const REQUEST_KEY_MAX = 200;
const ID_MAX = 200;
const NAME_MAX = 64;
const STATUS_MAX = 40;
const DIGEST_LENGTH = 64;
const READ_CONTENT_MAX = 64 * 1024;
const LIST_LIMIT_MAX = 200;
const RECEIPT_VERSION = 1;

const HEX64 = /^[a-f0-9]{64}$/;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 确定发生在副作用之前的失败：可以安全释放占位，让同一请求键重试。 */
const DETERMINISTIC_CODES = new Set(['forbidden', 'notFound', 'invalid', 'conflict']);

/* ── 依赖 / 动作集合 ── */

/**
 * 动作集合 = provider 的五个回调，签名直接取 provider 导出的类型，
 * 装配处 `{ scopes, ...actions }` 即可，不需要再维护第二套形状。
 */
export type ProjectSessionAssetActions = Omit<ProjectAssetToolDeps, 'scopes'>;

export interface ProjectSessionAssetDeps {
  /** 与 `project-session-tools.ts` 相同的授权服务：只允许冻结 grant 的绑定身份。 */
  readonly grants: Pick<ProjectSessionGrantService, 'authorize'>;
  /** 资产用例全套依赖（资产仓库、审核、审计、账号、团队、授权策略）。 */
  readonly assets: AssetReviewDeps;
  /** 会话重查：grant 里的 session 必须仍然存在。 */
  readonly sessions: Pick<Deps['sessions'], 'byId'>;
  /** 写操作幂等回执。 */
  readonly operationReceipts: OperationReceiptStore;
  /** 账号重查：授权时的人现在还必须可用。 */
  readonly loadActor: (accountId: string) => Promise<Principal | null>;
}

/* ── 授权上下文 ── */

interface Authorized {
  readonly project: ProjectLike;
  readonly actor: Principal;
  readonly viewer: AssetViewer;
}

type GrantScope = 'project:read' | 'asset:write';

/**
 * 每一步都从库里重新取：grant 只是「会话被冻结时拿到过什么」，
 * 不能代替当前项目可见性、当前账号状态与当前角色。
 */
async function authorize(
  deps: ProjectSessionAssetDeps,
  binding: { readonly actorId: string; readonly actorVia: GrantActor['via']; readonly sessionId: SessionId },
  scope: GrantScope
): Promise<Result<Authorized, DomainError>> {
  const granted = await deps.grants.authorize({
    actor: { userId: binding.actorId, via: binding.actorVia },
    sessionId: binding.sessionId,
    scope
  });
  if (!granted.ok) return granted;
  const grant = granted.value;
  if (grant.accountId !== binding.actorId || grant.sessionId !== binding.sessionId) {
    return err(forbidden('资产工具授权与会话身份不一致'));
  }
  if (!grant.scopes.includes(scope)) return err(forbidden('这次会话没有该资产权限'));

  const project = await deps.assets.projects.byId(grant.projectId);
  if (!project) return err(notFound('没有这个项目'));
  const session = await deps.sessions.byId(binding.sessionId);
  if (!session) return err(notFound('会话不存在'));

  const actor = await deps.loadActor(grant.accountId);
  if (!actor || actor.user.disabledAt !== null || actor.user.deletedAt !== null) {
    return err(forbidden('调用账号已不可用'));
  }

  const visible = await authorizeProjectResource(deps.assets.policy, actor, project, 'project.read');
  if (!visible.ok) return visible;
  return ok({ project: visible.value, actor, viewer: viewerOf(visible.value, actor) });
}

function viewerOf(project: ProjectLike, actor: Principal): AssetViewer {
  // 与浏览器项目资产页 / 会话启动时的约定一致：团队资产按项目所属团队过滤。
  return { userId: actor.user.id, teamId: project.teamId ?? null };
}

/* ── 基础校验（provider 已校验一遍，这里仍按信任边界再查） ── */

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !hasControl(value);
}

function checkOpaqueId(value: string, label: string): DomainError | null {
  if (value === '.' || value === '..' || /[\/\\:\s]/.test(value) || value.length > ID_MAX || hasControl(value)) {
    return invalid(`${label} 不合法`);
  }
  return null;
}

function checkKind(value: unknown): value is AssetKind {
  return typeof value === 'string' && (ASSET_KINDS as readonly string[]).includes(value);
}

function checkFiles(files: readonly ProjectAssetInputFile[]): DomainError | null {
  if (!Array.isArray(files) || files.length === 0) return invalid('files 至少要有 1 个文件');
  if (files.length > ASSET_LIMITS.maxFiles) return invalid(`files 不能超过 ${ASSET_LIMITS.maxFiles} 个文件`);
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (file === null || typeof file !== 'object') return invalid('files 里的文件必须是对象');
    if (!validText(file.path, PATH_MAX)) return invalid('文件路径必须是非空字符串，且不能有首尾空白或控制字符');
    const pathError = checkRelativePath(file.path);
    if (pathError) return pathError;
    if (seen.has(file.path)) return invalid('files 里不能有重复路径');
    seen.add(file.path);
    if (typeof file.content !== 'string' || file.content.includes('\u0000')) {
      return invalid('文件正文必须是 UTF-8 文本，且不能包含空字符');
    }
    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes > ASSET_LIMITS.maxFileBytes) {
      return invalid(`单个文件不能超过 ${Math.floor(ASSET_LIMITS.maxFileBytes / 1024)} KiB`);
    }
    total += bytes;
    if (total > ASSET_LIMITS.maxTotalBytes) {
      return invalid(`文件合计不能超过 ${Math.floor(ASSET_LIMITS.maxTotalBytes / 1024 / 1024)} MiB`);
    }
  }
  return null;
}

function toIncoming(files: readonly ProjectAssetInputFile[]): IncomingFile[] {
  return files.map((file) => ({ path: file.path, data: new TextEncoder().encode(file.content) }));
}

/* ── 回执 ── */

const WRITE_RECEIPT_KEYS = new Set([
  'version',
  'projectId',
  'assetId',
  'kind',
  'name',
  'scope',
  'digest',
  'published',
  'submissionId',
  'submissionStatus'
]);
const ENABLE_RECEIPT_KEYS = new Set(['version', 'projectId', 'assetId', 'enabled', 'overridden']);

type Reservation =
  | { readonly status: 'reserved'; readonly reservationId: string }
  | { readonly status: 'completed'; readonly payload: OperationReceiptPayload };

function fingerprintOf(values: readonly (string | number | null)[]): string {
  return createHash('sha256').update(requestFingerprint(values)).digest('hex');
}

function fileFingerprint(files: readonly ProjectAssetInputFile[]): string {
  return JSON.stringify(
    files.map((file) => [file.path, createHash('sha256').update(file.content, 'utf8').digest('hex')])
  );
}

async function reserve(
  deps: ProjectSessionAssetDeps,
  intent: {
    readonly key: string;
    readonly fingerprint: string;
    readonly actorId: string;
    readonly sessionId: SessionId;
    readonly projectId: ProjectId;
    readonly operation: string;
  }
): Promise<Result<Reservation, DomainError>> {
  let outcome;
  try {
    outcome = await deps.operationReceipts.reserve({
      key: intent.key,
      fingerprint: intent.fingerprint,
      actorId: intent.actorId,
      sourceSessionId: intent.sessionId,
      projectId: intent.projectId,
      operation: intent.operation
    });
  } catch {
    return err(unavailable('无法建立资产写入回执，请稍后重试'));
  }
  switch (outcome.status) {
    case 'reserved':
      return ok({ status: 'reserved', reservationId: outcome.reservationId });
    case 'completed':
      return ok({ status: 'completed', payload: outcome.payload });
    case 'pending':
      return err(unavailable('相同的资产写入请求正在处理中，请稍后再试'));
    case 'conflict':
      return err(conflict('同一请求键对应不同参数'));
  }
}

async function releaseQuietly(
  deps: ProjectSessionAssetDeps,
  intent: { readonly key: string; readonly fingerprint: string },
  reservationId: string
): Promise<void> {
  try {
    await deps.operationReceipts.release({ key: intent.key, fingerprint: intent.fingerprint, reservationId });
  } catch {
    // 释放失败不改变「这次没写成」的结论；占位会保持 pending，后续同键请求会被挡住。
  }
}

function exactKeys(raw: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const own = Object.keys(raw);
  return own.length === keys.size && own.every((key) => keys.has(key));
}

function receiptText(value: unknown, max: number): string | null {
  return validText(value, max) ? value : null;
}

function readWriteReceipt(
  payload: OperationReceiptPayload,
  expected: { readonly projectId: string; readonly kind: AssetKind; readonly assetId: string | null }
): Result<ProjectAssetWriteSnapshot, DomainError> {
  const raw = payload as Record<string, unknown>;
  if (!exactKeys(raw, WRITE_RECEIPT_KEYS)) return err(unavailable('资产提交回执无法核实'));
  if (raw.version !== RECEIPT_VERSION || raw.projectId !== expected.projectId) {
    return err(unavailable('资产提交回执无法核实'));
  }

  const assetId = receiptText(raw.assetId, ID_MAX);
  const kind = raw.kind;
  const name = receiptText(raw.name, NAME_MAX);
  const scope = raw.scope;
  const digest = raw.digest;
  const published = raw.published;
  const submissionId = raw.submissionId === null ? null : receiptText(raw.submissionId, ID_MAX);
  const submissionStatus = raw.submissionStatus === null ? null : receiptText(raw.submissionStatus, STATUS_MAX);

  if (
    assetId === null ||
    !checkKind(kind) ||
    kind !== expected.kind ||
    name === null ||
    !NAME_PATTERN.test(name) ||
    (scope !== 'personal' && scope !== 'project' && scope !== 'team' && scope !== 'global') ||
    typeof digest !== 'string' ||
    !HEX64.test(digest) ||
    typeof published !== 'boolean' ||
    submissionId === undefined ||
    submissionStatus === undefined ||
    (submissionId === null) !== (submissionStatus === null) ||
    (expected.assetId !== null && assetId !== expected.assetId) ||
    (expected.assetId === null && published)
  ) {
    return err(unavailable('资产提交回执无法核实'));
  }

  return ok({
    assetId,
    kind,
    name,
    scope,
    digest,
    published,
    submissionId,
    submissionStatus
  });
}

function readEnableReceipt(
  payload: OperationReceiptPayload,
  expected: { readonly projectId: string; readonly assetId: string }
): Result<ProjectAssetEnableSnapshot, DomainError> {
  const raw = payload as Record<string, unknown>;
  if (!exactKeys(raw, ENABLE_RECEIPT_KEYS)) return err(unavailable('资产开关回执无法核实'));
  if (
    raw.version !== RECEIPT_VERSION ||
    raw.projectId !== expected.projectId ||
    raw.assetId !== expected.assetId ||
    typeof raw.enabled !== 'boolean' ||
    typeof raw.overridden !== 'boolean'
  ) {
    return err(unavailable('资产开关回执无法核实'));
  }
  return ok({ assetId: expected.assetId, enabled: raw.enabled, overridden: raw.overridden });
}

/* ── 小工具 ── */

const isScope = (value: string): value is ProjectAssetSummary['scope'] =>
  value === 'personal' || value === 'project' || value === 'team' || value === 'global';

function assetName(asset: { readonly name: string }): string | null {
  if (asset.name.length === 0 || asset.name.length > NAME_MAX || hasControl(asset.name)) return null;
  return asset.name;
}

function writeSnapshot(
  asset: { readonly id: string; readonly kind: AssetKind; readonly name: string; readonly scope: ProjectAssetSummary['scope']; readonly pinned: string; readonly latest: string },
  submission: { readonly id: string; readonly status: string } | null
): Result<ProjectAssetWriteSnapshot, DomainError> {
  const name = assetName(asset);
  if (
    name === null ||
    asset.latest.length !== DIGEST_LENGTH ||
    !HEX64.test(asset.latest) ||
    !isScope(asset.scope)
  ) {
    return err(unavailable('资产提交结果无法核实'));
  }
  if (!asset.pinned && !asset.latest) return err(unavailable('资产提交结果无法核实'));
  return ok({
    assetId: asset.id,
    kind: asset.kind,
    name,
    scope: asset.scope,
    digest: asset.latest,
    published: asset.pinned === asset.latest,
    submissionId: submission?.id ?? null,
    submissionStatus: submission?.status ?? null
  });
}

function writePayload(projectId: string, snapshot: ProjectAssetWriteSnapshot): OperationReceiptPayload {
  return {
    version: RECEIPT_VERSION,
    projectId,
    assetId: snapshot.assetId,
    kind: snapshot.kind,
    name: snapshot.name,
    scope: snapshot.scope,
    digest: snapshot.digest,
    published: snapshot.published,
    submissionId: snapshot.submissionId,
    submissionStatus: snapshot.submissionStatus
  };
}

/* ── 动作 ── */

export function createProjectSessionAssetActions(deps: ProjectSessionAssetDeps): ProjectSessionAssetActions {
  const listAssets = async (
    query: ProjectAssetListQuery
  ): Promise<Result<readonly ProjectAssetSummary[], DomainError>> => {
    const authorized = await authorize(deps, query, 'project:read');
    if (!authorized.ok) return authorized;
    const { project, viewer } = authorized.value;

    const settings = await deps.assets.assets.projectSettings(project.id);
    const { choices } = resolveProjectAssets(await deps.assets.assets.list(), project.id, settings, viewer);

    const limit = Number.isInteger(query.limit) ? Math.min(Math.max(query.limit, 1), LIST_LIMIT_MAX) : 50;
    const rows: ProjectAssetSummary[] = [];
    for (const choice of choices) {
      const asset = choice.asset;
      const name = assetName(asset);
      const sourceType = asset.source.type;
      if (
        name === null ||
        !isScope(asset.scope) ||
        (sourceType !== 'upload' && sourceType !== 'git' && sourceType !== 'builtin')
      ) {
        return err(unavailable('资产列表无法核实'));
      }
      if (query.kind !== null && asset.kind !== query.kind) continue;
      if (!query.includeDisabled && (!choice.enabled || choice.shadowedBy !== null)) continue;
      rows.push({
        assetId: asset.id,
        kind: asset.kind,
        name,
        scope: asset.scope,
        sourceType,
        enabled: choice.enabled,
        overridden: Object.prototype.hasOwnProperty.call(settings, asset.id),
        shadowedBy: choice.shadowedBy,
        published: isPublished(asset)
      });
    }

    rows.sort((a, b) => (a.name === b.name ? a.assetId.localeCompare(b.assetId) : a.name.localeCompare(b.name)));
    const assets = rows.slice(0, limit);
    return ok(assets);
  };

  const readAsset = async (query: ProjectAssetReadQuery): Promise<Result<ProjectAssetReadSnapshot, DomainError>> => {
    const authorized = await authorize(deps, query, 'project:read');
    if (!authorized.ok) return authorized;
    const { project, viewer } = authorized.value;

    if (!validText(query.assetId, ID_MAX)) return err(invalid('asset_id 不合法'));
    const idError = checkOpaqueId(query.assetId, 'asset_id');
    if (idError) return err(idError);

    const asset = await deps.assets.assets.get(query.assetId);
    if (!asset || !isPublished(asset) || !assetVisibleIn(asset, project.id, viewer)) {
      return err(notFound('没有这个资产'));
    }

    const revisions = await assetRevisions(deps.assets, asset.id);
    if (!revisions.ok) return revisions;
    const pinned = revisions.value.find((revision) => revision.digest === asset.pinned);
    if (!pinned) return err(unavailable('资产已发布版本暂时无法读取'));

    const name = assetName(asset);
    if (name === null) return err(unavailable('资产版本无法核实'));

    const files = pinned.files.map((file) => ({ path: file.path, sha256: file.sha256, size: file.size }));

    if (query.path === null) {
      return ok({
        assetId: asset.id,
        kind: asset.kind,
        name,
        scope: asset.scope,
        digest: pinned.digest,
        files,
        file: null
      });
    }

    const pathError = checkRelativePath(query.path);
    if (pathError) return err(pathError);
    const listed = pinned.files.find((file) => file.path === query.path);
    if (!listed) return err(notFound('版本里没有这个文件'));

    const text = await assetFileText(deps.assets, asset.id, pinned.digest, query.path);
    if (!text.ok) return text;
    if (text.value === null) return err(invalid('该文件不是可读文本'));
    const bytes = Buffer.byteLength(text.value, 'utf8');
    if (bytes > READ_CONTENT_MAX) return err(invalid('资产文本文件超过 64 KiB，无法通过工具读取'));
    if (bytes !== listed.size) return err(unavailable('资产文本文件大小与版本清单不一致'));

    return ok({
      assetId: asset.id,
      kind: asset.kind,
      name,
      scope: asset.scope,
      digest: pinned.digest,
      files,
      file: { path: query.path, content: text.value, size: bytes }
    });
  };

  const createAsset = async (
    command: ProjectAssetCreateCommand
  ): Promise<Result<ProjectAssetWriteSnapshot, DomainError>> => {
    const authorized = await authorize(deps, command, 'asset:write');
    if (!authorized.ok) return authorized;
    const { project, actor } = authorized.value;

    if (!validText(command.requestKey, REQUEST_KEY_MAX)) return err(invalid('request_key 不合法'));
    if (!checkKind(command.kind)) return err(invalid(`kind 必须是 ${ASSET_KINDS.join(' / ')}`));
    if (command.name !== null && (!validText(command.name, NAME_MAX) || !NAME_PATTERN.test(command.name))) {
      return err(invalid('name 不合规：只能用小写字母、数字和单个连字符，1–64 个字符'));
    }
    const filesError = checkFiles(command.files);
    if (filesError) return err(filesError);

    const fingerprint = fingerprintOf([
      PROJECT_ASSET_CREATE_OPERATION,
      command.actorId,
      command.sessionId,
      project.id,
      command.kind,
      command.name,
      fileFingerprint(command.files)
    ]);
    const key = requestReplayKey(
      {
        actorId: command.actorId,
        sourceSessionId: command.sessionId,
        projectId: project.id as ProjectId,
        operation: PROJECT_ASSET_CREATE_OPERATION
      },
      command.requestKey
    );
    const intent = { key, fingerprint };
    const reserved = await reserve(deps, {
      ...intent,
      actorId: command.actorId,
      sessionId: command.sessionId,
      projectId: project.id as ProjectId,
      operation: PROJECT_ASSET_CREATE_OPERATION
    });
    if (!reserved.ok) return reserved;
    if (reserved.value.status === 'completed') {
      return readWriteReceipt(reserved.value.payload, { projectId: project.id, kind: command.kind, assetId: null });
    }

    const made = await submitNewAsset(deps.assets, actor, {
      from: 'upload',
      kind: command.kind,
      scope: 'project',
      projectId: project.id,
      ...(command.name === null ? {} : { name: command.name }),
      files: toIncoming(command.files)
    });
    if (!made.ok) {
      if (DETERMINISTIC_CODES.has(made.error.code)) {
        await releaseQuietly(deps, intent, reserved.value.reservationId);
        return made;
      }
      return err(unavailable('资产提交结果尚未确认，请用同一请求键重试核对'));
    }

    const snapshot = writeSnapshot(made.value.asset, made.value.submission);
    if (!snapshot.ok) return snapshot;
    const completed = await deps.operationReceipts.complete({
      key,
      fingerprint,
      reservationId: reserved.value.reservationId,
      payload: writePayload(project.id, snapshot.value)
    });
    if (completed.status === 'conflict') return err(unavailable('资产提交回执冲突，请人工核对'));
    if (completed.status === 'replayed') {
      return readWriteReceipt(completed.payload, { projectId: project.id, kind: command.kind, assetId: null });
    }
    return snapshot;
  };

  const reviseAsset = async (
    command: ProjectAssetReviseCommand
  ): Promise<Result<ProjectAssetWriteSnapshot, DomainError>> => {
    const authorized = await authorize(deps, command, 'asset:write');
    if (!authorized.ok) return authorized;
    const { project, viewer, actor } = authorized.value;

    if (!validText(command.requestKey, REQUEST_KEY_MAX)) return err(invalid('request_key 不合法'));
    if (!validText(command.assetId, ID_MAX)) return err(invalid('asset_id 不合法'));
    const idError = checkOpaqueId(command.assetId, 'asset_id');
    if (idError) return err(idError);
    const filesError = checkFiles(command.files);
    if (filesError) return err(filesError);

    const asset = await deps.assets.assets.get(command.assetId);
    if (!asset || !isPublished(asset) || !assetVisibleIn(asset, project.id, viewer)) {
      return err(notFound('没有这个资产'));
    }
    if (asset.scope !== 'project' || asset.projectId !== project.id) {
      return err(forbidden('只能修订当前项目的项目级资产'));
    }
    if (asset.source.type === 'builtin') return err(forbidden('内置资产不能改版'));

    const fingerprint = fingerprintOf([
      PROJECT_ASSET_REVISE_OPERATION,
      command.actorId,
      command.sessionId,
      project.id,
      command.assetId,
      fileFingerprint(command.files)
    ]);
    const key = requestReplayKey(
      {
        actorId: command.actorId,
        sourceSessionId: command.sessionId,
        projectId: project.id as ProjectId,
        operation: PROJECT_ASSET_REVISE_OPERATION
      },
      command.requestKey
    );
    const intent = { key, fingerprint };
    const reserved = await reserve(deps, {
      ...intent,
      actorId: command.actorId,
      sessionId: command.sessionId,
      projectId: project.id as ProjectId,
      operation: PROJECT_ASSET_REVISE_OPERATION
    });
    if (!reserved.ok) return reserved;
    if (reserved.value.status === 'completed') {
      return readWriteReceipt(reserved.value.payload, {
        projectId: project.id,
        kind: asset.kind,
        assetId: command.assetId
      });
    }

    const revised = await submitAssetRevision(deps.assets, actor, command.assetId, toIncoming(command.files));
    if (!revised.ok) {
      if (DETERMINISTIC_CODES.has(revised.error.code)) {
        await releaseQuietly(deps, intent, reserved.value.reservationId);
        return revised;
      }
      return err(unavailable('资产提交结果尚未确认，请用同一请求键重试核对'));
    }

    const snapshot = writeSnapshot(revised.value.asset, revised.value.submission);
    if (!snapshot.ok) return snapshot;
    const completed = await deps.operationReceipts.complete({
      key,
      fingerprint,
      reservationId: reserved.value.reservationId,
      payload: writePayload(project.id, snapshot.value)
    });
    if (completed.status === 'conflict') return err(unavailable('资产提交回执冲突，请人工核对'));
    if (completed.status === 'replayed') {
      return readWriteReceipt(completed.payload, {
        projectId: project.id,
        kind: revised.value.asset.kind,
        assetId: command.assetId
      });
    }
    return snapshot;
  };

  const setAssetEnabled = async (
    command: ProjectAssetSetEnabledCommand
  ): Promise<Result<ProjectAssetEnableSnapshot, DomainError>> => {
    const authorized = await authorize(deps, command, 'asset:write');
    if (!authorized.ok) return authorized;
    const { project, viewer, actor } = authorized.value;

    if (!validText(command.requestKey, REQUEST_KEY_MAX)) return err(invalid('request_key 不合法'));
    if (!validText(command.assetId, ID_MAX)) return err(invalid('asset_id 不合法'));
    const idError = checkOpaqueId(command.assetId, 'asset_id');
    if (idError) return err(idError);
    if (command.enabled !== null && typeof command.enabled !== 'boolean') {
      return err(invalid('enabled 必须是布尔值或 null'));
    }

    const asset = await deps.assets.assets.get(command.assetId);
    if (!asset || !isPublished(asset) || !assetVisibleIn(asset, project.id, viewer)) {
      return err(notFound('没有这个资产'));
    }

    /**
     * 项目开关会影响别人以后开的会话：除了 `project.update`，还要求是项目 owner
     * 或项目所属团队的负责人 / 管理员（与设计文档「项目负责人或团队负责人」一致）。
     */
    const ctx = await deps.assets.policy.context();
    const teamLead = can(
      actor,
      'team.manage',
      { kind: 'team', teamId: project.teamId ?? ctx.hubTeamId, createdBy: project.createdBy ?? null, sharedWith: project.members ?? [] },
      ctx
    );
    if (project.createdBy !== actor.user.id && !teamLead) {
      return err(forbidden('只有项目负责人或团队负责人能改项目资产开关'));
    }
    const allowed = await authorizeProjectResource(deps.assets.policy, actor, project, 'project.update');
    if (!allowed.ok) return allowed;

    const fingerprint = fingerprintOf([
      PROJECT_ASSET_SET_ENABLED_OPERATION,
      command.actorId,
      command.sessionId,
      project.id,
      command.assetId,
      command.enabled === null ? 'default' : command.enabled ? 'on' : 'off'
    ]);
    const key = requestReplayKey(
      {
        actorId: command.actorId,
        sourceSessionId: command.sessionId,
        projectId: project.id as ProjectId,
        operation: PROJECT_ASSET_SET_ENABLED_OPERATION
      },
      command.requestKey
    );
    const intent = { key, fingerprint };
    const reserved = await reserve(deps, {
      ...intent,
      actorId: command.actorId,
      sessionId: command.sessionId,
      projectId: project.id as ProjectId,
      operation: PROJECT_ASSET_SET_ENABLED_OPERATION
    });
    if (!reserved.ok) return reserved;
    if (reserved.value.status === 'completed') {
      return readEnableReceipt(reserved.value.payload, { projectId: project.id, assetId: command.assetId });
    }

    const saved = await setProjectAsset(deps.assets, {
      projectId: project.id,
      assetId: command.assetId,
      enabled: command.enabled
    });
    if (!saved.ok) {
      if (DETERMINISTIC_CODES.has(saved.error.code)) {
        await releaseQuietly(deps, intent, reserved.value.reservationId);
        return saved;
      }
      return err(unavailable('资产开关结果尚未确认，请用同一请求键重试核对'));
    }

    const settings = await deps.assets.assets.projectSettings(project.id);
    const snapshot: ProjectAssetEnableSnapshot = {
      assetId: command.assetId,
      enabled: settings[command.assetId] ?? true,
      overridden: Object.prototype.hasOwnProperty.call(settings, command.assetId)
    };

    await recordAssetAudit(
      { audit: deps.assets.audit, now: deps.assets.now },
      actor,
      'asset.project',
      command.assetId,
      command.enabled === null ? '恢复项目默认开关' : command.enabled ? '在项目中启用' : '在项目中停用'
    );

    const completed = await deps.operationReceipts.complete({
      key,
      fingerprint,
      reservationId: reserved.value.reservationId,
      payload: {
        version: RECEIPT_VERSION,
        projectId: project.id,
        assetId: snapshot.assetId,
        enabled: snapshot.enabled,
        overridden: snapshot.overridden
      }
    });
    if (completed.status === 'conflict') return err(unavailable('资产开关回执冲突，请人工核对'));
    if (completed.status === 'replayed') {
      return readEnableReceipt(completed.payload, { projectId: project.id, assetId: command.assetId });
    }
    return ok(snapshot);
  };

  return { listAssets, readAsset, createAsset, reviseAsset, setAssetEnabled };
}
