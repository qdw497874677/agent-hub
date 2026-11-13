import { z } from 'zod';
import type { RpcMethod } from './rpc/port.ts';
/**
 * 方法要的能力。与 domain 的 WorkerMethodCapability 同一组字面量（drift.ts 校验两边一致）；
 * 这里不 import domain：web 也吃 contract，不该被拖进 domain 的 node 依赖。
 */
export type WorkerMethodCapability = 'sessions' | 'files.read' | 'files.write' | 'git' | 'git.remote' | 'runtimes' | 'update' | 'control';

/**
 * /worker 长连接上的 RPC 方法表：两端唯一的约定。新加请求-回复就在这里加一项，不再新造帧。
 * 方向：hub→worker 的是 fs.*；worker→hub 的是 mcp.*。
 */
/** capability 必填（ADR 0030 D3）：漏写编译不过，参照 t3code「每个工具必须声明访问级别」。 */
const method = <P extends z.ZodType, R extends z.ZodType>(name: string, capability: WorkerMethodCapability, params: P, result: R): RpcMethod<P, R> & { readonly capability: WorkerMethodCapability } => ({
  name,
  capability,
  params,
  result
});

const entry = z.object({ name: z.string(), path: z.string(), isGit: z.boolean().optional(), modifiedAt: z.number().optional(), hidden: z.boolean().optional() });

export const fsListDirectories = method(
  'fs.list_directories', 'files.read',
  /** 空串 = 这台机器的默认起点（roots[0]）。 */
  z.object({ path: z.string() }),
  z.object({ path: z.string(), exists: z.boolean(), entries: z.array(entry) })
);

/** Worker 用 realpath 校验仍在 WORKER_ROOTS 里；不合法回 invalid。 */
export const fsMakeDirectory = method(
  'fs.make_directory', 'files.write',
  z.object({ parent: z.string(), name: z.string() }),
  z.object({ path: z.string() })
);

export const fsListFiles = method(
  'fs.list_files', 'files.read',
  z.object({ root: z.string(), limit: z.number().int().positive() }),
  z.object({ files: z.array(z.string()), truncated: z.boolean() })
);

/** data 为 null = 文件不存在；base64。 */
export const fsReadFile = method(
  'fs.read_file', 'files.read',
  z.object({ path: z.string(), maxBytes: z.number().int().positive() }),
  z.object({ data: z.string().nullable() })
);

/**
 * 一条 MCP JSON-RPC 消息原样过隧道。hub 按 token 认授权、核对会话托管在这台 Worker 上，
 * 再交给既有的 MCP 服务端。通知没有回复：message 为 null。token 不许进日志。
 */
export const mcpMessage = method(
  'mcp.message', 'sessions',
  /** server：MCP 资产名（远端 http 服务器，hub 代连）；不填 = hub 自己的工具。 */
  z.object({ token: z.string().min(1), server: z.string().min(1).max(64).optional(), message: z.record(z.string(), z.unknown()) }),
  z.object({ message: z.record(z.string(), z.unknown()).nullable() })
);

/* ── 工作空间（docs/design/workspaces.md §3）：在目录所在的那台机器上跑 git。Worker 侧都过 WORKER_ROOTS。 ── */

export const wsInspect = method(
  'ws.inspect', 'files.read',
  z.object({ path: z.string() }),
  z.object({ exists: z.boolean(), isGit: z.boolean(), remoteUrl: z.string().nullable(), branch: z.string().nullable() })
);

/** 用 Worker 本机的 git 凭据；hub 不存 token。 */
export const wsClone = method(
  'ws.clone', 'git',
  z.object({ repoUrl: z.string().min(1), parent: z.string(), name: z.string(), branch: z.string().nullable().optional() }),
  z.object({ path: z.string(), branch: z.string().nullable() })
);

export const wsAddWorktree = method(
  'ws.add_worktree', 'git',
  z.object({ repoPath: z.string(), path: z.string(), branch: z.string().min(1), base: z.string().nullable().optional(), existing: z.boolean().optional() }),
  z.object({ path: z.string(), branch: z.string() })
);

/** 在工作空间里跑项目配置的准备命令（docs/design/worktree.md §4）。只认项目配置，不接受逐次传入。 */
export const wsRunSetup = method(
  'ws.run_setup', 'git',
  z.object({ path: z.string(), command: z.string().min(1), timeoutMs: z.number().int().positive(), env: z.record(z.string(), z.string()).optional() }),
  z.object({ exitCode: z.number().int(), output: z.string(), timedOut: z.boolean() })
);

