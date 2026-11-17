/** 主题的纯逻辑（无 DOM），单测在 theme.test.ts；带 DOM 的部分在 theme.ts。 */
export type ThemePref = 'auto' | 'dark' | 'light';
export type Theme = 'dark' | 'light';

export const THEME_KEY = 'agent-hub.theme';

export function parseThemePref(raw: string | null | undefined): ThemePref {
  return raw === 'dark' || raw === 'light' || raw === 'auto' ? raw : 'auto';
}

/** 偏好 + 系统是否浅色 → 实际主题。纯函数，单测在 theme.test.ts。 */
export function resolveTheme(pref: ThemePref, systemLight: boolean): Theme {
  if (pref === 'auto') return systemLight ? 'light' : 'dark';
  return pref;
}
