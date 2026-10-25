import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type WorkerInfoDto } from './api.ts';

const STATE: Record<WorkerInfoDto['state'], { label: string; dot: string }> = {
  online: { label: '在线', dot: 'bg-sage' },
  offline: { label: '离线', dot: 'bg-rust' }
};

const ORIGIN: Record<WorkerInfoDto['origin'], string> = {
  local: '本机',
  remote: '远程'
};

/**
 * 节点状态（S1.2）：区分「它挂了」和「我改坏了配置」。
 *
 * 这里故意不显示 agent 数量：agent 属于会话卡与检查器，节点只交代「连没连上、
 * 是哪台机器」。两件事混在一处时，一处出错要翻两个地方。
 */
export function WorkersBadge() {
  const [open, setOpen] = useState(false);
  const workers = useQuery({ queryKey: ['workers'], queryFn: api.workers, refetchInterval: 5000 });
  const list = workers.data ?? [];
  const online = list.filter((worker) => worker.state === 'online').length;
  const tone = list.length === 0 ? 'text-tertiary' : online > 0 ? 'text-sage' : 'text-rust';

  return (
    <div className="relative">
      <button
        className="flex items-center gap-1.5 rounded-sm border border-hair px-2.5 py-1 text-meta text-tertiary hover:border-accent hover:text-accent"
        onClick={() => setOpen((current) => !current)}
        title="查看节点在线状态"
      >
        <span className={`block size-[7px] rounded-full ${list.length === 0 ? 'bg-tertiary' : online > 0 ? 'bg-sage' : 'bg-rust'}`} />
        <span className={tone}>
          {list.length === 0 ? '没有节点' : `${online}/${list.length} 节点`}
        </span>
      </button>

      {open ? (
        <div className="absolute right-0 top-9 z-20 w-[min(280px,calc(100vw-1.5rem))] rounded-md border border-strong bg-panel p-2 shadow-lg">
          {list.length === 0 ? (
            <p className="text-meta text-tertiary">
              还没有节点连上。worker 起来后会自己报到——如果你刚启动，等几秒。
            </p>
          ) : (
            list.map((worker) => (
              <div key={worker.workerId} className="flex items-start justify-between gap-2 py-1">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-body text-primary">
                    <span className={`block size-[7px] rounded-full ${STATE[worker.state].dot}`} />
                    {worker.label}
                    <span className="text-meta text-tertiary">{ORIGIN[worker.origin]}</span>
                  </p>
                  <p className="truncate font-mono text-meta text-tertiary">{worker.workerId}</p>
                </div>
                <span className="shrink-0 text-meta text-secondary" title={worker.reason ?? undefined}>
                  {worker.reason ? worker.reason.slice(0, 12) : STATE[worker.state].label}
                </span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
