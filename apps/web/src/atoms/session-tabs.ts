/**
 * 会话页的标签（PR #156 方案 A + 终端 + 预览）：会话 / 文件 / 改动 / 终端 / 预览。纯函数，不依赖 React。
 */
export type SessionTab = 'chat' | 'files' | 'changes' | 'terminal' | 'preview';

export const SESSION_TABS: readonly SessionTab[] = ['chat', 'files', 'changes', 'terminal', 'preview'];

/** 标签文字；改动数未知（还没读到 / 机器离线）时不显示数字。 */
export function sessionTabLabel(tab: SessionTab, changeCount?: number): string {
  if (tab === 'chat') return '会话';
  if (tab === 'files') return '文件';
  if (tab === 'terminal') return '终端';
  if (tab === 'preview') return '预览';
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

/** 上次停在哪一页：刷新后回到终端，而不是被安静地打回对话。 */
export function readStoredTab(sessionId: string, storage: TabStorage | null = tabStorage()): SessionTab | null {
  try {
    const raw = storage?.getItem(`${TAB_STORE}:${sessionId}`) ?? null;
    return raw !== null && isTab(raw) ? raw : null;
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
