import { z } from 'zod';
import type { RpcMethod } from './rpc/port.ts';

/**
 * /worker 长连接上的 RPC 方法表：两端唯一的约定。新加请求-回复就在这里加一项，不再新造帧。
 * 方向：hub→worker 的是 fs.*；worker→hub 的是 mcp.*。
 */
const method = <P extends z.ZodType, R extends z.ZodType>(name: string, params: P, result: R): RpcMethod<P, R> => ({
  name,
  params,
  result
});

const entry = z.object({ name: z.string(), path: z.string(), isGit: z.boolean().optional(), modifiedAt: z.number().optional(), hidden: z.boolean().optional() });

export const fsListDirectories = method(
  'fs.list_directories',
  /** 空串 = 这台机器的默认起点（roots[0]）。 */
  z.object({ path: z.string() }),
  z.object({ path: z.string(), exists: z.boolean(), entries: z.array(entry) })
);

/** Worker 用 realpath 校验仍在 WORKER_ROOTS 里；不合法回 invalid。 */
export const fsMakeDirectory = method(
  'fs.make_directory',
  z.object({ parent: z.string(), name: z.string() }),
  z.object({ path: z.string() })
);

export const fsListFiles = method(
  'fs.list_files',
  z.object({ root: z.string(), limit: z.number().int().positive() }),
  z.object({ files: z.array(z.string()), truncated: z.boolean() })
);

/** data 为 null = 文件不存在；base64。 */
export const fsReadFile = method(
  'fs.read_file',
  z.object({ path: z.string(), maxBytes: z.number().int().positive() }),
  z.object({ data: z.string().nullable() })
);

/**
 * 一条 MCP JSON-RPC 消息原样过隧道。hub 按 token 认授权、核对会话托管在这台 Worker 上，
 * 再交给既有的 MCP 服务端。通知没有回复：message 为 null。token 不许进日志。
 */
export const mcpMessage = method(
  'mcp.message',
  /** server：MCP 资产名（远端 http 服务器，hub 代连）；不填 = hub 自己的工具。 */
  z.object({ token: z.string().min(1), server: z.string().min(1).max(64).optional(), message: z.record(z.string(), z.unknown()) }),
  z.object({ message: z.record(z.string(), z.unknown()).nullable() })
);

/* ── 工作空间（docs/design/workspaces.md §3）：在目录所在的那台机器上跑 git。Worker 侧都过 WORKER_ROOTS。 ── */

export const wsInspect = method(
  'ws.inspect',
  z.object({ path: z.string() }),
  z.object({ exists: z.boolean(), isGit: z.boolean(), remoteUrl: z.string().nullable(), branch: z.string().nullable() })
);

/** 用 Worker 本机的 git 凭据；hub 不存 token。 */
export const wsClone = method(
  'ws.clone',
  z.object({ repoUrl: z.string().min(1), parent: z.string(), name: z.string(), branch: z.string().nullable().optional() }),
  z.object({ path: z.string(), branch: z.string().nullable() })
);

export const wsAddWorktree = method(
  'ws.add_worktree',
  z.object({ repoPath: z.string(), path: z.string(), branch: z.string().min(1), base: z.string().nullable().optional(), existing: z.boolean().optional() }),
  z.object({ path: z.string(), branch: z.string() })
);

export const wsStatus = method(
  'ws.status',
  z.object({ path: z.string() }),
  z.object({
    dirty: z.boolean().nullable(),
    untracked: z.number().int(),
    unpushed: z.number().int(),
    branch: z.string().nullable(),
    upstream: z.string().nullable()
  })
);

export const wsSaveWip = method(
  'ws.save_wip',
  z.object({ path: z.string(), message: z.string().min(1) }),
  z.object({ committed: z.boolean(), pushed: z.boolean(), branch: z.string().nullable(), reason: z.string().nullable() })
);

/** Worker 删之前会再查一次；有改动就回 removed:false + 原因（不是错误）。 */
export const wsRemove = method(
  'ws.remove',
  z.object({ path: z.string(), kind: z.enum(['worktree', 'directory']), force: z.boolean().optional() }),
  z.union([z.object({ removed: z.literal(true) }), z.object({ removed: z.literal(false), reason: z.string() })])
);

