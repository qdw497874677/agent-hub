import {
  ASSET_KINDS,
  ASSET_LIMITS,
  err,
  forbidden,
  invalid,
  notFound,
  ok,
  unavailable,
  type AssetKind,
  type AssetScope,
  type DomainError,
  type GrantActor,
  type Result,
  type SessionId,
  type ToolContext,
  type ToolDescriptor,
  type ToolProvider,
  type ToolScope
} from '@agent-hub/domain';

/**
 * 项目会话资产工具（docs/design/project-session-mcp.md）。
 *
 * 五个工具共用同一条边界：
 * - 身份只来自冻结的 `ctx.grant`（actor / via / session），payload 里不存在
 *   actor_id、project_id、session_id 这类可覆盖绑定的参数；
 * - 参数严格白名单，未知键直接拒绝，诊断只列键名；
 * - 文件只收资产内的相对 POSIX 路径与 UTF-8 文本，上限复用 `ASSET_LIMITS`，
 *   不提供任何绕过上限的开关；
 * - 响应按白名单重建：列表只有标识与开关，读取只回显**明确请求**的那个文件和
 *   版本内的相对文件名；提交结果只回 digest / receipt，不回正文、绝对路径或密钥；
 * - 读取永远只读 `asset.pinned`（已发布版本），所以待审提交不会因为知道 digest
 *   就能被读取。
 *
 * 项目归属、可见性、维护权限、项目开关权限与审批流全部由注入的回调重查；
 * 这里不从参数、当前目录或资产内容推断身份。
 */

export const PROJECT_ASSET_LIST_TOOL_NAME = 'project.asset.list';
export const PROJECT_ASSET_READ_TOOL_NAME = 'project.asset.read';
export const PROJECT_ASSET_CREATE_TOOL_NAME = 'project.asset.create';
export const PROJECT_ASSET_REVISE_TOOL_NAME = 'project.asset.revise';
export const PROJECT_ASSET_SET_ENABLED_TOOL_NAME = 'project.asset.set_enabled';

const REQUEST_KEY_MAX = 200;
const ID_MAX = 200;
const NAME_MAX = 64;
const PATH_MAX = 512;
const STATUS_MAX = 40;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const LIST_DEFAULT = 50;
const LIST_MAX = 200;
const READ_CONTENT_MAX = 64 * 1024;
const UNKNOWN_KEYS_SHOWN = 5;
const UNKNOWN_KEY_MAX = 40;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 读 / 写各自一个 scope；装配方注入，默认授权里不出现。 */
export interface ProjectAssetToolScopes {
  /** `project:read`：列表与读取。 */
  readonly read: ToolScope;
  /** `project:asset-write`（授权服务里的 `asset:write`）：创建 / 修订 / 开关。 */
  readonly write: ToolScope;
}

/** 只来自 `ctx.grant`；不接受 payload 覆盖。 */
export interface ProjectAssetBinding {
  readonly actorId: string;
  readonly actorVia: GrantActor['via'];
  readonly sessionId: SessionId;
}

export interface ProjectAssetListQuery extends ProjectAssetBinding {
  readonly kind: AssetKind | null;
  /** false（默认）= 只看当前生效的资产；true = 连同被关掉 / 被遮盖的一起看。 */
  readonly includeDisabled: boolean;
  readonly limit: number;
}

/** 列表白名单：够选择资产，不含描述正文、来源地址、绝对路径、密钥或作者 id。 */
export interface ProjectAssetSummary {
  readonly assetId: string;
  readonly kind: AssetKind;
  readonly name: string;
  readonly scope: AssetScope;
  readonly sourceType: 'upload' | 'git' | 'builtin';
  readonly enabled: boolean;
  readonly overridden: boolean;
  readonly shadowedBy: string | null;
  readonly published: boolean;
}

export interface ProjectAssetListSnapshot {
  readonly assets: readonly ProjectAssetSummary[];
  readonly truncated: boolean;
}

export interface ProjectAssetReadQuery extends ProjectAssetBinding {
  readonly assetId: string;
  /** null = 只读版本清单；给了路径就必须正好命中版本中的一个文件。 */
  readonly path: string | null;
}

export interface ProjectAssetReadFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface ProjectAssetReadSnapshot {
  readonly assetId: string;
  readonly kind: AssetKind;
  readonly name: string;
  readonly scope: AssetScope;
  readonly digest: string;
  readonly files: readonly ProjectAssetReadFile[];
  /** 只有显式请求路径时才有；内容是资产里本来就可见的文本。 */
  readonly file: { readonly path: string; readonly content: string; readonly size: number } | null;
}

/** 交给回调的文件：UTF-8 文本 + 资产根内的相对路径。 */
export interface ProjectAssetInputFile {
  readonly path: string;
  readonly content: string;
}

