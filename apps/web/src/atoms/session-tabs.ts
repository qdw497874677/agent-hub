/**
 * 会话页工具标签：会话 / 文件 / 改动 / 预览。纯函数，不依赖 React。
 */
export type SessionTab = 'chat' | 'files' | 'changes' | 'preview' | 'details';

export const SESSION_TABS: readonly SessionTab[] = ['chat', 'files', 'changes', 'preview', 'details'];

/** 标签文字；改动数未知（还没读到 / 机器离线）时不显示数字。 */
export function sessionTabLabel(tab: SessionTab, changeCount?: number): string {
  if (tab === 'chat') return '会话';
  if (tab === 'files') return '文件';
  if (tab === 'preview') return '预览';
  if (tab === 'details') return '详情';
  return changeCount === undefined ? '改动' : `改动 ${changeCount}`;
}

/** 键盘左右切换标签（WAI-ARIA tabs），首尾循环。 */
export function stepTab(current: SessionTab, delta: 1 | -1): SessionTab {
  const index = SESSION_TABS.indexOf(current);
  return SESSION_TABS[(index + delta + SESSION_TABS.length) % SESSION_TABS.length]!;
}

/** 只用得上这两个方法的存储接口：不把 DOM 的 Storage 类型拖进根 tsconfig。 */
interface TabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const TAB_STORE = 'hub:session-tab';
const CHANGES_STORE = 'hub:session-changes';

/** Only navigation is stored here; notes and their anchors are owned by the Hub. */
export type ChangesPosition = { base: string; file: { path: string; member: string | null } | null };

function tabStorage(): TabStorage | null {
  try {
    return (globalThis as { sessionStorage?: TabStorage }).sessionStorage ?? null;
  } catch {
    return null;
  }
}

function isTab(value: string): value is SessionTab {
  return (SESSION_TABS as readonly string[]).includes(value);
}

/** 旧版终端页签不再恢复，避免刷新时隐式打开 shell。 */
export function readStoredTab(sessionId: string, storage: TabStorage | null = tabStorage()): SessionTab | null {
  try {
    const raw = storage?.getItem(`${TAB_STORE}:${sessionId}`) ?? null;
    return raw === 'terminal' ? 'chat' : raw !== null && isTab(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function storeTab(sessionId: string, tab: SessionTab, storage: TabStorage | null = tabStorage()): void {
  try {
    storage?.setItem(`${TAB_STORE}:${sessionId}`, tab);
  } catch {
    // 隐私模式或配额满：记不住就算了，行为退回默认。
  }
}

export function readChangesSplit(sessionId: string): boolean {
  try { return tabStorage()?.getItem(`${CHANGES_STORE}:${sessionId}:split`) === 'true'; } catch { return false; }
}

export function storeChangesSplit(sessionId: string, enabled: boolean): void {
  try { tabStorage()?.setItem(`${CHANGES_STORE}:${sessionId}:split`, String(enabled)); } catch { /* storage is optional */ }
}

export function readChangesPosition(sessionId: string): ChangesPosition | null {
  try {
    const position = JSON.parse(tabStorage()?.getItem(`${CHANGES_STORE}:${sessionId}:position`) ?? 'null') as Partial<ChangesPosition> | null;
    if (!position || typeof position.base !== 'string' || !/^(session|head|branch|turn(?::\d+)?)$/.test(position.base)) return null;
    const file = position.file;
    if (file === null || (file && typeof file.path === 'string' && (file.member === null || typeof file.member === 'string'))) {
      return { base: position.base, file };
    }
  } catch { /* discard malformed or inaccessible state */ }
  return null;
}

export function storeChangesPosition(sessionId: string, position: ChangesPosition): void {
  try { tabStorage()?.setItem(`${CHANGES_STORE}:${sessionId}:position`, JSON.stringify(position)); } catch { /* storage is optional */ }
}
