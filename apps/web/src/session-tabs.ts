/**
 * 会话页的三个标签（PR #156 方案 A）：对话 / 文件 / 改动。纯函数，不依赖 React。
 */
export type SessionTab = 'chat' | 'files' | 'changes';

export const SESSION_TABS: readonly SessionTab[] = ['chat', 'files', 'changes'];

/** 标签文字；改动数未知（还没读到 / Worker 离线）时不显示数字。 */
export function sessionTabLabel(tab: SessionTab, changeCount?: number): string {
  if (tab === 'chat') return '对话';
  if (tab === 'files') return '文件';
  return changeCount === undefined ? '改动' : `改动 ${changeCount}`;
}

/** 键盘左右切换标签（WAI-ARIA tabs），首尾循环。 */
export function stepTab(current: SessionTab, delta: 1 | -1): SessionTab {
  const index = SESSION_TABS.indexOf(current);
  return SESSION_TABS[(index + delta + SESSION_TABS.length) % SESSION_TABS.length]!;
}