export interface ProjectAssetCreateCommand extends ProjectAssetBinding {
  readonly requestKey: string;
  readonly kind: AssetKind;
  /** null = 让领域从 SKILL.md frontmatter 等位置推导。 */
  readonly name: string | null;
  readonly files: readonly ProjectAssetInputFile[];
}

export interface ProjectAssetReviseCommand extends ProjectAssetBinding {
  readonly requestKey: string;
  readonly assetId: string;
  readonly files: readonly ProjectAssetInputFile[];
}

export interface ProjectAssetSetEnabledCommand extends ProjectAssetBinding {
  readonly requestKey: string;
  readonly assetId: string;
  /** null = 清掉项目覆盖，回到默认。 */
  readonly enabled: boolean | null;
}

/** 创建 / 修订的收据：只回标识、digest 与提交状态。 */
export interface ProjectAssetWriteSnapshot {
  readonly assetId: string;
  readonly kind: AssetKind;
  readonly name: string;
  readonly scope: AssetScope;
  /** 最新版本（待审或已发布）的 digest；不是正文。 */
  readonly digest: string;
  readonly published: boolean;
  readonly submissionId: string | null;
  readonly submissionStatus: string | null;
}

export interface ProjectAssetEnableSnapshot {
  readonly assetId: string;
  /** 保存后的生效状态（null 已按项目默认解析）。 */
  readonly enabled: boolean;
  readonly overridden: boolean;
}

export interface ProjectAssetToolDeps {
  readonly scopes: ProjectAssetToolScopes;
  /**
   * 列出当前授权项目里调用者可见的资产。实现方负责：按会话重新加载账号、
   * 核对项目可见性与 `project:read`，按 kind / enabled 过滤并限制条数。
   */
  readonly listAssets: (
    query: ProjectAssetListQuery
  ) => Promise<Result<readonly ProjectAssetSummary[], DomainError>>;
  /**
   * 读取当前项目里一个**已发布**版本的清单，或其中一个明确指定的文本文件。
   * 实现方负责：项目 / 资产可见性、只取 `asset.pinned`、拒绝待审版本、
   * 不展开密钥、不返回绝对路径。provider 仍会再按白名单裁剪一次。
   */
  readonly readAsset: (
    query: ProjectAssetReadQuery
  ) => Promise<Result<ProjectAssetReadSnapshot, DomainError>>;
  /**
   * 在当前项目创建项目级资产。实现方负责：`asset:write` 授权、账号重载、
   * 走 `submitNewAsset` / 审批而不是直接发布；请求键幂等。
   */
  readonly createAsset: (
    command: ProjectAssetCreateCommand
  ) => Promise<Result<ProjectAssetWriteSnapshot, DomainError>>;
  /**
   * 给已有项目资产交新版本。实现方负责：可见性与维护权限、审批流、请求键幂等；
   * 不得直接改团队 / 全局原始资产。
   */
  readonly reviseAsset: (
    command: ProjectAssetReviseCommand
  ) => Promise<Result<ProjectAssetWriteSnapshot, DomainError>>;
  /**
   * 改当前项目的资产开关。实现方负责：项目 owner / 团队负责人 / 管理员与
   * `project.update` 权限，以及请求键幂等。
   */
  readonly setAssetEnabled: (
    command: ProjectAssetSetEnabledCommand
  ) => Promise<Result<ProjectAssetEnableSnapshot, DomainError>>;
}

const LIST_INPUT_KEYS = new Set(['kind', 'include_disabled', 'limit']);
const READ_INPUT_KEYS = new Set(['asset_id', 'path']);
const CREATE_INPUT_KEYS = new Set(['request_key', 'kind', 'name', 'files']);
const REVISE_INPUT_KEYS = new Set(['request_key', 'asset_id', 'files']);
const SET_ENABLED_INPUT_KEYS = new Set(['request_key', 'asset_id', 'enabled']);
const FILE_INPUT_KEYS = new Set(['path', 'content']);

function listDescriptor(scope: ToolScope): ToolDescriptor {
  return {
    name: PROJECT_ASSET_LIST_TOOL_NAME,
    version: 1,
    scope,
    perMinute: 30,
    omitAuditPayload: true,
    description:
      'List assets visible in the current project with their project switch state. Returns a bounded { assets: [{ assetId, kind, name, scope, sourceType, enabled, overridden, shadowedBy, published }], truncated }. It never includes descriptions, source URLs, absolute paths, credentials, or secret values. By default only effective assets are returned; set include_disabled=true to inspect switched-off or shadowed ones.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [...ASSET_KINDS],
          description: 'Optional asset kind filter.'
        },
        include_disabled: {
          type: 'boolean',
          description: 'Defaults to false: only assets currently effective for this project.'
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: LIST_MAX,
          description: `Maximum number of assets to return (default ${LIST_DEFAULT}, max ${LIST_MAX}).`
        }
      },
      required: [],
      additionalProperties: false
    }
  };
}

