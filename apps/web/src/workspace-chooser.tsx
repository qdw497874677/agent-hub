import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type CanvasDto, type WorkerInfoDto, type WorkspaceDto, type WorkspaceViewDto } from './api.ts';
import { DirectoryPicker } from './directory-picker.tsx';
import { WorkerChip, WorkerPicker, resolveWorker } from './workers.tsx';

/**
 * 运行面板的核心（docs/design/workspaces.md §9.3）：「在哪台机器、哪个工作空间干活？」
 * - 第一行选机器（只有一台在线就直接用它）；
 * - 下面单选：已有的工作空间 / 新建持久工作空间（W4 起还有临时）。
 * - 不预选：持久和临时之间没有默认，也不记上次；没选之前「开始」是灰的。
 */
export type WorkspaceChoice =
  | { readonly type: 'existing'; readonly workspaceId: string }
  | { readonly type: 'new_long_lived'; readonly mode: 'create' }
  | { readonly type: 'new_long_lived'; readonly mode: 'link'; readonly path: string | null };

/** 选完了没有：「选已有目录」还没点目录不算。 */
export function choiceReady(choice: WorkspaceChoice | null): boolean {
  if (choice === null) return false;
  return !(choice.type === 'new_long_lived' && choice.mode === 'link' && !choice.path);
}

export function useWorkspaceViews(projectId: string) {
  return useQuery({ queryKey: ['workspaces', projectId], queryFn: () => api.workspaces(projectId), refetchInterval: 5000 });
}

/** 工作空间的人话名字：有标签用标签，否则用文件夹名。 */
export function workspaceName(workspace: Pick<WorkspaceDto, 'label' | 'path'>): string {
  return workspace.label ?? (workspace.path.split('/').filter(Boolean).at(-1) || workspace.path);
}

export const KIND_LABEL = { long_lived: '持久', temporary: '临时' } as const;
export const KIND_HINT = {
  long_lived: '持久：一直保留，下次还能接着用。',
  temporary: '临时：任务结束后自动清理；有未保存的改动会保留并提醒你。'
} as const;
export const CONCURRENT_HINT = '另一个任务也在这里干活，改动可能互相影响';

/** 路径中间省略：~/agent-hub/…/foo（§9.7）。 */
export function shortPath(path: string): string {
  const tilde = path.replace(/^\/home\/[^/]+/, '~').replace(/^\/root(?=\/|$)/, '~');
  const parts = tilde.split('/');
  return parts.length <= 4 ? tilde : `${parts.slice(0, 2).join('/')}/…/${parts.at(-1)}`;
}

const ROW = 'flex min-h-[56px] w-full items-start gap-2 rounded-sm border px-3 py-2 text-left';
const rowClass = (selected: boolean) => `${ROW} ${selected ? 'border-accent bg-card' : 'border-hair hover:border-strong'}`;

function Radio({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`mt-1 inline-block h-3 w-3 shrink-0 rounded-full border ${on ? 'border-accent bg-accent' : 'border-strong'}`}
    />
  );
}

