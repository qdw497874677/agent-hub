import { useEffect, useRef } from 'react';
import { ChatBlock } from './chat-blocks.tsx';
import type { DisplaySettings } from './display-settings.ts';
import type { Block } from './live-core.ts';
import { useStickToBottom } from './use-stick-to-bottom.ts';
import { DialogShell } from '../shell/dialog-shell.tsx';
import {
  SUBAGENT_STATUS_CLASS,
  resolveSubagentPath,
  subagentEntries,
  subagentStatusLabel,
  subagentStepsLabel,
  type SubagentBlock
} from './subagent-track.ts';

/**
 * 单个子代理的只读实时时间线：数据就是父对话里那份 block 树，不另开接口。
 * 面板只是「把这一层 children 换个地方摊开看」，所以父会话来了新事件，
 * 这里下一帧就多一行；滚动用 useStickToBottom，贴底时自动跟、往上翻就不抢。
 *
 * 嵌套子代理不铺成第二张折叠卡：面板里再嵌卡中卡，点进去还得再找按钮。
 * 这里一行一个，点一下进下一层，`←` 逐层返回。
 */
export function SubagentPanel({
  blocks,
  path,
  sessionId,
  agentLabel,
  settings,
  onNavigate
}: {
  readonly blocks: readonly Block[];
  /** 返回栈：最后一个是当前看的子代理。空数组由调用方处理成「关闭」。 */
  readonly path: readonly string[];
  readonly sessionId: string;
  readonly agentLabel: string;
  readonly settings: DisplaySettings;
  /** 上一层 / 下一层都走这里：push 进栈，pop 出栈。 */
  readonly onNavigate: (path: readonly string[]) => void;
}) {
  const chain = resolveSubagentPath(blocks, path);
  const current = chain[chain.length - 1] ?? null;
  const { ref: scroller } = useStickToBottom<HTMLDivElement>(current?.id ?? '');
  const back = useRef<HTMLButtonElement | null>(null);
  // 进面板、再进一层，都把焦点放在「返回」上：读屏先听到这是哪一层，
  // 键盘用户按一次就能退回去，不会落在背后页面的某个按钮上。
  useEffect(() => {
    back.current?.focus();
  }, [current?.id]);
  if (current === null) return null;

  const entry = subagentEntries([current])[0];
  const parent = chain[chain.length - 2] ?? null;
  const backLabel = parent === null ? '会话' : subagentEntries([parent])[0]?.title ?? '上一层';
  const steps = entry?.steps ?? 0;

  return (
    <DialogShell title={entry?.title ?? '子代理'} onClose={() => onNavigate([])} testId="subagent-panel" wide>
      <header className="shrink-0 border-b border-hair px-4 pb-2 pt-2 pr-12">
        <button
          ref={back}
          type="button"
          data-testid="subagent-panel-back"
          className="flex min-h-9 max-w-full items-center gap-1 text-meta text-tertiary hover:text-primary"
          onClick={() => onNavigate(path.slice(0, -1))}
        >
          <span aria-hidden>←</span>
          <span className="min-w-0 truncate">{backLabel}</span>
        </button>
        <h2 className="mt-1 min-w-0 truncate text-body text-primary">{entry?.title ?? '子代理'}</h2>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-meta">
          {entry?.agent !== null && entry?.agent !== undefined && entry.agent !== entry.title ? (
            <>
              <span className="truncate font-mono text-sage">{entry.agent}</span>
              <span aria-hidden className="text-tertiary">
                ·
              </span>
            </>
          ) : null}
          <span className={SUBAGENT_STATUS_CLASS[current.status]}>{subagentStatusLabel(current.status)}</span>
          <span aria-hidden className="text-tertiary">
            ·
          </span>
          <span className="text-tertiary">{subagentStepsLabel(steps)}</span>
        </p>
      </header>
      <div
        ref={scroller}
        tabIndex={0}
        data-testid="subagent-panel-timeline"
        role="log"
        aria-label={`${entry?.title ?? '子代理'} 的记录`}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        {current.children.length === 0 ? (
          <p className="py-6 text-center text-meta text-tertiary">子代理还没有输出。</p>
        ) : (
          <div className="flex flex-col gap-3">
            {current.children.map((child, index) =>
              child.kind === 'subagent' ? (
                <NestedSubagentRow
                  key={child.id}
                  block={child}
                  onEnter={() => onNavigate([...path, child.id])}
                />
              ) : (
                <ChatBlock
                  key={`${child.seq}-${index}`}
                  block={child}
                  sessionId={sessionId}
                  agentLabel={agentLabel}
                  settings={settings}
                  last={current.status === 'running' && index === current.children.length - 1}
                  running={current.status === 'running'}
                />
              )
            )}
          </div>
        )}
      </div>
    </DialogShell>
  );
}

function NestedSubagentRow({ block, onEnter }: { readonly block: SubagentBlock; readonly onEnter: () => void }) {
  const entry = subagentEntries([block])[0];
  return (
    <button
      type="button"
      data-testid="subagent-panel-enter"
      data-subagent-id={block.id}
      data-status={block.status}
      className="flex w-full items-center gap-2 rounded-sm border-l-2 border-hair bg-card/40 py-1.5 pl-3 pr-2 text-left transition-colors hover:bg-card-raised"
      onClick={onEnter}
    >
      <span aria-hidden className={block.status === 'failed' ? 'text-rust' : block.status === 'running' ? 'text-accent' : 'text-tertiary'}>
        ◈
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="min-w-0 truncate font-mono text-meta text-sage">{entry?.title ?? '子代理'}</span>
          {entry !== undefined && entry.agent !== null && entry.agent !== entry.title ? (
            <span className="shrink-0 truncate text-meta text-tertiary">{entry.agent}</span>
          ) : null}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-meta">
          <span className={SUBAGENT_STATUS_CLASS[block.status]}>{subagentStatusLabel(block.status)}</span>
          <span aria-hidden className="text-tertiary">
            ·
          </span>
          <span className="text-tertiary">{subagentStepsLabel(entry?.steps ?? 0)}</span>
        </span>
      </span>
      <span aria-hidden className="shrink-0 text-tertiary">
        ›
      </span>
    </button>
  );
}
