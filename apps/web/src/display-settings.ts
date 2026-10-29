/**
 * 对话的显示设置（参照 OpenCode web 的 Settings › General：
 * Show reasoning summaries / Expand shell tool parts / Expand edit tool parts / compact timeline）。
 *
 * 只是「怎么看」，不影响 agent 做什么，所以存在浏览器 localStorage 里、按账号分键；
 * 换台设备重新设一次，不值得为它加服务端表。纯逻辑在这里，node:test 能测。
 */
export type ToolDisplay = 'expanded' | 'collapsed' | 'hidden';
export type ThinkingDisplay = 'shown' | 'collapsed' | 'hidden';

export interface DisplaySettings {
  /** 工具调用：展开 / 折叠 / 隐藏。 */
  readonly tools: ToolDisplay;
  /** 「折叠」时命令行工具（bash）仍默认展开。 */
  readonly shellExpanded: boolean;
  /** 「折叠」时改文件的工具（edit / write / patch）仍默认展开。 */
  readonly editExpanded: boolean;
  /** 思考过程：显示 / 折叠 / 隐藏。 */
  readonly thinking: ThinkingDisplay;
  /** 紧凑模式：行距、间隔都收紧，一屏多看几条。 */
  readonly compact: boolean;
}

export const DEFAULT_DISPLAY: DisplaySettings = {
  tools: 'collapsed',
  shellExpanded: false,
  editExpanded: true,
  thinking: 'collapsed',
  compact: false
};

export const displayKey = (userId: string | null) => `agent-hub.display.${userId ?? 'anon'}`;

/** 坏数据、老版本、手改过的值一律退回默认，不让页面白屏。 */
export function parseDisplay(raw: string | null): DisplaySettings {
  if (raw === null) return DEFAULT_DISPLAY;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_DISPLAY;
  }
  if (typeof value !== 'object' || value === null) return DEFAULT_DISPLAY;
  const v = value as Record<string, unknown>;
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T =>
    allowed.includes(v[key] as T) ? (v[key] as T) : fallback;
  const flag = (key: string, fallback: boolean) => (typeof v[key] === 'boolean' ? (v[key] as boolean) : fallback);
  return {
    tools: pick('tools', ['expanded', 'collapsed', 'hidden'], DEFAULT_DISPLAY.tools),
    shellExpanded: flag('shellExpanded', DEFAULT_DISPLAY.shellExpanded),
    editExpanded: flag('editExpanded', DEFAULT_DISPLAY.editExpanded),
    thinking: pick('thinking', ['shown', 'collapsed', 'hidden'], DEFAULT_DISPLAY.thinking),
    compact: flag('compact', DEFAULT_DISPLAY.compact)
  };
}

/** 某个工具卡片一打开时是不是展开的。 */
export function toolOpenByDefault(settings: DisplaySettings, family: 'shell' | 'edit' | 'other'): boolean {
  if (settings.tools === 'expanded') return true;
  if (settings.tools === 'hidden') return false;
  return (family === 'shell' && settings.shellExpanded) || (family === 'edit' && settings.editExpanded);
}
