import { DeliveryNote } from './delivery-note.tsx';
import { AuthorTag } from './author.tsx';
import { AGENT_MESSAGE_KIND, REPLY_STATUS_TEXT, parseAgentMessage, type ParsedAgentMessage } from './agent-message-card.ts';

/** 会话通信 P1e：agent 间消息在时间线里画成卡片（谁发的、类型、回复状态、正文），正文仍是不可信数据。 */
/**
 * agent 明确用提问工具问的那一句。只认工具名和输入里的字段，不从回复语气、
 * 也不从后面某条用户消息反推答案——后者可能只是另一件事。
 */
const QUESTION_TOOL = /(?:^|[^a-z])(ask_?user(?:_?question)?|ask_?human|ask_?followup_?question|request_?user_?input|input_?required)(?:$|[^a-z])/i;

export function questionOf(block: Extract<Block, { kind: 'tool' }>): { text: string; options: readonly string[] } | null {
  if (!QUESTION_TOOL.test(block.name.trim())) return null;
  try {
    const value: unknown = JSON.parse(block.input);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
    const record = value as Record<string, unknown>;
    const first = Array.isArray(record.questions) && typeof record.questions[0] === 'object' && record.questions[0] !== null
      ? (record.questions[0] as Record<string, unknown>)
      : record;
    const text =
      (typeof first.question === 'string' && first.question.trim() !== '' ? first.question : null) ??
      (typeof first.prompt === 'string' && first.prompt.trim() !== '' ? first.prompt : null) ??
      (typeof first.message === 'string' && first.message.trim() !== '' ? first.message : null);
    if (text === null) return null;
    const options = (Array.isArray(first.options) ? first.options : [])
      .map((option) =>
        typeof option === 'string'
          ? option
          : typeof option === 'object' && option !== null && typeof (option as Record<string, unknown>).label === 'string'
            ? ((option as Record<string, unknown>).label as string)
            : null
      )
      .filter((option): option is string => option !== null && option.trim() !== '');
    return { text, options };
  } catch {
    // 输入解析不了就不当提问卡：尤其不能把原始工具参数当成给人看的问题。
    return null;
  }
}

/** 提问卡：证明 agent 真的问了什么；回答仍走正常输入框，不自动选中任何选项。 */
function AgentQuestion({ block }: { block: Extract<Block, { kind: 'tool' }> }) {
  const question = questionOf(block);
  if (question === null) return null;
  return (
    <div role="group" aria-label="Agent 提问" className="flex flex-col gap-1.5 border-l-2 border-link bg-link/5 px-3 py-2 text-meta text-primary" data-testid="agent-question">
      <p className="font-medium text-link">Agent 提问</p>
      <p className="whitespace-pre-wrap text-secondary">{question.text}</p>
      {question.options.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="问题里的选项（仅供参考）">
          {question.options.map((option) => (
            <li key={option} className="rounded-sm border border-hair px-2 py-1 text-tertiary">{option}</li>
          ))}
        </ul>
      ) : null}
      <p data-testid="agent-question-note" className="text-tertiary">这是当时的提问</p>
    </div>
  );
}

function AgentMessageCard({ message }: { message: ParsedAgentMessage }) {
  const tone = message.failure || message.status === 'failed' || message.status === 'refused' ? 'border-rust/50' : 'border-hair';
  return (
    <div data-testid="agent-message-card" data-kind={message.kind} className={`w-full max-w-[85%] min-w-0 rounded-[var(--radius-overlay)] rounded-br-sm border ${tone} bg-card-raised px-3 py-2`}>
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-meta">
        <span className="shrink-0 rounded bg-card px-1 text-[10px] text-secondary">{AGENT_MESSAGE_KIND[message.kind]}</span>
        <span className="min-w-0 truncate text-primary" title={message.fromSession}>{message.from}</span>
        {message.onBehalfOf ? <span className="shrink-0 text-tertiary">代 {message.onBehalfOf}</span> : null}
        {message.kind === 'reply' ? (
          <span data-testid="agent-message-card-status" className={`ml-auto shrink-0 ${message.failure || message.status !== 'ok' ? 'text-rust' : 'text-sage'}`}>
            {message.failure ? `失败（${message.failure}）` : (REPLY_STATUS_TEXT[message.status ?? 'ok'] ?? message.status)}
          </span>
        ) : null}
      </p>
      <p className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words text-chat text-primary">{message.body}</p>
    </div>
  );
}
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { api, attachmentUrl } from '../shell/api.ts';
import { useAccount } from '../shell/auth.tsx';
import {
  applyContrast,
  DEFAULT_DISPLAY,
  displayKey,
  parseDisplay,
  toolOpenByDefault,
  type ContrastDisplay,
  type DisplaySettings,
  type ThinkingDisplay,
  type ToolDisplay
} from './display-settings.ts';
import type { Block } from './live.ts';
import type { HandoffDto } from './live-core.ts';
import { formatRoute, parseRoute } from '../shell/route.ts';
import { LogMarkdown } from './log-markdown.tsx';
import { clipLines, parseUnifiedDiff, toolFamily, toolFileTarget, toolSummary, toolView, type DiffLine, type ToolView } from './tool-format.ts';
import { analyzeDiff, sliceTokens, type DiffTokenSlice, type WordSegment } from './diff-words.ts';
import { diffStat, runLength, startsRun, toolHeadline, toolRowKind, toolRowLine, toolRowTitle, toolRunChip, type ToolRowKind, type ToolRowProbe } from './tool-rows.ts';
import { durationText, summaryCounts, type WorkSummary } from './timeline-groups.ts';
import { languageOf } from './files-core.ts';
import { Icon } from './icons.tsx';
import { currentTheme } from '../shell/theme.ts';
import { ThemeSwitch } from '../shell/theme-switch.tsx';
import { subagentStepCount } from './live.ts';
import { useFileLinks } from './file-links.tsx';
import { coarsePointer, reducedMotion } from '../shell/device.ts';
import { FOLLOW_SLACK, RISE_EASING, RISE_MS, THINKING_MAX, edgeMask, hiddenBelow, riseFrom, transformOffset } from './thinking-window.ts';

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
  // 对比度手开关落在 <html data-contrast> 上：跟随系统时把属性删掉，
  // 让 styles.css 的 @media (prefers-contrast: more) 继续生效。
  useEffect(() => {
    const root = document.documentElement;
    if (applyContrast(settings) === 'more') root.dataset.contrast = 'more';
    else delete root.dataset.contrast;
  }, [settings]);
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
  triggerRef,
  testId,
  menuClassName = '',
  children
}: {
  label: string;
  icon: ReactNode;
  width?: string;
  /** 外面要收回焦点时（例如关掉选项打开的弹窗后）能找到这个「⋯」按钮。 */
  triggerRef?: Ref<HTMLButtonElement>;
  testId?: string;
  menuClassName?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useDismiss(open, () => setOpen(false));
  return (
    <div ref={root} className="relative" onKeyDown={(event) => {
      if (!open) return;
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); root.current?.querySelector('button')?.focus(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
      const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])].filter((item) => item.getClientRects().length > 0);
      if (!items.length) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : current < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[index]?.focus();
    }}>
      <button
        ref={triggerRef}
        data-testid={testId}
        className="flex h-[44px] min-w-[44px] items-center justify-center rounded-sm px-1.5 text-meta text-tertiary hover:text-primary md:h-9 md:min-w-9"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {icon}
      </button>
      {open ? (
        <div role="menu" className={`absolute right-0 z-30 mt-1 ${width} rounded-lg border border-strong bg-overlay py-1 shadow-overlay ${menuClassName}`}>
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
  danger = false,
  testId,
  className = '',
  onClick
}: {
  title: string;
  hint?: string;
  disabled?: boolean;
  /** 危险操作：标题用 rust，悬停时淡淡染一层，别和普通项长得一样。 */
  danger?: boolean;
  testId?: string;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      data-testid={testId}
      className={`block w-full px-3 py-2.5 text-left text-sub disabled:opacity-40 ${className} ${
        danger ? 'text-rust hover:bg-rust/10 hover:text-rust' : 'text-secondary hover:text-primary'
      }`}
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
  hint,
  value,
  options,
  onChange
}: {
  label: string;
  /** 一句话说明这组开关管什么，跟 Toggle 的 hint 一样放在标签的悬停提示里。 */
  hint?: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center justify-between gap-2 px-3 py-1.5">
      <span className="text-meta text-secondary" title={hint}>
        {label}
      </span>
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
      <span className="text-meta text-secondary" title={hint}>
        {label}
      </span>
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 accent-[var(--color-fg)]" />
    </label>
  );
}