export function WorkspaceChooser({
  canvas,
  taskId,
  agentId,
  workers,
  machine,
  onMachine,
  choice,
  onChoice
}: {
  canvas: CanvasDto;
  taskId: string;
  agentId: string;
  workers: readonly WorkerInfoDto[];
  /** 选中的机器（Worker id）；null = 还没选。 */
  machine: string | null;
  onMachine: (workerId: string | null) => void;
  choice: WorkspaceChoice | null;
  onChoice: (choice: WorkspaceChoice | null) => void;
}) {
  const views = useWorkspaceViews(canvas.project.id);
  const local = resolveWorker(workers, null);
  const offers = (worker: WorkerInfoDto) => (worker.agentIds ?? [agentId]).includes(agentId);
  const machines = workers.filter(offers);
  const usable = machines.filter((worker) => worker.state === 'online');

  // 只有一台能用的机器：直接用它（不是「默认」，是没得选）
  useEffect(() => {
    if (machine === null && usable.length === 1) onMachine(usable[0]!.workerId);
    if (machine !== null && !usable.some((worker) => worker.workerId === machine)) onMachine(null);
  }, [machine, usable, onMachine]);

  // 工作空间的 workerId null = hub 本机 → 本机那台 Worker
  const hostOf = (workspace: WorkspaceDto) => workspace.workerId ?? local?.workerId ?? null;
  const lastUsed = useMemo(() => {
    const at = new Map<string, number>();
    for (const session of canvas.sessions) {
      if (session.workspaceId) at.set(session.workspaceId, Math.max(at.get(session.workspaceId) ?? 0, session.updatedAt));
    }
    return at;
  }, [canvas.sessions]);
  const here: WorkspaceViewDto[] = (views.data ?? [])
    .filter(({ workspace }) => machine !== null && hostOf(workspace) === machine)
    .filter(({ workspace }) => workspace.state === 'ready' || workspace.state === 'kept')
    .filter(({ workspace }) => workspace.kind === 'long_lived' || workspace.ownerTaskId === taskId)
    .sort(
      (a, b) =>
        (lastUsed.get(b.workspace.id) ?? b.workspace.createdAt) - (lastUsed.get(a.workspace.id) ?? a.workspace.createdAt)
    );

  // 换机器：之前选的工作空间不在这台上了，清掉，免得误开到别处
  useEffect(() => {
    if (choice?.type === 'existing' && !here.some(({ workspace }) => workspace.id === choice.workspaceId)) onChoice(null);
  }, [choice, here, onChoice]);

  const machineName = machines.find((worker) => worker.workerId === machine)?.label ?? '这台机器';

  return (
    <section aria-label="工作空间" className="mb-3">
      {machines.length < 2 || usable.length === 0 ? (
        <p className="mb-1 text-meta text-secondary" title="干活的那台电脑。agent 在它上面读写文件、执行命令。">机器</p>
      ) : null}
      {usable.length === 0 ? (
        <p className="mb-3 border-l border-rust pl-2 text-meta text-secondary">
          现在没有在线的机器。打开一台已接入的机器，或者接入一台新的。
        </p>
      ) : machines.length < 2 ? (
        <p className="mb-3">
          <WorkerChip worker={machines[0]} />
        </p>
      ) : (
        <WorkerPicker label="机器" workers={machines} value={machine} onChange={onMachine} />
      )}

      {machine === null ? null : (
        <>
          <p className="mb-1 text-meta text-secondary" title="机器上的一个文件夹，agent 只在这里面干活。">工作空间</p>
          <div role="radiogroup" aria-label="选择工作空间" className="flex flex-col gap-1.5">
            {views.isLoading ? <p className="text-meta text-tertiary">正在读取工作空间…</p> : null}
            {!views.isLoading && here.length === 0 ? (
              <p className="text-meta text-tertiary">这台机器上还没有这个项目的工作空间，新建一个吧。</p>
            ) : null}
            {here.map(({ workspace, runningTaskIds }) => {
              const selected = choice?.type === 'existing' && choice.workspaceId === workspace.id;
              const others = runningTaskIds.some((id) => id !== taskId);
              return (
                <button
                  key={workspace.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={rowClass(selected)}
                  onClick={() => onChoice({ type: 'existing', workspaceId: workspace.id })}
                >
                  <Radio on={selected} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body text-primary">
                      {workspaceName(workspace)}
                      <span className="text-meta text-tertiary" title={KIND_HINT[workspace.kind]}>
                        {' · '}
                        {KIND_LABEL[workspace.kind]}
                        {workspace.state === 'kept' ? ' · 已保留' : ''}
                        {workspace.branch ? ` · ${workspace.branch}` : ''}
                      </span>
                    </span>
                    <span className="block truncate font-mono text-meta text-tertiary" title={workspace.path}>
                      {shortPath(workspace.path)}
                    </span>
                    {others ? (
                      <span className="mt-0.5 block text-meta text-rust" title={CONCURRENT_HINT}>
                        ⚠ {CONCURRENT_HINT}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
            <NewLongLived
              canvas={canvas}
              machine={machine}
              machineName={machineName}
              choice={choice}
              onChoice={onChoice}
            />
          </div>
        </>
      )}
    </section>
  );
}

function NewLongLived({
  canvas,
  machine,
  machineName,
  choice,
  onChoice
}: {
  canvas: CanvasDto;
  machine: string;
  machineName: string;
  choice: WorkspaceChoice | null;
  onChoice: (choice: WorkspaceChoice) => void;
}) {
  const selected = choice?.type === 'new_long_lived';
  const [picking, setPicking] = useState(false);
  // 托管目录在哪：问那台机器（它的 roots[0]/agent-hub/<slug>）
  const managed = useQuery({
    queryKey: ['managed-dir', machine, canvas.project.name],
    queryFn: () => api.listDirectories('', machine, canvas.project.name),
    enabled: selected
  });
  return (
    <div className={`${rowClass(selected)} flex-col`}>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        className="flex w-full items-start gap-2 text-left"
        onClick={() => onChoice({ type: 'new_long_lived', mode: 'create' })}
      >
        <Radio on={selected} />
        <span className="min-w-0 flex-1">
          <span className="block text-body text-primary">新建持久工作空间</span>
          <span className="block text-meta text-tertiary">一直保留，下次还能接着用</span>
        </span>
      </button>
      {selected ? (
        <div className="w-full pl-5">
          <div className="mb-1.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label="怎么新建">
            {(
              [
                ['create', '新建文件夹'],
                ['link', '选已有目录']
              ] as const
            ).map(([mode, text]) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={choice.mode === mode}
                className={`min-h-[32px] rounded-sm border px-2 text-meta ${
                  choice.mode === mode ? 'border-accent text-primary' : 'border-hair text-secondary hover:border-strong'
                }`}
                onClick={() => {
                  if (mode === 'create') onChoice({ type: 'new_long_lived', mode });
                  else {
                    onChoice({ type: 'new_long_lived', mode, path: null });
                    setPicking(true);
                  }
                }}
              >
                {text}
              </button>
            ))}
          </div>
          {choice.mode === 'create' ? (
            <p className="text-meta text-tertiary">
              将在 {machineName} 的 <span className="font-mono">{managed.data?.managed ? shortPath(managed.data.managed) : '~/agent-hub/…'}</span> 下新建
              {managed.data?.managed ? '（名字被占就自动加 -2）' : ''}
            </p>
          ) : (
            <>
              <p className="text-meta text-tertiary">
                {choice.path ? (
                  <>
                    将把 <span className="font-mono">{shortPath(choice.path)}</span> 登记成持久工作空间（不会删它）
                  </>
                ) : (
                  '选一个这台机器上已有的目录'
                )}
                <button type="button" className="ml-2 text-accent hover:underline" onClick={() => setPicking((open) => !open)}>
                  {picking ? '收起' : choice.path ? '换一个' : '浏览…'}
                </button>
              </p>
              {picking ? (
                <div className="mt-2">
                  <DirectoryPicker
                    workerId={machine}
                    project={canvas.project.name}
                    onCancel={() => setPicking(false)}
                    onPick={(path) => {
                      onChoice({ type: 'new_long_lived', mode: 'link', path });
                      setPicking(false);
                    }}
                  />
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
