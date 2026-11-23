import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  conflict,
  err,
  forbidden,
  invalid,
  ok,
  requestFingerprint,
  requestReplayKey,
  unavailable,
  type DomainError,
  type GrantActor,
  type OperationReceiptPayload,
  type OperationReceiptStore,
  type OperationReserveOutcome,
  type ProjectId,
  type Result,
  type SessionId
} from '@agent-hub/domain';
import type { ProjectGitFetchFailureCode, ProjectGitFetcher, ProjectGitFetchResult } from './project-git-fetch.ts';

/**
 * 会话级「项目 Git 抓取 → 无凭据 bundle 导入」的无路由组合（docs/design/project-git-access.md §27-43）。
 *
 * 一次调用只做：
 *   Hub 用项目登记凭据抓取精确 HTTPS 仓库/分支 → 本地校验 bundle → 把**无凭据**的
 *   bundle 交给同一会话绑定 Worker 的 `ws.import_project_git_bundle`。
 *
 * 边界：
 * - 会话冻结绑定（人 / 会话 / 派工来源）由调用方给，模型只能提供仓库 id、可选分支和稳定
 *   请求键；远端地址、Worker、工作空间、路径、凭据一律不接受模型输入。
 * - 是否真的允许这条路径由注入的 `authorize` 缝决定（项目授权、账号状态、Worker 隔离
 *   能力等）。返回的 `ProjectGitSessionFetchBinding` 必须完全由服务端记录推导；抓取完成
 *   后、导入发出前再授权一次，并逐字段比较绑定，任何漂移都拒绝。
 * - 凭据只经注入的 `credential` 缝进入本进程，只作为抓取 bridge 的 Header；bundle、回执、
 *   错误与导入参数里都不出现凭据或远端原始输出。
 * - 先占持久回执再抓取。抓取 / 校验 / 再授权失败都确定没有副作用，CAS 释放后由调用方重新
 *   发起；导入已发出但结果不明（超时、断线、返回对不上）时保留 pending，不用时钟接管，也不
 *   自动重放，要求调用方用同一请求键回来只读核对回执。
 * - 组合根目前不接这条路径（生产边界关闭）；`policy.enabled` 为 false 时直接拒绝，绝不
 *   回落到带凭据的 RPC 或本机 git。
 */

export const PROJECT_GIT_SESSION_FETCH_OPERATION = 'project.git.session-fetch' as const;
export const PROJECT_GIT_SESSION_FETCH_FINGERPRINT_VERSION = 1 as const;
export const PROJECT_GIT_SESSION_FETCH_RECEIPT_VERSION = 1 as const;

/** 阶段 2 的硬上限：Worker 只接受 8 MiB 以内的原始 bundle。 */
export const PROJECT_GIT_SESSION_FETCH_MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
/** 8 MiB 原始字节对应的 base64 长度（契约里的硬上限）。 */
export const PROJECT_GIT_SESSION_FETCH_MAX_BASE64_BYTES = 11_184_812;

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const BUNDLE_SHA_PATTERN = /^[0-9a-f]{64}$/;
const PROJECT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_ID_LENGTH = 200;
const MAX_REQUEST_KEY_LENGTH = 200;
const REQUEST_KEY_PATTERN = /^[^\u0000-\u001f\u007f]+$/;
const MAX_AUTHORIZATION_LENGTH = 8192;

const ACTOR_VIA: readonly GrantActor['via'][] = ['web', 'group', 'bot', 'connector', 'dispatch', 'tool'];

/** 抓取失败后统一的安全说法：不带 Worker 路径、远端原始输出或凭据。 */
const UNKNOWN_IMPORT_RESULT =
  '项目 Git bundle 导入结果尚未确认（可能已创建 ref）；请用同一请求键只读核对回执，不要自动重放';

