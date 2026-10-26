import { useEffect, useRef, useState } from 'react';
import type { SessionDto } from './api.ts';
import { useOfflineNotice } from './workers.tsx';
import { ActionDot, OfflineNotice } from './composer-parts.tsx';

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
  const offline = useOfflineNotice(session.workerId);
  const canSend = filled && !busy && offline === null;

  function send(): void {
    const element = area.current;
    const value = element?.value.trim() ?? '';
    if (value === '' || busy || offline !== null) return;
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
      <OfflineNotice text={offline} compact />
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
