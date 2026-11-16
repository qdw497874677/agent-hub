import type { PreviewLink } from '@agent-hub/domain';

/**
 * 预览自动出链接（docs/design/session-service.md §9）：
 * 进程/端口清单是事实来源——端口在听、进程的工作目录在某条会话的工作目录里，
 * 就给这条会话挂一条预览链接，不用人去填端口。
 *
 * 纯决策函数：调用方负责拿数据（进程、工作空间、已有链接）和执行（建链接、监听）。
 * 规则刻意保守：只认 1024 以上端口、只认最长前缀匹配、按机器去重、按会话限量。
 */

export interface ProcessEntry {
  readonly pid: number;
  readonly cwd: string;
  readonly ports: readonly number[];
}

export interface WorkspaceOwner {
  readonly sessionId: string;
  readonly workerId: string;
  readonly path: string;
}

export interface AutoLinkCandidate {
  readonly sessionId: string;
  readonly workerId: string;
  readonly port: number;
}

export interface AutoLinkOptions {
  /** 同一会话最多挂多少条（默认 8，与预览接口一致）。 */
  readonly perSessionMax?: number;
  /** 已存在（含人工建的）的链接：`workerId|port` 与按会话计数都从这里排除。 */
  readonly links?: readonly PreviewLink[];
  /** 只看这些会话（例如排除已删除/已收起的会话）；缺省不过滤。 */
  readonly allowedSessions?: ReadonlySet<string>;
}

const MIN_PORT = 1024;
const DEFAULT_PER_SESSION = 8;

/** 路径前缀比较：`/a/b` 覆盖 `/a/b/c`，但不覆盖 `/a/bc`。 */
function covers(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const trimmed = root.endsWith('/') ? root : `${root}/`;
  return candidate.startsWith(trimmed);
}

export function autoLinkCandidates(
  processes: readonly ProcessEntry[],
  owners: readonly WorkspaceOwner[],
  options: AutoLinkOptions = {}
): readonly AutoLinkCandidate[] {
  const perSessionMax = options.perSessionMax ?? DEFAULT_PER_SESSION;
  const links = options.links ?? [];
  const taken = new Set(links.map((link) => `${link.workerId}|${link.port}`));
  const perSession = new Map<string, number>();
  for (const link of links) perSession.set(link.sessionId, (perSession.get(link.sessionId) ?? 0) + 1);

  // 同一个 session 可能挂着多个工作空间（组合工作空间）：只留最长的那个前缀。
  const sorted = [...owners].sort((a, b) => b.path.length - a.path.length);
  const seen = new Set<string>();
  const out: AutoLinkCandidate[] = [];

  for (const process of [...processes].sort((a, b) => a.pid - b.pid)) {
    for (const port of process.ports) {
      if (!Number.isInteger(port) || port < MIN_PORT || port > 65_535) continue;
      const owner = sorted.find(
        (entry) => entry.workerId !== '' && covers(entry.path, process.cwd)
      );
      if (owner === undefined) continue;
      if (options.allowedSessions !== undefined && !options.allowedSessions.has(owner.sessionId)) continue;
      const key = `${owner.workerId}|${port}`;
      if (seen.has(key)) continue;
      const count = perSession.get(owner.sessionId) ?? 0;
      if (count >= perSessionMax) continue;
      seen.add(key);
      if (taken.has(key)) continue;
      perSession.set(owner.sessionId, count + 1);
      out.push({ sessionId: owner.sessionId, workerId: owner.workerId, port });
    }
  }

  return out;
}
