import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import type { AttachmentInputDto, CapabilityDto, SessionDto } from '../shell/api.ts';
import { api } from '../shell/api.ts';
import { checkAdd, filterCommands, formatBytes, mentionDraft, toInput, triggerAt, type Draft, type SlashCommand } from './attachments.ts';
import { readDraft } from './commands.ts';
import { growField } from './composer-grow.ts';
import { OptionControls, OptionFeedbackNotice } from './options.tsx';
import { useSessionOptions } from './session-options.tsx';
import { coarsePointer } from '../shell/device.ts';
import { useOfflineNotice } from '../shell/workers.tsx';
import { ActionDot, OfflineNotice } from './composer-parts.tsx';
import { Icon } from './icons.tsx';
import { composerKeyAction, currentPlatform, sendKeyHint } from './composer-keys.ts';

/** 输入框长到 200px 就停住、自己滚：再高就开始吃对话区了，窄屏尤其明显。 */
const AREA_MAX = 200;

interface Props {
  readonly session: SessionDto;
  readonly agentLabel: string;
  readonly draft: string;
  readonly onDraftChange: (text: string) => void;
  /** 返回 false 表示没发出去：输入框和附件都原样留着，别让人重写一遍。 */
  readonly onSend: (text: string, attachments: readonly AttachmentInputDto[]) => Promise<boolean>;
  /**
   * 「发送并新建会话」（⌘/Ctrl+Shift+Enter）：草稿先照常走 onSend 发出去，发成功了才调它。
   * 宿主不传就退回普通发送，并在输入框下面说一句——手势只对硬件键盘有意义，不额外出按钮。
   */
  readonly onSendAndNew?: () => void | Promise<void>;
  readonly onInterrupt: () => void;
  readonly busy: boolean;
  readonly error: string | null;
  /** 「这一轮还在跑」：决定按钮是 ■ 还是 ↑。 */
  readonly awaiting: boolean;
  /** 专注对话里盒子更大、能长高；画布右栏里它受限于 320px 宽。 */
  readonly large?: boolean;
  /** 已授权的专注页可让服务端持久排队，即使 Worker 离线。 */
  readonly allowOfflineSend?: boolean;
  /** agent 自己报上来的可调项（模型、思考强度、模式…），原样渲染。 */
  readonly onChangeOption: (optionId: string, value: string | boolean) => void | Promise<unknown>;
  /** 这个 agent 收不收附件：denied 时按钮灰掉并说原因，limited 时提示怎么降级。 */
  readonly capability: CapabilityDto;
  /** `/` 命令面板里能选的动作。 */
  readonly commands: readonly SlashCommand[];
  /** `@` 选择器去哪个项目里找文件。 */
  readonly projectId: string;
  /**
   * 从 diff 里「引用到对话」：宿主已经算好了新草稿（原有文字一个字没动），
   * 这里负责写回输入框、收起还开着的 `@` 菜单、光标落到末尾。nonce 变了才做一次。
   */
  readonly quote?: { readonly text: string; readonly nonce: number } | null;
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
  onSendAndNew,
  onInterrupt,
  busy,
  error,
  awaiting,
  large = false,
  allowOfflineSend = false,
  onChangeOption,
  capability,
  commands,
  projectId,
  quote
}: Props) {
  // 模型清单要补上 hub 提供商的模型（`session.optionSpec` 里只有 agent 原生模型）。
  const sessionOptions = useSessionOptions(session.optionSpec, projectId, session.workerId, session.agentId);
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

  /**
   * 让输入框跟着内容长高，到 200px 就自己滚。
   *
   * 走的是直接写 `style.height`，不是受控 value：React Flow 节点里受控 textarea 会丢字
   * （见上面 `area` 的注释），高度也只能绕开 React 自己量。
   * 先把高度置成 `auto` 再读 `scrollHeight`：盒子停在旧高度时，它自己的 padding 盒会被算成
   * overflow，读出来的永远是「比原来还高」，于是只长不缩。
   */
  function fitArea(): void {
    const element = area.current;
    if (!element) return;
    const floor = large ? 52 : 44; // 和 min-h-[52px] / min-h-[44px] 同一条线
    element.style.height = 'auto';
    const { height, overflowY } = growField({ scrollHeight: element.scrollHeight, floor, max: AREA_MAX });
    element.style.height = `${height}px`;
    element.style.overflowY = overflowY;
  }

  // 初次挂载、换草稿（发送后清空、恢复失败的文字）、`large` 变了：都重新量一次。
  useLayoutEffect(() => {
    fitArea();
  }, [draft, large]);

  // 变窄会让同样的字多折一行：宽度变了也要重量（分栏拖动、转屏）。
  useEffect(() => {
    const onResize = () => fitArea();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [large]);

  useEffect(() => {
    const element = area.current;
    if (element && draft === '' && element.value !== '') {
      element.value = '';
      setFilled(false);
      fitArea();
    }
  }, [draft]);

  // 换了会话，没发出去的附件不该跟过去。
  useEffect(() => {
    setItems([]);
    setNotice(null);
  }, [session.id]);

  // diff 里引用了段代码：草稿由宿主拼好（保住原有文字、末尾补空格），这里把它推回不受控的输入框。
  // 顺带把 `@` 菜单收掉——引用里本来就带 `@`，菜单再浮着会让人以为还要挑文件。
  // 记下已经落过的那次 nonce：换会话重挂载时不能把上一条会话的引用又写一遍。
  const appliedQuote = useRef(quote?.nonce ?? null);
  const quoteNonce = quote?.nonce ?? null;
  const quoted = quote?.text;
  useEffect(() => {
    const element = area.current;
    if (!element || quoted === undefined || quoteNonce === null || appliedQuote.current === quoteNonce) return;
    appliedQuote.current = quoteNonce;
    element.value = quoted;
    element.selectionStart = element.selectionEnd = quoted.length;
    setFilled(quoted.trim() !== '');
    setTrigger(null);
    fitArea();
    element.focus();
  }, [quoteNonce, quoted]);

  // `@` 选择器：每次查询变了就去问服务端；慢的旧回答不能盖掉新的。
  const mentionQuery = trigger?.kind === '@' ? trigger.query : null;
  useEffect(() => {
    if (mentionQuery === null) return;
    let stale = false;
    const timer = setTimeout(() => {
      api
        .projectFiles(projectId, mentionQuery, session.id)
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
  const offline = useOfflineNotice(session.workerId);
  const canSend = (filled || items.length > 0) && !busy && (allowOfflineSend || offline === null);

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
    fitArea();
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
    if (command.insert !== undefined) {
      replaceTrigger(command.insert);
      area.current?.focus();
      return;
    }
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
    await dispatch(onSend);
  }

  /**
   * 先发、再新建：发送走的是同一条 onSend（排队、回执、失败把文字还回来都不绕开），
   * 只有真的发出去了才请宿主去派生新会话。失败就留在原地，草稿不丢。
   */
  async function sendAndNew(): Promise<void> {
    const sent = await dispatch(onSend);
    if (!sent) return;
    if (onSendAndNew === undefined) {
      // 没有这个能力的会话（比如还没接上的旧入口）：照常发送，但明说一句，别让人以为新建了
      setNotice('这条会话不支持「发送后新建」，已经照常发送');
      return;
    }
    try {
      await onSendAndNew();
    } catch (failure) {
      setNotice((failure as Error).message);
    }
  }

  /** 发出去的那一下：清空输入框与附件；没发出去就原样还回去。 */
  async function dispatch(action: (text: string, attachments: readonly AttachmentInputDto[]) => Promise<boolean>): Promise<boolean> {
    const element = area.current;
    const value = element?.value.trim() ?? '';
    if ((value === '' && items.length === 0) || busy || (!allowOfflineSend && offline !== null)) return false;
    if (element) element.value = '';
    onDraftChange('');
    setFilled(false);
    setTrigger(null);
    const sent = await action(value, items.map(toInput));
    if (sent) {
      setItems([]);
      setNotice(null);
    } else if (element && element.value === '') {
      element.value = value;
      setFilled(value !== '');
      onDraftChange(value);
      fitArea();
    }
    return sent;
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
      <OfflineNotice text={allowOfflineSend ? null : offline} />
      <OptionFeedbackNotice sessionId={session.id} options={session.optionSpec} savedModel={session.model} />
      {options.length > 0 ? (
        <ul
          role="listbox"
          aria-label={trigger?.kind === '/' ? '命令' : '项目文件'}
          className="absolute bottom-full left-0 z-20 mb-1 max-h-60 w-full overflow-y-auto rounded-lg border border-strong bg-overlay py-1 shadow-overlay"
        >
          <li role="presentation" className="px-3 pt-1 pb-1 text-[11px] text-tertiary">{trigger?.kind === '/' ? '命令' : '文件'}</li>
          {options.map((option, index) => (
            <li key={option.key} role="option" aria-selected={index === active} className="px-1">
              <button
                type="button"
                className={`flex min-h-11 w-full items-center gap-2 rounded-control px-2 py-2.5 text-left text-sub md:min-h-0 md:py-1.5 ${
                  index === active ? 'bg-selected text-primary' : 'text-secondary hover:bg-hover'
                }`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={option.pick}
              >
                <Icon name={trigger?.kind === '/' ? 'command' : 'file'} size={13} className="text-tertiary" />
                <span className={`font-mono ${trigger?.kind === '/' ? 'shrink-0' : 'truncate'}`}>{option.label}</span>
                {option.hint ? (
                  <span className="ml-auto min-w-0 truncate text-right text-meta text-tertiary">{option.hint}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div
        className={`rounded-overlay border bg-surface-2 py-2 transition-[border-color] duration-[var(--dur-fast)] focus-within:border-fg/30 ${large ? 'px-3 shadow-composer' : 'px-2.5'} ${
          dragging ? 'border-ring' : 'border-strong'
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
                  className="grid size-7 shrink-0 place-items-center rounded-sm text-tertiary hover:bg-card hover:text-primary md:size-5"
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
          aria-keyshortcuts={
            onSendAndNew === undefined
              ? 'Meta+Enter Control+Enter'
              : 'Meta+Enter Control+Enter Meta+Shift+Enter Control+Shift+Enter'
          }
          className={`w-full resize-none overflow-y-hidden bg-transparent text-primary outline-none placeholder:text-tertiary ${large ? 'text-chat' : 'text-body'} ${
            large ? 'min-h-[52px]' : 'min-h-[44px]'
          }`}
          placeholder={coarsePointer() ? '接着说…（@ 引用文件，/ 命令）' : `接着说…（@ 引用文件，/ 命令，${sendKeyHint(currentPlatform())}）`}
          ref={area}
          defaultValue={draft}
          onChange={(event) => {
            setFilled(event.target.value.trim() !== '');
            onDraftChange(event.target.value);
            refreshTrigger();
            fitArea();
          }}
          onClick={refreshTrigger}
          onBlur={() => setTrigger(null)}
          onPaste={onPaste}
          onKeyDown={(event) => {
            const action = composerKeyAction(event);
            // 发送并新建排在命令面板前面：这是明确要发消息的手势，不该被弹出列表吃掉
            if (action === 'send-and-new') {
              event.preventDefault();
              void sendAndNew();
              return;
            }
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
            if (action === 'send') {
              event.preventDefault();
              void send();
            }
          }}
        />
        {notice ? <p className="mt-1 text-meta text-rust">{notice}</p> : null}
        <div data-testid="composer-controls" className="mt-1 flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <button
              type="button"
              aria-label="添加附件"
              title={attachTitle}
              disabled={denied}
              className="grid h-[44px] w-[44px] shrink-0 place-items-center rounded-sm text-sub text-tertiary hover:bg-card-raised hover:text-primary disabled:opacity-30 md:h-7 md:w-7"
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
                className="hidden size-10 shrink-0 place-items-center rounded-sm text-sub text-tertiary hover:bg-card-raised hover:text-primary disabled:opacity-30 sm:grid md:size-7"
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
            <OptionControls
              session={session}
              projectId={projectId}
              sessionId={session.id}
              agentLabel={agentLabel}
              options={sessionOptions.options}
              values={session.options}
              onChange={onChangeOption}
              compact
              mobileLayout
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