/* ── 资产中心（docs/design/asset-hub.md）：hub 推清单，Worker 按哈希来取内容，落到自己的资产目录 ── */

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const assetEntry = z.object({
  assetId: z.string(),
  kind: z.enum(['skill', 'instruction']),
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
  /** 落地名（项目级 = name--<id 前 8 位>）；旧 hub 不发，按 name。 */
  slot: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]{1,8})?$/).max(74).optional(),
  description: z.string(),
  digest: sha,
  files: z.array(z.object({ path: z.string(), sha256: sha, size: z.number().int().nonnegative() })).max(200)
});
export type AssetManifestEntryWire = z.infer<typeof assetEntry>;

/** hub→worker：这台机器该有的全部资产（不在清单里的就删）。回报落地后的目录与版本。 */
export const assetsSync = method(
  'assets.sync',
  z.object({ entries: z.array(assetEntry).max(500) }),
  z.object({ root: z.string(), installed: z.record(z.string(), sha) })
);

/** worker→hub：按 sha256 取内容（base64）。hub 只给这台机器清单里有的。 */
export const assetsFetch = method(
  'assets.fetch',
  z.object({ hashes: z.array(sha).min(1).max(200) }),
  z.object({ blobs: z.array(z.object({ sha256: sha, data: z.string() })) })
);

/**
 * hub→worker：从这台机器测一下模型提供商通不通（GET <baseUrl>/models）。
 * baseUrl 以 / 开头 = 经 hub 中转（worker 按自己连的 hub 地址补全），apiKey 是一次性中转令牌。
 */
export const providerTest = method(
  'provider.test',
  z.object({ protocol: z.enum(['openai-chat', 'openai-responses', 'anthropic']), baseUrl: z.string().min(1).max(2000), apiKey: z.string().min(1).max(4096) }),
  z.object({ ok: z.boolean(), status: z.number().int(), message: z.string(), models: z.array(z.string()).max(500) })
);

/* ── 工作空间文件浏览（ADR 0025）：hub→worker 的 files.*，worker→hub 的 files.changed。Worker 侧都过 WORKER_ROOTS + realpath。 ── */

const gitStatus = z.enum(['modified', 'added', 'deleted', 'renamed', 'untracked', 'conflicted']);
const browserEntry = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['file', 'dir', 'symlink']),
  size: z.number(),
  modifiedAt: z.number(),
  ignored: z.boolean(),
  sensitive: z.boolean(),
  git: gitStatus.nullable()
});

export const filesList = method(
  'files.list',
  z.object({ root: z.string(), path: z.string(), limit: z.number().int().positive() }),
  z.object({ path: z.string(), entries: z.array(browserEntry), truncated: z.boolean(), isGit: z.boolean() })
);

/** data：base64；binary 时为空串。 */
export const filesRead = method(
  'files.read',
  z.object({ root: z.string(), path: z.string(), maxBytes: z.number().int().positive() }),
  z.object({ path: z.string(), size: z.number(), modifiedAt: z.number(), binary: z.boolean(), truncated: z.boolean(), data: z.string() })
);

export const filesFind = method(
  'files.find',
  z.object({ root: z.string(), query: z.string(), limit: z.number().int().positive() }),
  z.object({ files: z.array(z.string()) })
);

export const filesChanges = method(
  'files.changes',
  z.object({ root: z.string(), base: z.string().nullable() }),
  z.object({ files: z.array(z.object({ path: z.string(), status: gitStatus, additions: z.number(), deletions: z.number(), oldPath: z.string().optional() })) })
);

export const filesDiff = method(
  'files.diff',
  z.object({ root: z.string(), path: z.string(), base: z.string().nullable(), maxBytes: z.number().int().positive() }),
  z.object({ path: z.string(), patch: z.string(), truncated: z.boolean(), binary: z.boolean() })
);

export const filesHead = method('files.head', z.object({ root: z.string() }), z.object({ head: z.string().nullable() }));

/** 开始盯：watchId 由 hub 起，变化用 files.changed 回报。 */
export const filesWatch = method(
  'files.watch',
  z.object({ watchId: z.string().min(1).max(80), root: z.string(), paths: z.array(z.string()).max(200) }),
  z.object({})
);
export const filesUnwatch = method('files.unwatch', z.object({ watchId: z.string().min(1).max(80) }), z.object({}));

/** worker→hub：某个订阅下有东西变了（已防抖）。 */
export const filesChanged = method(
  'files.changed',
  z.object({ watchId: z.string().min(1).max(80), paths: z.array(z.string()).max(1000) }),
  z.object({})
);
