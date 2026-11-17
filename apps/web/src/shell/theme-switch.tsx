import { Icon } from '../atoms/icons.tsx';
import { useThemePref, type ThemePref } from './theme.ts';

const OPTIONS: readonly [ThemePref, string, 'monitor' | 'moon' | 'sun'][] = [
  ['auto', '跟随系统', 'monitor'],
  ['dark', '深色', 'moon'],
  ['light', '浅色', 'sun']
];

/** 主题三选一：跟随系统 / 深色 / 浅色。账号菜单和「显示设置」里各放一份，记在本机。 */
export function ThemeSwitch({ withLabel = true }: { withLabel?: boolean }) {
  const [pref, , setPref] = useThemePref();
  return (
    <div className="flex items-center justify-between gap-3" data-testid="theme-switch">
      {withLabel ? <span className="text-meta text-secondary">主题</span> : null}
      <div role="radiogroup" aria-label="主题" className="flex gap-0.5 rounded-control border border-hair bg-canvas p-0.5">
        {OPTIONS.map(([value, label, icon]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={pref === value}
            aria-label={label}
            title={label}
            onClick={() => setPref(value)}
            className={`flex h-7 items-center gap-1 rounded-[4px] px-2 text-meta ${pref === value ? 'bg-selected text-primary' : 'text-tertiary hover:text-primary'}`}
          >
            <Icon name={icon} size={13} />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