function readDescriptor(scope: ToolScope): ToolDescriptor {
  return {
    name: PROJECT_ASSET_READ_TOOL_NAME,
    version: 1,
    scope,
    perMinute: 60,
    omitAuditPayload: true,
    description:
      'Read the published version of an asset visible in the current project. Without path it returns the version manifest { asset: { assetId, kind, name, scope, digest, files: [{ path, sha256, size }], file: null } }; with path it also returns that single UTF-8 text file as { path, content, size } (max 64 KiB). Only the pinned (approved) version is readable; pending submissions and arbitrary digests are never exposed. No absolute paths, credentials, or secret values are returned.',
    inputSchema: {
      type: 'object',
      properties: {
        asset_id: {
          type: 'string',
          minLength: 1,
          maxLength: ID_MAX,
          description: 'Asset id returned by project.asset.list.'
        },
        path: {
          type: 'string',
          minLength: 1,
          maxLength: PATH_MAX,
          description: 'Optional relative path inside the published asset, e.g. "SKILL.md". Omit for the manifest only.'
        }
      },
      required: ['asset_id'],
      additionalProperties: false
    }
  };
}

function filesSchema(description: string): Readonly<Record<string, unknown>> {
  return {
    type: 'array',
    minItems: 1,
    maxItems: ASSET_LIMITS.maxFiles,
    description,
    items: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          maxLength: PATH_MAX,
          description: 'Relative POSIX path inside the asset; no absolute paths, "..", backslashes, or drive letters.'
        },
        content: {
          type: 'string',
          maxLength: ASSET_LIMITS.maxFileBytes,
          description: 'UTF-8 text of the file. Binary content is not accepted.'
        }
      },
      required: ['path', 'content'],
      additionalProperties: false
    }
  };
}

function createDescriptor(scope: ToolScope): ToolDescriptor {
  return {
    name: PROJECT_ASSET_CREATE_TOOL_NAME,
    version: 1,
    scope,
    perMinute: 6,
    omitAuditPayload: true,
    description:
      'Submit a new project-owned asset for approval. Files are UTF-8 text with relative POSIX paths (max 200 files, 1 MiB each, 4 MiB total). The asset is never published directly; approval and publication stay in the asset review flow. Returns { asset: { assetId, kind, name, scope, digest, published, submissionId, submissionStatus } }. Reuse the same request key on retries.',
    inputSchema: {
      type: 'object',
      properties: {
        request_key: {
          type: 'string',
          minLength: 1,
          maxLength: REQUEST_KEY_MAX,
          description: 'Stable idempotency key chosen by you; reuse it verbatim when retrying the same creation.'
        },
        kind: {
          type: 'string',
          enum: [...ASSET_KINDS],
          description: 'Asset kind. Project assets are created with project scope.'
        },
        name: {
          type: 'string',
          minLength: 1,
          maxLength: NAME_MAX,
          description: 'Optional asset name (lowercase letters, digits, single hyphens). Omit to derive it from the skill/instruction metadata.'
        },
        files: filesSchema('Asset files. At least one file; text content only.')
      },
      required: ['request_key', 'kind', 'files'],
      additionalProperties: false
    }
  };
}

function reviseDescriptor(scope: ToolScope): ToolDescriptor {
  return {
    name: PROJECT_ASSET_REVISE_TOOL_NAME,
    version: 1,
    scope,
    perMinute: 6,
    omitAuditPayload: true,
    description:
      'Submit a new revision of an existing project asset for approval. Files are UTF-8 text with relative POSIX paths (max 200 files, 1 MiB each, 4 MiB total). This creates a pending submission and never edits team or global originals directly. Returns { asset: { assetId, kind, name, scope, digest, published, submissionId, submissionStatus } }. Reuse the same request key on retries.',
    inputSchema: {
      type: 'object',
      properties: {
        request_key: {
          type: 'string',
          minLength: 1,
          maxLength: REQUEST_KEY_MAX,
          description: 'Stable idempotency key chosen by you; reuse it verbatim when retrying the same revision.'
        },
        asset_id: {
          type: 'string',
          minLength: 1,
          maxLength: ID_MAX,
          description: 'Project asset id returned by project.asset.list.'
        },
        files: filesSchema('Replacement files for the new revision.')
      },
      required: ['request_key', 'asset_id', 'files'],
      additionalProperties: false
    }
  };
}

