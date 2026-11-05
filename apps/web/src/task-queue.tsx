import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { connectorApi, type DispatchItemDto } from './api.ts';
import { formatRoute } from './route.ts';
import { relativeTime } from './workers.tsx';

/**
 * 任务队列（ADR 0032 R3）：bot 用 task.create 建的任务在这里排队，调度器按上限开任务智能体会话。
 * 上限：全局 2 + 人工预留 1，每台机器 1、每个项目 1（人在对话里让 bot 建的只受全局 + 人工槽）。
 * 没有任何调度记录时不显示。
 */
const STATE: Record<DispatchItemDto['state'], { label: string; cls: string }> = {
  queued: { label: '排队', cls: 'bg-accent/15 text-accent' },
  running: { label: '运行中', cls: 'bg-sage/20 text-primary' },
  done: { label: '完成', cls: 'bg-sage/25 text-primary' },
  failed: { label: '失败', cls: 'bg-rust/15 text-rust' },
  cancelled: { label: '已取消', cls: 'bg-hair text-tertiary' }
};

function Tag({ state }: { state: DispatchItemDto['state'] }) {
  return <span className={`shrink-0 rounded px-1.5 text-[11px] leading-[18px] ${STATE[state].cls}`}>{STATE[state].label}</span>;
}

const sessionHref = (d: DispatchItemDto) => (d.sessionId ? formatRoute({ page: 'project', projectId: d.projectId, view: 'focus', sessionId: d.sessionId }) : null);

export function TaskQueue() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['dispatch'], queryFn: connectorApi.dispatch, refetchInterval: 8_000 });
  const cancel = useMutation({ mutationFn: (id: string) => connectorApi.cancelDispatch(id), onSuccess: () => client.invalidateQueries({ queryKey: ['dispatch'] }) });
  const data = q.data;
  if (!data || !data.caps || (data.queued.length + data.running.length + data.recent.length + data.pending.length === 0)) return null;
  const caps = data.caps;
  const slots = Array.from({ length: caps.global + caps.humanReserved }, (_, i) => data.running[i] ?? null);
  return (
    <section data-testid="task-queue" className="mb-4">
      <h2 className="mb-2 text-body font-medium text-primary">任务队列</h2>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-hair bg-card p-3">
          <div className="mb-2 text-body font-medium text-primary">并发 {caps.global} + 人工预留 {caps.humanReserved}</div>
          <div className="grid grid-cols-3 gap-1.5" data-testid="dispatch-slots">
            {slots.map((d, i) => (
              d ? (
                <a key={d.id} data-testid="dispatch-running" href={sessionHref(d) ?? undefined} title={d.title}
                  className="truncate rounded bg-sage/20 px-1.5 py-1 text-center text-meta text-primary">{d.title}{d.workerId ? ` · ${d.workerId.slice(0, 8)}` : ''}</a>
              ) : (
                <span key={`free${i}`} className="rounded bg-hair/60 px-1.5 py-1 text-center text-meta text-tertiary">{i >= caps.global ? '人工预留' : '空闲'}</span>
              )
            ))}
          </div>
          <div className="mt-2 text-meta text-tertiary">每台机器 {caps.perWorker} · 每个项目 {caps.perProject}（你在对话里让 bot 建的不受这两条限制）</div>
        </div>
        <div className="rounded-md border border-hair bg-card p-3">
          <div className="mb-1 text-body font-medium text-primary">排队 · {data.queued.length + data.pending.length}</div>
          {data.queued.length + data.pending.length === 0 ? <div className="py-2 text-meta text-tertiary">没有排队的任务</div> : null}
          <ul>
            {data.queued.map((d) => (
              <li key={d.id} data-testid="dispatch-queued" className="flex items-center gap-2 border-b border-hair py-2 last:border-b-0">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-primary">{d.position}. {d.title}</span>
                  <span className="block truncate text-meta text-tertiary">{d.human ? '你让 bot 建的' : '自动'} · {d.waitReason ?? '马上开始'} · {relativeTime(d.createdAt)}</span>
                </span>
                <Tag state="queued" />
                <button data-testid="dispatch-cancel" className="shrink-0 rounded border border-hair px-2 py-0.5 text-meta text-secondary hover:text-primary" disabled={cancel.isPending} onClick={() => cancel.mutate(d.id)}>取消</button>
              </li>
            ))}
            {data.pending.map((p) => (
              <li key={p.id} className="flex items-center gap-2 border-b border-hair py-2 last:border-b-0">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-primary">{p.title}</span>
                  <span className="block truncate text-meta text-tertiary">超额 · 等你在「等我处理」里批准</span>
                </span>
                <span className="shrink-0 rounded bg-strong px-1.5 text-[11px] leading-[18px] text-secondary">待批准</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {data.recent.length ? (
        <div className="mt-3 rounded-md border border-hair bg-card p-3">
          <div className="mb-1 text-body font-medium text-primary">最近完成</div>
          <ul>
            {data.recent.slice(0, 8).map((d) => (
              <li key={d.id} data-testid="dispatch-recent" className="flex items-center gap-2 border-b border-hair py-2 last:border-b-0">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-primary">{d.title}</span>
                  <span className="block truncate text-meta text-tertiary">{(d.result ?? '').split('\n')[0]?.slice(0, 80) || '—'}{d.state !== 'cancelled' ? ` · ${d.notified ? '已通知 bot' : '等 bot 空下来再通知'}` : ''} · {relativeTime(d.updatedAt)}</span>
                </span>
                <Tag state={d.state} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
