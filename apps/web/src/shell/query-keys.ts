/**
 * React Query 的 key 归属（Paseo 式分层）：谁拥有这份状态，key 就用谁。
 *
 * 目录派生（同一目录被多条会话共用，以 git / 文件系统为准）：
 *   git 状态、文件树 / 文件内容 / 搜索 / context、对比 HEAD 的改动与 diff。
 *   → workspaceId；老会话没有工作空间时回退 sessionId（此时它就是这个目录的唯一标识）。
 * 会话自有（只有这条会话知道）：
 *   turns、以会话 / 某一轮为基准的改动与 diff、deliveries、canvas。
 *   → sessionId。
 *
 * 两条会话共用同一目录时，目录维度的缓存共享，会话维度的不共享。
 * 字符串数组散在各文件里时，失效前缀特别容易和定义前缀对不上（文件 SSE 最明显），
 * 所以统一从这里生成；新代码不要再手写 `['files', ...]` 这类数组。
 */

/** 目录维度 key 的作用域：优先工作空间，没有工作空间的老会话退回 sessionId。 */
export function directoryScope(workspaceId: string | null | undefined, sessionId: string): string {
  return workspaceId ?? sessionId;
}

export const gitKeys = {
  /** git 状态是目录的：同目录的提交面板和会话头共用一份。 */
  all: (workspaceId: string | null | undefined, sessionId: string) =>
    ['git', directoryScope(workspaceId, sessionId)] as const,
  state: (workspaceId: string | null | undefined, sessionId: string) =>
    ['git', directoryScope(workspaceId, sessionId), 'state'] as const
};

/** 改动 / diff 的基准：'head' 是目录派生，'session' | 'turn' | 'turn:<n>' 是会话自有。 */
function ownedBySession(base: string): boolean {
  return base !== 'head';
}

export function filesKeys(workspaceId: string | null | undefined, sessionId: string) {
  const dir = directoryScope(workspaceId, sessionId);
  return {
    /** 目录维度前缀：list / read / find / context / 以 HEAD 为基准的 changes & diff。 */
    dir: ['files', dir] as const,
    /** 会话自有前缀：turns / 以会话或某一轮为基准的 changes & diff。 */
    session: ['files', sessionId] as const,
    list: (path: string) => ['files', dir, 'list', path] as const,
    read: (path: string, confirmed: boolean) => ['files', dir, 'read', path, confirmed] as const,
    find: (query: string) => ['files', dir, 'find', query] as const,
    context: () => ['files', dir, 'context'] as const,
    changes: (base: string) =>
      ownedBySession(base)
        ? (['files', sessionId, 'changes', base] as const)
        : (['files', dir, 'changes', base] as const),
    diff: (path: string, base: string) =>
      ownedBySession(base)
        ? (['files', sessionId, 'diff', path, base] as const)
        : (['files', dir, 'diff', path, base] as const),
    /** 会话的检查点（每轮改了哪些文件）只属于这条会话。 */
    turns: () => ['files', sessionId, 'turns'] as const
  };
}

export type FilesKeys = ReturnType<typeof filesKeys>;

/**
 * 刷新文件数据时两条前缀都要失效：目录维度的共享缓存 + 本会话自有的 turns / 基准。
 * 没有工作空间时两者是同一个前缀，只返回一条，避免重复触发同一批请求。
 */
export function filesInvalidationKeys(keys: FilesKeys): readonly (readonly unknown[])[] {
  return keys.dir[1] === keys.session[1] ? [keys.dir] : [keys.dir, keys.session];
}

export const taskKeys = {
  pullRequests: (taskId: string) => ['task-prs', taskId] as const
};

export const workspaceKeys = {
  /** 工作空间列表里的「有没有未提交 / 没推的改动」：git 操作成功后要一起失效。 */
  changes: (workspaceId: string) => ['workspace-changes', workspaceId] as const
};

export const projectKeys = {
  canvas: (projectId: string) => ['canvas', projectId] as const
};