/** 「显示」菜单：对应 OpenCode 的 Show reasoning summaries / Expand shell・edit tool parts / compact。 */
export function DisplaySettingsPanel({ settings, onChange }: { settings: DisplaySettings; onChange: (patch: Partial<DisplaySettings>) => void }) {
  return (
    <div className="py-1" data-testid="display-settings">
      <div className="px-3 py-1.5">
        <ThemeSwitch />
      </div>
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
      <Toggle label="紧凑" hint="收紧行距，一屏多看几条" checked={settings.compact} onChange={(compact) => onChange({ compact })} />
      <Segmented<ContrastDisplay>
        label="增强对比"
        hint="提高次要文字与分隔线的对比度"
        value={settings.contrast}
        options={[
          ['auto', '跟随系统'],
          ['more', '更高']
        ]}
        onChange={(contrast) => onChange({ contrast })}
      />
    </div>
  );
}

export function DisplayMenu({ settings, onChange }: { settings: DisplaySettings; onChange: (patch: Partial<DisplaySettings>) => void }) {
  return (
    <Dropdown label="显示设置" icon={<span aria-hidden>Aa</span>} width="w-72">
      {() => <DisplaySettingsPanel settings={settings} onChange={onChange} />}
    </Dropdown>
  );
}

/** 行内改动默认只露这么多行；更多的点开，或去「改动」页签看。 */
const DIFF_PREVIEW = 12;

interface Tok {
  readonly content: string;
  readonly color?: string | undefined;
}

/** 按需加载 shiki 给改动行上色；语言认不出、行太多就不上色（照旧是纯色 +/−）。 */
function useDiffTokens(lines: readonly DiffLine[], path: string | null): (readonly Tok[])[] | null {
  const [tokens, setTokens] = useState<(readonly Tok[])[] | null>(null);
  const code = lines.filter((line) => line.sign !== '@').map((line) => line.text).join('\n');
  useEffect(() => {
    setTokens(null);
    const lang = path ? languageOf(path) : null;
    if (!lang || code.length > 40_000) return;
    let live = true;
    const theme = currentTheme() === 'light' ? 'github-light' : 'github-dark-dimmed';
    void import('shiki')
      .then(({ codeToTokens }) => codeToTokens(code, { lang: lang as never, theme }))
      .then((result) => live && setTokens(result.tokens.map((row) => row.map((t) => ({ content: t.content, color: t.color })))), () => undefined);
    return () => {
      live = false;
    };
  }, [code, path]);
  return tokens;
}

