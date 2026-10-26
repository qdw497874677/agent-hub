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

const entry = z.object({ name: z.string(), path: z.string(), isGit: z.boolean().optional(), modifiedAt: z.number().optional() });

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
  z.object({ token: z.string().min(1), message: z.record(z.string(), z.unknown()) }),
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
  z.object({ repoPath: z.string(), path: z.string(), branch: z.string().min(1), base: z.string().nullable().optional() }),
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

/** Worker 删之前会再查一次；有改动就回 removed:false + 原因（不是错误）。 */
export const wsRemove = method(
  'ws.remove',
  z.object({ path: z.string(), kind: z.enum(['worktree', 'directory']), force: z.boolean().optional() }),
  z.union([z.object({ removed: z.literal(true) }), z.object({ removed: z.literal(false), reason: z.string() })])
);
