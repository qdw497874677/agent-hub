import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Command } from 'cmdk';
import { groupModels, pushRecent, type ModelItem } from './model-list.ts';

/** 清单短的时候原生下拉就够了；超过这个数才换成可搜索的选择器。 */
export const SEARCHABLE_AFTER = 8;

const recentKey = (scope: string) => `agent-hub.recent-models.${scope}`;

function readRecent(scope: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(recentKey(scope)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 可搜索的模型选择器：照 VS Code Quick Pick / Raycast 的做法，一个按钮打开「搜索框 + 分组列表」。
 * cmdk 管键盘和无障碍；按提供方分组，最近用过的置顶（按 agent 记在本机浏览器里）。
 * 宽屏是居中的浮层，窄屏贴底、占满宽度，行高够手指点。用 portal 挂到 body，画布的缩放变换不影响它。
 */
export function ModelPicker({
  items,
  value,
  onChange,
  scope,
  label = '模型',
  disabled = false,
  className = '',
  id
}: {
  items: readonly ModelItem[];
  value: string;
  onChange: (value: string) => void;
  /** 「最近用过」按什么记：一般是 agent id。 */
  scope: string;
  label?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = items.find((item) => item.value === value);
  return (
    <>
      <button
        type="button"
        id={id}
        aria-label={`${label}：${current?.label ?? value}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        title={current?.label ?? value}
        className={`flex min-w-0 items-center justify-between gap-1 text-left ${className}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <span className="min-w-0 truncate">{current?.label ?? (value || '默认')}</span>
        <span aria-hidden className="shrink-0 text-tertiary">
          ▾
        </span>
      </button>
      {open
        ? createPortal(
            <ModelSheet
              items={items}
              value={value}
              label={label}
              scope={scope}
              onClose={() => setOpen(false)}
              onPick={(picked) => {
                setOpen(false);
                if (picked !== value) onChange(picked);
              }}
            />,
            document.body
          )
        : null}
    </>
  );
}

function ModelSheet({
  items,
  value,
  label,
  scope,
  onPick,
  onClose
}: {
  items: readonly ModelItem[];
  value: string;
  label: string;
  scope: string;
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const recent = useMemo(() => readRecent(scope), [scope]);
  const groups = useMemo(() => groupModels(items, query, recent), [items, query, recent]);
  // 同一个模型可能同时在「最近用过」和它的提供方组里，cmdk 的 value 用「组:模型」保证唯一
  const keyOf = (heading: string, model: string) => `${heading}:${model}`;
  const [selected, setSelected] = useState(() => {
    const home = groups.find((group) => group.items.some((item) => item.value === value));
    return home ? keyOf(home.heading, value) : '';
  });
  useEffect(() => {
    const first = groups[0];
    if (query !== '' && first?.items[0]) setSelected(keyOf(first.heading, first.items[0].value));
  }, [groups, query]);

  const pick = (picked: string) => {
    try {
      localStorage.setItem(recentKey(scope), JSON.stringify(pushRecent(readRecent(scope), picked)));
    } catch {
      // 隐私模式等存不了就算了，只是少了「最近用过」
    }
    onPick(picked);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-canvas/75 sm:items-start sm:pt-[12vh]"
      onClick={onClose}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`选择${label}`}
        className="flex max-h-[80dvh] w-full flex-col rounded-t-md border border-strong bg-panel pb-[env(safe-area-inset-bottom)] sm:max-h-[60vh] sm:max-w-[440px] sm:rounded-md sm:pb-0"
        onClick={(event) => event.stopPropagation()}
      >
        <Command
          label={`选择${label}`}
          shouldFilter={false}
          value={selected}
          onValueChange={setSelected}
          loop
          className="flex min-h-0 flex-1 flex-col"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              // 别让外层对话框（DialogShell 在 window 上听 Esc）跟着一起关
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
        >
          <div className="flex items-center gap-2 border-b border-hair px-3">
            <span aria-hidden className="text-tertiary">
              ⌕
            </span>
            <Command.Input
              autoFocus
              aria-label={`搜索${label}`}
              value={query}
              onValueChange={setQuery}
              placeholder={`搜索${label}或提供方…（共 ${items.length} 个）`}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="min-w-0 flex-1 bg-transparent py-3 text-body text-primary outline-none placeholder:text-tertiary"
            />
            <button
              type="button"
              className="-mr-1 min-h-[44px] shrink-0 rounded-sm px-2 text-meta text-secondary hover:bg-card-raised sm:min-h-0 sm:py-1"
              onClick={onClose}
            >
              取消
            </button>
          </div>
          <Command.List className="min-h-0 flex-1 overflow-y-auto p-1.5 [scroll-padding-block:6px]">
            <Command.Empty className="px-3 py-3 text-meta text-tertiary">没有匹配的{label}</Command.Empty>
            {groups.map((group) => (
              <Command.Group
                key={group.heading}
                heading={group.heading}
                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-meta [&_[cmdk-group-heading]]:text-tertiary"
              >
                {group.items.map((item) => (
                  <Command.Item
                    key={keyOf(group.heading, item.value)}
                    value={keyOf(group.heading, item.value)}
                    onSelect={() => pick(item.value)}
                    className="flex min-h-[48px] cursor-pointer items-center gap-2 rounded-sm px-3 text-body text-secondary data-[selected=true]:bg-card-raised data-[selected=true]:text-primary sm:min-h-0 sm:py-1.5"
                  >
                    <span aria-hidden className="w-4 shrink-0 text-center text-accent">
                      {item.value === value ? '✓' : ''}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-sub">{item.label}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
