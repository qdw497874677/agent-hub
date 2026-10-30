import { AuthorTag } from './author.tsx';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { attachmentUrl } from './api.ts';
import { useAccount } from './auth.tsx';
import {
  DEFAULT_DISPLAY,
  displayKey,
  parseDisplay,
  toolOpenByDefault,
  type DisplaySettings,
  type ThinkingDisplay,
  type ToolDisplay
} from './display-settings.ts';
import type { Block } from './live.ts';
import { LogMarkdown } from './log-markdown.tsx';
import { clipLines, parseUnifiedDiff, toolFamily, toolSummary, toolView, type DiffLine } from './tool-format.ts';

/**
 * 专注对话里的一条条消息（参照 OpenCode web 的时间线）：
 * 用户气泡、markdown 回复、可折叠的思考与工具卡片、行内错误。
 * 只管「怎么画」，数据来自 live-core 折好的 Block。
 */

/** 显示设置：localStorage 按账号分键，改了立刻生效、刷新后还在。 */
export function useDisplaySettings(): [DisplaySettings, (patch: Partial<DisplaySettings>) => void] {
  const account = useAccount();
  const key = displayKey(account?.id ?? null);
  const [settings, setSettings] = useState<DisplaySettings>(() => readDisplay(key));
  useEffect(() => setSettings(readDisplay(key)), [key]);
  return [
    settings,
    (patch) =>
      setSettings((current) => {
        const next = { ...current, ...patch };
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // 隐私模式写不进去：这次会话里照样生效。
        }
        return next;
      })
  ];
}

function readDisplay(key: string): DisplaySettings {
  try {
    return parseDisplay(localStorage.getItem(key));
  } catch {
    return DEFAULT_DISPLAY;
  }
}

function useDismiss(open: boolean, close: () => void) {
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return root;
}