export const wsStatus = method(
  'ws.status', 'files.read',
  z.object({ path: z.string() }),
  z.object({
    dirty: z.boolean().nullable(),
    untracked: z.number().int(),
    unpushed: z.number().int(),
    branch: z.string().nullable(),
    upstream: z.string().nullable(),
    head: z.string().nullable().optional(),
    sizeBytes: z.number().nullable().optional(),
    files: z.number().int().nullable().optional()
  })
);

export const wsSaveWip = method(
  'ws.save_wip', 'git.remote',
  z.object({ path: z.string(), message: z.string().min(1) }),
  z.object({ committed: z.boolean(), pushed: z.boolean(), branch: z.string().nullable(), reason: z.string().nullable() })
);

/* ── ADR 0027 阶段 2：提交 / 推送 / gh 开 PR ── */
const remotePr = z.object({
  number: z.number().int(),
  url: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  headSha: z.string().nullable(),
  mergedAt: z.number().nullable()
});

export const wsPreview = method(
  'ws.preview', 'files.read',
  z.object({ path: z.string(), maxPatchBytes: z.number().int().min(0).max(1 << 20) }),
  z.object({
    isGit: z.boolean(),
    branch: z.string().nullable(),
    defaultBranch: z.string().nullable(),
    remoteUrl: z.string().nullable(),
    upstream: z.string().nullable(),
    ahead: z.number().int(),
    head: z.string().nullable(),
    files: z.array(z.object({ path: z.string(), status: z.string() })),
    patch: z.string(),
    truncated: z.boolean()
  })
);

export const wsCommit = method(
  'ws.commit', 'git',
  z.object({ path: z.string(), message: z.string().min(1).max(8000), authorName: z.string().max(200), authorEmail: z.string().max(320) }),
  z.object({ committed: z.boolean(), sha: z.string().nullable(), reason: z.string().nullable() })
);

export const wsPush = method(
  'ws.push', 'git.remote',
  z.object({ path: z.string() }),
  z.object({ pushed: z.boolean(), branch: z.string().nullable(), reason: z.string().nullable() })
);

export const wsGh = method(
  'ws.gh', 'git.remote',
  z.object({
    path: z.string(),
    request: z.discriminatedUnion('action', [
      z.object({ action: z.literal('create'), base: z.string().min(1), head: z.string().min(1), title: z.string().min(1).max(300), body: z.string().max(65_536) }),
      z.object({ action: z.literal('view'), number: z.number().int().positive() })
    ])
  }),
  z.union([z.object({ ok: z.literal(true), pr: remotePr }), z.object({ ok: z.literal(false), reason: z.string() })])
);

/** Worker 删之前会再查一次；有改动就回 removed:false + 原因（不是错误）。 */
export const wsRemove = method(
  'ws.remove', 'git',
  z.object({ path: z.string(), kind: z.enum(['worktree', 'directory']), force: z.boolean().optional(), mergedHead: z.string().optional() }),
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
  'assets.sync', 'control',
  z.object({ entries: z.array(assetEntry).max(500) }),
  z.object({ root: z.string(), installed: z.record(z.string(), sha) })
);

/** worker→hub：按 sha256 取内容（base64）。hub 只给这台机器清单里有的。 */
export const assetsFetch = method(
  'assets.fetch', 'control',
  z.object({ hashes: z.array(sha).min(1).max(200) }),
  z.object({ blobs: z.array(z.object({ sha256: sha, data: z.string() })) })
);

/**
 * hub→worker：从这台机器测一下模型提供商通不通（GET <baseUrl>/models）。
 * baseUrl 以 / 开头 = 经 hub 中转（worker 按自己连的 hub 地址补全），apiKey 是一次性中转令牌。
 */
export const providerTest = method(
  'provider.test', 'sessions',
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
  'files.list', 'files.read',
  z.object({ root: z.string(), path: z.string(), limit: z.number().int().positive() }),
  z.object({ path: z.string(), entries: z.array(browserEntry), truncated: z.boolean(), isGit: z.boolean() })
);

/** data：base64；binary 时为空串。 */
export const filesRead = method(
  'files.read', 'files.read',
  z.object({ root: z.string(), path: z.string(), maxBytes: z.number().int().positive() }),
  z.object({ path: z.string(), size: z.number(), modifiedAt: z.number(), binary: z.boolean(), truncated: z.boolean(), data: z.string() })
);

