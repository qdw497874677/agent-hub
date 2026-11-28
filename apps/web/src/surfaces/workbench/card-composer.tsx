import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AttachmentInputDto, SessionDto } from '../../shell/api.ts';
import { useOfflineNotice } from '../../shell/workers.tsx';
import { ActionDot, OfflineNotice } from '../../atoms/composer-parts.tsx';
import { composerKeyAction, currentPlatform, sendKeyHint } from '../../atoms/composer-keys.ts';
import { coarsePointer } from '../../shell/device.ts';
import { useWorkbenchDraft } from '../../atoms/workbench-drafts.tsx';
import { toInput } from '../../atoms/attachments.ts';
import { useAccount } from '../../shell/account-context.ts';

/**
 * 画布卡片里的输入行：不等你进专注对话，就地能说一句。
 *
 * 卡片只有 320px，所以它起步是一行，而不是一个会长高的盒子——画布上要的是「随手补一句」。
 * 按键和专注对话完全一样：⌘/Ctrl+Enter 发送，Enter 换行。同一个会话换个地方说话，按键不该反过来。
 */
export function CardComposer({
  session,
  onDraftChange,

  onSend,
  onSendAndNew,
  onInterrupt,
  busy,
  error,
  awaiting
}: {
  readonly session: SessionDto;
  readonly draft: string;
  readonly onDraftChange: (text: string) => void;
  readonly onSend: (text: string, attachments: readonly AttachmentInputDto[]) => Promise<boolean>;
  /**
   * ⌘/Ctrl+Shift+Enter：这一句照样发，发成功后宿主在同一张画布上再开一张卡。
   * 不传就退回普通发送（和专注对话那边同一条规矩）。
   */
  readonly onSendAndNew?: () => void | Promise<void>;
  readonly onInterrupt: () => void;
  readonly busy: boolean;
  readonly error: string | null;
  readonly awaiting: boolean;
}) {
  // 卡片活在 React Flow 的节点里，而 React Flow 的节点数据是「非紧急」渲染的：
  // 受控 textarea 在快速连打时会被一次落后的渲染写回旧值，实测 "abcdef" 会变成 "aef"。
  // 所以这里的输入框**不受控**——React 永远不写它的 value，只读它。
  // App 里那份 draft 仍然存在，但只服务于「切视图回来草稿还在」（S6.4）。
  const { store, entry } = useWorkbenchDraft(session.id);
  const account = useAccount();
  const originToken = useMemo(() => ({}), [account?.id, store, session.id]);
  const originLife = useRef<object | null>(null);
  const routeVersion = useRef(0);
  useLayoutEffect(() => {
    originLife.current = originToken;
    const onRouteChange = () => { routeVersion.current += 1; };
    window.addEventListener('hashchange', onRouteChange);
    return () => {
      if (originLife.current === originToken) originLife.current = null;
      window.removeEventListener('hashchange', onRouteChange);
    };
  }, [originToken]);
  const area = useRef<HTMLTextAreaElement>(null);
  const [initial] = useState(entry.text);
  const [filled, setFilled] = useState(initial.trim() !== '');
  useEffect(() => {
    // 只有「别处把它清空了」才动 DOM：一旦开始打字，值就该只属于这个输入框。
    const element = area.current;
    if (element && store.getEntry(session.id) === entry && element.value !== entry.text) {
      element.value = entry.text;
      setFilled(entry.text.trim() !== '');
    }
  }, [entry.text, session.id]);

  const running = awaiting;
  const offline = useOfflineNotice(session.workerId);
  const canSend = (filled || entry.items.length > 0) && !busy && !entry.pending && offline === null;

  async function send(derive = false): Promise<void> {
    if (busy || offline !== null) return;
    const originHash = window.location.hash;
    const originRouteVersion = routeVersion.current;
    const claim = store.claim(session.id);
    if (!claim) return;
    if (area.current) area.current.value = '';
    setFilled(false);
    let sent = false;
    try {
      sent = await onSend(claim.text.trim(), claim.items.map(toInput));
    } finally {
      store.finish(claim, sent);
    }
    // Even returning to the same hash must not revive a continuation from an old route.
    if (sent && derive && originLife.current === originToken &&
        routeVersion.current === originRouteVersion && window.location.hash === originHash) {
      await onSendAndNew?.();
    }
  }

  return (
    // nodrag：拖卡片和选文字是两种手势，不隔开的话选中一句话会把节点拖走。
    // nowheel：卡片内容滚动不能变成画布缩放。
    // 输入框里的双击是选词，不该顺带把整张卡切到专注对话
    <div className="nodrag nowheel mt-2" onDoubleClick={(event) => event.stopPropagation()}>
      {entry.recovery.length > 0 ? <p className="mb-1 text-meta text-rust">发送失败的草稿已保留。请先清空当前草稿，<button type="button" className="underline" onClick={() => store.recover(session.id)}>恢复旧草稿</button>（{entry.recovery.length}）</p> : null}
      {error ? <p className="mb-1 truncate text-meta text-rust" title={error}>{error}</p> : null}
      <OfflineNotice text={offline} compact />
      {entry.items.length > 0 ? <p className="mb-1 text-meta text-tertiary">待发送附件：{entry.items.map((item) => <span key={item.id}>{item.kind === 'mention' ? item.path : item.name} <button type="button" className="underline" aria-label={`移除 ${item.kind === 'mention' ? item.path : item.name}`} onClick={() => store.setItems(session.id, (current) => current.filter((other) => other.id !== item.id))}>×</button> </span>)}</p> : null}
      {/* 可调项不放在这里：卡片头部已经有一份，重复一份只会让人兑不明哪个是真的 */}
      <div className="mt-1 flex items-end gap-1.5 rounded-md border border-hair bg-canvas/40 px-2 py-1.5 focus-within:border-strong">
        <textarea
          aria-label={`对 ${session.id.slice(0, 4)} 说一句`}
          aria-keyshortcuts={
            onSendAndNew === undefined
              ? 'Meta+Enter Control+Enter'
              : 'Meta+Enter Control+Enter Meta+Shift+Enter Control+Shift+Enter'
          }
          rows={1}
          className="max-h-24 min-h-[20px] w-full resize-none bg-transparent text-sub text-primary outline-none placeholder:text-tertiary"
          placeholder={running ? '在跑…（■ 停下）' : coarsePointer() ? '说一句…' : `说一句…（${sendKeyHint(currentPlatform())}）`}
          ref={area}
          defaultValue={initial}
          onChange={(event) => {
            setFilled(event.target.value.trim() !== '');
            onDraftChange(event.target.value);
          }}
          onKeyDown={(event) => {
            // 卡片上的双击是「打开专注对话」，在输入框里双击只是选词。
            event.stopPropagation();
            const action = composerKeyAction(event);
            if (action === 'send-and-new') {
              event.preventDefault();
              void send(true);
              return;
            }
            if (action === 'send') {
              event.preventDefault();
              void send();
            }
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        />
        <ActionDot running={running} canSend={canSend} onSend={() => void send()} onInterrupt={onInterrupt} size="sm" />
      </div>
    </div>
  );
}