/** 工具 provider 冻结的会话绑定；模型不能改。 */
export interface ProjectGitSessionFetchCommand {
  readonly actorId: string;
  readonly actorVia: GrantActor['via'];
  /** 冻结的会话 id；项目、仓库清单、Worker 都从它绑定的记录推导。 */
  readonly sessionId: SessionId;
  /** 调用方稳定请求键：同键同参回放，同键异参冲突。 */
  readonly requestKey: string;
  /** 项目当前仓库清单里的仓库 id（不传地址）。 */
  readonly repoId: string;
  /** 显式分支；缺省时由授权缝填项目登记默认分支。 */
  readonly branch?: string | null;
}

/**
 * 服务端推导出的执行绑定。抓取前后各取一次，逐字段比较；任一项变化都不能继续导入。
 */
export interface ProjectGitSessionFetchBinding {
  readonly accountId: string;
  readonly sessionId: SessionId;
  readonly projectId: ProjectId;
  readonly repoId: string;
  /** 已登记的精确 HTTPS 克隆地址（不含 query / fragment / userinfo）。 */
  readonly repoUrl: string;
  readonly workerId: string;
  readonly workspaceId: string;
  /** Worker 上的目标工作空间目录；导入只在这里校验 bundle 并写专用 ref。 */
  readonly workspacePath: string;
  readonly branch: string;
}

export interface ProjectGitSessionFetchAuthorizeInput {
  readonly actor: GrantActor;
  readonly sessionId: SessionId;
  readonly repoId: string;
  /** null 表示没显式给，由实现填登记默认分支；给了就必须原样返回。 */
  readonly branch: string | null;
  readonly operation: typeof PROJECT_GIT_SESSION_FETCH_OPERATION;
}

/** 项目凭据缝：返回已生成好的 `Basic …` 头值，空串表示匿名；null 表示不可用（失败）。 */
export type ProjectGitSessionFetchCredentialInput = {
  readonly accountId: string;
  readonly projectId: ProjectId;
  readonly repoId: string;
  readonly repoUrl: string;
};

export type ProjectGitSessionFetchCredential = (
  input: ProjectGitSessionFetchCredentialInput
) => Promise<string | null>;

/** 与 `ws.import_project_git_bundle` 的参数对齐；这里不出现任何凭据字段。 */
export interface ProjectGitSessionBundleImport {
  readonly path: string;
  readonly expectedUrl: string;
  readonly bundleBase64: string;
  readonly bundleSha256: string;
  readonly tipSha: string;
  readonly ref: string;
}

export interface ProjectGitSessionImportOutcome {
  readonly ref: string;
  readonly tipSha: string;
  readonly alreadyPresent: boolean;
}

/**
 * 导入缝：组合根接到 `ServerGateway.importProjectGitBundle(workerId, input)`。
 * 返回错误时**只有 `not_implemented` 被当作「确定没有发出」**；其它错误（包括超时、
 * 断线、能力拒绝）可能已经产生副作用，本模块保守地按「结果未知」处理。
 */
export type ProjectGitSessionFetchImporter = (
  workerId: string,
  bundle: ProjectGitSessionBundleImport
) => Promise<Result<ProjectGitSessionImportOutcome, DomainError>>;

export interface ProjectGitSessionFetchDeps {
  /** 当前部署是否启用隔离抓取 + 无凭据导入；关闭时任何调用都拒绝，不回退。 */
  readonly policy: { readonly enabled: boolean };
  readonly authorize: (
    input: ProjectGitSessionFetchAuthorizeInput
  ) => Promise<Result<ProjectGitSessionFetchBinding, DomainError>>;
  readonly credential: ProjectGitSessionFetchCredential;
  /** 已存在的隔离抓取机制（`createProjectGitFetcher`），这里只调用它的 `fetch`。 */
  readonly fetcher: Pick<ProjectGitFetcher, 'fetch'>;
  readonly importer: ProjectGitSessionFetchImporter;
  readonly operationReceipts: OperationReceiptStore;
}

export interface ProjectGitSessionFetchResult {
  readonly projectId: ProjectId;
  readonly repoId: string;
  readonly workerId: string;
  readonly branch: string;
  readonly ref: string;
  readonly tip: string;
  readonly bundleBytes: number;
  readonly alreadyPresent: boolean;
}

