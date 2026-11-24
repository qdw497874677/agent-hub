import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Command } from 'cmdk';
import { Sheet } from '../shell/dialog-shell.tsx';
import { useNarrow } from '../shell/device.ts';
import { groupModels, pushRecent, type ModelItem } from './model-list.ts';

const recentKey = (scope: string) => `agent-hub.recent-models.${scope}`;

/** 底栏空间有限：`provider/model` 只留 `model`，完整值仍在 aria-label/title 里。 */
function modelName(label: string): string {
  const slash = label.lastIndexOf('/');
  return slash >= 0 ? label.slice(slash + 1) : label;
}

function readRecent(scope: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(recentKey(scope)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 全站唯一的模型选择器（输入框、派生对话框、Bot 设置共用）：照 VS Code Quick Pick / Raycast 的做法，一个按钮打开「搜索框 + 分组列表」。
 * 不论清单长短都用它，不替人自动选：值为空就显示占位。
 * cmdk 管键盘和无障碍；按提供方分组，最近用过的置顶（按 agent 记在本机浏览器里）。
 * 宽屏是居中的浮层，窄屏走底部抽屉（Sheet：贴底、占满宽度、可拖把手关），行高够手指点。
 * 用 portal 挂到 body，画布的缩放变换不影响它。
 */
export function ModelPicker({
  items,
  value,
  onChange,
  scope,
  label = '模型',
  disabled = false,
  pending = false,
  className = '',
  id,
  short = false,
  note,
  placeholder = '默认'
}: {
  items: readonly ModelItem[];
  value: string;
  onChange: (value: string) => void;
  /** 「最近用过」按什么记：一般是 agent id。 */
  scope: string;
  label?: string;
  disabled?: boolean;
  /** 请求还在飞：按钮写「切换中…」，不先显示还没被确认的目标值。 */
  pending?: boolean;
  className?: string;
  id?: string;
  /** 窄屏底栏只显示模型名本身，不把提供方前缀也塞进去。 */
  short?: boolean;
  /** 清单底部的一行说明：这轮有哪些模型被收起来了（不可选、也不能聚焦）。 */
  note?: string;
  /** 值为空时按钮上写什么（派生对话框里只能用 hub 模型时写「选择模型…」）。 */
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = items.find((item) => item.value === value);
  const full = current?.label ?? value;
  const shown = short ? modelName(full) : full;
  return (
    <>
      <button
        type="button"
        id={id}
        aria-label={`${label}：${full || placeholder}${pending ? '（切换中…）' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={pending || undefined}
        disabled={disabled || pending}
        title={pending ? `${full || placeholder} · 正在等 agent 确认` : full}
        className={`flex min-w-0 items-center justify-between gap-1 text-left ${className}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <span className="min-w-0 truncate">{pending ? '切换中…' : shown || placeholder}</span>
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
              note={note}
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
  note,
  onPick,
  onClose
}: {
  items: readonly ModelItem[];
  value: string;
  label: string;
  scope: string;
  note?: string;
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const narrow = useNarrow();
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

  const command = (
        <Command
          label={`选择${label}`}
          shouldFilter={false}
          value={selected}
          onValueChange={setSelected}
          loop
          className={`flex min-h-0 flex-1 flex-col ${narrow ? 'pb-[env(safe-area-inset-bottom)]' : ''}`}
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
          {narrow && note !== undefined ? (
            // 窄屏：抽屉一打开就在搜索框下面，还没选模型就先看见「换提供方会重启进程」。
            // 放在列表外面，滚动候选时也不会被推走。
            <p
              data-testid="model-scope-note"
              className="mx-1.5 mb-1 shrink-0 border-l-2 border-rust/60 bg-rust/5 px-2 py-1.5 text-meta leading-snug text-secondary"
            >
              {note}
            </p>
          ) : null}
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
                    disabled={item.disabled === true}
                    onSelect={() => pick(item.value)}
                    className="flex min-h-[48px] cursor-pointer items-center gap-2 rounded-sm px-3 text-body text-secondary data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-45 data-[selected=true]:bg-selected data-[selected=true]:text-primary sm:min-h-0 sm:py-1.5"
                  >
                    <span aria-hidden className="w-4 shrink-0 text-center text-primary">
                      {item.value === value ? '✓' : ''}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 truncate font-mono text-sub" title={item.label}>
                          {/* 组名已经是提供方了，行里不再重复前缀 */}
                          {item.label.startsWith(`${group.heading}/`) ? item.label.slice(group.heading.length + 1) : item.label}
                        </span>
                        {item.meta ? <span className="ml-auto shrink-0 text-meta text-tertiary">{item.meta}</span> : null}
                      </span>
                      {item.description ? <span className="block truncate text-meta text-tertiary">{item.description}</span> : null}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
            {note === undefined || narrow ? null : (
              // 说明行不是候选项：disabled 让 cmdk 跳过它（键盘不聚焦、点了也不选），
              // value 用不可能跟模型 id 撞的值，免得它被当成「当前选中」。
              <Command.Item
                value="scope-note"
                disabled
                className="flex min-h-[40px] items-center gap-2 px-3 pt-1 text-meta text-tertiary sm:min-h-0"
              >
                <span aria-hidden className="w-4 shrink-0 text-center">
                  ·
                </span>
                <span className="min-w-0 flex-1">{note}</span>
              </Command.Item>
            )}
          </Command.List>
        </Command>
  );

  // 窄屏：底部抽屉，把手能拖、遮罩能点、Esc 能关（都收在 dialog-shell 里）
  if (narrow) {
    return (
      <Sheet title={`选择${label}`} onClose={onClose} testId="model-sheet" scroll={false} zClassName="z-[60]">
        {command}
      </Sheet>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/55 sm:items-start sm:pt-[12vh]"
      onClick={onClose}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`选择${label}`}
        className="flex max-h-[60vh] w-full flex-col overflow-hidden rounded-overlay border border-strong bg-overlay shadow-overlay sm:max-w-[440px]"
        onClick={(event) => event.stopPropagation()}
      >
        {command}
      </div>
    </div>
  );
}
