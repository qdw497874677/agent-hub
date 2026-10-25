import { Handle, NodeResizer, Position, type NodeProps, type Node } from '@xyflow/react';
import { useState } from 'react';
import type { SessionDto, TaskDto } from './api.ts';
import { CardComposer } from './composer.tsx';
import { OptionControls } from './options.tsx';
import type { LiveSession } from './live.ts';
import { CARD_LIMITS, type CardKind, type Size } from './card-size.ts';

/** 两种卡片共有：拖过的尺寸（没有 = 宽度默认、高度随内容），以及拖完后的回调。 */
type Resizable = {
  size: Size | undefined;
  onResized: (box: Size & { x: number; y: number }) => void;
};

export type TaskNode = Node<
  {
    task: TaskDto;
    sessionCount: number;
    onStatus: (status: TaskDto['status']) => void;
    /** 开一条新会话（领域里叫派生：会话是从任务派生出来的）。 */
    onDerive: () => void;
  } & Resizable,
  'task'
>;
export type SessionNode = Node<
  {
    session: SessionDto;
    live: LiveSession | undefined;
    agentLabel: string;
    onOpen: () => void;
    /** 卡片上就地说话：不必先打开专注对话。 */
    draft: string;
    onDraftChange: (text: string) => void;
    onSend: (text: string) => Promise<void>;
    onInterrupt: () => Promise<void>;
    onChangeOption: (optionId: string, value: string | boolean) => Promise<void>;
  } & Resizable,
  'session'
>;

const STATUS: Record<SessionDto['status'], { label: string; dot: string; shape: string }> = {
  running: { label: '运行中', dot: 'bg-accent', shape: 'rounded-full' },
  done: { label: '完成', dot: 'border border-sage', shape: 'rounded-full' },
  stopped: { label: '已停止', dot: 'border border-tertiary', shape: 'rounded-sm' },
  interrupted: { label: '中断', dot: 'bg-rust', shape: 'rounded-sm' },
  failed: { label: '失败', dot: 'bg-rust', shape: 'rounded-sm' }
};

const TASK_STATUS_LABEL: Record<TaskDto['status'], string> = {
  open: '进行中',
  done: '已收尾',
  abandoned: '已放弃'
};

/**
 * React Flow 自带的缩放把手，只在选中时出现，免得平时挡住卡片上的按钮。
 * 触屏上把手放大到手指点得中（styles.css 的 pointer: coarse 规则）。
 */
function CardResizer({ kind, selected, onResized }: { kind: CardKind; selected: boolean; onResized: Resizable['onResized'] }) {
  const limits = CARD_LIMITS[kind];
  return (
    <NodeResizer
      isVisible={selected}
      minWidth={limits.minWidth}
      minHeight={limits.minHeight}
      maxWidth={limits.maxWidth}
      maxHeight={limits.maxHeight}
      color="var(--color-accent)"
      handleClassName="card-resize-handle"
      onResizeEnd={(_, box) => onResized(box)}
    />
  );
}

function StatusPill({ status, reason }: { status: SessionDto['status']; reason?: string | null }) {
  const style = STATUS[status];
  return (
    <span className="flex items-center gap-1.5 text-meta text-secondary" title={reason ?? style.label}>
      <span className={`block size-[7px] ${style.dot} ${style.shape}`} />
      {style.label}
    </span>
  );
}

function BlockView({ block }: { block: LiveSession['blocks'][number] }) {
  // 卡片只放 agent 说的话。用户自己的提问在专注对话里看，卡片上占地方。
  if (block.kind === 'prompt') return null;
  if (block.kind === 'text') {
    return <p className="whitespace-pre-wrap text-body text-primary/90">{block.text}</p>;
  }
  if (block.kind === 'tool') {
    const mark = block.result === null ? '⋯' : block.result.ok ? '✓' : '✗';
    const spent = block.result === null ? '' : ` · ${block.result.durationMs}ms`;
    return (
      <div className="flex items-baseline gap-2 border-l border-hair pl-2 text-meta text-secondary">
        <span className="text-tertiary">{mark}</span>
        <span className="font-mono text-sage">{block.name}</span>
        <span className="truncate opacity-60">{block.input.slice(0, 80)}</span>
        <span className="text-tertiary">{spent}</span>
      </div>
    );
  }
  return (
    <div className="flex items-baseline gap-2 text-meta">
      <span className="text-accent-dim">◆</span>
      <span className="truncate font-mono text-secondary">{block.path.split('/').pop()}</span>
      <span className="text-tertiary">{block.bytes > 0 ? `${Math.round(block.bytes / 1024)}K` : ''}</span>
    </div>
  );
}