function setEnabledDescriptor(scope: ToolScope): ToolDescriptor {
  return {
    name: PROJECT_ASSET_SET_ENABLED_TOOL_NAME,
    version: 1,
    scope,
    perMinute: 12,
    omitAuditPayload: true,
    description:
      'Enable or disable an asset for the current project only. This never edits the asset itself and affects other people\'s later sessions, so the backend rechecks project ownership/update permission. Set enabled=null to clear the project override. Returns { projectAsset: { assetId, enabled, overridden } }. Reuse the same request key on retries.',
    inputSchema: {
      type: 'object',
      properties: {
        request_key: {
          type: 'string',
          minLength: 1,
          maxLength: REQUEST_KEY_MAX,
          description: 'Stable idempotency key chosen by you; reuse it verbatim when retrying the same switch.'
        },
        asset_id: {
          type: 'string',
          minLength: 1,
          maxLength: ID_MAX,
          description: 'Asset id visible in the current project.'
        },
        enabled: {
          type: ['boolean', 'null'],
          description: 'true = enable for this project, false = disable, null = clear the project override.'
        }
      },
      required: ['request_key', 'asset_id', 'enabled'],
      additionalProperties: false
    }
  };
}

/** 控制字符不能出现在 id / 名称 / 路径 / 状态里；文件正文允许换行与制表符。 */
function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function hasNul(value: string): boolean {
  return value.includes('\u0000');
}

function asObject(input: unknown): Result<Record<string, unknown>, DomainError> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return err(invalid('参数必须是对象'));
  }
  return ok(input as Record<string, unknown>);
}

/** 未知键一律拒绝；诊断只列键名，不把键值写进错误或审计。 */
function rejectUnknownKeys(raw: Record<string, unknown>, allowed: ReadonlySet<string>): DomainError | null {
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length === 0) return null;
  const shown = unknown.slice(0, UNKNOWN_KEYS_SHOWN).map((key) => key.slice(0, UNKNOWN_KEY_MAX));
  const suffix = unknown.length > UNKNOWN_KEYS_SHOWN ? ' 等' : '';
  return invalid(`不支持的参数：${shown.join(', ')}${suffix}`);
}

/** id / 请求键 / 路径 / 名称：非空、无首尾空白、无控制字符、限长。 */
function exactString(
  raw: Record<string, unknown>,
  key: string,
  max: number
): Result<string | null, DomainError> {
  const value = raw[key];
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== 'string') return err(invalid(`${key} 必须是字符串`));
  if (value === '' || value !== value.trim()) {
    return err(invalid(`${key} 必须是非空字符串，且不能有首尾空白`));
  }
  if (value.length > max) return err(invalid(`${key} 不能超过 ${max} 字符`));
  if (hasControl(value)) return err(invalid(`${key} 不能包含控制字符`));
  return ok(value);
}

function requiredExact(
  raw: Record<string, unknown>,
  key: string,
  max: number
): Result<string, DomainError> {
  const parsed = exactString(raw, key, max);
  if (!parsed.ok) return parsed;
  if (parsed.value === null) return err(invalid(`${key} 必填`));
  return ok(parsed.value);
}

function parseKind(value: unknown): Result<AssetKind, DomainError> {
  if (typeof value === 'string' && (ASSET_KINDS as readonly string[]).includes(value)) {
    return ok(value as AssetKind);
  }
  return err(invalid(`kind 必须是 ${ASSET_KINDS.join(' / ')}`));
}

function parseAssetName(value: string): Result<string, DomainError> {
  if (value.length < 1 || value.length > NAME_MAX || !NAME_PATTERN.test(value)) {
    return err(invalid('name 不合规：只能用小写字母、数字和单个连字符，1–64 个字符'));
  }
  return ok(value);
}

/** 资产内相对路径：不做规范化、不接受绝对路径 / 反斜杠 / 盘符 / 空段 / `.` / `..`。 */
function checkRelativePath(value: string): DomainError | null {
  if (value.length > PATH_MAX) return invalid(`文件路径不能超过 ${PATH_MAX} 字符`);
  if (value.startsWith('/') || value.includes('\\') || value.includes(':')) {
    return invalid('文件路径不合法：必须是资产内的相对 POSIX 路径');
  }
  if (value.endsWith('/')) return invalid('文件路径不合法：不能以 / 结尾');
  if (value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return invalid('文件路径不合法：不能包含空段、. 或 ..');
  }
  if (hasControl(value)) return invalid('文件路径不能包含控制字符');
  return null;
}

/** 资产标识不是路径：不许出现分隔符、盘符、空白或 `.` / `..`。 */
function checkOpaqueId(value: string, label: string): DomainError | null {
  if (value === '.' || value === '..' || /[\/\\:\s]/.test(value)) {
    return invalid(`${label} 不合法`);
  }
  return null;
}

