import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CanvasDto, SearchHitDto, SessionDto } from './api.ts';
import { api } from './api.ts';
import type { LiveMap } from './live.ts';

const STATUS_LABEL: Record<SessionDto['status'], string> = {
  running: '运行中',
  done: '完成',
  stopped: '已停止',
  interrupted: '中断',
  failed: '失败'
};

function statusOf(session: SessionDto, live: LiveMap): SessionDto['status'] {
  return live[session.id]?.status ?? session.status;
}

/**
 * 列表视图：画布的低成本降级形态（S6.4）。
 *
 * 它不替代画布，只回答画布回答得慢的两个问题：「今天一共几个会话在跑」
 * 和「那条我想不起来的会话叫什么」。这里不做看板——按状态分列会诱导人
 * 用列来管理流程，那是另一套产品的入口。
 */
export function ListView({
  canvas,
  live,
  onOpen,
  onDerive
}: {
  canvas: CanvasDto;
  live: LiveMap;
  onOpen: (sessionId: string) => void;
  onDerive: (taskId: string) => void;
}) {
  const taskTitle = useMemo(
    () => new Map(canvas.tasks.map((task) => [task.id, task.title])),
    [canvas.tasks]
  );

  return (
    <div className="h-full overflow-y-auto px-3 py-4 md:px-6">
      <table className="w-full border-collapse text-body">
        <thead>
          <tr className="border-b border-hair text-left text-meta text-tertiary">
            <th className="py-2 font-normal">任务</th>
            <th className="py-2 font-normal">agent</th>
            <th className="hidden py-2 font-normal md:table-cell">模型</th>
            <th className="hidden py-2 font-normal md:table-cell">来源</th>
            <th className="py-2 font-normal">状态</th>
            <th className="hidden py-2 font-normal md:table-cell">事件</th>
          </tr>
        </thead>
        <tbody>
          {canvas.sessions.length === 0 ? (
            <tr>
              <td className="py-6 text-meta text-tertiary" colSpan={6}>
                还没有会话。点下面的任务（或画布上任务卡的「＋ 会话」）就能派生一条。
              </td>
            </tr>
          ) : null}
          {canvas.sessions.map((session) => {
            const status = statusOf(session, live);
            const seq = live[session.id]?.lastSeq ?? session.lastSeq;
            return (
              <tr
                key={session.id}
                className="cursor-pointer border-b border-hair/60 hover:bg-card"
                onClick={() => onOpen(session.id)}
              >
                <td className="max-w-[140px] truncate py-3 text-primary md:max-w-[280px] md:py-2">{taskTitle.get(session.taskId) ?? '—'}</td>
                <td className="py-2 text-secondary">
                  {canvas.agents.find((agent) => agent.id === session.agentId)?.label ?? session.agentId}
                </td>
                <td className="hidden py-2 font-mono text-meta text-tertiary md:table-cell">{session.model === '' ? '默认模型' : session.model}</td>
                <td className="hidden py-2 font-mono text-meta text-tertiary md:table-cell">
                  {session.origin.kind === 'fork' ? `分叉自 #${session.origin.atSeq}` : '派生'}
                </td>
                <td className="py-2 text-meta">{STATUS_LABEL[status]}</td>
                <td className="hidden py-2 font-mono text-meta text-tertiary md:table-cell">#{seq}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="mt-6 border-t border-hair pt-3">
        <p className="mb-2 text-meta text-tertiary">任务</p>
        <div className="flex flex-wrap gap-2">
          {canvas.tasks.map((task) => (
            <button
              key={task.id}
              className="rounded-sm border border-hair px-2 py-1 text-meta text-secondary hover:border-accent hover:text-accent"
              onClick={() => onDerive(task.id)}
              title="从这个任务派生一条会话"
            >
              {task.title}
              {task.status === 'abandoned' ? '（已放弃）' : ''}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Cmd+K。搜的是任务标题与会话正文，命中会话就直接跳到画布上那个节点——
 * 「搜到了但找不到」比搜不到更让人烦。
 */
export function SearchPalette({
  projectId,
  onJump,
  onClose
}: {
  projectId: string;
  onJump: (hit: SearchHitDto) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const trimmed = query.trim();

  useEffect(() => {
    input.current?.focus();
  }, []);

  const results = useQuery({
    queryKey: ['search', projectId, trimmed],
    queryFn: () => api.search(projectId, trimmed),
    enabled: trimmed.length > 0
  });

  const hits = results.data?.hits ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-canvas/80 px-3 pt-16 md:pt-24" onClick={onClose}>
      <div
        className="w-full max-w-[560px] rounded-md border border-strong bg-panel shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={input}
          className="w-full border-b border-hair bg-transparent px-3 py-2.5 text-body text-primary outline-none placeholder:text-tertiary"
          placeholder="搜任务标题，或者你记得的那句话"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose();
            if (event.key === 'ArrowDown') setCursor((current) => Math.min(current + 1, hits.length - 1));
            if (event.key === 'ArrowUp') setCursor((current) => Math.max(current - 1, 0));
            if (event.key === 'Enter') {
              const hit = hits[cursor];
              if (hit) onJump(hit);
            }
          }}
        />
        <div className="max-h-[320px] overflow-y-auto">
          {trimmed === '' ? (
            <p className="px-3 py-4 text-meta text-tertiary">输入关键词开始搜。回车打开，Esc 关掉。</p>
          ) : hits.length === 0 ? (
            <p className="px-3 py-4 text-meta text-tertiary">{results.isFetching ? '搜索中…' : '没有命中。'}</p>
          ) : (
            hits.map((hit, index) => (
              <button
                key={`${hit.kind}-${hit.sessionId ?? hit.taskId}-${index}`}
                className={`block w-full px-3 py-2 text-left ${index === cursor ? 'bg-card' : ''}`}
                onMouseEnter={() => setCursor(index)}
                onClick={() => onJump(hit)}
              >
                <span className="flex items-baseline gap-2">
                  <span className={`font-mono text-meta ${hit.kind === 'task' ? 'text-secondary' : 'text-sage'}`}>
                    {hit.kind === 'task' ? '任务' : '会话'}
                  </span>
                  <span className="max-w-[380px] truncate text-body text-primary">{hit.title}</span>
                </span>
                {hit.snippet === '' ? null : (
                  <span className="mt-0.5 block max-w-[480px] truncate text-meta text-tertiary">{hit.snippet}</span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
