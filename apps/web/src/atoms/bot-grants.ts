/**
 * bot 的项目授权（bot 归团队，项目只是授权）的展示口径。纯函数，不碰 DOM；
 * 单测在 bot-grants.test.ts。
 *
 * 契约（apps/server/src/bot-routes.ts）：
 * - `GET /api/bots?projectId=` 只回「已授权到该项目」的 bot；
 * - `GET /api/bots/team/:teamId` 回团队全部 bot（没有授权也能看到）；
 * - `GET /api/bots/:id/grants` 回这个 bot 的授权行（projectId + workspaceId）；
 * - 撤销后它不再出现在那个项目里，群成员是快照，需要另行从群里移出。
 */

/** 只用得到的两个字段；结构上兼容 `BotGrantDto`。 */
export interface BotGrantRef {
  readonly projectId: string;
  readonly workspaceId: string | null;
}

/** 列表标题下面那句：一句话说清「为什么这里只有一部分 bot」。 */
export const BOT_SCOPE_NOTE = '本项目已授权的 Bot';

/** 授权段的小字：讲清授权的作用范围。 */
export const BOT_GRANTS_HINT = '授权到项目后，才能把它拉进这个项目的群。';

/** 一个授权都没有时的空态。 */
export const BOT_GRANTS_EMPTY = '还没授权到任何项目。';

export const BOT_GRANT_PICKER_TITLE = '授权已有 bot';

/** 团队里的 bot 全都在这个项目里了（选择浮层的空态）。 */
export const BOT_GRANT_PICKER_EMPTY = '团队里的 bot 都已经授权到这个项目了。';

/** 没指定工作目录 = 跟随项目默认（后端的 workspaceId 为 null）。 */
export const BOT_GRANT_WORKSPACE_DEFAULT = '工作目录：跟随项目默认';

/**
 * 团队里还没授权到本项目的 bot，保持团队列表的顺序（授权浮层不重排，认位置靠记忆）。
 */
export function grantCandidates<T extends { readonly id: string }>(
  teamBots: readonly T[],
  grantedIds: Iterable<string>
): T[] {
  const granted = new Set(grantedIds);
  return teamBots.filter((bot) => !granted.has(bot.id));
}

/**
 * 选择浮层的内容。加载中不给空态：清单还在路上时先说「都授权了」会闪一下假结论。
 */
export function grantPickerView<T extends { readonly id: string }>(
  teamBots: readonly T[],
  grantedIds: Iterable<string>,
  loading = false
): { readonly items: readonly T[]; readonly empty: string | null } {
  const items = grantCandidates(teamBots, grantedIds);
  return { items, empty: loading || items.length > 0 ? null : BOT_GRANT_PICKER_EMPTY };
}

/**
 * 这个 bot 在某个项目上的那条授权。非 null 才显示「撤销」；null 才显示「授权到这个项目」。
 */
export function projectGrant<T extends { readonly projectId: string }>(
  grants: readonly T[],
  projectId: string
): T | null {
  return grants.find((grant) => grant.projectId === projectId) ?? null;
}

/**
 * 工作目录那一行。null = 跟随项目默认；查不到名字（空间被删 / 还没拉清单）就退回 id，
 * 别显示一个空字符串让人以为没指定。
 */
export function grantedWorkspaceText(
  workspaceId: string | null,
  names: ReadonlyMap<string, string>
): string {
  if (!workspaceId) return BOT_GRANT_WORKSPACE_DEFAULT;
  return `工作目录：${names.get(workspaceId) ?? workspaceId}`;
}

/** 授权行上给人看的两行：项目名 + 工作目录。项目名缺了（项目被删 / 还没拉清单）退回 id。 */
export function grantRowView(
  grant: BotGrantRef,
  projectName: string | null | undefined,
  workspaceNames: ReadonlyMap<string, string>
): { readonly project: string; readonly workspace: string } {
  return {
    project: projectName?.trim() || grant.projectId,
    workspace: grantedWorkspaceText(grant.workspaceId, workspaceNames)
  };
}

/**
 * 撤销前要人确认的那句：说清后果（从本项目的群里移出、@ 不再响应），也说清不丢什么。
 */
export function grantRevokeConfirm(label: string, projectName: string): string {
  return `撤销「${label}」在「${projectName}」的授权？它会从本项目的群里移出，@ 它也不再响应；已有的会话和聊天记录会保留。`;
}