function parseFiles(raw: Record<string, unknown>): Result<readonly ProjectAssetInputFile[], DomainError> {
  const value = raw.files;
  if (!Array.isArray(value)) return err(invalid('files 必须是数组'));
  if (value.length < 1) return err(invalid('files 至少要有 1 个文件'));
  if (value.length > ASSET_LIMITS.maxFiles) {
    return err(invalid(`files 不能超过 ${ASSET_LIMITS.maxFiles} 个文件`));
  }

  const files: ProjectAssetInputFile[] = [];
  const paths = new Set<string>();
  let total = 0;

  for (const entry of value) {
    const object = asObject(entry);
    if (!object.ok) return object;
    const file = object.value;

    const unknown = rejectUnknownKeys(file, FILE_INPUT_KEYS);
    if (unknown) return err(unknown);

    const path = requiredExact(file, 'path', PATH_MAX);
    if (!path.ok) return path;
    const pathError = checkRelativePath(path.value);
    if (pathError) return err(pathError);
    if (paths.has(path.value)) return err(invalid('files 里不能有重复路径'));
    paths.add(path.value);

    if (typeof file.content !== 'string') return err(invalid('files[].content 必须是字符串'));
    if (hasNul(file.content)) return err(invalid('files[].content 不能包含空字符'));

    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes > ASSET_LIMITS.maxFileBytes) {
      return err(invalid(`单个文件不能超过 ${Math.floor(ASSET_LIMITS.maxFileBytes / 1024)} KiB`));
    }
    total += bytes;
    if (total > ASSET_LIMITS.maxTotalBytes) {
      return err(invalid(`文件合计不能超过 ${Math.floor(ASSET_LIMITS.maxTotalBytes / 1024 / 1024)} MiB`));
    }

    files.push({ path: path.value, content: file.content });
  }

  return ok(files);
}

interface ParsedList {
  readonly kind: AssetKind | null;
  readonly includeDisabled: boolean;
  readonly limit: number;
}

function parseList(input: unknown): Result<ParsedList, DomainError> {
  const object = asObject(input);
  if (!object.ok) return object;
  const raw = object.value;

  const unknown = rejectUnknownKeys(raw, LIST_INPUT_KEYS);
  if (unknown) return err(unknown);

  let kind: AssetKind | null = null;
  if (raw.kind !== undefined && raw.kind !== null) {
    const parsed = parseKind(raw.kind);
    if (!parsed.ok) return parsed;
    kind = parsed.value;
  }

  let includeDisabled = false;
  if (raw.include_disabled !== undefined && raw.include_disabled !== null) {
    if (typeof raw.include_disabled !== 'boolean') return err(invalid('include_disabled 必须是布尔值'));
    includeDisabled = raw.include_disabled;
  }

  let limit = LIST_DEFAULT;
  if (raw.limit !== undefined && raw.limit !== null) {
    if (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit)) {
      return err(invalid('limit 必须是整数'));
    }
    if (raw.limit < 1 || raw.limit > LIST_MAX) {
      return err(invalid(`limit 必须在 1 到 ${LIST_MAX} 之间`));
    }
    limit = raw.limit;
  }

  return ok({ kind, includeDisabled, limit });
}

interface ParsedRead {
  readonly assetId: string;
  readonly path: string | null;
}

function parseRead(input: unknown): Result<ParsedRead, DomainError> {
  const object = asObject(input);
  if (!object.ok) return object;
  const raw = object.value;

  const unknown = rejectUnknownKeys(raw, READ_INPUT_KEYS);
  if (unknown) return err(unknown);

  const assetId = requiredExact(raw, 'asset_id', ID_MAX);
  if (!assetId.ok) return assetId;
  const idError = checkOpaqueId(assetId.value, 'asset_id');
  if (idError) return err(idError);
  const path = exactString(raw, 'path', PATH_MAX);
  if (!path.ok) return path;
  if (path.value !== null) {
    const pathError = checkRelativePath(path.value);
    if (pathError) return err(pathError);
  }

  return ok({ assetId: assetId.value, path: path.value });
}

interface ParsedCreate {
  readonly requestKey: string;
  readonly kind: AssetKind;
  readonly name: string | null;
  readonly files: readonly ProjectAssetInputFile[];
}

function parseCreate(input: unknown): Result<ParsedCreate, DomainError> {
  const object = asObject(input);
  if (!object.ok) return object;
  const raw = object.value;

  const unknown = rejectUnknownKeys(raw, CREATE_INPUT_KEYS);
  if (unknown) return err(unknown);

  const requestKey = requiredExact(raw, 'request_key', REQUEST_KEY_MAX);
  if (!requestKey.ok) return requestKey;
  const kind = parseKind(raw.kind);
  if (!kind.ok) return kind;

  let name: string | null = null;
  const rawName = exactString(raw, 'name', NAME_MAX);
  if (!rawName.ok) return rawName;
  if (rawName.value !== null) {
    const checked = parseAssetName(rawName.value);
    if (!checked.ok) return checked;
    name = checked.value;
  }

  const files = parseFiles(raw);
  if (!files.ok) return files;

  return ok({ requestKey: requestKey.value, kind: kind.value, name, files: files.value });
}

interface ParsedRevise {
  readonly requestKey: string;
  readonly assetId: string;
  readonly files: readonly ProjectAssetInputFile[];
}

