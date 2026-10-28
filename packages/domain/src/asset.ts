import { invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/**
 * 资产中心（docs/design/asset-hub.md）：hub 统一管理会话能用的能力，按 Worker 安装。
 *
 * MVP 只有两类：
 * - skill：一个目录，根上一份 SKILL.md（Agent Skills 开放标准，frontmatter 里 name / description）；
 * - instruction：一份 markdown，追加到会话的系统提示里；
 * - mcp：一份 mcp.json，描述一个 MCP 服务器（密钥只写引用，见 mcp.ts）。
 *
 * 版本不可变、按内容寻址：同样的文件 → 同一个 digest。资产「钉」在一个版本上，
 * 来源有新版本时只记成「可升级」，看过 diff 并确认后才换钉。
 */
export type AssetKind = 'skill' | 'instruction' | 'mcp';
export const ASSET_KINDS: readonly AssetKind[] = ['skill', 'instruction', 'mcp'];
/** 落成文件下发到 Worker 的那几类；mcp 不落盘（会话启动时按需展开，见 mcp.ts）。 */
export type FileAssetKind = Exclude<AssetKind, 'mcp'>;
export const FILE_ASSET_KINDS: readonly FileAssetKind[] = ['skill', 'instruction'];
export const isFileAssetKind = (kind: AssetKind): kind is FileAssetKind => kind !== 'mcp';

export type AssetSource =
  | { readonly type: 'upload' }
  /** ref = 分支 / 标签 / 提交（null = 远端默认分支）；path = 仓库里那个技能目录或指令文件（'' = 仓库根）。 */
  | { readonly type: 'git'; readonly url: string; readonly ref: string | null; readonly path: string };

export interface AssetFile {
  /** 相对资产根的路径，`/` 分隔。 */
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface AssetRevision {
  readonly assetId: string;
  /** 文件清单的 sha256：版本号本身。 */
  readonly digest: string;
  readonly name: string;
  readonly description: string;
  readonly files: readonly AssetFile[];
  /** git 来源的提交号；上传的为 null。 */
  readonly commit: string | null;
  readonly createdAt: number;
}

export interface Asset {
  readonly id: string;
  readonly kind: AssetKind;
  /** 落到 Worker 上的目录名 / 文件名；同一类、同一作用域里唯一（项目级可以和全局同名：就近优先）。 */
  readonly name: string;
  /** 作用域：null = 全局（所有项目可用）；否则只属于这个项目。 */
  readonly projectId: string | null;
  readonly description: string;
  readonly source: AssetSource;
  /** 钉住的版本：下发给 Worker 的就是它。 */
  readonly pinned: string;
  /** 来源上看到的最新版本；≠ pinned 就是「有新版本待确认」。 */
  readonly latest: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 下发给一台 Worker 的一项：它该装什么、装成什么名字、由哪些文件组成。 */
export interface AssetManifestEntry {
  readonly assetId: string;
  readonly kind: FileAssetKind;
  readonly name: string;
  /** Worker 上的目录 / 文件名（见 assetSlot）：全局就是 name，项目级带上 id，同名也不撞。 */
  readonly slot: string;
  readonly description: string;
  readonly digest: string;
  readonly files: readonly AssetFile[];
}

export type AssetScope = 'global' | 'project';
export const assetScope = (asset: Pick<Asset, 'projectId'>): AssetScope => (asset.projectId === null ? 'global' : 'project');

/** Worker 上落地用的名字：全局资产 = name（兼容旧目录）；项目级 = name--<id 前 8 位>。 */
export const assetSlot = (asset: Pick<Asset, 'id' | 'name' | 'projectId'>): string =>
  asset.projectId === null ? asset.name : `${asset.name}--${asset.id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()}`;

/**
 * 一个项目的资产开关（项目设置里改）：assetId → 开 / 关。没写的取默认：
 * 全局资产默认开、本项目的项目级资产默认开；别的项目的项目级资产永远不给。
 */
export type ProjectAssetSettings = Readonly<Record<string, boolean>>;

export interface ProjectAssetChoice {
  readonly asset: Asset;
  readonly enabled: boolean;
  /** 被同名的项目级资产盖住了（就近优先）。 */
  readonly shadowedBy: string | null;
}

/**
 * 就近优先：同类同名时项目级盖过全局。返回这个项目看得见的每个资产及其最终是否生效；
 * effective 里是真正给会话的那些。
 */
export function resolveProjectAssets(
  assets: readonly Asset[],
  projectId: string,
  settings: ProjectAssetSettings
): { choices: ProjectAssetChoice[]; effective: Asset[] } {
  const visible = assets.filter((asset) => asset.projectId === null || asset.projectId === projectId);
  const on = (asset: Asset) => settings[asset.id] ?? true;
  const local = new Map<string, Asset>();
  for (const asset of visible) if (asset.projectId !== null && on(asset)) local.set(`${asset.kind}:${asset.name}`, asset);
  const choices = visible.map((asset) => {
    const nearer = asset.projectId === null ? local.get(`${asset.kind}:${asset.name}`) : undefined;
    return { asset, enabled: on(asset), shadowedBy: nearer ? nearer.id : null };
  });
  return { choices, effective: choices.filter((choice) => choice.enabled && choice.shadowedBy === null).map((choice) => choice.asset) };
}

export type AssetSyncState = 'pending' | 'syncing' | 'synced' | 'failed';

/** 一台 Worker 的同步情况（hub 落库记着；Worker 重连会再同步一次）。 */
export interface WorkerAssetSync {
  readonly workerId: string;
  readonly state: AssetSyncState;
  /** Worker 上的资产根目录（如 ~/.agent-hub/assets）。 */
  readonly root: string | null;
  /** assetId → 已落地的 digest。 */
  readonly installed: Readonly<Record<string, string>>;
  readonly error: string | null;
  readonly at: number;
}

/** 导入时交上来的原始文件（来自上传或 git 检出）。 */
export interface IncomingFile {
  readonly path: string;
  readonly data: Uint8Array;
}

/** 规模上限：资产是「说明书」，不是仓库镜像。 */
export const ASSET_LIMITS = {
  maxFiles: 200,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024
} as const;

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Agent Skills 标准的名字规则：小写字母数字和连字符，1–64 字符，不以连字符开头结尾、不连写。 */
export function checkAssetName(name: string): Result<string, DomainError> {
  if (name.length < 1 || name.length > 64 || !NAME.test(name)) {
    return err(invalid(`名字「${name}」不合规：只能用小写字母、数字和单个连字符，1–64 个字符`));
  }
  return ok(name);
}

/** skill 里不收的目录：hooks / bin 是插件机制，MVP 明确不做（会话里不能有 hub 下发的可执行钩子）。 */
const FORBIDDEN_TOP = new Set(['hooks', 'bin', '.git']);

/** 规范化路径：拒绝绝对路径、`..`、反斜杠和空段。 */
export function normalizeAssetPath(raw: string): Result<string, DomainError> {
  const path = raw.replace(/^\.\/+/, '');
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    return err(invalid(`文件路径不合法：${raw}`));
  }
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return err(invalid(`文件路径不合法：${raw}`));
  return ok(parts.join('/'));
}

/** Web Crypto（Node 全局可用），领域层不碰 `node:`。 */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 一组文件的版本号：按路径排序后的「路径 + 内容哈希」再哈希。与上传顺序、时间无关。 */
export function revisionDigest(files: readonly AssetFile[]): Promise<string> {
  const canonical = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${file.path}\0${file.sha256}\0${file.size}`)
    .join('\n');
  return sha256Hex(canonical);
}

export interface PackedAsset {
  readonly files: readonly AssetFile[];
  readonly blobs: ReadonlyMap<string, Uint8Array>;
  readonly digest: string;
}

/**
 * 校验并打包一组文件：路径、数量、大小、skill 的结构（根上有 SKILL.md、没有 hooks/bin）、
 * instruction 只能是一份 markdown。返回内容寻址后的清单 + blob。
 */
export async function packAsset(kind: AssetKind, incoming: readonly IncomingFile[]): Promise<Result<PackedAsset, DomainError>> {
  if (incoming.length === 0) return err(invalid('没有文件'));
  if (incoming.length > ASSET_LIMITS.maxFiles) return err(invalid(`文件太多（${incoming.length}），上限 ${ASSET_LIMITS.maxFiles}`));
  const files: AssetFile[] = [];
  const blobs = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  let total = 0;
  for (const file of incoming) {
    const path = normalizeAssetPath(file.path);
    if (!path.ok) return path;
    if (seen.has(path.value)) return err(invalid(`重复的文件：${path.value}`));
    seen.add(path.value);
    const top = path.value.split('/')[0] ?? '';
    if (kind === 'skill' && FORBIDDEN_TOP.has(top)) {
      return err(invalid(`技能里不能带 ${top}/（钩子和可执行目录不在资产中心的范围内）`));
    }
    if (file.data.byteLength > ASSET_LIMITS.maxFileBytes) return err(invalid(`文件太大：${path.value}`));
    total += file.data.byteLength;
    if (total > ASSET_LIMITS.maxTotalBytes) return err(invalid('文件总大小超过 4 MB'));
    const hash = await sha256Hex(file.data);
    blobs.set(hash, file.data);
    files.push({ path: path.value, sha256: hash, size: file.data.byteLength });
  }
  if (kind === 'skill' && !seen.has('SKILL.md')) return err(invalid('技能目录的根上必须有 SKILL.md'));
  if (kind === 'instruction' && (files.length !== 1 || !/\.md$/i.test(files[0]?.path ?? ''))) {
    return err(invalid('指令只能是一份 markdown 文件'));
  }
  if (kind === 'mcp' && (files.length !== 1 || files[0]?.path !== 'mcp.json')) {
    return err(invalid('MCP 资产只能是一份 mcp.json'));
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return ok({ files, blobs, digest: await revisionDigest(files) });
}

export type FileChange = 'added' | 'removed' | 'modified' | 'unchanged';

export interface FileDiff {
  readonly path: string;
  readonly change: FileChange;
  /** 文本文件的统一 diff（unchanged / 二进制为 null）。 */
  readonly patch: string | null;
}

/** 两个版本按路径对齐：哪些文件增删改。 */
export function compareFiles(
  from: readonly AssetFile[],
  to: readonly AssetFile[]
): readonly { path: string; change: FileChange; before: AssetFile | null; after: AssetFile | null }[] {
  const before = new Map(from.map((file) => [file.path, file]));
  const after = new Map(to.map((file) => [file.path, file]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.map((path) => {
    const a = before.get(path) ?? null;
    const b = after.get(path) ?? null;
    const change: FileChange = a === null ? 'added' : b === null ? 'removed' : a.sha256 === b.sha256 ? 'unchanged' : 'modified';
    return { path, change, before: a, after: b };
  });
}
