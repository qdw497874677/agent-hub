/**
 * 对话的显示设置（参照 OpenCode web 的 Settings › General：
 * Show reasoning summaries / Expand shell tool parts / Expand edit tool parts / compact timeline）。
 *
 * 只是「怎么看」，不影响 agent 做什么，所以存在浏览器 localStorage 里、按账号分键；
 * 换台设备重新设一次，不值得为它加服务端表。纯逻辑在这里，node:test 能测。
 */
export type ToolDisplay = 'expanded' | 'collapsed' | 'hidden';
export type ThinkingDisplay = 'shown' | 'collapsed' | 'hidden';
/** 对比度：跟随系统偏好，或者由用户手动要求更高。 */
export type ContrastDisplay = 'auto' | 'more';

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
  /** 对比度：auto 跟随系统，more 手动抬高一档。 */
  readonly contrast: ContrastDisplay;
}

export const DEFAULT_DISPLAY: DisplaySettings = {
  tools: 'collapsed',
  shellExpanded: false,
  editExpanded: true,
  thinking: 'collapsed',
  compact: false,
  contrast: 'auto'
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
    compact: flag('compact', DEFAULT_DISPLAY.compact),
    contrast: pick('contrast', ['auto', 'more'], DEFAULT_DISPLAY.contrast)
  };
}

/**
 * 该给页面写的对比度。现在只有 auto / more 两档，直接透传；
 * 以后要加 'less' 时，所有「settings → 页面表现」的判断都从这里改，不用翻组件。
 */
export function applyContrast(settings: DisplaySettings): ContrastDisplay {
  return settings.contrast;
}

/** 某个工具卡片一打开时是不是展开的。 */
export function toolOpenByDefault(settings: DisplaySettings, family: 'shell' | 'edit' | 'other'): boolean {
  if (settings.tools === 'expanded') return true;
  if (settings.tools === 'hidden') return false;
  return (family === 'shell' && settings.shellExpanded) || (family === 'edit' && settings.editExpanded);
}
