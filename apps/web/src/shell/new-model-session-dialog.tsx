import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, providersApi, type CanvasDto, type HubModelsDto, type SessionDto, type WorkerInfoDto, type WorkspaceViewDto } from './api.ts';
import { DialogShell, PRIMARY_BUTTON, SECONDARY_BUTTON } from './dialog-shell.tsx';
import { modelsFor, withHubModels } from './dialogs.tsx';
import { startBlockReason, workerOffersAgent } from './harness-gate.ts';
import { projectKeys } from './query-keys.ts';
import { useWorkers } from './workers.tsx';
import { workspaceName } from '../atoms/workspace-format.ts';
import type { WorkspaceGroupView } from '../surfaces/workbench/workspace-group.ts';

type Group = WorkspaceGroupView & { readonly ownerTaskId?: string | null };
type Evidence = {
  canvas: CanvasDto;
  source: SessionDto;
  workers: readonly WorkerInfoDto[];
  workspaces: readonly WorkspaceViewDto[];
  providers: readonly HubModelsDto[];
  group: Group | null;
};

function blockReason(e: Evidence, source: SessionDto, model: string): string | null {
  const current = e.source;
  if (current.id !== source.id || current.kind !== source.kind || current.taskId !== source.taskId || current.agentId !== source.agentId || current.workerId !== source.workerId || current.workspaceId !== source.workspaceId || (current.groupId ?? null) !== (source.groupId ?? null)) return '原会话的位置已改变，请重新打开确认';
  if (source.kind === 'side' || !source.taskId || !e.canvas.tasks.some((task) => task.id === source.taskId && task.projectId === e.canvas.project.id)) return '原会话没有属于当前项目的普通任务';
  if (!source.workerId || (!source.workspaceId && !source.groupId)) return '原会话没有明确的机器或工作目录';
  const worker = e.workers.find((item) => item.workerId === source.workerId);
  if (!worker || worker.state !== 'online' || !workerOffersAgent(worker, source.agentId)) return '原机器不在线或没有此 Agent';
  const workspaceWorker = (workerId: string | null) => workerId ?? e.workers.find((item) => item.origin === 'local')?.workerId ?? null;
  const catalog = modelsFor(e.workers, source.workerId, source.agentId);
  const readiness = worker.agentModels?.find((item) => item.agentId === source.agentId)?.readiness;
  if (!catalog || !readiness || (readiness.state === 'ready' && readiness.check?.ok === false)) return '原机器的 Agent 尚未就绪或状态不可确认';
  const provider = e.providers.find((item) => item.models.some((entry) => entry.id === model));
  const protocol = provider?.protocol ?? null;
  if (model.startsWith('hub-') && (!provider || !worker.agentModels?.find((item) => item.agentId === source.agentId)?.providers?.includes(provider.protocol))) return '所选 Hub 模型在当前任务或机器上不可用';
  const reason = startBlockReason(worker, source.agentId, model, protocol);
  if (reason !== null) return `原机器上的 Agent 无法启动：${reason || '不可用'}`;
  if (!model || !withHubModels(catalog, e.workers, source.workerId, source.agentId, e.providers).models.includes(model)) return '所选模型在原机器或当前任务中不可用';
  if (source.groupId) {
    const group = e.group;
    if (!group || group.id !== source.groupId || group.projectId !== e.canvas.project.id || group.workerId !== source.workerId || group.ownerTaskId !== source.taskId || group.state !== 'ready' || !group.members?.length || group.members.some((member) => member.state !== 'ready') || group.members[0]?.workspaceId !== source.workspaceId) return '原组合工作目录不可用或不属于当前任务';
    if (group.members.some((member) => !e.workspaces.some(({ workspace }) => workspace.id === member.workspaceId && workspace.groupId === group.id && workspaceWorker(workspace.workerId) === source.workerId && workspace.ownerTaskId === source.taskId && (workspace.state === 'ready' || workspace.state === 'kept')))) return '组合工作目录的成员不可用';
  } else {
    const view = e.workspaces.find(({ workspace }) => workspace.id === source.workspaceId);
    const workspace = view?.workspace;
    if (!workspace || workspace.groupId || workspaceWorker(workspace.workerId) !== source.workerId || (workspace.state !== 'ready' && workspace.state !== 'kept') || (workspace.kind !== 'long_lived' && workspace.ownerTaskId !== source.taskId)) return '原工作目录不可用于当前任务或机器';
  }
  return null;
}