function parseRevise(input: unknown): Result<ParsedRevise, DomainError> {
  const object = asObject(input);
  if (!object.ok) return object;
  const raw = object.value;

  const unknown = rejectUnknownKeys(raw, REVISE_INPUT_KEYS);
  if (unknown) return err(unknown);

  const requestKey = requiredExact(raw, 'request_key', REQUEST_KEY_MAX);
  if (!requestKey.ok) return requestKey;
  const assetId = requiredExact(raw, 'asset_id', ID_MAX);
  if (!assetId.ok) return assetId;
  const idError = checkOpaqueId(assetId.value, 'asset_id');
  if (idError) return err(idError);
  const files = parseFiles(raw);
  if (!files.ok) return files;

  return ok({ requestKey: requestKey.value, assetId: assetId.value, files: files.value });
}

interface ParsedSetEnabled {
  readonly requestKey: string;
  readonly assetId: string;
  readonly enabled: boolean | null;
}

function parseSetEnabled(input: unknown): Result<ParsedSetEnabled, DomainError> {
  const object = asObject(input);
  if (!object.ok) return object;
  const raw = object.value;

  const unknown = rejectUnknownKeys(raw, SET_ENABLED_INPUT_KEYS);
  if (unknown) return err(unknown);

  const requestKey = requiredExact(raw, 'request_key', REQUEST_KEY_MAX);
  if (!requestKey.ok) return requestKey;
  const assetId = requiredExact(raw, 'asset_id', ID_MAX);
  if (!assetId.ok) return assetId;
  const idError = checkOpaqueId(assetId.value, 'asset_id');
  if (idError) return err(idError);

  if (raw.enabled === undefined) return err(invalid('enabled 必填；用 null 清除项目覆盖'));
  if (raw.enabled !== null && typeof raw.enabled !== 'boolean') {
    return err(invalid('enabled 必须是布尔值或 null'));
  }

  return ok({ requestKey: requestKey.value, assetId: assetId.value, enabled: raw.enabled });
}

/**
 * 只从冻结的工具授权里取身份；payload 里的 actor / project_id / session 参数根本不存在。
 * 更深一层的「这个人现在还能不能在这个项目写」由回调每次重新查。
 */
function bindingOf(ctx: ToolContext): Result<ProjectAssetBinding, DomainError> {
  const actor = ctx.grant.actor;
  if (!actor || actor.userId === null) {
    return err(forbidden('项目资产工具需要明确的调用身份'));
  }
  return ok({
    actorId: actor.userId,
    actorVia: actor.via,
    sessionId: ctx.grant.sessionId
  });
}

function assertScopes(scopes: ProjectAssetToolScopes): void {
  if (!scopes.read || !scopes.write) {
    throw new Error('project asset tools require both read and write scopes');
  }
  if (scopes.read === scopes.write) {
    throw new Error('project asset tools require distinct read and write scopes');
  }
}

const isScope = (value: unknown): value is AssetScope =>
  value === 'personal' || value === 'project' || value === 'team' || value === 'global';

const isSourceType = (value: unknown): value is 'upload' | 'git' | 'builtin' =>
  value === 'upload' || value === 'git' || value === 'builtin';

function safeId(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > ID_MAX || hasControl(value)) {
    return undefined;
  }
  return value;
}

