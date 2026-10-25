import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { SessionDto, TaskDto } from './api.ts';
import type { LiveSession } from './live.ts';

export type TaskNode = Node<
  {
    task: TaskDto;
    sessionCount: number;
    onStatus: (status: TaskDto['status']) => void;
    /** 开一条新会话（领域里叫派生：会话是从任务派生出来的）。 */
    onDerive: () => void;
  },
  'task'
>;
export type SessionNode = Node<
  { session: SessionDto; live: LiveSession | undefined; agentLabel: string; onOpen: () => void },
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
  const { session, live, agentLabel, onOpen } = data;
  const status = live?.status ?? session.status;
  const failed = status === 'failed' || status === 'interrupted';
  const failureReason = failed ? (live?.reason ?? null) : null;
  const blocks = live?.blocks ?? [];
  const dimmed = status === 'stopped';

  return (
    <div
      className={`group w-[320px] rounded-md border bg-card px-3 py-3 transition-colors ${
        selected ? 'border-accent' : 'border-hair'
      } ${dimmed ? 'opacity-70' : ''}`}
    >
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-strong" />
      <header className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2 overflow-hidden">
          <span className="text-head text-primary">{agentLabel}</span>
          <span className="truncate font-mono text-meta text-tertiary">
            {session.model === '' ? '默认模型' : session.model}
          </span>
        </div>
        <span className="flex shrink-0 items-center gap-1.5">
          <button
            className="nodrag rounded-sm border border-hair px-1.5 py-0.5 text-meta text-tertiary opacity-0 transition-opacity hover:border-accent hover:text-accent group-hover:opacity-100 focus:opacity-100"
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

      <div className="max-h-[320px] space-y-1.5 overflow-y-auto pr-1">
        {failureReason ? (
          <p className="border-l border-rust pl-2 text-meta text-rust">{failureReason}</p>
        ) : null}
        {blocks.length === 0 ? (
          <p className="text-meta text-tertiary">尚无输出</p>
        ) : (
          blocks.map((block, index) => <BlockView key={index} block={block} />)
        )}
      </div>

      <footer className="mt-2 flex items-center justify-between border-t border-hair pt-1.5 text-meta text-tertiary">
        <span className="font-mono">#{live?.lastSeq ?? session.lastSeq}</span>
        <span>{session.origin.kind === 'fork' ? `分叉自 #${session.origin.atSeq}` : '从任务派生'}</span>
      </footer>

      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-strong" />
    </div>
  );
}

export function TaskCard({ data }: NodeProps<TaskNode>) {
  const { task, sessionCount, onStatus, onDerive } = data;
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
      className={`group w-[220px] rounded-md border bg-panel px-3 py-2 hover:border-accent ${
        muted ? 'opacity-60' : ''
      }`}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-meta text-tertiary">任务</span>
        <span className="text-meta text-secondary">{TASK_STATUS_LABEL[task.status]}</span>
      </div>
      <p className={`text-body ${muted ? 'text-tertiary line-through' : 'text-primary'}`}>{task.title}</p>
      {task.goal ? <p className="mt-1 line-clamp-2 text-meta text-tertiary">{task.goal}</p> : null}
      <p className="mt-1.5 font-mono text-meta text-tertiary">
        {sessionCount} 个会话
        {sessionCount === 0 ? <span className="ml-1 text-tertiary/70">· 双击开一条</span> : null}
      </p>
      <div className="nodrag mt-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
