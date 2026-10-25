import { useEffect, useRef, useState } from 'react';
import type { CanvasDto, SessionDto } from './api.ts';
import { api } from './api.ts';
import { Composer } from './composer.tsx';
import type { Block, LiveSession } from './live.ts';

interface Props {
  readonly canvas: CanvasDto;
  readonly session: SessionDto;
  readonly live: LiveSession | null;
  readonly draft: string;
  readonly onDraftChange: (text: string) => void;
  readonly onBack: () => void;
  readonly onChanged: () => void;
}

const STATUS_LABEL: Record<SessionDto['status'], string> = {
  running: '运行中',
  done: '完成',
  stopped: '已停止',
  interrupted: '中断',
  failed: '失败'
};

function BlockView({ block, agentLabel }: { block: Block; agentLabel: string }) {
  if (block.kind === 'prompt') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-md rounded-br-sm bg-card-raised px-3 py-2 text-body text-primary">
          {block.text}
        </p>
      </div>
    );
  }
  if (block.kind === 'text') {
    return <p className="whitespace-pre-wrap text-body leading-relaxed text-primary/90">{block.text}</p>;
  }
  if (block.kind === 'tool') {
    const mark = block.result === null ? '⋯' : block.result.ok ? '✓' : '✗';
    const spent = block.result === null ? '' : `${block.result.durationMs}ms`;
    return (
      <details className="group border-l border-hair pl-3">
        <summary className="flex cursor-pointer list-none items-baseline gap-2 text-meta text-secondary">
          <span className="text-tertiary">{mark}</span>
          <span className="font-mono text-sage">{block.name}</span>
          <span className="truncate opacity-60">{block.input.slice(0, 120)}</span>
          <span className="ml-auto shrink-0 text-tertiary">{spent}</span>
        </summary>
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-meta text-tertiary">
          {block.input}
        </pre>
      </details>
    );
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

/**
 * 专注对话：一条会话，整屏看。
 *
 * 画布回答「这些思路之间是什么关系」，这里回答「它到底说了什么」。
 * 两者不能合并——把对话塞进 320px 的右栏，人只能在里面翻跟头。
 */
export function FocusView({ canvas, session, live, draft, onDraftChange, onBack, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tail = useRef<HTMLDivElement | null>(null);
  const agent = canvas.agents.find((candidate) => candidate.id === session.agentId);
  const task = canvas.tasks.find((candidate) => candidate.id === session.taskId);
  const blocks = live?.blocks ?? [];
  const status = live?.status ?? session.status;
  const reason = live?.reason ?? null;

  useEffect(() => {
    tail.current?.scrollIntoView({ block: 'end' });
  }, [blocks.length, session.id]);

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-canvas">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-hair px-3">
        <button className="text-meta text-tertiary hover:text-primary" onClick={onBack}>
          ← 画布
        </button>
        <span className="h-3 w-px bg-hair" />
        <p className="min-w-0 truncate text-body text-primary">{task?.title ?? session.taskId}</p>
        <span className="shrink-0 font-mono text-meta text-tertiary">
          {agent?.label ?? session.agentId} · {session.model === '' ? '默认模型' : session.model}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-3 text-meta text-tertiary">
          {session.origin.kind === 'fork' ? <span>分叉自 #{session.origin.atSeq}</span> : null}
          <span className={status === 'failed' || status === 'interrupted' ? 'text-rust' : ''}>
            {STATUS_LABEL[status]}
          </span>
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div role="log" aria-label="对话记录" className="mx-auto flex max-w-[760px] flex-col gap-4 px-4 py-6">
          {reason ? <p className="border-l border-rust pl-2 text-meta text-rust">{reason}</p> : null}
          {blocks.length === 0 ? (
            <p className="text-meta text-tertiary">
              这条会话还没有说话。在下面写一句，交给 {agent?.label ?? session.agentId}。
            </p>
          ) : (
            blocks.map((block, index) => (
              <BlockView key={index} block={block} agentLabel={agent?.label ?? session.agentId} />
            ))
          )}
          {status === 'running' ? (
            <p className="text-meta text-tertiary" aria-live="polite">
              {agent?.label ?? session.agentId} 正在说…
            </p>
          ) : null}
          <div ref={tail} />
        </div>
      </div>

      <div className="shrink-0 border-t border-hair px-4 py-3">
        <div className="mx-auto max-w-[760px]">
          <Composer
            large
            session={{ ...session, status }}
            agentLabel={agent?.label ?? session.agentId}
            draft={draft}
            onDraftChange={onDraftChange}
            onSend={(text) =>
              void run(async () => {
                await api.prompt(session.id, text);
                onDraftChange('');
              })
            }
            onInterrupt={() => void run(() => api.interrupt(session.id))}
            busy={busy}
            error={error}
          />
        </div>
      </div>
    </div>
  );
}