function DiffView({ lines, path = null }: { lines: readonly DiffLine[]; path?: string | null }) {
  const [all, setAll] = useState(false);
  const links = useFileLinks();
  const tokens = useDiffTokens(lines, path);
  // 词级分段 + 行号只算一次：长 diff 重算一次就是几十万次字符比较。
  // 2000 行以上的兜底在 diff-words.ts 的 pairLines（那里是唯一该管性能的地方）。
  const { rows, gutter } = useMemo(() => analyzeDiff(lines), [lines]);
  const shown = all ? lines : lines.slice(0, DIFF_PREVIEW);
  // tokens 只给非 @@ 行编号，这里把下标对上
  let codeIndex = 0;
  const codeIndexOf = lines.map((line) => (line.sign === '@' ? -1 : codeIndex++));
  return (
    <div className="overflow-hidden rounded-control border border-hair bg-surface-1" data-testid="tool-diff">
      <div className="overflow-x-auto py-1 font-mono text-meta leading-[1.6]">
        {shown.map((line, index) => {
          const row = tokens?.[codeIndexOf[index]!] ?? null;
          const info = rows[index];
          const highlight = info?.highlight ?? null;
          const wordTone = line.sign === '+' ? 'bg-success/25' : 'bg-danger/25';
          return (
            <div
              key={index}
              data-testid="diff-row"
              data-sign={line.sign}
              className={`flex whitespace-pre pr-3 ${line.sign === '+' ? 'bg-diff-add/10' : line.sign === '-' ? 'bg-diff-del/10' : ''}`}
            >
              {/* 行号只给人看：select-none，复制时只拿到正文 */}
              <span
                aria-hidden
                data-testid="diff-line-no"
                data-side="old"
                className={`shrink-0 select-none pl-2 pr-1.5 text-right tabular-nums text-fg-faint ${line.sign === '@' ? '' : 'border-r border-hair/60'}`}
                style={{ minWidth: gutter }}
              >
                {info?.old ?? ''}
              </span>
              <span
                aria-hidden
                data-testid="diff-line-no"
                data-side="new"
                className={`shrink-0 select-none pl-1.5 pr-1.5 text-right tabular-nums text-fg-faint ${line.sign === '@' ? '' : 'border-r border-hair/60'}`}
                style={{ minWidth: gutter }}
              >
                {info?.new ?? ''}
              </span>
              <span
                aria-hidden
                data-testid="diff-mark"
                className={`w-6 shrink-0 select-none text-center ${line.sign === '+' ? 'text-diff-add' : line.sign === '-' ? 'text-diff-del' : 'text-fg-faint'}`}
              >
                {line.sign === '@' ? '⋯' : line.sign === ' ' ? '' : line.sign === '-' ? '−' : '+'}
              </span>
              <span className="sr-only select-none">{line.sign === '@' ? '' : `${line.sign} `}</span>
              {line.sign === '@' ? null : highlight === 'whole' ? (
                <span className={wordTone}>
                  <DiffText tokens={row} segments={null} text={line.text} sign={line.sign} wordTone={wordTone} />
                </span>
              ) : (
                <DiffText tokens={row} segments={typeof highlight === 'object' ? highlight : null} text={line.text} sign={line.sign} wordTone={wordTone} />
              )}
            </div>
          );
        })}
      </div>
      {(lines.length > DIFF_PREVIEW && !all) || links?.openChanges ? (
        <div className="flex items-center gap-3 border-t border-hair px-2.5 py-1 text-meta">
          {lines.length > DIFF_PREVIEW && !all ? (
            <button className="text-tertiary hover:text-primary" onClick={() => setAll(true)}>
              展开全部（还有 {lines.length - DIFF_PREVIEW} 行）
            </button>
          ) : null}
          {links?.openChanges ? (
            <button className="ml-auto flex items-center gap-1 text-tertiary hover:text-primary" data-testid="tool-diff-open" onClick={() => links.openChanges?.(path)}>
              在改动中打开
              <Icon name="external" size={12} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 一行正文：shiki 的 token 负责颜色，词级分段负责「哪几个字变了」。
 * 两套坐标按字符数对齐（sliceTokens），有分段就切在 token 边界上，颜色不错位。
 */
function DiffText({
  tokens,
  segments,
  text,
  sign,
  wordTone
}: {
  tokens: readonly Tok[] | null;
  segments: readonly WordSegment[] | null;
  text: string;
  sign: DiffLine['sign'];
  wordTone: string;
}) {
  if (tokens === null && segments === null) {
    return <span className={sign === '+' ? 'text-diff-add' : sign === '-' ? 'text-diff-del' : 'text-secondary'}>{text}</span>;
  }
  const slices: readonly DiffTokenSlice[] =
    segments === null
      ? (tokens ?? []).map((tok) => ({ content: tok.content, ...(tok.color === undefined ? {} : { color: tok.color }), changed: false }))
      : tokens === null
        ? segments.map((segment) => ({ content: segment.text, changed: segment.changed }))
        : sliceTokens(tokens, segments);
  // 外层这一个 span 把整行正文包成「一个」flex 项：否则每个词/配色片段都是独立 flex item，
  // 浏览器复制选区时会在它们之间塞空格（复制出来变成 `const b = 4 ;`）。
  return (
    <span>
      {slices.map((slice, k) =>
        slice.changed ? (
          <span key={k} data-testid="diff-word" className={`rounded-[2px] ${wordTone}`}>
            {slice.content}
          </span>
        ) : (
          <span key={k} style={slice.color === undefined ? undefined : { color: slice.color }}>
            {slice.content}
          </span>
        )
      )}
    </span>
  );
}

function OutputView({ text, failed }: { text: string; failed: boolean }) {
  const [all, setAll] = useState(false);
  // 解析一次就够：每渲染一次都重解析会让 DiffView 的 useMemo 白算
  const diff = useMemo(() => parseUnifiedDiff(text), [text]);
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

/** 从同层的一个元素读出「这是什么工具、成没成」。不是工具行就返回 null（它同样会打断一组）。 */
function probeOf(node: Element | null): ToolRowProbe | null {
  if (node === null || !(node instanceof HTMLElement)) return null;
  const kind = node.dataset['toolKind'];
  if (kind === undefined) return null;
  const ok = node.dataset['toolOk'];
  return { kind: kind as ToolRowProbe['kind'], ok: ok === 'true' ? true : ok === 'false' ? false : null };
}

/** 同层后面每一行的探针；读到第一行不是工具的为止（生成器，`runLength` 自己会停）。 */
function* followingProbes(el: Element): Generator<ToolRowProbe | null> {
  for (let node = el.nextElementSibling; node !== null; node = node.nextElementSibling) yield probeOf(node);
}

/** 展开后看的参数本体。只有一行，所以永远挂着（不懒挂）：折叠时也得能读到「跑了什么」。 */
function ToolInput({ view, input }: { view: ToolView; input: string }) {
  return view.kind === 'shell' ? (
    <pre className="overflow-x-auto whitespace-pre-wrap rounded-sm bg-card-raised px-2 py-1.5 font-mono text-meta text-primary" data-testid="tool-input">
      <span className="select-none text-tertiary">$ </span>
      {view.command}
    </pre>
  ) : view.kind === 'edit' ? (
    <>
      <p className="min-w-0 font-mono text-meta text-tertiary">
        <PathText path={view.path} input={input} />
      </p>
      <DiffView lines={view.diff} path={view.path} />
    </>
  ) : view.kind === 'read' ? (
    <p className="min-w-0 font-mono text-meta text-tertiary" data-testid="tool-input">
      <PathText path={view.path} input={input} />
      {view.detail ? ` · ${view.detail}` : ''}
    </p>
  ) : view.kind === 'search' ? (
    <p className="min-w-0 font-mono text-meta text-tertiary" data-testid="tool-input">
      <span className="text-tertiary">⌕ </span>
      {view.query}
      {view.path ? ` · ${view.path}` : ''}
    </p>
  ) : view.kind === 'fetch' ? (
    <p className="min-w-0 break-all font-mono text-meta text-tertiary" data-testid="tool-input">
      {view.url}
    </p>
  ) : view.kind === 'worktree' ? (
    <p className="min-w-0 font-mono text-meta text-tertiary" data-testid="tool-input">
      {view.path}
      {view.branch ? ` · ${view.branch}` : ''}
    </p>
  ) : view.kind === 'subagent' ? (
    <p className="min-w-0 text-meta text-secondary" data-testid="tool-input">
      <span className="text-tertiary">◈ </span>
      {view.agent ?? '子代理'}
      {view.description ? ` · ${view.description}` : ''}
    </p>
  ) : view.kind === 'plan' ? (
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-meta text-tertiary" data-testid="tool-input">
      {view.text}
    </pre>
  ) : view.kind === 'file' ? (
    <p className="min-w-0 font-mono text-meta text-tertiary" data-testid="tool-input">
      <PathText path={view.path} input={input} />
      {view.detail ? ` · ${view.detail}` : ''}
    </p>
  ) : (
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-meta text-tertiary" data-testid="tool-input">
      {view.text}
    </pre>
  );
}

/**
 * 组头的「×N」。同一类多出一行时才出现，所以要有进出场：从 0fr 撑到 1fr 让它在行尾让出位置，
 * 里层同时从模糊+微缩淡入，看起来像「长出来」而不是突然插一个方块。
 * 只用 Tailwind 的 transition（不外挂 keyframes），reduce 时直接跳过。
 */
function RunChip({ kind, count }: { kind: ToolRowKind; count: number }) {
  const chip = toolRunChip(kind, count);
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    if (chip === '') return;
    const id = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(id);
    // 只在「有没有 chip」这件事翻转时重放，数字变化（×2→×3）就让它原地改字。
  }, [chip === '']);
  if (chip === '') return null;
  return (
    <span
      aria-label={chip}
      data-testid="tool-run"
      className="grid shrink-0 text-meta tabular-nums text-tertiary transition-[grid-template-columns] duration-[480ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
      style={{ gridTemplateColumns: grown ? '1fr' : '0fr' }}
    >
      <span className="min-w-0 overflow-hidden">
        <span
          className={`inline-block whitespace-nowrap rounded-sm border border-hair px-1 transition duration-[480ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
            grown ? 'scale-100 opacity-100 blur-none' : 'scale-[0.985] opacity-0 blur-[2px]'
          }`}
        >
          ×{count}
        </span>
      </span>
    </span>
  );
}

/**
 * 一次工具调用 = 一行（13px/16px）。展开才挂输出：输出可能几百行，行本身只占一行。
 *
 * 「同类聚合」不改数据结构，只看同层相邻的行：这一行前面是不是同类且没失败（决定它是不是一组的开头），
 * 往后数到第一行不是同类为止（决定组头写 ×几）。时间线里每一块都是同一层的兄弟节点，
 * 所以读取 `previousElementSibling` / `nextElementSibling` 就够了；万一结构变了（比如以后按轮包一层），
 * 相邻关系断掉，最坏也只是退回「每行一条」，不会画错。
 *
 * 没用 `content-visibility: auto`：折叠的 `<details>` 本来就不渲染内容，真正的开销已经被挡住了；
 * 而自动跳过屏幕外的行会让里面的元素量出零尺寸，e2e 里「参数可见」的断言会随机挂。
 */
function ToolRow({ block, settings, recovered = false, stale = false, searchOpen = false }: { block: Extract<Block, { kind: 'tool' }>; settings: DisplaySettings; recovered?: boolean; stale?: boolean; searchOpen?: boolean }) {
  const view = toolView(block.name, block.input);
  const family = toolFamily(block.name, view);
  const kind = toolRowKind(block.name, view);
  const ok = block.result === null ? null : block.result.ok;
  const line = toolRowLine(view, block.input);
  const probe: ToolRowProbe = { kind, ok };
  const ref = useRef<HTMLDetailsElement | null>(null);
  const probeRef = useRef(probe);
  probeRef.current = probe;
  const [run, setRun] = useState<{ first: boolean; count: number }>({ first: true, count: 1 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () => {
      const self = probeRef.current;
      const first = startsRun(probeOf(el.previousElementSibling), self);
      return { first, count: first ? runLength(self, followingProbes(el)) : 1 };
    };
    const apply = () => {
      const next = measure();
      setRun((current) => (current.first === next.first && current.count === next.count ? current : next));
    };
    // 先量一次（挂载时可能夹在已有的一组中间），流式追加的行再靠观察者补上 ×N。
    apply();
    const parent = el.parentElement;
    if (parent === null) return;
    // 只盯直接子节点的增删：行内文字变化（比如 chip 从 ×1 变 ×3）不会反过来触发它。
    const observer = new MutationObserver(apply);
    observer.observe(parent, { childList: true });
    return () => observer.disconnect();
  }, [kind, ok]);

  // 「显示设置」给默认值，用户点过就以用户为准（流式刷新不该把他刚展开的那一行又关回去）。
  const defaultOpen = toolOpenByDefault(settings, family);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const ordinaryOpen = userOpen ?? defaultOpen;
  const open = searchOpen || ordinaryOpen;
  const [mounted, setMounted] = useState(ordinaryOpen);
  useEffect(() => {
    if (ordinaryOpen) setMounted(true);
  }, [ordinaryOpen]);

  const failed = ok === false;
  // 失败分级：之后同类又成功了 = 可恢复（警告色）；否则是真失败（危险色）
  const failTone = failed ? (recovered ? 'text-warning' : 'text-danger') : '';
  const mark = ok === null ? '⋯' : ok ? '✓' : '✗';
  const head = toolHeadline(block.name, view);
  const stat = view.kind === 'edit' ? diffStat(view.diff) : null;
  const spent = block.result === null ? (stale ? '状态未确认' : '运行中') : block.result.durationMs > 0 ? `${block.result.durationMs}ms` : '';
  const output = block.result?.output;
  // 有东西可展开才画那个尖角：单行 bash 还在跑的时候就没什么可看的。
  const expandable = block.result !== null || view.kind !== 'shell';
  const chip = toolRunChip(kind, run.count);
  return (
    <details
      ref={ref}
      className={`group/tool min-w-0 border-l border-hair pl-3 ${run.first ? '' : '-mt-2'}`}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (!searchOpen && next !== open) setUserOpen(next);
      }}
      data-testid="tool-card"
      data-tool-kind={kind}
      data-tool-ok={ok === null ? 'running' : String(ok)}
      data-tool-run={run.first ? (run.count > 1 ? 'start' : 'single') : 'cont'}
      data-tool-count={run.count > 1 ? run.count : undefined}
    >
      <summary
        className="flex min-w-0 cursor-pointer list-none items-center gap-2 py-0.5 text-[13px] leading-4 text-secondary"
        title={toolRowTitle(block.name, line)}
      >
        <span
          aria-hidden
          className={`w-2.5 shrink-0 text-tertiary motion-reduce:transition-none ${
            expandable ? 'transition-transform group-open/tool:rotate-90' : 'opacity-0'
          }`}
        >
          ›
        </span>
        <span aria-hidden className={`shrink-0 text-meta ${failed ? failTone : ok === null && !stale ? 'text-live' : 'text-tertiary'}`}>
          {mark}
        </span>
        {run.first || head.target !== '' ? (
          <span
            className={`shrink-0 font-medium ${failed ? failTone : 'text-secondary'}`}
            data-testid="tool-name"
            data-tool-name={block.name}
          >
            {head.verb}
          </span>
        ) : null}
        <span className="min-w-0 truncate font-mono text-sub text-tertiary" data-testid="tool-params">
          {head.target !== '' ? (
            <span className="text-primary/85">{head.target}</span>
          ) : line.pairs.length === 0 ? (
            toolSummary(view)
          ) : (
            line.pairs.map((param, index) => (
              <span key={`${param.key}:${index}`}>
                {index > 0 ? ' ' : null}
                {param.key === '' ? null : <span>{param.key}=</span>}
                <span className="text-secondary">{param.value}</span>
              </span>
            ))
          )}
          {head.target === '' && line.hidden > 0 ? <span className="text-tertiary"> +{line.hidden}</span> : null}
        </span>
        {stat && (stat.added > 0 || stat.removed > 0) ? (
          <span className="shrink-0 font-mono text-meta tabular-nums" data-testid="tool-diffstat">
            <span className="text-diff-add">+{stat.added}</span> <span className="text-diff-del">−{stat.removed}</span>
          </span>
        ) : null}
        {head.source ? (
          <span className="shrink-0 rounded-[4px] border border-hair px-1 text-[11px] leading-4 text-tertiary" data-testid="tool-source">
            {head.source}
          </span>
        ) : null}
        {failed && recovered ? <span className="shrink-0 text-meta text-warning">已重试</span> : null}
        {chip === '' ? null : (
          // 组头从 0fr 撑到 1fr：同一类多出一行时它慢慢露出来，不跳。
          <RunChip kind={kind} count={run.count} />
        )}
        <span className="ml-auto shrink-0 whitespace-nowrap text-meta text-tertiary">{spent}</span>
      </summary>
      <div className="mt-1 min-w-0 space-y-1.5 pb-0.5">
        <ToolInput view={view} input={block.input} />
        {mounted || searchOpen ? (
          output !== undefined && !(view.kind === 'edit' && block.result?.ok) ? (
            <OutputView text={output} failed={failed} />
          ) : output !== undefined ? (
            <p className="text-meta text-tertiary">{output.split('\n')[0]}</p>
          ) : block.result !== null ? (
            <p className="text-meta text-tertiary">（没有输出）</p>
          ) : null
        ) : null}
      </div>
    </details>
  );
}

/** 工具参数里的文件路径：在工作目录内就是按钮，点了跳到「文件」页那个文件（知道行号就到那一行）。 */
function PathText({ path, input }: { path: string; input: string }) {
  const links = useFileLinks();
  const target = links ? toolFileTarget(input, links.root) : null;
  if (!links || !target) return <>{path}</>;
  return (
    <button
      type="button"
      data-testid="tool-path-link"
      data-path={target.path}
      data-line={target.line ?? undefined}
      title={target.line ? `在文件页打开 ${target.path}:${target.line}` : `在文件页打开 ${target.path}`}
      className="min-h-6 break-all text-left text-link underline decoration-dotted underline-offset-2 hover:text-primary"
      onClick={() => links.open(target)}
    >
      {path}
    </button>
  );
}

/**
 * 思考正文：一个固定高度的窗口。
 *
 * 思考比答案长、来得比答案快，于是这一块不跟着内容无限长高——到了 `THINKING_MAX` 就停住，
 * 底下接新行、再滑上去（pin 拿到实际位移，用 WAAPI 滑回来），上下边缘按「还藏着多少」渐隐。
 * 几何算式在 thinking-window.ts，这里只管 DOM。
 *
 * 全是命令式写入（`style.height` / `style.maskImage` / `dataset`），不走 React 状态：
 * 这块每来一段 delta 就要重算一次，进 state 等于每帧重渲一遍 markdown。
 */
function ThinkingWindow({ text }: { text: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    const stream = streamRef.current;
    if (!box || !stream) return;

    // 手机：不做窗口。手指在窄屏上要滚的是整段对话，里面再套一层滚动区会先吃掉一半手势，
    // 也和外层「跟到底」的滚动逻辑互相拉扯。保持现在的整段展开。
    if (coarsePointer()) {
      box.style.maxHeight = 'none';
      box.style.overflowY = 'visible';
      return;
    }

    let layout = -1; // 上一帧的布局高度；-1 = 还没量过（刚挂载 / 刚展开）
    let following = true; // 读者在底部才把新内容顶上来；往上翻过就别抢
    let windowed = false; // 内容是否已经超过窗口、正在用遮罩 + 内部滚动
    let rise: Animation | null = null;

    // 一律用布局高度，不用 scrollHeight：上滑动画把内容 translate 到了底边以下，
    // 浏览器把它算成 overflow，跟着它就会去追自己那一滑。
    const streamHeight = (): number => stream.getBoundingClientRect().height;

    const paintMask = (): void => {
      if (!windowed) return;
      const mask = edgeMask(box.scrollTop, hiddenBelow(streamHeight(), box.clientHeight, box.scrollTop));
      // Safari 还只认前缀版，两个都写。
      box.style.setProperty('mask-image', mask);
      box.style.setProperty('-webkit-mask-image', mask);
    };

    const readScroll = (): void => {
      following = hiddenBelow(streamHeight(), box.clientHeight, box.scrollTop) <= FOLLOW_SLACK;
    };

    /** 滚到底，返回真正滚走的位移（可能小于「该滚的量」——已经在底了就是 0）。 */
    const pin = (): number => {
      const before = box.scrollTop;
      box.scrollTop = Math.max(0, streamHeight() - box.clientHeight);
      return box.scrollTop - before;
    };

    /** 正在飞的那一滑还剩多少位移，接着它起步，快流就是一条连续的滑行。 */
    const inFlight = (): number => (rise ? transformOffset(getComputedStyle(stream).transform) : 0);

    const measure = (): void => {
      if (!boxRef.current || !streamRef.current) return; // 正在卸载
      const height = streamHeight();
      const capped = height > THINKING_MAX + 0.5;

      if (capped !== windowed) {
        windowed = capped;
        box.dataset.windowed = capped ? 'true' : 'false';
        // 还没到窗口高度时不该有内部滚动条，也不该有渐隐；
        // 同样地，不能滚的时候别占一个空的 Tab 站。
        box.style.overflowY = capped ? 'auto' : 'hidden';
        box.tabIndex = capped ? 0 : -1;
        if (!capped) {
          box.style.removeProperty('mask-image');
          box.style.removeProperty('-webkit-mask-image');
        }
      }

      // 首次量到高度（挂载 / 展开）：只记位置，不追。读者该看到的是从头开始的一段，
      // 而不是「一打开就跳到底」。之后才是「长出来的内容接住再回落」。
      const grew = layout > 0.5 && height - layout > 0.5;

      if (windowed && grew && following) {
        const moved = pin();
        if (moved > 0.5 && !reducedMotion()) {
          const from = riseFrom(inFlight(), moved);
          rise?.cancel();
          rise = stream.animate(
            [{ transform: `translateY(${from}px)` }, { transform: 'translateY(0)' }],
            { duration: RISE_MS, easing: RISE_EASING }
          );
        }
      }

      layout = height;
      readScroll();
      paintMask();
    };

    // 读者自己滚：更新「还在跟随吗」，顺手重画遮罩（滚走了就该多一条边上的渐隐）。
    const onScroll = (): void => {
      readScroll();
      paintMask();
    };

    box.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(stream);
    measure();

    return () => {
      box.removeEventListener('scroll', onScroll);
      observer.disconnect();
      rise?.cancel();
    };
  }, []);

  return (
    <div
      ref={boxRef}
      data-testid="thinking-window"
      data-windowed="false"
      tabIndex={-1}
      className="think-window mt-1.5 ml-1 overflow-y-hidden border-l-2 border-hair pl-3 [overflow-anchor:none]"
      style={{ maxHeight: THINKING_MAX }}
    >
      {/* 内层是正文本身：高度由它撑，窗口只负责裁。flow-root 免得首行 margin 折叠出去。 */}
      <div ref={streamRef} data-testid="thinking-stream" className="flow-root whitespace-pre-wrap leading-relaxed text-fg-faint/80">
        {text}
      </div>
    </div>
  );
}

function ThinkingBlock({ text, settings, live }: { text: string; settings: DisplaySettings; live: boolean }) {
  if (settings.thinking === 'hidden') return null;
  return (
    <details className="group/think text-meta" open={settings.thinking === 'shown'} data-testid="thinking">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-tertiary hover:text-secondary">
        <span aria-hidden className="inline-block w-2.5 transition-transform group-open/think:rotate-90 motion-reduce:transition-none">›</span>
        <span className={live ? 'shimmer-text' : ''}>{live ? '正在思考…' : '思考过程'}</span>
      </summary>
      <ThinkingWindow text={text} />
    </details>
  );
}

const rangeText = (ranges: readonly (readonly [number, number])[]) =>
  ranges.map(([a, b]) => (a === b ? `第 ${a} 轮` : `第 ${a}–${b} 轮`)).join('、');

/** 交接提示条（ADR 0029 · D6）：这条是平台写的交接简报，带了多少、省略多少；省略的 agent 可以用 session.read 查。 */
export function HandoffBar({ handoff }: { handoff: HandoffDto }) {
  const route = parseRoute(typeof location === 'undefined' ? '' : location.hash);
  const sourceHref =
    route && route.page === 'project' ? formatRoute({ ...route, view: 'focus', sessionId: handoff.sourceSessionId }) : null;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return (
    <details className="group/handoff w-full text-meta text-tertiary" data-testid="handoff-bar">
      <summary className="flex cursor-pointer select-none list-none items-center gap-2 hover:text-secondary">
        <span aria-hidden className="h-px flex-1 bg-hair" />
        <Icon name="layers" size={12} />
        <span className="min-w-0 truncate">
          交接：带了 {handoff.turns} 轮里的 {handoff.carriedTurns} 轮（{handoff.carried} 条）
          {handoff.omitted > 0 ? `，省略 ${handoff.omitted} 条` : '，没有省略'} · 约 {k(handoff.tokens)} / {k(handoff.budget)} token
        </span>
        <span aria-hidden className="h-px flex-1 bg-hair" />
      </summary>
      <div className="mx-auto mt-1.5 flex max-w-[560px] flex-col gap-1 text-secondary">
        <p>这是自动生成的交接说明，不是原会话全文。</p>
        {handoff.omittedTurns.length > 0 ? <p>整轮省略：{rangeText(handoff.omittedTurns)}。agent 需要时可以用 session.read 查原文。</p> : null}
        {handoff.omitted > 0 && handoff.omittedTurns.length === 0 ? <p>省略的是部分轮次里较旧的条目（多是工具调用）；agent 需要时可以用 session.read 查原文。</p> : null}
        {sourceHref ? (
          <a className="text-link" href={sourceHref} data-testid="handoff-source">
            打开来源会话 →
          </a>
        ) : null}
      </div>
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
  showAuthor = false,
  queued = false,
  recovered = false,
  stale = false,
  searchOpen = false
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
  /** 这条用户消息还在等（排队 / 发送中 / 未送达）：气泡淡一点，位置不变。 */
  queued?: boolean;
  /** 工具失败后同类又成功了（时间线分组算出来的）：画成警告色而不是红色。 */
  recovered?: boolean;
  /** 记录尚未补齐，非终态不能当作实时状态。 */
  stale?: boolean;
  /** 搜索时开放工具输出，退出后恢复用户的展开状态。 */
  searchOpen?: boolean;
}) {
  if (block.kind === 'subagent') {
    const label = block.agent ?? '子代理';
    const status =
      block.status === 'running'
        ? stale ? { text: '状态未确认', className: 'text-tertiary' } : { text: '运行中', className: 'text-live' }
        : block.status === 'failed'
          ? { text: '失败', className: 'text-rust' }
          : block.status === 'cancelled'
            ? { text: '已取消', className: 'text-tertiary' }
            : { text: '完成', className: 'text-sage' };
    const steps = subagentStepCount(block);
    return (
      <details
        className="group rounded-sm border-l-2 border-hair bg-card/40 pl-3"
        open={block.status === 'failed'}
        data-testid="subagent-card"
        data-subagent-id={block.id}
        data-status={block.status}
      >
        <summary className="flex cursor-pointer list-none items-baseline gap-2 py-1 text-meta text-secondary">
          <span className={block.status === 'failed' ? 'text-rust' : (block.status === 'running' && !stale ? 'text-live' : 'text-tertiary')}>◈</span>
          <span className="shrink-0 font-mono text-sage">{label}</span>
          {block.title ? <span className="min-w-0 truncate text-secondary">{block.title}</span> : null}
          <span className={`ml-auto shrink-0 ${status.className}`}>{status.text}</span>
          <span className="shrink-0 text-tertiary">{steps > 0 ? `${steps} 步` : stale && block.status === 'running' ? '暂无输出' : '等待输出'}</span>
        </summary>
        <div className="mt-1 space-y-2 border-l border-hair pl-3">
          {block.children.length === 0 ? (
            <p className="text-meta text-tertiary">子代理还没有输出。</p>
          ) : (
            block.children.map((child, index) => (
              <ChatBlock
                key={`${child.seq}-${index}`}
                block={child}
                sessionId={sessionId}
                agentLabel={agentLabel}
                settings={settings}
                last={block.status === 'running' && index === block.children.length - 1}
                running={block.status === 'running'}
                stale={stale}
              />
            ))
          )}
        </div>
      </details>
    );
  }
  if (block.kind === 'prompt') {
    const images = block.attachments.filter((item) => item.kind === 'image');
    const others = block.attachments.filter((item) => item.kind !== 'image');
    return (
      <div className="flex flex-col items-end gap-1.5" data-testid="msg-user">
        {block.handoff ? <HandoffBar handoff={block.handoff} /> : null}
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
        {block.text !== '' && block.author?.via === 'agent' && parseAgentMessage(block.text) ? (
          <AgentMessageCard message={parseAgentMessage(block.text)!} />
        ) : block.text !== '' ? (
          <p
            className={`max-w-[85%] whitespace-pre-wrap rounded-[var(--radius-overlay)] rounded-br-sm bg-card-raised px-3 py-2 text-chat text-primary transition-opacity duration-150 ${
              queued ? 'opacity-80' : ''
            }`}
          >
            {block.text}
          </p>
        ) : null}
        <DeliveryNote seq={block.seq} />
      </div>
    );
  }
  if (block.kind === 'approval') return <ApprovalCard block={block} sessionId={sessionId} />;
  if (block.kind === 'unknown') return <UnknownOutcome />;
  if (block.kind === 'error') {
    return (
      <div role="alert" className="flex flex-col gap-1" data-testid="msg-error">
        <SystemDivider tone="danger" icon="alert" text="这一轮失败了" />
        <p className="whitespace-pre-wrap px-1 text-meta text-danger/90">{block.text}</p>
      </div>
    );
  }
  if (block.kind === 'stopped') return <StoppedDivider text={block.text} />;
  if (block.kind === 'compaction') {
    return (
      <div role="status" data-testid="msg-compaction">
        <SystemDivider text={block.text} icon={block.ok ? 'layers' : 'warning'} tone={block.ok ? 'muted' : 'warning'} />
      </div>
    );
  }
  if (block.kind === 'stall') {
    return (
      <p role="status" className="flex items-center gap-1.5 text-meta text-warning">
        <Icon name="warning" size={13} />
        {block.text}
      </p>
    );
  }
  if (block.kind === 'thinking') return <ThinkingBlock text={block.text} settings={settings} live={last && running && !stale} />;
  if (block.kind === 'text') {
    return (
      <div data-testid="msg-assistant">
        <LogMarkdown body={block.text} className="text-chat text-primary/90" />
      </div>
    );
  }
  if (block.kind === 'tool') {
    // 明确提问是会话里必须看见的事实，不跟着「工具显示」一起被藏掉。
    if (questionOf(block) !== null) return <AgentQuestion block={block} />;
    // 隐藏工具仍须提醒失败，但不泄露用户选择隐藏的工具内容。
    if (settings.tools === 'hidden') return block.result?.ok === false
      ? <p role="alert" className="text-meta text-danger" data-testid="hidden-tool-failure">有工具执行失败（工具内容已隐藏）</p>
      : null;
    return <ToolRow block={block} settings={settings} recovered={recovered} stale={stale} searchOpen={searchOpen} />;
  }
  return (
    <p className="flex items-baseline gap-2 text-meta">
      <span className="text-tertiary">◆</span>
      <span className="font-mono text-secondary">{block.path}</span>
      <span className="text-tertiary">{block.bytes > 0 ? `${block.bytes} 字节` : ''}</span>
      <span className="ml-auto text-tertiary">{agentLabel}</span>
    </p>
  );
}

/**
 * 批准卡（ADR 0023）：运行时要做一件需要人点头的事。手机上按钮整行、至少 44px 高，点得准。
 * 倒计时到 0 只收起按钮，显示等待结果；超时本身不是拒绝，等 journal 里的结论。
 */
function ApprovalCard({ block, sessionId }: { block: Extract<Block, { kind: 'approval' }>; sessionId: string }) {
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [submitted, setSubmitted] = useState<'allow' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const left = block.expiresAt === null ? null : Math.max(0, Math.ceil((block.expiresAt - now) / 1000));
  const open = block.resolved === null && submitted === null && (left === null || left > 0);
  useEffect(() => {
    if (!open || block.expiresAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, block.expiresAt]);
  const answer = async (decision: 'allow' | 'deny') => {
    setBusy(decision);
    setError(null);
    try {
      await api.respondApproval(sessionId, block.id, decision);
      // 202 只表示请求已被接单，不是允许/拒绝的结论。先收起按钮，等 journal 的 resolved。
      setSubmitted(decision);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(null);
    }
  };
  const verdict = block.resolved
    ? block.resolved.decision === 'allow'
      ? `已允许${block.resolved.author ? `（${block.resolved.author.name}）` : ''}`
      : block.resolved.by === 'timeout'
        ? '超时，已拒绝'
        : block.resolved.by === 'runtime'
          ? '运行时已不再等待'
          : `已拒绝${block.resolved.author ? `（${block.resolved.author.name}）` : ''}`
    : submitted !== null
      ? null
      : open
        ? null
        : '倒计时已结束，等待结果确认';
  return (
    <div role="group" aria-label="需要你批准" className="flex flex-col gap-2 rounded-sm border-l-2 border-ochre bg-ochre/10 px-3 py-2 text-meta text-primary" data-testid="msg-approval" data-state={block.resolved?.decision ?? (submitted !== null ? 'submitted' : open ? 'open' : 'expired')}>
      <p className="font-medium text-ochre">需要你批准</p>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-secondary">{block.title || '（运行时没说要做什么）'}</pre>
      {block.detail ? <p className="whitespace-pre-wrap text-secondary">{block.detail}</p> : null}
      {open ? (
        <>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button type="button" className="min-h-[44px] w-full rounded-sm border border-rule bg-card-raised px-3 font-medium hover:bg-card disabled:opacity-50 sm:w-auto" disabled={busy !== null} onClick={() => void answer('allow')} data-testid="approval-allow">
              {busy === 'allow' ? '发送中…' : '允许（仅这一次）'}
            </button>
            <button type="button" className="min-h-[44px] w-full rounded-sm border border-rust px-3 text-rust hover:bg-rust/10 disabled:opacity-50 sm:w-auto" disabled={busy !== null} onClick={() => void answer('deny')} data-testid="approval-deny">
              {busy === 'deny' ? '发送中…' : '拒绝'}
            </button>
          </div>
          {left !== null ? <p className="text-tertiary" data-testid="approval-countdown">{left} 秒内不回答就当拒绝</p> : null}
        </>
      ) : submitted !== null && block.resolved === null ? (
        <p className="text-secondary" data-testid="approval-submitted" role="status">已提交，等待结果确认</p>
      ) : verdict !== null ? (
        <p className="text-secondary" data-testid="approval-verdict">{verdict}</p>
      ) : null}
      {error ? <p role="alert" className="text-rust">{error}</p> : null}
    </div>
  );
}

/**
 * 结果待确认：运行时中断，但没有任何证据说这轮成功或失败。
 * 不提供一键重发，也不在浏览器里假装修好——先去对工作目录和会话记录；
 * 真要继续时，输入框仍然可以发一条明确的新消息。
 */
function UnknownOutcome() {
  return (
    <div role="status" className="flex flex-col gap-2 rounded-sm border-l-2 border-ochre bg-ochre/10 px-3 py-2 text-meta text-primary" data-testid="msg-unknown">
      <p className="font-medium text-ochre">这一轮结果待确认</p>
      <p className="text-secondary">
        运行时中途中断，没留下明确结论，可能已经改过文件。
      </p>
      <p className="text-tertiary" data-testid="unknown-guidance">
        先核对工作目录和会话记录，再决定下一步。这里不会自动重发，也不会把后面某句话当成这轮的答案；需要继续时，在输入框发一条新消息。
      </p>
    </div>
  );
}

/** 时间线里的系统分隔线（参照 t3code TimelineSystemDivider）：打断 / 失败 / 交接都用它。 */
export function SystemDivider({
  text,
  tone = 'muted',
  icon,
  compact = false,
  testId
}: {
  text: ReactNode;
  tone?: 'muted' | 'warning' | 'danger';
  icon?: 'stop' | 'alert' | 'warning' | 'layers';
  compact?: boolean;
  testId?: string;
}) {
  const color = tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-tertiary';
  return (
    <div data-testid={testId} className={`flex items-center gap-2 text-meta ${color} ${compact ? '' : 'my-1'}`}>
      <span aria-hidden className="h-px flex-1 bg-hair" />
      <span className="flex shrink-0 items-center gap-1.5">
        {icon ? <Icon name={icon} size={12} /> : null}
        {text}
      </span>
      <span aria-hidden className="h-px flex-1 bg-hair" />
    </div>
  );
}

/** 这一轮在这里停下了。画布卡片也用它。 */
export function StoppedDivider({ text, compact = false }: { text: string; compact?: boolean }) {
  return (
    <div role="status" data-testid="turn-stopped" className={`flex items-center gap-2 text-meta text-tertiary ${compact ? '' : 'my-1'}`}>
      <span aria-hidden className="h-px flex-1 bg-hair" />
      <span className="flex shrink-0 items-center gap-1.5">
        <Icon name="stop" size={12} />
        {text}
      </span>
      <span aria-hidden className="h-px flex-1 bg-hair" />
    </div>
  );
}

/** 一个摘要控制本段活动；正文始终显示，活动项留在原来的顺序。 */
export function WorkGroup({
  summary,
  defaultOpen,
  live,
  stale = false,
  forceOpen,
  children
}: {
  summary: WorkSummary;
  defaultOpen: boolean;
  live: boolean;
  stale?: boolean;
  forceOpen: boolean;
  children: (open: boolean, mounted: boolean) => ReactNode;
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [visited, setVisited] = useState(defaultOpen);
  const open = forceOpen || (userOpen ?? defaultOpen);
  const counts = summaryCounts(summary);
  const spent = durationText(summary.durationMs);
  return (
    <div
      className="min-w-0"
      data-testid="work-group"
      data-live={live && !stale ? 'true' : undefined}
    >
      <button type="button" data-testid="work-group-toggle" aria-expanded={open} disabled={forceOpen} title={forceOpen ? '搜索时展开工作过程' : undefined} onClick={() => { setVisited(true); setUserOpen(!open); }} className="flex min-h-[44px] w-full min-w-0 cursor-pointer items-center gap-2 text-left text-meta text-tertiary hover:text-secondary focus-visible:outline-2 focus-visible:outline-ring">
        <span aria-hidden className={`inline-block w-2.5 transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}>›</span>
        <Icon name="wrench" size={13} className={live && !stale ? 'text-live' : ''} />
        <span className="shrink-0 text-secondary">工作过程</span>
        <span className="shrink-0 tabular-nums">{summary.steps + summary.thinking} 项</span>
        {counts ? <span className="min-w-0 truncate">· {counts}</span> : null}
        {summary.failed > 0 ? (
          <span className="flex shrink-0 items-center gap-1 text-danger">
            · <Icon name="alert" size={12} /> {summary.failed} 处失败
          </span>
        ) : summary.recovered > 0 ? (
          <span className="flex shrink-0 items-center gap-1 text-warning">
            · <Icon name="warning" size={12} /> {summary.recovered} 处重试
          </span>
        ) : null}
        {spent ? <span className="ml-auto shrink-0 tabular-nums">{spent}</span> : null}
      </button>
      <div className="flex min-w-0 flex-col gap-2">{children(open, visited || forceOpen)}</div>
    </div>
  );
}