const hasText = (value: unknown, max: number = MAX_ID_LENGTH): value is string =>
  typeof value === 'string' &&
  value !== '' &&
  value === value.trim() &&
  value.length <= max &&
  !CONTROL_CHARACTERS.test(value);

const exactId = (value: unknown, label: string): Result<string, DomainError> =>
  hasText(value) ? ok(value) : err(invalid(`${label}不合法`));

/** 专用 ref 只由平台拼：`refs/agent-hub/fetch/<projectId>/<40 位 SHA>`。 */
export function projectGitSessionFetchRef(projectId: string, tip: string): Result<string, DomainError> {
  if (!PROJECT_REF_PATTERN.test(projectId)) return err(invalid('项目 ID 不能用于项目 Git 抓取 ref'));
  if (!SHA_PATTERN.test(tip)) return err(invalid('项目 Git bundle 必须给完整 40 位小写 SHA'));
  return ok(`refs/agent-hub/fetch/${projectId}/${tip}`);
}

/** 分支名按 Git ref 的安全子集校验；显式输入不接受 `refs/...` 前缀，避免两种写法漂移。 */
function checkedBranch(value: unknown): Result<string, DomainError> {
  if (typeof value !== 'string') return err(invalid('分支名不合法'));
  const branch = value.trim();
  if (
    branch !== value ||
    !BRANCH_PATTERN.test(branch) ||
    branch.startsWith('refs/') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.includes('//') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.endsWith('.lock') ||
    branch === '@'
  ) {
    return err(invalid('分支名不合法'));
  }
  return ok(branch);
}

/** 已生成好的 Authorization 头值；只接受空串或 `Basic …`，不接受其它方案。 */
function checkedAuthorization(value: string): Result<string, DomainError> {
  if (value === '') return ok('');
  if (
    value.length > MAX_AUTHORIZATION_LENGTH ||
    !value.startsWith('Basic ') ||
    value.length <= 'Basic '.length ||
    CONTROL_CHARACTERS.test(value)
  ) {
    return err(invalid('项目 Git 凭据格式不正确'));
  }
  return ok(value);
}

function validateCommand(
  command: ProjectGitSessionFetchCommand
): Result<{ readonly branch: string | null }, DomainError> {
  if (!hasText(command.actorId)) return err(invalid('缺少调用人'));
  if (!ACTOR_VIA.includes(command.actorVia)) return err(invalid('调用来源不合法'));
  if (!hasText(command.sessionId) || !SESSION_REF_PATTERN.test(command.sessionId)) {
    return err(invalid('会话 ID 不合法'));
  }
  if (!hasText(command.requestKey, MAX_REQUEST_KEY_LENGTH) || !REQUEST_KEY_PATTERN.test(command.requestKey)) {
    return err(invalid('请求键不合法'));
  }
  const repo = exactId(command.repoId, '仓库 ID');
  if (!repo.ok) return repo;
  if (command.branch === undefined || command.branch === null) return ok({ branch: null });
  const branch = checkedBranch(command.branch);
  if (!branch.ok) return branch;
  return ok({ branch: branch.value });
}

/**
 * 服务端绑定必须与冻结输入一致，并且自身形状合法；默认分支由授权缝填，显式分支不能改写。
 */
