/** 只记用户实际打开过的 ID，不把创建时间当成访问记录，也不在本地保存标题。 */
function key(accountId: string, projectId: string): string {
  return `agent-hub:palette-recent:${encodeURIComponent(accountId)}:${encodeURIComponent(projectId)}`;
}

export function readPaletteRecent(accountId: string, projectId: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(accountId, projectId)) ?? '[]');
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))].slice(0, 20) : [];
  } catch {
    return [];
  }
}

export function rememberPaletteRecent(accountId: string, projectId: string, sessionId: string): void {
  try {
    localStorage.setItem(key(accountId, projectId), JSON.stringify([sessionId, ...readPaletteRecent(accountId, projectId).filter((id) => id !== sessionId)].slice(0, 20)));
  } catch {
    // 隐私模式或配额不足时不记最近记录，不影响导航。
  }
}

/** 面板打开时冻结当前项目可见成员；后续实时状态只更新或移除行。 */
export function paletteSnapshot(
  accountId: string | null,
  projectId: string,
  visibleIds: readonly string[],
  items: readonly { projectId: string; sessionId: string }[]
): { attention: string[]; recent: string[] } {
  const visible = new Set(visibleIds);
  const attention = [...new Set(items.filter((item) => item.projectId === projectId && visible.has(item.sessionId)).map((item) => item.sessionId))];
  const waiting = new Set(attention);
  return { attention, recent: accountId ? readPaletteRecent(accountId, projectId).filter((id) => visible.has(id) && !waiting.has(id)) : [] };
}
