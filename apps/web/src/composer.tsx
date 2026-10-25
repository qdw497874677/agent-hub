import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import type { AttachmentInputDto, CapabilityDto, SessionDto } from './api.ts';
import { api } from './api.ts';
import {
  checkAdd,
  filterCommands,
  formatBytes,
  mentionDraft,
  toInput,
  triggerAt,
  type Draft,
  type SlashCommand
} from './attachments.ts';
import { readDraft } from './commands.ts';
import { OptionControls } from './options.tsx';
import { coarsePointer } from './device.ts';

interface Props {
  readonly session: SessionDto;
  readonly agentLabel: string;
  readonly draft: string;
  readonly onDraftChange: (text: string) => void;
  /** 返回 false 表示没发出去：输入框和附件都原样留着，别让人重写一遍。 */
  readonly onSend: (text: string, attachments: readonly AttachmentInputDto[]) => Promise<boolean>;
  readonly onInterrupt: () => void;
  readonly busy: boolean;
  readonly error: string | null;
  /** 「这一轮还在跑」：决定按钮是 ■ 还是 ↑。 */
  readonly awaiting: boolean;
  /** 专注对话里盒子更大、能长高；画布右栏里它受限于 320px 宽。 */
  readonly large?: boolean;
  /** agent 自己报上来的可调项（模型、思考强度、模式…），原样渲染。 */
  readonly onChangeOption: (optionId: string, value: string | boolean) => void;
  /** 这个 agent 收不收附件：denied 时按钮灰掉并说原因，limited 时提示怎么降级。 */
  readonly capability: CapabilityDto;
  /** `/` 命令面板里能选的动作。 */
  readonly commands: readonly SlashCommand[];
  /** `@` 选择器去哪个项目里找文件。 */
  readonly projectId: string;
}

/**
 * 一个圆点，两种身份：能发时是 ↑，在跑时是 ■。
 *
 * 不并排放两个按钮——运行中同时摆着「↑ 发送」和「■ 中断」，人得先读字才知道按哪个；
 * 而这两件事本来就互斥（参考 opencode web 的做法）。
 */
function ActionDot({
  running,
  canSend,
  onSend,
  onInterrupt,
  size
}: {
  running: boolean;
  canSend: boolean;
  onSend: () => void;
  onInterrupt: () => void;
  size: 'sm' | 'md';
}) {
  const box = size === 'sm' ? 'size-6 text-meta' : 'size-9 text-sub md:size-7';
  if (running) {
    return (
      <button
        aria-label="中断"
        className={`grid ${box} shrink-0 place-items-center rounded-full border border-rust text-rust hover:bg-rust/15`}
        title="中断"
        onClick={onInterrupt}
      >
        ■
      </button>
    );
  }
  return (
    <button
      aria-label="发送"
      className={`grid ${box} shrink-0 place-items-center rounded-full bg-accent text-canvas hover:brightness-110 disabled:opacity-30`}
      title="发送（⌘↵）"
      disabled={!canSend}
      onClick={onSend}
    >
      ↑
    </button>
  );
}

/**
 * 输入与发送本来是一件事。
 *
 * 拆成「带边框的 textarea + 下面一排按钮」会让人用眼睛搬一次家，
 * 所以它们装在一个盒子里：写的地方无边框，发的地方是个圆点。
 *
 * 附件参考 opencode web：+ 选文件、粘贴/拖入图片、手机上直接拍照；
 * `@` 从项目里挑文件引用，`/` 调出命令。待发的附件以小卡片排在输入框上方，可逐个移除。
 */