function validateBinding(
  binding: ProjectGitSessionFetchBinding,
  command: ProjectGitSessionFetchCommand,
  explicitBranch: string | null
): Result<void, DomainError> {
  if (!hasText(binding.accountId) || binding.accountId !== command.actorId) {
    return err(forbidden('项目 Git 抓取授权账号与会话绑定不一致'));
  }
  if (!hasText(binding.sessionId) || binding.sessionId !== command.sessionId) {
    return err(forbidden('项目 Git 抓取授权会话与当前绑定不一致'));
  }
  if (!hasText(binding.projectId) || !PROJECT_REF_PATTERN.test(binding.projectId)) {
    return err(forbidden('项目 Git 抓取缺少合法项目'));
  }
  if (!hasText(binding.repoId) || binding.repoId !== command.repoId) {
    return err(forbidden('项目 Git 抓取仓库与请求不一致'));
  }
  if (!hasText(binding.workerId)) return err(forbidden('项目 Git 抓取缺少 Worker'));
  if (!hasText(binding.workspaceId)) return err(forbidden('项目 Git 抓取缺少工作空间'));
  if (!hasText(binding.workspacePath) || !isAbsolute(binding.workspacePath)) {
    return err(forbidden('项目 Git 抓取工作目录不合法'));
  }
  if (!hasText(binding.repoUrl)) return err(forbidden('项目 Git 抓取缺少仓库地址'));
  if (binding.repoUrl !== binding.repoUrl.trim()) return err(forbidden('项目 Git 抓取仓库地址不合法'));
  let url: URL;
  try {
    url = new URL(binding.repoUrl);
  } catch {
    return err(forbidden('项目 Git 抓取仓库地址不合法'));
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return err(forbidden('项目 Git 抓取只接受已登记的 HTTPS 仓库地址'));
  }
  const branch = checkedBranch(binding.branch);
  if (!branch.ok) return err(forbidden('项目 Git 抓取分支不合法'));
  if (explicitBranch !== null && branch.value !== explicitBranch) {
    return err(forbidden('项目 Git 抓取分支与请求不一致'));
  }
  return ok(undefined);
}

/** 抓取前 / 后的完整绑定比较；路径按写入时的精确值比较，规范化差异也算漂移。 */
function bindingChanged(
  before: ProjectGitSessionFetchBinding,
  after: ProjectGitSessionFetchBinding
): boolean {
  return (
    before.accountId !== after.accountId ||
    before.sessionId !== after.sessionId ||
    before.projectId !== after.projectId ||
    before.repoId !== after.repoId ||
    before.repoUrl !== after.repoUrl ||
    before.workerId !== after.workerId ||
    before.workspaceId !== after.workspaceId ||
    before.workspacePath !== after.workspacePath ||
    before.branch !== after.branch
  );
}

/**
 * 目标身份摘要：把精确 Worker / 工作空间 / 路径 / 仓库地址折成摘要。
 * 回执与回放指纹只落这份摘要，不落原始路径或 URL；同一请求键在绑定漂移后即冲突。
 */
const bindingDigest = (binding: ProjectGitSessionFetchBinding): string =>
  createHash('sha256')
    .update(
      requestFingerprint([
        binding.workerId,
        binding.workspaceId,
        binding.workspacePath,
        binding.repoUrl
      ])
    )
    .digest('hex');

const fingerprintOf = (command: ProjectGitSessionFetchCommand, binding: ProjectGitSessionFetchBinding): string =>
  createHash('sha256')
    .update(
      requestFingerprint([
        PROJECT_GIT_SESSION_FETCH_FINGERPRINT_VERSION,
        command.actorVia,
        command.sessionId,
        binding.projectId,
        binding.repoId,
        binding.branch,
        bindingDigest(binding)
      ])
    )
    .digest('hex');

/** 抓取失败映射成安全领域错误；不转发上游 / Git 原始消息。 */
function fetchFailure(code: ProjectGitFetchFailureCode): DomainError {
  switch (code) {
    case 'bad_target':
    case 'bad_branch':
    case 'bad_authorization':
      return invalid('项目 Git 抓取目标或分支不合法');
    case 'blocked':
      return forbidden('项目 Git 抓取目标不在允许范围内');
    case 'busy':
      return conflict('项目 Git 抓取繁忙，请稍后再试');
    case 'timeout':
      return unavailable('项目 Git 抓取超时');
    case 'too_large':
      return unavailable('项目 Git 抓取超出上限');
    case 'bundle_invalid':
      return unavailable('项目 Git 抓取结果校验失败');
    case 'closed':
      return unavailable('项目 Git 抓取已关闭');
    case 'upstream':
    case 'git_failed':
    case 'io':
    case 'generic':
      return unavailable('项目 Git 抓取失败');
  }
}

/**
 * 有界读取：用同一个文件描述符做 O_NOFOLLOW 打开 + fstat，读取到「声明大小 + 1」为止。
 * 任何长度不符、多出字节或符号链接都拒绝；句柄在 finally 关闭。
 */