export const filesFind = method(
  'files.find', 'files.read',
  z.object({ root: z.string(), query: z.string(), limit: z.number().int().positive() }),
  z.object({ files: z.array(z.string()) })
);

export const filesChanges = method(
  'files.changes', 'files.read',
  z.object({ root: z.string(), base: z.string().nullable(), target: z.string().nullable().optional() }),
  z.object({ files: z.array(z.object({ path: z.string(), status: gitStatus, additions: z.number(), deletions: z.number(), oldPath: z.string().optional() })) })
);

export const filesDiff = method(
  'files.diff', 'files.read',
  z.object({ root: z.string(), path: z.string(), base: z.string().nullable(), maxBytes: z.number().int().positive(), target: z.string().nullable().optional() }),
  z.object({ path: z.string(), patch: z.string(), truncated: z.boolean(), binary: z.boolean() })
);

/** 回合检查点（ADR 0027）：临时 index 写树 + commit-tree + update-ref。老 Worker 没有 = unsupported，hub 照常跑，只是没有「本轮」。 */
export const filesCheckpoint = method('files.checkpoint', 'files.write', z.object({ root: z.string(), ref: z.string().max(200) }), z.object({ commit: z.string().nullable() }));
export const filesDropRefs = method('files.drop_refs', 'files.write', z.object({ root: z.string(), prefix: z.string().max(200) }), z.object({ dropped: z.number() }));

export const filesRestore = method(
  'files.restore', 'files.write',
  z.object({ root: z.string(), commit: z.string().max(64), safetyRef: z.string().max(200) }),
  z.object({ safety: z.string(), restored: z.number(), removed: z.number() })
);
export const filesHead = method('files.head', 'files.read', z.object({ root: z.string() }), z.object({ head: z.string().nullable() }));

/** 开始盯：watchId 由 hub 起，变化用 files.changed 回报。 */
export const filesWatch = method(
  'files.watch', 'files.read',
  z.object({ watchId: z.string().min(1).max(80), root: z.string(), paths: z.array(z.string()).max(200) }),
  z.object({})
);
export const filesUnwatch = method('files.unwatch', 'files.read', z.object({ watchId: z.string().min(1).max(80) }), z.object({}));

/** worker→hub：某个订阅下有东西变了（已防抖）。 */
export const filesChanged = method(
  'files.changed', 'files.read',
  z.object({ watchId: z.string().min(1).max(80), paths: z.array(z.string()).max(1000) }),
  z.object({})
);

/**
 * 交互式终端（docs/design/terminal.md）。cwd 不进协议：worker 用自己的会话工作空间 Map 决定，
 * 并过 WorkerFiles.check()。不支持 PTY 的 worker 回 unsupported，hub 据此隐藏页签。
 */
const terminalId = z.string().min(1).max(120);

export const terminalOpen = method(
  'terminal.open', 'sessions',
  z.object({
    terminalId,
    sessionId: terminalId,
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
    /** hub 已算好的会话工作空间目录；给了就用它，省得 worker 依赖本进程的 sessions 表（会话结束后仍在）。 */
    cwd: z.string().min(1).max(4096).optional()
  }),
  z.object({
    cols: z.number(),
    rows: z.number(),
    reused: z.boolean(),
    /**
     * 复用一个还活着的终端时，带上最近的输出（base64，≤256 KB 原始数据），
     * 让刷新后的页面能把滚屏接上。新开的终端没有这个字段。
     */
    scrollback: z.string().max(400_000).optional()
  })
);

export const terminalResize = method(
  'terminal.resize', 'sessions',
  z.object({ terminalId, cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) }),
  z.object({ ok: z.literal(true) })
);

export const terminalClose = method('terminal.close', 'sessions', z.object({ terminalId }), z.object({ ok: z.literal(true) }));

/** 对账：hub 重启后用它找出自己不认识、还活着的 PTY。 */
export const terminalList = method('terminal.list', 'sessions', z.object({}), z.object({ terminals: z.array(z.object({ terminalId, sessionId: terminalId })).max(200) }));

/** 应用层回声（ADR 0030 D1）：hub 定时问一句，量的是「对端事件循环真的在处理帧」，不只是 TCP 活着。 */
export const linkEcho = method('link.echo', 'control', z.object({ at: z.number() }), z.object({ at: z.number() }));
