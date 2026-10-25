import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type CanvasDto, type TaskDto, type WorkLogEntryDto } from './api.ts';
import { NEXT_STATUS, TASK_STATUS_LABEL, TASK_STATUS_TONE } from './task-status.ts';

/** handoff 模板：与 domain 的 HANDOFF_TEMPLATE 同文（web 不依赖 domain，抄一份）。 */
const HANDOFF_TEMPLATE = '## 已完成\n- \n\n## 进行中\n- \n\n## 下一步\n- \n\n## 风险/待决\n- \n\n## 关键文件\n- ';

const KIND_LABEL: Record<WorkLogEntryDto['kind'], string> = {
  note: '笔记',
  progress: '进展',
  decision: '决定',
  blocker: '阻塞',
  handoff: '交接',
  status_change: '状态',
  session_event: '会话'
};
const WRITABLE: readonly WorkLogEntryDto['kind'][] = ['note', 'progress', 'decision', 'blocker', 'handoff'];

function authorLabel(entry: WorkLogEntryDto): string {
  const author = entry.author;
  if (author.kind === 'user') return author.name ?? '人';
  if (author.kind === 'agent') return `${author.agentId}${author.model ? ` · ${author.model}` : ''}`;
  return '系统';
}

function when(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function TaskBadge({ status }: { status: TaskDto['status'] }) {
  return (
    <span data-testid="task-status" className={`rounded-sm border px-1.5 py-px text-meta ${TASK_STATUS_TONE[status]}`}>
      {TASK_STATUS_LABEL[status]}
    </span>
  );
}

/**
 * 任务详情抽屉：状态 + 当前进展 + 工作日志时间线 + 写日志。
 * 宽屏贴右（440px），窄屏撑满——手机上就是一个整页。
 */
export function TaskDetail({
  canvas,
  taskId,
  onClose,
  onOpenSession
}: {
  canvas: CanvasDto;
  taskId: string;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const client = useQueryClient();
  const task = canvas.tasks.find((t) => t.id === taskId);
  const sessions = canvas.sessions.filter((s) => s.taskId === taskId);
  const [kind, setKind] = useState<WorkLogEntryDto['kind']>('note');
  const [body, setBody] = useState('');
  const composer = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const log = useInfiniteQuery({
    queryKey: ['task-log', taskId, task?.logSeq],
    queryFn: ({ pageParam }) => api.taskLog(taskId, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => page.nextBeforeSeq ?? undefined
  });

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['canvas'] });
    void client.invalidateQueries({ queryKey: ['task-log', taskId] });
  };
  const append = useMutation({
    mutationFn: () => api.appendTaskLog(taskId, { kind, body }),
    onSuccess: () => {
      setBody('');
      setKind('note');
      refresh();
    }
  });
  const status = useMutation({
    mutationFn: (next: TaskDto['status']) => api.setTaskStatus(taskId, next),
    onSuccess: refresh
  });

  if (!task) return null;
  const entries = log.data?.pages.flatMap((page) => page.entries) ?? [];

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-canvas/60" onClick={onClose}>
      <aside
        role="dialog"
        aria-label={`任务：${task.title}`}
        data-testid="task-detail"
        className="flex h-full w-full flex-col border-l border-strong bg-panel sm:max-w-[440px]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="border-b border-hair px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-head text-primary">{task.title}</h2>
            <button className="text-sub text-tertiary hover:text-primary" onClick={onClose} aria-label="关闭">
              ✕
            </button>
          </div>
          {task.goal ? <p className="mt-1 text-sub text-secondary">{task.goal}</p> : null}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <TaskBadge status={task.status} />
            {NEXT_STATUS[task.status].map((action) => (
              <button
                key={action.next}
                disabled={status.isPending}
                className="rounded-sm border border-hair px-1.5 py-px text-meta text-tertiary hover:border-accent hover:text-accent"
                onClick={() => status.mutate(action.next)}
              >
                {action.label}
              </button>
            ))}
            <button
              type="button"
              className="rounded-sm border border-accent-dim px-1.5 py-px text-meta text-accent hover:border-accent"
              onClick={() => {
                setKind('handoff');
                if (!body.trim()) setBody(HANDOFF_TEMPLATE);
                requestAnimationFrame(() => composer.current?.focus());
              }}
            >
              写交接
            </button>
            {task.branch ? <span className="font-mono text-meta text-tertiary">⎇ {task.branch}</span> : null}
          </div>
          <p className="mt-2 text-sub text-secondary" data-testid="task-summary">
            <span className="text-tertiary">当前进展：</span>
            {task.summary ?? '还没有交接记录'}
          </p>
          {sessions.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  className="rounded-sm border border-hair px-1.5 py-px font-mono text-meta text-tertiary hover:border-accent hover:text-accent"
                  onClick={() => onOpenSession(session.id)}
                >
                  {session.agentId} · {session.id.slice(0, 6)}
                </button>
              ))}
            </div>
          ) : null}
        </header>

        <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3" data-testid="work-log">
          {entries.length === 0 && !log.isLoading ? <li className="text-meta text-tertiary">还没有日志。</li> : null}
          {entries.map((entry) => (
            <li key={entry.id} className={`rounded-sm border px-2.5 py-2 ${entry.kind === 'handoff' ? 'border-accent-dim bg-card-raised' : 'border-hair bg-card'}`}>
              <div className="mb-1 flex items-center gap-1.5 text-meta text-tertiary">
                <span className={entry.kind === 'blocker' ? 'text-rust' : entry.kind === 'handoff' ? 'text-accent' : 'text-secondary'}>
                  {KIND_LABEL[entry.kind]}
                </span>
                <span>·</span>
                <span className="truncate">{authorLabel(entry)}</span>
                <span className="ml-auto shrink-0 font-mono">#{entry.seq} · {when(entry.createdAt)}</span>
              </div>
              <p className="whitespace-pre-wrap break-words text-sub text-primary">{entry.body}</p>
            </li>
          ))}
          {log.hasNextPage ? (
            <li>
              <button className="text-meta text-tertiary hover:text-accent" onClick={() => void log.fetchNextPage()}>
                更早的日志…
              </button>
            </li>
          ) : null}
        </ol>

        <form
          className="border-t border-hair px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (body.trim()) append.mutate();
          }}
        >
          <div className="mb-1.5 flex flex-wrap gap-1">
            {WRITABLE.map((option) => (
              <button
                type="button"
                key={option}
                aria-pressed={kind === option}
                className={`rounded-sm border px-1.5 py-px text-meta ${kind === option ? 'border-accent text-accent' : 'border-hair text-tertiary'}`}
                onClick={() => {
                  setKind(option);
                  if (option === 'handoff' && !body.trim()) setBody(HANDOFF_TEMPLATE);
                }}
              >
                {KIND_LABEL[option]}
              </button>
            ))}
          </div>
          <textarea
            ref={composer}
            aria-label="写日志"
            className="h-24 w-full resize-none rounded-sm border border-hair bg-card px-2.5 py-2 text-sub text-primary outline-none placeholder:text-tertiary focus:border-accent"
            placeholder="记一笔：做了什么、决定了什么、卡在哪里"
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-meta text-rust">{append.error ? (append.error as Error).message : ''}</span>
            <button
              type="submit"
              disabled={!body.trim() || append.isPending}
              className="rounded-sm bg-accent px-3 py-1.5 text-sub text-canvas hover:brightness-110 disabled:opacity-40"
            >
              记录
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}