async function readBoundedBundle(
  path: string,
  expectedBytes: number,
  expectedSha256: string
): Promise<Result<Buffer, DomainError>> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // 先用非阻塞模式打开，避免错误的 FIFO 路径在 fstat 可以拒绝它之前卡住。
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    // O_NOFOLLOW 命中的符号链接 / 缺失文件都统一按不可读取处理。
    return err(unavailable('项目 Git bundle 不存在或不可读取'));
  }
  try {
    let info;
    try {
      info = await handle.stat();
    } catch {
      return err(unavailable('项目 Git bundle 不存在或不可读取'));
    }
    if (!info.isFile()) return err(unavailable('项目 Git bundle 不是普通文件'));
    if (info.size <= 0 || info.size > PROJECT_GIT_SESSION_FETCH_MAX_BUNDLE_BYTES) {
      return err(unavailable('项目 Git bundle 超过 8 MiB 上限'));
    }
    if (info.size !== expectedBytes) {
      return err(unavailable('项目 Git bundle 大小与抓取结果不一致'));
    }

    // 固定按声明大小 + 1 申请：读满声明大小后再探 1 字节，必须正好是 EOF。
    const buffer = Buffer.allocUnsafe(info.size + 1);
    let offset = 0;
    while (offset < info.size) {
      const { bytesRead } = await handle.read(buffer, offset, info.size - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    if (offset !== info.size) return err(unavailable('项目 Git bundle 读取长度与声明大小不一致'));
    const { bytesRead: extra } = await handle.read(buffer, info.size, 1, info.size);
    if (extra !== 0) return err(unavailable('项目 Git bundle 在读取期间发生变化'));

    const bytes = buffer.subarray(0, info.size);
    if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
      return err(unavailable('项目 Git bundle 校验失败'));
    }
    return ok(bytes);
  } catch {
    return err(unavailable('项目 Git bundle 读取失败'));
  } finally {
    try {
      await handle.close();
    } catch {
      // 关闭失败不影响已经得出的校验结论。
    }
  }
}

/**
 * bundle 身份校验：分支 / ref / 40 位 SHA / 大小 / SHA-256 全部对上，才允许进入导入。
 * 读取有界（同句柄 fstat + 定长读 + EOF 探测），bundle 文件无论成败都立即删除。
 */
async function readVerifiedBundle(
  fetched: ProjectGitFetchResult,
  binding: ProjectGitSessionFetchBinding
): Promise<Result<Buffer, DomainError>> {
  // 只清理绝对路径；相对路径绝不落到当前工作目录去删。
  const cleanupPath = isAbsolute(fetched.bundlePath) ? fetched.bundlePath : null;
  try {
    if (cleanupPath === null) return err(unavailable('项目 Git 抓取结果路径不合法'));
    if (fetched.branch !== binding.branch) return err(unavailable('项目 Git 抓取分支与绑定不一致'));
    if (fetched.ref !== `refs/heads/${binding.branch}`) {
      return err(unavailable('项目 Git 抓取 ref 与分支不一致'));
    }
    if (!SHA_PATTERN.test(fetched.tip)) return err(unavailable('项目 Git bundle 只支持 40 位 SHA-1 提交'));
    if (!BUNDLE_SHA_PATTERN.test(fetched.bundleSha256)) {
      return err(unavailable('项目 Git bundle 摘要不合法'));
    }
    if (
      !Number.isSafeInteger(fetched.bundleBytes) ||
      fetched.bundleBytes <= 0 ||
      fetched.bundleBytes > PROJECT_GIT_SESSION_FETCH_MAX_BUNDLE_BYTES
    ) {
      return err(unavailable('项目 Git bundle 超过 8 MiB 上限'));
    }
    return await readBoundedBundle(fetched.bundlePath, fetched.bundleBytes, fetched.bundleSha256);
  } finally {
    // 机制约定 bundle 写在调用方输出目录，由调用方清理；读进内存后立刻删掉。
    if (cleanupPath !== null) {
      try {
        await rm(cleanupPath, { force: true });
      } catch {
        // 清理失败不影响已经拿到的校验结果；残留文件由父级目录的生命周期兜底。
      }
    }
  }
}