/** 头部按钮下拉的小菜单。点外面或 Esc 收起；触控区 44px。 */
export function Dropdown({
  label,
  icon,
  width = 'w-60',
  children
}: {
  label: string;
  icon: ReactNode;
  width?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useDismiss(open, () => setOpen(false));
  return (
    <div ref={root} className="relative">
      <button
        className="flex h-11 min-w-9 items-center justify-center rounded-sm px-1.5 text-meta text-tertiary hover:text-primary md:h-9"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {icon}
      </button>
      {open ? (
        <div role="menu" className={`absolute right-0 z-30 mt-1 ${width} rounded-sm border border-hair bg-panel py-1 shadow`}>
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({
  title,
  hint,
  disabled,
  onClick
}: {
  title: string;
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      className="block w-full px-3 py-2.5 text-left text-sub text-secondary hover:text-primary disabled:opacity-40"
      disabled={disabled}
      onClick={onClick}
    >
      {title}
      {hint ? <span className="mt-0.5 block text-meta text-tertiary">{hint}</span> : null}
    </button>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center justify-between gap-2 px-3 py-1.5">
      <span className="text-meta text-secondary">{label}</span>
      <span className="flex rounded-sm border border-hair">
        {options.map(([id, text]) => (
          <button
            key={id}
            role="radio"
            aria-checked={value === id}
            className={`px-2 py-1 text-meta ${value === id ? 'bg-card-raised text-primary' : 'text-tertiary hover:text-primary'}`}
            onClick={() => onChange(id)}
          >
            {text}
          </button>
        ))}
      </span>
    </div>
  );
}

function Toggle({ label, hint, checked, disabled, onChange }: { label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={`flex items-center justify-between gap-2 px-3 py-1.5 ${disabled ? 'opacity-40' : ''}`}>
      <span className="text-meta text-secondary">
        {label}
        {hint ? <span className="block text-tertiary">{hint}</span> : null}
      </span>
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
    </label>
  );
}

/** 「显示」菜单：对应 OpenCode 的 Show reasoning summaries / Expand shell・edit tool parts / compact。 */
export function DisplayMenu({ settings, onChange }: { settings: DisplaySettings; onChange: (patch: Partial<DisplaySettings>) => void }) {
  return (
    <Dropdown label="显示设置" icon={<span aria-hidden>Aa</span>} width="w-72">
      {() => (
        <div className="py-1" data-testid="display-settings">
          <Segmented<ToolDisplay>
            label="工具调用"
            value={settings.tools}
            options={[
              ['expanded', '展开'],
              ['collapsed', '折叠'],
              ['hidden', '隐藏']
            ]}
            onChange={(tools) => onChange({ tools })}
          />
          <Toggle label="命令输出默认展开" checked={settings.shellExpanded} disabled={settings.tools !== 'collapsed'} onChange={(shellExpanded) => onChange({ shellExpanded })} />
          <Toggle label="文件改动默认展开" checked={settings.editExpanded} disabled={settings.tools !== 'collapsed'} onChange={(editExpanded) => onChange({ editExpanded })} />
          <Segmented<ThinkingDisplay>
            label="思考过程"
            value={settings.thinking}
            options={[
              ['shown', '显示'],
              ['collapsed', '折叠'],
              ['hidden', '隐藏']
            ]}
            onChange={(thinking) => onChange({ thinking })}
          />
          <Toggle label="紧凑模式" hint="收紧行距，一屏多看几条" checked={settings.compact} onChange={(compact) => onChange({ compact })} />
        </div>
      )}
    </Dropdown>
  );
}

function DiffView({ lines }: { lines: readonly DiffLine[] }) {
  const [all, setAll] = useState(false);
  const limit = 40;
  const shown = all ? lines : lines.slice(0, limit);
  return (
    <div className="overflow-x-auto rounded-sm border border-hair bg-card font-mono text-meta" data-testid="tool-diff">
      {shown.map((line, index) => (
        <div
          key={index}
          className={`whitespace-pre px-2 ${
            line.sign === '+' ? 'bg-sage/10 text-sage' : line.sign === '-' ? 'bg-rust/10 text-rust' : line.sign === '@' ? 'text-tertiary' : 'text-secondary'
          }`}
        >
          {line.sign === '@' ? '⋯' : `${line.sign} ${line.text}`}
        </div>
      ))}
      {lines.length > limit && !all ? (
        <button className="w-full px-2 py-1 text-left text-tertiary hover:text-primary" onClick={() => setAll(true)}>
          展开全部（还有 {lines.length - limit} 行）
        </button>
      ) : null}
    </div>
  );
}

function OutputView({ text, failed }: { text: string; failed: boolean }) {
  const [all, setAll] = useState(false);
  const diff = parseUnifiedDiff(text);
  if (diff !== null) return <DiffView lines={diff} />;
  const clipped = clipLines(text);
  return (
    <div data-testid="tool-output">
      <pre className={`max-h-[480px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-hair bg-card px-2 py-1.5 font-mono text-meta ${failed ? 'text-rust' : 'text-secondary'}`}>
        {all ? text : clipped.shown}
      </pre>
      {clipped.hidden > 0 ? (
        <button className="mt-0.5 text-meta text-tertiary hover:text-primary" onClick={() => setAll(!all)}>
          {all ? '收起' : `展开全部（还有 ${clipped.hidden} 行）`}
        </button>
      ) : null}
    </div>
  );
}

function ToolCard({ block, settings }: { block: Extract<Block, { kind: 'tool' }>; settings: DisplaySettings }) {
  const view = toolView(block.name, block.input);
  const family = toolFamily(block.name, view);
  const mark = block.result === null ? '⋯' : block.result.ok ? '✓' : '✗';
  const spent = block.result === null ? '运行中' : block.result.durationMs > 0 ? `${block.result.durationMs}ms` : '';
  const output = block.result?.output;
  return (
    <details className="group border-l border-hair pl-3" open={toolOpenByDefault(settings, family)} data-testid="tool-card">
      <summary className="flex cursor-pointer list-none items-baseline gap-2 text-meta text-secondary">
        <span className={block.result?.ok === false ? 'text-rust' : 'text-tertiary'}>{mark}</span>
        <span className="shrink-0 font-mono text-sage">{block.name}</span>
        <span className="min-w-0 truncate font-mono opacity-70">{toolSummary(view)}</span>
        <span className="ml-auto shrink-0 text-tertiary">{spent}</span>
      </summary>
      <div className="mt-1.5 space-y-1.5">
        {view.kind === 'shell' ? (
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-sm bg-card-raised px-2 py-1.5 font-mono text-meta text-primary" data-testid="tool-input">
            <span className="select-none text-tertiary">$ </span>
            {view.command}
          </pre>
        ) : view.kind === 'edit' ? (
          <>
            <p className="font-mono text-meta text-tertiary">{view.path}</p>
            <DiffView lines={view.diff} />
          </>
        ) : view.kind === 'file' ? (
          <p className="font-mono text-meta text-tertiary" data-testid="tool-input">
            {view.path}
            {view.detail ? ` · ${view.detail}` : ''}
          </p>
        ) : (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-meta text-tertiary" data-testid="tool-input">
            {view.text}
          </pre>
        )}
        {output !== undefined && !(view.kind === 'edit' && block.result?.ok) ? (
          <OutputView text={output} failed={block.result?.ok === false} />
        ) : output !== undefined ? (
          <p className="text-meta text-tertiary">{output.split('\n')[0]}</p>
        ) : block.result !== null ? (
          <p className="text-meta text-tertiary">（没有输出）</p>
        ) : null}
      </div>
    </details>
  );
}

function ThinkingBlock({ text, settings, live }: { text: string; settings: DisplaySettings; live: boolean }) {
  if (settings.thinking === 'hidden') return null;
  return (
    <details className="group text-meta" open={settings.thinking === 'shown'} data-testid="thinking">
      <summary className="cursor-pointer list-none text-tertiary hover:text-secondary">
        <span className="inline-block transition-transform group-open:rotate-90">›</span> {live ? '正在思考…' : '思考过程'}
      </summary>
      <p className="mt-1 whitespace-pre-wrap border-l border-hair pl-3 italic text-tertiary">{text}</p>
    </details>
  );
}

export function ChatBlock({
  block,
  sessionId,
  agentLabel,
  settings,
  last,
  running,
  showAuthor = false
}: {
  block: Block;
  sessionId: string;
  agentLabel: string;
  settings: DisplaySettings;
  /** 是不是最后一块：正在流的思考写「正在思考…」。 */
  last: boolean;
  running: boolean;
  /** 不止一个人说过话时，用户气泡旁标出是谁。 */
  showAuthor?: boolean;
}) {
  if (block.kind === 'prompt') {
    const images = block.attachments.filter((item) => item.kind === 'image');
    const others = block.attachments.filter((item) => item.kind !== 'image');
    return (
      <div className="flex flex-col items-end gap-1.5" data-testid="msg-user">
        {showAuthor ? <AuthorTag author={block.author} /> : null}
        {images.length > 0 ? (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
            {images.map((item) => (
              <a key={item.path} href={attachmentUrl(sessionId, item.path)} target="_blank" rel="noreferrer">
                <img src={attachmentUrl(sessionId, item.path)} alt={item.name} loading="lazy" className="max-h-40 max-w-[240px] rounded-md border border-hair object-cover" />
              </a>
            ))}
          </div>
        ) : null}
        {others.length > 0 ? (
          <ul aria-label="附带的文件" className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
            {others.map((item) => (
              <li key={item.path} title={item.path} className="max-w-[260px] truncate rounded-sm border border-hair px-1.5 py-0.5 font-mono text-meta text-secondary">
                {item.kind === 'mention' ? '@' : '▤ '}
                {item.kind === 'mention' ? item.path : item.name}
              </li>
            ))}
          </ul>
        ) : null}
        {block.text !== '' ? (
          <p className="max-w-[85%] whitespace-pre-wrap rounded-md rounded-br-sm bg-card-raised px-3 py-2 text-body text-primary">{block.text}</p>
        ) : null}
      </div>
    );
  }
  if (block.kind === 'error') {
    return (
      <p role="alert" className="whitespace-pre-wrap rounded-sm border-l-2 border-rust bg-rust/10 px-3 py-2 text-meta text-rust" data-testid="msg-error">
        {block.text}
      </p>
    );
  }
  if (block.kind === 'stall') {
    return (
      <p role="status" className="border-l border-rust pl-2 text-meta text-rust">
        {block.text}
      </p>
    );
  }
  if (block.kind === 'thinking') return <ThinkingBlock text={block.text} settings={settings} live={last && running} />;
  if (block.kind === 'text') {
    return (
      <div data-testid="msg-assistant">
        <LogMarkdown body={block.text} className="text-body leading-relaxed text-primary/90" />
      </div>
    );
  }
  if (block.kind === 'tool') {
    if (settings.tools === 'hidden') return null;
    return <ToolCard block={block} settings={settings} />;
  }
  return (
    <p className="flex items-baseline gap-2 text-meta">
      <span className="text-accent-dim">◆</span>
      <span className="font-mono text-secondary">{block.path}</span>
      <span className="text-tertiary">{block.bytes > 0 ? `${block.bytes} 字节` : ''}</span>
      <span className="ml-auto text-tertiary">{agentLabel}</span>
    </p>
  );
}
