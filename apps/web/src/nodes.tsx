import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { SessionDto, TaskDto } from './api.ts';
import type { LiveSession } from './live.ts';

export type TaskNode = Node<{ task: TaskDto; sessionCount: number }, 'task'>;
export type SessionNode = Node<{ session: SessionDto; live: LiveSession | undefined; agentLabel: string }, 'session'>;

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
  const { session, live, agentLabel } = data;
  const status = live?.status ?? session.status;
  const failed = status === 'failed' || status === 'interrupted';
  const failureReason = failed ? (live?.reason ?? null) : null;
  const blocks = live?.blocks ?? [];
  const dimmed = status === 'stopped';

  return (
    <div
      className={`w-[320px] rounded-md border bg-card px-3 py-3 transition-colors ${
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
        <StatusPill status={status} reason={failureReason} />
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
        <span>{session.origin.kind === 'fork' ? `分叉自 #${session.origin.atSeq}` : '派生'}</span>
      </footer>

      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-strong" />
    </div>
  );
}

export function TaskCard({ data, selected }: NodeProps<TaskNode>) {
  const { task, sessionCount } = data;
  const muted = task.status === 'abandoned';
  return (
    <div
      className={`w-[220px] rounded-md border bg-panel px-3 py-2 ${selected ? 'border-accent' : 'border-strong'} ${
        muted ? 'opacity-60' : ''
      }`}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-meta text-tertiary">任务</span>
        <span className="text-meta text-secondary">{TASK_STATUS_LABEL[task.status]}</span>
      </div>
      <p className={`text-body ${muted ? 'text-tertiary line-through' : 'text-primary'}`}>{task.title}</p>
      {task.goal ? <p className="mt-1 line-clamp-2 text-meta text-tertiary">{task.goal}</p> : null}
      <p className="mt-1.5 font-mono text-meta text-tertiary">{sessionCount} 个会话</p>
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-strong" />
    </div>
  );
}