const RECEIPT_KEYS = [
  'version',
  'projectId',
  'repoId',
  'workerId',
  'workspaceId',
  'bindingHash',
  'branch',
  'ref',
  'tip',
  'bundleBytes',
  'alreadyPresent'
] as const;

const receipt = (
  binding: ProjectGitSessionFetchBinding,
  imported: { readonly tip: string; readonly ref: string; readonly bundleBytes: number; readonly alreadyPresent: boolean }
): OperationReceiptPayload => ({
  version: PROJECT_GIT_SESSION_FETCH_RECEIPT_VERSION,
  projectId: binding.projectId,
  repoId: binding.repoId,
  workerId: binding.workerId,
  workspaceId: binding.workspaceId,
  // 只存目标摘要，不把原始工作空间路径或仓库地址写进持久回执。
  bindingHash: bindingDigest(binding),
  branch: binding.branch,
  ref: imported.ref,
  tip: imported.tip,
  bundleBytes: imported.bundleBytes,
  alreadyPresent: imported.alreadyPresent
});

/** 回执读回后逐字段校验；`unknown` 不能直接当业务对象用。 */
function readReceipt(
  payload: OperationReceiptPayload,
  binding: ProjectGitSessionFetchBinding
): Result<ProjectGitSessionFetchResult, DomainError> {
  const keys = Object.keys(payload);
  if (keys.length !== RECEIPT_KEYS.length || !RECEIPT_KEYS.every((key) => keys.includes(key))) {
    return err(unavailable('项目 Git 抓取回执形状不正确，请核对'));
  }
  if (payload.version !== PROJECT_GIT_SESSION_FETCH_RECEIPT_VERSION) {
    return err(unavailable('项目 Git 抓取回执版本不支持，请核对'));
  }
  const fields = {
    projectId: payload.projectId,
    repoId: payload.repoId,
    workerId: payload.workerId,
    workspaceId: payload.workspaceId,
    branch: payload.branch,
    ref: payload.ref,
    tip: payload.tip
  };
  for (const [label, value] of Object.entries(fields)) {
    if (!hasText(value)) return err(unavailable(`项目 Git 抓取回执的 ${label} 不合法，请核对`));
  }
  const bundleBytes = payload.bundleBytes;
  if (
    typeof bundleBytes !== 'number' ||
    !Number.isSafeInteger(bundleBytes) ||
    bundleBytes <= 0 ||
    bundleBytes > PROJECT_GIT_SESSION_FETCH_MAX_BUNDLE_BYTES
  ) {
    return err(unavailable('项目 Git 抓取回执的 bundleBytes 不合法，请核对'));
  }
  const alreadyPresent = payload.alreadyPresent;
  if (typeof alreadyPresent !== 'boolean') {
    return err(unavailable('项目 Git 抓取回执缺少 alreadyPresent，请核对'));
  }
  const bindingHash = payload.bindingHash;
  if (typeof bindingHash !== 'string' || !BUNDLE_SHA_PATTERN.test(bindingHash)) {
    return err(unavailable('项目 Git 抓取回执的目标摘要不合法，请核对'));
  }
  if (bindingHash !== bindingDigest(binding)) {
    return err(unavailable('项目 Git 抓取回执与当前目标不一致，请核对'));
  }
  const read = fields as Record<keyof typeof fields, string>;
  if (read.projectId !== binding.projectId || read.repoId !== binding.repoId) {
    return err(unavailable('项目 Git 抓取回执与当前项目或仓库不一致，请核对'));
  }
  if (read.workerId !== binding.workerId || read.workspaceId !== binding.workspaceId) {
    return err(unavailable('项目 Git 抓取回执与当前 Worker 或工作空间不一致，请核对'));
  }
  if (read.branch !== binding.branch) {
    return err(unavailable('项目 Git 抓取回执与当前分支不一致，请核对'));
  }
  const expectedRef = projectGitSessionFetchRef(read.projectId, read.tip);
  if (!expectedRef.ok) return err(unavailable('项目 Git 抓取回执的 ref 不合法，请核对'));
  if (read.ref !== expectedRef.value) {
    return err(unavailable('项目 Git 抓取回执的 ref 与提交不一致，请核对'));
  }
  return ok({
    projectId: binding.projectId,
    repoId: read.repoId,
    workerId: read.workerId,
    branch: read.branch,
    ref: read.ref,
    tip: read.tip,
    bundleBytes,
    alreadyPresent
  });
}