export function SessionCard({ data, selected }: NodeProps<SessionNode>) {
  const { session, live, agentLabel, onOpen, draft, onDraftChange, onSend, onInterrupt, onChangeOption, size, onResized } =
    data;
  // 每张卡自己的发送状态：一张卡在等响应，不该让整块画布跟着变灰。
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const status = live?.status ?? session.status;
  const failed = status === 'failed' || status === 'interrupted';
  const failureReason = failed ? (live?.reason ?? null) : null;
  const blocks = live?.blocks ?? [];
  const dimmed = status === 'stopped';

  return (
    <div
      // 双击整张卡进专注对话。不能只靠 React Flow 的 onNodeDoubleClick：
      // 卡片中段被输入框盖住了，而它会把表单控件上的双击事件当成「用户在编辑」而忽略。
      onDoubleClick={() => onOpen()}
      // 宽高由 React Flow 节点本身决定（node.width/height），卡片只铺满；输出区吃掉剩余高度。
      className={`group flex h-full w-full flex-col rounded-md border bg-card px-3 py-3 transition-colors ${
        selected ? 'border-accent' : 'border-hair'
      } ${dimmed ? 'opacity-70' : ''}`}
    >
      <CardResizer kind="session" selected={selected} onResized={onResized} />
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-strong" />
      <header className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2 overflow-hidden">
          <span className="shrink-0 text-head text-primary">{agentLabel}</span>
          {/* 没有可调项清单（老会话还没人报过）时退回显示模型名 */}
          {session.optionSpec.length === 0 ? (
            <span className="truncate font-mono text-meta text-tertiary">
              {session.model === '' ? '默认模型' : session.model}
            </span>
          ) : null}
        </div>
        <span className="flex shrink-0 items-center gap-1.5">
          <button
            className="nodrag rounded-sm border border-hair px-1.5 py-0.5 text-meta text-tertiary transition-opacity hover:border-accent hover:text-accent focus:opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100"
            title="打开专注对话"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
          >
            对话
          </button>
          <StatusPill status={status} reason={failureReason} />
        </span>
      </header>

      {/* 可调项自己占一行：卡片只有 320px，和 agent 名、状态位挤在一行会把模型名截成三个字 */}
      {session.optionSpec.length === 0 ? null : (
        <div className="nodrag mb-2">
          <OptionControls
            options={session.optionSpec}
            values={session.options}
            onChange={(optionId, value) => void run(() => onChangeOption(optionId, value))}
            compact
          />
        </div>
      )}

      <div className={`min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1 ${size ? '' : 'max-h-[320px]'}`}>
        {failureReason ? (
          <p className="border-l border-rust pl-2 text-meta text-rust">{failureReason}</p>
        ) : null}
        {blocks.length === 0 ? (
          <p className="text-meta text-tertiary">尚无输出</p>
        ) : (
          blocks.map((block, index) => <BlockView key={index} block={block} />)
        )}
      </div>

      <CardComposer
        session={{ ...session, status }}
        awaiting={live?.awaiting ?? false}
        draft={draft}
        onDraftChange={onDraftChange}
        onSend={(text) => void run(() => onSend(text))}
        onInterrupt={() => void run(onInterrupt)}
        busy={busy}
        error={error}
      />

      <footer className="mt-2 flex items-center justify-between border-t border-hair pt-1.5 text-meta text-tertiary">
        <span className="font-mono">#{live?.lastSeq ?? session.lastSeq}</span>
        <span>{session.origin.kind === 'fork' ? `分叉自 #${session.origin.atSeq}` : '从任务派生'}</span>
      </footer>

      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-strong" />
    </div>
  );
}

export function TaskCard({ data, selected }: NodeProps<TaskNode>) {
  const { task, sessionCount, onStatus, onDerive, onResized } = data;
  const muted = task.status === 'abandoned';
  // 「试过是死路」和「还在试」必须能区分（S4.2），所以收尾与放弃是两个动作，重开也留着。
  // 动作挂在 hover 上而不是「选中后显示」：React Flow 的 onClick 里改 state 会让
  // 双击事件被两段渲染切开，任务卡的派生就再也点不出来了。
  const actions: readonly { label: string; next: TaskDto['status'] }[] =
    task.status === 'open'
      ? [
          { label: '收尾', next: 'done' },
          { label: '放弃', next: 'abandoned' }
        ]
      : [{ label: '重开', next: 'open' }];
  return (
    <div
      className={`group h-full w-full overflow-hidden rounded-md border bg-panel px-3 py-2 hover:border-accent ${
        selected ? 'border-accent' : 'border-hair'
      } ${muted ? 'opacity-60' : ''}`}
    >
      <CardResizer kind="task" selected={selected} onResized={onResized} />
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-meta text-tertiary">任务</span>
        <span className="text-meta text-secondary">{TASK_STATUS_LABEL[task.status]}</span>
      </div>
      <p className={`text-body ${muted ? 'text-tertiary line-through' : 'text-primary'}`}>{task.title}</p>
      {task.goal ? <p className="mt-1 line-clamp-2 text-meta text-tertiary">{task.goal}</p> : null}
      <p className="mt-1.5 font-mono text-meta text-tertiary">
        {sessionCount} 个会话
        {sessionCount === 0 ? <span className="ml-1 text-tertiary/70">· 点「＋ 会话」开一条</span> : null}
      </p>
      <div className="nodrag mt-1.5 flex gap-1 transition-opacity focus-within:opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100">
        <button
          className="rounded-sm border border-hair px-1.5 py-0.5 text-meta text-tertiary hover:border-accent hover:text-accent"
          onClick={(event) => {
            event.stopPropagation();
            onDerive();
          }}
        >
          ＋ 会话
        </button>
        {actions.map((action) => (
          <button
            key={action.next}
            className="rounded-sm border border-hair px-1.5 py-0.5 text-meta text-tertiary hover:border-accent hover:text-accent"
            onClick={(event) => {
              event.stopPropagation();
              onStatus(action.next);
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-strong" />
    </div>
  );
}