export function Composer({
  session,
  agentLabel,
  draft,
  onDraftChange,
  onSend,
  onInterrupt,
  busy,
  error,
  awaiting,
  large = false,
  onChangeOption,
  capability,
  commands,
  projectId
}: Props) {
  // 输入框不受控，原因见 CardComposer 上的注释：React Flow 节点里受控 textarea 会丢字。
  const area = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [initial] = useState(draft);
  const [filled, setFilled] = useState(initial.trim() !== '');
  const [items, setItems] = useState<readonly Draft[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [trigger, setTrigger] = useState<ReturnType<typeof triggerAt>>(null);
  const [files, setFiles] = useState<readonly string[]>([]);
  const [active, setActive] = useState(0);
  const [dragging, setDragging] = useState(false);
  const denied = capability.state === 'denied';

  useEffect(() => {
    const element = area.current;
    if (element && draft === '' && element.value !== '') {
      element.value = '';
      setFilled(false);
    }
  }, [draft]);

  // 换了会话，没发出去的附件不该跟过去。
  useEffect(() => {
    setItems([]);
    setNotice(null);
  }, [session.id]);

  // `@` 选择器：每次查询变了就去问服务端；慢的旧回答不能盖掉新的。
  const mentionQuery = trigger?.kind === '@' ? trigger.query : null;
  useEffect(() => {
    if (mentionQuery === null) return;
    let stale = false;
    const timer = setTimeout(() => {
      api
        .projectFiles(projectId, mentionQuery)
        .then((result) => {
          if (!stale) setFiles(result.files);
        })
        .catch(() => {
          if (!stale) setFiles([]);
        });
    }, 80);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [mentionQuery, projectId]);

  const options: readonly { key: string; label: string; hint: string; pick: () => void }[] =
    trigger === null
      ? []
      : trigger.kind === '/'
        ? filterCommands(commands, trigger.query).map((command) => ({
            key: command.name,
            label: `/${command.name}`,
            hint: command.hint,
            pick: () => runCommand(command)
          }))
        : denied
          ? []
          : files.map((path) => ({ key: path, label: path, hint: '', pick: () => pickFile(path) }));

  const running = awaiting;
  const canSend = (filled || items.length > 0) && !busy;

  function refreshTrigger(): void {
    const element = area.current;
    if (!element) return;
    const next = triggerAt(element.value, element.selectionStart);
    setTrigger(next);
    setActive(0);
  }

  function replaceTrigger(insert: string): void {
    const element = area.current;
    if (!element || trigger === null) return;
    const caret = element.selectionStart;
    element.value = element.value.slice(0, trigger.start) + insert + element.value.slice(caret);
    element.selectionStart = element.selectionEnd = trigger.start + insert.length;
    setFilled(element.value.trim() !== '');
    onDraftChange(element.value);
    setTrigger(null);
    element.focus();
  }

  function pickFile(path: string): void {
    replaceTrigger('');
    if (items.length >= 8) {
      setNotice('最多 8 个附件');
      return;
    }
    if (!items.some((item) => item.kind === 'mention' && item.path === path)) {
      setItems((current) => [...current, mentionDraft(path)]);
    }
  }

  function runCommand(command: SlashCommand): void {
    replaceTrigger('');
    command.run().then(
      () => setNotice(null),
      (failure: unknown) => setNotice((failure as Error).message)
    );
  }

  async function addFiles(list: readonly File[]): Promise<void> {
    if (list.length === 0) return;
    if (denied) {
      setNotice(capability.reason ?? `${agentLabel} 不接收附件`);
      return;
    }
    let current = items;
    let problem: string | null = null;
    for (const file of list) {
      const kind = file.type.startsWith('image/') ? 'image' : 'file';
      const reason = checkAdd(current, { kind, name: file.name, bytes: file.size });
      if (reason) {
        problem = reason;
        continue;
      }
      current = [...current, await readDraft(file)];
    }
    setItems(current);
    setNotice(problem);
  }

  async function send(): Promise<void> {
    const element = area.current;
    const value = element?.value.trim() ?? '';
    if ((value === '' && items.length === 0) || busy) return;
    if (element) element.value = '';
    setFilled(false);
    setTrigger(null);
    const sent = await onSend(value, items.map(toInput));
    if (sent) {
      setItems([]);
      setNotice(null);
    } else if (element && element.value === '') {
      element.value = value;
      setFilled(value !== '');
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const pasted = [...event.clipboardData.files];
    if (pasted.length === 0) return;
    event.preventDefault();
    void addFiles(pasted);
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragging(false);
    void addFiles([...event.dataTransfer.files]);
  }

  const attachTitle = denied
    ? (capability.reason ?? `${agentLabel} 不接收附件`)
    : capability.state === 'limited' && capability.reason
      ? `添加附件（${capability.reason}）`
      : '添加图片或文件（也可以粘贴、拖进来）';

  return (
    <div className="relative">
      {error ? <p className="mb-1 text-meta text-rust">{error}</p> : null}
      {options.length > 0 ? (
        <ul
          role="listbox"
          aria-label={trigger?.kind === '/' ? '命令' : '项目文件'}
          className="absolute bottom-full left-0 z-20 mb-1 max-h-60 w-full overflow-y-auto rounded-md border border-hair bg-card-raised py-1 shadow-lg"
        >
          {options.map((option, index) => (
            <li key={option.key} role="option" aria-selected={index === active}>
              <button
                type="button"
                className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sub ${
                  index === active ? 'bg-accent/15 text-primary' : 'text-secondary hover:bg-card'
                }`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={option.pick}
              >
                <span className="truncate font-mono">{option.label}</span>
                {option.hint ? <span className="ml-auto shrink-0 text-meta text-tertiary">{option.hint}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div
        className={`rounded-md border bg-card py-2 focus-within:border-strong ${large ? 'px-3' : 'px-2.5'} ${
          dragging ? 'border-accent' : 'border-hair'
        }`}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {items.length > 0 ? (
          <ul aria-label="待发送的附件" className="mb-2 flex flex-wrap gap-1.5">
            {items.map((item) => (
              <li
                key={item.id}
                className="group flex max-w-[220px] items-center gap-1.5 rounded-sm border border-hair bg-canvas/60 py-1 pr-1 pl-1.5 text-meta text-secondary"
              >
                {item.kind === 'image' && item.preview ? (
                  <img src={item.preview} alt="" className="size-8 shrink-0 rounded-sm object-cover" />
                ) : (
                  <span className="shrink-0 font-mono text-tertiary">{item.kind === 'mention' ? '@' : '▤'}</span>
                )}
                <span className="min-w-0 truncate font-mono" title={item.kind === 'mention' ? item.path : item.name}>
                  {item.kind === 'mention' ? item.path : item.name}
                </span>
                {item.kind !== 'mention' ? <span className="shrink-0 text-tertiary">{formatBytes(item.bytes)}</span> : null}
                <button
                  type="button"
                  aria-label={`移除 ${item.kind === 'mention' ? item.path : item.name}`}
                  className="grid size-5 shrink-0 place-items-center rounded-sm text-tertiary hover:bg-card hover:text-primary"
                  onClick={() => setItems((current) => current.filter((other) => other.id !== item.id))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <textarea
          aria-label="发送消息"
          aria-autocomplete="list"
          className={`w-full resize-none bg-transparent text-body text-primary outline-none placeholder:text-tertiary ${
            large ? 'min-h-[52px] max-h-56' : 'min-h-[44px] max-h-40'
          }`}
          placeholder={coarsePointer() ? '接着说…（@ 引用文件，/ 命令）' : '接着说…（@ 引用文件，/ 命令，⌘↵ 发送）'}
          ref={area}
          defaultValue={draft}
          onChange={(event) => {
            setFilled(event.target.value.trim() !== '');
            onDraftChange(event.target.value);
            refreshTrigger();
          }}
          onClick={refreshTrigger}
          onBlur={() => setTrigger(null)}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (options.length > 0) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setActive((index) => (index + step + options.length) % options.length);
                return;
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                options[Math.min(active, options.length - 1)]?.pick();
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setTrigger(null);
                return;
              }
            }
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void send();
            }
          }}
        />
        {notice ? <p className="mt-1 text-meta text-rust">{notice}</p> : null}
        <div className="mt-1 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              aria-label="添加附件"
              title={attachTitle}
              disabled={denied}
              className="grid size-9 md:size-6 shrink-0 place-items-center rounded-sm text-sub text-tertiary hover:bg-card-raised hover:text-primary disabled:opacity-30"
              onClick={() => filePicker.current?.click()}
            >
              +
            </button>
            {coarsePointer() ? (
              <button
                type="button"
                aria-label="拍照"
                title={attachTitle}
                disabled={denied}
                className="grid size-9 md:size-6 shrink-0 place-items-center rounded-sm text-sub text-tertiary hover:bg-card-raised hover:text-primary disabled:opacity-30"
                onClick={() => camera.current?.click()}
              >
                ◉
              </button>
            ) : null}
            <input
              ref={filePicker}
              type="file"
              multiple
              hidden
              data-testid="attach-input"
              onChange={(event) => {
                void addFiles([...(event.target.files ?? [])]);
                event.target.value = '';
              }}
            />
            <input
              ref={camera}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(event) => {
                void addFiles([...(event.target.files ?? [])]);
                event.target.value = '';
              }}
            />
            <span className="shrink-0 text-meta text-tertiary">{agentLabel}</span>
            <OptionControls
              options={session.optionSpec}
              values={session.options}
              onChange={onChangeOption}
              compact
            />
          </div>
          <ActionDot
            running={running}
            canSend={canSend}
            onSend={() => void send()}
            onInterrupt={onInterrupt}
            size={large ? 'md' : 'sm'}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * 画布卡片里的输入行：不等你进专注对话，就地能说一句。
 *
 * 卡片只有 320px，所以它是一行（Enter 发送、Shift+Enter 换行），
 * 而不是一个会长高的盒子——画布上要的是「随手补一句」，不是「坐下来聊半小时」。
 */
export function CardComposer({
  session,
  draft,
  onDraftChange,
  onSend,
  onInterrupt,
  busy,
  error,
  awaiting
}: {
  readonly session: SessionDto;
  readonly draft: string;
  readonly onDraftChange: (text: string) => void;
  readonly onSend: (text: string) => void;
  readonly onInterrupt: () => void;
  readonly busy: boolean;
  readonly error: string | null;
  readonly awaiting: boolean;
}) {
  // 卡片活在 React Flow 的节点里，而 React Flow 的节点数据是「非紧急」渲染的：
  // 受控 textarea 在快速连打时会被一次落后的渲染写回旧值，实测 "abcdef" 会变成 "aef"。
  // 所以这里的输入框**不受控**——React 永远不写它的 value，只读它。
  // App 里那份 draft 仍然存在，但只服务于「切视图回来草稿还在」（S6.4）。
  const area = useRef<HTMLTextAreaElement>(null);
  const [initial] = useState(draft);
  const [filled, setFilled] = useState(initial.trim() !== '');
  useEffect(() => {
    // 只有「别处把它清空了」才动 DOM：一旦开始打字，值就该只属于这个输入框。
    const element = area.current;
    if (element && draft === '' && element.value !== '') {
      element.value = '';
      setFilled(false);
    }
  }, [draft]);

  const running = awaiting;
  const canSend = filled && !busy;

  function send(): void {
    const element = area.current;
    const value = element?.value.trim() ?? '';
    if (value === '' || busy) return;
    if (element) element.value = '';
    setFilled(false);
    onSend(value);
  }

  return (
    // nodrag：拖卡片和选文字是两种手势，不隔开的话选中一句话会把节点拖走。
    // nowheel：卡片内容滚动不能变成画布缩放。
    // 输入框里的双击是选词，不该顺带把整张卡切到专注对话
    <div className="nodrag nowheel mt-2" onDoubleClick={(event) => event.stopPropagation()}>
      {error ? <p className="mb-1 truncate text-meta text-rust" title={error}>{error}</p> : null}
      {/* 可调项不放在这里：卡片头部已经有一份，重复一份只会让人兑不明哪个是真的 */}
      <div className="mt-1 flex items-end gap-1.5 rounded-md border border-hair bg-canvas/40 px-2 py-1.5 focus-within:border-strong">
        <textarea
          aria-label={`对 ${session.id.slice(0, 4)} 说一句`}
          rows={1}
          className="max-h-24 min-h-[20px] w-full resize-none bg-transparent text-sub text-primary outline-none placeholder:text-tertiary"
          placeholder={running ? '在跑…（■ 停下）' : '说一句…（Enter 发送）'}
          ref={area}
          defaultValue={initial}
          onChange={(event) => {
            setFilled(event.target.value.trim() !== '');
            onDraftChange(event.target.value);
          }}
          onKeyDown={(event) => {
            // 卡片上的双击是「打开专注对话」，在输入框里双击只是选词。
            event.stopPropagation();
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        />
        <ActionDot running={running} canSend={canSend} onSend={send} onInterrupt={onInterrupt} size="sm" />
      </div>
    </div>
  );
}