function safeName(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > NAME_MAX ||
    hasControl(value) ||
    !NAME_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

/** 列表按白名单重建；条目不合格时整次失败，不把无法核实的对象透传出去。 */
function listResult(
  query: ProjectAssetListQuery,
  rows: readonly ProjectAssetSummary[]
): Result<ProjectAssetListSnapshot, DomainError> {
  if (!Array.isArray(rows)) return err(unavailable('资产列表无法核实'));

  const assets: ProjectAssetSummary[] = [];
  for (const row of rows) {
    if (assets.length >= query.limit) break;
    if (row === null || typeof row !== 'object') return err(unavailable('资产列表无法核实'));

    const assetId = safeId((row as { assetId?: unknown }).assetId);
    const name = safeName((row as { name?: unknown }).name);
    const kind = (row as { kind?: unknown }).kind;
    const scope = (row as { scope?: unknown }).scope;
    const sourceType = (row as { sourceType?: unknown }).sourceType;
    const enabled = (row as { enabled?: unknown }).enabled;
    const overridden = (row as { overridden?: unknown }).overridden;
    const shadowedBy = safeId((row as { shadowedBy?: unknown }).shadowedBy);
    const published = (row as { published?: unknown }).published;

    if (
      typeof assetId !== 'string' ||
      name === null ||
      (kind !== 'skill' && kind !== 'instruction' && kind !== 'mcp') ||
      !isScope(scope) ||
      !isSourceType(sourceType) ||
      typeof enabled !== 'boolean' ||
      typeof overridden !== 'boolean' ||
      shadowedBy === undefined ||
      typeof published !== 'boolean'
    ) {
      return err(unavailable('资产列表无法核实'));
    }
    if (query.kind !== null && kind !== query.kind) continue;
    // include_disabled=false 的回调本应只回生效项；这里再兜一次底。
    if (!query.includeDisabled && (!enabled || shadowedBy !== null)) continue;

    assets.push({ assetId, kind, name, scope, sourceType, enabled, overridden, shadowedBy, published });
  }

  return ok({ assets, truncated: rows.length > assets.length });
}

function readResult(
  query: ProjectAssetReadQuery,
  value: ProjectAssetReadSnapshot
): Result<ProjectAssetReadSnapshot, DomainError> {
  if (value === null || typeof value !== 'object') return err(unavailable('资产版本无法核实'));
  if (value.assetId !== query.assetId) return err(unavailable('资产版本无法核实'));
  const name = safeName(value.name);
  const kind = value.kind;
  const scope = value.scope;
  if (
    name === null ||
    (kind !== 'skill' && kind !== 'instruction' && kind !== 'mcp') ||
    !isScope(scope) ||
    typeof value.digest !== 'string' ||
    !DIGEST_PATTERN.test(value.digest)
  ) {
    return err(unavailable('资产版本无法核实'));
  }
  if (!Array.isArray(value.files) || value.files.length > ASSET_LIMITS.maxFiles) {
    return err(unavailable('资产版本无法核实'));
  }

  const files: ProjectAssetReadFile[] = [];
  const paths = new Set<string>();
  const sizes = new Map<string, number>();
  for (const entry of value.files) {
    if (entry === null || typeof entry !== 'object') return err(unavailable('资产版本无法核实'));
    const path = entry.path;
    const sha256 = entry.sha256;
    const size = entry.size;
    if (
      typeof path !== 'string' ||
      checkRelativePath(path) !== null ||
      paths.has(path) ||
      typeof sha256 !== 'string' ||
      !DIGEST_PATTERN.test(sha256) ||
      typeof size !== 'number' ||
      !Number.isInteger(size) ||
      size < 0 ||
      size > ASSET_LIMITS.maxFileBytes
    ) {
      return err(unavailable('资产版本无法核实'));
    }
    paths.add(path);
    sizes.set(path, size);
    files.push({ path, sha256, size });
  }

  let file: ProjectAssetReadSnapshot['file'] = null;
  if (query.path === null) {
    if (value.file !== null && value.file !== undefined) return err(unavailable('资产版本无法核实'));
  } else {
    const candidate = value.file;
    if (candidate === null || typeof candidate !== 'object') {
      return err(unavailable('资产版本无法核实'));
    }
    if (candidate.path !== query.path || !paths.has(query.path)) {
      return err(unavailable('资产版本无法核实'));
    }
    if (typeof candidate.content !== 'string' || hasNul(candidate.content)) {
      return err(unavailable('资产版本无法核实'));
    }
    const bytes = Buffer.byteLength(candidate.content, 'utf8');
    if (bytes > READ_CONTENT_MAX) {
      return err(invalid('资产文本文件超过 64 KiB，无法通过工具读取'));
    }
    if (
      bytes > ASSET_LIMITS.maxFileBytes ||
      sizes.get(query.path) !== bytes ||
      typeof candidate.size !== 'number' ||
      !Number.isInteger(candidate.size) ||
      candidate.size !== bytes
    ) {
      return err(unavailable('资产版本无法核实'));
    }
    file = { path: candidate.path, content: candidate.content, size: bytes };
  }

  return ok({
    assetId: value.assetId,
    kind,
    name,
    scope,
    digest: value.digest,
    files,
    file
  });
}

function writeResult(
  expected: { readonly assetId?: string; readonly kind: AssetKind; readonly create: boolean },
  value: ProjectAssetWriteSnapshot
): Result<ProjectAssetWriteSnapshot, DomainError> {
  if (value === null || typeof value !== 'object') return err(unavailable('资产提交结果无法核实'));
  const assetId = safeId(value.assetId);
  const name = safeName(value.name);
  const submissionId = safeId(value.submissionId);
  const status = value.submissionStatus;
  if (
    typeof assetId !== 'string' ||
    (expected.assetId !== undefined && assetId !== expected.assetId) ||
    name === null ||
    value.kind !== expected.kind ||
    !isScope(value.scope) ||
    typeof value.digest !== 'string' ||
    !DIGEST_PATTERN.test(value.digest) ||
    typeof value.published !== 'boolean' ||
    submissionId === undefined ||
    (status !== null && (typeof status !== 'string' || status.length === 0 || status.length > STATUS_MAX || hasControl(status))) ||
    (submissionId === null) !== (status === null)
  ) {
    return err(unavailable('资产提交结果无法核实'));
  }
  // 新资产必须走审批，不允许回调声称「已直接发布」。
  if (expected.create && value.published) return err(unavailable('资产提交结果无法核实'));

  return ok({
    assetId,
    kind: value.kind,
    name,
    scope: value.scope,
    digest: value.digest,
    published: value.published,
    submissionId,
    submissionStatus: status
  });
}

function enableResult(
  command: ProjectAssetSetEnabledCommand,
  value: ProjectAssetEnableSnapshot
): Result<ProjectAssetEnableSnapshot, DomainError> {
  if (value === null || typeof value !== 'object') return err(unavailable('资产开关结果无法核实'));
  if (
    value.assetId !== command.assetId ||
    typeof value.enabled !== 'boolean' ||
    typeof value.overridden !== 'boolean'
  ) {
    return err(unavailable('资产开关结果无法核实'));
  }
  return ok({ assetId: value.assetId, enabled: value.enabled, overridden: value.overridden });
}

/**
 * 回调可能抛异常（文件系统 / Git / 存储）；网关会把异常文本原样拼进错误，
 * 所以这里先兜住，统一成不含路径与内容的固定文案。unavailable 也做同样处理，
 * 因为底层失败信息常带绝对路径或远端地址。
 */
async function safeCall<T>(
  fallback: string,
  run: () => Promise<Result<T, DomainError>>
): Promise<Result<T, DomainError>> {
  let result: Result<T, DomainError>;
  try {
    result = await run();
  } catch {
    return err(unavailable(fallback));
  }
  if (!result.ok && result.error.code === 'unavailable') return err(unavailable(fallback));
  return result;
}

export function createProjectAssetToolProvider(deps: ProjectAssetToolDeps): ToolProvider {
  assertScopes(deps.scopes);

  const listTool = listDescriptor(deps.scopes.read);
  const readTool = readDescriptor(deps.scopes.read);
  const createTool = createDescriptor(deps.scopes.write);
  const reviseTool = reviseDescriptor(deps.scopes.write);
  const setEnabledTool = setEnabledDescriptor(deps.scopes.write);
  const tools: ToolDescriptor[] = [listTool, readTool, createTool, reviseTool, setEnabledTool];
  const enabled = new Set(tools.map((tool) => tool.name));

  return {
    id: 'project-asset-tools',
    tools: () => tools,
    async call(name, input, ctx): Promise<Result<unknown, DomainError>> {
      if (!enabled.has(name)) return err(notFound(`未知工具：${name}`));

      const binding = bindingOf(ctx);
      if (!binding.ok) return binding;

      if (name === listTool.name) {
        const parsed = parseList(input);
        if (!parsed.ok) return parsed;

        const query: ProjectAssetListQuery = { ...binding.value, ...parsed.value };
        const listed = await safeCall('资产列表暂时无法读取', () => deps.listAssets(query));
        if (!listed.ok) return listed;
        return listResult(query, listed.value);
      }

      if (name === readTool.name) {
        const parsed = parseRead(input);
        if (!parsed.ok) return parsed;

        const query: ProjectAssetReadQuery = { ...binding.value, ...parsed.value };
        const read = await safeCall('资产版本暂时无法读取', () => deps.readAsset(query));
        if (!read.ok) return read;
        const safe = readResult(query, read.value);
        if (!safe.ok) return safe;
        return ok({ asset: safe.value });
      }

      if (name === createTool.name) {
        const parsed = parseCreate(input);
        if (!parsed.ok) return parsed;

        const command: ProjectAssetCreateCommand = { ...binding.value, ...parsed.value };
        const created = await safeCall('资产提交未完成，请稍后重试', () => deps.createAsset(command));
        if (!created.ok) return created;
        const safe = writeResult({ kind: command.kind, create: true }, created.value);
        if (!safe.ok) return safe;
        return ok({ asset: safe.value });
      }

      if (name === reviseTool.name) {
        const parsed = parseRevise(input);
        if (!parsed.ok) return parsed;

        const command: ProjectAssetReviseCommand = { ...binding.value, ...parsed.value };
        const revised = await safeCall('资产提交未完成，请稍后重试', () => deps.reviseAsset(command));
        if (!revised.ok) return revised;
        const safe = writeResult(
          { assetId: command.assetId, kind: revised.value.kind, create: false },
          revised.value
        );
        if (!safe.ok) return safe;
        return ok({ asset: safe.value });
      }

      const parsed = parseSetEnabled(input);
      if (!parsed.ok) return parsed;

      const command: ProjectAssetSetEnabledCommand = { ...binding.value, ...parsed.value };
      const saved = await safeCall('资产开关未保存，请稍后重试', () => deps.setAssetEnabled(command));
      if (!saved.ok) return saved;
      const safe = enableResult(command, saved.value);
      if (!safe.ok) return safe;
      return ok({ projectAsset: safe.value });
    }
  };
}