const releaseQuietly = async (
  deps: ProjectGitSessionFetchDeps,
  reservation: { readonly key: string; readonly fingerprint: string; readonly reservationId: string }
): Promise<void> => {
  try {
    await deps.operationReceipts.release(reservation);
  } catch {
    // 释放失败不改变「导入没有发出」的事实；保留原错误。
  }
};

/**
 * 会话级项目 Git 抓取 + 无凭据 bundle 导入。
 *
 * 成功返回新建（或已存在）的专用 ref 与提交；任何不确定的导入结果都返回
 * `unavailable` 并保留 pending，要求调用方用同一请求键回来核对，绝不自动重放。
 */
export async function fetchProjectGitForSession(
  deps: ProjectGitSessionFetchDeps,
  command: ProjectGitSessionFetchCommand
): Promise<Result<ProjectGitSessionFetchResult, DomainError>> {
  const shape = validateCommand(command);
  if (!shape.ok) return shape;
  const explicitBranch = shape.value.branch;

  if (!deps.policy.enabled) {
    return err(unavailable('项目 Git 会话抓取未在当前部署启用'));
  }

  const authorizeInput = (): ProjectGitSessionFetchAuthorizeInput => ({
    actor: { userId: command.actorId, via: command.actorVia },
    sessionId: command.sessionId,
    repoId: command.repoId,
    branch: explicitBranch,
    operation: PROJECT_GIT_SESSION_FETCH_OPERATION
  });

  let first: Result<ProjectGitSessionFetchBinding, DomainError>;
  try {
    first = await deps.authorize(authorizeInput());
  } catch {
    // 授权缝自身异常：中性说法，不当作“已拒绝”，也没有任何副作用。
    return err(unavailable('项目 Git 抓取授权暂时不可用'));
  }
  if (!first.ok) return first;
  const binding = first.value;
  const bound = validateBinding(binding, command, explicitBranch);
  if (!bound.ok) return bound;

  const fingerprint = fingerprintOf(command, binding);
  // 项目 id 只在授权之后才可信；键里的项目来自服务端绑定，不来自入参。
  const key = requestReplayKey(
    {
      actorId: command.actorId,
      sourceSessionId: command.sessionId,
      projectId: binding.projectId,
      operation: PROJECT_GIT_SESSION_FETCH_OPERATION
    },
    command.requestKey
  );

  let reserved: OperationReserveOutcome;
  try {
    reserved = await deps.operationReceipts.reserve({
      key,
      fingerprint,
      actorId: command.actorId,
      sourceSessionId: command.sessionId,
      projectId: binding.projectId,
      operation: PROJECT_GIT_SESSION_FETCH_OPERATION
    });
  } catch {
    return err(unavailable('无法建立项目 Git 抓取回执，请稍后重试'));
  }

  if (reserved.status === 'conflict') return err(conflict('同一请求键对应不同参数'));
  if (reserved.status === 'pending') {
    return err(conflict('同一请求键已有未确认的项目 Git 抓取，请用同一请求键只读核对回执，不要重复执行'));
  }
  if (reserved.status === 'completed') return readReceipt(reserved.payload, binding);

  const reservation = { key, fingerprint, reservationId: reserved.reservationId };
  const beforeImport = async (
    error: DomainError
  ): Promise<Result<ProjectGitSessionFetchResult, DomainError>> => {
    await releaseQuietly(deps, reservation);
    return err(error);
  };

  let authorization: string | null;
  try {
    authorization = await deps.credential({
      accountId: binding.accountId,
      projectId: binding.projectId,
      repoId: binding.repoId,
      repoUrl: binding.repoUrl
    });
  } catch {
    authorization = null;
  }
  if (authorization === null) return beforeImport(unavailable('项目 Git 凭据不可用'));
  const header = checkedAuthorization(authorization);
  if (!header.ok) return beforeImport(header.error);

  let fetched: ProjectGitFetchResult;
  try {
    const outcome = await deps.fetcher.fetch({
      repoUrl: binding.repoUrl,
      branch: binding.branch,
      authorization: header.value
    });
    if (!outcome.ok) return beforeImport(fetchFailure(outcome.code));
    fetched = outcome.result;
  } catch {
    return beforeImport(unavailable('项目 Git 抓取失败'));
  }

  const verified = await readVerifiedBundle(fetched, binding);
  if (!verified.ok) return beforeImport(verified.error);
  const bytes = verified.value;

  // 抓取是只读的；但写入 Worker 之前必须再确认一次实时授权与服务端绑定没有漂移。
  let second: Result<ProjectGitSessionFetchBinding, DomainError>;
  try {
    second = await deps.authorize(authorizeInput());
  } catch {
    // 第二次授权发生在导入之前，确定没有副作用；释放占位并用中性说法。
    return beforeImport(unavailable('项目 Git 抓取授权暂时不可用'));
  }
  if (!second.ok) return beforeImport(second.error);
  const reconfirmed = validateBinding(second.value, command, explicitBranch);
  if (!reconfirmed.ok) return beforeImport(reconfirmed.error);
  if (bindingChanged(binding, second.value)) {
    return beforeImport(forbidden('项目 Git 抓取目标在确认前发生变化'));
  }

  const ref = projectGitSessionFetchRef(binding.projectId, fetched.tip);
  if (!ref.ok) return beforeImport(ref.error);

  const bundleBase64 = bytes.toString('base64');
  if (bundleBase64.length > PROJECT_GIT_SESSION_FETCH_MAX_BASE64_BYTES) {
    return beforeImport(unavailable('项目 Git bundle 超过 8 MiB 上限'));
  }

  let imported: Result<ProjectGitSessionImportOutcome, DomainError>;
  try {
    imported = await deps.importer(binding.workerId, {
      path: binding.workspacePath,
      expectedUrl: binding.repoUrl,
      bundleBase64,
      bundleSha256: fetched.bundleSha256,
      tipSha: fetched.tip,
      ref: ref.value
    });
  } catch {
    // 发出后异常：可能已经创建 ref；保留 pending，不自动重放。
    return err(unavailable(UNKNOWN_IMPORT_RESULT));
  }

  if (!imported.ok) {
    if (imported.error.code === 'not_implemented') {
      // 已知的「零字节发出」：Worker 没有开这个能力，确定没有副作用，释放后允许重试。
      return beforeImport(unavailable('当前 Worker 未启用项目 Git bundle 导入'));
    }
    // 其它错误无法区分「没发出」和「发出后失败」；保守按结果未知处理。
    return err(unavailable(UNKNOWN_IMPORT_RESULT));
  }

  if (
    imported.value.ref !== ref.value ||
    imported.value.tipSha !== fetched.tip ||
    typeof imported.value.alreadyPresent !== 'boolean'
  ) {
    return err(unavailable(UNKNOWN_IMPORT_RESULT));
  }

  const payload = receipt(binding, {
    tip: fetched.tip,
    ref: ref.value,
    bundleBytes: fetched.bundleBytes,
    alreadyPresent: imported.value.alreadyPresent
  });

  let completed: Awaited<ReturnType<OperationReceiptStore['complete']>>;
  try {
    completed = await deps.operationReceipts.complete({
      key,
      fingerprint,
      reservationId: reservation.reservationId,
      payload
    });
  } catch {
    return err(unavailable('项目 Git 抓取已完成，但回执未能确认；请用同一请求键只读核对'));
  }
  if (completed.status === 'conflict') {
    return err(unavailable('项目 Git 抓取回执状态冲突，请用同一请求键只读核对'));
  }
  if (completed.status === 'replayed') return readReceipt(completed.payload, binding);
  return readReceipt(payload, binding);
}