export function NewModelSessionDialog({ canvas, source, model, onClose, onCreated }: {
  canvas: CanvasDto;
  source: SessionDto;
  model: string;
  onClose: () => void;
  onCreated: (session: SessionDto) => void;
}) {
  const client = useQueryClient();
  const workers = useWorkers();
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const taskId = source.taskId ?? '';
  const evidence = useQuery({
    queryKey: ['new-model-session-evidence', canvas.project.id, source.id, model],
    queryFn: async (): Promise<Evidence> => {
      const [freshCanvas, current, machines, workspaces, hub, group] = await Promise.all([
        api.canvas(canvas.project.id), api.session(source.id), api.workers(), api.workspaces(canvas.project.id),
        providersApi.modelsExplained(taskId), source.groupId ? api.workspaceGroup(source.groupId) : Promise.resolve(null)
      ]);
      return { canvas: freshCanvas, source: current, workers: machines, workspaces, providers: hub.providers, group };
    },
    retry: false,
    refetchOnMount: 'always'
  });
  const reason = evidence.isFetching ? '正在确认原会话和可用状态…' : evidence.isError || !evidence.data ? '无法确认原会话和可用状态，请关闭后重试' : blockReason(evidence.data, source, model);
  const workspace = evidence.data?.workspaces.find((item) => item.workspace.id === source.workspaceId)?.workspace;
  const task = canvas.tasks.find((item) => item.id === source.taskId);
  const machine = workers.byId(source.workerId);
  const agent = canvas.agents.find((item) => item.id === source.agentId);

  const submit = async () => {
    if (locked.current || pending || uncertain || reason !== null) return;
    locked.current = true;
    setPending(true);
    setError('');
    let sent = false;
    try {
      const latest = await evidence.refetch();
      if (latest.isError || !latest.data) throw new Error('无法重新确认原会话状态，请关闭后重试');
      const blocked = blockReason(latest.data, source, model);
      if (blocked) throw new Error(blocked);
      sent = true;
      const session = await api.derive({ taskId, agentId: source.agentId, model, workerId: source.workerId!, ...(source.groupId ? { groupId: source.groupId } : { workspaceId: source.workspaceId! }) });
      sent = false;
      void client.invalidateQueries({ queryKey: projectKeys.canvas(canvas.project.id) });
      if (mounted.current) onCreated(session);
    } catch (failure) {
      if (sent) {
        setUncertain(true);
        void client.invalidateQueries({ queryKey: projectKeys.canvas(canvas.project.id) });
        const detail = failure instanceof Error && failure.message ? ` 错误详情：${failure.message}` : '';
        setError(`创建结果未知，可能已经成功。请关闭后检查会话列表，不要盲目重复创建。${detail}`);
      } else {
        setError(failure instanceof Error ? failure.message : '无法创建会话');
      }
    } finally {
      locked.current = false;
      setPending(false);
    }
  };

  return (
    <DialogShell title="用此模型新开会话" testId="new-model-session-confirm" onClose={() => { if (!pending) onClose(); }}>
      <h2 className="mb-3 text-head text-primary">用此模型新开会话</h2>
      <dl className="space-y-2 break-all text-body text-secondary">
        <div><dt>任务</dt><dd className="text-primary">{task?.title ?? source.taskId ?? '不可用'}</dd></div>
        <div><dt>机器</dt><dd className="text-primary">{machine?.label ?? source.workerId ?? '不可用'}</dd></div>
        <div><dt>工作目录</dt><dd className="text-primary">{source.groupId ? (evidence.data?.group?.root ?? '组合工作目录') : workspace ? workspaceName(workspace) : '不可用'}</dd></div>
        <div><dt>Agent / 模型</dt><dd className="text-primary">{agent && agent.label !== source.agentId ? `${agent.label} (${source.agentId})` : source.agentId} / {model}</dd></div>
      </dl>
      <p className="my-4 text-meta text-secondary">原会话和草稿会保留；旧对话不会带入新会话。共享的文件改动可能互相影响。</p>
      {error || reason ? <p role="alert" className="mb-3 text-meta text-rust">{error || reason}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" className={SECONDARY_BUTTON} disabled={pending} onClick={onClose}>取消</button>
        <button type="button" className={PRIMARY_BUTTON} disabled={pending || uncertain || reason !== null} onClick={() => void submit()}>{pending ? '创建中…' : '新建会话'}</button>
      </div>
    </DialogShell>
  );
}
